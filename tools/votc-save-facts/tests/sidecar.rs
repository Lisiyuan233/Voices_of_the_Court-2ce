//! votc-save-facts 集成测试（实施计划 Task 2 步骤 7）。
//!
//! 覆盖：CLI usage error、stdin 超限、JSON 尾部垃圾、unknown 字段策略、
//! 路径逃逸（越界 / symlink / 非 .ck3 / 目录）、输出上限降级、
//! 响应 JSON 结构稳定（快照式字段检查）、错误不回显完整路径、
//! stdout 只含一份 JSON。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_OUTPUT: &str = "2097152";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("votc-sf-test-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// allowed root 内含一个最小 .ck3 占位文件的 fixture。
struct Fixture {
    root: PathBuf,
    input: PathBuf,
    input_len: usize,
    _dir: TempDir,
}

fn make_fixture() -> Fixture {
    let dir = TempDir::new("fixture");
    let input = dir.path().join("save.ck3");
    // 占位内容；Task 2 不解析文件内容，只关心 containment 与大小。
    let content = b"meta_data={}\n";
    fs::write(&input, content).unwrap();
    Fixture {
        root: dir.path().to_path_buf(),
        input,
        input_len: content.len(),
        _dir: dir,
    }
}

fn s(path: &Path) -> String {
    path.to_str().unwrap().to_string()
}

fn cli_args(op: &str, input: &Path, root: &Path, max_output: &str) -> Vec<String> {
    vec![
        op.to_string(),
        "--input".into(),
        s(input),
        "--allowed-root".into(),
        s(root),
        "--max-output-bytes".into(),
        max_output.into(),
    ]
}

fn binary_path() -> PathBuf {
    // cargo 在运行测试时会设置 CARGO_BIN_EXE_*；取不到时退回编译期值。
    let raw = std::env::var("CARGO_BIN_EXE_votc-save-facts")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_votc-save-facts").to_string());
    wsl_to_windows_path(&raw)
}

/// 本环境下 cargo 是 WSL Linux 进程，给出的二进制路径是 /mnt/<drive>/...
/// 形式；测试进程本身是 Windows 进程，需要 <drive>:\... 形式才能 spawn。
/// 在普通 Windows 开发机上路径已是 Windows 形式，原样返回。
#[cfg(windows)]
fn wsl_to_windows_path(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("/mnt/") {
        let mut chars = rest.chars();
        match (chars.next(), chars.next()) {
            (Some(drive), Some('/')) if drive.is_ascii_alphabetic() => {
                let tail: String = chars.collect();
                return PathBuf::from(format!("{}:\\{}", drive, tail.replace('/', "\\")));
            }
            _ => {}
        }
    }
    PathBuf::from(raw)
}

#[cfg(not(windows))]
fn wsl_to_windows_path(raw: &str) -> PathBuf {
    PathBuf::from(raw)
}

fn run_sidecar(args: &[String], stdin_bytes: &[u8]) -> Output {
    let mut child = Command::new(binary_path())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // 子进程可能提前退出（例如 stdin 超限后停读），忽略 broken pipe。
    let _ = stdin.write_all(stdin_bytes);
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn valid_request(op: &str) -> serde_json::Value {
    serde_json::json!({
        "protocolVersion": 2,
        "operation": op,
        "expected": {
            "playerCharacterId": "1001",
            "participantCharacterIds": ["1003", "1002"],
            "gameDateNumeric": 8670101,
            "campaignId": "abc",
            "campaignIdParts": [1, 2, 3, 4],
            "snapshotSequence": 7,
            "snapshotSlot": 0
        },
        "categories": ["identity", "family", "realm"],
        "limits": {
            "maxFacts": 100,
            "maxEntities": 50,
            "maxRelatedCharacters": 20,
            "maxOutputBytes": 1048576,
            "maxDecompressedBytes": 1048576,
            "maxNestingDepth": 64,
            "maxScalarBytes": 1024
        }
    })
}

/// 协议响应路径：断言成功退出、stderr 为空、stdout 为一份完整 JSON。
fn expect_protocol_json(out: &Output) -> serde_json::Value {
    assert!(
        out.status.success(),
        "protocol responses must exit 0, got {:?} (stderr: {})",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stderr.is_empty(),
        "stderr must stay empty on protocol responses, got: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    assert!(stdout.ends_with("}\n"), "exactly one trailing newline");
    assert!(!stdout.ends_with("}\n\n"), "no extra blank line");
    serde_json::from_str(stdout.trim_end()).expect("stdout must be one complete JSON document")
}

fn expect_invalid_with_code(out: &Output, code: &str) -> serde_json::Value {
    let v = expect_protocol_json(out);
    assert_eq!(v["status"], "invalid");
    assert_eq!(v["error"]["code"], code);
    v
}

// ---------------------------------------------------------------------------
// CLI usage error
// ---------------------------------------------------------------------------

#[test]
fn usage_error_on_unknown_flag() {
    let fx = make_fixture();
    let mut args = cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT);
    args.push("--output".into());
    args.push("x".into());
    let out = run_sidecar(&args, b"");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty(), "usage errors must not write stdout");
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}

#[test]
fn usage_error_on_duplicate_flag() {
    let fx = make_fixture();
    let args = vec![
        "probe".into(),
        "--input".into(),
        s(&fx.input),
        "--input".into(),
        s(&fx.input),
        "--allowed-root".into(),
        s(&fx.root),
        "--max-output-bytes".into(),
        MAX_OUTPUT.into(),
    ];
    let out = run_sidecar(&args, b"");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn usage_error_on_missing_flag() {
    let fx = make_fixture();
    let args = vec![
        "probe".into(),
        "--input".into(),
        s(&fx.input),
        "--allowed-root".into(),
        s(&fx.root),
    ];
    let out = run_sidecar(&args, b"");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn usage_error_on_unknown_subcommand() {
    let out = run_sidecar(&["dump".into()], b"");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn usage_error_on_max_output_bytes_over_hard_cap() {
    let fx = make_fixture();
    let args = cli_args("probe", &fx.input, &fx.root, "2097153");
    let out = run_sidecar(&args, b"");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

// ---------------------------------------------------------------------------
// stdin 请求：超限、尾部垃圾、unknown 字段、语义校验
// ---------------------------------------------------------------------------

#[test]
fn stdin_over_limit_returns_request_limit_exceeded() {
    let fx = make_fixture();
    let big = vec![b' '; 64 * 1024 + 1];
    let out = run_sidecar(&cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT), &big);
    expect_invalid_with_code(&out, "REQUEST_LIMIT_EXCEEDED");
}

#[test]
fn stdin_trailing_garbage_is_invalid() {
    let fx = make_fixture();
    let mut raw = valid_request("probe").to_string().into_bytes();
    raw.extend_from_slice(b" trailing");
    let out = run_sidecar(&cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT), &raw);
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_empty_is_invalid() {
    let fx = make_fixture();
    let out = run_sidecar(&cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT), b"");
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_unknown_field_rejected() {
    // unknown 字段策略：拒绝（deny_unknown_fields）。
    let fx = make_fixture();
    let mut req = valid_request("probe");
    req["recentUserText"] = serde_json::json!("hello");
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_wrong_protocol_version_rejected() {
    let fx = make_fixture();
    let mut req = valid_request("probe");
    req["protocolVersion"] = serde_json::json!(3);
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_operation_must_match_subcommand() {
    let fx = make_fixture();
    let out = run_sidecar(
        &cli_args("extract", &fx.input, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_unknown_category_rejected() {
    let fx = make_fixture();
    let mut req = valid_request("probe");
    req["categories"] = serde_json::json!(["identity", "war"]);
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_limits_above_hard_cap_rejected() {
    let fx = make_fixture();
    let mut req = valid_request("probe");
    req["limits"]["maxFacts"] = serde_json::json!(501);
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

#[test]
fn stdin_too_many_participants_rejected() {
    let fx = make_fixture();
    let mut req = valid_request("probe");
    let ids: Vec<String> = (0..101).map(|i| format!("p{i}")).collect();
    req["expected"]["participantCharacterIds"] = serde_json::json!(ids);
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "REQUEST_INVALID");
}

// ---------------------------------------------------------------------------
// 路径 containment
// ---------------------------------------------------------------------------

#[test]
fn input_not_found_returns_save_not_found() {
    let fx = make_fixture();
    let missing = fx.root.join("nope.ck3");
    let out = run_sidecar(
        &cli_args("probe", &missing, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "SAVE_NOT_FOUND");
}

#[test]
fn input_outside_allowed_root_rejected_without_path_echo() {
    let fx = make_fixture();
    let outside = TempDir::new("outside");
    let file = outside.path().join("save.ck3");
    fs::write(&file, b"x").unwrap();
    let out = run_sidecar(
        &cli_args("probe", &file, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "SAVE_READ_DENIED");
    // 错误响应不得回显完整路径（两端 canonical/原始形式都检查）。
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains(&s(&file)), "stdout echoes input path");
    assert!(
        !stdout.contains(&s(outside.path())),
        "stdout echoes outside dir"
    );
    assert!(!stdout.contains(&s(&fx.root)), "stdout echoes allowed root");
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(!stderr.contains(&s(&file)), "stderr echoes input path");
}

#[test]
fn input_symlink_escaping_root_rejected() {
    let fx = make_fixture();
    let outside = TempDir::new("outside");
    let target = outside.path().join("save.ck3");
    fs::write(&target, b"x").unwrap();
    let link = fx.root.join("link.ck3");
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&target, &link).is_ok();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&target, &link).is_ok();
    #[cfg(not(any(unix, windows)))]
    let made = false;
    if !made {
        eprintln!("symlink creation not permitted on this host; skipping");
        return;
    }
    let out = run_sidecar(
        &cli_args("probe", &link, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "SAVE_READ_DENIED");
}

#[test]
fn input_non_ck3_extension_rejected() {
    let fx = make_fixture();
    let file = fx.root.join("save.txt");
    fs::write(&file, b"x").unwrap();
    let out = run_sidecar(
        &cli_args("probe", &file, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "SAVE_READ_DENIED");
}

#[test]
fn input_directory_rejected() {
    let fx = make_fixture();
    let dir = fx.root.join("dir.ck3");
    fs::create_dir(&dir).unwrap();
    let out = run_sidecar(
        &cli_args("probe", &dir, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    expect_invalid_with_code(&out, "SAVE_READ_DENIED");
}

// ---------------------------------------------------------------------------
// probe / extract 占位响应与结构稳定性
// ---------------------------------------------------------------------------

#[test]
fn probe_unsupported_response_shape_is_stable() {
    let fx = make_fixture();
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        valid_request("probe").to_string().as_bytes(),
    );
    let v = expect_protocol_json(&out);

    // 顶层 key 集合冻结（计划 5.4，identity 缺省时省略）。
    let obj = v.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "entities",
            "error",
            "facts",
            "manifest",
            "metrics",
            "operation",
            "protocolVersion",
            "status",
            "warnings"
        ]
    );

    assert_eq!(v["protocolVersion"], 2);
    assert_eq!(v["operation"], "probe");
    assert_eq!(v["status"], "unsupported");
    assert_eq!(v["entities"], serde_json::json!([]));
    assert_eq!(v["facts"], serde_json::json!([]));
    assert_eq!(v["warnings"], serde_json::json!([]));
    assert_eq!(v["error"]["code"], "SAVE_ENVELOPE_UNKNOWN");
    assert!(v.get("identity").is_none());

    let manifest = v["manifest"].as_object().unwrap();
    let mut mkeys: Vec<&str> = manifest.keys().map(String::as_str).collect();
    mkeys.sort_unstable();
    assert_eq!(
        mkeys,
        [
            "factSchemaVersion",
            "parserVersion",
            "snapshotId",
            "sourceFingerprint",
            "sourceFormat"
        ]
    );
    assert_eq!(v["manifest"]["sourceFormat"], "unknown");
    assert_eq!(v["manifest"]["factSchemaVersion"], 1);
    assert!(v["manifest"]["parserVersion"].is_string());
    // Task 3 起：envelope 无法识别时 snapshotId 为空（unidentified），
    // sourceFingerprint 为真实 SHA-256（64 位小写 hex）。
    assert_eq!(v["manifest"]["snapshotId"], "");
    let fp = v["manifest"]["sourceFingerprint"].as_str().unwrap();
    assert_eq!(fp.len(), 64);
    assert!(fp.bytes().all(|b| b.is_ascii_hexdigit()));

    let metrics = v["metrics"].as_object().unwrap();
    let mut kkeys: Vec<&str> = metrics.keys().map(String::as_str).collect();
    kkeys.sort_unstable();
    assert_eq!(
        kkeys,
        [
            "durationMs",
            "emittedEntities",
            "emittedFacts",
            "inputBytes"
        ]
    );
    assert_eq!(v["metrics"]["inputBytes"], fx.input_len as u64);
    assert_eq!(v["metrics"]["emittedFacts"], 0);
    assert_eq!(v["metrics"]["emittedEntities"], 0);
    assert!(v["metrics"]["durationMs"].is_number());
}

#[test]
fn extract_unsupported_response_matches_subcommand() {
    let fx = make_fixture();
    let out = run_sidecar(
        &cli_args("extract", &fx.input, &fx.root, MAX_OUTPUT),
        valid_request("extract").to_string().as_bytes(),
    );
    let v = expect_protocol_json(&out);
    assert_eq!(v["operation"], "extract");
    assert_eq!(v["status"], "unsupported");
    assert_eq!(v["error"]["code"], "SAVE_ENVELOPE_UNKNOWN");
    assert_eq!(v["entities"], serde_json::json!([]));
    assert_eq!(v["facts"], serde_json::json!([]));
}

// ---------------------------------------------------------------------------
// 输出上限
// ---------------------------------------------------------------------------

#[test]
fn output_over_cap_falls_back_to_small_limit_response() {
    let fx = make_fixture();
    let req = valid_request("probe").to_string();
    let full = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, MAX_OUTPUT),
        req.as_bytes(),
    );
    assert!(full.status.success());
    let full_len = full.stdout.len();

    // 把 cap 压到正常响应之下、小型响应之上：应得到完整的
    // SAVE_LIMIT_EXCEEDED 响应而不是截断 JSON。
    let cap = (full_len - 20).to_string();
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, &cap),
        req.as_bytes(),
    );
    let v = expect_protocol_json(&out);
    assert!(out.stdout.len() <= full_len - 20);
    assert_eq!(v["status"], "invalid");
    assert_eq!(v["error"]["code"], "SAVE_LIMIT_EXCEEDED");
}

#[test]
fn output_cap_below_minimum_response_is_process_failure() {
    let fx = make_fixture();
    let out = run_sidecar(
        &cli_args("probe", &fx.input, &fx.root, "64"),
        valid_request("probe").to_string().as_bytes(),
    );
    assert!(
        !out.status.success(),
        "tiny cap must fail closed (non-zero)"
    );
    assert!(out.stdout.is_empty(), "no truncated JSON on stdout");
}
