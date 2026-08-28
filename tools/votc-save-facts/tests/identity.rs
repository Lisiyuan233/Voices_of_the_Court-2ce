//! Identity 提取集成测试（实施计划 Task 3 步骤 4、6、7）。
//!
//! 覆盖：完整 identity（静态 fixture）、scale=1 / scale=1000 推导、
//! campaign 缺段、snapshot 变量缺失/缺段、sequence 非法（负数/余数）、
//! 日期非法、未知 CK3 version warning、缺玩家 ID 降级 partial、
//! cleared triple（protocol=0）、probe 提前停止、extract 重新校验后
//! 仍降级 unsupported。

mod common;

use common::*;

fn write_unified(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let meta_len = body.find("}\n").map(|i| i + 2).unwrap_or(body.len());
    let mut content = sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    write_file(dir, name, &content)
}

fn warning_codes(v: &serde_json::Value) -> Vec<&str> {
    v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["code"].as_str().unwrap())
        .collect()
}

#[test]
fn unified_fixture_extracts_full_identity() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_minimal.ck3"),
        &fixtures_dir(),
    );
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["sourceFormat"], "unified_text");
    assert_eq!(v["manifest"]["ck3Version"], "1.13.0");
    assert_eq!(v["manifest"]["factSchemaVersion"], 1);

    let id = &v["identity"];
    assert_eq!(id["playerCharacterId"], "1001");
    assert_eq!(id["gameDateNumeric"], 316_470);
    assert_eq!(id["gameDateDisplay"], "867.1.15");
    assert_eq!(
        id["campaignIdParts"],
        serde_json::json!([111, 222, 333, 444])
    );
    assert_eq!(id["snapshotSequence"], 17);
    assert_eq!(id["snapshotSlot"], 0);
    assert_eq!(id["scriptVariableScale"], 1000);

    // snapshotId：四要素齐全 → 64 位 hex 且稳定。
    let snapshot_id = v["manifest"]["snapshotId"].as_str().unwrap();
    assert_eq!(snapshot_id.len(), 64);
    assert!(snapshot_id.bytes().all(|b| b.is_ascii_hexdigit()));

    assert_eq!(v["warnings"], serde_json::json!([]));
    assert_eq!(v["entities"], serde_json::json!([]));
    assert_eq!(v["facts"], serde_json::json!([]));

    // probe 提前停止：living 块在 variables 之后，扫描字节 < 文件大小。
    let scanned = v["metrics"]["scannedBytes"].as_u64().unwrap();
    let input = v["metrics"]["inputBytes"].as_u64().unwrap();
    assert!(
        scanned < input,
        "expected early stop: scanned={scanned} input={input}"
    );
    assert!(v["metrics"].get("decompressedBytes").is_none());
}

#[test]
fn real_player_variable_fixture_extracts_snapshot_and_omitted_zero_slot() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_player_variables.ck3"),
        &fixtures_dir(),
    );

    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["ck3Version"], "1.19.2.3");
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(
        v["identity"]["campaignIdParts"],
        serde_json::json!([111, 222, 333, 444])
    );
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert_eq!(v["identity"]["snapshotSlot"], 0);
    assert_eq!(v["identity"]["scriptVariableScale"], 100_000);
    assert_eq!(v["warnings"], serde_json::json!([]));
}

#[test]
fn snapshot_id_is_stable_across_runs() {
    let fixture = fixtures_dir().join("unified_text_minimal.ck3");
    let (_o1, v1) = probe_json(&fixture, &fixtures_dir());
    let (_o2, v2) = probe_json(&fixture, &fixtures_dir());
    assert_eq!(v1["manifest"]["snapshotId"], v2["manifest"]["snapshotId"]);
    assert_eq!(
        v1["manifest"]["sourceFingerprint"],
        v2["manifest"]["sourceFingerprint"]
    );
}

#[test]
fn scale_one_decodes_plain_raw_values() {
    let dir = TempDir::new("scale-1");
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &default_vars(1));
    let path = write_unified(dir.path(), "scale1.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert_eq!(v["identity"]["scriptVariableScale"], 1);
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert_eq!(
        v["identity"]["campaignIdParts"],
        serde_json::json!([111, 222, 333, 444])
    );
}

#[test]
fn campaign_missing_part_drops_all_four_with_warning() {
    let dir = TempDir::new("camp-part");
    let vars = vec![
        ("votc_campaign_id_a", 111),
        ("votc_campaign_id_b", 222),
        ("votc_campaign_id_c", 333),
        ("votc_save_snapshot_protocol", 1),
        ("votc_save_snapshot_sequence", 17),
        ("votc_save_snapshot_slot", 0),
    ];
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &vars);
    let path = write_unified(dir.path(), "camp.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert!(v["identity"].get("campaignIdParts").is_none());
    assert!(warning_codes(&v).contains(&"CAMPAIGN_PARTS_MISSING"));
}

#[test]
fn all_votc_variables_missing_gives_warning_but_ok() {
    let dir = TempDir::new("vars-none");
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &[]);
    let path = write_unified(dir.path(), "plain.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert!(v["identity"].get("snapshotSequence").is_none());
    assert!(v["identity"].get("campaignIdParts").is_none());
    assert!(v["identity"].get("scriptVariableScale").is_none());
    assert!(warning_codes(&v).contains(&"VOTC_VARIABLES_MISSING"));
    // identity 不完整 → snapshotId 为空。
    assert_eq!(v["manifest"]["snapshotId"], "");
}

#[test]
fn snapshot_tail_partial_is_not_accepted() {
    let dir = TempDir::new("snap-part");
    let vars = vec![
        ("votc_save_snapshot_protocol", 1),
        ("votc_save_snapshot_sequence", 17),
        // slot 缺失：三项必须同时存在
    ];
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &vars);
    let path = write_unified(dir.path(), "snap.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert!(v["identity"].get("snapshotSequence").is_none());
    assert!(v["identity"].get("snapshotSlot").is_none());
    assert!(warning_codes(&v).contains(&"SNAPSHOT_PARTS_MISSING"));
}

#[test]
fn negative_sequence_is_invalid() {
    let dir = TempDir::new("seq-neg");
    let mut vars = default_vars(1000);
    vars[5] = ("votc_save_snapshot_sequence", -17000);
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &vars);
    let path = write_unified(dir.path(), "neg.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "invalid");
    assert_eq!(v["error"]["code"], "SAVE_PARSE_FAILED");
}

#[test]
fn fractional_sequence_is_invalid() {
    let dir = TempDir::new("seq-frac");
    let mut vars = default_vars(1000);
    vars[5] = ("votc_save_snapshot_sequence", 17500); // 17.5：拒绝余数
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &vars);
    let path = write_unified(dir.path(), "frac.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "invalid");
    assert_eq!(v["error"]["code"], "SAVE_PARSE_FAILED");
}

#[test]
fn invalid_date_is_invalid() {
    let dir = TempDir::new("date-bad");
    let body = gamestate_text("1.13.0", "1001", "867.13.40", &default_vars(1));
    let path = write_unified(dir.path(), "date.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "invalid");
    assert_eq!(v["error"]["code"], "SAVE_PARSE_FAILED");
}

#[test]
fn unknown_ck3_version_probes_with_warning() {
    let dir = TempDir::new("ver-unknown");
    let body = gamestate_text("99.0.0", "1001", "867.1.15", &default_vars(1));
    let path = write_unified(dir.path(), "ver.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert_eq!(v["manifest"]["ck3Version"], "99.0.0");
    assert!(warning_codes(&v).contains(&"CK3_VERSION_UNRECOGNIZED"));
    // 其余 identity 不受影响。
    assert_eq!(v["identity"]["snapshotSequence"], 17);
}

#[test]
fn missing_player_id_degrades_to_partial() {
    let dir = TempDir::new("no-player");
    let body = "meta_data={\n\tversion=\"1.13.0\"\n}\ndate=867.1.15\n".to_string();
    let path = write_unified(dir.path(), "np.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "partial");
    assert!(v["identity"].get("playerCharacterId").is_none());
    assert!(warning_codes(&v).contains(&"PLAYER_ID_MISSING"));
    assert_eq!(v["manifest"]["snapshotId"], "");
}

#[test]
fn cleared_snapshot_triple_reports_zero_and_undetermined_scale() {
    let dir = TempDir::new("cleared");
    let vars = vec![
        ("votc_save_snapshot_protocol", 0),
        ("votc_save_snapshot_sequence", 0),
        ("votc_save_snapshot_slot", 0),
    ];
    let body = gamestate_text("1.13.0", "1001", "867.1.15", &vars);
    let path = write_unified(dir.path(), "cleared.ck3", &body);

    let (_out, v) = probe_json(&path, dir.path());
    assert_eq!(v["status"], "ok");
    assert_eq!(v["identity"]["snapshotSequence"], 0);
    assert_eq!(v["identity"]["snapshotSlot"], 0);
    assert!(v["identity"].get("scriptVariableScale").is_none());
    assert!(warning_codes(&v).contains(&"SCALE_UNDETERMINED"));
}

#[test]
fn extract_revalidates_identity_within_same_invocation() {
    let fixture = fixtures_dir().join("unified_text_minimal.ck3");
    let out = run_sidecar(
        &extract_args(&fixture, &fixtures_dir()),
        valid_request("extract").as_bytes(),
    );
    assert!(out.status.success());
    let v =
        serde_json::from_slice::<serde_json::Value>(&out.stdout[..out.stdout.len() - 1]).unwrap();
    assert_eq!(v["operation"], "extract");
    // Task 4 起：extract 在同一调用内重跑 identity 并产出实体/事实
    // （fixture 的 living 块不含 participant 1002，只有占位 ID 实体 +
    // PARTICIPANT_NOT_FOUND warning）。
    assert_eq!(v["status"], "ok");
    assert!(v.get("error").is_none());
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert_eq!(v["manifest"]["ck3Version"], "1.13.0");
    assert_eq!(v["facts"], serde_json::json!([]));
    assert_eq!(
        v["entities"],
        serde_json::json!([{ "type": "character", "id": "1002" }])
    );
    assert!(
        warning_codes(&v).contains(&"PARTICIPANT_NOT_FOUND"),
        "warnings: {}",
        v["warnings"]
    );
}

#[test]
fn join_candidates_fixture_extracts_ordered_decimal_ids() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_join_candidates_minimal.ck3"),
        &fixtures_dir(),
    );
    assert_eq!(v["status"], "ok");
    assert_eq!(v["joinCandidates"], serde_json::json!(["13206", "33435"]));
    assert_eq!(v["facts"], serde_json::json!([]));
    assert_eq!(v["entities"], serde_json::json!([]));
}

#[test]
fn old_save_without_join_candidates_list_omits_the_field() {
    let (_out, v) = probe_json(
        &fixtures_dir().join("unified_text_minimal.ck3"),
        &fixtures_dir(),
    );
    assert_eq!(v["status"], "ok");
    assert!(v.get("joinCandidates").is_none());
}
