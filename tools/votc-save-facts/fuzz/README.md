# votc-save-facts fuzz 说明

cargo-fuzz 结构（实施计划 Task 5 步骤 4）。两个 target 都通过 `#[path]`
直接编译主 crate（binary crate，无 lib target）的源码模块，保证 fuzz 的
就是生产代码本身。

## targets

- `envelope_detect`：任意字节流 → `envelope::classify_bytes`（header 解析 +
  central directory 定位 + entry 策略判定矩阵）。
- `text_scanner`：任意字节流 → `identity::extract`（有界 scanner）与
  `extract::extract`（skip-first visitor，固定 participant 上下文）。
- `melt`：任意字节流 → `melt::MeltReader` 全量 melt 与 `melt::check_version`
  （版本门禁），消费量有界（16 MiB）防文本放大。

## 运行（本机未装 cargo-fuzz，以下为标准流程）

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
cd tools/votc-save-facts
cargo +nightly fuzz run envelope_detect
cargo +nightly fuzz run text_scanner
cargo +nightly fuzz run melt
```

长 fuzz 在本地/定期任务运行；CI 不跑长 fuzz，改为固定 regression corpus：
`tests/limits.rs::regression_corpus_never_panics_and_always_valid_json`
覆盖合成恶意样本（截断、zip bomb、CRC 损坏、超深嵌套、超长 token、
重复 key storm、非法 UTF-8、NUL、escaped quotes 等），断言进程不 panic、
退出码 0、stdout 恰好一份完整 JSON。

fuzz 发现的 crash 样本应缩减后加入该 corpus（合成、脱敏）。
