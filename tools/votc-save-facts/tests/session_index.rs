//! Plan B Task 3: one-pass public index integration through the CLI.
//!
//! Verifies that `session_open` reports real bounded index counts, flips to
//! partial with stable warnings when caps are hit, never leaks skipped
//! secret/AI markers into stdout, and produces identical summaries for
//! identical input.

#[path = "common/mod.rs"]
mod common;

use common::{s, TempDir};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};

fn char_entry(id: &str, body: &str) -> String {
    format!("\t{id}={{\n{body}\t}}\n")
}

/// Rich synthetic save: three living characters (family/court/liege links)
/// and two numeric titles with loc keys.
fn rich_save_body() -> String {
    let living = common::living_block(&format!(
        "{}{}{}",
        char_entry(
            "1001",
            concat!(
                "\t\tfirst_name=\"Aldric\"\n",
                "\t\tspouse=1002\n",
                "\t\talive_data={ liege=1003 primary_title=8001 }\n"
            )
        ),
        char_entry(
            "1002",
            concat!(
                "\t\tfirst_name=\"Sabina\"\n",
                "\t\tlanded_data={ domain={ 8002 } realm_capital=8002 }\n"
            )
        ),
        char_entry(
            "1003",
            concat!(
                "\t\tfirst_name=\"fictional_player\"\n",
                "\t\tcourt_data={ host=1001 }\n",
                "\t\treal_father=999\n",
                "\t\tsecrets={ MARKER_SECRET_777777 }\n",
                "\t\tai_behavior=MARKER_AI_888888\n"
            )
        ),
    ));
    let titles = common::landed_titles_block(&format!(
        "\t8001={{\n\t\tkey=\"e_test_empire\"\n\t\tholder=1001\n\t}}\n\t8002={{\n\t\tkey=\"k_test_realm\"\n\t\tholder=1002\n\t\tde_facto_liege=8001\n\t}}\n"
    ));
    common::gamestate_blocks(&common::default_vars(1000), &format!("{living}{titles}"))
}

struct SessionProc {
    child: std::process::Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl SessionProc {
    fn spawn(input: &Path, root: &Path) -> Self {
        let mut child = Command::new(binary_path())
            .args([
                "session".to_string(),
                "--input".to_string(),
                s(input),
                "--allowed-root".to_string(),
                s(root),
                "--max-output-bytes".to_string(),
                "262144".to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout }
    }

    fn send_line(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn read_frame(&mut self) -> String {
        let mut line = String::new();
        match self.stdout.read_line(&mut line) {
            Ok(0) => panic!("unexpected EOF waiting for frame"),
            Ok(_) => line.trim_end_matches(['\n', '\r']).to_string(),
            Err(err) => panic!("read failed: {err}"),
        }
    }

    fn wait(mut self) -> std::process::Output {
        drop(self.stdin);
        self.child.wait_with_output().unwrap()
    }
}

fn binary_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_votc-save-facts"))
}

fn write_rich_save(dir: &TempDir, name: &str) -> std::path::PathBuf {
    let body = rich_save_body();
    let meta_len = body.find("}\n").map(|i| i + 2).unwrap_or(body.len());
    let mut content = common::sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    common::write_file(dir.path(), name, &content)
}

fn fingerprint_of(input: &Path, root: &Path) -> String {
    let (_, probe) = common::probe_json(input, root);
    assert_eq!(probe["status"], "ok", "probe failed: {probe}");
    probe["manifest"]["sourceFingerprint"].as_str().unwrap().to_string()
}

fn open_request(fingerprint: &str, max_characters: u64) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": "req-1",
        "sessionId": "sess-index-0001",
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
            "maxCharacters": max_characters,
            "maxTitles": 50000,
            "maxRelationsPerCharacter": 64,
            "maxIdleMs": 600000
        }
    })
    .to_string()
}

#[test]
fn open_reports_real_bounded_index_counts() {
    let dir = TempDir::new("sidx-counts");
    let input = write_rich_save(&dir, "rich.ck3");
    let fingerprint = fingerprint_of(&input, dir.path());

    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000));
    let frame: serde_json::Value =
        serde_json::from_str(&proc.read_frame()).expect("open response JSON");
    assert_eq!(frame["status"], "ready", "{frame}");
    assert_eq!(frame["index"]["status"], "ready");
    assert_eq!(frame["index"]["livingCharacterCount"], 3);
    assert_eq!(frame["index"]["titleCount"], 2);
    assert!(
        frame["index"]["warningCodes"].as_array().unwrap().is_empty(),
        "no warnings expected: {frame}"
    );

    proc.send_line(&close_request_line("sess-index-0001"));
    let close: serde_json::Value =
        serde_json::from_str(&proc.read_frame()).expect("close response");
    assert_eq!(close["status"], "closed");
    let output = proc.wait();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
}

fn close_request_line(session_id: &str) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": "req-close-1",
        "sessionId": session_id,
        "operation": "session_close"
    })
    .to_string()
}

#[test]
fn lowered_character_cap_flips_index_to_partial_with_stable_warning() {
    let dir = TempDir::new("sidx-cap");
    let input = write_rich_save(&dir, "rich.ck3");
    let fingerprint = fingerprint_of(&input, dir.path());

    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 2));
    let frame: serde_json::Value =
        serde_json::from_str(&proc.read_frame()).expect("open response JSON");
    assert_eq!(frame["status"], "ready", "open still succeeds: {frame}");
    assert_eq!(frame["index"]["status"], "partial");
    assert_eq!(frame["index"]["livingCharacterCount"], 3, "count is total living seen");
    let warnings: Vec<String> = frame["index"]["warningCodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect();
    assert!(warnings.contains(&"INDEX_CHARACTER_LIMIT".to_string()), "{warnings:?}");

    proc.send_line(&close_request_line("sess-index-0001"));
    proc.read_frame();
    let output = proc.wait();
    assert!(output.status.success());
}

#[test]
fn skipped_secret_and_ai_markers_never_reach_stdout() {
    let dir = TempDir::new("sidx-secrets");
    let input = write_rich_save(&dir, "rich.ck3");
    let fingerprint = fingerprint_of(&input, dir.path());

    let mut proc = SessionProc::spawn(&input, dir.path());
    proc.send_line(&open_request(&fingerprint, 10000));
    let frame = proc.read_frame();
    assert!(frame.contains("\"ready\""), "{frame}");
    proc.send_line(&close_request_line("sess-index-0001"));
    proc.read_frame();
    let output = proc.wait();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("MARKER_SECRET_777777"), "secret leaked: {stdout}");
    assert!(!stdout.contains("MARKER_AI_888888"), "AI state leaked: {stdout}");
    // Obfuscated name must not appear as a literal display name anywhere.
    assert!(!stdout.contains("fictional_player"), "obfuscated save-internal name leaked");
    assert!(!stdout.contains("999\""), "real_father id leaked");
}

#[test]
fn identical_input_produces_identical_open_summaries() {
    let run = |tag: &str| -> (u64, u64, Vec<String>, String) {
        let dir = TempDir::new(tag);
        let input = write_rich_save(&dir, "rich.ck3");
        let fingerprint = fingerprint_of(&input, dir.path());
        let mut proc = SessionProc::spawn(&input, dir.path());
        proc.send_line(&open_request(&fingerprint, 10000));
        let frame: serde_json::Value =
            serde_json::from_str(&proc.read_frame()).expect("open response");
        proc.send_line(&close_request_line("sess-index-0001"));
        proc.read_frame();
        let output = proc.wait();
        assert!(output.status.success());
        (
            frame["index"]["livingCharacterCount"].as_u64().unwrap(),
            frame["index"]["titleCount"].as_u64().unwrap(),
            frame["index"]["warningCodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_string())
                .collect(),
            frame["manifest"]["sourceFingerprint"].as_str().unwrap().to_string(),
        )
    };
    let first = run("sidx-det-a");
    let second = run("sidx-det-b");
    assert_eq!(first.0, second.0);
    assert_eq!(first.1, second.1);
    assert_eq!(first.2, second.2);
    assert_eq!(first.3, second.3);
}
