#![no_main]
//! 二进制 melter fuzz target（binary-save-melt-integration-plan §6.4）。
//!
//! 任意字节流喂给 `MeltReader`（全量 melt）与 `check_version`（门禁）：
//! 不得 panic、不得越界、输出消费量有界（防资源放大）。

use libfuzzer_sys::fuzz_target;

#[path = "../../src/error.rs"]
pub mod error;
#[path = "../../src/limits.rs"]
pub mod limits;
#[path = "../../src/protocol.rs"]
pub mod protocol;
#[path = "../../src/identity.rs"]
pub mod identity;
#[path = "../../src/tokens.rs"]
pub mod tokens;
#[path = "../../src/melt.rs"]
pub mod melt;

/// fuzz 侧输出消费上限（16 MiB）：melt 有文本放大，限制消费量保证有界。
const MAX_CONSUMED: u64 = 16 * 1024 * 1024;

fuzz_target!(|data: &[u8]| {
    use std::io::Read;

    let stats = melt::new_stats();
    let mut reader = melt::MeltReader::new(std::io::Cursor::new(data), stats);
    let mut consumed = 0u64;
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                consumed += n as u64;
                if consumed > MAX_CONSUMED {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let _ = melt::check_version(std::io::Cursor::new(data), 1 << 20);
});
