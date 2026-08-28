//! family predicate 集成测试（实施计划 Task 4 步骤 8）。
//!
//! 覆盖：正常 spouse/parent/child、引用实体缺失、dead reference、重复 key、
//! unknown mod fields、literal name、hidden father 不输出、secrets/schemes
//! 块零输出、一跳邻域、source path/provenance、稳定 fact ID、上限 partial、
//! 排序、category 过滤。

mod common;

use common::*;

/// 标准 family fixture：participant=1001，含反向 child、hidden father、
/// 埋入的 secrets/schemes/wars 数据。
fn family_body() -> String {
    let living = living_block(&[
        char_entry(
            "1001",
            "\t\tfirst_name=\"Placeholder Alpha\"\n\t\tmother=1002\n\t\tfather=1003\n\t\tspouse=1004\n\t\treal_father=9001\n\t\tsome_mod_block={\n\t\t\tnested={\n\t\t\t\tsecret=1\n\t\t\t}\n\t\t}\n",
        ),
        char_entry("1002", "\t\tfirst_name=\"Placeholder Mother\"\n\t\tspouse=1003\n"),
        char_entry("1004", "\t\tfirst_name=\"Placeholder Spouse\"\n\t\tspouse=1001\n"),
        char_entry("1006", "\t\tfirst_name=\"Placeholder Child\"\n\t\tmother=1001\n"),
        char_entry("1007", "\t\tfirst_name=\"Placeholder Unrelated\"\n\t\tmother=1008\n"),
        char_entry("9001", "\t\tfirst_name=\"Placeholder Hidden\"\n"),
    ]
    .concat());
    let secrets = "secrets={\n\t1={\n\t\tsecret_type=\"murder_secret\"\n\t\tsecret_owner=1001\n\t\tsecret_target=1004\n\t}\n}\n";
    let schemes =
        "schemes={\n\t2={\n\t\tscheme_type=\"murder\"\n\t\tscheme_owner=1001\n\t\ttarget=1004\n\t}\n}\n";
    let wars = "wars={\n\t3={\n\t\tname=\"Placeholder War\"\n\t}\n}\n";
    gamestate_blocks(&default_vars(1), &(living + secrets + schemes + wars))
}

#[test]
fn full_family_extraction() {
    let dir = TempDir::new("fam-full");
    let v = extract_on_body(
        &dir,
        "family.ck3",
        &family_body(),
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok", "unexpected: {v}");

    // 7 条 family 事实：parent/child 各两条正向 + spouse 一条 + 反向一对。
    let facts = v["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 7, "facts: {facts:?}");

    let parents = facts_with(&v, "character.parent");
    assert_eq!(parents.len(), 3);
    // 正向：participant 的父母。
    assert!(parents.iter().any(|f| f["subject"]["id"] == "1001"
        && f["object"]["id"] == "1002"
        && f["sourcePath"] == "character_mother"
        && f["confidence"] == "exact"));
    assert!(parents.iter().any(|f| f["subject"]["id"] == "1001"
        && f["object"]["id"] == "1003"
        && f["sourcePath"] == "character_father"));
    // 反向：非 participant 的 mother 指向 participant。
    assert!(parents
        .iter()
        .any(|f| f["subject"]["id"] == "1006" && f["object"]["id"] == "1001"));

    // derived child：与 parent 共享 source evidence，confidence mapped。
    let children = facts_with(&v, "character.child");
    assert_eq!(children.len(), 3);
    assert!(children.iter().any(|f| f["subject"]["id"] == "1002"
        && f["object"]["id"] == "1001"
        && f["sourcePath"] == "character_mother"
        && f["confidence"] == "mapped"));
    assert!(children.iter().any(|f| f["subject"]["id"] == "1001"
        && f["object"]["id"] == "1006"
        && f["confidence"] == "mapped"));

    // spouse：双向声明只输出一次 canonical pair（较小 ID 为 subject）。
    let spouses = facts_with(&v, "character.spouse");
    assert_eq!(spouses.len(), 1);
    assert_eq!(spouses[0]["subject"]["id"], "1001");
    assert_eq!(spouses[0]["object"]["id"], "1004");
    assert_eq!(spouses[0]["sourcePath"], "character_spouse");
    assert_eq!(spouses[0]["visibility"], "public");
    assert_eq!(spouses[0]["sensitivity"], "personal");

    // 通用字段：source/asOf/provenance。
    for f in facts {
        assert_eq!(f["source"], "save_snapshot");
        assert_eq!(f["category"], "family");
        assert_eq!(f["asOfGameDate"]["numeric"], 316_470);
        assert_eq!(f["asOfGameDate"]["display"], "867.1.15");
        assert_eq!(f["provenance"]["snapshotSequence"], 17);
        assert_eq!(f["provenance"]["campaignId"], "111.222.333.444");
        assert_eq!(f["provenance"]["snapshotId"], v["manifest"]["snapshotId"]);
        assert_eq!(f["id"].as_str().unwrap().len(), 32);
    }

    // 实体：participant + 4 个 related，literal 名按 candidate 输出。
    let chars = entity_ids(&v, "character");
    assert_eq!(chars, vec!["1001", "1002", "1003", "1004", "1006"]);
    let entities = v["entities"].as_array().unwrap();
    let alpha = entities.iter().find(|e| e["id"] == "1001").unwrap();
    assert_eq!(alpha["displayNameCandidate"]["kind"], "literal");
    assert_eq!(alpha["displayNameCandidate"]["value"], "Placeholder Alpha");
    // 1003 没有 first_name：保留 ID，无 candidate，不失败。
    let father = entities.iter().find(|e| e["id"] == "1003").unwrap();
    assert!(father.get("displayNameCandidate").is_none());
}

#[test]
fn ck3_1_19_family_data_child_layout_is_extracted_without_real_father() {
    let dir = TempDir::new("fam-real-layout");
    let living = living_block(
        &[
            char_entry(
                "1001",
                "\t\tfirst_name=\"fictional_player\"\n\t\tfamily_data={\n\t\t\tprimary_spouse=1004\n\t\t\tspouse=1004\n\t\t\tchild={ 1006 }\n\t\t\treal_father=9001\n\t\t}\n",
            ),
            char_entry("1004", "\t\tfirst_name=\"Spouse_4E00\"\n"),
            char_entry("1006", "\t\tfirst_name=\"Child_4E01\"\n"),
        ]
        .concat(),
    );
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "family-real.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );

    assert_eq!(v["status"], "ok", "unexpected: {v}");
    let children = facts_with(&v, "character.child");
    assert!(children.iter().any(|f| f["subject"]["id"] == "1001"
        && f["object"]["id"] == "1006"
        && f["sourcePath"] == "character_child"
        && f["confidence"] == "exact"));
    let parents = facts_with(&v, "character.parent");
    assert!(parents.iter().any(|f| f["subject"]["id"] == "1006"
        && f["object"]["id"] == "1001"
        && f["sourcePath"] == "character_child"
        && f["confidence"] == "mapped"));
    assert_eq!(facts_with(&v, "character.spouse").len(), 1);
    assert!(!v.to_string().contains("9001"));

    // Save-internal encoded names are localization-key candidates now; the
    // app-side catalog resolves their real display names.
    let entities = v["entities"].as_array().unwrap();
    assert!(!entities.is_empty(), "expected extracted entities: {v}");
    for entity in entities {
        if entity["type"] == "character" {
            assert_eq!(entity["displayNameCandidate"]["kind"], "localization_key");
        }
    }
}

#[test]
fn hidden_father_and_secret_blocks_produce_no_output() {
    let dir = TempDir::new("fam-hidden");
    let v = extract_on_body(
        &dir,
        "hidden.ck3",
        &family_body(),
        &extract_request(&["1001"], &["family", "realm"]),
    );
    let text = v.to_string();
    // real_father 9001 与 secret/scheme 里埋的 ID 不得出现在任何实体/事实中。
    for f in v["facts"].as_array().unwrap() {
        assert_ne!(f["subject"]["id"], "9001");
        assert_ne!(f["object"]["id"], "9001");
    }
    assert!(!entity_ids(&v, "character").contains(&"9001".to_string()));
    // secrets/schemes/wars 块整块跳过：输出中不出现其结构字段。
    assert!(!text.contains("secret_owner"));
    assert!(!text.contains("scheme_owner"));
    assert!(!text.contains("murder"));
}

#[test]
fn one_hop_neighborhood_does_not_expand_related() {
    let dir = TempDir::new("fam-hop");
    let v = extract_on_body(
        &dir,
        "hop.ck3",
        &family_body(),
        &extract_request(&["1001"], &["family"]),
    );
    // 1002（related）自己的 spouse=1003 不展开；1007/1008 与 participant 无关。
    // （注意：derived child 事实 subject 可以是 related，如 1002→1001，那是
    // 由 participant 的 parent 事实派生的，不算展开。）
    for f in v["facts"].as_array().unwrap() {
        let pred = f["predicate"].as_str().unwrap();
        let subj = f["subject"]["id"].as_str().unwrap();
        let obj = f["object"]["id"].as_str().unwrap_or("");
        assert!(
            !(subj == "1002" && (pred == "character.spouse" || pred == "character.parent")),
            "related char own relations must not expand: {f}"
        );
        assert!(subj != "1007" && subj != "1008" && obj != "1007" && obj != "1008");
    }
    assert!(!entity_ids(&v, "character").contains(&"1007".to_string()));
    assert!(!entity_ids(&v, "character").contains(&"1008".to_string()));
}

#[test]
fn missing_reference_keeps_id_only_entity() {
    let dir = TempDir::new("fam-missing");
    let living = living_block(&char_entry("1001", "\t\tmother=9999\n"));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "miss.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    let parents = facts_with(&v, "character.parent");
    assert_eq!(parents.len(), 1);
    assert_eq!(parents[0]["object"]["id"], "9999");
    let e = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "9999")
        .unwrap();
    assert!(e.get("displayNameCandidate").is_none());
}

#[test]
fn dead_reference_without_alive_data_still_extracts() {
    let dir = TempDir::new("fam-dead");
    let living = living_block(
        &[
            char_entry("1001", "\t\tmother=1002\n"),
            // dead：没有 alive_data，只有名字。
            char_entry("1002", "\t\tfirst_name=\"Placeholder Dead\"\n"),
        ]
        .concat(),
    );
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "dead.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    assert_eq!(facts_with(&v, "character.parent").len(), 1);
    let e = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1002")
        .unwrap();
    assert_eq!(e["displayNameCandidate"]["value"], "Placeholder Dead");
}

#[test]
fn duplicate_single_value_key_first_wins_with_warning() {
    let dir = TempDir::new("fam-dup");
    let living = living_block(
        &[
            char_entry("1001", "\t\tmother=1002\n\t\tmother=1003\n"),
            char_entry("1002", "\t\tfirst_name=\"Placeholder First\"\n"),
        ]
        .concat(),
    );
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "dup.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    assert!(warning_codes_of(&v).contains(&"DUPLICATE_KEY".to_string()));
    let parents = facts_with(&v, "character.parent");
    assert_eq!(parents.len(), 1);
    assert_eq!(parents[0]["object"]["id"], "1002", "first key wins");
}

#[test]
fn multiple_spouses_each_get_one_fact() {
    let dir = TempDir::new("fam-multi");
    let living = living_block(
        &[
            char_entry("1001", "\t\tspouse=1004\n\t\tspouse=1009\n"),
            char_entry("1004", "\t\tspouse=1001\n"),
        ]
        .concat(),
    );
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "multi.ck3",
        &body,
        &extract_request(&["1001"], &["family"]),
    );
    let spouses = facts_with(&v, "character.spouse");
    assert_eq!(spouses.len(), 2);
    assert!(spouses.iter().any(|f| f["object"]["id"] == "1004"));
    assert!(spouses.iter().any(|f| f["object"]["id"] == "1009"));
}

#[test]
fn fact_ids_stable_across_runs_and_name_changes() {
    let dir = TempDir::new("fam-stable");
    let request = extract_request(&["1001"], &["family"]);
    let v1 = extract_on_body(&dir, "s1.ck3", &family_body(), &request);
    let v2 = extract_on_body(&dir, "s2.ck3", &family_body(), &request);
    let ids1: Vec<&str> = v1["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    let ids2: Vec<&str> = v2["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids1, ids2, "same snapshot must produce stable fact IDs");

    // 改名（display name 变化）不改变 fact ID。
    let renamed = family_body().replace("Placeholder Alpha", "Placeholder Renamed");
    let v3 = extract_on_body(&dir, "s3.ck3", &renamed, &request);
    let ids3: Vec<&str> = v3["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids1, ids3, "display name must not feed into fact ID");
}

#[test]
fn related_character_limit_marks_partial_and_stops_growth() {
    let dir = TempDir::new("fam-limit");
    // related 上限 2：1001 的 mother/father/spouse 三个 related 装不下。
    let v = extract_on_body(
        &dir,
        "limit.ck3",
        &family_body(),
        &extract_request_with_limits(&["1001"], &["family"], 500, 250, 2),
    );
    assert_eq!(v["status"], "partial");
    assert!(warning_codes_of(&v).contains(&"EXTRACTION_LIMIT_REACHED".to_string()));
    let chars = entity_ids(&v, "character");
    assert!(chars.len() <= 3, "participant + ≤2 related: {chars:?}");
}

#[test]
fn facts_limit_marks_partial() {
    let dir = TempDir::new("fam-factslimit");
    let v = extract_on_body(
        &dir,
        "fl.ck3",
        &family_body(),
        &extract_request_with_limits(&["1001"], &["family"], 3, 250, 100),
    );
    assert_eq!(v["status"], "partial");
    assert!(v["facts"].as_array().unwrap().len() <= 3);
    assert!(warning_codes_of(&v).contains(&"EXTRACTION_LIMIT_REACHED".to_string()));
}

#[test]
fn facts_and_entities_are_stably_sorted() {
    let dir = TempDir::new("fam-sort");
    let v = extract_on_body(
        &dir,
        "sort.ck3",
        &family_body(),
        &extract_request(&["1001"], &["family"]),
    );
    let facts = v["facts"].as_array().unwrap();
    let keys: Vec<(String, String, String)> = facts
        .iter()
        .map(|f| {
            (
                f["subject"]["id"].as_str().unwrap().to_string(),
                f["predicate"].as_str().unwrap().to_string(),
                f["object"]["id"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(
        keys, sorted,
        "facts must be sorted by subject id/predicate/object id"
    );

    let entities = v["entities"].as_array().unwrap();
    let ekeys: Vec<(String, String)> = entities
        .iter()
        .map(|e| {
            (
                e["type"].as_str().unwrap().to_string(),
                e["id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let mut esorted = ekeys.clone();
    esorted.sort();
    assert_eq!(ekeys, esorted, "entities must be sorted by type/id");
}
