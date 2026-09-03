//! 构建脚本：把 token-resolver-builder 生成的 token 表转换为可 `include!` 的形式。
//!
//! 生成文件以 `//!` 模块文档开头，而宏展开位置不允许 inner doc comment
//! （E0753），这里只做 `//!` → `//` 的机械转换并写入 OUT_DIR；表内容本身
//! 一字节不改。不新增任何构建依赖（仅 std）。

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let source = Path::new("../token-resolver-builder/out/ck3_tokens_1_19_0_6.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(source)
        .unwrap_or_else(|e| panic!("cannot read token table {}: {e}", source.display()));
    let converted: String = text
        .lines()
        .map(|line| {
            line.strip_prefix("//!")
                .map(|rest| format!("//{rest}"))
                .unwrap_or_else(|| line.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("ck3_tokens_1_19_0_6.rs");
    fs::write(&out, converted).expect("cannot write converted token table");
}
