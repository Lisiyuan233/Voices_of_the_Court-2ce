//! Minimal, versioned public court extraction.
//!
//! F4 (2026-08-12 real-save verification): CK3 1.19.0.6 stores the hosting
//! court of a guest as `living=<id>={court_data={host=<hostId> ...}}`.
//! A court_owner fact is emitted only when the host is an authorized
//! participant. Council/court positions (F5) are template-id lists with no
//! names in the save and are intentionally not extracted.

use std::collections::HashSet;

use super::character::CharacterRecord;
use super::normalize::FactSink;
use crate::protocol::{
    Category, Confidence, EntityType, FactSensitivity, FactVisibility, Predicate,
};

pub(crate) fn record_court_facts(sink: &mut FactSink, characters: &[(String, CharacterRecord)]) {
    let participants: HashSet<String> = sink.participant_ids().into_iter().collect();
    for (character_id, character) in characters {
        if !participants.contains(character_id) {
            continue;
        }
        let Some(host) = character.court_owner.as_deref() else {
            continue;
        };
        if !participants.contains(host) {
            continue;
        }
        sink.push_fact(
            Category::Court,
            (EntityType::Character, character_id),
            Predicate::CharacterCourtOwner,
            Some((EntityType::Character, host)),
            "character_court_owner",
            Confidence::Exact,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
}
