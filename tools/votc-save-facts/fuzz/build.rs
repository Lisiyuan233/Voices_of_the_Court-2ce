//! 与主 crate build.rs 相同的 token 表转换（`//!` → `//` 后写入 OUT_DIR），
//! 供 melt fuzz target 经 #[path] 编译 src/tokens.rs 时 include! 使用。
//! 仅 std，不新增依赖。

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let source = Path::new("../../token-resolver-builder/out/ck3_tokens_1_19_0_6.rs");
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
