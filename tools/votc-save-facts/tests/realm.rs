//! realm predicate 集成测试（实施计划 Task 4 步骤 8）。
//!
//! 覆盖：liege / primary_title / title.holder 正常路径、引用缺失、
//! localization key vs literal name、一跳邻域、重复 key、category 过滤、
//! 稳定 fact ID。

mod common;

use common::*;

/// 标准 realm fixture：participant=1001（liege=1005、primary_title=200），
/// 另有非 participant 持有的 title 与 related 的 liege（都不应展开）。
fn realm_body() -> String {
    let living = living_block(
        &[
            char_entry(
                "1001",
                "\t\tfirst_name=\"Placeholder Alpha\"\n\t\talive_data={\n\t\t\tliege=1005\n\t\t\tprimary_title=200\n\t\t\tgold=10\n\t\t}\n",
            ),
            char_entry(
                "1004",
                "\t\tfirst_name=\"Placeholder Spouse\"\n\t\tspouse=1001\n\t\talive_data={\n\t\t\tliege=1010\n\t\t}\n",
            ),
        ]
        .concat(),
    );
    let titles = landed_titles_block(
        &[
            title_entry(
                "200",
                "\t\tkey=\"title_placeholder_duchy\"\n\t\tholder=1001\n",
            ),
            title_entry(
                "201",
                "\t\tkey=\"title_other\"\n\t\tname=\"Literal Custom\"\n\t\tholder=1007\n",
            ),
        ]
        .concat(),
    );
    gamestate_blocks(&default_vars(1), &(living + &titles))
}

#[test]
fn full_realm_extraction() {
    let dir = TempDir::new("realm-full");
    let v = extract_on_body(
        &dir,
        "realm.ck3",
        &realm_body(),
        &extract_request(&["1001"], &["realm"]),
    );
    assert_eq!(v["status"], "ok", "unexpected: {v}");

    let facts = v["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 3, "facts: {facts:?}");

    let liege = facts_with(&v, "character.liege");
    assert_eq!(liege.len(), 1);
    assert_eq!(liege[0]["subject"]["id"], "1001");
    assert_eq!(liege[0]["object"]["type"], "character");
    assert_eq!(liege[0]["object"]["id"], "1005");
    assert_eq!(liege[0]["sourcePath"], "character_liege");
    assert_eq!(liege[0]["visibility"], "public");
    assert_eq!(liege[0]["sensitivity"], "political");
    assert_eq!(liege[0]["confidence"], "exact");

    let primary = facts_with(&v, "character.primary_title");
    assert_eq!(primary.len(), 1);
    assert_eq!(primary[0]["subject"]["id"], "1001");
    assert_eq!(primary[0]["object"]["type"], "title");
    assert_eq!(primary[0]["object"]["id"], "200");
    assert_eq!(primary[0]["sourcePath"], "character_primary_title");

    // title.holder：内部反向索引，omniscient_internal，不直接渲染。
    let holders = facts_with(&v, "title.holder");
    assert_eq!(holders.len(), 1);
    assert_eq!(holders[0]["subject"]["type"], "title");
    assert_eq!(holders[0]["subject"]["id"], "200");
    assert_eq!(holders[0]["object"]["id"], "1001");
    assert_eq!(holders[0]["sourcePath"], "title_holder");
    assert_eq!(holders[0]["visibility"], "omniscient_internal");
    assert_eq!(holders[0]["sensitivity"], "political");

    // title 201 的 holder 不是 participant → 无事实。
    assert!(!entity_ids(&v, "title").contains(&"201".to_string()));
    // related character 1004 的 liege=1010 不展开（一跳）。
    assert!(!entity_ids(&v, "character").contains(&"1010".to_string()));
    assert!(facts.iter().all(|f| f["object"]["id"] != "1010"));

    // title 200 实体：key → localization_key candidate（不当 display string）。
    let t200 = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "200")
        .unwrap();
    assert_eq!(t200["type"], "title");
    assert_eq!(t200["displayNameCandidate"]["kind"], "localization_key");
    assert_eq!(
        t200["displayNameCandidate"]["value"],
        "title_placeholder_duchy"
    );
    // 1005 不在 living：id-only 实体，不失败。
    let l = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1005")
        .unwrap();
    assert!(l.get("displayNameCandidate").is_none());
}

#[test]
fn ck3_1_19_domain_and_title_hierarchy_resolve_primary_title_and_liege() {
    let dir = TempDir::new("realm-real-layout");
    let living = living_block(&char_entry(
        "1001",
        "\t\tfirst_name=\"fictional_player\"\n\t\tlanded_data={\n\t\t\tdomain={ 200 201 }\n\t\t\trealm_capital=201\n\t\t}\n",
    ));
    let titles = landed_titles_block(
        &(String::from("\tdynamic_templates={ { key=\"x_mc_0\" tier=duchy dyn=yes } }\n")
            + &title_entry(
                "200",
                "\t\tkey=d_placeholder\n\t\tholder=1001\n\t\tde_facto_liege=300\n\t\tde_jure_liege=301\n\t\ttitle_name_data={\n\t\t\tname=\"Localized Duchy\"\n\t\t\tadj=\"Localized\"\n\t\t}\n",
            )
            + &title_entry("201", "\t\tkey=c_capital\n\t\tholder=1001\n")
            + &title_entry("300", "\t\tkey=k_liege\n\t\tholder=1005\n")),
    );
    let body = gamestate_blocks(&default_vars(1), &(living + &titles));
    let v = extract_on_body(
        &dir,
        "realm-real.ck3",
        &body,
        &extract_request(&["1001"], &["realm"]),
    );

    assert_eq!(v["status"], "ok", "unexpected: {v}");
    let primary = facts_with(&v, "character.primary_title");
    assert_eq!(primary.len(), 1);
    assert_eq!(primary[0]["object"]["id"], "200");
    let liege = facts_with(&v, "character.liege");
    assert_eq!(liege.len(), 1);
    assert_eq!(liege[0]["object"]["id"], "1005");

    let title = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entity| entity["type"] == "title" && entity["id"] == "200")
        .unwrap();
    assert_eq!(title["displayNameCandidate"]["kind"], "literal");
    assert_eq!(title["displayNameCandidate"]["value"], "Localized Duchy");
    // Obfuscated 存档名是本地化键：必须作为 localization_key 候选输出，
    // 由 App 侧目录解析真实显示名（大山），而非丢弃或按字面量透出。
    let c1001 = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1001")
        .unwrap();
    assert_eq!(c1001["type"], "character");
    assert_eq!(c1001["displayNameCandidate"]["kind"], "localization_key");
    assert_eq!(c1001["displayNameCandidate"]["value"], "fictional_player");
}

#[test]
fn plain_literal_first_names_stay_literal_candidates() {
    let dir = TempDir::new("realm-literal-name");
    let living = living_block(&char_entry(
        "1001",
        "\t\tfirst_name=\"Wilhelm_the_Dead\"\n\t\tlanded_data={\n\t\t\tdomain={ 200 }\n\t\t\trealm_capital=200\n\t\t}\n",
    ));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "realm-literal-name.ck3",
        &body,
        // 空 categories 会整块跳过 living（skip-first），无法索引名字；
        // 参照同文件 category_filter_excludes_other_predicates 用最小 family 集。
        &extract_request(&["1001"], &["family"]),
    );

    assert_eq!(v["status"], "ok", "unexpected: {v}");
    let c1001 = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "1001")
        .unwrap();
    // 仅末段恰为 hex 的普通西文名不是转义键形态（其余分段非 4-hex），
    // 保持 literal 候选；App 目录查无此键时自然 unresolved。
    assert_eq!(c1001["displayNameCandidate"]["kind"], "literal");
    assert_eq!(c1001["displayNameCandidate"]["value"], "Wilhelm_the_Dead");
}

#[test]
fn literal_title_name_preferred_over_loc_key() {
    let dir = TempDir::new("realm-lit");
    let living = living_block(&char_entry(
        "1001",
        "\t\talive_data={\n\t\t\tprimary_title=201\n\t\t}\n",
    ));
    let titles = landed_titles_block(&title_entry(
        "201",
        "\t\tkey=\"title_other\"\n\t\tname=\"Literal Custom\"\n\t\tholder=1001\n",
    ));
    let body = gamestate_blocks(&default_vars(1), &(living + &titles));
    let v = extract_on_body(
        &dir,
        "lit.ck3",
        &body,
        &extract_request(&["1001"], &["realm"]),
    );
    let t = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "201")
        .unwrap();
    assert_eq!(t["displayNameCandidate"]["kind"], "literal");
    assert_eq!(t["displayNameCandidate"]["value"], "Literal Custom");
}

#[test]
fn missing_primary_title_reference_keeps_id_only_entity() {
    let dir = TempDir::new("realm-missing");
    let living = living_block(&char_entry(
        "1001",
        "\t\talive_data={\n\t\t\tprimary_title=299\n\t\t}\n",
    ));
    let body = gamestate_blocks(&default_vars(1), &living);
    let v = extract_on_body(
        &dir,
        "m.ck3",
        &body,
        &extract_request(&["1001"], &["realm"]),
    );
    assert_eq!(v["status"], "ok");
    let primary = facts_with(&v, "character.primary_title");
    assert_eq!(primary.len(), 1);
    assert_eq!(primary[0]["object"]["id"], "299");
    let t = v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "299")
        .unwrap();
    assert_eq!(t["type"], "title");
    assert!(t.get("displayNameCandidate").is_none());
}

#[test]
fn duplicate_holder_key_first_wins_with_warning() {
    let dir = TempDir::new("realm-dup");
    let living = living_block(&char_entry("1001", "\t\tfirst_name=\"A\"\n"));
    let titles = landed_titles_block(&title_entry("200", "\t\tholder=1001\n\t\tholder=1007\n"));
    let body = gamestate_blocks(&default_vars(1), &(living + &titles));
    let v = extract_on_body(
        &dir,
        "d.ck3",
        &body,
        &extract_request(&["1001"], &["realm"]),
    );
    assert!(warning_codes_of(&v).contains(&"DUPLICATE_KEY".to_string()));
    let holders = facts_with(&v, "title.holder");
    assert_eq!(holders.len(), 1);
    assert_eq!(holders[0]["object"]["id"], "1001", "first key wins");
}

#[test]
fn category_filter_excludes_other_predicates() {
    let dir = TempDir::new("realm-filter");
    // 只请求 family：realm fixture 不应产出 realm 事实。
    let v = extract_on_body(
        &dir,
        "f.ck3",
        &realm_body(),
        &extract_request(&["1001"], &["family"]),
    );
    assert_eq!(v["status"], "ok");
    assert!(facts_with(&v, "character.liege").is_empty());
    assert!(facts_with(&v, "character.primary_title").is_empty());
    assert!(facts_with(&v, "title.holder").is_empty());
    // family 事实仍正常（1004 spouse 1001）。
    assert_eq!(facts_with(&v, "character.spouse").len(), 1);
}

#[test]
fn realm_fact_ids_stable_across_runs() {
    let dir = TempDir::new("realm-stable");
    let request = extract_request(&["1001"], &["realm"]);
    let v1 = extract_on_body(&dir, "r1.ck3", &realm_body(), &request);
    let v2 = extract_on_body(&dir, "r2.ck3", &realm_body(), &request);
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
    assert_eq!(ids1, ids2);
}

#[test]
fn extract_still_reports_identity_and_metrics() {
    let dir = TempDir::new("realm-meta");
    let v = extract_on_body(
        &dir,
        "meta.ck3",
        &realm_body(),
        &extract_request(&["1001"], &["realm"]),
    );
    // extract 重跑 identity：identity 块随响应返回。
    assert_eq!(v["identity"]["playerCharacterId"], "1001");
    assert_eq!(v["identity"]["snapshotSequence"], 17);
    assert_eq!(v["manifest"]["ck3Version"], "1.13.0");
    assert_eq!(v["metrics"]["emittedFacts"], 3);
    assert!(v["metrics"]["emittedEntities"].as_u64().unwrap() >= 3);
    assert!(v["metrics"]["scannedBytes"].is_number());
}
