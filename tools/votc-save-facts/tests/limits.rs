//! Task 5 安全门槛测试（实施计划步骤 2/3/4 的固定 regression corpus）。
//!
//! - zip bomb / archive 安全：高压缩比 + stream 实际超限、declared 与实际
//!   不符、CRC 错误、压缩流损坏、unexpected EOF（envelope 级截断见
//!   tests/envelope.rs 的 truncated_zip / missing/duplicate/slip 用例）。
//! - parser 恶意输入：超深嵌套、超长 token、重复 key storm、mixed
//!   object/array、escaped quotes、非法 UTF-8、NUL、Unicode 边界。
//! - 所有输入必须收敛到既有错误码/跳过行为：进程不 panic、退出码 0、
//!   stdout 恰好一份完整 JSON。

mod common;

use common::*;

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 自定义 nesting/scalar 上限的请求（其余与 valid_request 一致）。
fn request_with_scan_limits(max_nesting: u64, max_scalar: u64, max_decompressed: u64) -> String {
    let mut req: serde_json::Value = serde_json::from_str(&valid_request("probe")).unwrap();
    req["limits"]["maxNestingDepth"] = serde_json::json!(max_nesting);
    req["limits"]["maxScalarBytes"] = serde_json::json!(max_scalar);
    req["limits"]["maxDecompressedBytes"] = serde_json::json!(max_decompressed);
    req.to_string()
}

/// 直接给定字节写文件并用指定请求 probe。
fn probe_bytes(dir: &TempDir, name: &str, content: &[u8], request: &str) -> serde_json::Value {
    let path = write_file(dir.path(), name, content);
    let out = run_sidecar(&probe_args(&path, dir.path()), request.as_bytes());
    assert!(
        out.status.success(),
        "probe must exit 0 (stderr: {})",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice::<serde_json::Value>(&out.stdout[..out.stdout.len() - 1])
        .expect("stdout must be one complete JSON document")
}

fn unified_save(body: &[u8]) -> Vec<u8> {
    let meta_len = body
        .windows(2)
        .position(|w| w == b"}\n")
        .map(|i| i + 2)
        .unwrap_or(body.len());
    let mut content = sav_header_line(0, meta_len);
    content.extend_from_slice(body);
    content
}

fn expect_invalid_code(v: &serde_json::Value, code: &str) {
    assert_eq!(v["status"], "invalid", "unexpected: {v}");
    assert_eq!(v["error"]["code"], code, "unexpected: {v}");
}

// ---------------------------------------------------------------------------
// zip bomb / archive 安全
// ---------------------------------------------------------------------------

#[test]
fn high_ratio_deflate_stream_is_capped_by_budget() {
    // 高压缩比：10 MiB 重复字节 deflate 后只有几 KiB，declared 10 MiB 低于
    // 512 MiB 前置防线，但 request 预算 1 MiB → 流式防线必须拦住。
    let dir = TempDir::new("ratio");
    let gamestate = vec![b'x'; 10 * 1024 * 1024];
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: &gamestate,
        declared_uncompressed: None,
    }]);
    assert!(
        zip.len() < 64 * 1024,
        "deflate ratio fixture should be tiny"
    );
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "ratio.ck3", &save);

    let req = request_with_scan_limits(64, 4096, 1024 * 1024);
    let out = run_sidecar(&probe_args(&path, dir.path()), req.as_bytes());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    expect_invalid_code(&v, "SAVE_LIMIT_EXCEEDED");
}

#[test]
fn crc_mismatch_is_rejected_on_extract_but_probe_skips_tail_verification() {
    let dir = TempDir::new("crc");
    let gamestate = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gamestate.as_bytes(),
        declared_uncompressed: None,
    }]);
    // 破坏 central directory 里的 CRC（数据不动）：翻转第一个 CRC 字节。
    let mut zip = zip;
    let cd_pos = zip
        .windows(4)
        .position(|w| w == b"PK\x01\x02")
        .expect("central directory");
    zip[cd_pos + 16] ^= 0xFF;
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "crc.ck3", &save);

    // extract 读完整条流并在 EOF 校验 CRC → 拒绝。
    let out = run_sidecar(
        &extract_args(&path, dir.path()),
        extract_request(&["1001"], &["family"]).as_bytes(),
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    expect_invalid_code(&v, "SAVE_PARSE_FAILED");

    // probe 提前停止、不校验尾部 CRC → 仍 ok（App 以 extract 为准）。
    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
}

#[test]
fn declared_size_mismatch_is_rejected_on_extract() {
    let dir = TempDir::new("size-lie");
    let gamestate = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gamestate.as_bytes(),
        // 宣称比实际少 1 字节：EOF 校验 size 不符 → 拒绝。
        declared_uncompressed: Some(gamestate.len() as u32 - 1),
    }]);
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "lie.ck3", &save);

    let out = run_sidecar(
        &extract_args(&path, dir.path()),
        extract_request(&["1001"], &["family"]).as_bytes(),
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    expect_invalid_code(&v, "SAVE_PARSE_FAILED");
}

#[test]
fn corrupted_deflate_payload_is_rejected() {
    let dir = TempDir::new("deflate-corrupt");
    let gamestate = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gamestate.as_bytes(),
        declared_uncompressed: None,
    }]);
    // 翻转压缩负载中间的字节（保持结构长度不变）。
    let mut zip = zip;
    let data_pos = zip
        .windows(4)
        .position(|w| w == b"PK\x03\x04")
        .expect("local header");
    let payload = data_pos + 30 + b"gamestate".len();
    for i in 0..8 {
        zip[payload + 8 + i] ^= 0xA5;
    }
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "corrupt.ck3", &save);

    let out = run_sidecar(
        &extract_args(&path, dir.path()),
        extract_request(&["1001"], &["family"]).as_bytes(),
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    assert_eq!(v["status"], "invalid");
    assert!(
        v["error"]["code"] == "SAVE_PARSE_FAILED" || v["error"]["code"] == "SAVE_TRUNCATED",
        "unexpected: {v}"
    );
}

// ---------------------------------------------------------------------------
// parser 恶意输入
// ---------------------------------------------------------------------------

#[test]
fn deep_nesting_hits_nesting_limit() {
    let dir = TempDir::new("deep");
    // 未知顶层块里的 600 层嵌套：即使被跳过也计深度。
    let body = format!("weird={}", "{".repeat(600));
    let content = unified_save(body.as_bytes());
    // request 上限 512（= 硬上限）→ 超出必须 SAVE_LIMIT_EXCEEDED。
    let v = probe_bytes(
        &dir,
        "deep.ck3",
        &content,
        &request_with_scan_limits(512, 4096, 1 << 20),
    );
    expect_invalid_code(&v, "SAVE_LIMIT_EXCEEDED");
}

#[test]
fn overlong_scalar_hits_scalar_limit() {
    let dir = TempDir::new("long-scalar");
    let body = format!("key={}", "a".repeat(70 * 1024));
    let content = unified_save(body.as_bytes());
    // 64 KiB 硬上限作为 request 值。
    let v = probe_bytes(
        &dir,
        "long.ck3",
        &content,
        &request_with_scan_limits(64, 64 * 1024, 1 << 21),
    );
    expect_invalid_code(&v, "SAVE_LIMIT_EXCEEDED");
}

#[test]
fn duplicate_key_storm_is_bounded() {
    let dir = TempDir::new("dup-storm");
    let storm = "\t\tmother=1002\n".repeat(5000);
    let living = living_block(&char_entry("1001", &storm));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "storm.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    assert!(warning_codes_of(&v).contains(&"DUPLICATE_KEY".to_string()));
    // first wins，恰好一条 parent + 一条 derived child。
    assert_eq!(facts_with(&v, "character.parent").len(), 1);
    assert_eq!(facts_with(&v, "character.child").len(), 1);
}

#[test]
fn mixed_object_array_in_variables_is_parse_failed() {
    let dir = TempDir::new("mixed");
    // variables.data 里混入裸 scalar（非法结构）→ 确定性 ParseFailed。
    let body = "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}\ndate=867.1.15\nvariables={\n\tdata={\n\t\t1\n\t\t2\n\t}\n}\n";
    let content = unified_save(body.as_bytes());
    let v = probe_bytes(&dir, "mixed.ck3", &content, &valid_request("probe"));
    expect_invalid_code(&v, "SAVE_PARSE_FAILED");
}

#[test]
fn mixed_content_in_skipped_block_is_fine() {
    let dir = TempDir::new("mixed-skip");
    // 未知顶层块里 object/scalar/string 混杂：整块跳过，不受影响。
    let body = "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}\ndate=867.1.15\nweird={\n\ta=1\n\t{\n\t\tx=1\n\t}\n\t\"loose string\"\n}\n";
    let content = unified_save(body.as_bytes());
    let v = probe_bytes(&dir, "ok.ck3", &content, &valid_request("probe"));
    assert_eq!(v["status"], "ok", "unexpected: {v}");
}

#[test]
fn escaped_quotes_roundtrip() {
    let dir = TempDir::new("esc");
    let living = living_block(&char_entry(
        "1001",
        "\t\tfirst_name=\"Placeholder \\\"Quoted\\\"\"\n",
    ));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "esc.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    let e = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1001")
        .unwrap();
    assert_eq!(e["displayNameCandidate"]["value"], "Placeholder \"Quoted\"");
}

#[test]
fn unterminated_string_is_truncated() {
    let dir = TempDir::new("unterminated");
    let body = "meta_data={\n\tversion=\"1.13.0\n";
    let content = unified_save(body.as_bytes());
    let v = probe_bytes(&dir, "unterm.ck3", &content, &valid_request("probe"));
    expect_invalid_code(&v, "SAVE_TRUNCATED");
}

#[test]
fn invalid_utf8_in_read_field_is_parse_failed() {
    let dir = TempDir::new("utf8-bad");
    let mut body = b"meta_data={\n\tversion=\"".to_vec();
    body.extend_from_slice(&[0xFF, 0xFE]);
    body.extend_from_slice(b"\"\n\tmeta_player_id=1001\n}\ndate=867.1.15\n");
    let content = unified_save(&body);
    let v = probe_bytes(&dir, "bad.ck3", &content, &valid_request("probe"));
    expect_invalid_code(&v, "SAVE_PARSE_FAILED");
}

#[test]
fn invalid_utf8_and_nul_in_skipped_blocks_are_tolerated() {
    let dir = TempDir::new("utf8-skip");
    let mut body = b"meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}\ndate=867.1.15\nsecrets={\n\tx=\"\xFF\xFE\x00\"\n}\n\0garbage_block={\n\t\0\0\n}\n".to_vec();
    let content = unified_save(&body);
    let v = probe_bytes(&dir, "skip.ck3", &content, &valid_request("probe"));
    assert_eq!(v["status"], "ok", "unexpected: {v}");
    body.clear();
}

#[test]
fn unicode_boundary_names_roundtrip() {
    let dir = TempDir::new("unicode");
    let living = living_block(&char_entry("1001", "\t\tfirst_name=\"占位名字 🏰 é\"\n"));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "u.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    let e = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1001")
        .unwrap();
    assert_eq!(e["displayNameCandidate"]["value"], "占位名字 🏰 é");
}

// ---------------------------------------------------------------------------
// 固定 regression corpus（fuzz 的 CI 对应物，见 fuzz/README.md）
// ---------------------------------------------------------------------------

/// 合成恶意/边界样本。每条都必须：进程退出码 0、stdout 恰好一份完整 JSON、
/// status ∈ 合法枚举。个别样本的精确期望在上面的专项测试里。
#[test]
fn regression_corpus_never_panics_and_always_valid_json() {
    let dir = TempDir::new("corpus");
    let mut corpus: Vec<(&str, Vec<u8>)> = Vec::new();

    corpus.push(("empty", Vec::new()));
    corpus.push(("random-bytes", (0u8..=255).collect()));
    corpus.push(("sav-only", b"SAV".to_vec()));
    corpus.push(("header-no-newline", b"SAV0100aabbccdd00000000".to_vec()));
    corpus.push(("nul-everywhere", vec![0u8; 4096]));
    corpus.push((
        "deep-nesting",
        unified_save(format!("x={}", "{".repeat(2000)).as_bytes()),
    ));
    corpus.push((
        "long-scalar",
        unified_save(format!("x={}", "a".repeat(100 * 1024)).as_bytes()),
    ));
    corpus.push((
        "dup-key-storm",
        unified_save(
            gamestate_blocks(
                &default_vars(1),
                &living_block(&char_entry("1001", &"\t\tmother=1002\n".repeat(2000))),
            )
            .as_bytes(),
        ),
    ));
    corpus.push((
        "unterminated-string",
        unified_save(b"meta_data={\n\tversion=\"1.13"),
    ));
    corpus.push((
        "invalid-utf8",
        unified_save(b"meta_data={\n\tversion=\"\xFF\xFE\"\n}"),
    ));
    corpus.push(("root-rbrace", unified_save(b"}")));
    corpus.push(("key-without-eq", unified_save(b"meta_data")));
    corpus.push(("escaped-backslash-eof", unified_save(b"x=\"abc\\")));
    // zip 变体：truncated / crc 损坏 / declared 超大。
    let gs = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gs.as_bytes(),
        declared_uncompressed: None,
    }]);
    corpus.push((
        "zip-truncated",
        build_prefixed_zip_save(2, b"", &zip[..zip.len() / 2]),
    ));
    corpus.push((
        "zip-declared-huge",
        build_prefixed_zip_save(
            2,
            b"",
            &build_zip(&[ZipEntrySpec {
                name: b"gamestate",
                data: b"tiny",
                declared_uncompressed: Some(600 * 1024 * 1024),
            }]),
        ),
    ));
    let mut zip_crc = zip.clone();
    let cd_pos = zip_crc.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    zip_crc[cd_pos + 16] ^= 0xFF;
    corpus.push(("zip-crc-bad", build_prefixed_zip_save(2, b"", &zip_crc)));

    for (name, bytes) in corpus {
        let path = write_file(dir.path(), &format!("{name}.ck3"), &bytes);
        for op in ["probe", "extract"] {
            let request = if op == "probe" {
                valid_request("probe")
            } else {
                extract_request(&["1001"], &["family", "realm"])
            };
            let args = if op == "probe" {
                probe_args(&path, dir.path())
            } else {
                extract_args(&path, dir.path())
            };
            let out = run_sidecar(&args, request.as_bytes());
            assert!(
                out.status.success(),
                "{name}/{op}: non-zero exit (stderr: {})",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(
                out.stdout.ends_with(b"}\n") && !out.stdout.ends_with(b"}\n\n"),
                "{name}/{op}: stdout must be one JSON doc with single newline"
            );
            let v: serde_json::Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1])
                .unwrap_or_else(|e| panic!("{name}/{op}: stdout is not complete JSON: {e}"));
            let status = v["status"].as_str().unwrap();
            assert!(
                ["ok", "partial", "unsupported", "invalid"].contains(&status),
                "{name}/{op}: illegal status {status}"
            );
        }
    }
}
