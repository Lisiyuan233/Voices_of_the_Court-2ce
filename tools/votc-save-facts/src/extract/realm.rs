//! landed_titles 块的选择性解析（实施计划 Task 4 步骤 1/4）。
//!
//! **raw schema 假定（合成结构，字段名待真实脱敏存档确认）**：
//!
//! ```text
//! landed_titles={
//!   <titleId>={
//!     key="title_some_place"      // localization key（不得当 display string）
//!     name="Literal Custom Name"  // 可选：自定义 literal 名
//!     holder=<charId>             // 当前持有人
//!     ...
//!   }
//! }
//! ```
//!
//! 白名单制：只读取 key / name / holder，其余（de_jure_*、历史、claim
//! 等）一律跳过。

use std::io::Read;

use super::super::identity::{IdentityError, Scanner, Token};

#[derive(Debug, Default)]
pub(crate) struct TitleRecord {
    /// `key=` 原始 loc key。
    pub key: Option<String>,
    /// `name=` literal 自定义名（优先于 key 作为 displayNameCandidate）。
    pub name: Option<String>,
    pub holder: Option<String>,
    pub de_facto_liege: Option<String>,
    pub de_jure_liege: Option<String>,
    pub duplicate_key: bool,
}

fn assign_once(slot: &mut Option<String>, value: String, duplicate: &mut bool) {
    if slot.is_some() {
        *duplicate = true;
    } else {
        *slot = Some(value);
    }
}

fn read_id_value<R: Read>(scanner: &mut Scanner<R>) -> Result<String, IdentityError> {
    match scanner.next_token()? {
        Token::Scalar(v) | Token::Str(v)
            if !v.is_empty() && v.iter().all(|b| b.is_ascii_digit()) =>
        {
            String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)
        }
        Token::Eof => Err(IdentityError::Truncated),
        _ => Err(IdentityError::ParseFailed),
    }
}

fn scan_title_name_data<R: Read>(
    scanner: &mut Scanner<R>,
    rec: &mut TitleRecord,
) -> Result<(), IdentityError> {
    scanner.expect_lbrace()?;
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(()),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                if key == b"name" {
                    match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            let name =
                                String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?;
                            assign_once(&mut rec.name, name, &mut rec.duplicate_key);
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

/// 解析一个 title 记录（进入时 `<id>=` 已读，期望 `{`）。
pub(crate) fn scan_title<R: Read>(scanner: &mut Scanner<R>) -> Result<TitleRecord, IdentityError> {
    scanner.expect_lbrace()?;
    let mut rec = TitleRecord::default();
    loop {
        match scanner.next_token()? {
            Token::RBrace => return Ok(rec),
            Token::Eof => return Err(IdentityError::Truncated),
            Token::Scalar(key) => {
                scanner.expect_eq()?;
                match key.as_slice() {
                    b"key" | b"name" => match scanner.next_token()? {
                        Token::Str(v) | Token::Scalar(v) => {
                            let s = String::from_utf8(v).map_err(|_| IdentityError::ParseFailed)?;
                            if key == b"key" {
                                assign_once(&mut rec.key, s, &mut rec.duplicate_key);
                            } else {
                                assign_once(&mut rec.name, s, &mut rec.duplicate_key);
                            }
                        }
                        _ => return Err(IdentityError::ParseFailed),
                    },
                    b"holder" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.holder, id, &mut rec.duplicate_key);
                    }
                    b"de_facto_liege" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.de_facto_liege, id, &mut rec.duplicate_key);
                    }
                    b"de_jure_liege" => {
                        let id = read_id_value(scanner)?;
                        assign_once(&mut rec.de_jure_liege, id, &mut rec.duplicate_key);
                    }
                    b"title_name_data" => scan_title_name_data(scanner, &mut rec)?,
                    _ => scanner.skip_value()?,
                }
            }
            _ => return Err(IdentityError::ParseFailed),
        }
    }
}

// ---------------------------------------------------------------------------
// realm predicate 构造（registry 见计划 5.5 节）
// ---------------------------------------------------------------------------

use super::normalize::FactSink;
use crate::protocol::{
    Category, Confidence, EntityType, FactSensitivity, FactVisibility, Predicate,
};

// canonical source path 枚举值（见 family.rs 注释；raw save 路径永不过线）。
const SRC_LIEGE: &str = "character_liege";
const SRC_PRIMARY_TITLE: &str = "character_primary_title";
const SRC_DIRECT_VASSAL_OF: &str = "character_direct_vassal_of";
const SRC_REALM_CAPITAL: &str = "character_realm_capital";
const SRC_TITLE_HOLDER: &str = "title_holder";

/// participant 的直接领主与主要头衔。只在 participant 角色上调用
/// （一跳邻域：related character 的领主/头衔不展开）。
pub(crate) fn record_character_realm(
    sink: &mut FactSink,
    char_id: &str,
    primary_title: Option<&str>,
    liege: Option<&str>,
    direct_vassal_of: Option<&str>,
    realm_capital: Option<&str>,
    title_index: &std::collections::HashMap<String, TitleRecord>,
) {
    if let Some(liege) = liege {
        sink.push_fact(
            Category::Realm,
            (EntityType::Character, char_id),
            Predicate::CharacterLiege,
            Some((EntityType::Character, liege)),
            SRC_LIEGE,
            Confidence::Exact,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
    if let Some(title) = primary_title {
        sink.push_fact(
            Category::Realm,
            (EntityType::Character, char_id),
            Predicate::CharacterPrimaryTitle,
            Some((EntityType::Title, title)),
            SRC_PRIMARY_TITLE,
            Confidence::Exact,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
    if let Some(vassal_of) = direct_vassal_of.filter(|id| *id != char_id) {
        sink.push_fact(
            Category::Realm,
            (EntityType::Character, char_id),
            Predicate::CharacterDirectVassalOf,
            Some((EntityType::Character, vassal_of)),
            SRC_DIRECT_VASSAL_OF,
            Confidence::Exact,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
    // Require a bounded public title record; never expose an unvalidated raw
    // location/estate field as a realm capital.
    if let Some(capital) = realm_capital.filter(|id| title_index.contains_key(*id)) {
        sink.push_fact(
            Category::Realm,
            (EntityType::Character, char_id),
            Predicate::CharacterRealmCapital,
            Some((EntityType::Title, capital)),
            SRC_REALM_CAPITAL,
            Confidence::Mapped,
            FactVisibility::Public,
            FactSensitivity::Political,
        );
    }
}

/// Resolve the direct liege through the participant's primary title.  CK3
/// stores the upper title id on the title record; that title's current holder
/// is the character liege.  De-facto hierarchy wins, with de-jure as fallback.
pub(crate) fn resolve_title_liege<'a>(
    primary_title: &str,
    titles: &'a std::collections::HashMap<String, TitleRecord>,
) -> Option<&'a str> {
    let primary = titles.get(primary_title)?;
    for liege_title in [
        primary.de_facto_liege.as_deref(),
        primary.de_jure_liege.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if liege_title == "0" || liege_title == primary_title {
            continue;
        }
        if let Some(holder) = titles
            .get(liege_title)
            .and_then(|record| record.holder.as_deref())
        {
            return Some(holder);
        }
    }
    None
}

/// `title.holder`：只作内部反向索引（visibility omniscient_internal，
/// 默认不直接渲染）。只在 holder 是 participant 时产出（一跳）。
pub(crate) fn record_title_holder(sink: &mut FactSink, title_id: &str, holder: &str) {
    sink.push_fact(
        Category::Realm,
        (EntityType::Title, title_id),
        Predicate::TitleHolder,
        Some((EntityType::Character, holder)),
        SRC_TITLE_HOLDER,
        Confidence::Exact,
        FactVisibility::OmniscientInternal,
        FactSensitivity::Political,
    );
}
