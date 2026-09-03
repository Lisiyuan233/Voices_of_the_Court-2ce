//! Identity 提取（实施计划 Task 3 步骤 4/6）。
//!
//! 从已验证的 text gamestate 流中做**有界、可提前停止**的扫描，提取：
//!
//! - root `meta_data` 块内的 `version`（CK3 版本）与玩家角色 ID；
//! - root numeric `date`；
//! - root `variables` 块内白名单 campaign raw 值；
//! - `living.<played_character>.alive_data.variables` 内的 snapshot raw 值。
//!
//! Task 0 实机确认 snapshot protocol/sequence/slot 位于玩家记录，且零值 slot
//! 会保留 `type=value` 但省略 `identity`。扫描因此分两遍：第一遍只找 root
//! identity/campaign 字段，第二遍用已确认的 played_character ID 定向进入玩家记录；
//! 不读取或输出其他角色的变量。
//!
//! 数值解码：raw → checked fixed point → integer。scale **不凭经验硬编码**：
//! 由 `votc_save_snapshot_protocol` 的 raw 值推导（protocol 语义恒为 1，
//! 故 scale = raw_protocol），再校验所有 raw 都能被该 scale 整除；
//! protocol raw 为 0（mod 已清除/未启用）时 scale 不可推导，
//! `scriptVariableScale` 置空并给 warning。Task 0 已确认真实 scale=100000，
//! 但实现仍从 protocol raw 推导，不硬编码。
//!
//! 提前停止：root identity/campaign 齐全后停止第一遍，玩家 snapshot 三元组齐全后
//! 停止第二遍；两遍实际消费字节之和计入返回值。

use std::io::Read;

use crate::protocol::{Identity, Warning};

// ---- 兼容结构常量；真实路径结论见 tests/fixtures/README.md ----

/// 旧合成 fixture 的 meta_data 玩家 ID key；真实 1.19 存档使用 played_character。
const META_PLAYER_ID_KEY: &[u8] = b"meta_player_id";
/// meta_data 块内 CK3 版本的 key（ck3save 已验证存在 version 字段）。
const META_VERSION_KEY: &[u8] = b"version";

/// 白名单变量 flag。root scanner 继续接受旧 fixture 中的七项 root 变量；真实
/// snapshot 三元组只从目标玩家的 alive_data.variables 补齐。
const VAR_FLAGS: [&[u8]; 7] = [
    b"votc_campaign_id_a",
    b"votc_campaign_id_b",
    b"votc_campaign_id_c",
    b"votc_campaign_id_d",
    b"votc_save_snapshot_protocol",
    b"votc_save_snapshot_sequence",
    b"votc_save_snapshot_slot",
];

const SNAPSHOT_VAR_START: usize = 4;

/// 已验证支持的 CK3 版本前缀（假定列表，随实机验证维护）。
/// 未知版本仍可 probe，但给 warning，不宣称完全支持。
const RECOGNIZED_CK3_VERSION_PREFIXES: [&str; 7] =
    ["1.13", "1.14", "1.15", "1.16", "1.17", "1.18", "1.19"];

/// CK3 日历每月天数（假定：固定 365 天年、2 月恒 28 天，待 Task 0 确认；
/// gameDateNumeric 需与 mod 端 GetDateAsTotalDays 对齐验证）。
const MONTH_DAYS: [u64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// warning codes（5.4 节 warnings 元素为自由 code 字符串）
pub const WARN_VERSION_MISSING: &str = "CK3_VERSION_MISSING";
pub const WARN_VERSION_UNRECOGNIZED: &str = "CK3_VERSION_UNRECOGNIZED";
pub const WARN_PLAYER_ID_MISSING: &str = "PLAYER_ID_MISSING";
pub const WARN_GAME_DATE_MISSING: &str = "GAME_DATE_MISSING";
pub const WARN_VOTC_VARIABLES_MISSING: &str = "VOTC_VARIABLES_MISSING";
pub const WARN_CAMPAIGN_PARTS_MISSING: &str = "CAMPAIGN_PARTS_MISSING";
pub const WARN_SNAPSHOT_PARTS_MISSING: &str = "SNAPSHOT_PARTS_MISSING";
pub const WARN_SCALE_UNDETERMINED: &str = "SCALE_UNDETERMINED";
/// root `variables.list` 中 `votc_join_candidates` 列表存在但畸形/超限：
/// 整列表丢弃（degrade 仅 candidates 字段，不失败整个 identity extract）。
pub const WARN_JOIN_CANDIDATES_INVALID: &str = "JOIN_CANDIDATES_INVALID";

/// root `variables.list` 中唯一被识别并提取的全局列表名（Plan C Task 2b）。
const JOIN_CANDIDATES_LIST_NAME: &[u8] = b"votc_join_candidates";

#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    /// gamestate（解压后）流字节预算。
    pub max_bytes: u64,
    /// 嵌套深度上限。
    pub max_nesting: u32,
    /// 单个 scalar/string 上限。
    pub max_scalar: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    /// 结构未闭合 / token 未完结时遇到 EOF。
    Truncated,
    /// 非法值：余数、负数、溢出、非法日期、非法 raw、非 UTF-8 version 等。
    ParseFailed,
    /// 字节 / 嵌套 / scalar 超限。
    LimitExceeded,
    /// 底层 IO 错误（含 ZIP CRC 错误）。
    Io,
}

pub struct IdentityExtraction {
    pub identity: Identity,
    pub ck3_version: Option<String>,
    pub warnings: Vec<Warning>,
    /// 实际从 gamestate 流消费的字节数（probe 提前停止时 < 总长）。
    pub scanned_bytes: u64,
    /// 核心 identity（version / player id / date）是否齐全。
    pub core_complete: bool,
    /// root `variables.list` 中 `votc_join_candidates` 的保序十进制 ID。
    /// 列表缺失/畸形/超限 = None（畸形/超限另带 warning）。
    pub join_candidates: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// 有界计数 reader + tokenizer
// ---------------------------------------------------------------------------

pub(crate) struct CountingReader<R> {
    inner: R,
    count: u64,
    cap: u64,
    exceeded: bool,
}

impl<R: Read> CountingReader<R> {
    fn new(inner: R, cap: u64) -> Self {
        Self {
            inner,
            count: 0,
            cap,
            exceeded: false,
        }
    }
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.exceeded {
            return Ok(0);
        }
        let remaining = self.cap.saturating_sub(self.count) as usize;
        if remaining == 0 {
            self.exceeded = true;
            return Ok(0);
        }
        let want = remaining.min(buf.len());
        let n = self.inner.read(&mut buf[..want])?;
        self.count += n as u64;
        Ok(n)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Token {
    LBrace,
    RBrace,
    Eq,
    Scalar(Vec<u8>),
    Str(Vec<u8>),
    Eof,
}

pub(crate) struct Scanner<R: Read> {
    reader: CountingReader<std::io::BufReader<R>>,
    peeked_token: Option<Token>,
    peeked_byte: Option<u8>,
    pub(crate) depth: u32,
    limits: ScanLimits,
}

impl<R: Read> Scanner<R> {
    pub(crate) fn new(inner: R, limits: ScanLimits) -> Self {
        Self {
            // BufReader 摊销单字节 tokenize 的 read 调用（真实大存档下
            // 逐字节直接读文件/解压流会慢几个数量级）。
            reader: CountingReader::new(
                std::io::BufReader::with_capacity(64 * 1024, inner),
                limits.max_bytes,
            ),
            peeked_token: None,
            peeked_byte: None,
            depth: 0,
            limits,
        }
    }

    fn next_byte(&mut self) -> Result<Option<u8>, IdentityError> {
        if let Some(b) = self.peeked_byte.take() {
            return Ok(Some(b));
        }
        let mut buf = [0u8; 1];
        let result = self.reader.read(&mut buf);
        let exceeded = self.reader.exceeded;
        let n = result.map_err(|_| {
            if exceeded {
                IdentityError::LimitExceeded
            } else {
                IdentityError::Io
            }
        })?;
        if n == 0 {
            if exceeded {
                return Err(IdentityError::LimitExceeded);
            }
            return Ok(None);
        }
        Ok(Some(buf[0]))
    }

    fn unread_byte(&mut self, b: u8) {
        self.peeked_byte = Some(b);
    }

    pub(crate) fn peek_token(&mut self) -> Result<&Token, IdentityError> {
        if self.peeked_token.is_none() {
            self.peeked_token = Some(self.read_token()?);
        }
        Ok(self.peeked_token.as_ref().unwrap())
    }

    pub(crate) fn next_token(&mut self) -> Result<Token, IdentityError> {
        if let Some(t) = self.peeked_token.take() {
            return Ok(t);
        }
        self.read_token()
    }

    fn read_token(&mut self) -> Result<Token, IdentityError> {
        // skip whitespace
        let first = loop {
            match self.next_byte()? {
                None => return Ok(Token::Eof),
                Some(b) if b.is_ascii_whitespace() => {}
                Some(b) => break b,
            }
        };
        match first {
            b'{' => {
                self.depth += 1;
                if self.depth > self.limits.max_nesting {
                    return Err(IdentityError::LimitExceeded);
                }
                Ok(Token::LBrace)
            }
            b'}' => {
                self.depth = self.depth.saturating_sub(1);
                Ok(Token::RBrace)
            }
            b'=' => Ok(Token::Eq),
            b'"' => self.read_string(),
            _ => self.read_scalar(first),
        }
    }

    fn read_scalar(&mut self, first: u8) -> Result<Token, IdentityError> {
        let mut buf = vec![first];
        loop {
            match self.next_byte()? {
                None => break,
                Some(b) if b.is_ascii_whitespace() || b == b'{' || b == b'}' || b == b'=' => {
                    if !b.is_ascii_whitespace() {
                        self.unread_byte(b);
                    }
                    break;
                }
                Some(b) => {
                    buf.push(b);
                    if buf.len() > self.limits.max_scalar {
                        return Err(IdentityError::LimitExceeded);
                    }
                }
            }
        }
        Ok(Token::Scalar(buf))
    }

    fn read_string(&mut self) -> Result<Token, IdentityError> {
        let mut buf = Vec::new();
        loop {
            match self.next_byte()? {
                None => return Err(IdentityError::Truncated), // 字符串未闭合
                Some(b'\\') => match self.next_byte()? {
                    None => return Err(IdentityError::Truncated),
                    Some(escaped) => buf.push(escaped),
                },
                Some(b'"') => break,
                Some(b) => buf.push(b),
            }
            if buf.len() > self.limits.max_scalar {
                return Err(IdentityError::LimitExceeded);
            }
        }
        Ok(Token::Str(buf))
    }

    /// 跳过一个值（scalar/string 或一对平衡花括号）。
    pub(crate) fn skip_value(&mut self) -> Result<(), IdentityError> {
        match self.next_token()? {
            Token::LBrace => self.skip_block(),
            Token::Scalar(_) | Token::Str(_) => {
                // Clausewitz 复合值：scalar 后可直接跟一个块（真实 1.19 存档
                // title 记录里的 color=rgb { 71 3 1 }），块属于该值，一并跳过。
                if self.peek_token()? == &Token::LBrace {
                    self.next_token()?;
                    self.skip_block()?;
                }
                Ok(())
            }
            // 值位置出现 = / } / EOF 都是结构损坏。
            _ => Err(IdentityError::ParseFailed),
        }
    }

    /// 跳过一对已消费 `{` 的平衡花括号块。
    fn skip_block(&mut self) -> Result<(), IdentityError> {
        let mut depth = 1u32;
        while depth > 0 {
            match self.next_token()? {
                Token::LBrace => depth += 1,
                Token::RBrace => depth -= 1,
                Token::Eof => return Err(IdentityError::Truncated),
                _ => {}
            }
        }
        Ok(())
    }

    pub(crate) fn expect_eq(&mut self) -> Result<(), IdentityError> {
        match self.next_token()? {
            Token::Eq => Ok(()),
            Token::Eof => Err(IdentityError::Truncated),
            _ => Err(IdentityError::ParseFailed),
        }
    }

    pub(crate) fn expect_lbrace(&mut self) -> Result<(), IdentityError> {
        match self.next_token()? {
            Token::LBrace => Ok(()),
            Token::Eof => Err(IdentityError::Truncated),
            _ => Err(IdentityError::ParseFailed),
        }
    }

    /// 实际从流中消费的字节数（extract 模块记录扫描量用）。
    pub(crate) fn scanned_bytes(&self) -> u64 {
        self.reader.count
    }
}

// ---------------------------------------------------------------------------
// 目标块扫描
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RawTargets {
    ck3_version: Option<String>,
    player_id: Option<String>,
    date_raw: Option<String>,
    /// 顺序对应 VAR_FLAGS。
    vars: [Option<u64>; 7],
    /// root variables 块已经见过；即使某些白名单 flag 不存在，也允许第一遍
    /// 在拿到 played_character 后结束，不必扫描存档尾部。
    root_variables_seen: bool,
    /// root `variables.list` 的 votc_join_candidates 保序十进制 ID。
    join_candidates: Option<Vec<String>>,
    /// 列表存在但畸形/超限：整列表丢弃并记 warning（仅 degrade candidates）。
    join_candidates_dropped: bool,
}

impl RawTargets {
    fn root_complete(&self) -> bool {
        self.ck3_version.is_some()
            && self.player_id.is_some()
            && self.date_raw.is_some()
            && self.root_variables_seen
    }

    fn snapshot_complete(&self) -> bool {
        self.vars[SNAPSHOT_VAR_START..].iter().all(Option::is_some)
    }
}

fn parse_raw_u64(raw: &[u8]) -> Result<u64, IdentityError> {
    // raw 必须是无符号整数文本：拒绝负号、小数、NaN、科学计数法和溢出。
    // CK3 将负 script value 序列化为 u64 回绕值；先完整接收该表示，随后由
    // fixed-point 整除/取值范围校验拒绝它，避免把合法大 raw 截断成 i64。
    let s = std::str::from_utf8(raw).map_err(|_| IdentityError::ParseFailed)?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(IdentityError::ParseFailed);
    }
    s.parse::<u64>().map_err(|_| IdentityError::ParseFailed)
}

/// 非空、全 ASCII 数字、且能表示为 u64 的十进制字节串（candidate 局内 ID）。
fn is_decimal_identity_bytes(raw: &[u8]) -> bool {
    if raw.is_empty() || !raw.iter().all(|b| b.is_ascii_digit()) {
        return false;
    }
    std::str::from_utf8(raw)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .is_some()
}

fn scan_meta_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    META_VERSION_KEY => match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            acc.ck3_version =
                                Some(String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?);
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    META_PLAYER_ID_KEY => match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            if v.is_empty() || !v.iter().all(|b| b.is_ascii_digit()) {
                                return Err(IdentityError::ParseFailed);
                            }
                            acc.player_id = Some(String::from_utf8(v).unwrap());
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// CK3 1.19 stores the active player at root as
/// `played_character={ character=<id> player=1 ... }`.  Keep accepting the
/// older synthetic/meta field above for fixture and older-save compatibility,
/// but prefer this real save field whenever it is present.
fn scan_played_character_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"character" {
                    match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            if v.is_empty() || !v.iter().all(|b| b.is_ascii_digit()) {
                                return Err(IdentityError::ParseFailed);
                            }
                            acc.player_id =
                                Some(String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?);
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_var_value_block<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Option<Vec<u8>>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut value = None;
    let mut zero_if_omitted = false;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(value.or_else(|| zero_if_omitted.then(|| b"0".to_vec()))),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"identity" || key == b"value" {
                    match scanner.next_token()? {
                        // Do not parse yet: character variable blocks contain many
                        // unrelated typed values. Only a whitelisted flag may turn
                        // this scalar into a protocol raw number at entry end.
                        Token::Scalar(v) | Token::Str(v) => value = Some(v),
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else if key == b"type" {
                    match scanner.next_token()? {
                        Token::Scalar(v) | Token::Str(v) => {
                            zero_if_omitted = v == b"value" || v == b"integer";
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_var_entry<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
    first_allowed: usize,
) -> Result<(), IdentityError> {
    // entry 形如 { flag="name" data={ type=integer value=<raw> } }，
    // flag/data 顺序不假设，entry 结束时按 flag 名归位。
    let mut flag: Option<Vec<u8>> = None;
    let mut value: Option<Vec<u8>> = None;
    loop {
        match scanner.next_token()? {
            Token::RBrace => {
                if let (Some(name), Some(raw)) = (flag, value) {
                    if let Some(idx) = VAR_FLAGS.iter().position(|f| f == &name.as_slice()) {
                        if idx >= first_allowed {
                            acc.vars[idx] = Some(parse_raw_u64(&raw)?); // 重复 flag：后者覆盖
                        }
                    }
                }
                return Ok(());
            }
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"flag" => match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => flag = Some(v),
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    b"data" => value = scan_var_value_block(scanner)?,
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

// ---------------------------------------------------------------------------
// root variables.list 有界解析（Plan C Task 2b：votc_join_candidates）
// ---------------------------------------------------------------------------
//
// 真实存档序列化（已实证）：root `variables` 块内 `list=` 是匿名 entry 列表，
// 每个 entry 形如 `{ name="<listName>" item={ type=char identity=<十进制> } ... }`，
// 数组序 = 插入顺序。只对名字恰好为 `votc_join_candidates` 的列表做语义解析；
// 其余列表名一律整条跳过。条目必须全部 `type=char` + 十进制 identity，≤512 条；
// 任一畸形/超限 → 整列表丢弃（None + JOIN_CANDIDATES_INVALID warning），
// 仅 degrade candidates 字段，不失败整个 identity extract。结构性损坏（EOF /
// token 级畸形）仍按 IdentityError 传播。

/// 解析一个 `item={ type=char identity=<decimal> }` 块。语义合法返回
/// `Ok(Some(十进制ID字符串))`；`type` 非 char / identity 非十进制 / 字段缺失
/// 返回 `Ok(None)`（由调用方决定整列表丢弃）。结构损坏返回 `Err`。
fn scan_list_item_block<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Option<String>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut kind: Option<Vec<u8>> = None;
    let mut identity: Option<Vec<u8>> = None;
    loop {
        match scanner.next_token()? {
            Token::RBrace => break,
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"type" {
                    match scanner.next_token()? {
                        Token::Scalar(v) | Token::Str(v) => kind = Some(v),
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else if key == b"identity" {
                    match scanner.next_token()? {
                        Token::Scalar(v) | Token::Str(v) => identity = Some(v),
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
    match (kind.as_deref(), identity) {
        (Some(b"char"), Some(raw)) if is_decimal_identity_bytes(&raw) => {
            let id = String::from_utf8(raw).map_err(|_| IdentityError::ParseFailed)?;
            Ok(Some(id))
        }
        _ => Ok(None),
    }
}

/// 解析 `list=` 块内的一个命名列表 entry。CK3 序列化保证 `name` 最先出现；
/// 名字不是 `votc_join_candidates` 时整条跳过（item 一律 skip_value）。
fn scan_named_list_entry<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<(), IdentityError> {
    // 调用方（scan_variables_list_block）已消费 entry 的 `{`，与 scan_var_entry
    // 约定一致；本函数只消费 entry 内部并停在 entry 的 `}`。
    let mut is_target = false;
    let mut items: Vec<String> = Vec::new();
    let mut dropped = false;
    loop {
        match scanner.next_token()? {
            Token::RBrace => break,
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"name" {
                    match scanner.next_token()? {
                        Token::Scalar(v) | Token::Str(v) => {
                            is_target = v == JOIN_CANDIDATES_LIST_NAME;
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    }
                } else if key == b"item" {
                    if !is_target || dropped {
                        // 非目标列表 / 已判定畸形：保持括号平衡即可。
                        scanner.skip_value()?;
                    } else if items.len() >= crate::limits::HARD_MAX_JOIN_CANDIDATES {
                        dropped = true;
                        scanner.skip_value()?;
                    } else if scanner.peek_token()? == &Token::LBrace {
                        match scan_list_item_block(scanner)? {
                            Some(id) => items.push(id),
                            None => dropped = true,
                        }
                    } else {
                        return Err(IdentityError::ParseFailed);
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
    if is_target {
        if dropped {
            acc.join_candidates = None;
            acc.join_candidates_dropped = true;
        } else {
            acc.join_candidates = Some(items);
        }
    }
    Ok(())
}

/// 解析 `variables` 块内的 `list={ ... }` 子块（匿名 entry 列表）。
fn scan_variables_list_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::LBrace => scan_named_list_entry(scanner, acc)?,
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_variables_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
    first_allowed: usize,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"data" && scanner.peek_token()? == &Token::LBrace {
                    // data={ {flag=...} {flag=...} ... }：匿名 entry 列表。
                    scanner.expect_lbrace()?;
                    loop {
                        match scanner.next_token()? {
                            Token::RBrace => break,
                            Token::Eof => return Err(IdentityError::Truncated),
                            Token::LBrace => scan_var_entry(scanner, acc, first_allowed)?,
                            _ => return Err(IdentityError::ParseFailed),
                        }
                    }
                } else if key == b"list"
                    && first_allowed == 0
                    && scanner.peek_token()? == &Token::LBrace
                {
                    // 只从 root variables（first_allowed == 0）提取候选列表；
                    // alive_data 路径（first_allowed == SNAPSHOT_VAR_START）
                    // 一律跳过，与“候选只存于 root”契约一致。
                    scan_variables_list_block(scanner, acc)?;
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// Scan only the target player's `alive_data.variables` block. Returning early
/// after the snapshot triple is intentional: the second reader is independent,
/// so the remainder of `living` does not need to be balanced or consumed.
fn scan_alive_data_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<bool, IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(acc.snapshot_complete()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"variables" {
                    scan_variables_block(scanner, acc, SNAPSHOT_VAR_START)?;
                    if acc.snapshot_complete() {
                        return Ok(true);
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_target_character_block<R: Read>(
    scanner: &mut Scanner<R>,
    acc: &mut RawTargets,
) -> Result<bool, IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(acc.snapshot_complete()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"alive_data" {
                    if scan_alive_data_block(scanner, acc)? {
                        return Ok(true);
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_living_block<R: Read>(
    scanner: &mut Scanner<R>,
    target_player_id: &[u8],
    acc: &mut RawTargets,
) -> Result<bool, IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(false),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(character_id) | Token::Str(character_id) => {
                scanner.expect_eq()?;
                if character_id == target_player_id {
                    // The target record is authoritative even when the protocol
                    // flags are intentionally absent. Stop here rather than
                    // treating the remaining character entries as root fields.
                    scan_target_character_block(scanner, acc)?;
                    return Ok(true);
                }
                scanner.skip_value()?;
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

fn scan_player_snapshot<R: Read>(
    reader: R,
    limits: ScanLimits,
    target_player_id: &[u8],
    acc: &mut RawTargets,
) -> Result<u64, IdentityError> {
    let mut scanner = Scanner::new(reader, limits);
    loop {
        match scanner.next_token()? {
            Token::Eof => {
                if scanner.depth != 0 {
                    return Err(IdentityError::Truncated);
                }
                break;
            }
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"living" {
                    if scan_living_block(&mut scanner, target_player_id, acc)? {
                        break;
                    }
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
    Ok(scanner.scanned_bytes())
}

// ---------------------------------------------------------------------------
// 数值解码与 identity 组装
// ---------------------------------------------------------------------------

fn parse_game_date(raw: &str) -> Result<u64, IdentityError> {
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() != 3 {
        return Err(IdentityError::ParseFailed);
    }
    let mut nums = [0u64; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(IdentityError::ParseFailed);
        }
        nums[i] = p.parse::<u64>().map_err(|_| IdentityError::ParseFailed)?;
    }
    let (y, m, d) = (nums[0], nums[1], nums[2]);
    if y == 0 || !(1..=12).contains(&m) {
        return Err(IdentityError::ParseFailed);
    }
    let month_idx = (m - 1) as usize;
    if d == 0 || d > MONTH_DAYS[month_idx] {
        return Err(IdentityError::ParseFailed);
    }
    let cum: u64 = MONTH_DAYS[..month_idx].iter().sum();
    Ok(y * 365 + cum + d)
}

/// raw -> checked fixed point -> integer：拒绝余数与溢出。
fn decode_fixed(raw: u64, scale: u64) -> Result<u64, IdentityError> {
    if scale == 0 || !raw.is_multiple_of(scale) {
        return Err(IdentityError::ParseFailed);
    }
    Ok(raw / scale)
}

fn warning(code: &str) -> Warning {
    Warning {
        code: code.to_string(),
        category: None,
    }
}

/// 有界扫描 gamestate 文本流并组装 identity。两个 reader 必须指向同一 gamestate
/// 的开头；第二个只在 snapshot 三元组未能从兼容 root layout 取得时使用。
pub fn extract(
    root_reader: impl Read,
    player_reader: impl Read,
    limits: ScanLimits,
) -> Result<IdentityExtraction, IdentityError> {
    let mut scanner = Scanner::new(root_reader, limits);
    let mut acc = RawTargets::default();

    // root 层：meta_data / date / variables 定向扫描，其余整块跳过。
    loop {
        match scanner.next_token()? {
            Token::Eof => {
                if scanner.depth != 0 {
                    return Err(IdentityError::Truncated);
                }
                break;
            }
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"meta_data" => scan_meta_block(&mut scanner, &mut acc)?,
                    b"played_character" => scan_played_character_block(&mut scanner, &mut acc)?,
                    b"date" => match scanner.next_token()? {
                        Token::Scalar(v) | Token::Str(v) => {
                            acc.date_raw =
                                Some(String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?);
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    b"variables" => {
                        scan_variables_block(&mut scanner, &mut acc, 0)?;
                        acc.root_variables_seen = true;
                    }
                    _ => scanner.skip_value()?,
                }
            }
            // root 层出现 } 或 string key：结构损坏。
            _ => return Err(IdentityError::ParseFailed),
        }
        if acc.root_complete() {
            break;
        }
    }
    let root_scanned_bytes = scanner.scanned_bytes();

    // Real 1.19 layout stores snapshot variables under the player. Root-only
    // synthetic/legacy fixtures remain supported and skip this second pass.
    let player_scanned_bytes = if !acc.snapshot_complete() {
        if let Some(player_id) = acc.player_id.clone() {
            let mut player_limits = limits;
            player_limits.max_bytes = limits.max_bytes.saturating_sub(root_scanned_bytes);
            if player_limits.max_bytes == 0 {
                return Err(IdentityError::LimitExceeded);
            }
            scan_player_snapshot(player_reader, player_limits, player_id.as_bytes(), &mut acc)?
        } else {
            0
        }
    } else {
        0
    };
    let scanned_bytes = root_scanned_bytes
        .checked_add(player_scanned_bytes)
        .ok_or(IdentityError::LimitExceeded)?;

    // ---- 组装 + 校验 ----
    let mut warnings = Vec::new();

    if let Some(version) = &acc.ck3_version {
        let recognized = RECOGNIZED_CK3_VERSION_PREFIXES.iter().any(|p| {
            version
                .strip_prefix(p)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
        });
        if !recognized {
            warnings.push(warning(WARN_VERSION_UNRECOGNIZED));
        }
    } else {
        warnings.push(warning(WARN_VERSION_MISSING));
    }

    if acc.player_id.is_none() {
        warnings.push(warning(WARN_PLAYER_ID_MISSING));
    }

    let (game_date_numeric, game_date_display) = match &acc.date_raw {
        Some(raw) => {
            let numeric = parse_game_date(raw)?;
            (Some(numeric), Some(raw.clone()))
        }
        None => {
            warnings.push(warning(WARN_GAME_DATE_MISSING));
            (None, None)
        }
    };

    let [ca, cb, cc, cd, raw_protocol, raw_sequence, raw_slot] = acc.vars;

    // scale 推导：protocol 语义恒为 1（启用时），故 scale = raw_protocol；
    // protocol raw 为 0（已清除/未启用）时 scale 不可推导，不猜倍率。
    let mut scale: Option<u64> = None;
    let mut snapshot_sequence = None;
    let mut snapshot_slot = None;
    match (raw_protocol, raw_sequence, raw_slot) {
        (Some(p), Some(s), Some(l)) => {
            if p == 0 {
                // 已清除状态：sequence/slot 必须同为 0；scale 不可推导。
                if s != 0 || l != 0 {
                    return Err(IdentityError::ParseFailed);
                }
                snapshot_sequence = Some(0);
                snapshot_slot = Some(0);
                warnings.push(warning(WARN_SCALE_UNDETERMINED));
            } else {
                let sc = p; // protocol 恒为 1 → scale = raw_protocol
                if decode_fixed(s, sc)? == 0 {
                    return Err(IdentityError::ParseFailed); // sequence 必须为正
                }
                let slot = decode_fixed(l, sc)?;
                if slot > 1 {
                    return Err(IdentityError::ParseFailed);
                }
                snapshot_sequence = Some(decode_fixed(s, sc)?);
                snapshot_slot = Some(slot);
                scale = Some(sc);
            }
        }
        (None, None, None) => {}
        _ => {
            // 三项必须同时存在且合法，不允许截断 tail 被部分接受。
            warnings.push(warning(WARN_SNAPSHOT_PARTS_MISSING));
        }
    }

    let campaign_id_parts = match (ca, cb, cc, cd) {
        (Some(a), Some(b), Some(c), Some(d)) => match scale {
            Some(sc) => Some([
                decode_fixed(a, sc)?,
                decode_fixed(b, sc)?,
                decode_fixed(c, sc)?,
                decode_fixed(d, sc)?,
            ]),
            None => {
                warnings.push(warning(WARN_SCALE_UNDETERMINED));
                None
            }
        },
        (None, None, None, None) => None,
        _ => {
            warnings.push(warning(WARN_CAMPAIGN_PARTS_MISSING));
            None
        }
    };

    if acc.vars.iter().all(Option::is_none) {
        warnings.push(warning(WARN_VOTC_VARIABLES_MISSING));
    }

    if acc.join_candidates_dropped {
        warnings.push(warning(WARN_JOIN_CANDIDATES_INVALID));
    }

    let core_complete =
        acc.ck3_version.is_some() && acc.player_id.is_some() && acc.date_raw.is_some();

    Ok(IdentityExtraction {
        identity: Identity {
            player_character_id: acc.player_id,
            game_date_numeric,
            game_date_display,
            campaign_id_parts,
            snapshot_sequence,
            snapshot_slot,
            script_variable_scale: scale,
        },
        ck3_version: acc.ck3_version,
        warnings,
        scanned_bytes,
        core_complete,
        join_candidates: acc.join_candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: ScanLimits = ScanLimits {
        max_bytes: 1 << 20,
        max_nesting: 64,
        max_scalar: 1024,
    };

    fn scan(text: &str) -> Result<IdentityExtraction, IdentityError> {
        extract(
            std::io::Cursor::new(text.as_bytes()),
            std::io::Cursor::new(text.as_bytes()),
            LIMITS,
        )
    }

    fn full_gamestate(protocol_raw: i64, sequence_raw: i64) -> String {
        format!(
            "meta_data={{\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}}\n\
             date=867.1.15\n\
             variables={{\n\tdata={{\n\t\t{{\n\t\t\tflag=\"votc_campaign_id_a\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue={ca}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_b\"\n\t\t\tdata={{\n\t\t\t\tvalue={cb}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_c\"\n\t\t\tdata={{\n\t\t\t\tvalue={cc}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_d\"\n\t\t\tdata={{\n\t\t\t\tvalue={cd}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_protocol\"\n\t\t\tdata={{\n\t\t\t\tvalue={protocol_raw}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_sequence\"\n\t\t\tdata={{\n\t\t\t\tvalue={sequence_raw}\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_slot\"\n\t\t\tdata={{\n\t\t\t\tvalue=0\n\t\t\t}}\n\t\t}}\n\
             \t}}\n\tsize=7\n}}\nliving={{\n\t999={{\n\t\talive_data={{}}\n\t}}\n}}\n",
            ca = 111 * protocol_raw,
            cb = 222 * protocol_raw,
            cc = 333 * protocol_raw,
            cd = 444 * protocol_raw,
        )
    }

    fn real_player_gamestate(sequence_raw: u64, slot_data: &str) -> String {
        format!(
            "meta_data={{ version=\"1.19.2.3\" }}\n\
             date=867.1.15\n\
             variables={{ data={{\
               {{ flag=\"votc_campaign_id_a\" data={{ type=value identity=11100000 }} }}\
               {{ flag=\"votc_campaign_id_b\" data={{ type=value identity=22200000 }} }}\
               {{ flag=\"votc_campaign_id_c\" data={{ type=value identity=33300000 }} }}\
               {{ flag=\"votc_campaign_id_d\" data={{ type=value identity=44400000 }} }}\
             }} }}\n\
             living={{\
               999={{ alive_data={{ variables={{ data={{\
                 {{ flag=\"votc_save_snapshot_protocol\" data={{ type=value identity=100000 }} }}\
                 {{ flag=\"votc_save_snapshot_sequence\" data={{ type=value identity=9900000 }} }}\
                 {{ flag=\"votc_save_snapshot_slot\" data={{ type=value identity=100000 }} }}\
               }} }} }} }}\
               1001={{ alive_data={{ variables={{ data={{\
                 {{ flag=\"votc_save_snapshot_protocol\" data={{ type=value identity=100000 }} }}\
                 {{ flag=\"votc_save_snapshot_sequence\" data={{ type=value identity={sequence_raw} }} }}\
                 {{ flag=\"votc_save_snapshot_slot\" data={{ {slot_data} }} }}\
               }} }} }} }}\
             }}\n\
             played_character={{ character=1001 player=1 }}\n"
        )
    }

    #[test]
    fn extracts_identity_with_derived_scale() {
        let r = scan(&full_gamestate(1000, 17000)).unwrap();
        assert_eq!(r.ck3_version.as_deref(), Some("1.13.0"));
        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.game_date_numeric, Some(316_470));
        assert_eq!(r.identity.game_date_display.as_deref(), Some("867.1.15"));
        assert_eq!(r.identity.campaign_id_parts, Some([111, 222, 333, 444]));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
        assert_eq!(r.identity.snapshot_slot, Some(0));
        assert_eq!(r.identity.script_variable_scale, Some(1000));
        assert!(r.warnings.is_empty());
        assert!(r.core_complete);
        // 提前停止：living 块在 variables 之后，不应被扫到。
        assert!(r.scanned_bytes < full_gamestate(1000, 17000).len() as u64);
    }

    #[test]
    fn extracts_ck3_1_19_identity_from_real_field_layout() {
        let text = full_gamestate(100_000, 1_700_000)
            .replace("version=\"1.13.0\"", "version=\"1.19.2.3\"")
            .replace("\tmeta_player_id=1001\n", "")
            .replace(
                "}\ndate=867.1.15",
                "}\nplayed_character={ character=1001 player=1 }\ndate=867.1.15",
            )
            .replace("value=", "identity=")
            .replace("type=integer", "type=value");

        let r = scan(&text).unwrap();
        assert_eq!(r.ck3_version.as_deref(), Some("1.19.2.3"));
        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.script_variable_scale, Some(100_000));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
        assert_eq!(r.identity.campaign_id_parts, Some([111, 222, 333, 444]));
        assert!(r.warnings.is_empty());
        assert!(r.core_complete);
    }

    #[test]
    fn extracts_snapshot_from_target_player_and_treats_omitted_identity_as_zero() {
        let text = real_player_gamestate(1_700_000, "type=value");
        let r = scan(&text).unwrap();

        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.campaign_id_parts, Some([111, 222, 333, 444]));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
        assert_eq!(r.identity.snapshot_slot, Some(0));
        assert_eq!(r.identity.script_variable_scale, Some(100_000));
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn wrapped_negative_sequence_from_real_save_is_rejected() {
        let text = real_player_gamestate(u64::MAX - 1_699_999, "type=value identity=0");
        assert!(matches!(scan(&text), Err(IdentityError::ParseFailed)));
    }

    #[test]
    fn absent_player_snapshot_flags_do_not_parse_unrelated_variables() {
        let text = real_player_gamestate(1_700_000, "type=value")
            .replace("votc_save_snapshot_protocol", "ordinary_protocol")
            .replace("votc_save_snapshot_sequence", "ordinary_sequence")
            .replace("votc_save_snapshot_slot", "ordinary_slot");
        let r = scan(&text).unwrap();

        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.snapshot_sequence, None);
        assert_eq!(r.identity.snapshot_slot, None);
        assert_eq!(r.identity.campaign_id_parts, None);
        assert!(r.core_complete);
    }

    #[test]
    fn scale_one_decodes_plain_values() {
        let r = scan(&full_gamestate(1, 17)).unwrap();
        assert_eq!(r.identity.script_variable_scale, Some(1));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
        assert_eq!(r.identity.campaign_id_parts, Some([111, 222, 333, 444]));
    }

    #[test]
    fn fractional_sequence_is_rejected() {
        assert!(matches!(
            scan(&full_gamestate(1000, 17500)),
            Err(IdentityError::ParseFailed)
        ));
    }

    #[test]
    fn negative_sequence_is_rejected() {
        assert!(matches!(
            scan(&full_gamestate(1000, -17000)),
            Err(IdentityError::ParseFailed)
        ));
    }

    #[test]
    fn zero_sequence_with_protocol_one_is_rejected() {
        assert!(matches!(
            scan(&full_gamestate(1000, 0)),
            Err(IdentityError::ParseFailed)
        ));
    }

    #[test]
    fn date_math_and_validation() {
        assert_eq!(parse_game_date("867.1.1"), Ok(867 * 365 + 1));
        assert_eq!(parse_game_date("867.2.1"), Ok(867 * 365 + 31 + 1));
        assert_eq!(parse_game_date("867.13.1"), Err(IdentityError::ParseFailed));
        assert_eq!(parse_game_date("867.2.30"), Err(IdentityError::ParseFailed));
        assert_eq!(parse_game_date("867.1"), Err(IdentityError::ParseFailed));
        assert_eq!(parse_game_date("-867.1.1"), Err(IdentityError::ParseFailed));
        assert_eq!(
            parse_game_date("867.1.1.1"),
            Err(IdentityError::ParseFailed)
        );
    }

    #[test]
    fn truncated_block_is_truncated_error() {
        let text = "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n";
        assert!(matches!(scan(text), Err(IdentityError::Truncated)));
    }

    #[test]
    fn cleared_snapshot_triple_gives_zero_and_undetermined_scale() {
        let text = "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}\n\
                    date=867.1.15\n\
                    variables={\n\tdata={\n\
                    \t{\n\t\tflag=\"votc_save_snapshot_protocol\"\n\t\tdata={\n\t\t\tvalue=0\n\t\t}\n\t}\n\
                    \t{\n\t\tflag=\"votc_save_snapshot_sequence\"\n\t\tdata={\n\t\t\tvalue=0\n\t\t}\n\t}\n\
                    \t{\n\t\tflag=\"votc_save_snapshot_slot\"\n\t\tdata={\n\t\t\tvalue=0\n\t\t}\n\t}\n\
                    }\n}\n";
        let r = scan(text).unwrap();
        assert_eq!(r.identity.snapshot_sequence, Some(0));
        assert_eq!(r.identity.snapshot_slot, Some(0));
        assert_eq!(r.identity.script_variable_scale, None);
        assert!(r.warnings.iter().any(|w| w.code == WARN_SCALE_UNDETERMINED));
    }

    #[test]
    fn nesting_limit_is_enforced() {
        let deep = format!("x={}", "{".repeat(70));
        assert!(matches!(scan(&deep), Err(IdentityError::LimitExceeded)));
    }

    #[test]
    fn scalar_limit_is_enforced() {
        let long = format!("x={}", "a".repeat(2000));
        assert!(matches!(scan(&long), Err(IdentityError::LimitExceeded)));
    }

    #[test]
    fn byte_budget_is_enforced() {
        let limits = ScanLimits {
            max_bytes: 64,
            ..LIMITS
        };
        let text = full_gamestate(1, 17);
        assert!(matches!(
            extract(
                std::io::Cursor::new(text.as_bytes()),
                std::io::Cursor::new(text.as_bytes()),
                limits,
            ),
            Err(IdentityError::LimitExceeded)
        ));
    }

    // -----------------------------------------------------------------------
    // Plan C Task 2b：root variables.list 的 votc_join_candidates 提取
    // -----------------------------------------------------------------------

    fn join_candidates_gamestate(list_block: &str) -> String {
        format!(
            "meta_data={{\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n}}\n\
             date=867.1.15\n\
             variables={{\n\tdata={{\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_a\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=111000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_b\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=222000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_c\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=333000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_campaign_id_d\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=444000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_protocol\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=1000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_sequence\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=17000\n\t\t\t}}\n\t\t}}\n\
             \t\t{{\n\t\t\tflag=\"votc_save_snapshot_slot\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue=0\n\t\t\t}}\n\t\t}}\n\
             \t}}\n\tlist={{\n{list_block}\t}}\n}}\n\
             living={{\n\t9999={{\n\t\talive_data={{\n\t\t}}\n\t}}\n}}\n"
        )
    }

    fn target_list_entry(item_lines: &str) -> String {
        format!(
            "\t\t{{\n\t\t\tname=\"votc_join_candidates\"\n{item_lines}\t\t}}\n"
        )
    }

    #[test]
    fn join_candidates_extracted_in_order_as_decimal_ids() {
        let list_block = target_list_entry(
            "\t\t\titem={ type=char identity=13206 }\n\t\t\titem={ type=char identity=33435 }\n",
        );
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        assert_eq!(
            r.join_candidates,
            Some(vec!["13206".to_string(), "33435".to_string()])
        );
        assert!(r.warnings.is_empty());
        // identity 其余字段不受影响。
        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
    }

    #[test]
    fn join_candidates_missing_list_is_absent() {
        let r = scan(&full_gamestate(1000, 17000)).unwrap();
        assert_eq!(r.join_candidates, None);
    }

    #[test]
    fn join_candidates_other_list_names_are_ignored() {
        let list_block = "\t\t{\n\t\t\tname=\"votc_conversation_characters_list\"\n\
                          \t\t\titem={ type=char identity=13206 }\n\t\t}\n";
        let r = scan(&join_candidates_gamestate(list_block)).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn join_candidates_non_char_item_drops_whole_list_with_warning() {
        let list_block =
            target_list_entry("\t\t\titem={ type=integer identity=13206 }\n");
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.code == WARN_JOIN_CANDIDATES_INVALID));
        // 仅 degrade candidates；identity 不受影响。
        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
        assert_eq!(r.identity.snapshot_sequence, Some(17));
    }

    #[test]
    fn join_candidates_non_decimal_identity_drops_whole_list_with_warning() {
        let list_block = target_list_entry(
            "\t\t\titem={ type=char identity=13206 }\n\t\t\titem={ type=char identity=abc }\n",
        );
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.code == WARN_JOIN_CANDIDATES_INVALID));
    }

    #[test]
    fn join_candidates_missing_identity_drops_whole_list_with_warning() {
        let list_block = target_list_entry("\t\t\titem={ type=char }\n");
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.code == WARN_JOIN_CANDIDATES_INVALID));
    }

    #[test]
    fn join_candidates_over_limit_drops_whole_list_with_warning() {
        let mut item_lines = String::new();
        for i in 0..crate::limits::HARD_MAX_JOIN_CANDIDATES + 1 {
            item_lines.push_str(&format!("\t\t\titem={{ type=char identity={i} }}\n"));
        }
        let list_block = target_list_entry(&item_lines);
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.code == WARN_JOIN_CANDIDATES_INVALID));
    }

    #[test]
    fn join_candidates_exactly_at_limit_is_accepted() {
        let mut item_lines = String::new();
        for i in 0..crate::limits::HARD_MAX_JOIN_CANDIDATES {
            item_lines.push_str(&format!("\t\t\titem={{ type=char identity={i} }}\n"));
        }
        let list_block = target_list_entry(&item_lines);
        let r = scan(&join_candidates_gamestate(&list_block)).unwrap();
        let expected: Vec<String> = (0..crate::limits::HARD_MAX_JOIN_CANDIDATES as u64)
            .map(|i| i.to_string())
            .collect();
        assert_eq!(r.join_candidates, Some(expected));
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn join_candidates_not_extracted_from_alive_data_path() {
        let text = "meta_data={ version=\"1.19.2.3\" }\n\
                    date=867.1.15\n\
                    variables={ data={\
                      { flag=\"votc_campaign_id_a\" data={ type=value identity=11100000 } }\
                    } }\n\
                    living={\
                      1001={ alive_data={ variables={ list={\
                        { name=\"votc_join_candidates\" item={ type=char identity=13206 } }\
                      } } } }\
                    }\n\
                    played_character={ character=1001 player=1 }\n";
        let r = scan(text).unwrap();
        assert_eq!(r.join_candidates, None);
        assert!(!r
            .warnings
            .iter()
            .any(|w| w.code == WARN_JOIN_CANDIDATES_INVALID));
        // alive_data 的 snapshot 变量仍可正常提取。
        assert_eq!(r.identity.player_character_id.as_deref(), Some("1001"));
    }
}
