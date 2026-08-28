//! 规范化：稳定 fact ID 派生、去重与排序（实施计划 Task 4 步骤 5/6）。
//!
//! fact ID = SHA-256(domain ‖ subject.type ‖ subject.id ‖ predicate ‖
//! object.type ‖ object.id) 的前 32 位 hex。不包含 display name，角色改名
//! 不改变 fact identity。domain 与截断长度**已冻结**（Task 5 步骤 1）：
//! 修改必须递增 domain 版本并同步 fixtures/README。

use std::collections::HashSet;

use sha2::{Digest, Sha256};

use crate::protocol::{
    AsOfGameDate, CanonicalEntityV1, Category, Confidence, EntityRefV1, EntityType,
    ExtractedGameFactV1, FactProvenance, FactSensitivity, FactSource, FactVisibility, Predicate,
    Warning,
};

const FACT_ID_DOMAIN: &[u8] = b"votc-save-facts:fact:v1\0";

pub(crate) const WARN_DUPLICATE_KEY: &str = "DUPLICATE_KEY";
pub(crate) const WARN_PARTICIPANT_NOT_FOUND: &str = "PARTICIPANT_NOT_FOUND";
pub(crate) const WARN_EXTRACTION_LIMIT: &str = "EXTRACTION_LIMIT_REACHED";
pub(crate) const WARN_LOOKUP_INDEX_LIMIT: &str = "LOOKUP_INDEX_LIMIT";

pub(crate) fn entity_type_str(t: EntityType) -> &'static str {
    match t {
        EntityType::Character => "character",
        EntityType::Title => "title",
        EntityType::War => "war",
        EntityType::Activity => "activity",
        EntityType::Location => "location",
    }
}

pub(crate) fn predicate_str(p: Predicate) -> &'static str {
    match p {
        Predicate::CharacterSpouse => "character.spouse",
        Predicate::CharacterParent => "character.parent",
        Predicate::CharacterChild => "character.child",
        Predicate::CharacterLiege => "character.liege",
        Predicate::CharacterPrimaryTitle => "character.primary_title",
        Predicate::CharacterDirectVassalOf => "character.direct_vassal_of",
        Predicate::CharacterRealmCapital => "character.realm_capital",
        Predicate::TitleHolder => "title.holder",
        Predicate::CharacterAtWar => "character.at_war",
        Predicate::WarAttacker => "war.attacker",
        Predicate::WarDefender => "war.defender",
        Predicate::WarCasusBelli => "war.casus_belli",
        Predicate::CharacterWarScoreBand => "character.war_score_band",
        Predicate::CharacterCurrentActivity => "character.current_activity",
        Predicate::CharacterTraveling => "character.traveling",
        Predicate::CharacterPublicLocation => "character.public_location",
        Predicate::ActivityLocation => "activity.location",
        Predicate::CharacterCouncilPosition => "character.council_position",
        Predicate::CharacterCourtPosition => "character.court_position",
        Predicate::CharacterCourtOwner => "character.court_owner",
    }
}

/// 稳定 fact ID：subject+predicate+object 派生，不含 display name。
pub(crate) fn fact_id(
    subject: &EntityRefV1,
    predicate: Predicate,
    object: Option<&EntityRefV1>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FACT_ID_DOMAIN);
    let object_part = match object {
        Some(o) => format!("{}|{}", entity_type_str(o.entity_type), o.id),
        None => "-|-".to_string(),
    };
    hasher.update(
        format!(
            "{}|{}|{}|{}",
            entity_type_str(subject.entity_type),
            subject.id,
            predicate_str(predicate),
            object_part
        )
        .as_bytes(),
    );
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for b in &digest[..16] {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 事实排序：subject type/id、predicate（字符串序）、object type/id、fact ID。
pub(crate) fn sort_facts(facts: &mut [ExtractedGameFactV1]) {
    facts.sort_by(|a, b| {
        (
            a.subject.entity_type,
            &a.subject.id,
            predicate_str(a.predicate),
            a.object.as_ref().map(|o| o.entity_type),
            a.object.as_ref().map(|o| o.id.as_str()),
            &a.id,
        )
            .cmp(&(
                b.subject.entity_type,
                &b.subject.id,
                predicate_str(b.predicate),
                b.object.as_ref().map(|o| o.entity_type),
                b.object.as_ref().map(|o| o.id.as_str()),
                &b.id,
            ))
    });
}

/// 实体排序：type、id。
pub(crate) fn sort_entities(entities: &mut [CanonicalEntityV1]) {
    entities.sort_by(|a, b| (a.entity_type, &a.id).cmp(&(b.entity_type, &b.id)));
}

/// 事实汇集器：去重、related/fact 上限、provenance/asOf 统一填充。
///
/// 任一上限命中 → `partial = true` + 一次 warning，之后停止增长
/// （不再接受新事实），保证输出有界且确定性（扫描序即处理序）。
pub(crate) struct FactSink<'a> {
    participants: HashSet<&'a str>,
    as_of: AsOfGameDate,
    provenance: FactProvenance,
    max_facts: u64,
    max_related_characters: u64,
    facts: Vec<ExtractedGameFactV1>,
    fact_ids: HashSet<String>,
    spouse_pairs: HashSet<(String, String)>,
    /// 事实引用到的非 participant 角色 ID（去重计数）。
    related_characters: HashSet<String>,
    partial: bool,
    limit_warned: bool,
    warnings: Vec<Warning>,
}

impl<'a> FactSink<'a> {
    pub(crate) fn new(
        participants: &'a [String],
        as_of: AsOfGameDate,
        provenance: FactProvenance,
        max_facts: u64,
        max_related_characters: u64,
    ) -> Self {
        Self {
            participants: participants.iter().map(String::as_str).collect(),
            as_of,
            provenance,
            max_facts,
            max_related_characters,
            facts: Vec::new(),
            fact_ids: HashSet::new(),
            spouse_pairs: HashSet::new(),
            related_characters: HashSet::new(),
            partial: false,
            limit_warned: false,
            warnings: Vec::new(),
        }
    }

    fn hit_limit(&mut self) {
        self.partial = true;
        if !self.limit_warned {
            self.limit_warned = true;
            self.warnings.push(Warning {
                code: WARN_EXTRACTION_LIMIT.to_string(),
                category: None,
            });
        }
    }

    /// 引用计数：返回 false 表示该事实会引入超额 related character。
    fn admit_character(&mut self, id: &str) -> bool {
        if self.participants.contains(id) || self.related_characters.contains(id) {
            return true;
        }
        if self.related_characters.len() as u64 >= self.max_related_characters {
            self.hit_limit();
            return false;
        }
        self.related_characters.insert(id.to_string());
        true
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_fact(
        &mut self,
        category: Category,
        subject: (EntityType, &str),
        predicate: Predicate,
        object: Option<(EntityType, &str)>,
        source_path: &'static str,
        confidence: Confidence,
        visibility: FactVisibility,
        sensitivity: FactSensitivity,
    ) {
        self.push_fact_with_value(
            category,
            subject,
            predicate,
            object,
            source_path,
            confidence,
            visibility,
            sensitivity,
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_fact_with_value(
        &mut self,
        category: Category,
        subject: (EntityType, &str),
        predicate: Predicate,
        object: Option<(EntityType, &str)>,
        source_path: &'static str,
        confidence: Confidence,
        visibility: FactVisibility,
        sensitivity: FactSensitivity,
        value: Option<&str>,
    ) {
        if self.partial {
            return; // 达上限后停止增长
        }
        // related 上限只对 character 引用计数。
        if let (EntityType::Character, sid) = subject {
            if !self.admit_character(sid) {
                return;
            }
        }
        if let Some((EntityType::Character, oid)) = object {
            if !self.admit_character(oid) {
                return;
            }
        }
        if self.facts.len() as u64 >= self.max_facts {
            self.hit_limit();
            return;
        }

        let subject = EntityRefV1 {
            entity_type: subject.0,
            id: subject.1.to_string(),
        };
        let object_ref = object.map(|(t, id)| EntityRefV1 {
            entity_type: t,
            id: id.to_string(),
        });
        let id = fact_id(&subject, predicate, object_ref.as_ref());
        if !self.fact_ids.insert(id.clone()) {
            return; // 完全相同的事实去重（确定性，无 warning）
        }
        self.facts.push(ExtractedGameFactV1 {
            id,
            category,
            subject,
            predicate,
            object: object_ref,
            value: value.map(str::to_string),
            as_of_game_date: self.as_of.clone(),
            source: FactSource::SaveSnapshot,
            source_path: source_path.to_string(),
            confidence,
            visibility,
            sensitivity,
            provenance: self.provenance.clone(),
        });
    }

    /// spouse 去重：canonical pair 按 ID 排序，只输出一次（稳定方向：
    /// 较小 ID 为 subject）。
    pub(crate) fn admit_spouse_pair(&mut self, a: &str, b: &str) -> Option<(String, String)> {
        let pair = if a <= b {
            (a.to_string(), b.to_string())
        } else {
            (b.to_string(), a.to_string())
        };
        if self.spouse_pairs.insert(pair.clone()) {
            Some(pair)
        } else {
            None
        }
    }

    pub(crate) fn push_warning_once(&mut self, code: &str) {
        if !self.warnings.iter().any(|w| w.code == code) {
            self.warnings.push(Warning {
                code: code.to_string(),
                category: None,
            });
        }
    }

    pub(crate) fn mark_partial_with_warning(&mut self, code: &str) {
        self.partial = true;
        self.push_warning_once(code);
    }

    pub(crate) fn is_participant(&self, id: &str) -> bool {
        self.participants.contains(id)
    }

    pub(crate) fn participant_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .participants
            .iter()
            .map(|id| (*id).to_string())
            .collect();
        ids.sort();
        ids
    }

    pub(crate) fn related_characters(&self) -> &HashSet<String> {
        &self.related_characters
    }

    pub(crate) fn facts(&self) -> &[ExtractedGameFactV1] {
        &self.facts
    }

    pub(crate) fn is_full(&self) -> bool {
        self.partial || self.facts.len() as u64 >= self.max_facts
    }

    pub(crate) fn finish(mut self) -> (Vec<ExtractedGameFactV1>, Vec<Warning>, bool) {
        sort_facts(&mut self.facts);
        (self.facts, self.warnings, self.partial)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn char_ref(id: &str) -> EntityRefV1 {
        EntityRefV1 {
            entity_type: EntityType::Character,
            id: id.to_string(),
        }
    }

    #[test]
    fn fact_id_is_stable_and_name_free() {
        let s = char_ref("1001");
        let o = char_ref("1002");
        let a = fact_id(&s, Predicate::CharacterSpouse, Some(&o));
        let b = fact_id(&s, Predicate::CharacterSpouse, Some(&o));
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        // predicate / object 变化 → ID 变化。
        assert_ne!(a, fact_id(&s, Predicate::CharacterParent, Some(&o)));
        assert_ne!(
            a,
            fact_id(&s, Predicate::CharacterSpouse, Some(&char_ref("1003")))
        );
        assert_ne!(a, fact_id(&s, Predicate::CharacterSpouse, None));
    }

    #[test]
    fn spouse_pair_is_canonical() {
        let participants = ["1001".to_string()];
        let mut sink = FactSink::new(
            &participants,
            AsOfGameDate {
                numeric: Some(1),
                display: None,
            },
            FactProvenance {
                snapshot_id: None,
                campaign_id: None,
                snapshot_sequence: None,
            },
            10,
            10,
        );
        assert_eq!(
            sink.admit_spouse_pair("1002", "1001"),
            Some(("1001".to_string(), "1002".to_string()))
        );
        // 反方向重复 → 去重。
        assert_eq!(sink.admit_spouse_pair("1001", "1002"), None);
    }
}
