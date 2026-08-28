//! Minimal versioned court-host extraction coverage (F4 real-save shape).
//!
//! 2026-08-12: council/court positions (F5) are unsupported; the tests
//! assert they are never produced.

mod common;

use common::{
    default_vars, extract_on_body, extract_request, gamestate_blocks, living_block, TempDir,
};

#[test]
fn fixture_extracts_only_bounded_public_court_owner_facts() {
    let dir = TempDir::new("court-fixture");
    let body = include_str!("fixtures/unified_text_court_minimal.ck3");
    let value = extract_on_body(
        &dir,
        "court.ck3",
        &gamestate_blocks(&default_vars(1000), body),
        &extract_request(&["1001", "1002"], &["court"]),
    );
    assert!(value["status"] == "ok" || value["status"] == "partial");
    let facts = value["facts"].as_array().unwrap();
    assert!(facts
        .iter()
        .any(|f| f["predicate"] == "character.court_owner"
            && f["subject"]["id"] == "1001"
            && f["object"]["id"] == "1002"));
    assert!(!facts.iter().any(|f| f["predicate"] == "character.council_position"));
    assert!(!facts.iter().any(|f| f["predicate"] == "character.court_position"));
    assert!(facts
        .iter()
        .all(|f| f["visibility"] == "public" && f["category"] == "court"));
}

#[test]
fn non_participant_host_fails_closed() {
    let dir = TempDir::new("court-gate");
    let body = living_block("1001={ court_data={ host=9999 } }\n");
    let value = extract_on_body(
        &dir,
        "court-gate.ck3",
        &body,
        &extract_request(&["1001"], &["court"]),
    );
    assert!(value["facts"].as_array().unwrap().is_empty());
}

#[test]
fn missing_host_emits_nothing() {
    let dir = TempDir::new("court-missing-host");
    let body = living_block("1001={ court_data={ leave_court_date=869.3.9 } }\n");
    let value = extract_on_body(
        &dir,
        "court-missing-host.ck3",
        &gamestate_blocks(&default_vars(1000), &body),
        &extract_request(&["1001"], &["court"]),
    );
    assert!(value["status"] == "ok" || value["status"] == "partial");
    assert!(value["facts"].as_array().unwrap().is_empty());
}
