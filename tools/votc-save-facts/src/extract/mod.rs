//! 参与者邻域的稀疏 family/realm extraction（实施计划 Task 4）。
//!
//! skip-first visitor：root 层只进入 `living`（角色）、`landed_titles`
//! （头衔）和显式 allowlist 的 `wars` 块；其它块全部整块跳过。
//!
//! 单趟扫描，不构造完整 character map：
//!
//! - participant 角色：全量白名单关系（family + realm）；
//! - 其他角色：只保留指向 participant 的反向公开关系（spouse/parent）；
//! - 角色名只进有界 name index（供 related 实体的 displayNameCandidate），
//!   title 记录进有界 title index；
//! - 任一上限（facts / entities / related characters）命中 → partial +
//!   warning，停止增长。
//!
//! raw schema 假定见 character.rs / realm.rs / war.rs 头部注释；war.rs
//! 明确只接受最小 fixture schema，未知真实 CK3 war layout fail-closed。

pub(crate) mod activity;
pub(crate) mod character;
pub(crate) mod court;
pub(crate) mod family;
pub(crate) mod normalize;
pub(crate) mod realm;
pub(crate) mod war;

use std::collections::{HashMap, HashSet};
use std::io::Read;

use crate::identity::{IdentityError, ScanLimits, Scanner, Token};
use crate::protocol::{
    AsOfGameDate, CanonicalEntityV1, Category, DisplayNameCandidate, DisplayNameKind, EntityType,
    ExtractedGameFactV1, FactProvenance, Warning,
};
use normalize::FactSink;

/// name/title 查找索引的条目上限（**已冻结**，Task 5 步骤 1）。超出后停止
/// 索引新名字并记 warning；名称只是 best-effort candidate，缺失不失败。
const NAME_INDEX_CAP: usize = 100_000;
const TITLE_INDEX_CAP: usize = 50_000;

struct ParticipantRealmRequest {
    character_id: String,
    primary_title: Option<String>,
    legacy_liege: Option<String>,
    direct_vassal_of: Option<String>,
    realm_capital: Option<String>,
}

pub(crate) struct ExtractionContext {
    /// 已去重+稳定排序的 participant ID 列表。
    pub participants: Vec<String>,
    pub categories: Vec<Category>,
    pub game_date_numeric: Option<u64>,
    pub game_date_display: Option<String>,
    pub snapshot_id: Option<String>,
    /// campaign 四段的点分形式（`a.b.c.d`），缺段时为 None。
    pub campaign_id: Option<String>,
    pub snapshot_sequence: Option<u64>,
}

pub(crate) struct ExtractionLimits {
    pub scan: ScanLimits,
    pub max_facts: u64,
    pub max_entities: u64,
    pub max_related_characters: u64,
}

pub(crate) struct Extraction {
    /// 已按 type/id 排序。
    pub entities: Vec<CanonicalEntityV1>,
    /// 已按 subject type/id、predicate、object type/id、fact ID 排序。
    pub facts: Vec<ExtractedGameFactV1>,
    pub warnings: Vec<Warning>,
    pub partial: bool,
    pub scanned_bytes: u64,
}

fn warning(code: &str) -> Warning {
    Warning {
        code: code.to_string(),
        category: None,
    }
}

/// 跳过整个 `living` / `landed_titles` 之外的 root 块是 skip-first 的
/// 核心：这里出现的 key 永远不会被读取（含 secrets/schemes/wars/AI/未知块）。
#[allow(clippy::too_many_arguments)]
fn scan_living<R: Read>(
    scanner: &mut Scanner<R>,
    sink: &mut FactSink,
    name_index: &mut HashMap<String, DisplayNameCandidate>,
    participants_seen: &mut HashSet<String>,
    participant_realms: &mut Vec<ParticipantRealmRequest>,
    participant_lieges: &mut HashMap<String, String>,
    want_family: bool,
    want_realm: bool,
    want_war: bool,
    want_location: bool,
    want_court: bool,
    activity_characters: &mut Vec<(String, character::CharacterRecord)>,
    index_warned: &mut bool,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(id_bytes) | Token::Str(id_bytes) => {
                if id_bytes.is_empty() || !id_bytes.iter().all(|b| b.is_ascii_digit()) {
                    return Err(IdentityError::ParseFailed);
                }
                let id = String::from_utf8(id_bytes).map_err(|_| IdentityError::ParseFailed)?;
                scanner.expect_eq()?;
                let rec = character::scan_character(scanner)?;
                let is_participant = sink.is_participant(&id);
                if is_participant {
                    participants_seen.insert(id.clone());
                }
                if let Some(name) = &rec.first_name {
                    if name_index.len() >= NAME_INDEX_CAP {
                        if !*index_warned {
                            *index_warned = true;
                            sink.push_warning_once(normalize::WARN_LOOKUP_INDEX_LIMIT);
                        }
                    } else {
                        name_index
                            .entry(id.clone())
                            .or_insert_with(|| DisplayNameCandidate {
                                kind: if rec.first_name_is_localization_key {
                                    DisplayNameKind::LocalizationKey
                                } else {
                                    DisplayNameKind::Literal
                                },
                                value: name.clone(),
                            });
                    }
                }
                if rec.duplicate_key {
                    sink.push_warning_once(normalize::WARN_DUPLICATE_KEY);
                }
                if want_family {
                    family::record_character_family(sink, &id, &rec, is_participant);
                }
                if want_realm && is_participant {
                    // Resolve after the complete title map has been scanned.
                    participant_realms.push(ParticipantRealmRequest {
                        character_id: id.clone(),
                        primary_title: rec
                            .primary_title
                            .clone()
                            .or_else(|| rec.domains.first().cloned()),
                        legacy_liege: rec.liege.clone(),
                        direct_vassal_of: rec.direct_vassal_of.clone(),
                        realm_capital: rec.realm_capital.clone(),
                    });
                }
                if want_war && is_participant {
                    if let Some(liege) = rec.liege.clone() {
                        participant_lieges.insert(id.clone(), liege);
                    }
                }
                if (want_location || want_court) && is_participant {
                    activity_characters.push((id.clone(), rec.clone()));
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_titles<R: Read>(
    scanner: &mut Scanner<R>,
    sink: &mut FactSink,
    title_index: &mut HashMap<String, realm::TitleRecord>,
    index_warned: &mut bool,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(id_bytes) | Token::Str(id_bytes) => {
                scanner.expect_eq()?;
                // 真实 1.19 存档把 title 记录嵌套在第二层 `landed_titles` 块中
                // （第一层只有 dynamic_templates 元数据），递归进入同一扫描。
                if id_bytes == b"landed_titles" {
                    scan_titles(scanner, sink, title_index, index_warned)?;
                    continue;
                }
                // Real saves include metadata entries such as
                // `dynamic_templates={...}` in this block.
                if id_bytes.is_empty() || !id_bytes.iter().all(|b| b.is_ascii_digit()) {
                    scanner.skip_value()?;
                    continue;
                }
                let id = String::from_utf8(id_bytes).map_err(|_| IdentityError::ParseFailed)?;
                let rec = realm::scan_title(scanner)?;
                if rec.duplicate_key {
                    sink.push_warning_once(normalize::WARN_DUPLICATE_KEY);
                }
                // holder 是 participant → title.holder 反向索引事实（一跳）。
                if let Some(holder) = &rec.holder {
                    if sink.is_participant(holder) {
                        realm::record_title_holder(sink, &id, holder);
                    }
                }
                if title_index.len() >= TITLE_INDEX_CAP {
                    if !*index_warned {
                        *index_warned = true;
                        sink.push_warning_once(normalize::WARN_LOOKUP_INDEX_LIMIT);
                    }
                } else {
                    title_index.entry(id).or_insert(rec);
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// 单趟有界扫描，产出规范化实体与事实（已排序）。
pub(crate) fn extract(
    reader: impl Read,
    limits: ExtractionLimits,
    ctx: &ExtractionContext,
) -> Result<Extraction, IdentityError> {
    let want_family = ctx.categories.contains(&Category::Family);
    let want_realm = ctx.categories.contains(&Category::Realm);
    let want_war = ctx.categories.contains(&Category::War);
    let want_location = ctx.categories.contains(&Category::Location);
    let want_court = ctx.categories.contains(&Category::Court);

    let mut sink = FactSink::new(
        &ctx.participants,
        AsOfGameDate {
            numeric: ctx.game_date_numeric,
            display: ctx.game_date_display.clone(),
        },
        FactProvenance {
            snapshot_id: ctx.snapshot_id.clone(),
            campaign_id: ctx.campaign_id.clone(),
            snapshot_sequence: ctx.snapshot_sequence,
        },
        limits.max_facts,
        limits.max_related_characters,
    );
    let mut name_index: HashMap<String, DisplayNameCandidate> = HashMap::new();
    let mut title_index: HashMap<String, realm::TitleRecord> = HashMap::new();
    let mut participants_seen: HashSet<String> = HashSet::new();
    let mut participant_realms: Vec<ParticipantRealmRequest> = Vec::new();
    let mut participant_lieges: HashMap<String, String> = HashMap::new();
    let mut war_records: Vec<war::WarRecord> = Vec::new();
    let mut activity_characters: Vec<(String, character::CharacterRecord)> = Vec::new();
    let mut location_records: Vec<activity::LocationRecord> = Vec::new();
    let mut index_warned = false;

    let mut scanner = Scanner::new(reader, limits.scan);
    loop {
        match scanner.next_token()? {
            Token::Eof => {
                if scanner.depth != 0 {
                    return Err(IdentityError::Truncated);
                }
                break;
            }
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"living"
                        if want_family || want_realm || want_war || want_location || want_court =>
                    {
                        scan_living(
                            &mut scanner,
                            &mut sink,
                            &mut name_index,
                            &mut participants_seen,
                            &mut participant_realms,
                            &mut participant_lieges,
                            want_family,
                            want_realm,
                            want_war,
                            want_location,
                            want_court,
                            &mut activity_characters,
                            &mut index_warned,
                        )?
                    }
                    b"landed_titles" if want_realm => {
                        scan_titles(&mut scanner, &mut sink, &mut title_index, &mut index_warned)?
                    }
                    b"wars" if want_war => {
                        war_records = war::scan_wars(&mut scanner)?;
                    }
                    b"locations" if want_location => {
                        location_records = activity::scan_locations(&mut scanner)?;
                    }
                    // skip-first：identity 块、secrets、schemes、AI、memory
                    // manager 及一切未知顶层块整块跳过。
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
    let scanned_bytes = scanner.scanned_bytes();

    if want_realm {
        for request in &participant_realms {
            let resolved_liege = request.legacy_liege.as_deref().or_else(|| {
                request
                    .primary_title
                    .as_deref()
                    .and_then(|title| realm::resolve_title_liege(title, &title_index))
            });
            realm::record_character_realm(
                &mut sink,
                &request.character_id,
                request.primary_title.as_deref(),
                resolved_liege,
                request.direct_vassal_of.as_deref(),
                request.realm_capital.as_deref(),
                &title_index,
            );
        }
    }

    let mut war_names: HashMap<String, String> = HashMap::new();
    if want_war {
        war::record_wars(&mut sink, &war_records, &participant_lieges, &mut war_names);
    }

    let mut location_names: HashMap<String, String> = HashMap::new();
    if want_location {
        activity::record_public_locations(
            &mut sink,
            &activity_characters,
            &location_records,
            &mut location_names,
        );
    }
    if want_court {
        court::record_court_facts(&mut sink, &activity_characters);
    }

    // ---- 实体组装（确定性顺序：participants → related → titles）----
    let mut entities: Vec<CanonicalEntityV1> = Vec::new();
    let mut entity_partial = false;
    let mut push_entity = |entities: &mut Vec<CanonicalEntityV1>,
                           entity_type: EntityType,
                           id: String,
                           name: Option<DisplayNameCandidate>| {
        if entities.len() as u64 >= limits.max_entities {
            entity_partial = true;
            return;
        }
        entities.push(CanonicalEntityV1 {
            entity_type,
            id,
            display_name_candidate: name,
        });
    };

    let char_name = |id: &str| name_index.get(id).cloned();

    for p in &ctx.participants {
        if !participants_seen.contains(p) {
            // participant 不在 living（可能已死亡/缺失）：保留 ID 实体，
            // 名称缺失不失败。
            sink.push_warning_once(normalize::WARN_PARTICIPANT_NOT_FOUND);
        }
        push_entity(
            &mut entities,
            EntityType::Character,
            p.clone(),
            char_name(p),
        );
    }
    let mut related: Vec<&String> = sink.related_characters().iter().collect();
    related.sort();
    for r in related {
        push_entity(
            &mut entities,
            EntityType::Character,
            r.clone(),
            char_name(r),
        );
    }
    let mut title_set: HashSet<&str> = HashSet::new();
    let mut war_set: HashSet<&str> = HashSet::new();
    let mut location_set: HashSet<&str> = HashSet::new();
    for f in sink.facts() {
        if f.subject.entity_type == EntityType::Title {
            title_set.insert(f.subject.id.as_str());
        }
        if let Some(o) = &f.object {
            if o.entity_type == EntityType::Title {
                title_set.insert(o.id.as_str());
            }
            if o.entity_type == EntityType::War {
                war_set.insert(o.id.as_str());
            }
        }
        if f.subject.entity_type == EntityType::War {
            war_set.insert(f.subject.id.as_str());
        }
        if f.subject.entity_type == EntityType::Location {
            location_set.insert(f.subject.id.as_str());
        }
        if let Some(o) = &f.object {
            if o.entity_type == EntityType::Location {
                location_set.insert(o.id.as_str());
            }
        }
    }
    let mut titles: Vec<&str> = title_set.into_iter().collect();
    titles.sort();
    for t in titles {
        let name = title_index.get(t).and_then(|rec| {
            if let Some(lit) = &rec.name {
                Some(DisplayNameCandidate {
                    kind: DisplayNameKind::Literal,
                    value: lit.clone(),
                })
            } else {
                rec.key.as_ref().map(|k| DisplayNameCandidate {
                    kind: DisplayNameKind::LocalizationKey,
                    value: k.clone(),
                })
            }
        });
        push_entity(&mut entities, EntityType::Title, t.to_string(), name);
    }
    let mut wars: Vec<&str> = war_set.into_iter().collect();
    wars.sort();
    for id in wars {
        let name = war_names.get(id).map(|name| DisplayNameCandidate {
            kind: DisplayNameKind::Literal,
            value: name.clone(),
        });
        push_entity(&mut entities, EntityType::War, id.to_string(), name);
    }
    let mut locations: Vec<&str> = location_set.into_iter().collect();
    locations.sort();
    for id in locations {
        let name = location_names.get(id).map(|name| DisplayNameCandidate {
            kind: DisplayNameKind::Literal,
            value: name.clone(),
        });
        push_entity(&mut entities, EntityType::Location, id.to_string(), name);
    }

    let (facts, mut warnings, mut partial) = sink.finish();
    if entity_partial {
        partial = true;
        if !warnings
            .iter()
            .any(|w| w.code == normalize::WARN_EXTRACTION_LIMIT)
        {
            warnings.push(warning(normalize::WARN_EXTRACTION_LIMIT));
        }
    }
    normalize::sort_entities(&mut entities);

    Ok(Extraction {
        entities,
        facts,
        warnings,
        partial,
        scanned_bytes,
    })
}
