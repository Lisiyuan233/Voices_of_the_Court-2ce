//! Shared interactive-session helpers for protocol v3 integration tests.
//! Each integration test file includes this module via #[path].
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

pub struct SessionProc {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<std::process::ChildStdout>,
}

impl SessionProc {
    pub fn spawn(input: &Path, root: &Path) -> Self {
        let mut child = Command::new(std::env::var("CARGO_BIN_EXE_votc-save-facts").unwrap_or_else(|_| env!("CARGO_BIN_EXE_votc-save-facts").to_string()))
            .args([
                "session".to_string(),
                "--input".to_string(),
                input.to_str().unwrap().to_string(),
                "--allowed-root".to_string(),
                root.to_str().unwrap().to_string(),
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

    pub fn send_line(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Blocking bounded read of one NDJSON response line.
    pub fn read_frame(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.stdout.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_string()),
            Err(_) => None,
        }
    }

    pub fn read_json(&mut self) -> serde_json::Value {
        let line = self.read_frame().unwrap_or_else(|| panic!("expected frame"));
        serde_json::from_str(&line).unwrap_or_else(|err| panic!("bad JSON `{line}`: {err}"))
    }

    pub fn expect_error(&mut self, code: &str) -> serde_json::Value {
        let frame = self.read_json();
        assert_eq!(frame["status"], "error", "expected error frame: {frame}");
        assert_eq!(frame["errorCode"], code, "unexpected errorCode: {frame}");
        frame
    }

    /// Poll-wait with deadline (ms). Returns exit code (None = timed out).
    pub fn wait_deadline(mut self, timeout_ms: u64) -> Option<i32> {
        drop(self.stdin);
        let started = std::time::Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {
                    if started.elapsed().as_millis() as u64 >= timeout_ms {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => return None,
            }
        }
    }

    pub fn wait_output(self) -> std::process::Output {
        drop(self.stdin);
        self.child.wait_with_output().unwrap()
    }
}

pub fn open_request(fingerprint: &str, max_characters: u64, max_idle_ms: u64) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": "req-1",
        "sessionId": "sess-it-0001",
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
            "maxIdleMs": max_idle_ms
        }
    })
    .to_string()
}

pub fn search_request(request_id: &str, selectors: serde_json::Value, limit: u64) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": request_id,
        "sessionId": "sess-it-0001",
        "operation": "character_search",
        "selectors": selectors,
        "limit": limit
    })
    .to_string()
}

pub fn profile_request(request_id: &str, character_id: &str, sections: &[&str]) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": request_id,
        "sessionId": "sess-it-0001",
        "operation": "character_profile",
        "characterId": character_id,
        "sections": sections
    })
    .to_string()
}

pub fn close_request(request_id: &str) -> String {
    serde_json::json!({
        "protocolVersion": 3,
        "requestId": request_id,
        "sessionId": "sess-it-0001",
        "operation": "session_close"
    })
    .to_string()
}

/// Write a rich text save and return (path, exact fingerprint from probe).
pub fn make_save(dir: &super::common::TempDir, name: &str) -> (std::path::PathBuf, String) {
    use super::common::char_entry;
    let living = format!(
        "{}{}{}{}",
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
                "\t\tfirst_name=\"Baldwin\"\n",
                "\t\tcourt_data={ host=1001 }\n"
            )
        ),
        char_entry(
            "5005",
            concat!("\t\tfirst_name=\"Dup\"\n", "\t\talive_data={ liege=1003 }\n")
        ),
    );
    let dup_entries = format!(
        "{}{}{}{}",
        char_entry("5001", "\t\tfirst_name=\"Dup\"\n"),
        char_entry("5010", "\t\tfirst_name=\"Dup\"\n"),
        char_entry(
            "6000",
            concat!(
                "\t\tfirst_name=\"Parent\"\n",
                "\t\tfamily_data={ child={ 6001 } }\n"
            )
        ),
        char_entry("6001", "\t\tfirst_name=\"Child\"\n")
    );
    let living_all = super::common::living_block(&format!("{living}{dup_entries}"));
    let titles = super::common::landed_titles_block(
        "\t8001={\n\t\tkey=\"e_test_empire\"\n\t\tholder=1001\n\t}\n\t8002={\n\t\tkey=\"k_test_realm\"\n\t\tholder=1002\n\t\tde_facto_liege=8001\n\t}\n",
    );
    let body = super::common::gamestate_blocks(&super::common::default_vars(1000), &format!("{living_all}{titles}"));
    let meta_len = body.find("}\n").map(|i| i + 2).unwrap_or(body.len());
    let mut content = super::common::sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    let path = super::common::write_file(dir.path(), name, &content);
    let (_, probe) = super::common::probe_json(&path, dir.path());
    assert_eq!(probe["status"], "ok", "probe failed: {probe}");
    let fingerprint = probe["manifest"]["sourceFingerprint"].as_str().unwrap().to_string();
    (path, fingerprint)
}
