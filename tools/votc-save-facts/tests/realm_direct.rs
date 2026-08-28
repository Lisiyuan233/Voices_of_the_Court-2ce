//! P1-D-c direct realm relation fixture coverage.

mod common;

use common::{
    default_vars, extract_on_body, extract_request, gamestate_blocks, living_block, TempDir,
};

#[test]
fn extracts_only_direct_vassal_and_bounded_realm_capital() {
    let dir = TempDir::new("realm-direct");
    let body = include_str!("fixtures/unified_text_realm_direct_minimal.ck3");
    let value = extract_on_body(
        &dir,
        "realm-direct.ck3",
        &gamestate_blocks(&default_vars(1000), body),
        &extract_request(&["1001"], &["realm"]),
    );
    let facts = value["facts"].as_array().unwrap();
    assert!(facts
        .iter()
        .any(|fact| fact["predicate"] == "character.direct_vassal_of"
            && fact["object"]["id"] == "1005"));
    assert!(facts.iter().any(
        |fact| fact["predicate"] == "character.realm_capital" && fact["object"]["id"] == "200"
    ));
    assert!(facts
        .iter()
        .filter(|fact| fact["predicate"] == "character.direct_vassal_of")
        .all(|fact| fact["sourcePath"] == "character_direct_vassal_of"));
    assert!(facts
        .iter()
        .filter(|fact| fact["predicate"] == "character.realm_capital")
        .all(|fact| fact["sourcePath"] == "character_realm_capital"));
}

#[test]
fn drops_unbounded_capital_and_self_relation() {
    let dir = TempDir::new("realm-direct-gate");
    let body = living_block(
        "1001={ alive_data={ direct_vassal_of=1001 } landed_data={ realm_capital=299 } }\n",
    );
    let value = extract_on_body(
        &dir,
        "realm-direct-gate.ck3",
        &body,
        &extract_request(&["1001"], &["realm"]),
    );
    let facts = value["facts"].as_array().unwrap();
    assert!(!facts
        .iter()
        .any(|fact| fact["predicate"] == "character.direct_vassal_of"));
    assert!(!facts
        .iter()
        .any(|fact| fact["predicate"] == "character.realm_capital"));
}

#[test]
fn missing_capital_record_drops_only_capital_and_keeps_direct_relation() {
    let dir = TempDir::new("realm-direct-missing-capital");
    let body = living_block(
        "1001={ alive_data={ direct_vassal_of=1005 } landed_data={ realm_capital=299 } }\n",
    );
    let value = extract_on_body(
        &dir,
        "realm-direct-missing-capital.ck3",
        &gamestate_blocks(&default_vars(1000), &body),
        &extract_request(&["1001"], &["realm"]),
    );
    let facts = value["facts"].as_array().unwrap();
    assert!(facts
        .iter()
        .any(|fact| fact["predicate"] == "character.direct_vassal_of"
            && fact["object"]["id"] == "1005"));
    assert!(!facts
        .iter()
        .any(|fact| fact["predicate"] == "character.realm_capital"));
}
