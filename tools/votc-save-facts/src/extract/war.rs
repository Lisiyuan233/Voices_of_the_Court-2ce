//! Bounded public-war extraction.
//!
//! The save schema is not treated as known CK3 truth here.  This slice only
//! accepts the small, explicit fixture schema below:
//!
//! ```text
//! wars={
//!   7001={
//!     name="Northern War"
//!     attacker={ character=1001 }
//!     defender={ character=1002 }
//!     casus_belli=claim
//!     score=60
//!   }
//! }
//! ```
//!
//! A side must contain exactly a numeric `character` or `title` reference.
//! Unknown CK3 war layouts are skipped rather than guessed.  Only a safe
//! literal `name` can establish a war entity; localization keys, hidden
//! fields, participant lists, and exact military values never cross the wire.

use std::collections::HashMap;
use std::io::Read;

use super::normalize::FactSink;
use crate::identity::{IdentityError, Scanner, Token};
use crate::protocol::{
    Category, Confidence, EntityType, FactSensitivity, FactVisibility, Predicate,
};

pub(crate) const WARN_WAR_TRUNCATED: &str = "WAR_EXTRACTION_TRUNCATED";
const WAR_PER_PARTICIPANT_CAP: usize = 3;

const SRC_AT_WAR: &str = "character_at_war";
const SRC_ATTACKER: &str = "war_attacker";
const SRC_DEFENDER: &str = "war_defender";
const SRC_CASUS_BELLI: &str = "war_casus_belli";
const SRC_SCORE_BAND: &str = "character_war_score_band";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WarSide {
    Character(String),
    Title(String),
}

impl WarSide {
    fn entity(&self) -> (EntityType, &str) {
        match self {
            Self::Character(id) => (EntityType::Character, id),
            Self::Title(id) => (EntityType::Title, id),
        }
    }

    fn character_id(&self) -> Option<&str> {
        match self {
            Self::Character(id) => Some(id),
            Self::Title(_) => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WarRecord {
    pub id: String,
    pub name: Option<String>,
    pub attacker: Option<WarSide>,
    pub defender: Option<WarSide>,
    pub casus_belli: Option<String>,
    pub score: Option<i64>,
}

fn parse_id(raw: &[u8]) -> Result<String, IdentityError> {
    if raw.is_empty() || !raw.iter().all(|b| b.is_ascii_digit()) {
        return Err(IdentityError::ParseFailed);
    }
    String::from_utf8(raw.to_vec()).map_err(|_| IdentityError::ParseFailed)
}

fn read_id<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value) => parse_id(&value),
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn read_text<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value) => {
            String::from_utf8(value).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn safe_name(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_score<R: Read>(scanner: &mut Scanner<R>) -> Result<Option<i64>, IdentityError> {
    let raw = read_text(scanner)?;
    Ok(raw
        .parse::<i64>()
        .ok()
        .filter(|score| (-100..=100).contains(score)))
}

fn scan_side<R: Read>(scanner: &mut Scanner<R>) -> Result<Option<WarSide>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut side = None;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(side),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"character" if side.is_none() => {
                        side = Some(WarSide::Character(read_id(scanner)?));
                    }
                    b"title" if side.is_none() => {
                        side = Some(WarSide::Title(read_id(scanner)?));
                    }
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_war<R: Read>(scanner: &mut Scanner<R>, id: String) -> Result<WarRecord, IdentityError> {
    scanner.expect_lbrace()?;
    let mut record = WarRecord {
        id,
        ..WarRecord::default()
    };
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(record),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"name" if record.name.is_none() => {
                        record.name = safe_name(read_text(scanner)?);
                    }
                    b"attacker" if record.attacker.is_none() => {
                        record.attacker = scan_side(scanner)?;
                    }
                    b"defender" if record.defender.is_none() => {
                        record.defender = scan_side(scanner)?;
                    }
                    b"casus_belli" if record.casus_belli.is_none() => {
                        record.casus_belli = Some(read_text(scanner)?);
                    }
                    b"score" if record.score.is_none() => {
                        record.score = read_score(scanner)?;
                    }
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

pub(crate) fn scan_wars<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Vec<WarRecord>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut records: Vec<WarRecord> = Vec::new();
    loop {
        match scanner.next_token()? {
            Token::RBrace => {
                records.sort_by(|a, b| a.id.cmp(&b.id));
                return Ok(records);
            }
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(id_bytes) | Token::Str(id_bytes) => {
                scanner.expect_eq()?;
                if id_bytes.is_empty() || !id_bytes.iter().all(|b| b.is_ascii_digit()) {
                    scanner.skip_value()?;
                    continue;
                }
                let id = parse_id(&id_bytes)?;
                records.push(scan_war(scanner, id)?);
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn map_casus_belli(raw: &str) -> Option<&'static str> {
    match raw {
        "claim" => Some("claim"),
        "conquest" => Some("conquest"),
        "de_jure" => Some("de_jure"),
        "holy_war" => Some("holy_war"),
        "independence" => Some("independence"),
        "liberation" => Some("liberation"),
        "succession" => Some("succession"),
        _ => None,
    }
}

pub(crate) fn score_band(score: i64, participant_is_attacker: bool) -> Option<&'static str> {
    let perspective = if participant_is_attacker {
        score
    } else {
        -score
    };
    Some(match perspective {
        -100..=-75 => "decisive_loss",
        -74..=-26 => "losing",
        -25..=25 => "balanced",
        26..=74 => "winning",
        75..=100 => "decisive_win",
        _ => return None,
    })
}

/// Record only wars where a participant is the known primary side or has a
/// known direct liege who is that primary side. The cap counts wars, not facts.
pub(crate) fn record_wars(
    sink: &mut FactSink,
    wars: &[WarRecord],
    participant_lieges: &HashMap<String, String>,
    war_names: &mut HashMap<String, String>,
) {
    let mut counts: HashMap<String, usize> = HashMap::new();

    for war in wars {
        let Some(name) = war.name.as_deref() else {
            continue;
        };
        let attacker_id = war.attacker.as_ref().and_then(WarSide::character_id);
        let defender_id = war.defender.as_ref().and_then(WarSide::character_id);
        let mut relevant = Vec::new();

        for participant in sink.participant_ids() {
            let direct_attacker = attacker_id == Some(participant.as_str());
            let direct_defender = defender_id == Some(participant.as_str());
            let liege_attacker = participant_lieges
                .get(&participant)
                .is_some_and(|liege| attacker_id == Some(liege.as_str()));
            let liege_defender = participant_lieges
                .get(&participant)
                .is_some_and(|liege| defender_id == Some(liege.as_str()));
            let is_attacker = direct_attacker || liege_attacker;
            let is_defender = direct_defender || liege_defender;
            if is_attacker ^ is_defender {
                relevant.push((participant.clone(), is_attacker));
            }
        }

        relevant.retain(|(participant, _)| {
            let count = counts.entry(participant.clone()).or_default();
            if *count >= WAR_PER_PARTICIPANT_CAP {
                sink.mark_partial_with_warning(WARN_WAR_TRUNCATED);
                false
            } else {
                *count += 1;
                true
            }
        });
        if relevant.is_empty() {
            continue;
        }
        if sink.is_full() {
            sink.mark_partial_with_warning(WARN_WAR_TRUNCATED);
            break;
        }

        war_names.insert(war.id.clone(), name.to_string());
        if let Some(attacker) = &war.attacker {
            sink.push_fact(
                Category::War,
                (EntityType::War, &war.id),
                Predicate::WarAttacker,
                Some(attacker.entity()),
                SRC_ATTACKER,
                Confidence::Exact,
                FactVisibility::Public,
                FactSensitivity::Political,
            );
        }
        if let Some(defender) = &war.defender {
            sink.push_fact(
                Category::War,
                (EntityType::War, &war.id),
                Predicate::WarDefender,
                Some(defender.entity()),
                SRC_DEFENDER,
                Confidence::Exact,
                FactVisibility::Public,
                FactSensitivity::Political,
            );
        }
        if let Some(casus_belli) = war.casus_belli.as_deref().and_then(map_casus_belli) {
            sink.push_fact_with_value(
                Category::War,
                (EntityType::War, &war.id),
                Predicate::WarCasusBelli,
                None,
                SRC_CASUS_BELLI,
                Confidence::Mapped,
                FactVisibility::Public,
                FactSensitivity::Political,
                Some(casus_belli),
            );
        }
        for (participant, is_attacker) in relevant {
            sink.push_fact(
                Category::War,
                (EntityType::Character, &participant),
                Predicate::CharacterAtWar,
                Some((EntityType::War, &war.id)),
                SRC_AT_WAR,
                Confidence::Exact,
                FactVisibility::Public,
                FactSensitivity::Political,
            );
            if let Some(score) = war.score.and_then(|score| score_band(score, is_attacker)) {
                sink.push_fact_with_value(
                    Category::War,
                    (EntityType::Character, &participant),
                    Predicate::CharacterWarScoreBand,
                    Some((EntityType::War, &war.id)),
                    SRC_SCORE_BAND,
                    Confidence::Mapped,
                    FactVisibility::Public,
                    FactSensitivity::Political,
                    Some(score),
                );
            }
        }
    }
}
