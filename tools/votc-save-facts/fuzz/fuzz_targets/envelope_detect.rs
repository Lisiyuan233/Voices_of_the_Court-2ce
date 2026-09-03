#![no_main]
//! envelope detection fuzz target（实施计划 Task 5 步骤 4）。
//!
//! 通过 #[path] 直接编译主 crate 的源码模块（crate 是 binary，无 lib
//! target），crate:: 路径在 fuzz target crate root 下镜像解析。
//! 关注：任意字节流下不 panic、不越界、判定收敛。

use libfuzzer_sys::fuzz_target;

#[path = "../../src/error.rs"]
pub mod error;
#[path = "../../src/limits.rs"]
pub mod limits;
#[path = "../../src/protocol.rs"]
pub mod protocol;
#[path = "../../src/envelope.rs"]
pub mod envelope;

fuzz_target!(|data: &[u8]| {
    let _ = envelope::classify_bytes(data);
});
