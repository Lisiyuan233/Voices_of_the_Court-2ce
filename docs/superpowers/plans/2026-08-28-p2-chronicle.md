# P2 宫廷编年史（Chronicle）迁移 — 实施计划（v1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **前提状态（2026-08-28）：** P0/P6/P1 代码侧全部完成（P6 待游戏内验收矩阵；P1 已过静态审计并修复 8 项，含桥接门卫与 hmd 载荷模板 `90f28bf`）。timeline v2 基础件、campaign 身份/路径、history 核心均已就位。本计划基于 2026-08-28 三路并行探索（1.x 应用侧 / mod1 mod 侧 / 2CE 集成面）的实测锚点编写；执行时标 ⓥ 的定位命令必须重跑。

**Goal:** 将 1.x 宫廷编年史迁入 2CE：双通道数据（应用侧 GameData 观察四喂给点 + mod 侧 CHRONICLE_MEMORY debug.log 块与 25 字段剪贴板信号）、ChronicleMemoryStore/Entries/Attempts 三存储、预算规划 + LLM 叙事生成、ChronicleWindow 及 8 条 IPC、设置节与 chroniclePrompt 接线；mod 侧脉冲/导出效果/事件 + 决议入口（替代 mod1 HUD 按钮）。

**Architecture 决策（先读）：**
1. **导出子系统（TimelineExport* 家族 + summaryOverrides + archiver/yauzl）整体延后为 P2b**：需新增 npm 依赖（archiver/yauzl，安装需用户同意），且不影响编年史本体验收。MVP 中 `export-current-timeline` 通道不注册（窗口按钮点击报错，错误键 `chronicle.export.*` 已在主进程字典），P2b 恢复。本计划附录 B 记录全部延后清单。
2. ** Diary 不接入观察**：1.x 无 diary 喂给点，保持 parity（2CE 有 diary 子系统但不在 P2 接入，记录决策）。
3. **决议入口替代 HUD**：mod1 唯一入口是 hud.gui 按钮（且依赖 debug 模式的 `effect` 控制台命令）。遵循方案 A 原则 2，新增 `votc_open_chronicle_manager_decision` 触发 `votc_open_chronicle_manager_manual_effect`（mod2 ce 无 hud.gui，维持不动）。
4. **i18n 走 1.x 原生路线**：编年史窗口 renderer 用 `dist/shared/i18n.js` + `i18nRenderer.js`（t() + data-i18n），主进程字典 `src/shared/locales/{en,zh}.ts` 的 `chronicle.*`/`settings.chronicle*`/`prompts.chroniclePrompt` 键**已在 2CE 预置**（en.ts 140-149/1507-1508/1742-1798，zh.ts 对应）——只需补 `src/shared/i18nRenderer.ts`（1.x 存在、2CE 缺失，预计小文件）并确认 2CE 构建产物含 `dist/shared/i18n.js`。`public/locales/*.json` 不需要新键。
5. **零 parseLog 改动**：通道 B 的内存块由 `ChronicleMemoryBlockParser` 直读 debug.log（独立解析器），通道 A 复用已解析 GameData——parseLog 的 dataType switch 不动。
6. **喂给点四处全接**（对话关闭/出信/来信/战报）：P1 时来信喂给被剥离（注释见 `IncomingLetterGenerator.ts:27-32`），P2 一并回填，与 1.x 对齐。
7. 两仓库独立提交；mod 侧沿用 `package_mod.py install` 收尾。

**规格来源:** `docs/superpowers/specs/2026-08-24-votc-full-alignment-design.md` §3/P2；总方案《VOTC_合并迁移方案.md》§P2；P6 计划附录 A 的 P2 前置包条目。
**参考实现:** `Voices_of_the_Court1/src/main/chronicle/`（14 文件 5552 行）、`Voices_of_the_Court1/src/main/main.ts:2140-2957`（编年史接线段）、`voices_of_the_court_mod1/common/scripted_effects/votc_chronicle_effects.txt`（146 行）。
**涉及仓库:** `Voices_of_the_Court2 ce/` 与 `voices_of_the_court_mod2 ce/`。

---

## 已验证事实基线（2026-08-28 实测）

### App 侧：1.x 编年史结构（14 文件，5552 行）

| 文件 | 行数 | 角色 |
|---|---|---|
| chronicleTypes.ts | 486 | 全部 schema 契约（**已随 P6 移植且 diff 干净**）|
| chronicleAtomicJson.ts | 314 | 原子写/.bak 轮换/损坏隔离/路径断言 |
| chronicleHealth.ts | 56 | 进程内不健康标记表（粘滞）|
| chronicleMemoryIdentity.ts | 150 | SHA-256 身份原语（anchor/memoryKey/renderHash）|
| chronicleObservation.ts | 200 | GameData→记忆观察入口 observeParsedGameDataForChronicle |
| ChronicleMemoryStore.ts | 646 | memory_observations.json 存储 + parseMemoryStoreBuffer |
| ChronicleMemoryBlockParser.ts | 403 | 解析 mod 的 VOTC:CHRONICLE_MEMORY 块（依赖 ck3Text.removeTooltip）|
| chronicleClipboardPayload.ts | 187 | 25 字段 CHRONICLE_TICK/MANAGER 载荷解析 |
| ChronicleSourceCollector.ts | 655 | 周期源收集（对话/记忆/信件/战报；依赖 battleReportGameDate）|
| ChronicleBudgetPlanner.ts | 482 | token 预算 + 表示选择 + LLM 摘要缓存（source_digests.json）|
| ChroniclePromptBuilder.ts | 153 | DEFAULT_CHRONICLE_PROMPT + buildChroniclePrompt |
| ChronicleGenerator.ts | 5? 行 255 | LLM 叙事生成 + 输出校验 + 秘密脱敏 |
| ChronicleStore.ts | 659 | entries.json/attempts.json 状态机 |
| ChronicleCoordinator.ts | 906 | 信号编排（handleSignal/retry/regenerate/周期选择/请求键）|

接线段（1.x main.ts）：coordinator 实例化 :566-571（两参构造）；观察喂给 :1005（对话）、:1614（战报）、LetterReplyGenerator.ts:490（出信）、IncomingLetterGenerator.ts:497（来信）；flushChronicleMemoryBlock :2210-2246；buildChronicleSignal :2248-2262；VOTC:CHRONICLE_TICK 处理器 :2265-2301（静默 flush + 频率门自动生成）、VOTC:CHRONICLE_MANAGER :2304-2353（flush + 开窗）；buildChronicleCoordinatorConfig :2140-2149；IPC 八通道 :2640-2887（get-chronicle-context/entries/read-entry/attempts/generate-to-current-date/retry/regenerate/close-window）+ export :2802（P2b）。

存储布局（2CE `campaignDataPaths.ts:117-145` **已预置全部路径**）：`<userData>/votc_data/campaigns/<cid>/players/<pid>/chronicle/{entries,attempts,memory_observations}.json`(+.bak/.corrupt) + source_digests.json。协调器/存储构造入参是裸 `userData` 根（campaignDataPaths 自行拼 votc_data），与 summaryManager 的 votc_data 根约定不同——移植时保持 1.x 原样传入 `app.getPath('userData')`。

窗口与资产：`windows/ChronicleWindow.ts`（49 行，1400x900 无边框置顶，preload 惯例同 ConversationHistoryWindow）；`public/chronicleWindow/{chronicle.html 4KB, chronicle.css 16KB, chronicleRenderer.js 19KB}`（依赖 marked ^14.1.3 + dompurify ^3.0.8——**2CE 已有**；i18n 走 dist/shared/i18n.js）；语言/主题广播数组各需追加。

配置键：`chronicleFrequency('disabled'|'quarterly'|'yearly', 默认 yearly)`、`chronicleRawSourceCharLimit(30000)`、`chronicleOutputMaxTokens(1000)`、`chroniclePrompt`（1.x Config.ts:385-388 + default_config.json:157-160；设置节 settings.html:225-248/:395-403；提示词 textarea prompts.html:91-93）。注意 1.x 的 chroniclePrompt 存 config.json 根键（经 buildChronicleCoordinatorConfig :2145 读取），**不走** getEffectivePrompts 预设层——移植保持原样（config 根键 + settings/prompts 页直连 config-change），不套 P1 预设配方（差异记录：2CE prompts 页 textarea 读写走 `config.prompts[lang][key]`（main.ts:1539-1553），而 chroniclePrompt 需写 config 根键 → prompts.html 的 confID 若直接用 `chroniclePrompt` 会被路由进 prompts 层造成读错位。**处置：chroniclePrompt 的 textarea 放 settings.html 编年史节内（1.x 即如此，prompts.html:91-93 的入口 2CE 不移植），confID 直连 config 根键，天然正确**）。

测试（1.x，14 个编年史 + 6 导出）：chronicleAtomicJson/BudgetPlanner/ClipboardPayload/Coordinator/ExportRendererSmoke/MemoryBlockParser/MemoryIdentity/MemoryStore/Observation/ObservationCallOrder/PromptBuilder/SourceCollector/SourceMetadata/Store + 导出侧 6（P2b）。

### Mod 侧：mod1 编年史结构（全部需移植，mod2 ce 零编年史脚本）

| 文件 | 行数 | 内容 |
|---|---|---|
| common/scripted_effects/votc_chronicle_effects.txt | 146 | 28 位请求 id 生成、CHRONICLE_MEMORY 块导出（start/memory×N/participant×N/end，13 字段 memory 行）、季度计算、5 个入口效果（open_manager→.9003 / open_manager_manual→.9004 / quarterly/yearly/manual tick）|
| common/on_action/votc_chronicle_on_actions.txt | 18 | quarterly_playable_pulse→.9001、yearly_playable_pulse→.9002（events-only 追加式；yearly 为 mod2 ce 首个注册）|
| events/votc_chronicle_events.txt | 65 | namespace votc_chronicle_event .9001-.9004（.9003/.9004 可见剪贴板桥，talk_clear widget）|
| localization/{english,simp_chinese}/votc_chronicle_l_*.yml | 15×2 | 6 键（HUD tooltip + 事件 title/desc；.9003/.9004 desc 即 25 字段载荷）|
| run_test_scripts/votc_test_chronicle.txt + _memory_identity.txt | 50+77 | 端到端 + 能力探针 |

协议要点：memory 行 13 字段 `VOTC:CHRONICLE_MEMORY/;/memory/;/requestId/;/ordinal/;/ownerId/;/ownerName/;/typeToken/;/memoryName/;/creationTotalDays/;/creationDisplay/;/description/;/relevance(硬编码50)/;/participantCount`；载荷 25 字段 `VOTC:CHRONICLE_TICK|MANAGER/;/playerId/;/epoch/;/playerName/;/nodeA/;/nodeB/;/parentA/;/parentB/;/token/;/pendingToken/;/2/;/campaignSchema/;/campA-D/;/bootstrapKind/;/timelineSchema/;/signalKind/;/dateTotalDays/;/year/;/month/;/day/;/pulseQuarter/;/primaryTitle/;/memoryRequestId`。

依赖符号在 mod2 ce **全部就位**：votc_init_checkpoint_effect 与全部 checkpoint/campaign 变量（363 行 v2 文件逐行同源）、event_window_widget_talk_clear、custom_widgets_container。无命名冲突（votc_chronicle_event 命名空间/`votc_chronicle_*` loc 前缀/全局变量族均空闲；`run_test_scripts/votc_test_cleanup.txt:98-103` 已预置 chronicle 清理块）。唯一缺口=HUD 按钮（决策 3 处置）。

### 2CE 集成面锚点（main.ts 2426 行）

- 窗口声明区 :202-206；语言广播 windows[] :2412-2418、主题广播 :2389-2395（两处都要加 ChronicleWindow）；惰性建窗模板 :1165-1167。
- ClipboardListener 分支表 :56-90（无 CHRONICLE_TICK/CHRONICLE_MANAGER，新分支加在 INCOMING_LETTER 之后）；处理器群 :920-1404。
- IPC 模板 `src/main/ipc/timelineIpc.ts`（deps 注入 + 双注册守卫 + main.ts:841-851 调用）；现有通道无 chronicle 命名冲突。
- 预置碎片：chronicleTypes.ts 字节级同源；campaignDataPaths chronicle 六路径；HistoryRecordReaders `tolerant_for_chronicle` 模式与 `strict_for_export`；historyRecordTypes TIMELINE_EXPORT_* 常量；IncomingLetterGenerator.ts:27-32 的 P2 回填注释；summaryManager.ts:301-305 node 戳说明。
- 主进程字典 chronicle 键全量预置（en.ts :140-149/:1507-1508/:1742-1798；zh.ts 对应）；public/locales 无需新增。
- 缺失依赖：`src/shared/gameData/ck3Text.ts`（removeTooltip；2CE 版本内嵌在 parseLog.ts —— 移植时比对两版实现，提取为共享模块并让 parseLog 改 import，测试兜底）；`src/main/battleReport/battleReportGameDate.ts`（resolveBattleReportGameDate，SourceCollector 依赖）；`src/shared/i18nRenderer.ts`（initRendererI18n，编年史窗口 renderer require）；Config 四键 + default_config.json 四键；ClipboardListener 两分支；ChronicleWindow + public/chronicleWindow 三件套。

---

## Task A0: mod 侧移植（voices_of_the_court_mod2 ce）

- [ ] **Step 1**: 复制三脚本文件（verbatim）：votc_chronicle_effects.txt / votc_chronicle_on_actions.txt / votc_chronicle_events.txt + 两个 loc yml + 两个 run 脚本。cp 保字节继承 BOM/CRLF。
- [ ] **Step 2**: 新建决议 `votc_open_chronicle_manager_decision`（追加进 common/decisions/votc_decisions.txt 或独立小文件，沿用 `decision_group_type = decisions` 风格）：effect = init_checkpoint（ 决议内手动 init 与 mod1 HUD 等价的上下文准备——ⓥ 对照 mod1 HUD onclick `effect votc_chronicle_manual_tick_effect = yes` 的前置，手动入口效果内部已含 init_checkpoint（effects :122-128），决议直接 `votc_open_chronicle_manager_manual_effect = yes` 即可）+ custom_tooltip。
- [ ] **Step 3**: loc 追加：mod1 6 键原样 + 决议四键（name/tooltip/confirm/desc/effect_desc 按 mod2 ce 决议键惯例，en+sc）。.9003/.9004 title 的占位 "aha" 顺手改为正经标题（en "Chronicle"/sc "编年史"，变更记录入提交信息；desc 载荷键一字不动）。
- [ ] **Step 4**: 引用审计（沿用 P1 的 token 枚举比对法）+ 花括号平衡 + BOM 校验（全部新文件 efbbbf）。
- [ ] **Step 5**: `python package_mod.py install` + 复制 2 个 run 脚本到 CK3 run 目录。
- [ ] **Step 6**: 提交 `feat(chronicle): port chronicle pulses, memory export and manager entry from mod1`。

## Task A1: app 侧核心 13 文件移植（Voices_of_the_Court2 ce）

- [ ] **Step 1**: 复制 12 个编年史文件（chronicleTypes 已在）：chronicleAtomicJson / chronicleHealth / chronicleMemoryIdentity / chronicleObservation / ChronicleMemoryStore / ChronicleMemoryBlockParser / chronicleClipboardPayload / ChronicleSourceCollector / ChronicleBudgetPlanner / ChroniclePromptBuilder / ChronicleGenerator / ChronicleStore / ChronicleCoordinator（逐字复制；ts 编译报错驱动适配点收敛）。
- [ ] **Step 2**: 依赖补齐三件：
  - `src/shared/gameData/ck3Text.ts`：从 1.x 复制；ⓥ diff 2CE parseLog.ts 内嵌 removeTooltip 与 1.x ck3Text 版实现，若语义一致则 parseLog 改为 re-export（保持既有导出面不变），不一致则保留 parseLog 本地版、ck3Text 独立存在（提交信息注明取舍）。
  - `src/main/battleReport/battleReportGameDate.ts`：从 1.x 复制（ⓥ 其对 GameData 字段的消费与 2CE GameData 对齐——totalDays/gameDate 均在）。
  - `src/shared/i18nRenderer.ts`：从 1.x 复制；确认 `npm run build` 产出 `dist/shared/i18nRenderer.js` 且 chronicleRenderer 的 require 路径 `../../dist/shared/i18n*.js` 解析成立（2CE tsconfig outDir 与 1.x 相同为 dist ✓ ⓥ）。
- [ ] **Step 3**: `npm run build` 收敛（预期报错集中在 ck3Text 路径与 GameData 字段名，逐个对照 1.x 修）；禁止为过编译删除断言性代码。

## Task A2: 窗口 + 剪贴板 + IPC + 喂给点

- [ ] **Step 1**: 复制 `windows/ChronicleWindow.ts`（49 行，无边框置顶惯例保留）与 `public/chronicleWindow/` 三件套（**排除**两个 sync-conflict 垃圾文件）；renderer 保持字节级原样（i18n/主题/语言监听走 1.x 同名机制，2CE 的 `language-changed`/`update-theme` 广播语义一致 ⓥ 事件名核对）。
- [ ] **Step 2**: ClipboardListener 加 `CHRONICLE_TICK` / `CHRONICLE_MANAGER` 两 case（emit 带完整 payloads，模板照 1.x ClipboardListener :85-89）。
- [ ] **Step 3**: main.ts 移植接线段（对照 1.x :2140-2353 与 :2640-2887）：`chronicleWindow/chronicleWindowContext/chronicleWindowPayload/chronicleCoordinator` 四状态、coordinator 实例化（app.whenReady 内，configProvider 闭包读 `buildChronicleCoordinatorConfig(config)`）、flush/signal 助手、两个 clipboard 处理器、八个 IPC handler（`export-current-timeline` **不移植**，附录 B）。IPC 收敛进新文件 `src/main/ipc/chronicleIpc.ts`（模仿 timelineIpc.ts 的 deps+守卫模式）或按 1.x 直挂 main.ts——取直挂（通道全在 1.x main.ts 同位置，减少 diff 面积），守卫重复注册用模块级布尔。
- [ ] **Step 4**: 四个观察喂给点（全部 `observeParsedGameDataForChronicle(userDataRoot, gameData, <kind>, config.language)` + try/catch `markChronicleUnhealthy`，userDataRoot=`app.getPath('userData')`）：
  1. 对话关闭：Conversation.ts summarize() 末尾（:1793 后、diary 循环前）——在 Conversation.ts 内直调（import chronicleObservation）或回调注入；选直调（1.x 为 main.ts 持 coordinator，观察调用在 main.ts:1005——2CE 的 summarize 由 main.ts 触发链相似，ⓥ 找 2CE main.ts 调 summarize 的位置，与 1.x 同构则挂 main.ts，否则挂 Conversation.ts）。
  2. 战报：main.ts VOTC:BATTLE_REPORT 处理器 `generateBattleReport(...)` 之后（:1362 附近）。
  3. 来信：IncomingLetterGenerator.ts 生成成功后（回填 P1 剥离点 :27-32 注释处，kind='incoming_letter'）。
  4. 出信：LetterReplyGenerator.ts 对应位置（ⓥ 1.x :490 语义 = 回信生成后；2CE :374-377 LLM 调用完成、历史保存之前）。
- [ ] **Step 5**: 主题/语言广播数组追加 chronicleWindow（:2389-2395、:2412-2418）。
- [ ] **Step 6**: `npm run build` + 冒烟 `npm run start`（无崩溃、无重复注册报错）。

## Task A3: 配置 + 设置节 + 提示词

- [ ] **Step 1**: Config.ts 增四字段（:78 后）：`chronicleFrequency: 'disabled'|'quarterly'|'yearly'`、`chronicleRawSourceCharLimit: number`、`chronicleOutputMaxTokens: number`、`chroniclePrompt: string`（带默认值兜底或 `!` 断言 + 构造器赋默认，风格随文件现状）。
- [ ] **Step 2**: default_config.json 增四键（值随 1.x：yearly/30000/1000/中文模板）——mergeConfigsStrict 自动下发老用户。
- [ ] **Step 3**: settings.html 增 "Court Historian/宫廷史官" 节（frequency select + 两个 config-number，confID 直连根键；i18n 标签 `settings.chronicle*` 已在字典）；settingsRenderer 若有 key 清单需同步（ⓥ 对照 1.x settings.html:395-403 的发送逻辑，2CE config-change 通用处理器已覆盖 confID 直连，无需额外注册）。
- [ ] **Step 4**: chroniclePrompt 编辑入口放 settings.html 编年史节内（决策见基线：不走 prompts 预设层），textarea 用 config-textarea confID="chroniclePrompt"。主进程字典标签 `prompts.chroniclePrompt*` 复用作节内标签/tooltip（或 settings.chronicle_prompt_tooltip，ⓥ 以字典实际键名为准）。

## Task A4: 测试移植

- [ ] 13 个编年史测试从 1.x 复制（排除 6 个导出测试 → P2b；chronicleExportRendererSmoke 改名 chronicleRendererSmoke 仅测渲染脚本加载）：预期修复点集中在 electron mock（app.getPath）、ck3Text 路径、GameData 构造差异。chronicleObservationCallOrder 断言来信/出信喂给点在 2CE 的对应位置成立。
- [ ] 新增静态契约测试 `chronicleProtocolStatic.test.ts`（模板=incomingGreatProjectProtocolStatic）：断言 app 侧 MemoryBlockParser 期望的字段序 ↔ mod votc_chronicle_effects.txt :64-87 的 debug_log 模板、ClipboardPayload 期望 ↔ votc_chronicle loc 的 25 字段 desc。
- [ ] 全量 `npm run build && npm test` 全绿后分仓提交。

## Task V: 游戏内验收（需用户配合）

1. 先过 P6/P1 遗留矩阵；2. 决议打开编年史管理器 → 应用弹 ChronicleWindow 且 debug.log 出现 `VOTC:CHRONICLE_MEMORY` 块被 flush（应用日志 `memoryRequestId`）；3. 季度/年度脉冲 → `run votc_test_chronicle` 全链路；4. 频率 disabled 时 tick 静默；5. 生成/重试/再生成按钮走通（需 summarization 连接可用）；6. 断链场景（删除 memory_observations.json 制造损坏）→ fail-closed + 健康标记生效。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| chronicleRenderer 依赖 1.x 专属 dist 产物 | i18nRenderer 随 A1 移植；构建后 node -e require 冒烟验证 dist 路径 |
| GameData 字段名漂移（memoryTypeToken/snapshotOrdinal 等 P0 字段） | 2CE Character.ts 已含（:29-34 实测），编译期暴露 |
| Conversation summarize 位置与 1.x 调用链不同构 | A2 Step4 ⓥ 先定位再挂点；观察失败仅 markUnhealthy 不阻断主流程（1.x 语义） |
| 载荷/内存块 schema 双侧漂移 | A4 静态契约测试钉住；mod 文件逐字复制 |
| settings.html 2CE 结构差异 | confID 直连机制通用（config-change 处理器按 confID 赋根键），无需渲染端注册表 |
| archiver/yauzl 依赖缺失 | 导出整体延后 P2b，不引入安装需求 |

## 附录 A：执行策略

1. 子代理 A：Task A0（mod 仓）。
2. 子代理 B：Task A1 → A2 → A3 → A4（app 仓，A0 并行）。
3. 主会话：集成验证 + 用户游戏内矩阵。
预计净时：12–18 小时代理工时。

## 附录 B：明确延后项（P2b 前置包）

| 项 | 依赖 |
|---|---|
| history/TimelineExport{Service,Collector,BundleBuilder,Markdown} + timelineExportTypes + exportSourceSnapshot + chronicleExportIpc + `export-current-timeline` 通道与窗口导出按钮 | ChronicleMemoryStore（本计划就位）+ archiver/yauzl npm 依赖（需安装同意）|
| summaryOverrides.ts + 5 个导出测试 + summaryManagerTimeline.test | 仅被导出链引用 |
| Diary 观察喂给 | parity 决策：1.x 无此点；如需另立任务 |
| BOOKMARK 导入的 mod 侧触发链（hmd_on_action/log_hmd_playergamedata） | P7 范围 |
