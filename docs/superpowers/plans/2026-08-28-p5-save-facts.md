# P5 实验性存档事实 Save Facts 迁移实施计划（mod1/1.x → mod2 ce/2CE）

> 日期：2026-08-28 · 上游：《VOTC_合并迁移方案.md》§P5 · 前置：P0/P6/P1/P2/P3 已完成（P4 跳过）
> 源探索记录：1.x 侧 20 个 saveFacts TS 文件 + `tools/votc-save-facts` Rust sidecar（jomini/rawzip，probe/extract/verify/capabilities/session 五子命令）；2CE 侧 `saveSnapshotProtocol.ts` 解析器与 `campaignDataPaths.saveFacts*Path` 已预置，`votc_save_snapshot_*` 变量在 mod2 ce 只读不写。

## 0. 范围裁决（P5a 本期落地 / P5b 明确延后）

**P5a（本期）**——完整 fail-closed 核心管线：
1. mod 侧：`votc_save_snapshot_effects.txt` 四 effect（prepare/probe STATE/set sequence/clear）、对话入口调用 prepare、v3s/v3l init 尾补 date 五连 + snapshot 三连（按既有不变式注释插入位）、`event_window_widget_talk_v2.gui` on_finish 追加 `save votc_context`（mod1 talk widget 同款 `ExecuteConsoleCommandsForced` 批命令）、scripted_gui 门 + 3 个 probe 事件 + widget + 英中本地化 + run 脚本。
2. app 侧：SaveParserClient / saveParserPath / SaveSnapshotWaiter / SaveIdentityValidator / SaveSnapshotCoordinator / SaveFactStore / SaveFactPersistenceQueue / saveFactTypes / saveFactTopics / saveFactSettings / saveFactSchemas / SaveFactNameResolver / SaveFactAuthorityResolver / SaveFactVisibilityPolicy / SaveFactIndex / SaveFactRenderer / SaveFactProjector 全套移植（去 agency/verify/session/delta 挂点）。
3. 接线：main.ts 初始化 coordinator、VOTC:IN 路径在 `new Conversation` 前 prepare()、promptBuilder 注入 `<game_facts>`、Config + default_config 新键（默认全关）、settings.html 实验节 + `public/locales/en|zh.json` 键（其余 9 语言回落 HTML 内联英文）。
4. sidecar：Rust 工程 `cp -r` 至 2CE `tools/votc-save-facts`（排除 target/fuzz）+ `cargo build --release`；`build/stageSaveParser.js` + forge `extraResource` 打包链；exe 与 target/ 进 .gitignore。
5. 测试：saveSnapshotProtocol / saveFactSettings / saveParserPath / coordinator G0 零 I/O 门 / projector+renderer / 军事-式静态契约（mod↔app init 尾 + widget 命令 + BOM）。

**P5b（延后，登记于附录 A）**：verify 子命令消费链（AgencySaveVerifier/AgencyTaskReconciler，依赖被跳过的 P4）、session 模式（角色查询/对话中途加入挂接）、delta store、saveFactPromptWorkbench、usage telemetry、scene description/suggestion 消费点、diagnostics 设置页视图。

## 1. 契约（沿 1.x，双侧已核实）

- init 行布局：core 0–14，timeline 尾 15–22，date 五连 23–27，save_snapshot 三连 28–30（`protocol|sequence|slot`），其后字段解析端忽略。状态机：`available(1/seq>0/slot∈{0,1})`、`disabled(0/0/0)`、`legacy(缺尾)`、`unsupported`、`truncated`、`invalid`。
- 固定存档名 `votc_context.ck3`（slot 名 `votc_context_0/1.ck3` 保留）；目标路径 `<config.userFolderPath>/save games/`；等待状态机 resolve→poll→stable（3 次同指纹）→probe→matched。
- sidecar 协议：argv=子命令+`--input/--allowed-root/--max-output-bytes`；stdin 64KiB 请求 JSON；stdout 2MiB 硬帽；超时 10s；永不 throw，typed `{ok,code,detail}`；错误码 `PARSER_NOT_FOUND/CRASHED/OUTPUT_INVALID/OUTPUT_LIMIT/TIMEOUT/PROTOCOL_UNSUPPORTED/SAVE_LIMIT_EXCEEDED/START_SUPERSEDED`。
- extract 限幅：facts 500/entities 250/related 64/output 2MiB/decompressed 512MiB；probe 限幅 64KiB/64MiB。
- fail-closed 链：mod 侧 `debug_only` 之外的路径恒写 0/0/0 → app `willWaitForSaveSnapshot` false → coordinator 预检 `disabled`，零文件 I/O、零 sidecar spawn。配置键默认全 `false`，仅字面量 `true` 生效。

## 2. mod 侧任务（`voices_of_the_court_mod2 ce/`，UTF-8 BOM + LF）

- **M1** `common/scripted_effects/votc_save_snapshot_effects.txt`（新，四 effect 自 mod1 逐字移植；campaign id 全局变量 2CE 已有）。
- **M2** `events/mcc_events_v2.txt`：8999/9000/9001/9100 的 immediate 在 init_checkpoint 后追加 `votc_prepare_save_snapshot_effect = yes`（root=玩家）。
- **M3** `common/scripted_effects/log_gamedata_v3s_effect.txt` / `log_gamedata_v3l_effect.txt`：init 尾在 timeline_schema 后插 date 五连，再把 protocol 占位扩为 protocol/sequence/slot 三连；更新不变式注释。v3 与 incoming_letter 发射端已有全尾，核对即可。
- **M4** `gui/event_window_widgets/event_window_widget_talk_v2.gui`：on_finish 改 `ExecuteConsoleCommandsForced('save votc_context; gui.createwidget ...')`（mod1 talk widget 逐字同款，保序避免同帧竞态）。
- **M5** `common/scripted_guis/votc_save_snapshot.txt` + `events/votc_save_snapshot_probe_events.txt` + `gui/event_window_widgets/votc_save_snapshot_probe{,_inactive,_text}_widget.gui` + 本地化（en/simp_chinese）+ run 脚本（`votc_test_save_snapshot_prepare/read/cleanup`）+ cleanup 补四个变量。

## 3. app 侧任务（`Voices_of_the_Court2 ce/`）

- **A0（先行，契约层）**：移植 `saveFactTypes.ts`、`saveFactSettings.ts`（去 delta/agencyVerify/characterQuery 键或保留但注释 P5b），确定共享类型面。
- **A1（代理移植组 1，纯事实层）**：saveFactTopics / SaveFactNameResolver / SaveFactAuthorityResolver / SaveFactVisibilityPolicy / SaveFactIndex / SaveFactRenderer / SaveFactProjector + 各自单测（electron mock 按 2CE 既有套件样式）。
- **A2（代理移植组 2，sidecar 管线层）**：SaveParserClient / saveParserPath / SaveSnapshotWaiter / SaveIdentityValidator / SaveSnapshotCoordinator / SaveFactStore / SaveFactPersistenceQueue / saveFactSchemas + 单测；Coordinator 预检保留全部早退分支（G0 零 I/O 门必须有测试钉住），去 verify/session/delta/joinCandidates 挂点。
- **A3（自做）**：Config.ts 可选字段 + `default_userdata/configs/default_config.json` 键（saveGameSnapshotParsingEnabled/PromptEnabled/DiagnosticsEnabled/WaitTimeoutMs 15000/ParserTimeoutMs 10000/预算 baseline 400 dynamic 800/类别开关 family/realm/activity/location/court true、war false）。
- **A4（自做）**：main.ts——`initializeSaveSnapshotCoordinator()`（失败仅禁用本次会话）、VOTC:IN 路径 `willWaitForSaveSnapshot` 判定 + `prepare()` 先于 `new Conversation`、`save-facts-status` 渲染端通知、`save-facts:get-diagnostics` IPC；promptBuilder 在 description 后注入 `<game_facts>`（Projector 空 block 时不注入）。
- **A5（自做）**：settings.html 实验节（Court Historian 节为模板）+ `public/locales/en.json/zh.json` 键（其余 9 语言靠内联英文回落）；HTML 内联英文为缺省文本。
- **A6（自做）**：`build/stageSaveParser.js` + `forge.config.js` extraResource + `.gitignore`（tools/votc-save-facts/target、build/save-parser）+ `cp -r` Rust 工程并 `cargo build --release`。

## 4. 测试与验证

1. 代理交付的单测 + 自做测试全绿：`npm run build` + `npm test`。
2. `tests/unit/saveFactsProtocolStatic.test.ts`（模板=militaryProtocolStatic）：mod 四 effect 存在、v3s/v3l init 尾字段序正则 ↔ saveSnapshotProtocol.ts 索引常量互证、talk_v2 on_finish 命令、probe 事件/loc/run 脚本/BOM。
3. sidecar 冒烟：`votc-save-facts.exe capabilities` 输出 JSON 校验（不依赖真存档）。
4. 游戏内（需用户）：`-debug_mode` 启动 → 开对话 → `save games/votc_context.ck3` 生成、debug.log STATE 行 protocol=1 sequence 递增、chat 窗收到 `<game_facts>`；非 debug 模式走 disabled 零 I/O。run 脚本已复制到 CK3 run 目录。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 1.x 20 文件移植漂移 | 代理以 `cp` 逐字起步、只做声明式裁剪；两组文件互不重叠；集成时我统一编译修边 |
| saveFactTypes 30KB/Store 61KB 裁剪误伤 | A0 我先定契约层；删除面仅限 agency/verify/session/delta 导入点，逐处留 `P5b` 注释 |
| Rust 构建不可复现 | cargo 1.95 本地构建 + 1.x 预编译 exe 兜底复制；Cargo.lock 随迁 |
| talk_v2 on_finish 改动影响既有对话链 | 仅追加批命令首段，`gui.createwidget` 段逐字保留；对话主流程不依赖 save 成败 |
| 11 语言设置页文案 | 仅 en/zh 入 JSON，其余内联英文回落（与迁移翻译债策略一致） |
