# votc-save-facts 测试 fixtures

本目录存放 `votc-save-facts` sidecar 的最小 CK3 存档 fixture。本 README 冻结 fixture 的记录规则；
fixture 实体文件由后续 Task 0（实机确认）和 Task 3（identity/facts 提取）逐步填充。

## 记录规则

每个 fixture 提交时必须在本 README 中登记以下信息：

- **envelope 类型**：unified text（纯文本游戏状态）/ prefixed ZIP + text（ZIP 头后接文本游戏状态）/ binary（含二进制游戏状态，预期明确降级）。
- **save version**：存档头中的 CK3 版本号。
- **是否包含 ZIP 前缀**：是否带 `PK\x03\x04` 等 ZIP local header 前缀。
- **script variable scale**：该 fixture 证明的 script variable raw fixed-point 倍率（由 Task 0 实机 fixture 确认，不允许凭经验硬编码）。
- **预期 identity**：`probe`/`extract` 应稳定提取的 identity 字段（save id、campaign id、player character id、游戏日期等）。
- **预期 facts**：`extract` 应输出的事实行及其规范化后的取值。
- **来源**：「手工合成」或「脱敏裁剪」，并注明裁剪自哪个版本的真实存档。

## 脱敏要求

- 不包含真实人物名（玩家、亲友、历史人物昵称一律替换为占位名）。
- 不包含 Windows 用户名、Steam ID、账号信息。
- 不包含完整存档片段，只保留能触发对应代码路径的最小结构。

## 计划中的最小 fixture（待填充）

按实施计划 6.1 节，本目录最终至少包含以下四个 fixture：

| 文件 | envelope 类型 | 用途 | 状态 |
|---|---|---|---|
| `unified_text_minimal.ck3` | unified text | 最小纯文本存档，验证 identity 与基础 facts 提取 | 已填充（Task 3，手工合成） |
| `unified_text_player_variables.ck3` | unified text | 脱敏后的 CK3 1.19 实机字段顺序、玩家变量路径与零值省略编码 | 已填充（Task 0/3，按实机结果裁剪重建） |
| `prefixed_zip_text_minimal.ck3` | prefixed ZIP + text | 带 ZIP 前缀的文本存档，验证前缀剥离与 identity 提取 | 已填充（Task 3，由 `tests/common/mod.rs` 在临时目录动态生成同名文件；deflate entry） |
| `binary_marker_minimal.ck3` | binary | 二进制游戏状态标记，验证 sidecar 明确降级而不误解析 | 已填充（Task 3，手工合成） |
| `truncated_minimal.ck3` | unified text（截断） | 写入中断的截断存档，验证有界输出与错误路径 | 已填充（Task 3，手工合成） |
| `unified_text_join_candidates_minimal.ck3` | unified text | 含 root `variables.list` 块中 `votc_join_candidates` 全局列表的最小存档，验证 `joinCandidates` 保序提取 | 已填充（Plan C Task 2b，手工合成） |

填充时在上表补充每个 fixture 的 save version、ZIP 前缀、script variable scale、预期 identity 与预期 facts。

## Task 3 填充记录（Task 0 已确认项与仍待修正项）

** envelope 与结构 **

- `unified_text_minimal.ck3`：`SAV0100` header + 纯文本 gamestate。gamestate root 依次含
  `meta_data` 块、`date`、`variables` 块、`living` 块。
- `prefixed_zip_text_minimal.ck3`（动态生成）：`SAV0102` header + inline meta 前缀 +
  ZIP（deflate，`gamestate` entry）。jomini envelope 只支持 deflate entry，stored 会按
  `unsupported` + `SAVE_VERSION_UNSUPPORTED` 降级。
- `binary_marker_minimal.ck3`：`SAV0101` header + 非 ZIP 二进制内容 → `unified_binary`，
  `unsupported` + `SAVE_TOKEN_RESOLVER_MISSING`。
- `truncated_minimal.ck3`：`SAV0100` header + `meta_data` 块中途截断（花括号未闭合）→
  `invalid` + `SAVE_TRUNCATED`。

** Task 0 实机结论（2026-08-06/07） **

- **script variable scale**：真实 CK3 1.19 存档为 `100000`；合成 fixture 也覆盖
  `1`/`1000`。sidecar 不硬编码倍率：scale 由 protocol raw 推导（protocol 恒为 1），
  `identity.scriptVariableScale` 返回推导值；protocol raw=0 时 scale 不可推导（置空 +
  `SCALE_UNDETERMINED` warning）。
- **变量路径**：四个 campaign global variables 位于 root `variables`；三个 snapshot
  协议变量位于 `living.<played_character>.alive_data.variables`，不能再按“七变量全部在
  root”实现。旧合成 fixture 的 root 布局与 `value=<raw>` 仅作兼容回归；
  `unified_text_player_variables.ck3` 覆盖真实玩家变量路径。
- **零值编码**：已出现的 `votc_save_snapshot_slot=0` 保存为
  `data={ type=value }`，省略 `identity=0`；必须与 flag 完全缺失区分。
- **边界编码**：`17.5` raw=`1750000`；`-17` raw=
  `18446744073707851616`（`2^64-1700000`）；生产协议仍拒绝小数和负数。
- **玩家角色 ID key**：真实存档使用 root
  `played_character={ character=<number> player=1 }`；旧合成 fixture 的
  `meta_data.meta_player_id` 继续兼容。
- **CK3 版本 key**：`meta_data` 块内 `version="x.y.z"`（ck3save crate 已验证存在）。
- **日期**：root `date=y.m.d`；`gameDateNumeric = y*365 + 年内累计天数 + d`，假定固定
  365 天年、2 月恒 28 天，需与 mod 端 `GetDateAsTotalDays` 实机对齐。
- **已识别 CK3 版本前缀**：`1.13`-`1.19`，未知版本 probe 仍 ok 但给
  `CK3_VERSION_UNRECOGNIZED` warning。
- **标准非 debug 格式**：CK3 1.19.0.6 GUI save 实测为 `SAV0103` / `zip_binary`；
  当前 sidecar 正确降级为 `SAVE_TOKEN_RESOLVER_MISSING`，不能作为生产事实源使用。

## Task 4 填充记录（extract raw schema，CK3 1.19 实机确认）

真实字段结构见 `docs/save-snapshot-real-save-field-probe-2026-08-06.md`；测试同时
保留旧合成字段以防回归，并新增 CK3 1.19 布局 fixture：

- **living 块**：`living={ <charId>={ ... } }`，白名单字段
  `family_data={ primary_spouse=<id> spouse=<id> child={ <id>... } }` 与
  `landed_data={ domain={ <titleId>... } }`。父母由公开 child 列表反向派生；
  domain 第一项是主要头衔。`first_name` 的 save-internal 编码不作为展示名。
- **hidden/real father**：真实字段为 `family_data.real_father=<charId>`。extractor 是
  白名单制，`real_father`、hidden relation、secret、AI、mod 私货等一切不在
  白名单内的 key 在解析层直接 `skip_value` 跳过，从不读取（测试
  `hidden_father_and_secret_blocks_produce_no_output` 看守）。
- **landed_titles 块**：允许非数字的 `dynamic_templates` 元数据；数字 title
  记录读取 `key`、`holder`、`de_facto_liege`、`de_jure_liege` 与
  `title_name_data.name`。主要头衔的上级 title holder 解析为直接领主；
  `title_name_data.name` 优先作 literal candidate，只有 `key` 时作
  `localization_key` candidate。
- **顶层 skip 列表**：meta_data/date/variables（identity 已处理）、secrets、
  schemes、wars、AI 内部块、memory manager 及一切未知顶层块。
- **canonical sourcePath**：协议枚举值 `character_mother|character_father|
  character_child|character_spouse|character_liege|character_primary_title|title_holder`
  （raw save 路径永不过线；Task 20 修正，与 App `saveFactTypes.ts` 的
  `SAVE_FACT_SOURCE_PATHS` 对齐）；derived child 与 parent 共享同一
  sourcePath。
- **重复 key 规则**：单值 key（domain/holder/de_facto_liege/de_jure_liege/
  key/name/first_name）重复时 first wins + `DUPLICATE_KEY` warning；
  spouse 可重复。
- **fact ID**：`SHA-256(domain ‖ subject.type|id ‖ predicate ‖ object.type|id)`
  前 32 位 hex，不含 display name（暂定算法，Task 5 冻结）。

** 预期 identity（`unified_text_minimal.ck3` / 动态 zip fixture） **

- ck3Version `1.13.0`；playerCharacterId `1001`；gameDate `867.1.15` → numeric `316470`；
- campaignIdParts `[111, 222, 333, 444]`（raw 111000-444000，假定 scale 1000）；
- snapshotSequence `17`（raw 17000）；snapshotSlot `0`；scriptVariableScale `1000`。
- 脱敏：全部使用占位名（`Placeholder Player`）与占位 ID，无真实人名/用户名/存档片段。

## Plan C Task 2b 填充记录（joinCandidates 提取，协议 v2）

- `unified_text_join_candidates_minimal.ck3`：`SAV0100` header + 纯文本 gamestate，与
  `unified_text_minimal.ck3` 同构，额外在 root `variables` 块内 `list=` 子块加入
  `{ name="votc_join_candidates" item={ type=char identity=13206 } item={ type=char identity=33435 } }`。
- **save version**：`1.13.0`；**script variable scale**：`1000`。
- **预期 identity**：与 `unified_text_minimal.ck3` 一致（player 1001、campaign
  [111,222,333,444]、sequence 17、slot 0）。
- **预期 joinCandidates**：`["13206", "33435"]`（保序、十进制 ID 字符串；来自 root
  `variables.list`，不进入 facts/predicate 流）。
- **来源**：手工合成，占位 ID，无真实人名/用户名。

## Task 5 冻结记录与性能测量方法

### 已冻结常量（Task 5 步骤 1；修改需同步计划 Task 5 表格与本文件）

- 硬上限（`src/limits.rs`）：stdin 64 KiB / stdout 2 MiB / stderr 64 KiB（App 端）/
  decompressed 512 MiB / nesting 512 / scalar 64 KiB / facts 500 / entities 250 /
  related 100 / wars 0。App 请求只能更低。
- fingerprint（`src/fingerprint.rs`）：domain `votc-save-facts:fp:v1`，
  head/middle/tail 每段 4096 字节 + file size + envelope header 行。
- snapshotId（`src/fingerprint.rs`）：domain `votc-save-facts:snapshot:v1`，
  材料 `player|a|b|c|d|sequence|slot`。
- fact ID（`src/extract/normalize.rs`）：domain `votc-save-facts:fact:v1`，
  SHA-256 前 32 位 hex，材料 `subject.type|id ‖ predicate ‖ object.type|id`。
- 查找索引上限（`src/extract/mod.rs`）：name index 100 000、title index 50 000。

### 性能测量方法（合成输入，真实存档 p50/p95 留待 Task 21 E2E）

```bash
cargo test --manifest-path tools/votc-save-facts/Cargo.toml \
  --test benchmark -- --ignored --nocapture
```

`tests/benchmark.rs` 在临时目录生成 ~100 MB 合成 unified text（living 块
约 67 万个角色，绝大多数与 participant 无关，触发 name index 上限路径），
通过 CLI 测量 probe/extract 耗时、Linux /proc VmHWM 峰值 RSS、输出字节与
fact 数。不提交生成的大文件。

**本机测量（WSL2，host Linux debug / release 构建，2026-08-05）**：

| 指标 | debug | release |
|---|---:|---:|
| 输入 | 100.1 MiB unified text | 同左 |
| probe | 22 ms（提前停止，扫描 737 B） | — |
| extract | 10 613 ms | **804 ms**（durationMs；wall 0.81 s） |
| extract 峰值 RSS | 16.4 MB | 15.5 MB |
| extract 输出 | 5 163 B，8 facts / 6 entities | 同左 |
| warnings | LOOKUP_INDEX_LIMIT（预期，name index 满） | 同左 |

结论：release 构建 100 MB 输入 extract < 1 s、RSS ≪ 512 MB、输出 ≪ 2 MB，
满足 App 侧 15 s 硬截止。注意：unified text 的 decompressed 预算必须 ≥
文件大小（request maxDecompressedBytes），否则按设计 SAVE_LIMIT_EXCEEDED。
ZIP 样本与低配 CPU 的测量留待有真实存档时补充。

### Windows release 测量（2026-08-11，App `9a05db9`）

用 `build/measureSaveParserPerformance.ps1`（`npm run save-parser:measure`
或直接 `pwsh -File build/measureSaveParserPerformance.ps1`）对合成样本做
每格 20 次 warm 测量，结果归档于实施计划 §10.4a（probe/extract/verify ×
unified/zip 六格，p95 ≤ 41.7 ms，peak working set p95 ≤ 2.8 MB）。

prefixed ZIP 样本构造要点（复现测量用，PowerShell）：

- `SAV0102` 头行 `SAV0102aabbccdd00000000\n`（meta_len 为 0，inline meta 可空），
  后接 ZIP 字节；ZIP 必须恰好含一个 `gamestate` entry（deflate），内容是
  去掉 SAV 头后的完整 gamestate 文本（含 `meta_data` 块）。
- 写入 ZIP entry 内容时不能带 UTF-8 BOM：jomini 的 text 流扫描对 BOM 敏感，
  会导致 `meta_data` 块解析失败并报 `CK3_VERSION_MISSING`/`PLAYER_ID_MISSING`。
  用字节级写入（`entry.Open().Write(bytes)`），不要用 `StreamWriter`（默认加 BOM）。
- 生成的样本可直接被 `probe` 识别为 `sourceFormat: zip_text`，identity 完整
  （version/player/date/variables 全量 ok）。
