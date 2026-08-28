//! P1-C war extraction coverage: direct/liege relevance, bounded fields,
//! participant cap, participant-relative score bands, and envelope safety.

mod common;

use common::{
    char_entry, default_vars, extract_json, extract_on_body, extract_request,
    extract_request_with_limits, facts_with, fixtures_dir, gamestate_blocks, living_block,
    warning_codes_of, TempDir,
};

fn war_fixture() -> serde_json::Value {
    let dir = fixtures_dir();
    let path = dir.join("unified_text_war_minimal.ck3");
    extract_json(&path, &dir, &extract_request(&["1001", "1002"], &["war"]))
}

fn war_entries(count: usize) -> String {
    (0..count)
        .map(|index| {
            format!(
                "\t{}={{\n\t\tname=\"Fixture War {}\"\n\t\tattacker={{ character=1001 }}\n\t\tdefender={{ character=1002 }}\n\t\tcasus_belli=claim\n\t\tscore=60\n\t}}\n",
                8000 + index,
                index
            )
        })
        .collect()
}

fn war_body(entries: &str) -> String {
    gamestate_blocks(
        &default_vars(1000),
        &format!(
            "{}{}wars={{\n{entries}}}\n",
            living_block(&format!(
                "{}{}",
                char_entry("1001", "\t\talive_data={\n\t\t\tliege=9001\n\t\t}\n"),
                char_entry("1002", "\t\talive_data={\n\t\t}\n")
            )),
            "",
        ),
    )
}

#[test]
fn fixture_is_deterministic_and_extracts_direct_and_liege_wars() {
    let first = war_fixture();
    let second = war_fixture();
    assert_eq!(first["status"], "ok");
    assert_eq!(first["facts"], second["facts"]);
    assert_eq!(first["entities"], second["entities"]);

    let facts = first["facts"].as_array().unwrap();
    assert!(facts.iter().any(|fact| {
        fact["predicate"] == "character.at_war"
            && fact["subject"]["id"] == "1001"
            && fact["object"]["type"] == "war"
    }));
    assert!(facts.iter().any(|fact| {
        fact["predicate"] == "character.at_war"
            && fact["subject"]["id"] == "1001"
            && fact["object"]["id"] == "7003"
    }));
    assert!(facts.iter().any(|fact| {
        fact["predicate"] == "war.casus_belli"
            && fact["value"] == "claim"
            && fact["subject"]["id"] == "7001"
    }));
    assert!(first["entities"].as_array().unwrap().iter().any(|entity| {
        entity["type"] == "war"
            && entity["id"] == "7001"
            && entity["displayNameCandidate"]["value"] == "Northern War"
    }));
}

#[test]
fn unrelated_and_unsafe_wars_are_not_guessed() {
    let value = war_fixture();
    let facts = value["facts"].as_array().unwrap();
    assert!(!facts.iter().any(|fact| fact["subject"]["id"] == "7002"));
    assert!(!facts.iter().any(|fact| fact["subject"]["id"] == "7005"));
    assert!(!facts
        .iter()
        .any(|fact| { fact["subject"]["id"] == "7004" && fact["predicate"] == "war.casus_belli" }));
    assert!(!facts.iter().any(|fact| fact["subject"]["id"] == "7006"));
}

#[test]
fn score_band_is_reversed_for_defender_and_unknown_score_is_dropped() {
    let value = war_fixture();
    let bands = facts_with(&value, "character.war_score_band");
    assert!(bands.iter().any(|fact| {
        fact["subject"]["id"] == "1001"
            && fact["object"]["id"] == "7001"
            && fact["value"] == "winning"
    }));
    assert!(bands.iter().any(|fact| {
        fact["subject"]["id"] == "1002"
            && fact["object"]["id"] == "7001"
            && fact["value"] == "losing"
    }));

    let dir = TempDir::new("war-unknown-score");
    let body = war_body(
        "\t9000={\n\t\tname=\"Unknown Score\"\n\t\tattacker={ character=1001 }\n\t\tdefender={ character=1002 }\n\t\tcasus_belli=claim\n\t}\n",
    );
    let value = extract_on_body(
        &dir,
        "unknown-score.ck3",
        &body,
        &extract_request(&["1001"], &["war"]),
    );
    assert!(facts_with(&value, "character.war_score_band").is_empty());
}

#[test]
fn per_participant_cap_is_deterministic_and_warns() {
    let dir = TempDir::new("war-cap");
    let value = extract_on_body(
        &dir,
        "war-cap.ck3",
        &war_body(&war_entries(5)),
        &extract_request(&["1001"], &["war"]),
    );
    assert_eq!(value["status"], "partial");
    assert!(warning_codes_of(&value).contains(&"WAR_EXTRACTION_TRUNCATED".to_string()));
    let war_ids: std::collections::HashSet<&str> = value["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|fact| {
            if fact["subject"]["type"] == "war" {
                fact["subject"]["id"].as_str()
            } else {
                fact["object"]["id"].as_str()
            }
        })
        .collect();
    assert_eq!(war_ids.len(), 3);
    assert!(!war_ids.contains("8003"));
}

#[test]
fn global_fact_cap_marks_partial_without_leaking_unbounded_war_data() {
    let dir = TempDir::new("war-global-cap");
    let value = extract_on_body(
        &dir,
        "war-global-cap.ck3",
        &war_body(&war_entries(2)),
        &extract_request_with_limits(&["1001"], &["war"], 3, 250, 100),
    );
    assert_eq!(value["status"], "partial");
    assert!(warning_codes_of(&value).contains(&"EXTRACTION_LIMIT_REACHED".to_string()));
    assert!(value["facts"].as_array().unwrap().len() <= 3);
}

#[test]
fn malformed_text_is_invalid_and_binary_remains_unsupported() {
    let dir = TempDir::new("war-envelope-safety");
    let malformed = war_body("\t9000={\n\t\tname=\"Broken\"\n\t\tattacker={ character=1001 }\n");
    let invalid = extract_on_body(
        &dir,
        "malformed-war.ck3",
        &malformed,
        &extract_request(&["1001"], &["war"]),
    );
    assert_eq!(invalid["status"], "invalid");
    assert!(invalid["facts"].as_array().unwrap().is_empty());

    let fixtures = fixtures_dir();
    let binary = extract_json(
        &fixtures.join("binary_marker_minimal.ck3"),
        &fixtures,
        &extract_request(&["1001"], &["war"]),
    );
    assert_eq!(binary["status"], "unsupported");
    assert!(binary["facts"].as_array().unwrap().is_empty());
}
