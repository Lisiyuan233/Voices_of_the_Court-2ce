# VOTC 2CE 全量对齐合并设计（Full Alignment Design）

- 日期：2026-08-24
- 状态：方向已经决策确认，待评审后进入实施计划（writing-plans）
- 计划方式：本文件是项目级总 spec；每个阶段（P0…P7、收尾）在开工前各出一份独立实施计划，按 §3 顺序执行。
- 参考：`F:\github\votc\VOTC1_vs_2CE_功能对比报告.md`（能力对比）、`F:\github\votc\VOTC_合并迁移方案.md`（工作量估算与风险）

## 1. 目标

以 2CE（应用 `Voices_of_the_Court2 ce` + mod `voices_of_the_court_mod2 ce`）为唯一主干，就地分阶段吸收 1.x 的全部纵深能力，最终只维护一套版本。范围包含完整的时间线 v2 协议（战役身份、checkpoint 令牌、分支调和、事务化注册表）。

## 2. 已定决策

| 决策点 | 结论 |
|---|---|
| 基座 | 2CE 应用 + mod2 ce，**就地开发**，Git 分支隔离迁移提交 |
| 范围 | 全量对齐（P0–P7 + 收尾，估 89–138 人日），分阶段交付 |
| 时间线 v2 | 完整移植（非简化战役 ID），执行位次提前到 P0 之后 |
| mod 入口策略 | 新增玩法一律决议入口，不修改原版 `hud.gui`（HUD 按钮仅作后续可选增强） |
| 本地化 | 新增 UI/mod 文案先英+中，其余 9 语言靠回落机制，社区翻译后补 |
| 用户数据 | 依赖 `userDataCheck.ts` 严格深合并自动下发新 config 键；不做手工迁移脚本 |
| 兼容红线 | 详见 §5 |

## 3. 各阶段规格

> 执行顺序即编号顺序：P0 → P6 → P1 → P2 → P3 → P4 → P5 → P7 → 收尾。
> 每阶段四件套一起交付：mod 增量文件 + app 代码/目录 + jest 测试 + i18n 键。

### P0 白得解析（3–5 天）
消费 mod2 ce 已输出但 2CE 未解析的数据。
- app：`parseLog.ts` 增加 case：`modifier / stress / legitimacy / income / treasury / influence / herd / levies_vassals / levies_dom / levies_theo / maa / troops_eob / laws / persona_numbers / k_secret`；`Character.ts` 增对应字段；描述脚本与 promptBuilder 注入点；为新事实设 token 预算上限。
- 验收：真实 debug.log 样本解析单测通过；对话提示词出现新事实且总量受预算约束。

### P6 完整时间线 v2 移植（11–17 天）
- app 平移核心集群：`timelineManager`、`timelineCoordinator`、`timelineTransitionJournal`、`timelineJournalApi`、`timelineResolver`、`timelineRegistryRecovery`、`timelineLegacyWriter`、`timelineBusinessWire`（暂缓接线，见下）、`registryValidator`、`timelineLock`，及共享层 `timelineProtocol.ts`、`CampaignIdentity.ts` 与配套 jest 用例。存储路径维持 manager 自建的 `votc_data/campaigns/<campaignId>/players/<playerId>/timeline_registry.json`。
- mod：mod1 的 `votc_checkpoint_effects.txt` 全套替换 mod2 ce 极简版；`log_gamedata_v3/v3l/v3s` 的 `init` 行追加协议尾部字段（schema 版本、campaign id×4、bootstrap kind、checkpoint/pending token、node ids）。
- app 接线：parseLog 启用尾部协议解析；ClipboardListener 补 `CHECKPOINT/CAMPAIGN/TIMELINE` 命令与 fail-closed 管理器载荷；对话关闭 votc.txt 写入器替换为 1.x `buildCloseConversationEffect`；摘要/信件/日记/历史的打戳点由 epoch 升级为 node+campaign 血统戳，过滤改走 resolver 分支调和；存量 epoch-only 记录按 legacy 语义兼容。
- 验收：run 脚本 `votc_checkpoint_bump/read`、`votc_test_campaign_id`、`votc_test_checkpoint_token` 游戏内通过；复制存档双开的分支场景记录互不污染；旧档加载不崩溃。

### P1 NPC 主动来信（15–25 天）
- mod：mod1 来信全家桶——作者资格 triggers、`votc_start_incoming_letter_effect` 系列、事件（触发/到达/清理/剪贴板桥）、8 槽分配（家书/诗笺专用槽）、频率设置窗口 GUI、相关 on_action（季度脉冲、围城完成、开战、死亡、旅行完成、建筑）。
- app：ClipboardListener `INCOMING_LETTER` 分支、letterSnapshot 解析扩展、`IncomingLetterGenerator`、`incomingLetterPrompt` 键、Letters 页"来信"分区与历史归档。
- 注意：建立并维护《全局变量/事件 ID 占用表》（放本仓库 docs/），`votc_letter_N`（写信线程）与 `votc_incoming_letter_N`（来信槽）并存不冲突。
- 验收：≥25 类信件类型抽样走通 触发→生成→延迟投递→阅读→归档 全链路；频率/冷却生效；既有 9 线程写信零回归。

### P2 宫廷编年史（8–12 天）
- app：`src/main/chronicle/` 整目录平移 + ChronicleWindow + IPC 注册 + 会话关闭/战报两条观察喂给线 + System 页 Court Historian 设置节 + `chroniclePrompt` 键。
- mod：季度/年度脉冲 on_action、`votc_chronicle_events`、CHRONICLE_MEMORY 导出效果、手动 tick 决议入口。
- 验收：三档节奏生成成功；时间线 Markdown 导出可用；观察库同时接收会话与战报输入。

### P3 军事快照 + 军事会议（6–10 天）
- mod：军事会议决议、名册构建 effect、战争/围城/军队快照导出、近期事件环形缓冲、追踪 on_action×4。
- app：parseLog 补 `military_snapshot / war / war_participant / siege / army / army_regiment / war_event / military_attendee / military_snapshot_complete / war_truncation` 分支；搬运 `militaryBrief.js` 描述脚本注入会话与战报提示词。
- 验收：军事会议决议成册；战报与会话提示词含指挥官/军队/围城细节。

### P4 Agency Ledger（8–12 天）
- app：`src/main/agency/` 整目录 + AgencyManagerWindow + IPC；寻址从 `campaigns/<campaignId>/players/<playerId>` 适配为复用 P6 注册表命名空间；接通 BusinessWire 与时间线联动；投影注入会话提示词/来信/角色挑选提示。
- mod：桥接事件 + 决议入口（极小）。
- 验收：抽取→账本→投影注入闭环可用；omniscient 模式进出正常；默认关闭灰度。

### P5 实验性存档事实（8–12 天）
- 组成：Rust sidecar `tools/votc-save-facts`（forge extraResources 随包分发）+ `src/main/saveFacts/` 目录 + Settings 页实验节 + mod 侧固定名存档快照协议（`votc_prepare_save_snapshot_effect` 等）+ parseLog 启用 saveSnapshotProtocol 尾部。
- 约束：仅 `-debug_mode` 生效；默认关闭；非 debug 模式 fail-closed 静默。
- 验收：debug 模式下家庭/领地/战争等公开事实进入提示词；诊断视图可用。

### P7 Prompt Workbench（20–30 天）
- 约 90 文件 + 加固窗口（唯一 contextIsolation 窗口，安全模型照搬）+ ~130 IPC 通道 + `apiConnection.completeWithMetrics()` 与 judge/proposer 第 4/5 连接角色扩展。
- 验收：窗口可开；生产 prompt 捕获入库；简单模式完成一轮 实验→评审→晋升 流程。

### 收尾（10–15 天）
i18n 键校验与回落检查；为合并 mod 补 `package_mod.py` 式安装脚本；README/文档更新；jest 全量回归；游戏内全链路联调（开局→对话→来信→战报→编年史→换档归档→分支调和）。

## 4. 目标架构边界

- 所有移植模块保持"整目录 + 显式 IPC 注册 + 注入式存储根"形态，禁止把新逻辑塞进 `main.ts` 内联实现。
- 2CE 既有的 epoch 过滤/归档机制保留作为 fallback，血统戳存在时优先走 resolver。

## 5. 兼容红线

1. `VOTC:IN` init 尾部扩展必须携带 schema 版本号；解析端对缺尾部字段的旧日志按 legacy 路径处理，不抛错阻断。
2. run 脚本文件名不变：`votc.txt` / `letters.txt` / `battle_report<N>.txt`。
3. mod 新增全局变量/事件 ID 先查《占用表》；两版同名变量（`votc_checkpoint_epoch`、`votc_letter_N`）语义归属一次性定清并记录。
4. 记录类 JSON 只增字段不改名，读取端容忍缺失字段。

## 6. 风险与缓解

沿用迁移方案 §四：变量撞名（占用表）、CK3 版本漂移（决议入口优先）、token 预算（上限+回归）、翻译债（回落机制）、测试断层（每阶段 jest 随迁并真正接入 ts-jest 配置）。新增：就地开发须以独立 feature 分支承载迁移提交，避免与日常修复混流。

## 7. 不做（Out of Scope)

- Ironman/成就支持；mod 其余 7 语言文案的完整翻译（交社区）；1.x 三个旧项目的继续演进；完整时间线协议之外的 CK3 引擎级改造。
