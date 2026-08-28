//! Plan B Task 4: bounded character search over the in-memory index.

#[path = "common/mod.rs"]
mod common;

#[path = "common/session_util.rs"]
mod session_util;

use common::TempDir;
use session_util::{
    close_request, make_save, open_request, search_request, SessionProc,
};

fn spawn_ready() -> (TempDir, SessionProc) {
    let dir = TempDir::new("ssearch");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000, 600000));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ready", "open failed: {frame}");
    (dir, proc)
}

fn ids_of(frame: &serde_json::Value) -> Vec<String> {
    frame["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["characterId"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn candidate_id_selector_returns_exact_matches_in_numeric_order() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "candidateCharacterIds": ["5005", "5001", "5010"] }),
        8,
    ));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ok");
    assert_eq!(ids_of(&frame), vec!["5001", "5005", "5010"]);
    assert_eq!(
        frame["candidates"][0]["matchedBy"][0], "candidate_id",
        "{frame}"
    );
    proc.send_line(&close_request("req-9"));
    assert_eq!(proc.read_json()["status"], "closed");
    let output = proc.wait_output();
    assert!(output.status.success());
}

#[test]
fn literal_name_supports_exact_prefix_substring_and_case_fold() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "literalNameQuery": "Aldric" }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1001"]);

    proc.send_line(&search_request(
        "req-3",
        serde_json::json!({ "literalNameQuery": "sab" }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1002"]);

    // Substring: "ald" matches Aldric AND Baldwin.
    proc.send_line(&search_request(
        "req-4",
        serde_json::json!({ "literalNameQuery": "ald" }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1001", "1003"]);
    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn duplicate_literal_names_break_ties_by_numeric_id_and_truncate() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "literalNameQuery": "Dup" }),
        8,
    ));
    let frame = proc.read_json();
    // Three "Dup" characters exist; all fit under limit 8.
    assert_eq!(ids_of(&frame), vec!["5001", "5005", "5010"]);
    assert_eq!(frame["truncated"], false);

    proc.send_line(&search_request(
        "req-3",
        serde_json::json!({ "literalNameQuery": "Dup" }),
        2,
    ));
    let frame = proc.read_json();
    assert_eq!(ids_of(&frame), vec!["5001", "5005"]);
    assert_eq!(frame["truncated"], true);
    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn title_key_selector_resolves_primary_titles() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "primaryTitleKeys": ["e_test_empire"] }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1001"]);

    proc.send_line(&search_request(
        "req-3",
        serde_json::json!({ "primaryTitleKeys": ["k_test_realm"] }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1002"]);
    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn relation_selectors_cover_all_six_kinds() {
    let (_dir, mut proc) = spawn_ready();

    // spouse of 1001 → 1002
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "relation": { "kind": "spouse", "anchorCharacterId": "1001" } }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1002"]);

    // liege of 1001 is 1003 → searching liege kind anchored at 1001 finds 1003
    proc.send_line(&search_request(
        "req-3",
        serde_json::json!({ "relation": { "kind": "liege", "anchorCharacterId": "1001" } }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1003"]);

    // direct vassals of 1003 include 1001 and Dup 5005/5001/5010
    proc.send_line(&search_request(
        "req-4",
        serde_json::json!({ "relation": { "kind": "direct_vassal", "anchorCharacterId": "1003" } }),
        8,
    ));
    let frame = proc.read_json();
    let ids = ids_of(&frame);
    assert!(ids.contains(&"1001".to_string()), "{frame}");
    assert!(ids.contains(&"5005".to_string()), "{frame}");

    // court members hosted by 1001 include 1003
    proc.send_line(&search_request(
        "req-5",
        serde_json::json!({ "relation": { "kind": "court_member", "anchorCharacterId": "1001" } }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1003"]);

    // parent of 6001 is 6000
    proc.send_line(&search_request(
        "req-6",
        serde_json::json!({ "relation": { "kind": "parent", "anchorCharacterId": "6001" } }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["6000"]);

    // child of 6000 is 6001
    proc.send_line(&search_request(
        "req-7",
        serde_json::json!({ "relation": { "kind": "child", "anchorCharacterId": "6000" } }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["6001"]);

    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn multiple_selectors_are_combined_with_and() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({
            "candidateCharacterIds": ["1001", "1002"],
            "literalNameQuery": "sabina"
        }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1002"]);
    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn zero_hits_report_not_found_without_error() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "literalNameQuery": "Nobody" }),
        8,
    ));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "not_found");
    assert_eq!(frame["candidates"].as_array().unwrap().len(), 0);
    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}

#[test]
fn semantic_selector_violations_are_recoverable_errors() {
    let (_dir, mut proc) = spawn_ready();

    // Empty selector object.
    proc.send_line(&search_request("req-2", serde_json::json!({}), 8));
    proc.expect_error("REQUEST_INVALID");

    // Non-canonical id.
    proc.send_line(&search_request(
        "req-3",
        serde_json::json!({ "candidateCharacterIds": ["0x1F"] }),
        8,
    ));
    proc.expect_error("REQUEST_INVALID");

    // Out-of-range limit.
    proc.send_line(&search_request(
        "req-4",
        serde_json::json!({ "literalNameQuery": "Aldric" }),
        99,
    ));
    proc.expect_error("REQUEST_INVALID");

    // Session still fully usable afterwards.
    proc.send_line(&search_request(
        "req-5",
        serde_json::json!({ "literalNameQuery": "Aldric" }),
        8,
    ));
    assert_eq!(ids_of(&proc.read_json()), vec!["1001"]);
    proc.send_line(&close_request("req-9"));
    assert_eq!(proc.read_json()["status"], "closed");
    proc.wait_output();
}
