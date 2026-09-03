//! One-pass bounded public character/title index for sessions (Plan B Task 3).
//!
//! Built once from the private gamestate artifact while `session_open` runs;
//! afterwards queries only ever touch these in-memory structures (R3).
//!
//! Security properties:
//! - whitelist scanning only: fields outside the extract whitelist are
//!   skipped at the parser boundary and never materialized;
//! - obfuscated localization-key first names (`fictional_player` shape) are
//!   never stored as literal names;
//! - every array is bounded before push; global character/title caps switch
//!   the index to `partial` with stable warnings.

// Record fields are consumed by Task 4 search/profile; digest is test-only.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Read;

use crate::extract::{character, realm};
use crate::identity::{IdentityError, ScanLimits, Scanner, Token};
use crate::limits;

pub(crate) const WARN_INDEX_CHARACTER_LIMIT: &str = "INDEX_CHARACTER_LIMIT";
pub(crate) const WARN_INDEX_TITLE_LIMIT: &str = "INDEX_TITLE_LIMIT";
pub(crate) const WARN_INDEX_RELATION_LIMIT: &str = "INDEX_RELATION_LIMIT";
pub(crate) const WARN_INDEX_DUPLICATE_KEY: &str = "INDEX_DUPLICATE_KEY";

/// Numeric-canonical ordering for decimal character ids (plan §7.4).
pub(crate) fn cmp_ids(a: &str, b: &str) -> Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}

/// Deduplicated, numerically sorted id list bounded at a per-record cap.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BoundedIds {
    pub ids: Vec<String>,
    pub truncated: bool,
}

impl BoundedIds {
    fn with_capacity(cap: usize) -> Self {
        Self {
            ids: Vec::with_capacity(cap.min(16)),
            truncated: false,
        }
    }

    /// Returns true when pushing was refused because the cap is hit.
    fn push_bounded(&mut self, id: String, cap: usize) -> bool {
        if self.ids.contains(&id) {
            return false;
        }
        if self.ids.len() >= cap {
            self.truncated = true;
            return true;
        }
        self.ids.push(id);
        false
    }

    fn finish(mut self, cap: usize) -> Self {
        if self.ids.len() > cap {
            self.ids.truncate(cap);
            self.truncated = true;
        }
        self.ids.sort_unstable_by(|a, b| cmp_ids(a, b));
        self
    }
}

fn collect_bounded(values: Vec<String>, cap: usize) -> BoundedIds {
    let mut bounded = BoundedIds::with_capacity(cap.min(16));
    for value in values {
        // Duplicates do not count against the cap.
        let _ = bounded.push_bounded(value, cap);
    }
    bounded.finish(cap)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SectionPartialFlags {
    pub public_family: bool,
    pub realm: bool,
}

#[derive(Debug)]
pub(crate) struct SessionCharacterRecord {
    pub id: String,
    /// None when the save stores an obfuscated localization-key name.
    pub literal_name: Option<String>,
    pub name_is_localization_key: bool,
    pub spouses: BoundedIds,
    pub parents: BoundedIds,
    pub children: BoundedIds,
    pub liege: Option<String>,
    pub direct_vassal_of: Option<String>,
    pub primary_title: Option<String>,
    pub domains: BoundedIds,
    pub realm_capital: Option<String>,
    pub court_owner: Option<String>,
    pub public_location: Option<String>,
    pub sections_partial: SectionPartialFlags,
}

#[derive(Debug)]
pub(crate) struct SessionTitleRecord {
    pub key: Option<String>,
    pub name: Option<String>,
    pub holder: Option<String>,
    pub de_facto_liege: Option<String>,
    pub de_jure_liege: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SessionIndex {
    pub characters: HashMap<String, SessionCharacterRecord>,
    pub titles: HashMap<String, SessionTitleRecord>,
    /// Reverse buckets for relation search anchors; each bounded per key.
    pub vassals_by_liege: HashMap<String, Vec<String>>,
    pub members_by_court: HashMap<String, Vec<String>>,
    pub status: &'static str,
    pub warnings: Vec<String>,
    pub living_character_count: u64,
    pub title_count: u64,
    relation_bucket_truncated: bool,
    relations_cap: usize,
}

impl SessionIndex {
    pub(crate) fn summary(&self) -> crate::session::protocol::SessionIndexSummary {
        crate::session::protocol::SessionIndexSummary {
            status: self.status,
            living_character_count: self.living_character_count,
            title_count: self.title_count,
            warning_codes: self.warnings.clone(),
        }
    }

    /// Deterministic summary digest of index content and ordering. The same
    /// input always produces the same digest regardless of HashMap order.
    pub(crate) fn content_digest(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let mut char_ids: Vec<&String> = self.characters.keys().collect();
        char_ids.sort_unstable_by(|a, b| cmp_ids(a, b));
        for id in char_ids {
            let rec = &self.characters[id];
            let _ = write!(
                out,
                "c{}|n{:?}|s{}|p{}|ch{}|l{}|dv{}|t{}|d{}|rc{}|co{}|loc{}|f{}|r{};",
                id,
                rec.literal_name,
                rec.spouses.ids.join(","),
                rec.parents.ids.join(","),
                rec.children.ids.join(","),
                rec.liege.as_deref().unwrap_or(""),
                rec.direct_vassal_of.as_deref().unwrap_or(""),
                rec.primary_title.as_deref().unwrap_or(""),
                rec.domains.ids.join(","),
                rec.realm_capital.as_deref().unwrap_or(""),
                rec.court_owner.as_deref().unwrap_or(""),
                rec.public_location.as_deref().unwrap_or(""),
                rec.sections_partial.public_family as u8,
                rec.sections_partial.realm as u8,
            );
        }
        let mut title_ids: Vec<&String> = self.titles.keys().collect();
        title_ids.sort();
        for id in title_ids {
            let title = &self.titles[id];
            let _ = write!(
                out,
                "t{id}|k{:?}|nm{:?}|h{}|fl{}|jl{};",
                title.key,
                title.name,
                title.holder.as_deref().unwrap_or(""),
                title.de_facto_liege.as_deref().unwrap_or(""),
                title.de_jure_liege.as_deref().unwrap_or(""),
            );
        }
        out
    }

    fn push_vassal(&mut self, liege: &str, vassal: &str) {
        push_bucket(
            &mut self.vassals_by_liege,
            liege,
            vassal,
            self.relations_cap,
            &mut self.relation_bucket_truncated,
        );
    }

    fn push_court_member(&mut self, owner: &str, member: &str) {
        push_bucket(
            &mut self.members_by_court,
            owner,
            member,
            self.relations_cap,
            &mut self.relation_bucket_truncated,
        );
    }
}

fn push_bucket(
    bucket: &mut HashMap<String, Vec<String>>,
    key: &str,
    value: &str,
    cap: usize,
    truncated: &mut bool,
) {
    let entry = bucket.entry(key.to_string()).or_default();
    if entry.iter().any(|v| v == value) {
        return;
    }
    if entry.len() >= cap {
        *truncated = true;
        return;
    }
    entry.push(value.to_string());
}

/// Request-side limits clamped to the frozen hard caps (App may lower only).
pub(crate) struct IndexLimits {
    pub max_characters: u64,
    pub max_titles: u64,
    pub max_relations_per_character: u64,
}

impl IndexLimits {
    fn clamped(limits: &crate::session::protocol::SessionLimits) -> Self {
        Self {
            max_characters: limits.max_characters.min(limits::HARD_MAX_SESSION_CHARACTERS),
            max_titles: limits.max_titles.min(limits::HARD_MAX_SESSION_TITLES),
            max_relations_per_character: limits
                .max_relations_per_character
                .min(limits::HARD_MAX_SESSION_RELATIONS_PER_CHARACTER)
                .max(1),
        }
    }
}

/// Scan the decompressed gamestate exactly once, entering only `living` and
/// `landed_titles`; every other top-level block is skipped whole.
pub(crate) fn build(
    reader: impl Read,
    scan_limits: ScanLimits,
    request_limits: &crate::session::protocol::SessionLimits,
) -> Result<SessionIndex, IdentityError> {
    let caps = IndexLimits::clamped(request_limits);
    let relations_cap = caps.max_relations_per_character as usize;
    let mut index = SessionIndex {
        characters: HashMap::new(),
        titles: HashMap::new(),
        vassals_by_liege: HashMap::new(),
        members_by_court: HashMap::new(),
        status: "ready",
        warnings: Vec::new(),
        living_character_count: 0,
        title_count: 0,
        relation_bucket_truncated: false,
        relations_cap,
    };
    let mut character_limit_warned = false;
    let mut title_limit_warned = false;

    let mut scanner = Scanner::new(reader, scan_limits);
    loop {
        match scanner.next_token()? {
            Token::Eof | Token::RBrace => break,
            Token::Scalar(key) | Token::Str(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"living" => scan_living_block(
                        &mut scanner,
                        &mut index,
                        &caps,
                        relations_cap,
                        &mut character_limit_warned,
                    )?,
                    b"landed_titles" => {
                        scan_title_block(&mut scanner, &mut index, &caps, &mut title_limit_warned)?
                    }
                    // meta_data / variables / events / secrets / AI state /
                    // anything else: skipped without reading contents.
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }

    derive_reverse_relations(&mut index);
    finalize_warnings(&mut index);
    Ok(index)
}

#[allow(clippy::too_many_arguments)]
fn scan_living_block<R: Read>(
    scanner: &mut Scanner<R>,
    index: &mut SessionIndex,
    caps: &IndexLimits,
    relations_cap: usize,
    character_limit_warned: &mut bool,
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
                index.living_character_count += 1;
                if rec.duplicate_key {
                    push_warning_once(index, WARN_INDEX_DUPLICATE_KEY);
                }
                if index.characters.len() as u64 >= caps.max_characters {
                    if !*character_limit_warned {
                        *character_limit_warned = true;
                        index.status = "partial";
                        push_warning_once(index, WARN_INDEX_CHARACTER_LIMIT);
                    }
                    continue;
                }
                let literal_name = if rec.first_name_is_localization_key {
                    None
                } else {
                    rec.first_name.clone()
                };
                let parents_src: Vec<String> =
                    [rec.mother.clone(), rec.father.clone()].into_iter().flatten().collect();
                let parents = collect_bounded(parents_src, relations_cap);
                let children = collect_bounded(rec.children.clone(), relations_cap);
                let spouses = collect_bounded(rec.spouses.clone(), relations_cap);
                let domains = collect_bounded(rec.domains.clone(), relations_cap);
                let sections_partial = SectionPartialFlags {
                    public_family: parents.truncated || children.truncated || spouses.truncated,
                    realm: domains.truncated,
                };
                let primary_title = rec
                    .primary_title
                    .or_else(|| rec.domains.first().cloned());
                index.characters.insert(
                    id.clone(),
                    SessionCharacterRecord {
                        id,
                        literal_name,
                        name_is_localization_key: rec.first_name_is_localization_key,
                        spouses,
                        parents,
                        children,
                        liege: rec.liege,
                        direct_vassal_of: rec.direct_vassal_of,
                        primary_title,
                        domains,
                        realm_capital: rec.realm_capital,
                        court_owner: rec.court_owner,
                        public_location: rec.current_location,
                        sections_partial,
                    },
                );
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_title_block<R: Read>(
    scanner: &mut Scanner<R>,
    index: &mut SessionIndex,
    caps: &IndexLimits,
    title_limit_warned: &mut bool,
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
                    scan_title_block(scanner, index, caps, title_limit_warned)?;
                    continue;
                }
                // Real saves carry non-numeric metadata entries here such as
                // `dynamic_templates={...}`; skip them like extract does.
                if id_bytes.is_empty() || !id_bytes.iter().all(|b| b.is_ascii_digit()) {
                    scanner.skip_value()?;
                    continue;
                }
                let rec = realm::scan_title(scanner)?;
                if rec.duplicate_key {
                    push_warning_once(index, WARN_INDEX_DUPLICATE_KEY);
                }
                if index.titles.len() as u64 >= caps.max_titles {
                    if !*title_limit_warned {
                        *title_limit_warned = true;
                        index.status = "partial";
                        push_warning_once(index, WARN_INDEX_TITLE_LIMIT);
                    }
                    continue;
                }
                let id = String::from_utf8(id_bytes).map_err(|_| IdentityError::ParseFailed)?;
                index.title_count += 1;
                index.titles.insert(
                    id,
                    SessionTitleRecord {
                        key: rec.key,
                        name: rec.name,
                        holder: rec.holder,
                        de_facto_liege: rec.de_facto_liege,
                        de_jure_liege: rec.de_jure_liege,
                    },
                );
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// Reverse derivation (plan §7.2): parents listed only in the parent's
/// `family_data.child`, plus reverse liege/court buckets, all in deterministic
/// numeric-id order.
fn derive_reverse_relations(index: &mut SessionIndex) {
    let mut derived_parents: Vec<(String, String)> = Vec::new();
    let mut char_ids: Vec<&String> = index.characters.keys().collect();
    char_ids.sort_unstable_by(|a, b| cmp_ids(a, b));
    for parent_id in char_ids {
        let children = index.characters[parent_id].children.ids.clone();
        for child in children {
            derived_parents.push((child, parent_id.clone()));
        }
    }
    for (child, parent) in derived_parents {
        let relations_cap = index.relations_cap;
        if let Some(record) = index.characters.get_mut(&child) {
            let refused = record.parents.push_bounded(parent, relations_cap);
            if refused {
                record.sections_partial.public_family = true;
            }
        }
    }

    // Spouse symmetry: real saves normally list marriages on both records,
    // but the public index must not depend on that. Derive the mirror link
    // deterministically (bounded by the same relation cap).
    let mut derived_spouses: Vec<(String, String)> = Vec::new();
    let mut char_ids: Vec<&String> = index.characters.keys().collect();
    char_ids.sort_unstable_by(|a, b| cmp_ids(a, b));
    for spouse_id in char_ids {
        let spouses = index.characters[spouse_id].spouses.ids.clone();
        for partner in spouses {
            derived_spouses.push((partner, spouse_id.clone()));
        }
    }
    for (partner, spouse) in derived_spouses {
        let relations_cap = index.relations_cap;
        if let Some(record) = index.characters.get_mut(&partner) {
            let refused = record.spouses.push_bounded(spouse, relations_cap);
            if refused {
                record.sections_partial.public_family = true;
            }
        }
    }

    // Liege/vassal and court membership reverse buckets, from an owned
    // snapshot so bucket mutation cannot alias key iteration.
    let mut forward: Vec<(String, Option<String>, Option<String>, Option<String>)> = Vec::new();
    let mut char_ids: Vec<&String> = index.characters.keys().collect();
    char_ids.sort_unstable_by(|a, b| cmp_ids(a, b));
    for id in char_ids {
        let rec = &index.characters[id];
        forward.push((
            id.clone(),
            rec.liege.clone(),
            rec.direct_vassal_of.clone(),
            rec.court_owner.clone(),
        ));
    }
    for (id, liege, direct_vassal_of, court_owner) in forward {
        if let Some(liege_id) = liege.as_ref() {
            index.push_vassal(liege_id, &id);
        }
        if let Some(direct) = direct_vassal_of.as_ref() {
            if Some(direct) != liege.as_ref() {
                index.push_vassal(direct, &id);
            }
        }
        if let Some(owner) = court_owner {
            index.push_court_member(&owner, &id);
        }
    }

    if index.relation_bucket_truncated {
        index.status = "partial";
        push_warning_once(index, WARN_INDEX_RELATION_LIMIT);
    }
}

fn finalize_warnings(index: &mut SessionIndex) {
    index.warnings.sort_unstable();
    index.warnings.dedup();
}

fn push_warning_once(index: &mut SessionIndex, code: &str) {
    if !index.warnings.iter().any(|w| w == code) {
        index.warnings.push(code.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::protocol::SessionLimits;

    fn scan_limits() -> ScanLimits {
        ScanLimits { max_bytes: 8 << 20, max_nesting: 64, max_scalar: 4096 }
    }

    fn session_limits() -> SessionLimits {
        serde_json::from_value(serde_json::json!({
            "maxDecompressedBytes": 67108864,
            "maxNestingDepth": 64,
            "maxScalarBytes": 4096,
            "maxCharacters": 100000,
            "maxTitles": 50000,
            "maxRelationsPerCharacter": 128,
            "maxIdleMs": 600000
        }))
        .unwrap()
    }

    fn build_from_text(text: &str) -> SessionIndex {
        build(std::io::Cursor::new(text.as_bytes().to_vec()), scan_limits(), &session_limits()).unwrap()
    }

    fn char_entry(id: &str, body: &str) -> String {
        format!("\t{id}={{\n{body}\t}}\n")
    }

    #[test]
    fn obfuscated_names_never_become_literal_names() {
        let text = format!(
            "living={{\n{}\n}}\n",
            char_entry(
                "1001",
                concat!(
                    "\t\tfirst_name=\"fictional_player\"\n",
                    "\t\talive_data={}\n"
                )
            )
        );
        let index = build_from_text(&text);
        let record = &index.characters["1001"];
        assert_eq!(record.literal_name, None);
        assert!(record.name_is_localization_key);
        assert!(!index.content_digest().contains("fictional_player"));
    }

    #[test]
    fn duplicate_single_value_keys_are_first_wins_with_warning() {
        let text = format!(
            "living={{\n{}\n}}\n",
            char_entry(
                "1002",
                concat!(
                    "\t\tfirst_name=\"Aldric\"\n",
                    "\t\tfirst_name=\"Second\"\n",
                    "\t\talive_data={\n\t\t\tliege=10\n\t\t\tliege=20\n\t\t}\n"
                )
            )
        );
        let index = build_from_text(&text);
        let record = &index.characters["1002"];
        assert_eq!(record.literal_name.as_deref(), Some("Aldric"));
        assert_eq!(record.liege.as_deref(), Some("10"));
        assert!(index.warnings.iter().any(|w| w == WARN_INDEX_DUPLICATE_KEY));
    }

    #[test]
    fn secrets_and_hidden_fields_are_not_materialized() {
        let text = format!(
            "living={{\n{}\n}}\n",
            char_entry(
                "1003",
                concat!(
                    "\t\tfirst_name=\"Baldwin\"\n",
                    "\t\treal_father=999\n",
                    "\t\tsecrets={ data={ { type=MARKER_SECRET_777777 } } }\n",
                    "\t\tai_behavior=MARKER_AI_888888\n",
                    "\t\talive_data={}\n"
                )
            )
        );
        let index = build_from_text(&text);
        let dump = format!("{index:?}");
        assert!(!dump.contains("MARKER_SECRET_777777"));
        assert!(!dump.contains("MARKER_AI_888888"));
        assert!(!index.content_digest().contains("777777"));
    }

    #[test]
    fn relation_storm_is_bounded_and_flags_partial_family() {
        let mut spouses = String::new();
        for i in 0..200 {
            spouses.push_str(&format!("\t\tspouse={}\n", 5000 + i));
        }
        let text = format!(
            "living={{\n{}\n}}\n",
            char_entry("1004", &format!("\t\tfirst_name=\"Storm\"\n{spouses}\t\talive_data={{}}\n"))
        );
        let index = build_from_text(&text);
        let record = &index.characters["1004"];
        assert_eq!(record.spouses.ids.len(), 128);
        assert!(record.spouses.truncated);
        assert!(record.sections_partial.public_family);
    }

    #[test]
    fn reverse_family_and_court_buckets_are_derived() {
        let text = format!(
            "living={{\n{}{}{}{}\n}}\n",
            char_entry(
                "2001",
                concat!(
                    "\t\tfirst_name=\"Parent\"\n",
                    "\t\tfamily_data={ child={ 3002 } }\n",
                    "\t\tcourt_data={ host=4000 }\n"
                )
            ),
            char_entry("3002", "\t\tfirst_name=\"Child\"\n"),
            char_entry(
                "2003",
                concat!("\t\tfirst_name=\"Courtier\"\n", "\t\tcourt_data={ host=4000 }\n")
            ),
            char_entry(
                "4000",
                concat!("\t\tfirst_name=\"Host\"\n", "\t\talive_data={ liege=5000 }\n")
            ),
        );
        let index = build_from_text(&text);
        let child = &index.characters["3002"];
        assert!(child.parents.ids.iter().any(|p| p == "2001"));
        let members = &index.members_by_court["4000"];
        assert!(members.contains(&"2001".to_string()));
        assert!(members.contains(&"2003".to_string()));
        assert!(index.vassals_by_liege["5000"].contains(&"4000".to_string()));
    }

    #[test]
    fn character_and_title_caps_flip_index_to_partial_with_warnings() {
        // App-requestable lower cap: 2 characters.
        let mut entries = String::new();
        for i in 0..5 {
            entries.push_str(&char_entry(
                &(3000 + i).to_string(),
                "\t\tfirst_name=\"Filler\"\n\t\talive_data={}\n",
            ));
        }
        let text = format!("living={{\n{entries}\n}}\n");
        let mut limits = session_limits();
        limits.max_characters = 2;
        let index =
            build(std::io::Cursor::new(text.as_bytes().to_vec()), scan_limits(), &limits).unwrap();
        assert_eq!(index.characters.len(), 2);
        assert_eq!(index.living_character_count, 5);
        assert_eq!(index.status, "partial");
        assert!(index.warnings.contains(&WARN_INDEX_CHARACTER_LIMIT.to_string()));

        // Title cap via lowered request limit. Landed-titles entries use
        // numeric ids; `key=` carries the loc key.
        let mut title_entries = String::new();
        for i in 0..4 {
            title_entries.push_str(&format!(
                "\t{}={{\n\t\tkey=\"TITLE_KEY_{i}\"\n\t}}\n",
                8000 + i
            ));
        }
        let title_text = format!("landed_titles={{\n{title_entries}\n}}\nliving={{\n{}\n}}\n", char_entry("6001", "\t\tfirst_name=\"Lone\"\n"));
        let mut limits = session_limits();
        limits.max_titles = 3;
        let index =
            build(std::io::Cursor::new(title_text.as_bytes().to_vec()), scan_limits(), &limits).unwrap();
        assert_eq!(index.titles.len(), 3);
        assert_eq!(index.status, "partial");
        assert!(index.warnings.contains(&WARN_INDEX_TITLE_LIMIT.to_string()));
    }

    #[test]
    fn digest_is_stable_across_runs_and_insertion_orders() {
        let make = |reverse: bool| -> String {
            let ids: Vec<u32> = if reverse {
                (7000..7010).rev().collect()
            } else {
                (7000..7010).collect()
            };
            let mut entries = String::new();
            for id in ids {
                entries.push_str(&char_entry(
                    &id.to_string(),
                    "\t\tfirst_name=\"Stable\"\n\t\talive_data={ liege=9 }\n",
                ));
            }
            format!("living={{\n{entries}\n}}\n")
        };
        let forward = build_from_text(&make(false));
        let backward = build_from_text(&make(true));
        assert_eq!(forward.content_digest(), backward.content_digest());
    }
}
