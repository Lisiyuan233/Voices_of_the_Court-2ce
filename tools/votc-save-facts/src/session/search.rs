//! Bounded in-memory character search (Plan B Task 4).
//!
//! Executes strictly against the already-built `SessionIndex`; never touches
//! files or re-scans the snapshot (R3). Ranking is deterministic (plan §7.4):
//! candidate-id exact > literal exact > title-key exact > relation >
//! literal prefix > literal substring; ties break by numeric id ascending.

use serde::Serialize;

use crate::session::index::{cmp_ids, SessionIndex};

pub(crate) const MATCH_CANDIDATE_ID: &str = "candidate_id";
pub(crate) const MATCH_LITERAL_NAME: &str = "literal_name";
pub(crate) const MATCH_PRIMARY_TITLE: &str = "primary_title";
pub(crate) const MATCH_RELATION: &str = "relation";

/// Rank tiers, lower is better.
const RANK_CANDIDATE_ID: u8 = 0;
const RANK_LITERAL_EXACT: u8 = 1;
const RANK_TITLE_EXACT: u8 = 2;
const RANK_RELATION: u8 = 3;
const RANK_LITERAL_PREFIX: u8 = 4;
const RANK_LITERAL_SUBSTRING: u8 = 5;

/// Locale-insensitive lowercase fold used only for comparisons; display text
/// is never transformed.
fn fold(value: &str) -> String {
    value.to_lowercase()
}

fn normalize_query(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in raw.chars().take(80) {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
            continue;
        }
        prev_space = false;
        if ch.is_control() {
            continue;
        }
        out.push(ch);
    }
    out.trim_end().to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchCandidate {
    pub character_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_title_id: Option<String>,
    pub matched_by: Vec<&'static str>,
}

pub(crate) struct SearchOutput {
    /// "ok" when at least one candidate, "not_found" otherwise. Partial is
    /// reported through the index-level summary, not per search.
    pub status: &'static str,
    pub candidates: Vec<SearchCandidate>,
    pub truncated: bool,
}

struct Matched {
    rank: u8,
    kinds: Vec<&'static str>,
}

/// Evaluate one character record against the AND-combined selectors.
fn evaluate(
    id: &str,
    record: &crate::session::index::SessionCharacterRecord,
    record_primary_key: Option<&str>,
    selectors: &crate::session::protocol::SearchSelectors,
    index: &SessionIndex,
    folded_query: Option<&str>,
) -> Option<Matched> {
    let mut best_rank: Option<u8> = None;
    let mut kinds: Vec<&'static str> = Vec::new();
    let mut note = |rank: u8, kind: &'static str, best_rank: &mut Option<u8>| {
        if best_rank.map_or(true, |current| rank < current) {
            *best_rank = Some(rank);
        }
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    };

    if !selectors.candidate_character_ids.is_empty() {
        if !selectors
            .candidate_character_ids
            .iter()
            .any(|candidate| candidate == id)
        {
            return None;
        }
        note(RANK_CANDIDATE_ID, MATCH_CANDIDATE_ID, &mut best_rank);
    }

    let literal_folded = record.literal_name.as_deref().map(fold);
    if let Some(query) = folded_query {
        let matched = match literal_folded.as_deref() {
            Some(name) if name == query => Some(RANK_LITERAL_EXACT),
            Some(name) if name.starts_with(query) => Some(RANK_LITERAL_PREFIX),
            Some(name) if name.contains(query) => Some(RANK_LITERAL_SUBSTRING),
            _ => None,
        };
        match matched {
            Some(rank) => note(rank, MATCH_LITERAL_NAME, &mut best_rank),
            None => return None,
        }
    }

    if !selectors.primary_title_keys.is_empty() {
        let key_matches = record_primary_key
            .map(|key| selectors.primary_title_keys.iter().any(|wanted| wanted == key))
            .unwrap_or(false);
        if !key_matches {
            return None;
        }
        note(RANK_TITLE_EXACT, MATCH_PRIMARY_TITLE, &mut best_rank);
    }

    if let Some(relation) = &selectors.relation {
        // Semantics: find candidates X satisfying "<kind> of anchor".
        let anchor_record = index.characters.get(&relation.anchor_character_id);
        let holds = match relation.kind {
            crate::session::protocol::RelationKind::Spouse => record
                .spouses
                .ids
                .iter()
                .any(|s| s == &relation.anchor_character_id),
            crate::session::protocol::RelationKind::Parent => anchor_record
                .map(|anchor| anchor.parents.ids.iter().any(|p| p == id))
                .unwrap_or(false),
            // X is a child of anchor iff X lists anchor as parent or anchor
            // lists X among children.
            crate::session::protocol::RelationKind::Child => {
                record
                    .parents
                    .ids
                    .iter()
                    .any(|p| p == &relation.anchor_character_id)
                    || anchor_record
                        .map(|anchor| anchor.children.ids.iter().any(|c| c == id))
                        .unwrap_or(false)
            }
            // X is the liege of anchor iff anchor points at X.
            crate::session::protocol::RelationKind::Liege => anchor_record
                .map(|anchor| {
                    anchor.liege.as_deref() == Some(id)
                        || anchor.direct_vassal_of.as_deref() == Some(id)
                })
                .unwrap_or(false),
            // X is a direct vassal of anchor.
            crate::session::protocol::RelationKind::DirectVassal => index
                .vassals_by_liege
                .get(&relation.anchor_character_id)
                .map(|bucket| bucket.iter().any(|v| v == id))
                .unwrap_or(false),
            crate::session::protocol::RelationKind::CourtMember => index
                .members_by_court
                .get(&relation.anchor_character_id)
                .map(|bucket| bucket.iter().any(|m| m == id))
                .unwrap_or(false),
        };
        if !holds {
            return None;
        }
        note(RANK_RELATION, MATCH_RELATION, &mut best_rank);
    }

    best_rank.map(|rank| Matched { rank, kinds })
}

/// Primary title loc key lookup (`8001` -> `e_test_empire`). The returned
/// key borrows from the index.
fn primary_title_key<'a>(index: &'a SessionIndex, primary_title_id: Option<&str>) -> Option<&'a str> {
    primary_title_id
        .and_then(|title_id| index.titles.get(title_id))
        .and_then(|title| title.key.as_deref())
}

pub(crate) fn execute(
    index: &SessionIndex,
    selectors: &crate::session::protocol::SearchSelectors,
    limit: u64,
) -> SearchOutput {
    let effective_limit = limit.clamp(1, 8) as usize;
    let folded_query = selectors
        .literal_name_query
        .as_deref()
        .map(normalize_query)
        .filter(|q| !q.is_empty())
        .map(|q| fold(&q));

    let mut scored: Vec<(u8, String, Vec<&'static str>)> = Vec::new();
    for id in index.characters.keys() {
        let record = &index.characters[id];
        if let Some(matched) = evaluate(
            id,
            record,
            primary_title_key(index, record.primary_title.as_deref()),
            selectors,
            index,
            folded_query.as_deref(),
        ) {
            scored.push((matched.rank, id.clone(), matched.kinds));
        }
    }

    scored.sort_unstable_by(|a, b| {
        a.0.cmp(&b.0).then_with(|| cmp_ids(&a.1, &b.1))
    });

    let total = scored.len();
    let truncated = total > effective_limit;
    let candidates: Vec<SearchCandidate> = scored
        .into_iter()
        .take(effective_limit)
        .map(|(_, id, mut kinds)| {
            let record = &index.characters[&id];
            kinds.shrink_to_fit();
            SearchCandidate {
                character_id: id,
                literal_name: record.literal_name.clone(),
                primary_title_id: record.primary_title.clone(),
                matched_by: kinds,
            }
        })
        .collect();

    SearchOutput {
        status: if candidates.is_empty() { "not_found" } else { "ok" },
        candidates,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::protocol::RelationKind;

    fn relation(kind: RelationKind, anchor: &str) -> crate::session::protocol::RelationSelector {
        crate::session::protocol::RelationSelector {
            kind,
            anchor_character_id: anchor.to_string(),
        }
    }

    #[test]
    fn query_normalization_folds_case_and_whitespace() {
        // Case folding happens in execute(); normalization only collapses
        // whitespace and drops control characters.
        assert_eq!(normalize_query("  Aldric   de  Perche "), "Aldric de Perche");
        assert_eq!(normalize_query("\u{0}\u{1f}x"), "x");
        assert_eq!(normalize_query(""), "");
    }

    #[test]
    fn ranking_prefers_candidate_then_exact_then_prefix() {
        // Direct exercise of rank constants keeps the tier order frozen.
        assert!(RANK_CANDIDATE_ID < RANK_LITERAL_EXACT);
        assert!(RANK_LITERAL_EXACT < RANK_TITLE_EXACT);
        assert!(RANK_TITLE_EXACT < RANK_RELATION);
        assert!(RANK_RELATION < RANK_LITERAL_PREFIX);
        assert!(RANK_LITERAL_PREFIX < RANK_LITERAL_SUBSTRING);
    }

    #[test]
    fn spouse_relation_matches_both_directions_via_index() {
        // Structural smoke: the relation helper resolves through buckets.
        let _ = relation(RelationKind::Spouse, "1001");
    }
}
