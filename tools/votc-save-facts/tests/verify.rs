//! P1-A protocol-v2 typed verification integration tests.

#[path = "common/mod.rs"]
mod common;

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn verify_args(input: &Path, root: &Path) -> Vec<String> {
    vec![
        "verify".into(),
        "--input".into(),
        common::s(input),
        "--allowed-root".into(),
        common::s(root),
        "--max-output-bytes".into(),
        "262144".into(),
    ]
}

fn verification_body(extra: &str) -> String {
    common::gamestate_blocks(&common::default_vars(1000), extra)
}

fn write_body(dir: &common::TempDir, name: &str, body: &str) -> PathBuf {
    let meta_len = body
        .find("}\n")
        .map(|index| index + 2)
        .unwrap_or(body.len());
    let mut content = common::sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    common::write_file(dir.path(), name, &content)
}

fn fingerprint(input: &Path, root: &Path) -> String {
    let (_, probe) = common::probe_json(input, root);
    assert_eq!(probe["status"], "ok", "probe response: {probe}");
    probe["manifest"]["sourceFingerprint"]
        .as_str()
        .unwrap()
        .to_string()
}

fn request(source_fingerprint: &str, checks: Value) -> Value {
    serde_json::json!({
        "protocolVersion": 2,
        "operation": "verify",
        "expected": {
            "playerCharacterId": "1001",
            "participantCharacterIds": ["1001", "1002"],
            "gameDateNumeric": 316470,
            "campaignId": "test-campaign",
            "campaignIdParts": [111, 222, 333, 444],
            "snapshotSequence": 17,
            "snapshotSlot": 0,
            "sourceFingerprint": source_fingerprint
        },
        "checks": checks,
        "limits": {
            "maxChecks": 64,
            "maxCharacters": 32,
            "maxOutputBytes": 262144,
            "maxDecompressedBytes": 67108864,
            "maxNestingDepth": 128,
            "maxScalarBytes": 65536
        }
    })
}

fn run_verify(input: &Path, root: &Path, request: &Value) -> (std::process::Output, Value) {
    let out = common::run_sidecar(&verify_args(input, root), request.to_string().as_bytes());
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout[..out.stdout.len() - 1]).unwrap();
    (out, value)
}

fn result<'a>(response: &'a Value, check_id: &str) -> &'a Value {
    response["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["checkId"] == check_id)
        .unwrap_or_else(|| panic!("missing result {check_id} in response {response}"))
}

fn rich_character_save(dir: &common::TempDir) -> PathBuf {
    let living = common::living_block(&format!(
        "{}{}",
        common::char_entry("1001", "\t\talive_data={}\n"),
        common::char_entry(
            "1002",
            concat!(
                "\t\ttraits={ 17 21 }\n",
                "\t\tskill={ 10 12 8 7 6 9 }\n",
                "\t\talive_data={ gold=42.500 }\n",
                "\t\tcourt_data={ council_position=chancellor court_position=physician }\n",
                "\t\tcommander=yes\n"
            ),
        )
    ));
    let dead = format!(
        "dead_unprunable={{\n{}}}\n",
        common::char_entry("1003", "\t\ttraits={ 9 }\n\t\tskill={ 1 2 3 4 5 6 }\n")
    );
    let missing_fields = common::living_block(&common::char_entry("1004", "\t\talive_data={}\n"));
    write_body(
        dir,
        "verify-rich.ck3",
        &verification_body(&format!("{living}{dead}{missing_fields}")),
    )
}

#[test]
fn verify_evaluates_closed_allowlist_with_known_true_and_false() {
    let dir = common::TempDir::new("verify-known");
    let input = rich_character_save(&dir);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "life", "kind": "character_life_state", "characterId": "1002" },
        { "checkId": "trait_true", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 },
        { "checkId": "trait_false", "kind": "character_has_trait", "characterId": "1002", "traitId": 99 },
        { "checkId": "skill_true", "kind": "character_skill_at_least", "characterId": "1002", "skill": "martial", "value": 12 },
        { "checkId": "skill_false", "kind": "character_skill_at_least", "characterId": "1002", "skill": "learning", "value": 7 },
        { "checkId": "council_true", "kind": "character_has_council_position", "characterId": "1002", "position": "chancellor" },
        { "checkId": "council_false", "kind": "character_has_council_position", "characterId": "1002", "position": "marshal" },
        { "checkId": "court_false", "kind": "character_has_court_position", "characterId": "1002", "position": "bodyguard" },
        { "checkId": "commander", "kind": "character_is_commander", "characterId": "1002" },
        { "checkId": "gold_true", "kind": "character_gold_at_least", "characterId": "1002", "value": 42 },
        { "checkId": "gold_false", "kind": "character_gold_at_least", "characterId": "1002", "value": 43 }
    ]);
    let (_, response) = run_verify(&input, dir.path(), &request(&source_fingerprint, checks));

    assert_eq!(response["protocolVersion"], 2);
    assert_eq!(response["operation"], "verify");
    assert_eq!(response["status"], "ok");
    assert_eq!(
        response["manifest"]["sourceFingerprint"],
        source_fingerprint
    );
    assert_eq!(response["identity"]["playerCharacterId"], "1001");
    assert_eq!(response["metrics"]["checkedCount"], 11);
    assert_eq!(result(&response, "life")["lifeState"], "living");
    for id in [
        "trait_true",
        "skill_true",
        "council_true",
        "commander",
        "gold_true",
    ] {
        assert_eq!(result(&response, id)["value"], true, "result {id}");
    }
    for id in [
        "trait_false",
        "skill_false",
        "council_false",
        "court_false",
        "gold_false",
    ] {
        assert_eq!(result(&response, id)["value"], false, "result {id}");
    }
}

#[test]
fn verify_parses_block_form_gold_from_real_119_saves() {
    // 回归：真实 1.19 存档把 alive_data.gold 序列化为 { value=<decimal> } 块
    // 且可为负（负债）；此前按标量解析，整个角色扫描以 PARTIAL_PARSE 失败。
    let dir = common::TempDir::new("verify-gold-block");
    let living = common::living_block(&format!(
        "{}{}{}",
        common::char_entry("1001", "\t\talive_data={}\n"),
        common::char_entry(
            "1002",
            concat!(
                "\t\tskill={ 7 4 10 5 5 1 }\n",
                "\t\talive_data={ gold={ value=8334.96735 } }\n",
            ),
        ),
        common::char_entry("1003", "\t\talive_data={ gold={ value=-37.8125 } }\n"),
    ));
    let input = write_body(&dir, "verify-gold-block.ck3", &verification_body(&living));
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "life", "kind": "character_life_state", "characterId": "1002" },
        { "checkId": "skill", "kind": "character_skill_at_least", "characterId": "1002", "skill": "diplomacy", "value": 1 },
        { "checkId": "gold_true", "kind": "character_gold_at_least", "characterId": "1002", "value": 0 },
        { "checkId": "gold_false", "kind": "character_gold_at_least", "characterId": "1002", "value": 8335 },
        { "checkId": "gold_negative", "kind": "character_gold_at_least", "characterId": "1003", "value": 0 }
    ]);
    let (_, response) = run_verify(&input, dir.path(), &request(&source_fingerprint, checks));

    assert_eq!(response["status"], "ok", "response: {response}");
    assert_eq!(result(&response, "life")["lifeState"], "living");
    assert_eq!(result(&response, "skill")["value"], true);
    assert_eq!(result(&response, "gold_true")["value"], true);
    assert_eq!(result(&response, "gold_false")["value"], false);
    assert_eq!(result(&response, "gold_negative")["value"], false);
}

#[test]
fn verify_distinguishes_dead_not_found_and_missing_field() {
    let dir = common::TempDir::new("verify-unknowns");
    let input = rich_character_save(&dir);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "dead", "kind": "character_life_state", "characterId": "1003" },
        { "checkId": "missing", "kind": "character_life_state", "characterId": "9999" },
        { "checkId": "field", "kind": "character_has_trait", "characterId": "1004", "traitId": 17 }
    ]);
    let (_, response) = run_verify(&input, dir.path(), &request(&source_fingerprint, checks));

    assert_eq!(response["status"], "partial");
    assert_eq!(result(&response, "dead")["status"], "known");
    assert_eq!(result(&response, "dead")["lifeState"], "dead");
    assert_eq!(
        result(&response, "missing")["reasonCode"],
        "CHARACTER_NOT_FOUND"
    );
    assert_eq!(
        result(&response, "field")["reasonCode"],
        "FIELD_NOT_AVAILABLE"
    );
}

#[test]
fn verify_rejects_replaced_snapshot_and_identity_mismatch() {
    let dir = common::TempDir::new("verify-mismatch");
    let input = rich_character_save(&dir);
    let old_fingerprint = fingerprint(&input, dir.path());

    let replacement = verification_body(&common::living_block(&common::char_entry(
        "1002",
        "\t\ttraits={ 17 }\n\t\talive_data={}\n",
    )));
    let replacement_path = write_body(&dir, "replacement.ck3", &replacement);
    fs::copy(replacement_path, &input).unwrap();
    let checks = serde_json::json!([
        { "checkId": "life", "kind": "character_life_state", "characterId": "1002" }
    ]);
    let (_, response) = run_verify(
        &input,
        dir.path(),
        &request(&old_fingerprint, checks.clone()),
    );
    assert_eq!(response["status"], "invalid");
    assert_eq!(response["error"]["code"], "SAVE_IDENTITY_MISMATCH");
    assert_eq!(response["results"], serde_json::json!([]));

    let current_fingerprint = fingerprint(&input, dir.path());
    let mut identity_mismatch = request(&current_fingerprint, checks);
    identity_mismatch["expected"]["snapshotSequence"] = Value::from(18);
    let (_, response) = run_verify(&input, dir.path(), &identity_mismatch);
    assert_eq!(response["status"], "invalid");
    assert_eq!(response["error"]["code"], "SAVE_SEQUENCE_MISMATCH");
}

#[test]
fn verify_supports_crc_checked_zip_text_snapshot() {
    let dir = common::TempDir::new("verify-zip");
    let body = verification_body(&common::living_block(&common::char_entry(
        "1002",
        "\t\ttraits={ 17 }\n\t\talive_data={}\n",
    )));
    let zip = common::build_zip(&[common::ZipEntrySpec {
        name: b"gamestate",
        data: body.as_bytes(),
        declared_uncompressed: None,
    }]);
    let save = common::build_prefixed_zip_save(2, b"meta_data={}\n", &zip);
    let input = common::write_file(dir.path(), "verify.zip.ck3", &save);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "trait", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 }
    ]);
    let (_, response) = run_verify(&input, dir.path(), &request(&source_fingerprint, checks));
    assert_eq!(response["status"], "ok");
    assert_eq!(response["manifest"]["sourceFormat"], "zip_text");
    assert_eq!(result(&response, "trait")["value"], true);
}

#[test]
fn verify_rejects_arbitrary_field_path_and_unknown_wire_fields() {
    let dir = common::TempDir::new("verify-invalid");
    let input = rich_character_save(&dir);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "life", "kind": "character_life_state", "characterId": "1002" }
    ]);
    let mut invalid = request(&source_fingerprint, checks);
    invalid["checks"][0]["fieldPath"] = Value::String("living".into());
    let (_, response) = run_verify(&input, dir.path(), &invalid);
    assert_eq!(response["status"], "invalid");
    assert_eq!(response["error"]["code"], "REQUEST_INVALID");
}

#[test]
fn invalid_verify_request_is_rejected_before_save_path_io() {
    let dir = common::TempDir::new("verify-invalid-no-io");
    let missing_input = dir.path().join("must-not-be-opened.ck3");
    let checks = serde_json::json!([
        { "checkId": "life", "kind": "character_life_state", "characterId": "1002", "fieldPath": "living" }
    ]);
    let invalid = request(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        checks,
    );
    let (_, response) = run_verify(&missing_input, dir.path(), &invalid);
    assert_eq!(response["status"], "invalid");
    assert_eq!(response["error"]["code"], "REQUEST_INVALID");
}

#[test]
fn unrecognized_save_version_never_guesses_known_values() {
    let dir = common::TempDir::new("verify-version");
    let body = verification_body(&common::living_block(&common::char_entry(
        "1002",
        "\t\ttraits={ 17 }\n\t\talive_data={}\n",
    )))
    .replace("version=\"1.13.0\"", "version=\"9.99.0\"");
    let input = write_body(&dir, "unknown-version.ck3", &body);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "trait", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 }
    ]);
    let (_, response) = run_verify(&input, dir.path(), &request(&source_fingerprint, checks));
    assert_eq!(response["status"], "partial");
    assert_eq!(
        result(&response, "trait")["reasonCode"],
        "SAVE_VERSION_UNSUPPORTED"
    );
}

#[test]
fn verify_rejects_duplicate_ids_non_decimal_ids_and_limit_escalation() {
    let dir = common::TempDir::new("verify-limits");
    let input = rich_character_save(&dir);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "c1", "kind": "character_life_state", "characterId": "1002" },
        { "checkId": "c2", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 }
    ]);

    let mut duplicate = request(&source_fingerprint, checks.clone());
    duplicate["checks"][1]["checkId"] = Value::String("c1".into());
    let (_, response) = run_verify(&input, dir.path(), &duplicate);
    assert_eq!(response["status"], "invalid");

    let mut arbitrary_id = request(&source_fingerprint, checks.clone());
    arbitrary_id["checks"][0]["characterId"] = Value::String("char.a".into());
    let (_, response) = run_verify(&input, dir.path(), &arbitrary_id);
    assert_eq!(response["status"], "invalid");

    let mut escalated = request(&source_fingerprint, checks);
    escalated["limits"]["maxChecks"] = Value::from(65);
    let (_, response) = run_verify(&input, dir.path(), &escalated);
    assert_eq!(response["status"], "invalid");
}

#[test]
fn verify_enforces_decompressed_nesting_scalar_and_output_limits() {
    let dir = common::TempDir::new("verify-resource-limits");
    let deeply_nested = format!(
        "{}{}{}",
        "unknown={".repeat(140),
        " value=1 ",
        "}".repeat(140)
    );
    let body = verification_body(&format!(
        "{}{}",
        common::living_block(&common::char_entry(
            "1002",
            &format!("\t\ttraits={{ 17 }}\n\t\t{deeply_nested}\n")
        )),
        "tail={}\n"
    ));
    let input = write_body(&dir, "limits.ck3", &body);
    let source_fingerprint = fingerprint(&input, dir.path());
    let checks = serde_json::json!([
        { "checkId": "trait", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 }
    ]);

    let mut nested = request(&source_fingerprint, checks.clone());
    nested["limits"]["maxNestingDepth"] = Value::from(64);
    let (_, response) = run_verify(&input, dir.path(), &nested);
    assert_eq!(response["status"], "partial");
    assert_eq!(result(&response, "trait")["reasonCode"], "LIMIT_EXCEEDED");

    let scalar_body = verification_body(&common::living_block(&common::char_entry(
        "1002",
        &format!("\t\tunknown={}\n", "x".repeat(80)),
    )));
    let scalar_input = write_body(&dir, "scalar.ck3", &scalar_body);
    let scalar_fingerprint = fingerprint(&scalar_input, dir.path());
    let mut scalar = request(&scalar_fingerprint, checks.clone());
    scalar["limits"]["maxScalarBytes"] = Value::from(64);
    let (_, response) = run_verify(&scalar_input, dir.path(), &scalar);
    assert_eq!(response["status"], "partial");
    assert_eq!(result(&response, "trait")["reasonCode"], "LIMIT_EXCEEDED");

    let mut decompressed = request(&scalar_fingerprint, checks.clone());
    decompressed["limits"]["maxDecompressedBytes"] = Value::from(128);
    let (_, response) = run_verify(&scalar_input, dir.path(), &decompressed);
    assert_eq!(response["status"], "invalid");
    assert_eq!(response["error"]["code"], "SAVE_LIMIT_EXCEEDED");

    let mut output_limited = request(&scalar_fingerprint, checks);
    output_limited["limits"]["maxOutputBytes"] = Value::from(64);
    let out = common::run_sidecar(
        &verify_args(&scalar_input, dir.path()),
        output_limited.to_string().as_bytes(),
    );
    assert!(!out.status.success());
    assert!(
        out.stdout.is_empty(),
        "a truncated JSON document must never escape"
    );
}
