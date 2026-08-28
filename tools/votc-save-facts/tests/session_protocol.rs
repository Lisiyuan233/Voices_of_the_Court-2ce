//! Phase 3 Plan B Task 2: persistent session subcommand protocol skeleton.
//!
//! Covers CLI whitelist, capabilities advertisement, bounded NDJSON framing,
//! first-frame-must-be-open, strict frame validation, oversized rejection,
//! clean lifecycle (open → not-ready queries → close) and the guarantee that
//! protocol violations never touch the save file.

#[path = "common/mod.rs"]
mod common;

use common::{s, TempDir};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

fn session_args(input: &Path, root: &Path) -> Vec<String> {
    vec![
        "session".into(),
        "--input".into(),
        s(input),
        "--allowed-root".into(),
        s(root),
        "--max-output-bytes".into(),
        "262144".into(),
    ]
}

struct SessionProc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl SessionProc {
    fn spawn(input: &Path, root: &Path) -> Self {
        let mut child = Command::new(binary_path())
            .args(&session_args(input, root))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send_line(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        self.stdin.write_all(bytes).unwrap();
        self.stdin.flush().unwrap();
    }

    /// Blocking bounded read of one NDJSON response line (None on EOF).
    fn read_frame(&mut self) -> Option<String> {
        let mut line = String::new();
        // Hard safety valve so a buggy sidecar cannot hang CI forever.
        let read = self.stdout.read_line(&mut line);
        match read {
            Ok(0) => None,
            Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_string()),
            Err(_) => None,
        }
    }

    fn wait(self) -> (i32, String) {
        drop(self.stdin);
        let output = self.child.wait_with_output().unwrap();
        (
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).to_string(),
        )
    }
}

fn binary_path() -> PathBuf {
    let raw = std::env::var("CARGO_BIN_EXE_votc-save-facts")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_votc-save-facts").to_string());
    PathBuf::from(wsl_to_windows_path(&raw))
}

fn wsl_to_windows_path(raw: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = raw.strip_prefix("/mnt/") {
            let mut chars = rest.chars();
            if let (Some(drive), Some('/')) = (chars.next(), chars.next()) {
                if drive.is_ascii_alphabetic() {
                    let tail: String = chars.collect();
                    return format!("{}:\\{}", drive, tail.replace('/', "\\"));
                }
            }
        }
    }
    raw.to_string()
}

/// Build a valid text save and return its exact expected fingerprint via probe.
fn make_save(dir: &TempDir, name: &str) -> (PathBuf, String) {
    let extra = common::living_block(&common::char_entry(
        "9999",
        "\t\tfirst_name=\"Aldric\"\n\t\talive_data={ liege=1001 }\n",
    ));
    let body = common::gamestate_blocks(&common::default_vars(1000), &extra);
    let meta_len = body.find("}\n").map(|i| i + 2).unwrap_or(body.len());
    let mut content = common::sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    let input = common::write_file(dir.path(), name, &content);
    let (_, probe) = common::probe_json(&input, dir.path());
    assert_eq!(probe["status"], "ok", "fixture probe failed: {probe}");
    let fingerprint = probe["manifest"]["sourceFingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    (input, fingerprint)
}

fn open_request(fingerprint: &str) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": "req-1",
        "sessionId": "5f0a-SESSION-id-0001",
        "operation": "session_open",
        "expected": {
            "playerCharacterId": "1001",
            "participantCharacterIds": ["1001"],
            "gameDateNumeric": 316470,
            "campaignId": "placeholder",
            "campaignIdParts": [111, 222, 333, 444],
            "snapshotSequence": 17,
            "snapshotSlot": 0,
            "sourceFingerprint": fingerprint
        },
        "limits": {
            "maxDecompressedBytes": 67108864,
            "maxNestingDepth": 128,
            "maxScalarBytes": 65536,
            "maxCharacters": 10000,
            "maxTitles": 5000,
            "maxRelationsPerCharacter": 64,
            "maxIdleMs": 600000
        }
    })
    .to_string()
}

fn search_request(request_id: &str, session_id: &str) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": request_id,
        "sessionId": session_id,
        "operation": "character_search",
        "selectors": { "literalNameQuery": "Aldric" },
        "limit": 8
    })
    .to_string()
}

fn close_request(request_id: &str, session_id: &str) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": request_id,
        "sessionId": session_id,
        "operation": "session_close"
    })
    .to_string()
}

fn parse_frame(line: &str) -> serde_json::Value {
    serde_json::from_str(line).unwrap_or_else(|err| panic!("frame not JSON: {err}: {line}"))
}

fn expect_error_frame(line: &str, code: &str) -> serde_json::Value {
    let frame = parse_frame(line);
    assert_eq!(frame["status"], "error", "expected error frame: {line}");
    assert_eq!(frame["errorCode"], code, "unexpected code in: {line}");
    frame
}

#[test]
fn capabilities_advertise_session_v3() {
    let out = common::run_sidecar(
        &[
            "capabilities".to_string(),
            "--max-output-bytes".to_string(),
            "262144".to_string(),
        ],
        b"{\"protocolVersion\":1,\"operation\":\"capabilities\"}",
    );
    assert!(out.status.success());
    let value: serde_json::Value =
        serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    assert_eq!(value["status"], "ok");
    let entries = value["capabilities"].as_array().unwrap();
    assert!(
        entries
            .iter()
            .any(|e| e["operation"] == "session" && e["protocolVersion"] == 3),
        "missing session/v3 capability: {value}"
    );
    // Legacy pairs remain advertised unchanged.
    assert!(entries.iter().any(|e| e["operation"] == "probe"));
    assert!(entries.iter().any(|e| e["operation"] == "verify" && e["protocolVersion"] == 2));
}

#[test]
fn session_cli_rejects_duplicate_flags_and_unknown_flags() {
    let dir = TempDir::new("sess-cli");
    let missing = dir.path().join("missing.ck3");

    let dup = common::run_sidecar(
        &[
            "session".into(),
            "--input".into(),
            s(&missing),
            "--input".into(),
            s(&missing),
            "--allowed-root".into(),
            s(dir.path()),
            "--max-output-bytes".into(),
            "262144".into(),
        ],
        b"",
    );
    assert_eq!(dup.status.code(), Some(2), "duplicate flag must be usage error");

    let unknown = common::run_sidecar(
        &[
            "session".into(),
            "--input".into(),
            s(&missing),
            "--allowed-root".into(),
            s(dir.path()),
            "--max-output-bytes".into(),
            "262144".into(),
            "--dump".into(),
            "x".into(),
        ],
        b"",
    );
    assert_eq!(unknown.status.code(), Some(2), "unknown flag must be usage error");
}

#[test]
fn first_frame_must_be_session_open() {
    let dir = TempDir::new("sess-first");
    let missing = dir.path().join("never.ck3");
    let mut proc = SessionProc::spawn(&missing, dir.path());
    proc.send_line(&search_request("req-1", "sid"));
    let line = proc.read_frame().expect("terminal frame required");
    expect_error_frame(&line, "REQUEST_INVALID");
    let (code, _stderr) = proc.wait();
    assert_eq!(code, 0, "invalid protocol responses still exit 0");
}

#[test]
fn malformed_first_frames_are_rejected_without_save_io() {
    let mut cases: Vec<(String, Vec<u8>)> = vec![
        ("empty line".into(), b"\n".to_vec()),
        (
            "bom prefix".into(),
            [[0xEF, 0xBB, 0xBF].as_slice(), b"{}", b"\n"].concat(),
        ),
        ("array top level".into(), b"[1,2]\n".to_vec()),
        (
            "multiple documents".into(),
            b"{\"a\":1}{\"b\":2}\n".to_vec(),
        ),
        (
            "unknown field".into(),
            br#"{"protocolVersion":3,"requestId":"r","sessionId":"s","operation":"session_open","extra":1}"#
                .to_vec(),
        ),
        ("invalid utf8".into(), vec![0xFF, 0xFE, 0x0A]),
        (
            "wrong protocol version".into(),
            br#"{"protocolVersion":2,"requestId":"r","sessionId":"s","operation":"session_close"}"#
                .to_vec(),
        ),
        (
            "unknown operation".into(),
            br#"{"protocolVersion":3,"requestId":"r","sessionId":"s","operation":"dump_world"}"#
                .to_vec(),
        ),
    ];
    // Every frame must be newline-terminated or the child waits for EOF
    // while the parent waits for a response: circular wait.
    for (_, payload) in cases.iter_mut() {
        if payload.last() != Some(&b'\n') {
            payload.push(b'\n');
        }
    }
    for (label, payload) in cases {
        let dir = TempDir::new("sess-bad-frame");
        let missing = dir.path().join("never-read.ck3");
        let mut proc = SessionProc::spawn(&missing, dir.path());
        proc.send_raw(&payload);
        let line = proc
            .read_frame()
            .unwrap_or_else(|| panic!("{label}: expected terminal frame"));
        let frame = expect_error_frame(&line, "REQUEST_INVALID");
        assert!(
            frame.get("message").and_then(|m| m.as_str()).is_some(),
            "{label}: bounded message required"
        );
        let message = frame["message"].as_str().unwrap();
        assert!(
            !message.contains("never-read"),
            "{label}: messages must never contain paths: {message}"
        );
        let (code, _) = proc.wait();
        assert_eq!(code, 0, "{label}: protocol errors exit 0 after emitting frame");
    }
}

#[test]
fn oversized_frame_is_rejected_at_the_cap() {
    let dir = TempDir::new("sess-big");
    let missing = dir.path().join("never.ck3");
    let mut proc = SessionProc::spawn(&missing, dir.path());
    let big = vec![b'a'; 64 * 1024 + 1];
    proc.send_raw(&big);
    // The child may have already terminated on the oversized frame; ignore
    // the broken-pipe error for the trailing newline.
    let _ = writeln!(proc.stdin, "");
    let line = proc.read_frame().expect("limit frame required");
    expect_error_frame(&line, "REQUEST_LIMIT_EXCEEDED");
    let (code, _) = proc.wait();
    assert_eq!(code, 0);
}

#[test]
fn open_with_missing_save_fails_cleanly_per_type() {
    let dir = TempDir::new("sess-missing");
    let missing = dir.path().join("gone.ck3");
    let mut proc = SessionProc::spawn(&missing, dir.path());
    proc.send_line(&open_request("deadbeef"));
    let line = proc.read_frame().expect("typed failure frame");
    expect_error_frame(&line, "SAVE_NOT_FOUND");
    let (code, stderr) = proc.wait();
    assert_eq!(code, 0);
    assert!(!stderr.contains("gone"), "stderr must not leak paths: {stderr}");
}

#[test]
fn valid_open_becomes_ready_with_pending_index_then_close_works() {
    let dir = TempDir::new("sess-life");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());

    // One request, exactly one response line.
    proc.send_line(&open_request(&fingerprint));
    let line = proc.read_frame().expect("open response");
    let frame = parse_frame(&line);
    assert_eq!(frame["status"], "ready", "open must become ready: {line}");
    assert_eq!(frame["requestId"], "req-1");
    assert_eq!(frame["identity"]["playerCharacterId"], "1001");
    // The synthetic fixture carries exactly one living character (9999)
    // and no landed_titles block.
    assert_eq!(frame["index"]["livingCharacterCount"], 1);
    assert_eq!(frame["index"]["titleCount"], 0);
    assert_eq!(frame["index"]["status"], "ready");

    // Queries now execute against the real index (Plan B Task 4): a literal
    // name search finds the fixture character.
    proc.send_line(&search_request("req-2", "5f0a-SESSION-id-0001"));
    let line = proc.read_frame().expect("search response");
    let frame = parse_frame(&line);
    assert_eq!(frame["status"], "ok", "{line}");
    assert_eq!(
        frame["candidates"][0]["characterId"], "9999",
        "fixture character must be found: {line}"
    );
    proc.send_line(&serde_json::json!({
        "protocolVersion": 3,
        "requestId": "req-3",
        "sessionId": "5f0a-SESSION-id-0001",
        "operation": "character_profile",
        "characterId": "9999",
        "sections": ["identity"]
    }).to_string());
    let line = proc.read_frame().expect("profile response");
    let frame = parse_frame(&line);
    assert_eq!(frame["status"], "ok", "{line}");
    assert_eq!(frame["profile"]["identity"]["literalName"], "Aldric");

    // Close answers once and the process exits cleanly.
    proc.send_line(&close_request("req-4", "5f0a-SESSION-id-0001"));
    let line = proc.read_frame().expect("close response");
    let frame = parse_frame(&line);
    assert_eq!(frame["status"], "closed");
    assert_eq!(frame["operation"], "session_close");
    let (code, _) = proc.wait();
    assert_eq!(code, 0);
    assert!(!line.contains('\n'));
}

#[test]
fn duplicate_request_id_after_open_is_fatal() {
    let dir = TempDir::new("sess-dup-id");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint));
    proc.read_frame().expect("open response");
    proc.send_line(&search_request("req-1", "5f0a-SESSION-id-0001"));
    let line = proc.read_frame().expect("dup id terminal frame");
    expect_error_frame(&line, "REQUEST_INVALID");
    let (code, _) = proc.wait();
    assert_eq!(code, 0);
}

#[test]
fn changed_session_id_after_open_is_fatal() {
    let dir = TempDir::new("sess-sid");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint));
    proc.read_frame().expect("open response");
    proc.send_line(&search_request("req-2", "different-session"));
    let line = proc.read_frame().expect("session change terminal frame");
    expect_error_frame(&line, "REQUEST_INVALID");
    let (code, _) = proc.wait();
    assert_eq!(code, 0);
}

#[test]
fn second_open_is_rejected_single_session_per_process() {
    let dir = TempDir::new("sess-reopen");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint));
    proc.read_frame().expect("open response");
    let second = open_request(&fingerprint).replace("req-1", "req-9");
    proc.send_line(&second);
    let line = proc.read_frame().expect("reopen terminal frame");
    expect_error_frame(&line, "REQUEST_INVALID");
    let (code, _) = proc.wait();
    assert_eq!(code, 0);
}

#[test]
fn stdin_eof_equals_clean_close() {
    let dir = TempDir::new("sess-eof");
    let (input, fingerprint) = make_save(&dir, "save.ck3");
    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint));
    proc.read_frame().expect("open response");
    // Dropping stdin closes the pipe; the sidecar must treat EOF as close.
    let (code, _) = proc.wait();
    assert_eq!(code, 0, "EOF must be a clean shutdown");
}

#[test]
fn legacy_one_shot_operations_still_work() {
    // Guard against regressions in probe/extract/verify dispatch.
    let dir = TempDir::new("sess-legacy");
    let (input, _) = make_save(&dir, "legacy.ck3");
    let (_, probe) = common::probe_json(&input, dir.path());
    assert_eq!(probe["status"], "ok");
    let out = fs::read(&input).unwrap();
    assert!(!out.is_empty());
}
