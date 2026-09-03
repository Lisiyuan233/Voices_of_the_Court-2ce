//! Sparse, closed-allowlist character verification.
//!
//! Only requested decimal character IDs are materialized (at most 32). For a
//! requested character, only fields needed by the seven frozen v2 checks are
//! parsed. Missing fields remain unknown; they are never converted to false.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use crate::identity::{IdentityError, ScanLimits, Scanner, Token};
use crate::protocol::{
    SaveVerificationCheckV2, SaveVerificationResultV2, VerificationBooleanOutcomeV2,
    VerificationCouncilPositionV2, VerificationCourtPositionV2, VerificationLifeOutcomeV2,
    VerificationLifeStateV2, VerificationSkillV2, VerificationUnknownReasonV2,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifeState {
    Living,
    Dead,
}

#[derive(Debug, Default)]
struct CharacterRecord {
    life_state: Option<LifeState>,
    duplicate_state: bool,
    traits: Option<BTreeSet<u64>>,
    skills: Option<[i64; 6]>,
    council_position: Option<String>,
    court_position: Option<String>,
    commander: Option<bool>,
    gold: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct RequestedFields {
    traits: bool,
    skills: bool,
    council_position: bool,
    court_position: bool,
    commander: bool,
    gold: bool,
}

impl RequestedFields {
    fn from_check(check: &SaveVerificationCheckV2) -> Self {
        let mut fields = Self::default();
        match check {
            SaveVerificationCheckV2::CharacterLifeState { .. } => {}
            SaveVerificationCheckV2::CharacterHasTrait { .. } => fields.traits = true,
            SaveVerificationCheckV2::CharacterSkillAtLeast { .. } => fields.skills = true,
            SaveVerificationCheckV2::CharacterHasCouncilPosition { .. } => {
                fields.council_position = true
            }
            SaveVerificationCheckV2::CharacterHasCourtPosition { .. } => {
                fields.court_position = true
            }
            SaveVerificationCheckV2::CharacterIsCommander { .. } => fields.commander = true,
            SaveVerificationCheckV2::CharacterGoldAtLeast { .. } => fields.gold = true,
        }
        fields
    }

    fn merge(&mut self, other: Self) {
        self.traits |= other.traits;
        self.skills |= other.skills;
        self.council_position |= other.council_position;
        self.court_position |= other.court_position;
        self.commander |= other.commander;
        self.gold |= other.gold;
    }

    fn any(self) -> bool {
        self.traits
            || self.skills
            || self.council_position
            || self.court_position
            || self.commander
            || self.gold
    }
}

pub(crate) struct Verification {
    records: BTreeMap<String, CharacterRecord>,
}

pub(crate) fn scan(
    reader: impl Read,
    limits: ScanLimits,
    checks: &[SaveVerificationCheckV2],
) -> Result<Verification, IdentityError> {
    let mut requested = BTreeMap::<String, RequestedFields>::new();
    for check in checks {
        requested
            .entry(check.character_id().to_string())
            .or_default()
            .merge(RequestedFields::from_check(check));
    }
    let mut records = requested
        .keys()
        .map(|id| (id.clone(), CharacterRecord::default()))
        .collect::<BTreeMap<_, _>>();
    let mut scanner = Scanner::new(reader, limits);
    loop {
        match scanner.next_token()? {
            Token::Eof => {
                if scanner.depth != 0 {
                    return Err(IdentityError::Truncated);
                }
                return Ok(Verification { records });
            }
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                let life_state = match key.as_slice() {
                    b"living" => Some(LifeState::Living),
                    b"dead" | b"dead_prunable" | b"dead_unprunable" => Some(LifeState::Dead),
                    _ => None,
                };
                if let Some(life_state) = life_state {
                    scan_character_collection(&mut scanner, &requested, &mut records, life_state)?;
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_character_collection<R: Read>(
    scanner: &mut Scanner<R>,
    requested: &BTreeMap<String, RequestedFields>,
    records: &mut BTreeMap<String, CharacterRecord>,
    life_state: LifeState,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(id) | Token::Str(id) => {
                let id = decimal_string(&id)?;
                scanner.expect_eq()?;
                if let Some(fields) = requested.get(&id).copied() {
                    let mut parsed = if fields.any() {
                        scan_character(scanner, fields)?
                    } else {
                        scanner.skip_value()?;
                        CharacterRecord::default()
                    };
                    let destination = records.get_mut(&id).ok_or(IdentityError::ParseFailed)?;
                    if destination.life_state.is_some() {
                        destination.duplicate_state = true;
                    } else {
                        parsed.life_state = Some(life_state);
                        *destination = parsed;
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_character<R: Read>(
    scanner: &mut Scanner<R>,
    requested: RequestedFields,
) -> Result<CharacterRecord, IdentityError> {
    scanner.expect_lbrace()?;
    let mut record = CharacterRecord::default();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(record),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"traits" if requested.traits => {
                        assign_once(&mut record.traits, scan_traits(scanner)?)?
                    }
                    b"skill" if requested.skills => {
                        assign_once(&mut record.skills, scan_skills(scanner)?)?
                    }
                    b"alive_data" if requested.gold || requested.commander => {
                        scan_alive_data(scanner, &mut record, requested)?
                    }
                    b"court_data" if requested.council_position || requested.court_position => {
                        scan_court_data(scanner, &mut record, requested)?
                    }
                    b"commander" | b"is_commander" if requested.commander => {
                        assign_once(&mut record.commander, read_bool(scanner)?)?
                    }
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_alive_data<R: Read>(
    scanner: &mut Scanner<R>,
    record: &mut CharacterRecord,
    requested: RequestedFields,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"gold" if requested.gold => {
                        assign_once(&mut record.gold, read_gold(scanner)?)?
                    }
                    b"commander" | b"is_commander" if requested.commander => {
                        assign_once(&mut record.commander, read_bool(scanner)?)?
                    }
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_court_data<R: Read>(
    scanner: &mut Scanner<R>,
    record: &mut CharacterRecord,
    requested: RequestedFields,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"council_position" if requested.council_position => {
                        assign_once(&mut record.council_position, read_ascii_enum(scanner)?)?
                    }
                    b"court_position" if requested.court_position => {
                        assign_once(&mut record.court_position, read_ascii_enum(scanner)?)?
                    }
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_traits<R: Read>(scanner: &mut Scanner<R>) -> Result<BTreeSet<u64>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut traits = BTreeSet::new();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(traits),
            Token::Scalar(value) | Token::Str(value) => {
                traits.insert(parse_u64(&value)?);
            }
            Token::Eof => return Err(IdentityError::Truncated),
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_skills<R: Read>(scanner: &mut Scanner<R>) -> Result<[i64; 6], IdentityError> {
    scanner.expect_lbrace()?;
    let mut values = Vec::with_capacity(6);
    loop {
        match scanner.next_token()? {
            Token::RBrace => break,
            Token::Scalar(value) | Token::Str(value) => {
                let value = parse_u64(&value)?;
                values.push(i64::try_from(value).map_err(|_| IdentityError::ParseFailed)?);
                if values.len() > 6 {
                    return Err(IdentityError::ParseFailed);
                }
            }
            Token::Eof => return Err(IdentityError::Truncated),
            _ => return Err(IdentityError::ParseFailed),
        }
    }
    values.try_into().map_err(|_| IdentityError::ParseFailed)
}

fn read_bool<R: Read>(scanner: &mut Scanner<R>) -> Result<bool, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value) if value == b"yes" => Ok(true),
        Token::Scalar(value) | Token::Str(value) if value == b"no" => Ok(false),
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn read_ascii_enum<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value)
            if !value.is_empty() && value.len() <= 64 && value.iter().all(u8::is_ascii_graphic) =>
        {
            String::from_utf8(value).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

/// 真实 1.19 存档把 `alive_data.gold` 序列化为块（`gold={ value=<decimal> }`，
/// 与 piety/prestige 的 currency 块同型），且 value 可为负（负债）；旧合成
/// fixture 用标量形式。两种形式都接受，负号原样保留，由 decimal_at_least
/// 按“阈值恒非负”把负数判为 false。块内缺 value 视为结构损坏（fail-closed）。
fn read_gold<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::LBrace => {
            let mut gold = None;
            loop {
                match scanner.next_token()? {
                    Token::RBrace => return gold.ok_or(IdentityError::ParseFailed),
                    Token::Eof => return Err(IdentityError::Truncated),
                    Token::Scalar(key) => {
                        scanner.expect_eq()?;
                        if key == b"value" {
                            assign_once(&mut gold, read_decimal(scanner)?)?;
                        } else {
                            scanner.skip_value()?;
                        }
                    }
                    _ => return Err(IdentityError::ParseFailed),
                }
            }
        }
        Token::Scalar(value) | Token::Str(value) if is_decimal(&value) => {
            String::from_utf8(value).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn read_decimal<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value) if is_decimal(&value) => {
            String::from_utf8(value).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn is_decimal(value: &[u8]) -> bool {
    let unsigned = value.strip_prefix(b"-").unwrap_or(value);
    let mut split = unsigned.split(|byte| *byte == b'.');
    let integer = split.next().unwrap_or_default();
    let fraction = split.next();
    !integer.is_empty()
        && integer.iter().all(u8::is_ascii_digit)
        && fraction.is_none_or(|part| !part.is_empty() && part.iter().all(u8::is_ascii_digit))
        && split.next().is_none()
}

fn parse_u64(value: &[u8]) -> Result<u64, IdentityError> {
    let raw = std::str::from_utf8(value).map_err(|_| IdentityError::ParseFailed)?;
    raw.parse().map_err(|_| IdentityError::ParseFailed)
}

fn decimal_string(value: &[u8]) -> Result<String, IdentityError> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return Err(IdentityError::ParseFailed);
    }
    String::from_utf8(value.to_vec()).map_err(|_| IdentityError::ParseFailed)
}

fn assign_once<T>(slot: &mut Option<T>, value: T) -> Result<(), IdentityError> {
    if slot.is_some() {
        return Err(IdentityError::ParseFailed);
    }
    *slot = Some(value);
    Ok(())
}

impl Verification {
    pub(crate) fn results(
        &self,
        checks: &[SaveVerificationCheckV2],
    ) -> Vec<SaveVerificationResultV2> {
        checks.iter().map(|check| self.evaluate(check)).collect()
    }

    fn evaluate(&self, check: &SaveVerificationCheckV2) -> SaveVerificationResultV2 {
        let record = &self.records[check.character_id()];
        let missing_reason = if record.life_state.is_none() {
            VerificationUnknownReasonV2::CharacterNotFound
        } else if record.duplicate_state {
            VerificationUnknownReasonV2::PartialParse
        } else {
            VerificationUnknownReasonV2::FieldNotAvailable
        };
        match check {
            SaveVerificationCheckV2::CharacterLifeState { check_id, .. } => {
                let outcome = match (record.life_state, record.duplicate_state) {
                    (_, true) => VerificationLifeOutcomeV2::Unknown {
                        reason_code: VerificationUnknownReasonV2::PartialParse,
                    },
                    (Some(LifeState::Living), false) => VerificationLifeOutcomeV2::Known {
                        life_state: VerificationLifeStateV2::Living,
                    },
                    (Some(LifeState::Dead), false) => VerificationLifeOutcomeV2::Known {
                        life_state: VerificationLifeStateV2::Dead,
                    },
                    (None, false) => VerificationLifeOutcomeV2::Unknown {
                        reason_code: VerificationUnknownReasonV2::CharacterNotFound,
                    },
                };
                SaveVerificationResultV2::CharacterLifeState {
                    check_id: check_id.clone(),
                    outcome,
                }
            }
            SaveVerificationCheckV2::CharacterHasTrait {
                check_id, trait_id, ..
            } => SaveVerificationResultV2::CharacterHasTrait {
                check_id: check_id.clone(),
                outcome: bool_outcome(
                    record
                        .traits
                        .as_ref()
                        .map(|traits| traits.contains(trait_id)),
                    missing_reason,
                ),
            },
            SaveVerificationCheckV2::CharacterSkillAtLeast {
                check_id,
                skill,
                value,
                ..
            } => SaveVerificationResultV2::CharacterSkillAtLeast {
                check_id: check_id.clone(),
                outcome: bool_outcome(
                    record
                        .skills
                        .map(|skills| skills[skill_index(*skill)] >= *value),
                    missing_reason,
                ),
            },
            SaveVerificationCheckV2::CharacterHasCouncilPosition {
                check_id, position, ..
            } => SaveVerificationResultV2::CharacterHasCouncilPosition {
                check_id: check_id.clone(),
                outcome: bool_outcome(
                    record
                        .council_position
                        .as_deref()
                        .map(|actual| actual == council_position_name(*position)),
                    missing_reason,
                ),
            },
            SaveVerificationCheckV2::CharacterHasCourtPosition {
                check_id, position, ..
            } => SaveVerificationResultV2::CharacterHasCourtPosition {
                check_id: check_id.clone(),
                outcome: bool_outcome(
                    record
                        .court_position
                        .as_deref()
                        .map(|actual| actual == court_position_name(*position)),
                    missing_reason,
                ),
            },
            SaveVerificationCheckV2::CharacterIsCommander { check_id, .. } => {
                SaveVerificationResultV2::CharacterIsCommander {
                    check_id: check_id.clone(),
                    outcome: bool_outcome(record.commander, missing_reason),
                }
            }
            SaveVerificationCheckV2::CharacterGoldAtLeast {
                check_id, value, ..
            } => SaveVerificationResultV2::CharacterGoldAtLeast {
                check_id: check_id.clone(),
                outcome: bool_outcome(
                    record
                        .gold
                        .as_deref()
                        .map(|gold| decimal_at_least(gold, *value)),
                    missing_reason,
                ),
            },
        }
    }
}

fn bool_outcome(
    value: Option<bool>,
    reason: VerificationUnknownReasonV2,
) -> VerificationBooleanOutcomeV2 {
    match value {
        Some(value) => VerificationBooleanOutcomeV2::Known { value },
        None => VerificationBooleanOutcomeV2::Unknown {
            reason_code: reason,
        },
    }
}

fn skill_index(skill: VerificationSkillV2) -> usize {
    match skill {
        VerificationSkillV2::Diplomacy => 0,
        VerificationSkillV2::Martial => 1,
        VerificationSkillV2::Stewardship => 2,
        VerificationSkillV2::Intrigue => 3,
        VerificationSkillV2::Learning => 4,
        VerificationSkillV2::Prowess => 5,
    }
}

fn council_position_name(position: VerificationCouncilPositionV2) -> &'static str {
    match position {
        VerificationCouncilPositionV2::Chancellor => "chancellor",
        VerificationCouncilPositionV2::Marshal => "marshal",
        VerificationCouncilPositionV2::Steward => "steward",
        VerificationCouncilPositionV2::Spymaster => "spymaster",
        VerificationCouncilPositionV2::CourtChaplain => "court_chaplain",
    }
}

fn court_position_name(position: VerificationCourtPositionV2) -> &'static str {
    match position {
        VerificationCourtPositionV2::Physician => "physician",
        VerificationCourtPositionV2::Bodyguard => "bodyguard",
        VerificationCourtPositionV2::Seneschal => "seneschal",
        VerificationCourtPositionV2::FoodTaster => "food_taster",
        VerificationCourtPositionV2::CourtTutor => "court_tutor",
    }
}

fn decimal_at_least(actual: &str, threshold: i64) -> bool {
    debug_assert!(threshold >= 0);
    // 阈值恒非负，负数 gold（负债）恒不满足。
    if actual.starts_with('-') {
        return false;
    }
    let integer = actual
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let threshold = threshold.to_string();
    integer.len() > threshold.len()
        || (integer.len() == threshold.len() && integer >= threshold.as_str())
}

pub(crate) fn unknown_results(
    checks: &[SaveVerificationCheckV2],
    reason: VerificationUnknownReasonV2,
) -> Vec<SaveVerificationResultV2> {
    checks
        .iter()
        .map(|check| match check {
            SaveVerificationCheckV2::CharacterLifeState { check_id, .. } => {
                SaveVerificationResultV2::CharacterLifeState {
                    check_id: check_id.clone(),
                    outcome: VerificationLifeOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterHasTrait { check_id, .. } => {
                SaveVerificationResultV2::CharacterHasTrait {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterSkillAtLeast { check_id, .. } => {
                SaveVerificationResultV2::CharacterSkillAtLeast {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterHasCouncilPosition { check_id, .. } => {
                SaveVerificationResultV2::CharacterHasCouncilPosition {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterHasCourtPosition { check_id, .. } => {
                SaveVerificationResultV2::CharacterHasCourtPosition {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterIsCommander { check_id, .. } => {
                SaveVerificationResultV2::CharacterIsCommander {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
            SaveVerificationCheckV2::CharacterGoldAtLeast { check_id, .. } => {
                SaveVerificationResultV2::CharacterGoldAtLeast {
                    check_id: check_id.clone(),
                    outcome: VerificationBooleanOutcomeV2::Unknown {
                        reason_code: reason,
                    },
                }
            }
        })
        .collect()
}
