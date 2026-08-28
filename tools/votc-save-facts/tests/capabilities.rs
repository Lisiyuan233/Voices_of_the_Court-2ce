//! P1-A capabilities contract: fixed command, strict DTO, and no save-path I/O.

#[path = "common/mod.rs"]
mod common;

use serde_json::Value;

fn capabilities_args() -> Vec<String> {
    vec![
        "capabilities".into(),
        "--max-output-bytes".into(),
        common::MAX_OUTPUT.into(),
    ]
}

#[test]
fn capabilities_returns_only_supported_operation_pairs_without_save_io() {
    let request = serde_json::json!({
        "protocolVersion": 1,
        "operation": "capabilities"
    });
    let out = common::run_sidecar(&capabilities_args(), request.to_string().as_bytes());
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    let value: Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["operation"], "capabilities");
    assert_eq!(value["status"], "ok");
    assert_eq!(
        value["capabilities"],
        serde_json::json!([
            { "operation": "probe", "protocolVersion": 2 },
            { "operation": "extract", "protocolVersion": 2 },
            { "operation": "verify", "protocolVersion": 2 },
            { "operation": "session", "protocolVersion": 3 }
        ])
    );
    assert!(value.get("inputPath").is_none());
    assert!(value.get("allowedRootPath").is_none());
}

#[test]
fn capabilities_rejects_save_path_flags_at_cli_boundary() {
    let args = vec![
        "capabilities".into(),
        "--input".into(),
        "missing.ck3".into(),
        "--max-output-bytes".into(),
        common::MAX_OUTPUT.into(),
    ];
    let out = common::run_sidecar(&args, b"{}");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn capabilities_unknown_request_is_explicitly_unsupported() {
    let request = serde_json::json!({
        "protocolVersion": 1,
        "operation": "capabilities",
        "inputPath": "should-not-be-read"
    });
    let out = common::run_sidecar(&capabilities_args(), request.to_string().as_bytes());
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    assert_eq!(value["status"], "unsupported");
    assert_eq!(value["capabilities"], serde_json::json!([]));
}
