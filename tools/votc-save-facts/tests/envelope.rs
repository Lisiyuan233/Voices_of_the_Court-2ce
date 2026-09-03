//! Envelope 识别集成测试（实施计划 Task 3 步骤 1-3、7）。
//!
//! 覆盖：unified text、prefixed ZIP text、ZIP local header 不在 offset 0、
//! missing gamestate、duplicate gamestate、zip-slip 名称、truncated ZIP、
//! truncated text、binary marker（unified/zip binary 降级）、
//! declared 超大 uncompressed size、非 SAV 与未知 header kind。

mod common;

use common::*;

fn expect_error_code(v: &serde_json::Value, status: &str, code: &str) {
    assert_eq!(v["status"], status, "unexpected status: {v}");
    assert_eq!(v["error"]["code"], code, "unexpected error code: {v}");
}

#[test]
fn unified_text_fixture_maps_to_unified_text() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_minimal.ck3"),
        &fixtures_dir(),
    );
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_text");
    assert!(v.get("error").is_none());
}

#[test]
fn prefixed_zip_text_maps_to_zip_text() {
    let dir = TempDir::new("zip-text");
    let gamestate = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1000));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gamestate.as_bytes(),
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(2, b"meta_data={ inlined }\n", &zip);
    let path = write_file(dir.path(), "prefixed_zip_text_minimal.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["sourceFormat"], "zip_text");
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert!(v["metrics"]["decompressedBytes"].is_number());
    assert!(v["metrics"]["scannedBytes"].is_number());
}

#[test]
fn zip_local_header_far_from_offset_zero_still_located() {
    // local header 不在 offset 0：大段 inline 前缀 + ZIP，central directory
    // 偏移需要按前缀修正。
    let dir = TempDir::new("zip-offset");
    let gamestate = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1000));
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: gamestate.as_bytes(),
        declared_uncompressed: None,
    }]);
    let prefix = vec![b'x'; 4096];
    let save = build_prefixed_zip_save(2, &prefix, &zip);
    let path = write_file(dir.path(), "offset.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["sourceFormat"], "zip_text");
    assert_eq!(v["identity"]["snapshotSequence"], 17);
}

#[test]
fn zip_with_garbage_binary_gamestate_is_rejected_by_melt_gate() {
    // 语义变化（binary melt 接入后）：binary 不再是「识别即 unsupported」，
    // 而是版本门禁 → melt。垃圾二进制内容在门禁阶段判损坏，绝不能误解析。
    let dir = TempDir::new("zip-binary");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: b"\x00\x01\x02binary-gamestate",
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(3, b"", &zip); // kind 3 = UnifiedBinary
    let path = write_file(dir.path(), "zip_binary.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_PARSE_FAILED");
    assert_eq!(v["manifest"]["sourceFormat"], "zip_binary");
    assert!(v.get("identity").is_none());
}

#[test]
fn binary_marker_fixture_is_rejected_by_melt_gate() {
    // 同上：SAV0101 + 垃圾二进制内容 → melt 门禁损坏，不误解析。
    let (_out, v) = probe_json(
        &fixtures_dir().join("binary_marker_minimal.ck3"),
        &fixtures_dir(),
    );
    expect_error_code(&v, "invalid", "SAVE_PARSE_FAILED");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_binary");
    assert!(v.get("identity").is_none());
}

#[test]
fn truncated_zip_is_save_truncated_not_unified_text() {
    // header 声称 UnifiedText（ZIP），但 central directory 缺失：
    // 必须判截断，绝不能退回按纯文本解析 ZIP 字节。
    let dir = TempDir::new("zip-trunc");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: b"meta_data={}\n",
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(2, b"", &zip[..zip.len() / 2]); // 砍掉含 EOCD 的尾部
    let path = write_file(dir.path(), "truncated_zip.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_TRUNCATED");
}

#[test]
fn truncated_text_fixture_is_save_truncated() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("truncated_minimal.ck3"),
        &fixtures_dir(),
    );
    expect_error_code(&v, "invalid", "SAVE_TRUNCATED");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_text");
}

#[test]
fn missing_gamestate_entry_is_save_entry_missing() {
    let dir = TempDir::new("zip-no-gs");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"meta",
        data: b"meta_data={}\n",
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "missing.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_ENTRY_MISSING");
}

#[test]
fn duplicate_gamestate_entries_are_rejected() {
    let dir = TempDir::new("zip-dup-gs");
    let zip = build_zip(&[
        ZipEntrySpec {
            name: b"gamestate",
            data: b"meta_data={}\n",
            declared_uncompressed: None,
        },
        ZipEntrySpec {
            name: b"gamestate",
            data: b"meta_data={ }\n",
            declared_uncompressed: None,
        },
    ]);
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "dup.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_PARSE_FAILED");
}

#[test]
fn zip_slip_style_entry_name_is_not_accepted() {
    let dir = TempDir::new("zip-slip");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"../gamestate",
        data: b"meta_data={}\n",
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "slip.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_ENTRY_MISSING");
}

#[test]
fn declared_oversized_uncompressed_hint_is_rejected_early() {
    let dir = TempDir::new("zip-bomb");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: b"tiny",
        declared_uncompressed: Some(600 * 1024 * 1024), // 宣称 600 MiB > 512 MiB 硬上限
    }]);
    let save = build_prefixed_zip_save(2, b"", &zip);
    let path = write_file(dir.path(), "bomb.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "invalid", "SAVE_LIMIT_EXCEEDED");
}

#[test]
fn non_sav_file_is_envelope_unknown() {
    let dir = TempDir::new("non-sav");
    let path = write_file(dir.path(), "plain.ck3", b"PK\x03\x04 not really a save\n");

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "unsupported", "SAVE_ENVELOPE_UNKNOWN");
    assert_eq!(v["manifest"]["sourceFormat"], "unknown");
}

#[test]
fn unknown_header_kind_is_envelope_unknown() {
    let dir = TempDir::new("unknown-kind");
    let mut save = sav_header_line(0x99, 0); // kind Other(0x99)
    save.extend_from_slice(b"meta_data={}\n");
    let path = write_file(dir.path(), "unknown.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    expect_error_code(&v, "unsupported", "SAVE_ENVELOPE_UNKNOWN");
    assert_eq!(v["manifest"]["sourceFormat"], "unknown");
}
