//! living 角色块的选择性解析（实施计划 Task 4 步骤 1/2）。
//!
//! **raw schema 假定（合成结构，字段名待真实脱敏存档确认，见
//! tests/fixtures/README.md）**——按 CK3 公开已知的 jomini-text 结构合成：
//!
//! ```text
//! living={
//!   <charId>={
//!     first_name="Placeholder"        // literal 名（displayNameCandidate）
//!     mother=<charId>                 // 公开母亲（只接受普通字段）
//!     father=<charId>                 // 公开父亲
//!     spouse=<charId>                 // 可重复
//!     alive_data={
//!       liege=<charId>                // 直接领主
//!       primary_title=<titleId>       // 主要头衔
//!     }
//!     real_father=<charId>            // 禁止：永不读取（白名单之外，直接跳过）
//!     ...
//!   }
//! }
//! ```
//!
//! 解析是白名单制：只有上面列出的 key 会被读取；`real_father`、
//! hidden relation、secret、AI、mod 私货等一切其他 key 都在 extractor
//! 层直接 `skip_value` 跳过（不是读取后过滤）。没有 fixture 证明的字段
//! 不进 predicate registry。

use std::io::Read;

use super::super::identity::{IdentityError, Scanner, Token};

/// 一个角色记录中会被提取的白名单字段（其余一律跳过）。
#[derive(Debug, Clone, Default)]
pub(crate) struct CharacterRecord {
    pub first_name: Option<String>,
    /// `first_name` 是否为 `<base>_<XXXX>…` 本地化键形态（CK3 1.19 非
    /// Latin1 名字机制）。为 true 时下游按 DisplayNameKind::LocalizationKey 输出。
    pub first_name_is_localization_key: bool,
    pub mother: Option<String>,
    pub father: Option<String>,
    pub spouses: Vec<String>,
    /// Public children listed by CK3 1.19 under `family_data.child`.
    pub children: Vec<String>,
    pub liege: Option<String>,
    pub direct_vassal_of: Option<String>,
    pub primary_title: Option<String>,
    pub realm_capital: Option<String>,
    /// Held titles from CK3 1.19 `landed_data.domain`, in save order.  The
    /// first title is the primary title.
    pub domains: Vec<String>,
    /// Public location from `alive_data.location.location` (F1, real CK3
    /// 1.19.0.6 shape). Activity/travel/position fields (F2/F3/F5) are
    /// intentionally NOT read: the save only carries script template ids.
    pub current_location: Option<String>,
    /// Court host from `court_data.host` (F4, real CK3 1.19.0.6 shape).
    pub court_owner: Option<String>,
    /// 出现了重复的单值 key（确定性选择 first wins，调用方记 warning）。
    pub duplicate_key: bool,
}

/// 标量必须是十进制角色/头衔 ID（数字字符串），否则 ParseFailed。
fn parse_id(raw: &[u8]) -> Result<String, IdentityError> {
    if raw.is_empty() || !raw.iter().all(|b| b.is_ascii_digit()) {
        return Err(IdentityError::ParseFailed);
    }
    // 纯 ASCII 数字，from_utf8 不会失败。
    std::str::from_utf8(raw)
        .map(str::to_string)
        .map_err(|_| IdentityError::ParseFailed)
}

/// first-wins：重复单值 key 保留第一个，标记 duplicate。
fn assign_once(slot: &mut Option<String>, value: String, duplicate: &mut bool) {
    if slot.is_some() {
        *duplicate = true;
    } else {
        *slot = Some(value);
    }
}

fn read_id_value<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(v) | Token::Str(v) => parse_id(&v),
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn scan_id_list<R: Read>(scanner: &mut Scanner<R>) -> Result<Vec<String>, IdentityError> {
    scanner.expect_lbrace()?;
    let mut ids = Vec::new();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(ids),
            Token::Scalar(v) | Token::Str(v) => ids.push(parse_id(&v)?),
            Token::Eof => return Err(IdentityError::Truncated),
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// CK3 1.19 把含非 Latin1 字符的角色名写成 `<base>_<XXXX>…` 形式的
/// 本地化键（每个下划线分段都是 4 位十六进制码元），并在语言文件里
/// 提供 `键: "真名"` 条目。此类名字必须保留为 localization_key 候选，
/// 由 App 侧本地化目录解析显示名。
///
/// 仅当跳过 base 段后**每一段**都是 4 位 hex 且至少存在一段才认定为
/// 键形态；普通西文名（如 `Wilhelm_the_Dead`，仅末段恰为 hex）保持 literal。
///
/// 已知盲区（实测原版 chinese_character_names_l_english.yml 11,744 键中约
/// 19 个）：罗马化 base 自身含下划线的键（如 `A_cang_963F_81E7`）会被判为
/// literal，原始存档标识符可能作为显示名透出。后果被 live GameData 名称
/// （priority-1 权威）遮蔽；Phase 3 查询落地时应改为解析期用真实目录校验
/// 键形态，本启发式仅作提取期 best-effort 预分类。
fn is_obfuscated_first_name(name: &str) -> bool {
    let mut parts = name.split('_');
    let base = parts.next();
    let rest: Vec<&str> = parts.collect();
    !base.unwrap_or_default().is_empty()
        && !rest.is_empty()
        && rest
            .iter()
            .all(|s| s.len() == 4 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// CK3 1.19 family data.  `real_father` and all unknown/hidden relationship
/// fields are deliberately skipped at the parser boundary.
fn scan_family_data<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut CharacterRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"primary_spouse" | b"spouse" => {
                        rec.spouses.push(read_id_value(scanner)?);
                    }
                    b"child" => rec.children.extend(scan_id_list(scanner)?),
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// CK3 1.19 landed data.  Only the public domain title list is admitted.
fn scan_landed_data<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut CharacterRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"domain" {
                    if rec.domains.is_empty() {
                        rec.domains = scan_id_list(scanner)?;
                    } else {
                        rec.duplicate_key = true;
                        scanner.skip_value()?;
                    }
                } else if key == b"realm_capital" {
                    assign_once(
                        &mut rec.realm_capital,
                        read_id_value(scanner)?,
                        &mut rec.duplicate_key,
                    );
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// alive_data 块：只取 liege / primary_title / location / direct_vassal_of，其余跳过。
fn scan_alive_data<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut CharacterRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"liege" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.liege, id, &mut rec.duplicate_key);
                    }
                    b"direct_vassal_of" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.direct_vassal_of, id, &mut rec.duplicate_key);
                    }
                    b"primary_title" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.primary_title, id, &mut rec.duplicate_key);
                    }
                    // F1 (2026-08-12 real-save verification): the public
                    // location is a nested `location={ location=<id> }` block.
                    b"location" => scan_alive_location(scanner, rec)?,
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// `alive_data.location={ location=<id> }` (CK3 1.19.0.6). Only the
/// `location` scalar is read; any other key is skipped.
fn scan_alive_location<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut CharacterRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key.as_slice() == b"location" {
                    let id = read_id_value(scanner)?;
                    assign_once(&mut rec.current_location, id, &mut rec.duplicate_key);
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// F4 (2026-08-12 real-save verification): CK3 1.19.0.6 `court_data` stores
/// the hosting court as `host=<id>`. Council/court positions (F5) are
/// template-id lists (`court_positions={ <ids> }` / title `council={...}`)
/// with no names in the save, so they are NOT read here.
fn scan_court_data<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut CharacterRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key.as_slice() == b"host" {
                    assign_once(
                        &mut rec.court_owner,
                        read_id_value(scanner)?,
                        &mut rec.duplicate_key,
                    );
                } else {
                    scanner.skip_value()?;
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

/// 解析一个角色记录（进入时 `<id>=` 已读，期望 `{`）。
pub(crate) fn scan_character<R: Read>(
    scanner: &mut Scanner<R>,
) -> Result<CharacterRecord, IdentityError> {
    scanner.expect_lbrace()?;
    let mut rec = CharacterRecord::default();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(rec),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"first_name" => match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            let name =
                                String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?;
                            if is_obfuscated_first_name(&name) {
                                rec.first_name_is_localization_key = true;
                            }
                            assign_once(&mut rec.first_name, name, &mut rec.duplicate_key);
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    b"mother" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.mother, id, &mut rec.duplicate_key);
                    }
                    b"father" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.father, id, &mut rec.duplicate_key);
                    }
                    b"spouse" => {
                        // 可重复 key：每次都接受（多段婚姻）。
                        rec.spouses.push(read_id_value(scanner)?);
                    }
                    b"family_data" => scan_family_data(scanner, &mut rec)?,
                    b"landed_data" => scan_landed_data(scanner, &mut rec)?,
                    b"alive_data" => scan_alive_data(scanner, &mut rec)?,
                    b"court_data" => scan_court_data(scanner, &mut rec)?,
                    // F2/F3（current_activity / traveling）与 F5（职位）在
                    // 真实存档中无名称/布尔字段，白名单之外直接跳过。
                    // real_father / hidden relation / secrets / AI / 未知 key：
                    // 全部在这里直接跳过，从不读取。
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}
