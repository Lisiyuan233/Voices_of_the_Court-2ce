//! Minimal, versioned public location extraction.
//!
//! 2026-08-12 real-save verification (§14.6 F1): CK3 1.19.0.6 stores a
//! character's public location as a nested block
//! `alive_data={ location={ location=<id> } }`; there is no top-level
//! `current_location` field and no root `locations={ name=... }` block in
//! real saves. Activity/travel predicates (F2/F3) are unsupported: the save
//! only carries script template ids, no names or booleans, so nothing is
//! emitted for them.
//!
//! Accepted fixture shapes only:
//!
//! ```text
//! locations={5001={name="Royal hall"}}        // optional name candidates
//! living={1001={alive_data={location={location=5001}}}}
//! ```
//!
//! Unknown CK3 paths and layouts are skipped. A location is emitted only
//! when the explicit typed reference is present; raw IDs/localization keys
//! never render.

use std::io::Read;

use super::character::CharacterRecord;
use super::normalize::FactSink;
use crate::identity::{IdentityError, Scanner, Token};
use crate::protocol::{
    Category, Confidence, EntityType, FactSensitivity, FactVisibility, Predicate,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct LocationRecord {
    pub id: String,
    pub name: Option<String>,
}

fn safe_name(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        return None;
    }
    if value.starts_with("k_") || value.starts_with("ERROR:") {
        return None;
    }
    Some(value.to_string())
}

fn scan_location<R: Read>(
    scanner: &mut Scanner<R>,
    id: String,
) -> Result<LocationRecord, IdentityError> {
    scanner.expect_lbrace()?;
    let mut record = LocationRecord {
        id,
        ..Default::default()
    };
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(record),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key.as_slice() == b"name" && record.name.is_none() {
                    record.name = safe_name(scalar_text(scanner)?);
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

pub(crate) fn scan_locations<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Vec<LocationRecord>, IdentityError> {
    scan_keyed(scanner, scan_location)
}

fn scan_keyed<R: Read, T>(
    scanner: &mut Scanner<R>,
    mut scan: impl FnMut(&mut Scanner<R>, String) -> Result<T, IdentityError>,
) -> Result<Vec<T>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut out = Vec::new();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(out),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(id) | Token::Str(id) => {
                let id = numeric_id(&id)?;
                scanner.expect_eq()?;
                out.push(scan(scanner, id)?);
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn numeric_id(raw: &[u8]) -> Result<String, IdentityError> {
    if raw.is_empty() || !raw.iter().all(|b| b.is_ascii_digit()) {
        return Err(IdentityError::ParseFailed);
    }
    String::from_utf8(raw.to_vec()).map_err(|_| IdentityError::ParseFailed)
}

fn scalar_text<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(value) | Token::Str(value) => {
            String::from_utf8(value).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

/// Emit `character.public_location` for every participant whose
/// `alive_data.location` reference is present. Real CK3 1.19.0.6 saves have
/// no root `locations` name block, so the name block is an optional name
/// source only: a missing name is not a parse error (the App resolves the
/// name or drops the fact as name_unresolved).
pub(crate) fn record_public_locations(
    sink: &mut FactSink,
    characters: &[(String, CharacterRecord)],
    locations: &[LocationRecord],
    location_names: &mut std::collections::HashMap<String, String>,
) {
    let location_map: std::collections::HashMap<_, _> =
        locations.iter().map(|l| (l.id.as_str(), l)).collect();
    let participants: std::collections::HashSet<String> =
        sink.participant_ids().into_iter().collect();
    for (character_id, character) in characters
        .iter()
        .filter(|(id, _)| participants.contains(id))
    {
        let Some(location_id) = character.current_location.as_deref() else {
            continue;
        };
        if let Some(name) = location_map
            .get(location_id)
            .and_then(|location| location.name.as_deref())
        {
            location_names.insert(location_id.to_string(), name.to_string());
        }
        sink.push_fact(
            Category::Location,
            (EntityType::Character, character_id),
            Predicate::CharacterPublicLocation,
            Some((EntityType::Location, location_id)),
            "character_public_location",
            Confidence::Mapped,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
}
