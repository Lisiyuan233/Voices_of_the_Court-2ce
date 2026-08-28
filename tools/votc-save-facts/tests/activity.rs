//! Minimal versioned public-location fixture coverage (F1 real-save shape).
//!
//! 2026-08-12: activity/travel predicates (F2/F3) are unsupported, so the
//! tests assert they are never produced even when the old synthetic shape is
//! present.

mod common;

use common::{
    default_vars, extract_on_body, extract_request, gamestate_blocks, living_block, TempDir,
};

#[test]
fn fixture_extracts_only_bounded_public_location_facts() {
    let dir = TempDir::new("activity-fixture");
    let body = include_str!("fixtures/unified_text_activity_minimal.ck3");
    let value = extract_on_body(
        &dir,
        "activity.ck3",
        &gamestate_blocks(&default_vars(1000), body),
        &extract_request(&["1001"], &["activity", "location"]),
    );
    assert!(value["status"] == "ok" || value["status"] == "partial");
    let facts = value["facts"].as_array().unwrap();
    assert!(facts
        .iter()
        .any(|f| f["predicate"] == "character.public_location" && f["object"]["id"] == "5001"));
    assert!(!facts.iter().any(|f| f["predicate"] == "character.current_activity"));
    assert!(!facts.iter().any(|f| f["predicate"] == "character.traveling"));
    assert!(!facts.iter().any(|f| f["predicate"] == "activity.location"));
    assert!(!facts.iter().any(|f| f["object"]["id"] == "9999"));
    assert!(value["entities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["type"] == "location" && e["displayNameCandidate"]["value"] == "Royal Hall"));
}

#[test]
fn legacy_top_level_activity_fields_fail_closed() {
    let dir = TempDir::new("activity-gate");
    let body = "activities={9001={type=feast name=\"Hidden\"}}\nliving={1001={current_activity=9001 traveling=yes current_location=5001}}\n";
    let value = extract_on_body(
        &dir,
        "unknown-activity.ck3",
        body,
        &extract_request(&["1001"], &["activity"]),
    );
    assert!(value["status"] == "ok" || value["status"] == "partial");
    assert!(value["facts"].as_array().unwrap().is_empty());
}

#[test]
fn real_shape_without_locations_name_block_still_emits_location_fact() {
    let dir = TempDir::new("activity-no-name-block");
    let body = living_block("1001={ first_name=\"Player\" alive_data={ location={ location=5001 } } }\n");
    let value = extract_on_body(
        &dir,
        "no-name-block.ck3",
        &gamestate_blocks(&default_vars(1000), &body),
        &extract_request(&["1001"], &["location"]),
    );
    let facts = value["facts"].as_array().unwrap();
    assert!(facts
        .iter()
        .any(|f| { f["predicate"] == "character.public_location" && f["object"]["id"] == "5001" }));
    assert!(!facts
        .iter()
        .any(|f| f["predicate"] == "character.current_activity"));
}

#[test]
fn missing_location_reference_emits_nothing() {
    let dir = TempDir::new("activity-missing-location");
    let body = living_block("1001={ first_name=\"Player\" }\n");
    let value = extract_on_body(
        &dir,
        "missing-location.ck3",
        &gamestate_blocks(&default_vars(1000), &body),
        &extract_request(&["1001"], &["activity", "location"]),
    );
    assert!(value["facts"].as_array().unwrap().is_empty());
}
