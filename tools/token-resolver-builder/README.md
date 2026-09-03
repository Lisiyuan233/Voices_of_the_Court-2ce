# token-resolver-builder

通过「同一游戏状态」的 CK3 存档配对（二进制 + 明文）做结构对齐，自动推导
16bit token → 字段名的映射，产出 jomini 可直接消费的 token 表。

## 背景

CK3 二进制存档（`SAV0101`/`SAV0103`）中字段名被替换为 16bit token，
jomini 解析时必须提供实现 `jomini::binary::TokenResolver` 的 token 表。
本工具不需要官方表：同一游戏状态下，二进制与明文序列化器输出的字段顺序
一致，因此可以并行递归遍历两棵树并在每个对象层级内对齐子键序列。

## 用法

```bash
cargo run --release -- build \
  --pair "bin1.ck3=text1.ck3" \
  --pair "bin2.ck3=text2.ck3" \
  --pair "bin3.ck3=text3.ck3" \
  --out-dir out/ [--game-version 1.19.0.6]
```

- `--pair "bin=text"`：一对「同一游戏状态」的存档，左边二进制、右边明文
  （ZIP 包裹的 SAV0103 / SAV0102 均可，envelope 自动识别）。可重复多次，
  多对之间做跨配对投票 + 冲突检测。
- `--out-dir`：产物目录（自动创建）。
- `--game-version`：可选；缺省时从明文存档 `meta_data.version` 提取。

## 产物

输出目录下：

1. `ck3-tokens-<version>.json`：`tokens`（`"0x2d82": "meta_data"` 形式）、
   `lookup`（lookup 索引 → 字符串）、`stats`（解析/冲突/ambiguous 统计）。
   加载侧 `HashMap<u16, String>` 即已实现 `TokenResolver`。
2. `ck3_tokens_<version>.rs`：零依赖静态表源码，排序后的
   `static TOKENS: &[(u16, &str)]` + 二分查找 `resolve()`，lookup 表同理
   （`static LOOKUP` + `lookup()`）。供 Rust 消费方 `include!` 或复制使用，
   免运行时 JSON 加载。
3. `report.md`：验证报告 —— 每对存档的 token 出现/解析率、lookup 覆盖率、
   deserializer 重解析结果、二进制 vs 明文路径匹配率、漂移与值差异样本、
   单对独立建表间的一致性、冲突清单、应用的订正。

## 人工订正（overrides.json）

 crate 根目录的 `overrides.json` 在跨配对投票之后应用，用于修正证据充分的
错误映射（或补录未解析 token），重跑时不会丢失：

```json
{
  "_note": "订正依据说明",
  "tokens": { "0x3fcc": "needs_external_help" }
}
```

应用的订正会打印到 stdout 并写入 report.md。已收录的订正：

- `0x3fcc = needs_external_help`：对齐器在 `subunit_stack` 区域受 flags
  位域展开影响（文本侧 `needs_help`/`needs_help_changed` 独立布尔 vs
  二进制侧打包进 `flags` 组）错位映射成 `needs_help`；字节级走查（test4
  二进制 `/ai/war_coordinator_db/*/unit_stack/subunit_stack` 字段序列
  `id,units,flags,enemy,0x3fcc,0x3fcd`）与社区 exe 提取表（pdx.tools）
  一致，故订正。

## 算法要点

- 统一 item 序列：明文侧 `TextTape` 保序遍历，二进制侧 `binary::Lexer`
  逐 token 遍历，每层展开为 `(key, 值指纹, 子容器区间)` 序列。
- 锚点（保守）：整数/字符串 key 两侧唯一；整数值、布尔、字符串值指纹
  两侧各出现 ≤2 次。浮点（`0.175000` vs f32 位）与日期（`"1067.1.1"`
  vs 天数 i32）表示不一致，不参与锚定。
- 锚点切窗后：等长窗口按位 1:1 zip（两侧都是可锚定标量但指纹不等时视为
  错位证据，跳过）；不等长小窗口（≤200）做基于标量指纹的 LCS；不等长
  大窗口用窗口内唯一指纹贪心配对；对不上的计入 ambiguous，**绝不猜**。
- lookup 值（二进制 LookupU8/16/24/32 索引 ↔ 文本字符串）记入独立
  lookup 表（对应 `TokenResolver::lookup()`）。
- 跨配对投票：一 token 多名或一名多 token → 冲突，报告且不入表。

## 验证（内置）

- 用生成的表 + `FailedResolveStrategy::Stringify` 经
  `BinaryDeserializer` 完整重解析每个二进制存档，统计未解析 token
  出现次数与覆盖率。
- 二进制与明文解析结果都展平为「路径 → 值」多重集合做交叉比对，
  报告路径匹配率（目标 ≥99%）与差异样本。
- 单对独立建表，多份单对表之间必须零冲突。

## 已知边界

- token 表只覆盖样本存档中出现过的字段；与游戏 exe 内嵌完整表相比可能
  缺少冷门字段。
- **游戏版本升级后 token 可能变化，必须用新版本的配对存档重建。**
- 配对必须真的是「同一游戏状态」（同一时刻分别存二进制与明文）；
  否则漂移会以大量 ambiguous / 路径不匹配的形式体现在报告中。

## 1.19.0.6 实跑结果与已识别的表示差异

3 对样本（1067 宋 / 1178 拜占庭 / 867 马扎尔）：974 个 token，0 冲突，
3 份单对独立建表之间零冲突；token 出现次数解析率 100%（仅 1 个冷门 token
未解析：出现在全档仅一次的 UUID 旁，锚点不足，按设计不猜）；路径匹配率
99.55%–99.67%。剩余差异已确认为以下表示差异，均非对齐错误：

- **jomini TextTape 会丢弃数组开头的连续空对象**（ParseOpen 状态对
  `{ }` 直接跳过，token 层面信息已丢失）：`provinces/*/holding/buildings/[]`
  的 bin-only 差异全部来自这里（约占 0.3%），无法从 tape 恢复，只能接受。
- **二进制日期 = 小时计数**：文本日期 key（`history={ 1066.1.1={...} }`）
  对应二进制整数 key `((year+5000)*365 + day_of_year0)*24 + hour0`。
  展平比对时已在文本侧做归一化（`date_to_binary_hours`）。
- **混合容器**：文本 `levels={ 4 0=2 1=1 }` 的裸值在二进制中是普通数组
  元素（不是 `4=yes`），两侧结构天然一致。
- **RGB**：二进制 Rgb token 是单标量，文本是 3/4 元素数组；展平时二进制
  侧展开为 `<rgb>` 占位子路径。
- **极少量真实漂移/序列化差异**：如 `ai/war_coordinator_db/*` 的瞬态字段、
  仅文本侧序列化的 `/playthrough_timer`（每对约几十条）。
- CK3 1.19.0.6 的存档未使用 LookupU8/16/24/32 索引（lookup 表为空，
  机制由单元测试覆盖）。
