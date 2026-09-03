//! 对象内结构对齐：锚点切窗 + 窗口对齐（等长 zip / LCS / 大窗口贪心）。
//!
//! 同一游戏状态下二进制与明文序列化器输出的字段顺序一致，因此并行递归
//! 遍历两棵树，在每个对象层级内对齐 item 序列：
//!
//! 1. 锚点：整数/字符串 key 在两侧各出现一次 → key 锚点；可锚定值指纹在
//!    两侧各出现 ≤2 次 → 按出现次序配对的值锚点。
//! 2. 锚点把层级切成窗口；窗口等长 → 按位 1:1 zip（但两侧都是可锚定标量
//!    且指纹不等时视为错位证据，跳过计 ambiguous）。
//! 3. 窗口不等长且 ≤200 → 基于标量指纹的 LCS；对不上的计入 ambiguous。
//! 4. 窗口不等长且 >200 → 窗口内唯一指纹贪心配对，其余 ambiguous。
//!    绝不猜。
//!
//! 对齐成功的 (token key, 文本 key) 记为候选映射；文本字符串值 ↔ 二进制
//! lookup 索引记入 lookup 候选；文本字符串值 ↔ 二进制 token 值也记入候选
//! （值位置的 token 与 key 复用同一张表）。两侧都是容器时递归对齐子层级。

use std::collections::HashMap;

use jomini::text::TextToken;

use crate::events::{
    BinItem, Finger, Key, Mode, TextItem, walk_bin_level, walk_text_level,
};

/// LCS 窗口长度上限，超过则用贪心策略，避免 O(n²) 爆炸。
const LCS_WINDOW_MAX: usize = 200;

/// 递归深度上限（防御性，正常存档嵌套几十层）。
const MAX_DEPTH: usize = 500;

/// 一对存档对齐得到的候选映射与统计。
#[derive(Default)]
pub struct PairOutcome {
    /// token -> (name -> 票数)
    pub token_votes: HashMap<u16, HashMap<String, u64>>,
    /// lookup 索引 -> (字符串 -> 票数)
    pub lookup_votes: HashMap<u32, HashMap<String, u64>>,
    pub ambiguous_windows: u64,
    pub ambiguous_items: u64,
    pub aligned_items: u64,
    pub anchor_pairs: u64,
}

impl PairOutcome {
    fn vote_token(&mut self, token: u16, name: &str) {
        *self
            .token_votes
            .entry(token)
            .or_default()
            .entry(name.to_string())
            .or_default() += 1;
    }

    fn vote_lookup(&mut self, index: u32, value: &str) {
        *self
            .lookup_votes
            .entry(index)
            .or_default()
            .entry(value.to_string())
            .or_default() += 1;
    }
}

/// 对齐一对存档（根层）。
pub fn align_pair(
    tokens: &[TextToken],
    bin: &[u8],
    out: &mut PairOutcome,
) -> Result<(), String> {
    let text_items = walk_text_level(tokens, 0, tokens.len(), Mode::Object);
    let bin_items = walk_bin_level(bin)?;
    align_level(&text_items, &bin_items, tokens, bin, out, 0)
}

/// key 相等（仅限 Int/Str key；token key 未知名，不能自匹配）。
fn keys_match(a: &Option<Key>, b: &Option<Key>) -> bool {
    match (a, b) {
        (Some(Key::Int(x)), Some(Key::Int(y))) => x == y,
        (Some(Key::Str(x)), Some(Key::Str(y))) => x == y,
        _ => false,
    }
}

/// LCS / 贪心的元素匹配谓词：key 相等或可锚定指纹相等。
fn items_match(t: &TextItem, b: &BinItem) -> bool {
    keys_match(&t.key, &b.key) || (t.finger.anchorable() && t.finger == b.finger)
}

/// 收集锚点对 (text_idx, bin_idx)，按 text_idx 升序且 bin_idx 严格递增。
fn find_anchors(t: &[TextItem], b: &[BinItem]) -> Vec<(usize, usize)> {
    let mut pairs: Vec<(usize, usize)> = Vec::new();

    // key 锚点：Int/Str key 在两侧各恰好出现一次。
    let mut t_keys: HashMap<&Key, Vec<usize>> = HashMap::new();
    for (i, item) in t.iter().enumerate() {
        if let Some(k @ (Key::Int(_) | Key::Str(_))) = &item.key {
            t_keys.entry(k).or_default().push(i);
        }
    }
    let mut b_keys: HashMap<&Key, Vec<usize>> = HashMap::new();
    for (i, item) in b.iter().enumerate() {
        if let Some(k @ (Key::Int(_) | Key::Str(_))) = &item.key {
            b_keys.entry(k).or_default().push(i);
        }
    }
    for (k, t_pos) in &t_keys {
        if t_pos.len() == 1 {
            if let Some(b_pos) = b_keys.get(k) {
                if b_pos.len() == 1 {
                    pairs.push((t_pos[0], b_pos[0]));
                }
            }
        }
    }

    // 值锚点：可锚定指纹在两侧各出现 ≤2 次且次数相等，按出现次序配对。
    let mut t_fingers: HashMap<&Finger, Vec<usize>> = HashMap::new();
    for (i, item) in t.iter().enumerate() {
        if item.finger.anchorable() {
            t_fingers.entry(&item.finger).or_default().push(i);
        }
    }
    let mut b_fingers: HashMap<&Finger, Vec<usize>> = HashMap::new();
    for (i, item) in b.iter().enumerate() {
        if item.finger.anchorable() {
            b_fingers.entry(&item.finger).or_default().push(i);
        }
    }
    for (f, t_pos) in &t_fingers {
        if t_pos.len() <= 2 {
            if let Some(b_pos) = b_fingers.get(f) {
                if b_pos.len() == t_pos.len() {
                    for (&ti, &bi) in t_pos.iter().zip(b_pos.iter()) {
                        pairs.push((ti, bi));
                    }
                }
            }
        }
    }

    pairs.sort_unstable();
    // 保持双侧单调递增，冲突的锚点丢弃（保守）。
    let mut result = Vec::with_capacity(pairs.len());
    let mut last: Option<(usize, usize)> = None;
    for (ti, bi) in pairs {
        match last {
            Some((lti, lbi)) if ti <= lti || bi <= lbi => continue,
            _ => {
                result.push((ti, bi));
                last = Some((ti, bi));
            }
        }
    }
    result
}

/// 对齐一个对象层级。
fn align_level(
    t: &[TextItem],
    b: &[BinItem],
    tokens: &[TextToken],
    bin_data: &[u8],
    out: &mut PairOutcome,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("max nesting depth exceeded".into());
    }

    let anchors = find_anchors(t, b);
    out.anchor_pairs += anchors.len() as u64;

    let mut prev_t = 0usize;
    let mut prev_b = 0usize;
    for &(ai, bi) in &anchors {
        align_window(&t[prev_t..ai], &b[prev_b..bi], tokens, bin_data, out, depth)?;
        pair_items(&t[ai], &b[bi], tokens, bin_data, out, depth)?;
        prev_t = ai + 1;
        prev_b = bi + 1;
    }
    align_window(&t[prev_t..], &b[prev_b..], tokens, bin_data, out, depth)
}

/// 对齐锚点之间（或首尾之外）的窗口。
fn align_window(
    t: &[TextItem],
    b: &[BinItem],
    tokens: &[TextToken],
    bin_data: &[u8],
    out: &mut PairOutcome,
    depth: usize,
) -> Result<(), String> {
    if t.is_empty() && b.is_empty() {
        return Ok(());
    }
    if t.len() == b.len() {
        for (ti, bi) in t.iter().zip(b.iter()) {
            // 两侧都是可锚定标量但指纹不等：错位证据，不猜。
            if ti.finger.anchorable() && bi.finger.anchorable() && ti.finger != bi.finger {
                out.ambiguous_windows += 1;
                out.ambiguous_items += 1;
                continue;
            }
            pair_items(ti, bi, tokens, bin_data, out, depth)?;
        }
        return Ok(());
    }
    if t.len().max(b.len()) <= LCS_WINDOW_MAX {
        align_window_lcs(t, b, tokens, bin_data, out, depth)
    } else {
        align_window_greedy(t, b, tokens, bin_data, out, depth)
    }
}

/// 不等长小窗口：基于标量指纹/key 的 LCS。
fn align_window_lcs(
    t: &[TextItem],
    b: &[BinItem],
    tokens: &[TextToken],
    bin_data: &[u8],
    out: &mut PairOutcome,
    depth: usize,
) -> Result<(), String> {
    let n = t.len();
    let m = b.len();
    // dp[i][j] = t[..i] 与 b[..j] 的 LCS 长度。
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            dp[i][j] = if items_match(&t[i - 1], &b[j - 1]) {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }
    let mut matched = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        if items_match(&t[i - 1], &b[j - 1]) && dp[i][j] == dp[i - 1][j - 1] + 1 {
            matched.push((i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    matched.reverse();
    let matched_set_t: Vec<bool> = {
        let mut v = vec![false; n];
        for &(ti, _) in &matched {
            v[ti] = true;
        }
        v
    };
    let matched_set_b: Vec<bool> = {
        let mut v = vec![false; m];
        for &(_, bi) in &matched {
            v[bi] = true;
        }
        v
    };
    let unmatched = matched_set_t.iter().filter(|&&x| !x).count()
        + matched_set_b.iter().filter(|&&x| !x).count();
    if unmatched > 0 {
        out.ambiguous_windows += 1;
        out.ambiguous_items += unmatched as u64;
    }
    for (ti, bi) in matched {
        pair_items(&t[ti], &b[bi], tokens, bin_data, out, depth)?;
    }
    Ok(())
}

/// 不等长大窗口：窗口内唯一指纹/key 贪心配对，其余 ambiguous。
fn align_window_greedy(
    t: &[TextItem],
    b: &[BinItem],
    tokens: &[TextToken],
    bin_data: &[u8],
    out: &mut PairOutcome,
    depth: usize,
) -> Result<(), String> {
    // 以可匹配标识（key 或锚定指纹）在窗口内两侧各出现一次为条件配对。
    let mut t_count: HashMap<Ident, Vec<usize>> = HashMap::new();
    for (i, item) in t.iter().enumerate() {
        if let Some(id) = ident_of_t(item) {
            t_count.entry(id).or_default().push(i);
        }
    }
    let mut b_count: HashMap<Ident, Vec<usize>> = HashMap::new();
    for (i, item) in b.iter().enumerate() {
        if let Some(id) = ident_of_b(item) {
            b_count.entry(id).or_default().push(i);
        }
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for (id, t_pos) in &t_count {
        if t_pos.len() == 1 {
            if let Some(b_pos) = b_count.get(id) {
                if b_pos.len() == 1 {
                    pairs.push((t_pos[0], b_pos[0]));
                }
            }
        }
    }
    pairs.sort_unstable();
    let mut last: Option<(usize, usize)> = None;
    let mut matched_t = vec![false; t.len()];
    let mut matched_b = vec![false; b.len()];
    for (ti, bi) in pairs {
        match last {
            Some((lti, lbi)) if ti <= lti || bi <= lbi => continue,
            _ => {
                matched_t[ti] = true;
                matched_b[bi] = true;
                last = Some((ti, bi));
                pair_items(&t[ti], &b[bi], tokens, bin_data, out, depth)?;
            }
        }
    }
    let unmatched = matched_t.iter().filter(|&&x| !x).count()
        + matched_b.iter().filter(|&&x| !x).count();
    if unmatched > 0 {
        out.ambiguous_windows += 1;
        out.ambiguous_items += unmatched as u64;
    }
    Ok(())
}

/// 大窗口贪心的可匹配标识：Int/Str key 或可锚定指纹。
#[derive(Hash, PartialEq, Eq)]
enum Ident<'a> {
    Key(&'a Key),
    Finger(&'a Finger),
}

fn ident_of_t(item: &TextItem) -> Option<Ident<'_>> {
    match &item.key {
        Some(k @ (Key::Int(_) | Key::Str(_))) => Some(Ident::Key(k)),
        _ if item.finger.anchorable() => Some(Ident::Finger(&item.finger)),
        _ => None,
    }
}

fn ident_of_b(item: &BinItem) -> Option<Ident<'_>> {
    match &item.key {
        Some(k @ (Key::Int(_) | Key::Str(_))) => Some(Ident::Key(k)),
        _ if item.finger.anchorable() => Some(Ident::Finger(&item.finger)),
        _ => None,
    }
}

/// 对齐成功的一对 item：记录候选映射并按需递归子容器。
fn pair_items(
    t: &TextItem,
    b: &BinItem,
    tokens: &[TextToken],
    bin_data: &[u8],
    out: &mut PairOutcome,
    depth: usize,
) -> Result<(), String> {
    out.aligned_items += 1;

    // token key ↔ 文本 key。
    if let (Some(Key::Str(name)), Some(Key::Token(tok))) = (&t.key, &b.key) {
        out.vote_token(*tok, name);
    }

    // 文本字符串值 ↔ 二进制 lookup 索引。
    if let Some(index) = b.lookup {
        if let Finger::Str(s) = &t.finger {
            out.vote_lookup(index, s);
        }
    }

    // 文本字符串值 ↔ 二进制值位置 token（与 key 同一张表）。
    if let Some(tok) = b.value_token {
        if let Finger::Str(s) = &t.finger {
            out.vote_token(tok, s);
        }
    }

    // 两侧都是容器 → 递归对齐子层级。
    if let (Some((cs, ce)), Some((bs, be))) = (t.range, b.range) {
        let mode = match tokens.get(cs) {
            Some(TextToken::Object { .. }) => Mode::Object,
            Some(TextToken::Array { .. }) => Mode::Array,
            _ => return Ok(()),
        };
        let t_child = walk_text_level(tokens, cs + 1, ce, mode);
        let child_data = &bin_data[bs..be];
        let b_child = walk_bin_level(child_data)?;
        // 注意：子层级 range 相对于 child_data，递归时必须把它传下去。
        align_level(&t_child, &b_child, tokens, child_data, out, depth + 1)?;
    }
    Ok(())
}
