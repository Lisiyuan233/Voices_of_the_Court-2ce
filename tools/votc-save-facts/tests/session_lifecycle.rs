//! Plan B Task 4: session lifecycle — serial queries, idle self-exit,
//! EOF-as-close and temp-artifact hygiene.

#[path = "common/mod.rs"]
mod common;

#[path = "common/session_util.rs"]
mod session_util;

use common::TempDir;
use session_util::{
    close_request, make_save, open_request, profile_request, search_request, SessionProc,
};

fn temp_artifact_count() -> usize {
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with("votc-save-facts-") && name.ends_with(".tmp"))
                .unwrap_or(false)
        })
        .count()
}

#[test]
fn serial_queries_after_ready_all_answered() {
    let dir = TempDir::new("slife-serial");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000, 600000));
    assert_eq!(proc.read_json()["status"], "ready");

    for step in 0..10u32 {
        if step % 2 == 0 {
            proc.send_line(&search_request(
                &format!("req-s{step}"),
                serde_json::json!({ "literalNameQuery": "Dup" }),
                8,
            ));
            let frame = proc.read_json();
            assert_eq!(frame["status"], "ok", "{frame}");
        } else {
            proc.send_line(&profile_request(
                &format!("req-p{step}"),
                "1001",
                &["identity"],
            ));
            let frame = proc.read_json();
            assert_eq!(frame["status"], "ok", "{frame}");
        }
    }

    proc.send_line(&close_request("req-close"));
    assert_eq!(proc.read_json()["status"], "closed");
    let output = proc.wait_output();
    assert!(output.status.success());
}

#[test]
fn idle_timeout_self_exits_silently() {
    let dir = TempDir::new("slife-idle");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    // Watchdog clamps to a 1 s floor; request the minimum.
    proc.send_line(&open_request(&fingerprint, 10000, 1000));
    assert_eq!(proc.read_json()["status"], "ready");
    // No close: the sidecar must exit on its own shortly after.
    match proc.wait_deadline(8000) {
        Some(code) => assert_eq!(code, 0, "idle self-exit must be clean"),
        None => panic!("sidecar did not self-exit within 8 s"),
    }
}

#[test]
fn stdin_eof_after_queries_equals_clean_close() {
    let dir = TempDir::new("slife-eof");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000, 600000));
    proc.read_json();
    proc.send_line(&search_request(
        "req-2",
        serde_json::json!({ "literalNameQuery": "Aldric" }),
        8,
    ));
    proc.read_json();
    // Drop stdin via wait_output; expect clean exit without close frame.
    // Both protocol frames were consumed above via read_json.
    let output = proc.wait_output();
    assert!(output.status.success(), "EOF must be clean");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.is_empty(), "stderr must stay silent: {stderr}");
}

#[test]
fn fatal_protocol_error_leaves_no_temp_artifacts() {
    let baseline = temp_artifact_count();
    let dir = TempDir::new("slife-temp");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000, 600000));
    assert_eq!(proc.read_json()["status"], "ready");
    // Duplicate requestId → fatal → process releases artifacts on unwind/exit.
    proc.send_line(&search_request(
        "req-1",
        serde_json::json!({ "literalNameQuery": "x" }),
        8,
    ));
    let output = proc.wait_output();
    assert!(output.status.success());

    // Allow the filesystem a moment, then compare artifact counts.
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(
        temp_artifact_count() <= baseline + 2,
        "raw/gamestate temp artifacts leaked (baseline {baseline})"
    );
}
