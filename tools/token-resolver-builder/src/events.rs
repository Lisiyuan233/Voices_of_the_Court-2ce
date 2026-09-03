//! 统一事件流两侧的 Item 抽象与 walker。
//!
//! 明文侧 walker 基于保序的 `TextTape`，二进制侧 walker 基于 `binary::Lexer`。
//! 两侧都把「一个对象层级」展开为保序的 item 序列：每个 item 带 key 表示
//! （token / 整数 id / 字符串）、保守的值指纹、以及子容器的引用区间。
//!
//! 值指纹的锚定策略（保守，宁可不锚也不错锚）：
//! - 可锚定：整数（二进制 u32/u64/i32/i64 与文本整数精确相等）、布尔
//!   （文本 yes/no）、字符串（内容相等）。
//! - 不可锚定（`Finger::None`）：浮点（文本 "0.175000" vs 二进制 f32 位）、
//!   日期（文本 "1067.1.1" vs 二进制天数 i32，表示不一致）、RGB、
//!   lookup 索引、值位置的 token id。

use jomini::binary::{Lexer, LexemeId, Token};
use jomini::text::TextToken;

/// 字段 key 的统一表示。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// 二进制 16bit token（仅二进制侧）。
    Token(u16),
    /// 整数 id key（如 `living_characters` 下的角色 id）。
    Int(i128),
    /// 字符串 key。
    Str(String),
}

/// 保守的值指纹。只有 `Int` / `Bool` / `Str` 参与锚点匹配。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Finger {
    /// 不可锚定（浮点、日期、RGB、lookup、token 值等）。
    None,
    Int(i128),
    Bool(bool),
    Str(String),
    /// 容器（对象或数组），仅记结构标记。
    Group,
}

impl Finger {
    pub fn anchorable(&self) -> bool {
        matches!(self, Finger::Int(_) | Finger::Bool(_) | Finger::Str(_))
    }
}

/// 容器层级模式：对象（key=value 交替）或数组（纯值序列）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Object,
    Array,
}

/// 明文侧一个对象层级的 item。
#[derive(Clone, Debug)]
pub struct TextItem {
    /// `None` 表示数组元素 / 无 key 值。
    pub key: Option<Key>,
    pub finger: Finger,
    /// 标量值的原始文本（解码后），供验证与 lookup 表使用。
    pub value_raw: Option<String>,
    /// 子容器在 tape 中的区间 `[container_idx, end_idx]`（含 `End` token）。
    pub range: Option<(usize, usize)>,
}

/// 二进制侧一个对象层级的 item。
#[derive(Clone, Debug)]
pub struct BinItem {
    pub key: Option<Key>,
    pub finger: Finger,
    /// 值为 lookup 索引（LookupU8/U16/U24/U32）时记录。
    pub lookup: Option<u32>,
    /// 值为 token id 时记录（token 也可出现在值位置，复用同一张表）。
    pub value_token: Option<u16>,
    /// 值为 RGB 时记录分量数（3 或 4）；文本侧等价物是 3/4 个元素的数组。
    pub rgb: Option<u8>,
    /// 子容器 body 在当前字节切片中的区间 `[start, end)`（不含开闭括号）。
    pub range: Option<(usize, usize)>,
}

pub fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// 判断文本标量是否形如日期（"1067.1.1"、"1.19.0.6"）：点分隔的 3+ 段数字。
pub fn is_date_like(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 把文本日期 key（"1066.1.1"[.hour]）转换为二进制存档中的小时计数 key。
///
/// 二进制日期编码（与 jomini `ExpandedRawDate::from_binary` 互逆）：
/// `hours = ((year + 5000) * 365 + day_of_year0) * 24 + hour0`，
/// 其中 day_of_year0 为 1 月 1 日起的 0 基天数（无闰年），hour0 为 0 基小时
/// （文本无小时部分时为 0；文本小时 H 对应二进制 H-1）。
pub fn date_to_binary_hours(s: &str) -> Option<i64> {
    const MONTH_DAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 3 || parts.len() > 4 {
        return None;
    }
    let year: i64 = parts[0].parse().ok()?;
    let year = if neg { -year } else { year };
    let month: i64 = parts[1].parse().ok()?;
    let day: i64 = parts[2].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let hour0 = match parts.get(3) {
        Some(h) => {
            let h: i64 = h.parse().ok()?;
            if !(1..=24).contains(&h) {
                return None;
            }
            h - 1
        }
        None => 0,
    };
    let doy0: i64 = MONTH_DAYS[..(month - 1) as usize].iter().sum::<i64>() + (day - 1);
    Some(((year + 5000) * 365 + doy0) * 24 + hour0)
}

/// 文本标量 → (指纹, 原始字符串)。
fn text_finger(raw: &[u8], quoted: bool) -> (Finger, String) {
    let s = decode(raw);
    if !quoted {
        if s == "yes" {
            return (Finger::Bool(true), s);
        }
        if s == "no" {
            return (Finger::Bool(false), s);
        }
        if let Ok(i) = s.parse::<i64>() {
            return (Finger::Int(i as i128), s);
        }
        if let Ok(u) = s.parse::<u64>() {
            return (Finger::Int(u as i128), s);
        }
        // 浮点（"0.175000"、"1e5"）：不可靠，不参与锚定。
        if s.parse::<f64>().is_ok() && s.bytes().any(|b| b == b'.' || b == b'e' || b == b'E') {
            return (Finger::None, s);
        }
    }
    // 日期类：文本与二进制表示不一致，不参与锚定。
    if is_date_like(&s) {
        return (Finger::None, s);
    }
    (Finger::Str(s.clone()), s)
}

/// 文本 key 标量 → Key。整数字符串归为 Int（对应二进制的整数 key）。
fn text_key(raw: &[u8]) -> Key {
    let s = decode(raw);
    if let Ok(i) = s.parse::<i64>() {
        Key::Int(i as i128)
    } else if let Ok(u) = s.parse::<u64>() {
        Key::Int(u as i128)
    } else {
        Key::Str(s)
    }
}

fn container_range(tokens: &[TextToken], i: usize) -> Option<(usize, usize)> {
    match tokens.get(i) {
        Some(TextToken::Object { end, .. }) | Some(TextToken::Array { end, .. }) => Some((i, *end)),
        _ => None,
    }
}

/// 把 tape 的一个层级 `[start, end)` 展开为保序 item 序列。
/// `end` 是 `End` token 的索引（或根层的 `tokens.len()`）。
///
/// 混合容器（mixed container）：`MixedContainer` token 处翻转模式
/// （数组头 ↔ 对象尾）。二进制侧的对应编码是「裸值为普通数组元素 +
/// 有 key 的为 key=value」，与文本侧结构一致，无需特殊处理。
pub fn walk_text_level(tokens: &[TextToken], mut i: usize, end: usize, mode: Mode) -> Vec<TextItem> {
    let mut items = Vec::new();
    let mut mode = mode;
    while i < end {
        match &tokens[i] {
            // 混合容器分界：数组头 ↔ 对象尾（或反之），翻转模式。
            TextToken::MixedContainer => {
                mode = match mode {
                    Mode::Object => Mode::Array,
                    Mode::Array => Mode::Object,
                };
                i += 1;
            }
            TextToken::Operator(_) | TextToken::End(_) => {
                i += 1;
            }
            TextToken::Object { .. } | TextToken::Array { .. } => {
                let range = container_range(tokens, i);
                items.push(TextItem {
                    key: None,
                    finger: Finger::Group,
                    value_raw: None,
                    range,
                });
                i = range.map(|(_, e)| e + 1).unwrap_or(i + 1);
            }
            TextToken::Header(_) => {
                // `key = rgb { ... }` 的 header：值是紧随其后的容器。
                if let Some(range) = container_range(tokens, i + 1) {
                    items.push(TextItem {
                        key: None,
                        finger: Finger::Group,
                        value_raw: None,
                        range: Some(range),
                    });
                    i = range.1 + 1;
                } else {
                    i += 1;
                }
            }
            scalar => {
                let raw = scalar.as_scalar().map(|s| s.as_bytes()).unwrap_or(&[]);
                if mode == Mode::Object {
                    let key = Some(text_key(raw));
                    // 跳过 key 与 value 之间的非等号 operator（存档中基本只有 `=`）。
                    let mut j = i + 1;
                    while j < end && matches!(tokens[j], TextToken::Operator(_)) {
                        j += 1;
                    }
                    let (finger, value_raw, range, next) = if j >= end
                        || matches!(tokens[j], TextToken::End(_) | TextToken::MixedContainer)
                    {
                        (Finger::None, None, None, i + 1)
                    } else {
                        match &tokens[j] {
                            TextToken::Object { .. } | TextToken::Array { .. } => {
                                let range = container_range(tokens, j);
                                (Finger::Group, None, range, range.map(|(_, e)| e + 1).unwrap_or(j + 1))
                            }
                            TextToken::Header(_) => {
                                if let Some(range) = container_range(tokens, j + 1) {
                                    (Finger::Group, None, Some(range), range.1 + 1)
                                } else {
                                    (Finger::None, None, None, j + 1)
                                }
                            }
                            s2 => {
                                let b = s2.as_scalar().map(|x| x.as_bytes()).unwrap_or(&[]);
                                let quoted = matches!(s2, TextToken::Quoted(_));
                                let (f, r) = text_finger(b, quoted);
                                (f, Some(r), None, j + 1)
                            }
                        }
                    };
                    items.push(TextItem {
                        key,
                        finger,
                        value_raw,
                        range,
                    });
                    i = next;
                } else {
                    let quoted = matches!(scalar, TextToken::Quoted(_));
                    let (f, r) = text_finger(raw, quoted);
                    items.push(TextItem {
                        key: None,
                        finger: f,
                        value_raw: Some(r),
                        range: None,
                    });
                    i += 1;
                }
            }
        }
    }
    items
}

/// 读取一个值（key 之后、等号已消费），返回完整的 BinItem。
fn read_bin_value(lexer: &mut Lexer, key: Option<Key>) -> Result<BinItem, String> {
    let tok = lexer.read_token().map_err(|e| e.to_string())?;
    let mut item = BinItem {
        key,
        finger: Finger::None,
        lookup: None,
        value_token: None,
        rgb: None,
        range: None,
    };
    match tok {
        Token::Open => {
            item.range = Some(scan_group(lexer)?);
            item.finger = Finger::Group;
        }
        Token::U32(x) => item.finger = Finger::Int(x as i128),
        Token::U64(x) => item.finger = Finger::Int(x as i128),
        Token::I32(x) => item.finger = Finger::Int(x as i128),
        Token::I64(x) => item.finger = Finger::Int(x as i128),
        Token::Bool(b) => item.finger = Finger::Bool(b),
        Token::Quoted(s) | Token::Unquoted(s) => item.finger = Finger::Str(decode(s.as_bytes())),
        Token::F32(_) | Token::F64(_) => {}
        Token::Rgb(rgb) => item.rgb = Some(if rgb.a.is_some() { 4 } else { 3 }),
        Token::Lookup(i) => item.lookup = Some(i),
        Token::Id(t) => item.value_token = Some(t),
        Token::Equal | Token::Close => {
            return Err(format!("unexpected {tok:?} in value position"));
        }
    }
    Ok(item)
}

/// 消费一个开组后的 body（深度扫描到匹配的闭组），返回 body 字节区间。
fn scan_group(lexer: &mut Lexer) -> Result<(usize, usize), String> {
    let start = lexer.position();
    let mut depth = 1u32;
    while depth > 0 {
        match lexer.read_token().map_err(|e| e.to_string())? {
            Token::Open => depth += 1,
            Token::Close => depth -= 1,
            _ => {}
        }
    }
    // 闭组 token 占 2 字节。
    Ok((start, lexer.position() - 2))
}

/// 把二进制数据的一个层级展开为保序 item 序列。
/// `data` 应正好是该层级的 body（根层为整个 gamestate）。
pub fn walk_bin_level(data: &[u8]) -> Result<Vec<BinItem>, String> {
    let mut lexer = Lexer::new(data);
    let mut items = Vec::new();
    loop {
        match lexer.peek_id() {
            None => break,
            // body 区间不含闭组；遇到说明数据异常，容错结束本层。
            Some(LexemeId::CLOSE) => break,
            _ => {}
        }
        let tok = lexer
            .read_token()
            .map_err(|e| format!("{e} (level_len={})", data.len()))?;
        let is_equal_next = lexer.peek_id() == Some(LexemeId::EQUAL);
        match tok {
            Token::Open => {
                let range = scan_group(&mut lexer)?;
                items.push(BinItem {
                    key: None,
                    finger: Finger::Group,
                    lookup: None,
                    value_token: None,
                    rgb: None,
                    range: Some(range),
                });
            }
            Token::Close => break,
            Token::Equal => return Err("unexpected Equal at level start".into()),
            Token::Id(t) => {
                if is_equal_next {
                    lexer.read_token().map_err(|e| e.to_string())?;
                    items.push(read_bin_value(&mut lexer, Some(Key::Token(t)))?);
                } else {
                    items.push(BinItem {
                        key: None,
                        finger: Finger::None,
                        lookup: None,
                        value_token: Some(t),
                        rgb: None,
                        range: None,
                    });
                }
            }
            Token::U32(x) if is_equal_next => {
                lexer.read_token().map_err(|e| e.to_string())?;
                items.push(read_bin_value(&mut lexer, Some(Key::Int(x as i128)))?);
            }
            Token::U64(x) if is_equal_next => {
                lexer.read_token().map_err(|e| e.to_string())?;
                items.push(read_bin_value(&mut lexer, Some(Key::Int(x as i128)))?);
            }
            Token::I32(x) if is_equal_next => {
                lexer.read_token().map_err(|e| e.to_string())?;
                items.push(read_bin_value(&mut lexer, Some(Key::Int(x as i128)))?);
            }
            Token::I64(x) if is_equal_next => {
                lexer.read_token().map_err(|e| e.to_string())?;
                items.push(read_bin_value(&mut lexer, Some(Key::Int(x as i128)))?);
            }
            Token::U32(x) => items.push(scalar_bin_item(Finger::Int(x as i128))),
            Token::U64(x) => items.push(scalar_bin_item(Finger::Int(x as i128))),
            Token::I32(x) => items.push(scalar_bin_item(Finger::Int(x as i128))),
            Token::I64(x) => items.push(scalar_bin_item(Finger::Int(x as i128))),
            Token::Bool(b) => items.push(scalar_bin_item(Finger::Bool(b))),
            Token::Quoted(s) | Token::Unquoted(s) => {
                if is_equal_next {
                    lexer.read_token().map_err(|e| e.to_string())?;
                    items.push(read_bin_value(&mut lexer, Some(Key::Str(decode(s.as_bytes()))))?);
                } else {
                    items.push(scalar_bin_item(Finger::Str(decode(s.as_bytes()))));
                }
            }
            Token::F32(_) | Token::F64(_) => {
                items.push(scalar_bin_item(Finger::None));
            }
            Token::Rgb(rgb) => {
                let mut item = scalar_bin_item(Finger::None);
                item.rgb = Some(if rgb.a.is_some() { 4 } else { 3 });
                items.push(item);
            }
            Token::Lookup(i) => items.push(BinItem {
                key: None,
                finger: Finger::None,
                lookup: Some(i),
                value_token: None,
                rgb: None,
                range: None,
            }),
        }
    }
    Ok(items)
}

fn scalar_bin_item(finger: Finger) -> BinItem {
    BinItem {
        key: None,
        finger,
        lookup: None,
        value_token: None,
        rgb: None,
        range: None,
    }
}
