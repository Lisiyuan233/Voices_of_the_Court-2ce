//! Envelope 识别（实施计划 Task 3 步骤 1-3）。
//!
//! 基于 jomini 的 envelope 抽象（`SaveHeader` + rawzip central directory
//! 定位），而不是「文件头是否 PK」：
//!
//! - rawzip 从文件尾部最多 64 KiB 搜索 central directory，因此带 SAV 前缀
//!   的 ZIP（local header 不在 offset 0）能被正确定位；
//! - `SAV0100` 纯文本（unified text）；
//! - `SAV0102` 风格 prefixed ZIP + text gamestate；
//! - ZIP + binary header → zip_binary；无 ZIP + binary header →
//!   unified_binary；binary 内容绝不交给文本 scanner；
//! - header 声称是 ZIP 格式（Unified/Split）但 central directory 定位失败
//!   → 截断/损坏，不是 unified text；
//! - 无法解析的 header / Other kind → unknown。
//!
//! ZIP entry 策略（比 jomini 默认更严格）：只认字节精确等于 `gamestate`
//! 的 entry（`../gamestate`、绝对路径、大小写变体自然不匹配），0 个 →
//! `EntryMissing`，多于 1 个 → `DuplicateGamestate`（不任意选择）。
//! entry 只通过 reader 读取，绝不写盘。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use jomini::envelope::{JominiFile, JominiFileKind, SaveContentKind, SaveHeaderKind};
use rawzip::FileReader;

use crate::limits;
use crate::protocol::SourceFormat;

/// 只接受这个名字的 gamestate entry（字节精确比较）。
const GAMESTATE_ENTRY: &[u8] = b"gamestate";

/// rawzip 从文件尾部搜索 EOCD 的最大范围（与 jomini 内部一致）。
const EOCD_SEARCH_SPACE: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeError {
    /// 文件太小 / header 不完整 / header 声称 ZIP 但 central directory
    /// 定位失败 / ZIP 结构损坏。
    Truncated,
    /// 不是 SAV envelope 或 kind 无法识别。
    Unknown,
    /// ZIP 中没有名为 gamestate 的 entry。
    EntryMissing,
    /// ZIP 中有多个同名 gamestate entry，不任意选择。
    DuplicateGamestate,
    /// ZIP 宣称的 gamestate 解压后大小超过硬上限（zip bomb 前置防线）。
    DeclaredTooLarge,
    /// ZIP 压缩方式不属于已支持变体（jomini envelope 只支持 deflate）。
    UnsupportedCompression,
}

pub struct OpenedSave {
    pub format: SourceFormat,
    /// envelope header 行原始字节（供 fingerprint 使用，不含路径）。
    pub header_line: Vec<u8>,
    /// ZIP 宣称的 gamestate 解压后大小（仅 ZIP 格式有）。
    pub gamestate_uncompressed_hint: Option<u64>,
    jomini: JominiFile<FileReader>,
}

impl OpenedSave {
    /// binary 格式（zip_binary / unified_binary）已识别但不提供 reader，
    /// 调用方返回 unsupported（无 token resolver）。
    pub fn is_binary(&self) -> bool {
        matches!(
            self.format,
            SourceFormat::ZipBinary | SourceFormat::UnifiedBinary
        )
    }

    /// text gamestate reader（含 ZIP 解压流），借用 self。
    pub fn gamestate(&self) -> Result<Box<dyn Read + '_>, EnvelopeError> {
        match self.jomini.gamestate() {
            Ok(SaveContentKind::Text(body)) => Ok(body.into_inner()),
            // header 说 text 但 jomini 判 binary：不信任，拒绝。
            Ok(SaveContentKind::Binary(_)) => Err(EnvelopeError::Unknown),
            Err(e) => Err(match e.kind() {
                jomini::envelope::EnvelopeErrorKind::ZipUnsupportedCompression => {
                    EnvelopeError::UnsupportedCompression
                }
                _ => EnvelopeError::Truncated,
            }),
        }
    }

    /// text gamestate reader，ZIP 时带 CRC/size 校验（读到 EOF 时验证）。
    /// extract 路径使用（extract 会读完整条流）；probe 提前停止，用
    /// `gamestate()` 即可（尾部 CRC 不验证，由 extract 兜底）。
    pub fn gamestate_verified(&self) -> Result<Box<dyn Read + '_>, EnvelopeError> {
        match self.jomini.kind() {
            JominiFileKind::Zip(zip) => match zip.gamestate_verified() {
                Ok(SaveContentKind::Text(reader)) => Ok(Box::new(reader)),
                Ok(SaveContentKind::Binary(_)) => Err(EnvelopeError::Unknown),
                Err(e) => Err(match e.kind() {
                    jomini::envelope::EnvelopeErrorKind::ZipUnsupportedCompression => {
                        EnvelopeError::UnsupportedCompression
                    }
                    _ => EnvelopeError::Truncated,
                }),
            },
            JominiFileKind::Uncompressed(_) => self.gamestate(),
        }
    }
}

/// header kind + ZIP 定位结果 → SourceFormat 的共享判定矩阵
///（open 与 classify_bytes 共用，避免两处漂移）。
/// `gamestate_entries`：Some(n) 表示定位到 ZIP 且精确名为 gamestate 的
/// entry 有 n 个；None 表示没有定位到 ZIP。
fn decide_format(
    kind: SaveHeaderKind,
    gamestate_entries: Option<u32>,
) -> Result<SourceFormat, EnvelopeError> {
    match gamestate_entries {
        Some(0) => Err(EnvelopeError::EntryMissing),
        Some(1) => {
            if kind.is_binary() {
                Ok(SourceFormat::ZipBinary)
            } else if kind.is_text() {
                Ok(SourceFormat::ZipText)
            } else {
                Err(EnvelopeError::Unknown)
            }
        }
        Some(_) => Err(EnvelopeError::DuplicateGamestate),
        None => match kind {
            // SAV0100 纯文本：header 之后整体是 text gamestate。
            SaveHeaderKind::Text => Ok(SourceFormat::UnifiedText),
            SaveHeaderKind::Binary => Ok(SourceFormat::UnifiedBinary),
            // header 声称 ZIP（Unified/Split）但 central directory 定位
            // 失败：截断或损坏，绝不能退回按纯文本解析 ZIP 字节。
            SaveHeaderKind::UnifiedText
            | SaveHeaderKind::UnifiedBinary
            | SaveHeaderKind::SplitText
            | SaveHeaderKind::SplitBinary => Err(EnvelopeError::Truncated),
            SaveHeaderKind::Other(_) => Err(EnvelopeError::Unknown),
        },
    }
}

/// 内存版 envelope 识别（fuzz 入口；与 open() 同一判定矩阵）。
/// 不打开 entry、不做 hint 检查，只分类。
// 生产路径走 open()；本函数供 fuzz target（#[path] include）与单测使用。
#[allow(dead_code)]
pub fn classify_bytes(data: &[u8]) -> Result<SourceFormat, EnvelopeError> {
    let header = match jomini::envelope::SaveHeader::from_slice(data) {
        Ok(h) => h,
        Err(_) => {
            let looks_like_sav = data.len() >= 3 && &data[..3] == b"SAV";
            if !looks_like_sav {
                return Err(EnvelopeError::Unknown);
            }
            if data.len() < 24 || (data.len() < 33 && !data.contains(&b'\n')) {
                return Err(EnvelopeError::Truncated);
            }
            return Err(EnvelopeError::Unknown);
        }
    };
    let gamestate_entries = match rawzip::ZipArchive::with_max_search_space(EOCD_SEARCH_SPACE)
        .locate_in_slice(data)
    {
        Ok(archive) => {
            let mut count = 0u32;
            let mut entries = archive.entries();
            while let Some(entry) = entries.next_entry().map_err(|_| EnvelopeError::Truncated)? {
                if entry.file_path().as_ref() == GAMESTATE_ENTRY {
                    count += 1;
                }
            }
            Some(count)
        }
        Err(_) => None,
    };
    decide_format(header.kind(), gamestate_entries)
}

/// 打开并识别 envelope。binary / unknown / truncated / entry 问题的语义
/// 见 `EnvelopeError`；binary 是合法识别结果（Ok + is_binary()）。
pub fn open(path: &Path) -> Result<OpenedSave, EnvelopeError> {
    let file = File::open(path).map_err(|_| EnvelopeError::Truncated)?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);

    // 1) 解析 SAV header（jomini）。
    let mut head = [0u8; 64];
    let head_len = {
        let mut f = &file;
        f.read(&mut head).map_err(|_| EnvelopeError::Truncated)?
    };
    let header = match jomini::envelope::SaveHeader::from_slice(&head[..head_len]) {
        Ok(h) => h,
        Err(_) => {
            // header 不完整（文件过短、缺换行）按截断处理；完整但无法识别
            // 按 unknown 处理。
            let looks_like_sav = head_len >= 3 && &head[..3] == b"SAV";
            if !looks_like_sav {
                return Err(EnvelopeError::Unknown);
            }
            if file_size < 24 || (file_size < 33 && !head[..head_len].contains(&b'\n')) {
                return Err(EnvelopeError::Truncated);
            }
            return Err(EnvelopeError::Unknown);
        }
    };
    let header_line = head[..header.header_len().min(head_len)].to_vec();

    // 2) rawzip 从尾部定位 central directory（禁止「头部 PK」判断）。
    let mut zip_buf = vec![0u8; rawzip::RECOMMENDED_BUFFER_SIZE];
    let located = rawzip::ZipArchive::with_max_search_space(EOCD_SEARCH_SPACE)
        .locate_in_file(file, &mut zip_buf);

    // 3) 严格 entry 策略 + 判定矩阵（与 classify_bytes 共享）。
    let format = match located {
        Ok(archive) => {
            let mut gamestate_count = 0u32;
            {
                let mut entries = archive.entries(&mut zip_buf);
                while let Some(entry) =
                    entries.next_entry().map_err(|_| EnvelopeError::Truncated)?
                {
                    if entry.file_path().as_ref() == GAMESTATE_ENTRY {
                        gamestate_count += 1;
                    }
                }
            }
            decide_format(header.kind(), Some(gamestate_count))?
        }
        Err(_) => decide_format(header.kind(), None)?,
    };

    // 4) 交给 jomini envelope 持有文件并供后续读取（inlined meta /
    //    meta entry 差异由 jomini 处理；本任务只读 gamestate）。
    let jomini = JominiFile::from_file(File::open(path).map_err(|_| EnvelopeError::Truncated)?)
        .map_err(|_| EnvelopeError::Truncated)?;
    let hint = match jomini.kind() {
        JominiFileKind::Zip(zip) => Some(zip.gamestate_uncompressed_hint()),
        JominiFileKind::Uncompressed(_) => None,
    };
    if format == SourceFormat::ZipText {
        // 宣称超大 uncompressed size 直接拒绝，不进入解压流（zip bomb
        // 前置防线；流式防线在 identity 的 CountingReader）。
        if hint.is_some_and(|h| h > limits::HARD_MAX_DECOMPRESSED_BYTES) {
            return Err(EnvelopeError::DeclaredTooLarge);
        }
    }

    Ok(OpenedSave {
        format,
        header_line,
        gamestate_uncompressed_hint: hint,
        jomini,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_bytes_matches_decision_matrix() {
        // 非 SAV → unknown
        assert_eq!(classify_bytes(b"hello"), Err(EnvelopeError::Unknown));
        // SAV 但太短 → truncated
        assert_eq!(classify_bytes(b"SAV0100aa"), Err(EnvelopeError::Truncated));
        // SAV0100 完整 header → unified text
        assert_eq!(
            classify_bytes(b"SAV0100aabbccdd00000000\nmeta_data={}\n"),
            Ok(SourceFormat::UnifiedText)
        );
        // SAV0101 → unified binary
        assert_eq!(
            classify_bytes(b"SAV0101aabbccdd00000000\n\x00\x01\x02"),
            Ok(SourceFormat::UnifiedBinary)
        );
        // SAV0102 但无 ZIP → truncated（不退回纯文本）
        assert_eq!(
            classify_bytes(b"SAV0102aabbccdd00000000\nmeta_data={}\n"),
            Err(EnvelopeError::Truncated)
        );
        // Other kind → unknown
        assert_eq!(
            classify_bytes(b"SAV0199aabbccdd00000000\nmeta_data={}\n"),
            Err(EnvelopeError::Unknown)
        );
    }
}
