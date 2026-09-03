//! CK3 二进制存档 token 表（编译期静态打包）。
//!
//! 表由 `tools/token-resolver-builder` 从 1.19.0.6 配对存档生成，零依赖
//! 排序数组 + 二分查找，以 `include!` 静态引入（不新增任何运行时依赖，
//! 也不引入 JSON 加载路径）。CK3 版本升级时用 builder 重建表、替换
//! include 目标并同步更新 `TOKEN_TABLE_CK3_VERSION` 门禁常量。

/// 本表对应的 CK3 版本；二进制存档的 `meta_data.version` 必须与此一致，
/// 否则按 `SaveTokenVersionMismatch` 拒绝（token 随版本漂移，跨版本解析
/// 会静默错位，比拒绝更危险）。明文存档不受此门禁影响。
pub const TOKEN_TABLE_CK3_VERSION: &str = "1.19.0.6";

// 生成文件以 `//!` 模块文档开头（宏展开位置不允许 inner doc comment，
// E0753），由 build.rs 机械转换为 `//` 后写入 OUT_DIR 再 include。
mod generated {
    include!(concat!(env!("OUT_DIR"), "/ck3_tokens_1_19_0_6.rs"));
}

// LOOKUP/TOKENS 静态表供测试反查与调试；非测试构建下未直接消费属正常。
#[allow(unused_imports)]
pub use generated::{LOOKUP, TOKENS, lookup, resolve};
