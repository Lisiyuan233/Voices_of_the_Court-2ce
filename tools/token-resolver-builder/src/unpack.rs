//! Envelope 解包：打开 SAV010x 存档并读取 gamestate entry 的字节内容。
//!
//! 本工具是开发期构建器，直接使用 jomini envelope 的默认 entry 策略，
//! 不复制 votc-save-facts 的严格防护（严格 entry 名校验、zip bomb 上限等）。

use std::io::Read;
use std::path::Path;

use jomini::envelope::{JominiFile, SaveContentKind};

/// gamestate entry 的内容，按 envelope 判定区分明文 / 二进制。
pub enum Gamestate {
    Text(Vec<u8>),
    Binary(Vec<u8>),
}

/// 打开存档并读取整个 gamestate entry 到内存。
pub fn read_gamestate(path: &Path) -> Result<Gamestate, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let jomini = JominiFile::from_file(file)
        .map_err(|e| format!("envelope {}: {e}", path.display()))?;
    let content = jomini
        .gamestate()
        .map_err(|e| format!("gamestate entry {}: {e}", path.display()))?;
    match content {
        SaveContentKind::Text(mut reader) => {
            let mut buf = Vec::new();
            reader
                .read_to_end(&mut buf)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            Ok(Gamestate::Text(buf))
        }
        SaveContentKind::Binary(mut reader) => {
            let mut buf = Vec::new();
            reader
                .read_to_end(&mut buf)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            Ok(Gamestate::Binary(buf))
        }
    }
}
