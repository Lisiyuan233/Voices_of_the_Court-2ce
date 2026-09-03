//! 二进制（非 debug）存档 melt 接入的集成测试。
//!
//! 用 jomini `binary::Token::write` 手工构造微型二进制 gamestate（与
//! token-resolver-builder 测试同模式），token id 取自
//! `tools/token-resolver-builder/out/ck3_tokens_1_19_0_6.rs`（1.19.0.6 表）。
//! 覆盖：unified/zip binary 的 probe/extract 全路径、版本门禁（篡改
//! version）、未解析 token 降级 warning。

mod common;

use common::*;

use jomini::Scalar;
use jomini::binary::Token;

// token id（1.19.0.6 表，见 builder 产物）
const T_META_DATA: u16 = 0x3155;
const T_VERSION: u16 = 0x00ee;
const T_DATE: u16 = 0x06b5;
const T_PLAYED_CHARACTER: u16 = 0x27eb;
const T_CHARACTER: u16 = 0x06ec;
const T_PLAYER: u16 = 0x274a;
const T_VARIABLES: u16 = 0x0555;
const T_DATA: u16 = 0x00f0;
const T_FLAG: u16 = 0x0384;
const T_TYPE: u16 = 0x00e1;
const T_VALUE: u16 = 0x02d2;
const T_SIZE: u16 = 0x002f;

/// 867.1.15 的二进制小时计数：((867+5000)*365 + 14)*24。
const DATE_867_1_15_HOURS: i32 = 51_395_256;

fn bin(tokens: &[Token]) -> Vec<u8> {
    let mut v = Vec::new();
    for t in tokens {
        t.write(&mut v).unwrap();
    }
    v
}

/// 与 `gamestate_text` 等价的最小二进制 gamestate（root 变量旧布局，
/// scale=1000，player 1001，date 867.1.15）。
fn binary_gamestate(version: &str) -> Vec<u8> {
    let vars: [(&str, i32); 7] = [
        ("votc_campaign_id_a", 111_000),
        ("votc_campaign_id_b", 222_000),
        ("votc_campaign_id_c", 333_000),
        ("votc_campaign_id_d", 444_000),
        ("votc_save_snapshot_protocol", 1_000),
        ("votc_save_snapshot_sequence", 17_000),
        ("votc_save_snapshot_slot", 0),
    ];
    let mut t = vec![
        Token::Id(T_META_DATA),
        Token::Equal,
        Token::Open,
        Token::Id(T_VERSION),
        Token::Equal,
        Token::Quoted(Scalar::new(version.as_bytes())),
        Token::Close,
        Token::Id(T_PLAYED_CHARACTER),
        Token::Equal,
        Token::Open,
        Token::Id(T_CHARACTER),
        Token::Equal,
        Token::U32(1001),
        Token::Id(T_PLAYER),
        Token::Equal,
        Token::Bool(true),
        Token::Close,
        Token::Id(T_DATE),
        Token::Equal,
        Token::I32(DATE_867_1_15_HOURS),
        Token::Id(T_VARIABLES),
        Token::Equal,
        Token::Open,
        Token::Id(T_DATA),
        Token::Equal,
        Token::Open,
    ];
    for (flag, raw) in vars {
        t.extend([
            Token::Open,
            Token::Id(T_FLAG),
            Token::Equal,
            Token::Quoted(Scalar::new(flag.as_bytes())),
            Token::Id(T_DATA),
            Token::Equal,
            Token::Open,
            Token::Id(T_TYPE),
            Token::Equal,
            Token::Unquoted(Scalar::new(b"integer")),
            Token::Id(T_VALUE),
            Token::Equal,
            Token::I32(raw),
            Token::Close,
            Token::Close,
        ]);
    }
    t.extend([
        Token::Close, // variables.data
        Token::Id(T_SIZE),
        Token::Equal,
        Token::U32(7),
        Token::Close, // variables
    ]);
    bin(&t)
}

fn write_unified_binary(dir: &TempDir, name: &str, gamestate: &[u8]) -> std::path::PathBuf {
    let mut save = sav_header_line(1, 0); // kind 1 = binary, meta_len 0
    save.extend_from_slice(gamestate);
    write_file(dir.path(), name, &save)
}

#[test]
fn unified_binary_probe_matches_text_identity() {
    let dir = TempDir::new("melt-unified");
    let path = write_unified_binary(&dir, "unified_binary_minimal.ck3", &binary_gamestate("1.19.0.6"));

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok", "unexpected response: {v}");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_binary");
    assert_eq!(v["manifest"]["ck3Version"], "1.19.0.6");
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(v["identity"]["gameDateNumeric"], 316_470);
    assert_eq!(v["identity"]["gameDateDisplay"], "867.1.15");
    assert_eq!(v["identity"]["campaignIdParts"], serde_json::json!([111, 222, 333, 444]));
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert_eq!(v["identity"]["snapshotSlot"], 0);
    assert_eq!(v["identity"]["scriptVariableScale"], 1000);
    assert!(v["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn zip_binary_probe_and_extract_work() {
    let dir = TempDir::new("melt-zip");
    let zip = build_zip(&[ZipEntrySpec {
        name: b"gamestate",
        data: &binary_gamestate("1.19.0.6"),
        declared_uncompressed: None,
    }]);
    let save = build_prefixed_zip_save(3, b"", &zip); // kind 3 = UnifiedBinary
    let path = write_file(dir.path(), "zip_binary.ck3", &save);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok", "unexpected response: {v}");
    assert_eq!(v["manifest"]["sourceFormat"], "zip_binary");
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(v["identity"]["gameDateNumeric"], 316_470);

    let v = extract_json(&path, dir.path(), &extract_request(&["1001"], &["identity"]));
    assert_eq!(v["status"], "ok", "unexpected extract response: {v}");
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    // 最小 gamestate 无 living 块：participant 缺席属预期（与等价明文
    // fixture 行为一致），其余 warning 不应出现。
    assert_eq!(
        warning_codes_of(&v),
        vec!["PARTICIPANT_NOT_FOUND".to_string()],
        "unexpected extract warnings: {v}"
    );
}

#[test]
fn version_mismatch_is_rejected_by_gate() {
    let dir = TempDir::new("melt-gate");
    let path = write_unified_binary(&dir, "wrong_version.ck3", &binary_gamestate("1.18.0.0"));

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "unsupported", "unexpected response: {v}");
    assert_eq!(v["error"]["code"], "SAVE_TOKEN_VERSION_MISMATCH");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_binary");
    assert!(v.get("identity").is_none());
}

#[test]
fn unresolved_token_degrades_with_warning_not_failure() {
    let dir = TempDir::new("melt-unresolved");
    let mut tokens_gamestate = binary_gamestate("1.19.0.6");
    // 追加一个未解析 token 字段（0xffff 不在 1.19.0.6 表内）。
    for t in [
        Token::Id(0xffff),
        Token::Equal,
        Token::I32(30),
    ] {
        t.write(&mut tokens_gamestate).unwrap();
    }
    let path = write_unified_binary(&dir, "unresolved.ck3", &tokens_gamestate);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok", "unexpected response: {v}");
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert!(
        warning_codes_of(&v).contains(&"TOKENS_PARTIALLY_UNRESOLVED".to_string()),
        "expected TOKENS_PARTIALLY_UNRESOLVED warning: {v}"
    );
}

#[test]
fn text_fixture_is_not_affected_by_version_gate() {
    // 明文存档不受二进制版本门禁影响（旧版本号仍走 warning 而非拒绝）。
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_minimal.ck3"),
        &fixtures_dir(),
    );
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_text");
}
