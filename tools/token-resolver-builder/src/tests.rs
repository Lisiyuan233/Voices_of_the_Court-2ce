//! 单元测试：手工构造微型二进制 buffer（用 `Token::write` 保证语法正确）
//! 与对应明文，覆盖对齐 / 冲突 / lookup / 漂移 / 递归各分支。
//!
//! 真实存档冒烟测试用环境变量 `VOTC_TEST_SAVE_DIR` 门控且默认 ignore。

use jomini::Scalar;
use jomini::binary::Token;
use jomini::text::TextTape;

use crate::align::{self, PairOutcome};
use crate::verify;
use crate::vote;

/// 用 jomini 自带的 Token 序列化构造二进制 buffer。
fn bin(tokens: &[Token]) -> Vec<u8> {
    let mut v = Vec::new();
    for t in tokens {
        t.write(&mut v).unwrap();
    }
    v
}

fn align_one(text: &str, bin_data: &[u8]) -> PairOutcome {
    let tape = TextTape::from_slice(text.as_bytes()).unwrap();
    let mut out = PairOutcome::default();
    align::align_pair(tape.tokens(), bin_data, &mut out).unwrap();
    out
}

fn table_of(outcomes: &[&PairOutcome]) -> vote::FinalTable {
    vote::finalize(outcomes)
}

#[test]
fn simple_object_alignment() {
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(42),
        Token::Id(0x0101),
        Token::Equal,
        Token::Quoted(Scalar::new(b"hello")),
    ]);
    let out = align_one("alpha=42 beta=\"hello\"", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("alpha"));
    assert_eq!(table.tokens.get(&0x0101).map(String::as_str), Some("beta"));
    assert!(table.conflicts.is_empty());
}

#[test]
fn integer_keyed_recursion() {
    // 整数 id key（living_characters 风格）直接锚定并递归子对象。
    let bin = bin(&[
        Token::U32(1234),
        Token::Equal,
        Token::Open,
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(1),
        Token::Close,
    ]);
    let out = align_one("1234={ alpha=1 }", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("alpha"));
}

#[test]
fn drift_extra_text_field_is_ambiguous_not_guessed() {
    // 文本侧多出一个字段：锚点切窗后窗口不等长，LCS 对不上 → ambiguous。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(1),
        Token::Id(0x0102),
        Token::Equal,
        Token::I32(3),
    ]);
    let out = align_one("a=1 b=2 c=3", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("a"));
    assert_eq!(table.tokens.get(&0x0102).map(String::as_str), Some("c"));
    assert_eq!(table.tokens.len(), 2);
    assert!(out.ambiguous_items >= 1);
}

#[test]
fn drift_window_lcs_partial_match() {
    // 窗口内 2 vs 1：LCS 对上 y，x 计 ambiguous。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(1),
        Token::Id(0x0200),
        Token::Equal,
        Token::I32(200),
        Token::Id(0x0102),
        Token::Equal,
        Token::I32(2),
    ]);
    let out = align_one("a=1 x=100 y=200 b=2", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("a"));
    assert_eq!(table.tokens.get(&0x0200).map(String::as_str), Some("y"));
    assert_eq!(table.tokens.get(&0x0102).map(String::as_str), Some("b"));
    assert_eq!(table.tokens.len(), 3);
    assert!(out.ambiguous_items >= 1);
}

#[test]
fn equal_window_with_unequal_fingerprints_is_not_paired() {
    // 等长窗口但两侧可锚定指纹不等：错位证据，不按位猜。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(1),
        Token::Id(0x0300),
        Token::Equal,
        Token::I32(999),
        Token::Id(0x0102),
        Token::Equal,
        Token::I32(2),
    ]);
    let out = align_one("a=1 z=555 b=2", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("a"));
    assert_eq!(table.tokens.get(&0x0102).map(String::as_str), Some("b"));
    assert!(!table.tokens.contains_key(&0x0300));
}

#[test]
fn lookup_value_goes_to_lookup_table() {
    let bin = bin(&[
        Token::Id(0x0102),
        Token::Equal,
        Token::Lookup(300),
    ]);
    let out = align_one("culture=\"norse\"", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0102).map(String::as_str), Some("culture"));
    assert_eq!(table.lookup.get(&300).map(String::as_str), Some("norse"));
}

#[test]
fn value_position_token_is_voted() {
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::Id(0x0200),
    ]);
    let out = align_one("type=feudal", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("type"));
    assert_eq!(table.tokens.get(&0x0200).map(String::as_str), Some("feudal"));
}

#[test]
fn cross_pair_conflict_is_reported_not_included() {
    let bin1 = bin(&[Token::Id(0x0100), Token::Equal, Token::I32(1)]);
    let out1 = align_one("alpha=1", &bin1);
    let bin2 = bin(&[Token::Id(0x0100), Token::Equal, Token::I32(2)]);
    let out2 = align_one("gamma=2", &bin2);
    let table = table_of(&[&out1, &out2]);
    assert!(!table.tokens.contains_key(&0x0100));
    assert_eq!(table.conflicts.len(), 1);
    assert!(table.conflicts[0].contains("0x0100"));
}

#[test]
fn name_mapped_by_two_tokens_is_conflict() {
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(1),
        Token::Id(0x0101),
        Token::Equal,
        Token::I32(2),
    ]);
    let out = align_one("alpha=1 beta=2", &bin);
    // 手工制造一名多 token：0x0101 也投给 alpha。
    let mut rigged = PairOutcome::default();
    for (tok, names) in &out.token_votes {
        for (name, count) in names {
            rigged.token_votes.entry(*tok).or_default().insert(name.clone(), *count);
        }
    }
    rigged
        .token_votes
        .entry(0x0101)
        .or_default()
        .insert("alpha".to_string(), 1);
    let table = table_of(&[&rigged]);
    assert!(!table.tokens.contains_key(&0x0100));
    assert!(!table.tokens.contains_key(&0x0101));
    assert!(table.conflicts.iter().any(|c| c.contains("alpha")));
}

#[test]
fn dates_and_floats_do_not_anchor() {
    // 日期与浮点不锚定，但等长 zip 仍按位配对（无非锚定冲突时）。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(756789),
        Token::Id(0x0101),
        Token::Equal,
        Token::F32(0.175f32.to_le_bytes()),
    ]);
    let out = align_one("birth=\"1067.1.1\" factor=0.175000", &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("birth"));
    assert_eq!(table.tokens.get(&0x0101).map(String::as_str), Some("factor"));
}

#[test]
fn verify_flatten_and_compare() {
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::I32(42),
        Token::Id(0x0101),
        Token::Equal,
        Token::Open,
        Token::Id(0x0102),
        Token::Equal,
        Token::Bool(true),
        Token::Close,
    ]);
    let text = "alpha=42 beta={ gamma=yes }";
    let out = align_one(text, &bin);
    let table = table_of(&[&out]);
    let tape = TextTape::from_slice(text.as_bytes()).unwrap();
    let text_flat = verify::flatten_text(tape.tokens());
    let bin_flat = verify::flatten_bin(&bin, &table).unwrap();
    let cmp = verify::compare_paths(&text_flat, &bin_flat);
    assert_eq!(cmp.match_rate, 1.0);
    assert_eq!(cmp.value_mismatches, 0);

    let cov = verify::coverage(&bin, &table);
    assert_eq!(cov.unresolved_tokens, Vec::<u16>::new());
    assert!(cov.deserializer_ok, "{:?}", cov.deserializer_err);
}

#[test]
fn date_keys_normalize_to_binary_hours() {
    use crate::events::date_to_binary_hours;
    // 与真实存档二进制侧观察值一致。
    assert_eq!(date_to_binary_hours("1066.1.1"), Some(53138160));
    assert_eq!(date_to_binary_hours("1067.1.1"), Some(53146920));
    assert_eq!(date_to_binary_hours("1.19.0.6"), None); // 版本号不是日期

    // 日期 key 的 history 对象：文本 key 规范化后与二进制整数 key 路径一致。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::Open,
        Token::I32(53138160),
        Token::Equal,
        Token::Open,
        Token::Id(0x0101),
        Token::Equal,
        Token::I32(5),
        Token::Close,
        Token::Close,
    ]);
    let text = "history={ 1066.1.1={ holder=5 } }";
    let out = align_one(text, &bin);
    let table = table_of(&[&out]);
    assert_eq!(table.tokens.get(&0x0100).map(String::as_str), Some("history"));
    assert_eq!(table.tokens.get(&0x0101).map(String::as_str), Some("holder"));

    let tape = TextTape::from_slice(text.as_bytes()).unwrap();
    let text_flat = verify::flatten_text(tape.tokens());
    let bin_flat = verify::flatten_bin(&bin, &table).unwrap();
    let cmp = verify::compare_paths(&text_flat, &bin_flat);
    assert_eq!(cmp.match_rate, 1.0);
}

#[test]
fn mixed_container_bare_scalar_matches_binary_array_element() {
    // 文本混合容器 `levels={ 4 0=2 1=1 }` ↔ 二进制「裸值 = 普通数组元素，
    // 有 key 的 = key=value」。
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::Open,
        Token::U32(4),
        Token::I32(0),
        Token::Equal,
        Token::I32(2),
        Token::I32(1),
        Token::Equal,
        Token::I32(1),
        Token::Close,
    ]);
    let text = "levels={ 4 0=2 1=1 }";
    let tape = TextTape::from_slice(text.as_bytes()).unwrap();
    let mut table = vote::FinalTable::default();
    table.tokens.insert(0x0100, "levels".to_string());
    let text_flat = verify::flatten_text(tape.tokens());
    let bin_flat = verify::flatten_bin(&bin, &table).unwrap();
    let cmp = verify::compare_paths(&text_flat, &bin_flat);
    assert_eq!(cmp.match_rate, 1.0, "text_only={:?} bin_only={:?}",
        cmp.text_only_samples, cmp.bin_only_samples);
    assert_eq!(cmp.value_mismatches, 0);
}

#[test]
fn rgb_value_expands_to_array_paths() {
    let bin = bin(&[
        Token::Id(0x0100),
        Token::Equal,
        Token::Rgb(jomini::binary::Rgb {
            r: 120,
            g: 30,
            b: 40,
            a: None,
        }),
    ]);
    let text = "color=rgb { 120 30 40 }";
    let tape = TextTape::from_slice(text.as_bytes()).unwrap();
    let mut table = vote::FinalTable::default();
    table.tokens.insert(0x0100, "color".to_string());
    let text_flat = verify::flatten_text(tape.tokens());
    let bin_flat = verify::flatten_bin(&bin, &table).unwrap();
    let cmp = verify::compare_paths(&text_flat, &bin_flat);
    assert_eq!(cmp.match_rate, 1.0, "text_only={:?} bin_only={:?}",
        cmp.text_only_samples, cmp.bin_only_samples);
}

/// 真实存档冒烟测试：需要 `VOTC_TEST_SAVE_DIR` 指向包含配对存档的目录，
/// 默认 ignore。运行：
/// `VOTC_TEST_SAVE_DIR=... cargo test -- --ignored real_saves_smoke`
#[test]
#[ignore]
fn real_saves_smoke() {
    let dir = std::env::var("VOTC_TEST_SAVE_DIR").expect("VOTC_TEST_SAVE_DIR not set");
    let dir = std::path::Path::new(&dir);
    let mut outcomes = Vec::new();
    for n in ["votc_save_test1", "votc_save_test2", "votc_save_test3"] {
        let bin_data = match crate::unpack::read_gamestate(&dir.join(format!("{n}.ck3")))
            .unwrap()
        {
            crate::unpack::Gamestate::Binary(b) => b,
            _ => panic!("{n}.ck3 is not binary"),
        };
        let text_data = match crate::unpack::read_gamestate(&dir.join(format!("{n}_1.ck3")))
            .unwrap()
        {
            crate::unpack::Gamestate::Text(b) => b,
            _ => panic!("{n}_1.ck3 is not text"),
        };
        let tape = TextTape::from_slice(&text_data).unwrap();
        let mut out = PairOutcome::default();
        align::align_pair(tape.tokens(), &bin_data, &mut out).unwrap();
        outcomes.push(out);
    }
    // 单对独立建表必须零冲突。
    let singles: Vec<vote::FinalTable> = outcomes.iter().map(|o| vote::finalize(&[o])).collect();
    for (i, a) in singles.iter().enumerate() {
        for b in &singles[i + 1..] {
            for (tok, name) in &a.tokens {
                if let Some(other) = b.tokens.get(tok) {
                    assert_eq!(
                        other, name,
                        "token 0x{tok:04x} conflicts across single-pair tables"
                    );
                }
            }
        }
    }
}
