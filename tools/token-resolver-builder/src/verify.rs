//! 验证：重解析覆盖率统计 + 二进制/明文「路径→值」交叉比对。
//!
//! - 覆盖率：Lexer 全量扫描二进制流，统计 Id token / lookup 索引的出现
//!   次数与未解析清单；再用 `BinaryDeserializer` + 生成的表 +
//!   `FailedResolveStrategy::Stringify` 完整重解析一遍（deserialize 到
//!   `HashMap<String, IgnoredAny>`），证明表可被 jomini 正常消费。
//! - 交叉比对：两侧都展平为 路径 → 值 多重集合，计算路径匹配率；值仅在
//!   可比较表示（整数/布尔/字符串）时比对，浮点/日期/lookup 未解析等
//!   `<...>` 占位表示不参与值比对。

use std::borrow::Cow;
use std::collections::HashMap;

use jomini::binary::{
    BinaryDeserializer, BinaryFlavor, FailedResolveStrategy, Lexer, Token, TokenResolver,
};
use jomini::text::TextToken;
use jomini::{Encoding, Utf8Encoding};

use crate::events::{
    BinItem, Finger, Key, Mode, is_date_like, walk_bin_level, walk_text_level,
};
use crate::vote::FinalTable;

/// CK3 二进制 flavor：小端浮点 + UTF-8 字符串。
/// 验证只 deserialize 到 IgnoredAny，浮点解码精确性不影响结果。
struct Ck3Flavor(Utf8Encoding);

impl Encoding for Ck3Flavor {
    fn decode<'a>(&self, data: &'a [u8]) -> Cow<'a, str> {
        self.0.decode(data)
    }
}

impl BinaryFlavor for Ck3Flavor {
    fn visit_f32(&self, data: [u8; 4]) -> f32 {
        f32::from_le_bytes(data)
    }

    fn visit_f64(&self, data: [u8; 8]) -> f64 {
        f64::from_le_bytes(data)
    }
}

struct TableResolver<'a> {
    table: &'a FinalTable,
}

impl TokenResolver for TableResolver<'_> {
    fn resolve(&self, token: u16) -> Option<&str> {
        self.table.tokens.get(&token).map(|s| s.as_str())
    }

    fn lookup(&self, index: u32) -> Option<&str> {
        self.table.lookup.get(&index).map(|s| s.as_str())
    }
}

/// 单个二进制存档的覆盖率统计。
#[derive(Default)]
pub struct Coverage {
    /// Id token（key 与值位置）总出现次数。
    pub id_occurrences: u64,
    pub resolved_occurrences: u64,
    /// 未解析的不同 token（升序）。
    pub unresolved_tokens: Vec<u16>,
    pub lookup_occurrences: u64,
    pub lookup_resolved: u64,
    pub unresolved_lookups: Vec<u32>,
    /// BinaryDeserializer + Stringify 完整重解析是否成功。
    pub deserializer_ok: bool,
    pub deserializer_err: Option<String>,
}

pub fn coverage(bin: &[u8], table: &FinalTable) -> Coverage {
    let mut cov = Coverage::default();
    let mut unresolved: HashMap<u16, u64> = HashMap::new();
    let mut unresolved_lookup: HashMap<u32, u64> = HashMap::new();

    let mut lexer = Lexer::new(bin);
    loop {
        match lexer.next_token() {
            Ok(Some(Token::Id(t))) => {
                cov.id_occurrences += 1;
                if table.tokens.contains_key(&t) {
                    cov.resolved_occurrences += 1;
                } else {
                    *unresolved.entry(t).or_default() += 1;
                }
            }
            Ok(Some(Token::Lookup(i))) => {
                cov.lookup_occurrences += 1;
                if table.lookup.contains_key(&i) {
                    cov.lookup_resolved += 1;
                } else {
                    *unresolved_lookup.entry(i).or_default() += 1;
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(e) => {
                cov.deserializer_err = Some(format!("lexer scan failed: {e}"));
                break;
            }
        }
    }
    cov.unresolved_tokens = unresolved.keys().copied().collect();
    cov.unresolved_tokens.sort_unstable();
    cov.unresolved_lookups = unresolved_lookup.keys().copied().collect();
    cov.unresolved_lookups.sort_unstable();

    // BinaryDeserializer + Stringify 完整重解析 smoke。
    let resolver = TableResolver { table };
    let mut builder = BinaryDeserializer::builder_flavor(Ck3Flavor(Utf8Encoding::new()));
    builder.on_failed_resolve(FailedResolveStrategy::Stringify);
    let result: Result<HashMap<String, serde::de::IgnoredAny>, _> =
        builder.deserialize_slice(bin, &resolver);
    match result {
        Ok(_) => cov.deserializer_ok = true,
        Err(e) => {
            cov.deserializer_ok = false;
            cov.deserializer_err = Some(e.to_string());
        }
    }
    cov
}

/// 展平后的一个路径条目：出现次数 + 值表示样本（ capped ）。
#[derive(Default)]
pub struct PathEntry {
    pub count: u64,
    pub values: Vec<String>,
}

const VALUE_SAMPLES_CAP: usize = 4;

fn push_entry(map: &mut HashMap<String, PathEntry>, path: String, value: String) {
    let entry = map.entry(path).or_default();
    entry.count += 1;
    if entry.values.len() < VALUE_SAMPLES_CAP {
        entry.values.push(value);
    }
}

fn key_repr(key: &Option<Key>) -> String {
    match key {
        Some(Key::Token(t)) => format!("0x{t:04x}"),
        Some(Key::Int(i)) => i.to_string(),
        Some(Key::Str(s)) => s.clone(),
        None => "[]".to_string(),
    }
}

/// 明文侧 key 的路径段：日期 key（"1066.1.1"）规范化为二进制小时计数，
/// 与二进制侧的整数 key 对齐。
fn text_key_repr(key: &Option<Key>) -> String {
    match key {
        Some(Key::Str(s)) => {
            if let Some(hours) = crate::events::date_to_binary_hours(s) {
                hours.to_string()
            } else {
                s.clone()
            }
        }
        other => key_repr(other),
    }
}

/// 明文侧展平：路径 → 值表示。
pub fn flatten_text(tokens: &[TextToken]) -> HashMap<String, PathEntry> {
    let mut out = HashMap::new();
    flatten_text_level(tokens, 0, tokens.len(), Mode::Object, "", &mut out);
    out
}

fn flatten_text_level(
    tokens: &[TextToken],
    start: usize,
    end: usize,
    mode: Mode,
    path: &str,
    out: &mut HashMap<String, PathEntry>,
) {
    for item in walk_text_level(tokens, start, end, mode) {
        let p = format!("{}/{}", path, text_key_repr(&item.key));
        let value = if item.range.is_some() {
            "<group>".to_string()
        } else {
            item.value_raw.clone().unwrap_or_else(|| "<none>".to_string())
        };
        push_entry(out, p.clone(), value);
        if let Some((cs, ce)) = item.range {
            let child_mode = match tokens.get(cs) {
                Some(TextToken::Object { .. }) => Mode::Object,
                _ => Mode::Array,
            };
            flatten_text_level(tokens, cs + 1, ce, child_mode, &p, out);
        }
    }
}

/// 二进制侧展平（用生成的表解析 key / lookup / 值 token）。
pub fn flatten_bin(bin: &[u8], table: &FinalTable) -> Result<HashMap<String, PathEntry>, String> {
    let mut out = HashMap::new();
    flatten_bin_level(bin, table, "", &mut out)?;
    Ok(out)
}

fn bin_key_repr(key: &Option<Key>, table: &FinalTable) -> String {
    match key {
        Some(Key::Token(t)) => table
            .tokens
            .get(t)
            .cloned()
            .unwrap_or_else(|| format!("0x{t:04x}")),
        other => key_repr(other),
    }
}

fn bin_value_repr(item: &BinItem, table: &FinalTable) -> String {
    match &item.finger {
        Finger::Int(i) => i.to_string(),
        Finger::Bool(b) => if *b { "yes" } else { "no" }.to_string(),
        Finger::Str(s) => s.clone(),
        Finger::Group => "<group>".to_string(),
        Finger::None => {
            if let Some(i) = item.lookup {
                table
                    .lookup
                    .get(&i)
                    .cloned()
                    .unwrap_or_else(|| format!("<lookup:{i}>"))
            } else if let Some(t) = item.value_token {
                table
                    .tokens
                    .get(&t)
                    .cloned()
                    .unwrap_or_else(|| format!("0x{t:04x}"))
            } else {
                "<other>".to_string()
            }
        }
    }
}

fn flatten_bin_level(
    data: &[u8],
    table: &FinalTable,
    path: &str,
    out: &mut HashMap<String, PathEntry>,
) -> Result<(), String> {
    for item in walk_bin_level(data)? {
        let p = format!("{}/{}", path, bin_key_repr(&item.key, table));
        if let Some(n) = item.rgb {
            // RGB 标量 ↔ 文本侧 3/4 元素数组：展开为 [] 子路径对齐。
            // 分量表示不同（文本可能是 0-1 浮点），值统一用占位不参与比对。
            push_entry(out, p.clone(), "<rgb>".to_string());
            for _ in 0..n {
                push_entry(out, format!("{p}/[]"), "<rgb>".to_string());
            }
            continue;
        }
        let value = bin_value_repr(&item, table);
        push_entry(out, p.clone(), value);
        if let Some((bs, be)) = item.range {
            flatten_bin_level(&data[bs..be], table, &p, out)?;
        }
    }
    Ok(())
}

/// 交叉比对结果。
#[derive(Default)]
pub struct PathCompare {
    pub text_paths: u64,
    pub bin_paths: u64,
    pub matched: u64,
    /// matched / max(text, bin)。
    pub match_rate: f64,
    pub text_only_count: u64,
    pub bin_only_count: u64,
    pub text_only_samples: Vec<String>,
    pub bin_only_samples: Vec<String>,
    pub value_mismatches: u64,
    pub value_samples: Vec<String>,
}

const DIFF_SAMPLES_CAP: usize = 20;

/// 值是否可比较（`<...>` 占位表示与日期表示不参与值比对）。
fn comparable(value: &str) -> bool {
    !value.starts_with('<') && !is_date_like(value)
}

pub fn compare_paths(
    text: &HashMap<String, PathEntry>,
    bin: &HashMap<String, PathEntry>,
) -> PathCompare {
    let mut cmp = PathCompare::default();
    for (path, t) in text {
        cmp.text_paths += t.count;
        let b = bin.get(path);
        let bc = b.map(|e| e.count).unwrap_or(0);
        cmp.matched += t.count.min(bc);
        if bc < t.count {
            cmp.text_only_count += t.count - bc;
            if cmp.text_only_samples.len() < DIFF_SAMPLES_CAP {
                cmp.text_only_samples.push(path.clone());
            }
        }
        if let Some(b) = b {
            // 值比对：仅两侧都有样本且可比较时。
            if t.count <= VALUE_SAMPLES_CAP as u64 && b.count <= VALUE_SAMPLES_CAP as u64 {
                for (tv, bv) in t.values.iter().zip(b.values.iter()) {
                    if comparable(tv) && comparable(bv) && tv != bv {
                        cmp.value_mismatches += 1;
                        if cmp.value_samples.len() < DIFF_SAMPLES_CAP {
                            cmp.value_samples
                                .push(format!("{path}: text={tv:?} bin={bv:?}"));
                        }
                    }
                }
            }
        }
    }
    for (path, b) in bin {
        cmp.bin_paths += b.count;
        let tc = text.get(path).map(|e| e.count).unwrap_or(0);
        if tc < b.count {
            cmp.bin_only_count += b.count - tc;
            if cmp.bin_only_samples.len() < DIFF_SAMPLES_CAP {
                cmp.bin_only_samples.push(path.clone());
            }
        }
    }
    let total = cmp.text_paths.max(cmp.bin_paths);
    cmp.match_rate = if total == 0 {
        1.0
    } else {
        cmp.matched as f64 / total as f64
    };
    cmp
}
