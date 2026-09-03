//! 二进制 gamestate melter（`docs/binary-save-melt-integration-plan-2026-08-29.md` §3）。
//!
//! 把二进制（非 debug）gamestate 流式转换为明文文本流，直接喂给既有
//! `identity::extract` / extract / session materialize 文本路径，extract 层零改动。
//!
//! 二进制语法（已实证，见规划 §3.1 与 jomini 0.35 `binary/lexer.rs`）：
//!
//! - 字段：`Id(u16)` + `Equal(0x0001)` + 值；整数键：`<整数><载荷> Equal <值>`；
//! - 组内「后无 Equal 的 Id / 标量」是裸数组元素，不是字段；
//! - 值可以是另一个 token id（枚举式字符串值），经 token 表解析为字符串；
//! - 值类型全集：U32/U64/I32/I64/F32/F64/FIXED5_*(0x0d47–0x0d55 紧凑定点)/
//!   Bool/Quoted/Unquoted/EmptyString(0x0d42)/Rgb(0x0243)/Lookup*(0x0d3e–0x0d46)。
//!
//! 未解析 token **绝不猜**（错映射比缺映射危险）：字段键降级为
//! `unknown_0xXXXX=`，Id/lookup 值降级为 `"0xXXXX"` 字符串，出现次数累计到
//! [`MeltStats`]，由调用方映射为 `TOKENS_PARTIALLY_UNRESOLVED` warning。
//!
//! 日期：键解析为 `date` / `meta_date` 的字段把 I32 小时计数转回
//! `Y.M.D[.H]` 文本（公式见 `binary_hours_to_date`，与 builder
//! `date_to_binary_hours` 互逆；`meta_date` 的小时编码由实机 probe 确认，
//! 见规划 §7.2）。
//!
//! 实现说明：jomini `TokenReader` 把 FIXED5 与 F64 折叠为同一 `Token::F64`
//! （FIXED5 的载荷是 i64 缩放值而非 f64 位模式，二者必须区分），因此本模块
//! 在 `BufRead` 上自带一个最小 lexeme 读取层（常量复用 jomini `LexemeId`），
//! 不物化整个二进制 gamestate。

use std::cell::Cell;
use std::io::{self, BufReader, Read};
use std::rc::Rc;

use jomini::binary::{LexemeId, Rgb};

use crate::identity::{IdentityError, ScanLimits, Scanner, Token as TextToken};
use crate::tokens;

/// 未解析 token 统计对应的响应 warning code（不降级 status）。
pub const WARN_TOKENS_PARTIALLY_UNRESOLVED: &str = "TOKENS_PARTIALLY_UNRESOLVED";

/// 版本门禁的 melt 文本扫描预算（meta_data 块位于 gamestate 开头，
/// 正常仅数十 KiB；预算只防异常输入，宁大勿小）。
pub const VERSION_GATE_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// melter 单次 pump 的输出缓冲目标（超即返回，让下游及时消费）。
const PUMP_CHUNK: usize = 8 * 1024;

/// melter 统计。`Rc` 共享：melt reader 被 `identity::extract` 等按值消费后，
/// 调用方仍能读取未解析 token 计数。sidecar 单线程，Cell 足够。
#[derive(Debug, Default)]
pub struct MeltStats {
    pub unresolved_tokens: Cell<u64>,
}

pub type SharedMeltStats = Rc<MeltStats>;

pub fn new_stats() -> SharedMeltStats {
    Rc::new(MeltStats::default())
}

/// 读取错误： truncated（流中途 EOF）与其它损坏区分，供版本门禁映射
/// `SaveTruncated` / `SaveParseFailed`。
fn err_truncated() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "binary gamestate truncated")
}

fn err_corrupt(msg: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// 拥有所有权的二进制 token（payload 已从流复制）。
#[derive(Debug, Clone, PartialEq)]
enum OwnedToken {
    Open,
    Close,
    Equal,
    U32(u32),
    U64(u64),
    I32(i32),
    I64(i64),
    Bool(bool),
    Quoted(Vec<u8>),
    Unquoted(Vec<u8>),
    F32([u8; 4]),
    F64([u8; 8]),
    /// FIXED5 紧凑定点：i64 缩放值（真值 = raw / 100_000）。
    Fixed5(i64),
    Rgb(Rgb),
    Lookup(u32),
    Id(u16),
}

/// 二进制 gamestate → 明文文本的流式 `Read` adapter。
pub struct MeltReader<R: Read> {
    inner: BufReader<R>,
    /// 一个 token 的 lookahead（判定字段键 vs 裸数组元素）。
    pending: Option<OwnedToken>,
    out: Vec<u8>,
    pos: usize,
    depth: u32,
    finished: bool,
    /// 首个 pump 错误的 kind（输出 drain 完后按原 kind 重报）。
    failed: Option<io::ErrorKind>,
    stats: SharedMeltStats,
}

impl<R: Read> MeltReader<R> {
    pub fn new(reader: R, stats: SharedMeltStats) -> Self {
        Self {
            // 与 identity::Scanner 一致用 64 KiB 缓冲摊销小字节读取。
            inner: BufReader::with_capacity(64 * 1024, reader),
            pending: None,
            out: Vec::with_capacity(PUMP_CHUNK * 2),
            pos: 0,
            depth: 0,
            finished: false,
            failed: None,
            stats,
        }
    }

    // -----------------------------------------------------------------------
    // lexeme 读取层（常量与载荷布局见 jomini binary/lexer.rs）
    // -----------------------------------------------------------------------

    fn read_exact_or_truncated(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.inner.read_exact(buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                err_truncated()
            } else {
                e
            }
        })
    }

    fn read_array<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        let mut buf = [0u8; N];
        self.read_exact_or_truncated(&mut buf)?;
        Ok(buf)
    }

    /// 读取一个 token；干净 EOF（token 边界上 0 字节）返回 Ok(None)，
    /// token 中途 EOF 返回 truncated 错误。
    fn read_token(&mut self) -> io::Result<Option<OwnedToken>> {
        let mut first = [0u8; 1];
        let n = self.inner.read(&mut first)?;
        if n == 0 {
            return Ok(None);
        }
        let rest = self.read_array::<1>()?;
        let lexeme = LexemeId::new(u16::from_le_bytes([first[0], rest[0]]));
        let token = match lexeme {
            LexemeId::OPEN => OwnedToken::Open,
            LexemeId::CLOSE => OwnedToken::Close,
            LexemeId::EQUAL => OwnedToken::Equal,
            LexemeId::U32 => OwnedToken::U32(u32::from_le_bytes(self.read_array()?)),
            LexemeId::U64 => OwnedToken::U64(u64::from_le_bytes(self.read_array()?)),
            LexemeId::I32 => OwnedToken::I32(i32::from_le_bytes(self.read_array()?)),
            LexemeId::I64 => OwnedToken::I64(i64::from_le_bytes(self.read_array()?)),
            LexemeId::BOOL => OwnedToken::Bool(self.read_array::<1>()?[0] != 0),
            LexemeId::QUOTED => OwnedToken::Quoted(self.read_string_payload()?),
            LexemeId::EMPTY_STRING => OwnedToken::Quoted(Vec::new()),
            LexemeId::UNQUOTED => OwnedToken::Unquoted(self.read_string_payload()?),
            LexemeId::F32 => OwnedToken::F32(self.read_array()?),
            LexemeId::F64 => OwnedToken::F64(self.read_array()?),
            LexemeId::RGB => OwnedToken::Rgb(self.read_rgb_payload()?),
            LexemeId::LOOKUP_U8 | LexemeId::LOOKUP_U8_ALT => {
                OwnedToken::Lookup(u32::from(self.read_array::<1>()?[0]))
            }
            LexemeId::LOOKUP_U16 | LexemeId::LOOKUP_U16_ALT => {
                OwnedToken::Lookup(u32::from(u16::from_le_bytes(self.read_array()?)))
            }
            LexemeId::LOOKUP_U24 | LexemeId::LOOKUP_U24_ALT => {
                let b = self.read_array::<3>()?;
                OwnedToken::Lookup(u32::from_le_bytes([b[0], b[1], b[2], 0]))
            }
            LexemeId::LOOKUP_U32 | LexemeId::LOOKUP_U32_ALT => {
                OwnedToken::Lookup(u32::from_le_bytes(self.read_array()?))
            }
            l if l >= LexemeId::FIXED5_ZERO && l <= LexemeId::FIXED5_I56 => {
                // read_compact_f64 语义：offset>7 为负值，正/负各 0–7 字节 LE。
                let offset = l.0 - LexemeId::FIXED5_ZERO.0;
                let is_negative = offset > 7;
                let byte_count = (offset - if is_negative { 7 } else { 0 }) as usize;
                let mut buf = [0u8; 8];
                self.read_exact_or_truncated(&mut buf[..byte_count])?;
                let magnitude = u64::from_le_bytes(buf) as i64;
                OwnedToken::Fixed5(if is_negative { -magnitude } else { magnitude })
            }
            other => OwnedToken::Id(other.0),
        };
        Ok(Some(token))
    }

    fn read_string_payload(&mut self) -> io::Result<Vec<u8>> {
        let len = u16::from_le_bytes(self.read_array()?) as usize;
        let mut buf = vec![0u8; len];
        self.read_exact_or_truncated(&mut buf)?;
        Ok(buf)
    }

    /// RGB 载荷：`{ u32 u32 u32 [u32] }`（read_rgb 语义；畸形即损坏）。
    fn read_rgb_payload(&mut self) -> io::Result<Rgb> {
        let read_id = |m: &mut Self| -> io::Result<LexemeId> {
            Ok(LexemeId::new(u16::from_le_bytes(m.read_array()?)))
        };
        if read_id(self)? != LexemeId::OPEN {
            return Err(err_corrupt("malformed rgb payload"));
        }
        if read_id(self)? != LexemeId::U32 {
            return Err(err_corrupt("malformed rgb payload"));
        }
        let r = u32::from_le_bytes(self.read_array()?);
        if read_id(self)? != LexemeId::U32 {
            return Err(err_corrupt("malformed rgb payload"));
        }
        let g = u32::from_le_bytes(self.read_array()?);
        if read_id(self)? != LexemeId::U32 {
            return Err(err_corrupt("malformed rgb payload"));
        }
        let b = u32::from_le_bytes(self.read_array()?);
        match read_id(self)? {
            LexemeId::CLOSE => Ok(Rgb { r, g, b, a: None }),
            LexemeId::U32 => {
                let a = u32::from_le_bytes(self.read_array()?);
                if read_id(self)? != LexemeId::CLOSE {
                    return Err(err_corrupt("malformed rgb payload"));
                }
                Ok(Rgb { r, g, b, a: Some(a) })
            }
            _ => Err(err_corrupt("malformed rgb payload")),
        }
    }

    // -----------------------------------------------------------------------
    // 文本化
    // -----------------------------------------------------------------------

    fn emit(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    fn emit_str(&mut self, s: &str) {
        self.out.extend_from_slice(s.as_bytes());
    }

    /// 字段键（Id token）：解析名原样输出；未解析降级 `unknown_0xXXXX`。
    fn emit_id_key(&mut self, id: u16) {
        match tokens::resolve(id) {
            Some(name) => self.emit_str(name),
            None => {
                self.stats.unresolved_tokens.update(|c| c + 1);
                self.emit_str(&format!("unknown_0x{id:04x}"));
            }
        }
    }

    /// Id 值 / 裸 Id 数组元素：解析名原样输出（表内名字均为标识符安全），
    /// 未解析降级 `"0xXXXX"` 字符串。
    fn emit_id_value(&mut self, id: u16) {
        match tokens::resolve(id) {
            Some(name) => self.emit_str(name),
            None => {
                self.stats.unresolved_tokens.update(|c| c + 1);
                self.emit_str(&format!("\"0x{id:04x}\""));
            }
        }
    }

    /// 引号字符串，按 scanner 反转义规则转义 `\` 与 `"`。
    fn emit_quoted(&mut self, raw: &[u8]) {
        self.emit(b"\"");
        for &b in raw {
            if b == b'\\' || b == b'"' {
                self.out.push(b'\\');
            }
            self.out.push(b);
        }
        self.emit(b"\"");
    }

    /// unquoted 标量：内容标识符安全则原样输出，否则加引号保证可解析。
    fn emit_unquoted(&mut self, raw: &[u8]) {
        let bare = !raw.is_empty()
            && raw
                .iter()
                .all(|b| !b.is_ascii_whitespace() && !matches!(b, b'{' | b'}' | b'=' | b'"'));
        if bare {
            self.emit(raw);
        } else {
            self.emit_quoted(raw);
        }
    }

    /// 值位置输出一个标量；`is_date_key` 时 I32 按日期小时计数转换。
    fn emit_scalar_value(&mut self, tok: &OwnedToken, is_date_key: bool) {
        match tok {
            OwnedToken::U32(x) => self.emit_str(&x.to_string()),
            OwnedToken::U64(x) => self.emit_str(&x.to_string()),
            OwnedToken::I32(x) => {
                if is_date_key {
                    match binary_hours_to_date(i64::from(*x)) {
                        Some(text) => self.emit_str(&text),
                        // 超出可表示范围：退回整数文本（scanner 会拒，按损坏处理）。
                        None => self.emit_str(&x.to_string()),
                    }
                } else {
                    self.emit_str(&x.to_string());
                }
            }
            OwnedToken::I64(x) => self.emit_str(&x.to_string()),
            OwnedToken::Bool(b) => self.emit_str(if *b { "yes" } else { "no" }),
            OwnedToken::Quoted(raw) => self.emit_quoted(raw),
            OwnedToken::Unquoted(raw) => self.emit_unquoted(raw),
            // 浮点文本化与 CK3 明文序列为 6 位小数风格；VOTC 消费路径不读
            // 浮点，该表示是 best-effort（规划 §3.1）。
            OwnedToken::F32(bits) => {
                self.emit_str(&format!("{:.6}", f32::from_le_bytes(*bits) as f64))
            }
            OwnedToken::F64(bits) => self.emit_str(&format!("{:.6}", f64::from_le_bytes(*bits))),
            // FIXED5：raw/100000 精确格式化（不走浮点，避免精度噪声）。
            OwnedToken::Fixed5(raw) => self.emit_str(&format_fixed5(*raw)),
            OwnedToken::Rgb(rgb) => match rgb.a {
                Some(a) => self.emit_str(&format!("rgb {{ {} {} {} {} }}", rgb.r, rgb.g, rgb.b, a)),
                None => self.emit_str(&format!("rgb {{ {} {} {} }}", rgb.r, rgb.g, rgb.b)),
            },
            OwnedToken::Lookup(index) => match tokens::lookup(*index) {
                Some(s) => self.emit_quoted(s.as_bytes()),
                None => {
                    self.stats.unresolved_tokens.update(|c| c + 1);
                    self.emit_str(&format!("\"0x{index:04x}\""));
                }
            },
            OwnedToken::Id(id) => self.emit_id_value(*id),
            // Open/Close/Equal 由调用方处理，不会出现在这里。
            OwnedToken::Open | OwnedToken::Close | OwnedToken::Equal => unreachable!(),
        }
    }

    /// 消费 `key=` 之后的值：标量直接输出；Open 进入下一层组。
    fn emit_field_value(&mut self, is_date_key: bool) -> io::Result<()> {
        let tok = self.read_token()?.ok_or_else(err_truncated)?;
        match tok {
            OwnedToken::Open => {
                self.depth = self.depth.saturating_add(1);
                self.emit(b"{\n");
            }
            OwnedToken::Close | OwnedToken::Equal => {
                return Err(err_corrupt("unexpected token in value position"));
            }
            scalar => {
                self.emit_scalar_value(&scalar, is_date_key);
                self.emit(b"\n");
            }
        }
        Ok(())
    }

    /// 处理一个层级 item；返回 false 表示流已正常结束。
    fn step(&mut self) -> io::Result<bool> {
        let tok = match self.pending.take() {
            Some(t) => Some(t),
            None => self.read_token()?,
        };
        let tok = match tok {
            None => {
                if self.depth != 0 {
                    return Err(err_truncated());
                }
                self.finished = true;
                return Ok(false);
            }
            Some(t) => t,
        };
        match tok {
            OwnedToken::Open => {
                // 裸组元素（数组中的匿名对象）。
                self.depth = self.depth.saturating_add(1);
                self.emit(b"{\n");
            }
            OwnedToken::Close => {
                if self.depth == 0 {
                    return Err(err_corrupt("unbalanced close at root"));
                }
                self.depth -= 1;
                self.emit(b"}\n");
            }
            OwnedToken::Equal => return Err(err_corrupt("unexpected equal at level start")),
            OwnedToken::Id(id) => {
                let next = self.read_token()?;
                if next == Some(OwnedToken::Equal) {
                    self.emit_id_key(id);
                    self.emit(b"=");
                    let is_date_key =
                        matches!(tokens::resolve(id), Some("date") | Some("meta_date"));
                    self.emit_field_value(is_date_key)?;
                } else {
                    // 裸 Id 数组元素（组内后无 Equal 的 Id）。
                    self.emit_id_value(id);
                    self.emit(b"\n");
                    self.pending = next;
                }
            }
            // 整数键（`1={ ... }`）或裸整数数组元素。
            OwnedToken::U32(_) | OwnedToken::U64(_) | OwnedToken::I32(_) | OwnedToken::I64(_) => {
                let next = self.read_token()?;
                if next == Some(OwnedToken::Equal) {
                    self.emit_scalar_value(&tok, false);
                    self.emit(b"=");
                    self.emit_field_value(false)?;
                } else {
                    self.emit_scalar_value(&tok, false);
                    self.emit(b"\n");
                    self.pending = next;
                }
            }
            // 字符串键（罕见）或裸字符串数组元素。
            OwnedToken::Quoted(_) | OwnedToken::Unquoted(_) => {
                let next = self.read_token()?;
                if next == Some(OwnedToken::Equal) {
                    self.emit_scalar_value(&tok, false);
                    self.emit(b"=");
                    self.emit_field_value(false)?;
                } else {
                    self.emit_scalar_value(&tok, false);
                    self.emit(b"\n");
                    self.pending = next;
                }
            }
            // 其余类型不可能是键：裸值数组元素。
            scalar => {
                self.emit_scalar_value(&scalar, false);
                self.emit(b"\n");
            }
        }
        Ok(true)
    }

    fn pump(&mut self) -> io::Result<()> {
        while self.out.len() < PUMP_CHUNK && !self.finished {
            if !self.step()? {
                break;
            }
        }
        Ok(())
    }
}

impl<R: Read> Read for MeltReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.pos < self.out.len() {
                let n = (self.out.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
                self.pos += n;
                if self.pos == self.out.len() {
                    self.out.clear();
                    self.pos = 0;
                }
                return Ok(n);
            }
            if self.finished {
                return Ok(0);
            }
            if let Some(kind) = self.failed {
                // 已产出的输出先 drain（上方分支），错误在输出耗尽后按原
                // kind 重报——fail-closed，截断/损坏绝不静默变成「干净 EOF」。
                return Err(io::Error::new(kind, "melt stream failed"));
            }
            match self.pump() {
                Ok(()) => {}
                Err(e) => {
                    self.failed = Some(e.kind());
                    if self.out.is_empty() {
                        return Err(e);
                    }
                    // 本轮 pump 已产出部分输出：先交付，错误留到下次 read。
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 日期换算（与 builder date_to_binary_hours 互逆，已正反验证）
// ---------------------------------------------------------------------------

/// CK3 日历每月天数（固定 365 天年，无闰年；与 identity.rs MONTH_DAYS 一致）。
const MONTH_DAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// 二进制日期小时计数 → `Y.M.D[.H]` 文本。
///
/// 二进制编码：`hours = ((year + 5000) * 365 + doy0) * 24 + hour0`，doy0 为
/// 1 月 1 日起 0 基天数，hour0 为 0 基小时（文本小时 H ↔ 二进制 H-1，
/// 无小时部分等价于 hour0=0）。hour0 != 0 时输出第四段 `.H`。
/// 负年份用欧几里得除法保持正确；超出合理范围的输入返回 None。
pub fn binary_hours_to_date(hours: i64) -> Option<String> {
    let hour0 = hours.rem_euclid(24);
    let days = hours.div_euclid(24);
    let year = days.div_euclid(365) - 5000;
    let mut doy0 = days.rem_euclid(365);
    // 文本年份最多 7 位数字（防止恶意输入造出超长标量）。
    if !(-9_999_999..=9_999_999).contains(&year) {
        return None;
    }
    let mut month = 0usize;
    while month < 12 && doy0 >= MONTH_DAYS[month] {
        doy0 -= MONTH_DAYS[month];
        month += 1;
    }
    if month >= 12 {
        return None;
    }
    let day = doy0 + 1;
    let base = format!("{}.{}.{}", year, month + 1, day);
    if hour0 == 0 {
        Some(base)
    } else {
        Some(format!("{}.{}", base, hour0 + 1))
    }
}

// ---------------------------------------------------------------------------
// 版本门禁（规划 §4）：流式 melt 开头取 meta_data.version 与表版本比对
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionGateError {
    /// meta 段不可读（流截断 / 扫描预算耗尽 / 未找到 meta_data）。
    Truncated,
    /// melt 或文本结构损坏。
    ParseFailed,
    /// version 缺失或与 token 表版本不一致。
    Mismatch,
}

/// 二进制存档版本门禁。只消费开头（找到 meta_data 块即止），与
/// `tokens::TOKEN_TABLE_CK3_VERSION` 精确比对。`max_bytes` 是 melt 后文本的
/// 扫描预算（meta 块应位于 gamestate 开头，调用方给几 MiB 即可）。
pub fn check_version(reader: impl Read, max_bytes: u64) -> Result<(), VersionGateError> {
    let stats = new_stats();
    let melt = MeltReader::new(reader, stats);
    let limits = ScanLimits {
        max_bytes,
        max_nesting: 16,
        max_scalar: crate::limits::HARD_MAX_SCALAR_BYTES as usize,
    };
    let mut scanner = Scanner::new(melt, limits);
    let version = scan_meta_version(&mut scanner)?;
    match version {
        Some(v) if v == tokens::TOKEN_TABLE_CK3_VERSION => Ok(()),
        _ => Err(VersionGateError::Mismatch),
    }
}

fn scan_meta_version<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Option<String>, VersionGateError> {
    loop {
        match scanner.next_token() {
            Err(IdentityError::Truncated | IdentityError::LimitExceeded) => {
                return Err(VersionGateError::Truncated)
            }
            Err(IdentityError::ParseFailed | IdentityError::Io) => {
                return Err(VersionGateError::ParseFailed)
            }
            Ok(TextToken::Eof) => return Err(VersionGateError::Truncated),
            Ok(TextToken::Scalar(key)) => {
                scanner.expect_eq().map_err(map_gate_err)?;
                if key == b"meta_data" {
                    return scan_meta_block_version(scanner);
                }
                scanner.skip_value().map_err(map_gate_err)?;
            }
            Ok(_) => return Err(VersionGateError::ParseFailed),
        }
    }
}

fn scan_meta_block_version<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<Option<String>, VersionGateError> {
    let mut version = None;
    scanner.expect_lbrace().map_err(map_gate_err)?;
    loop {
        match scanner.next_token().map_err(map_gate_err)? {
            TextToken::RBrace => return Ok(version),
            TextToken::Eof => return Err(VersionGateError::Truncated),
            TextToken::Scalar(key) => {
                scanner.expect_eq().map_err(map_gate_err)?;
                if key == b"version" {
                    match scanner.next_token().map_err(map_gate_err)? {
                        TextToken::Str(v) | TextToken::Scalar(v) => {
                            version = Some(
                                String::from_utf8(v).map_err(|_| VersionGateError::ParseFailed)?,
                            );
                        }
                        _ => return Err(VersionGateError::ParseFailed),
                    }
                } else {
                    scanner.skip_value().map_err(map_gate_err)?;
                }
            }
            _ => return Err(VersionGateError::ParseFailed),
        }
    }
}

fn map_gate_err(err: IdentityError) -> VersionGateError {
    match err {
        IdentityError::Truncated | IdentityError::LimitExceeded => VersionGateError::Truncated,
        IdentityError::ParseFailed | IdentityError::Io => VersionGateError::ParseFailed,
    }
}

/// FIXED5 缩放值 → 精确十进制文本（真值 = raw / 100_000，固定 5 位小数）。
fn format_fixed5(raw: i64) -> String {
    let neg = raw < 0;
    let abs = raw.unsigned_abs();
    format!(
        "{}{}.{:05}",
        if neg { "-" } else { "" },
        abs / 100_000,
        abs % 100_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use jomini::Scalar;
    use jomini::binary::Token;

    /// 用 jomini 自带 Token 序列化构造二进制 buffer（与 builder 测试同模式）。
    fn bin(tokens: &[Token]) -> Vec<u8> {
        let mut v = Vec::new();
        for t in tokens {
            t.write(&mut v).unwrap();
        }
        v
    }

    /// FIXED5 lexeme（jomini Token::write 不支持，手工拼字节）。
    fn fixed5_bytes(lexeme: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = lexeme.to_le_bytes().to_vec();
        v.extend_from_slice(payload);
        v
    }

    fn melt_to_string(data: &[u8]) -> (String, u64) {
        let stats = new_stats();
        let mut reader = MeltReader::new(std::io::Cursor::new(data), stats.clone());
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        (out, stats.unresolved_tokens.get())
    }

    /// name → token id（测试用反向查表）。
    fn tid(name: &str) -> u16 {
        tokens::TOKENS
            .iter()
            .find(|(_, n)| *n == name)
            .unwrap_or_else(|| panic!("token for {name} missing"))
            .0
    }

    #[test]
    fn melts_simple_fields() {
        let data = bin(&[
            Token::Id(tid("version")),
            Token::Equal,
            Token::Quoted(Scalar::new(b"1.19.0.6")),
            Token::Id(tid("size")),
            Token::Equal,
            Token::U32(42),
        ]);
        let (text, unresolved) = melt_to_string(&data);
        assert_eq!(text, "version=\"1.19.0.6\"\nsize=42\n");
        assert_eq!(unresolved, 0);
    }

    #[test]
    fn melts_id_value_and_nested_group() {
        // type=<Id> 枚举式值 + 嵌套组。
        let data = bin(&[
            Token::Id(tid("type")),
            Token::Equal,
            Token::Id(tid("value")),
            Token::Id(tid("data")),
            Token::Equal,
            Token::Open,
            Token::Id(tid("identity")),
            Token::Equal,
            Token::I32(-7),
            Token::Close,
        ]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "type=value\ndata={\nidentity=-7\n}\n");
    }

    #[test]
    fn melts_integer_keys_and_bare_value_array() {
        // 整数键 + 裸值数组元素混合。
        let data = bin(&[
            Token::U32(1001),
            Token::Equal,
            Token::Open,
            Token::I32(1),
            Token::I32(2),
            Token::Quoted(Scalar::new(b"three")),
            Token::Close,
        ]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "1001={\n1\n2\n\"three\"\n}\n");
    }

    #[test]
    fn melts_bare_id_array_elements() {
        // 组内后无 Equal 的 Id 是元素不是字段（sieges/action_history 实证）。
        let data = bin(&[
            Token::Id(tid("tags")),
            Token::Equal,
            Token::Open,
            Token::Id(tid("name")),
            Token::Id(tid("type")),
            Token::Close,
        ]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "tags={\nname\ntype\n}\n");
    }

    #[test]
    fn melts_rgb_bool_floats_and_empty_string() {
        let data = bin(&[
            Token::Id(tid("color")),
            Token::Equal,
            Token::Rgb(Rgb {
                r: 10,
                g: 20,
                b: 30,
                a: None,
            }),
            Token::Id(tid("win")),
            Token::Equal,
            Token::Bool(true),
            Token::Id(tid("weight")),
            Token::Equal,
            Token::F32(0.5f32.to_le_bytes()),
            Token::Id(tid("name")),
            Token::Equal,
            Token::Quoted(Scalar::new(b"")),
        ]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(
            text,
            "color=rgb { 10 20 30 }\nwin=yes\nweight=0.500000\nname=\"\"\n"
        );
    }

    #[test]
    fn melts_fixed5_exactly() {
        let mut data = Vec::new();
        data.extend_from_slice(&tid("amount").to_le_bytes());
        data.extend_from_slice(&0x0001u16.to_le_bytes()); // Equal
        // FIXED5_U8 raw=5 → 0.00005
        data.extend_from_slice(&fixed5_bytes(0x0d48, &[5]));
        // FIXED5_I16 raw=-12500（magnitude 12500 = 0x30D4）→ -0.12500
        data.extend_from_slice(&tid("amount").to_le_bytes());
        data.extend_from_slice(&0x0001u16.to_le_bytes());
        data.extend_from_slice(&fixed5_bytes(0x0d50, &12_500u16.to_le_bytes()));
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "amount=0.00005\namount=-0.12500\n");
        assert_eq!(format_fixed5(0), "0.00000");
        assert_eq!(format_fixed5(-1), "-0.00001");
    }

    #[test]
    fn unresolved_tokens_degrade_and_count() {
        let data = bin(&[
            Token::Id(0xffff), // 不在表内
            Token::Equal,
            Token::I32(1),
            Token::Id(tid("type")),
            Token::Equal,
            Token::Id(0xfffe), // 未解析 Id 值
        ]);
        let (text, unresolved) = melt_to_string(&data);
        assert_eq!(text, "unknown_0xffff=1\ntype=\"0xfffe\"\n");
        assert_eq!(unresolved, 2);
    }

    #[test]
    fn date_field_i32_hours_convert_back() {
        // 867.1.15 → hours = ((867+5000)*365 + 14)*24
        let hours = ((867i64 + 5000) * 365 + 14) * 24;
        let data = bin(&[Token::Id(tid("date")), Token::Equal, Token::I32(hours as i32)]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "date=867.1.15\n");
    }

    #[test]
    fn binary_hours_to_date_roundtrip_boundaries() {
        // 与 builder date_to_binary_hours 互逆的边界：年初/年末/小时/负年。
        let cases = [
            (867, 1, 1, None),
            (867, 12, 31, None),
            // 文本小时 H=1 ↔ hour0=0，与无小时部分同编码（builder 正向公式
            // 同样把缺省小时映射为 hour0=0），逆转换不输出第四段。
            (1066, 9, 26, Some(1)),
            (1066, 9, 26, Some(24)),
            (-100, 1, 1, None),
            (-100, 6, 30, Some(13)),
            (1, 1, 1, None),
        ];
        for (y, m, d, h) in cases {
            let doy0: i64 = MONTH_DAYS[..(m - 1) as usize].iter().sum::<i64>() + (d as i64 - 1);
            let hour0 = h.map(|x| x as i64 - 1).unwrap_or(0);
            let hours = ((y as i64 + 5000) * 365 + doy0) * 24 + hour0;
            let expected = match h {
                None | Some(1) => format!("{y}.{m}.{d}"),
                Some(h) => format!("{y}.{m}.{d}.{h}"),
            };
            assert_eq!(binary_hours_to_date(hours).as_deref(), Some(expected.as_str()));
        }
        // 小时进位边界：文本 H=1 ↔ hour0=0 → 不输出第四段。
        let hours = ((867i64 + 5000) * 365) * 24;
        assert_eq!(binary_hours_to_date(hours).as_deref(), Some("867.1.1"));
    }

    #[test]
    fn truncated_stream_is_unexpected_eof() {
        // 组未闭合：read 必须报 UnexpectedEof，不得 panic 或静默成功。
        let data = bin(&[Token::Id(tid("data")), Token::Equal, Token::Open, Token::I32(1)]);
        let stats = new_stats();
        let mut reader = MeltReader::new(std::io::Cursor::new(&data[..]), stats);
        let mut out = Vec::new();
        let err = reader.read_to_end(&mut out).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn corrupt_equal_at_level_start_is_invalid_data() {
        let data = bin(&[Token::Equal, Token::I32(1)]);
        let stats = new_stats();
        let mut reader = MeltReader::new(std::io::Cursor::new(&data[..]), stats);
        let mut out = Vec::new();
        let err = reader.read_to_end(&mut out).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn mid_token_truncation_is_unexpected_eof() {
        // 字符串声明长度超出剩余字节。
        let mut data = bin(&[Token::Id(tid("name")), Token::Equal]);
        data.extend_from_slice(&LexemeId::QUOTED.0.to_le_bytes());
        data.extend_from_slice(&100u16.to_le_bytes());
        data.extend_from_slice(b"short");
        let stats = new_stats();
        let mut reader = MeltReader::new(std::io::Cursor::new(&data[..]), stats);
        let mut out = Vec::new();
        let err = reader.read_to_end(&mut out).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn quoted_string_escaping_roundtrips_through_scanner() {        let raw = b"a\"b\\c".to_vec();
        let data = bin(&[
            Token::Id(tid("name")),
            Token::Equal,
            Token::Quoted(Scalar::new(&raw)),
        ]);
        let (text, _) = melt_to_string(&data);
        assert_eq!(text, "name=\"a\\\"b\\\\c\"\n");
        // 经 Scanner 读回应还原原字节。
        let limits = ScanLimits {
            max_bytes: 1 << 20,
            max_nesting: 16,
            max_scalar: 4096,
        };
        let mut scanner = Scanner::new(std::io::Cursor::new(text.into_bytes()), limits);
        assert!(matches!(scanner.next_token(), Ok(TextToken::Scalar(_))));
        scanner.expect_eq().unwrap();
        match scanner.next_token() {
            Ok(TextToken::Str(v)) => assert_eq!(v, raw),
            other => panic!("unexpected token: {other:?}"),
        }
    }

    #[test]
    fn version_gate_accepts_matching_version() {
        let data = bin(&[
            Token::Id(tid("meta_data")),
            Token::Equal,
            Token::Open,
            Token::Id(tid("version")),
            Token::Equal,
            Token::Quoted(Scalar::new(tokens::TOKEN_TABLE_CK3_VERSION.as_bytes())),
            Token::Close,
            Token::Id(tid("living")),
            Token::Equal,
            Token::Open,
            Token::Close,
        ]);
        assert_eq!(
            check_version(std::io::Cursor::new(&data[..]), 1 << 20),
            Ok(())
        );
    }

    #[test]
    fn version_gate_rejects_mismatch_and_missing() {
        let mk = |version: &str| {
            bin(&[
                Token::Id(tid("meta_data")),
                Token::Equal,
                Token::Open,
                Token::Id(tid("version")),
                Token::Equal,
                Token::Quoted(Scalar::new(version.as_bytes())),
                Token::Close,
            ])
        };
        assert_eq!(
            check_version(std::io::Cursor::new(&mk("1.18.0.0")[..]), 1 << 20),
            Err(VersionGateError::Mismatch)
        );
        // meta_data 存在但无 version 字段 → mismatch（不猜版本）。
        let no_version = bin(&[
            Token::Id(tid("meta_data")),
            Token::Equal,
            Token::Open,
            Token::Id(tid("name")),
            Token::Equal,
            Token::Quoted(Scalar::new(b"x")),
            Token::Close,
        ]);
        assert_eq!(
            check_version(std::io::Cursor::new(&no_version[..]), 1 << 20),
            Err(VersionGateError::Mismatch)
        );
        // meta 段缺失（结构完好但无 meta_data）→ truncated。
        let no_meta = bin(&[
            Token::Id(tid("living")),
            Token::Equal,
            Token::Open,
            Token::Close,
        ]);
        assert_eq!(
            check_version(std::io::Cursor::new(&no_meta[..]), 1 << 20),
            Err(VersionGateError::Truncated)
        );
        // 任意垃圾字节 → 损坏（裸 Id 值 melt 成引号字符串，root 层不合法）。
        assert_eq!(
            check_version(std::io::Cursor::new(&b"\x00\x01garbage"[..]), 1 << 20),
            Err(VersionGateError::ParseFailed)
        );
    }

    #[test]
    fn downstream_limits_apply_to_melted_stream() {
        // 嵌套深度与字节预算由下游 scanner 既有逻辑强制执行（melt 只是
        // 字节流来源）；这里验证 melt 输出接入后限额确实生效。
        let deep = bin(&vec![Token::Open; 70]);
        let stats = new_stats();
        let melt = MeltReader::new(std::io::Cursor::new(&deep[..]), stats);
        let limits = ScanLimits {
            max_bytes: 1 << 20,
            max_nesting: 64,
            max_scalar: 4096,
        };
        let mut scanner = Scanner::new(melt, limits);
        let result = loop {
            match scanner.next_token() {
                Err(e) => break Err(e),
                Ok(TextToken::Eof) => break Ok(()),
                _ => {}
            }
        };
        assert_eq!(result, Err(IdentityError::LimitExceeded));

        // 字节预算：melt 文本超过 cap 即超限。
        let data = bin(&[
            Token::Id(tid("meta_data")),
            Token::Equal,
            Token::Open,
            Token::Id(tid("version")),
            Token::Equal,
            Token::Quoted(Scalar::new(b"1.19.0.6")),
            Token::Close,
        ]);
        let stats = new_stats();
        let melt = MeltReader::new(std::io::Cursor::new(&data[..]), stats);
        let limits = ScanLimits {
            max_bytes: 8,
            max_nesting: 64,
            max_scalar: 4096,
        };
        let mut scanner = Scanner::new(melt, limits);
        let result = loop {
            match scanner.next_token() {
                Err(e) => break Err(e),
                Ok(TextToken::Eof) => break Ok(()),
                _ => {}
            }
        };
        assert_eq!(result, Err(IdentityError::LimitExceeded));
    }

    /// 实机 probe（规划 §7.2）：melt 真实二进制存档开头，人工确认 meta 段
    /// 各字段编码（尤其 `meta_date` 与 `meta_data.version`）。用法：
    /// `VOTC_PROBE_SAVE=<path.ck3> cargo test --bin votc-save-facts real_save_head_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_save_head_probe() {
        let path = match std::env::var("VOTC_PROBE_SAVE") {
            Ok(p) => p,
            Err(_) => panic!("set VOTC_PROBE_SAVE to a binary .ck3 path"),
        };
        let opened = crate::envelope::open(std::path::Path::new(&path)).unwrap();
        assert!(opened.is_binary(), "probe target must be a binary save");
        let stats = new_stats();
        let binary = opened.gamestate_binary().unwrap();
        let mut reader = MeltReader::new(binary, stats.clone());
        let mut head = vec![0u8; 64 * 1024];
        let n = reader.read(&mut head).unwrap();
        println!("--- melt head ({} bytes) ---", n);
        println!("{}", String::from_utf8_lossy(&head[..n]));
        println!(
            "--- unresolved tokens so far: {} ---",
            stats.unresolved_tokens.get()
        );
    }

    /// 实机全量 melt probe：统计 melt 输出字节与未解析 token 数（token 表
    /// 覆盖率验证）。设置 `VOTC_PROBE_OUT=<path>` 时把 melt 文本整体写盘，
    /// 供与配对明文存档 diff。用法同 `real_save_head_probe`。
    #[test]
    #[ignore]
    fn real_save_full_melt_probe() {
        let path = match std::env::var("VOTC_PROBE_SAVE") {
            Ok(p) => p,
            Err(_) => panic!("set VOTC_PROBE_SAVE to a binary .ck3 path"),
        };
        let opened = crate::envelope::open(std::path::Path::new(&path)).unwrap();
        assert!(opened.is_binary(), "probe target must be a binary save");
        let stats = new_stats();
        let binary = opened.gamestate_binary().unwrap();
        let mut reader = MeltReader::new(binary, stats.clone());
        let mut out_file = std::env::var("VOTC_PROBE_OUT").ok().map(|p| {
            std::io::BufWriter::new(std::fs::File::create(p).expect("create VOTC_PROBE_OUT"))
        });
        let mut total = 0u64;
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total += n as u64;
                    if let Some(f) = out_file.as_mut() {
                        use std::io::Write;
                        f.write_all(&buf[..n]).expect("write VOTC_PROBE_OUT");
                    }
                }
                Err(e) => panic!("melt failed at {total} bytes: {e}"),
            }
        }
        println!(
            "full melt ok: {} text bytes, {} unresolved tokens",
            total,
            stats.unresolved_tokens.get()
        );
    }
}
