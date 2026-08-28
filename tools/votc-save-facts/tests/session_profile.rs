//! Plan B Task 4: fixed-section character profile integration.

#[path = "common/mod.rs"]
mod common;

#[path = "common/session_util.rs"]
mod session_util;

use common::TempDir;
use session_util::{
    close_request, make_save, open_request, profile_request, SessionProc,
};

fn spawn_ready() -> (TempDir, SessionProc) {
    let dir = TempDir::new("sprof");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000, 600000));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ready", "{frame}");
    (dir, proc)
}

#[test]
fn full_profile_returns_all_five_sections_with_status() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&profile_request(
        "req-2",
        "1001",
        &["identity", "public_family", "realm", "court", "location"],
    ));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ok", "{frame}");
    let profile = &frame["profile"];
    assert_eq!(profile["characterId"], "1001");
    assert_eq!(profile["identity"]["literalName"], "Aldric");
    assert_eq!(profile["identity"]["primaryTitleId"], "8001");
    // Spouse symmetry derived: 1001 lists 1002.
    assert_eq!(profile["publicFamily"]["spouseIds"].as_array().unwrap().len(), 1);
    assert!(profile.get("realm").is_some());
    assert!(profile.get("court").is_some());
    assert!(profile.get("location").is_some());

    let statuses: Vec<&str> = profile["sectionStatus"]
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(statuses.len(), 5);
    for expected in ["identity", "public_family", "realm", "court", "location"] {
        assert!(
            statuses.contains(&expected),
            "missing {expected} in {statuses:?}"
        );
    }
}

#[test]
fn unrequested_sections_are_absent_not_empty() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&profile_request("req-2", "1001", &["identity"]));
    let frame = proc.read_json();
    let profile = &frame["profile"];
    assert!(profile.get("identity").is_some() || profile.get("characterId").is_some());
    assert!(profile.get("publicFamily").is_none(), "{frame}");
    assert!(profile.get("realm").is_none(), "{frame}");
    assert!(profile.get("court").is_none(), "{frame}");
    assert!(profile.get("location").is_none(), "{frame}");
    let status_keys = profile["sectionStatus"].as_object().unwrap();
    assert_eq!(status_keys.len(), 1);
    assert!(status_keys.contains_key("identity"));
}

#[test]
fn missing_optional_fields_are_omitted_not_faked() {
    let (_dir, mut proc) = spawn_ready();
    // 6001 ("Child") has no titles/court/location.
    proc.send_line(&profile_request("req-2", "6001", &["realm", "court"]));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ok", "{frame}");
    let realm = &frame["profile"]["realm"];
    assert!(realm.get("liegeId").is_none(), "{frame}");
    assert!(realm.get("directVassalOfId").is_none(), "{frame}");
    assert_eq!(realm["domainTitleIds"].as_array().unwrap().len(), 0);
}

#[test]
fn unknown_character_is_honest_not_found() {
    let (_dir, mut proc) = spawn_ready();
    proc.send_line(&profile_request("req-2", "999999", &["identity"]));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "not_found");
    assert!(frame.get("profile").map_or(true, |p| p.is_null()));

    proc.send_line(&close_request("req-9"));
    assert_eq!(proc.read_json()["status"], "closed");
    proc.wait_output();
}

#[test]
fn semantic_violations_recoverable_and_session_survives() {
    let (_dir, mut proc) = spawn_ready();

    // Non-canonical character id.
    proc.send_line(&profile_request("req-2", "0x10", &["identity"]));
    proc.expect_error("REQUEST_INVALID");

    // Duplicate sections rejected (dedupe must be requested-side clean).
    proc.send_line(&profile_request(
        "req-3",
        "1001",
        &["identity", "identity"],
    ));
    proc.expect_error("REQUEST_INVALID");

    // Still usable afterwards.
    proc.send_line(&profile_request("req-4", "1001", &["identity"]));
    let frame = proc.read_json();
    assert_eq!(frame["status"], "ok");

    proc.send_line(&close_request("req-9"));
    proc.read_frame();
    proc.wait_output();
}
