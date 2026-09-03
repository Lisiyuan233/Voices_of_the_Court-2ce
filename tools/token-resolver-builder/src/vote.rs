//! 跨配对投票与冲突检测。
//!
//! 收录规则（保守）：
//! - token → name：该 token 在所有配对中只映射到一个 name，且该 name 也
//!   只被这一个 token 映射 → 入表。
//! - 一 token 多名 / 一名多 token → 冲突，报告且不入表。
//! - lookup 索引同理（只查 index → string 单方向冲突）。

use std::collections::{BTreeMap, HashMap};

use crate::align::PairOutcome;

/// 最终 token 表 + 冲突报告。
#[derive(Default)]
pub struct FinalTable {
    pub tokens: BTreeMap<u16, String>,
    pub lookup: BTreeMap<u32, String>,
    pub conflicts: Vec<String>,
}

/// 人工订正：投票之后应用，用于修正证据充分的错误映射或补录未解析 token。
/// 返回应用的描述列表（供报告）；订正同时清理 name->token 的唯一性约束
/// 不管——overrides 是人工裁决，优先级高于自动规则。
pub fn apply_overrides(
    table: &mut FinalTable,
    tokens: &BTreeMap<u16, String>,
) -> Vec<String> {
    let mut applied = Vec::new();
    for (tok, name) in tokens {
        match table.tokens.insert(*tok, name.clone()) {
            Some(old) if old != *name => {
                applied.push(format!("0x{tok:04x}: {old} -> {name}"));
            }
            Some(_) => {}
            None => applied.push(format!("0x{tok:04x}: (unresolved) -> {name}")),
        }
    }
    applied
}

/// 汇总若干 PairOutcome（每个对应一对存档），产出最终表。
pub fn finalize(outcomes: &[&PairOutcome]) -> FinalTable {
    let mut token_votes: HashMap<u16, HashMap<String, u64>> = HashMap::new();
    let mut lookup_votes: HashMap<u32, HashMap<String, u64>> = HashMap::new();
    for out in outcomes {
        for (tok, names) in &out.token_votes {
            let entry = token_votes.entry(*tok).or_default();
            for (name, count) in names {
                *entry.entry(name.clone()).or_default() += count;
            }
        }
        for (idx, strs) in &out.lookup_votes {
            let entry = lookup_votes.entry(*idx).or_default();
            for (s, count) in strs {
                *entry.entry(s.clone()).or_default() += count;
            }
        }
    }

    let mut result = FinalTable::default();

    // 反向索引：name -> tokens。
    let mut name_to_tokens: HashMap<&str, Vec<u16>> = HashMap::new();
    for (tok, names) in &token_votes {
        for name in names.keys() {
            name_to_tokens.entry(name.as_str()).or_default().push(*tok);
        }
    }

    for (tok, names) in &token_votes {
        if names.len() > 1 {
            let detail: Vec<String> = {
                let mut v: Vec<(&String, &u64)> = names.iter().collect();
                v.sort_by(|a, b| b.1.cmp(a.1));
                v.iter().map(|(n, c)| format!("{n}({c})")).collect()
            };
            result.conflicts.push(format!(
                "token 0x{tok:04x} -> multiple names: {}",
                detail.join(", ")
            ));
            continue;
        }
        let name = names.keys().next().unwrap();
        let tokens_for_name = &name_to_tokens[name.as_str()];
        if tokens_for_name.len() > 1 {
            let mut toks: Vec<String> =
                tokens_for_name.iter().map(|t| format!("0x{t:04x}")).collect();
            toks.sort();
            result.conflicts.push(format!(
                "name {name} <- multiple tokens: {}",
                toks.join(", ")
            ));
            continue;
        }
        result.tokens.insert(*tok, name.clone());
    }

    for (idx, strs) in &lookup_votes {
        if strs.len() > 1 {
            let detail: Vec<String> = {
                let mut v: Vec<(&String, &u64)> = strs.iter().collect();
                v.sort_by(|a, b| b.1.cmp(a.1));
                v.iter().map(|(s, c)| format!("{s}({c})")).collect()
            };
            result.conflicts.push(format!(
                "lookup {idx} -> multiple strings: {}",
                detail.join(", ")
            ));
            continue;
        }
        let s = strs.keys().next().unwrap();
        result.lookup.insert(*idx, s.clone());
    }

    result.conflicts.sort();
    result.conflicts.dedup();
    result
}
