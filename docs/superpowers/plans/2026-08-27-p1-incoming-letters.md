# P1 NPC 主动来信迁移 — 实施计划（v1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **前提状态（2026-08-27）：** P0 已完成（`adade44a` 等扩展事实解析系列）；P6 时间线 v2 已完成 App 侧全部提交至 `848d7808`、Mod 侧至 `a2d1a15`，且 `npm test` 19 套件 527 用例全绿（2026-08-27 复跑）。P6 的 §11 游戏内实机验收仍待用户执行；P1 可并行开发，但**合并验收矩阵时先过 P6 各项再测来信链路**。timeline v2 基础件（registry/journal/resolver/lock/businessWire/campaignDataPaths/history 记录合约）已在 2CE 就位，本计划直接消费，不再重复移植。

**Goal:** 将 1.x 的 NPC 主动来信全家桶迁入 2CE：mod 侧触发器/效果/事件/GUI/决议/on_action 全量移植并适配 mod2 ce 基础设施；app 侧打通 `VOTC:INCOMING_LETTER` 剪贴板命令 → debug.log 上下文解析 → 时间线转换（复用已就位的 `runIncomingLetterTimelineTransition`）→ LLM 生成信文 → run 文件回写游戏 → 信件历史归档与展示。

**Architecture 决策（先读）：**
1. **不移植 HUD 按钮**：mod1 通过整文件替换 `gui/hud.gui` 加按钮打开设置窗口（跨版本维护包袱）。遵循方案 A 原则 2「决议入口优先」：新增一个轻量本地事件携带按钮 widget，用 mod1 设置窗口自带的同款 `ExecuteConsoleCommands('GUI.ClearWidgets …; gui.createwidget …')` 模式加载窗口；入口做成决议。
2. **Agent 投影整段剥离**：1.x 的 agency 投影注入（构造器第二参、`buildIncomingLetterProjectionSection`、lazy require 段）在 2CE 无对应子系统（agency 属 P4），全部删除而非留空桩。`config.agencyIncludeInIncomingLetters` 同步不引入。P4 落地后按附录 B 回填。
3. **编年史喂给降级为延后项**：1.x 在生成成功后调用 `observeParsedGameDataForChronicle` + `markChronicleUnhealthy`（IncomingLetterGenerator.ts:496–502）。2CE 只有 `chronicleTypes.ts`（纯类型），故该调用整体剥离，记录为 P2 回填点；不影响信件本体协议。
4. **时间线接线零新建**：`runIncomingLetterTimelineTransition`（timelineBusinessWire.ts:430–446）、`requireCampaignIdentity`、campaign-scoped 路径、`IncomingLetterHistoryRecordV1` 类型/校验器/读取器/显示过滤分支均已随 P6 移植且无生产调用者——本计划就是它的第一个消费者，**禁止改其签名或协议语义**。
5. **letters.html 收件箱集成为增强项**：MVP 展示面沿用 1.x 事实——来信以 `direction:'incoming'` 的历史档案形式出现在会话历史窗口的「信件」tab（conversationHistory.ts 显示分支已在 P6 移入）；游戏内到达弹窗 artifact 不变。把来信混入 configWindow Letters 页inbox 属增强任务 E1（可独立裁剪）。
6. **提示词键接线补全**：`prompts.incomingLetterPrompt` 标签在 2CE 的类型化 locale 里已有（src/shared/locales/en.ts:1505、zh.ts:1507），但 `promptKeys` 数组（main.ts:1489–1505）、设置页 textarea、`default_userdata/configs/prompts/*.json` 均未接线——label 存在而管线断裂是 1.x promptWorkbench 教训里点名要避免的形态，本计划一次接完。
7. 两仓库（`Voices_of_the_Court2 ce/` 与 `voices_of_the_court_mod2 ce/`）独立提交，消息格式沿用各自仓库惯例（英文 conventional commits）。

**规格来源:** `docs/superpowers/specs/2026-08-24-votc-full-alignment-design.md` §3/P1（第 40–43 行）；总方案《VOTC_合并迁移方案.md》§P1。
**参考实现:** `Voices_of_the_Court1/src/main/letter/IncomingLetterGenerator.ts`（1157 行）、`Voices_of_the_Court1/src/main/main.ts:1556–1591`、`voices_of_the_court_mod1/common/scripted_effects/votc_incoming_letter_effects.txt`（2491 行）全家桶。
**涉及仓库:** `Voices_of_the_Court2 ce/` 与 `voices_of_the_court_mod2 ce/`（两个独立 Git 工作区，分开提交）。

---

## 已验证事实基线（2026-08-27 实测）

执行代理不需要重新验证本节结论，但标 ⓥ 的定位命令在动手前必须重跑（防锚点漂移）。基线 HEAD：app `848d7808`、mod `a2d1a15`。

### Mod 侧：mod1 来信全家桶文件清单（源）

| 文件（voices_of_the_court_mod1/） | 行数 | 角色 |
|---|---|---|
| `common/scripted_effects/votc_incoming_letter_effects.txt` | 2,491 | 槽位清理/分配、作者选择、三个 start 效果、逐槽上下文 debug_log 矩阵 |
| `events/votc_incoming_letter_events.txt` | 2,311 | 全部事件（见下方命名空间与分段）|
| `common/scripted_triggers/votc_incoming_letter_triggers.txt` | 354 | 使能/就绪 + 作者资格 triggers |
| `common/on_action/votc_incoming_letter_on_actions.txt` | 81 | on_action 注册（§钩子清单）|
| `common/scripted_guis/votc_incoming_letters.txt` | 279 | 设置窗口背后的 scripted GUI（含 battle report 共享开关）|
| `gui/custom_gui/votc_incoming_letters_window.gui` | 671 | 频率设置窗口 |
| `gui/event_window_widgets/event_window_widget_incoming_letter_1..8.gui` | 17×8 | 到达事件 widget，widget_show 时 run `incomingletter_v2_N.txt` |
| `common/decisions/votc_incoming_letter_settings.txt` | 67 | 启用/停用/清槽三决议 |
| `common/scripted_effects/log_incoming_letter_gamedata_effect.txt` | 85 | 快照 logger（VOTC:IN init 行 + character 行）|
| `run_test_scripts/votc_test_incoming_*.txt` | 17 个 | 控制台验证脚本 |

事件命名空间 `votc_incoming_letter_event`，分段：`.0001`（季度主题延迟选择）、`.0002`（on_army_monthly 围城检查）、`.0003`（围城完成失地信）、`.0004/.0012/.0016/.0005/.0019`（季度脉冲调度/家书/诗笺/派系/奇观里程碑分发）、`.0006`（开战分叉 ally_call/revolt_urgent）、`.0007→.0017`（死亡追焦）、`.0008`（旅行完成分类）、`.0010/.0011`（建筑 started/completed 奇观扫描；`.0010` 上方陈旧注释写着 "0009 scheme discovered"，实际注册的是 building started——`on_scheme_discovered` 有意未注册）、`.9001`（探针：保存 scope 并输出 `VOTC:INCOMING_LETTER/;/probe/;/<actor>/;/<recipient>`）、`.0101–.0108`（可见到达弹窗）、`.0111–.0118`（隐藏清槽）、`.0201–.0208`（剪贴板桥，提前 1 天，走 `event_window_widget_talk_clear` 的 `EventWindowData.CopyToClipboard`）。

**信件槽位**：全局变量 `votc_incoming_letter_1..8`（`flag:occupied`）+ `_sender_N` + `_type_N`；玩家变量 `_timer/_sent_day/_delivery_id`。槽 1–6 通用事件信、**槽 7 家书**、**槽 8 诗笺**。写信线程变量为 `votc_letter_1..9`，无冲突（见附录 A 占用表）。

**23+2 种信件类型 flag**（`votc_start_incoming_letter_effect = { TYPE = flag:<type> }`，effects 文件 ：1211 起）：`vassal_memorial, siege_report, lost_holding, courtier_petition, rival_taunt, dear_friend_greeting, ally_call_for_aid, revolt_urgent, deathbed_letter, pilgrimage_tales, tour_tales, wedding_tales, hunt_tales, tournament_tales, travel_tales, faction_warning, scheme_exposed, natural_disaster, tributary_letter, liege_overlord_letter, great_work_notice, great_project_report, letter_to_travelling_player` + 专用槽 `family_letter/poetry_letter`。

**剪贴板命令 schema（冻结，双端契约）**：`VOTC:INCOMING_LETTER/;/incoming_letter_N/;/<type>/;/<delivery_id>/;<player_id>/;/2/;/1/;/<campaign_id_a..d>/;/<bootstrap_kind>/;/<timeline_schema>`（clipboard_codes 键 `votc_incoming_letter_bridge_1..8`）。debug.log 上下文行：`VOTC:INCOMING_LETTER/;/context/;/<slotId>/;/<type>/;/<sentDate>/;/<senderId>/;/<deliveryId>/;/k=v…`，且要求同流 preceding `VOTC:IN/;/init` 行。

### Mod 侧：mod2 ce 现状（2026-08-27 rg 实测）

| 依赖符号 | mod2 ce 现状 | 动作 |
|---|---|---|
| `namespace = votc_incoming_letter_event` | 不存在 | ✅ 无冲突 |
| `clipboard_transfer_event_theme` | `common/event_themes/clipboard_transfer_event_theme.txt` 存在，4 个事件文件在引用 | ✅ 直接用 |
| `event_window_widget_talk_clear`（gui 定义文件） | 多个事件在引用；.gui 定义文件存在性在 Task M0 ⓥ 复核 | ⓥ |
| `custom_widgets_container`（原版容器名） | 已有事件在用 | ✅ |
| `log_character = yes`（mod1 全量角色快照） | **不存在同名效果**；对应物为 `log_character_v2_effect.txt` 的 `log_character_v2`（内含 log_relations/log_opinion_breakdown/log_memories/log_secrets/log_ksecrets 子效果） | 改名映射 |
| `debug_log = log_character_header` | 三个 log_gamedata_v3* 文件内已有同款用法 | ✅ 同款可用 |
| `votc_clear_conversation_portrait_slots` / `votc_set_conversation_portrait_slots` / `votc_conversation_characters_list` | **均不存在**（mod2 ce 无肖像子系统） | logger 内剥离（log_incoming_letter_gamedata_effect.txt 第 10/15/20 行）|
| `group = votc_tool_group_type`（mod1 决议组） | 不存在；现有 `common/decisions/votc_decisions.txt` 用 `decision_group_type = decisions` | 三决议改组名 |
| checkpoint v2 效果（init/bump/prepare/token/campaign id） | P6 已全量替换（363 行版） | ✅ 直接被来信效果调用 |
| `votc_letter_delay` script value | ⓥ 复核是否已随写信线程存在于 mod2 ce（若缺则连 `votc_squared_distance_value` 一并入） | ⓥ |
| 决议 desc 本地化键 | mod1 自身**缺失** `votc_enable/disable/clear_incoming_letters_decision_effect_desc` 三个键（显示裸 key 名） | port 时补上（顺手修 1.x 遗留缺陷）|
| hud.gui | mod2 ce 无此文件（未替换过 HUD） | 维持不动，窗口开启走决议+事件 widget |
| 事件本地化 | talk_l_*.yml 共 43 个 `votc_incoming*` 键 ×9 语言；clipboard_codes_l_*.yml 8 键 | 只落 en + simp_chinese 两语，其余语言由 CK3 回落英文 |

### App 侧：2CE 现状插入点（2026-08-27 实测）

| 插入点 | 锚点 | 说明 |
|---|---|---|
| ClipboardListener 分发 switch | `src/main/ClipboardListener.ts:56–81`，最后一支 `case "BATTLE_REPORT"` 在 ：78 | 新增 `case "INCOMING_LETTER"` 于其后，emit `'VOTC:INCOMING_LETTER', payloads[0], payloads[1], payloads[2]`（1.x ClipboardListener.ts:74–81 同款）|
| main.ts 事件处理挂点 | `main.ts:1175`（VOTC:LETTER）/`:1346`（VOTC:BATTLE_REPORT）；变量声明区 ：270–279 | 新增 `clipboardListener.on('VOTC:INCOMING_LETTER', …)`，校验 `/^incoming_letter_([1-8])$/`、type 非空、deliveryId 为安全非负整数（1.x main.ts:1556–1591 模板去掉 agencyService）|
| **时间线转换（已就位，勿改）** | `src/main/timelineBusinessWire.ts:412–446`：`IncomingLetterTransitionInput`、`incomingLetterRequestKey`、`runIncomingLetterTimelineTransition`（source=`'incoming_letter'`，commitMode=`'post-bump-node-only'`，targetEpoch=gameData.votcCheckpointEpoch+1，scopeVar=`'talk_first_scope'`，guardPostBumpNodeOnly）| 目前零生产调用者 |
| 身份解析（已就位） | `requireCampaignIdentity({ playerID, timelineSnapshotResult })`（campaignIdentityResolver.ts:94）| `CampaignIdentityUnavailableError/TimelineRegistryCorruptError/UnsupportedTimelineSchemaError` 三态分流模板见 LetterReplyGenerator.ts:335–351 |
| 历史记录合约（已就位） | `historyRecordTypes.ts:149–163`（`kind:'incoming_letter'`, `direction:'incoming'`）、`historyRecordSchemas.ts:485–511` 校验器、`HistoryRecordReaders.ts:450–457` 分类读取、`conversationHistory.ts:396` 显示分支 | 写路径函数尚未搬：1.x `saveIncomingLetterHistory`（conversationHistory.ts:596–620）与 `archiveFutureLetterHistoryForPlayer`（:337）待迁入 2CE conversationHistory.ts |
| 归档查询通道 | `get-archive-history-entries(playerId, checkpointEpoch, type)` 已注册（timelineIpc 注册链，main.ts 旧通道已被接管）| 历史 tab 无需前端改动即可显示来信 |
| 参考实现模板（当前活跃回信链路） | `LetterReplyGenerator.generateLetterReply`（LetterReplyGenerator.ts:255–423）：身份解析 :278 → epoch+1 :293 → 内容指纹入 eventSignature :298–310 → transition :313–325 → 错误三分流 :335–351 → fallback run 文件先行 :357 | IncomingLetterGenerator 照此编排 |
| prompt 基建缺口 | `promptKeys` 数组 main.ts:1489–1505 无 `incomingLetterPrompt`；`default_userdata/configs/prompts/*.json`（11 语）无该键；`public/configWindow/prompts.html` 无 textarea | 需四处接线；locale 标签 `prompts.incomingLetterPrompt` 已在 src/shared/locales/{en,zh}.ts，ⓥ 顺手确认 public/locales/*.json 是否同样带标签键 |
| 角色描述脚本 | `default_userdata/scripts/prompts/description/standard/pListLetter.js` 两仓同构 | 1.x 经相对 require 引入（IncomingLetterGenerator.ts:654），照抄路径层级 |
| summary/memory 消费 | 2CE 汇总存储经 P6 已 campaign-scoped 化；`createMemoryString/createIntelligenceString` 与 bounded 时间块在 2CE promptBuilder 中的可用形态 ⓥ | 实现时对齐 LetterReplyGenerator 现行取数方式；intelligence 缺失则以空段占位并在提交信息注明 |
| 测试基建 | jest 单根配置 `testMatch ['**/unit/**/*.test.ts']`，moduleNameMapper 去 `.js` 后缀；静态契约测试先例：121d095b 把 timelineProtocolStatic 指向 mod2 ce | 新静态测试 `MOD_ROOT = '../voices_of_the_court_mod2 ce'` |
| i18n 语言资源 | `public/locales/{de,en,es,fr,ja,ko,pl,pt,ru,tr,zh}.json` 11 语 | 新 UI 文案 en+zh 先行，其余语言靠默认文本回落 |

### 1.x 关键实现细节速查（IncomingLetterGenerator.ts，逐条带行号）

- `VALID_TYPES` 25 元型联合 ：154–162；`DEFAULT_INCOMING_LETTER_PROMPT` :168；KV-cache 稳定系统消息 `STABLE_INCOMING_LETTER_POLICY` :173；TOPIC/FACT/poetry/great-project 标签表 ：175–296。
- 幂等去重模块级状态 `inFlight/completed/latestSignatureBySlot` :164–166；签名 `${slotId}|${playerID}|${senderId}|${sentDate}|${type}|${deliveryId}` :424。
- `parseContext()` :564–644 —— 从日志尾部倒扫最近一条匹配 slot/type/deliveryId 的 context 行，要求前置 init 行，返回字节区间 `[snapshotStartOffset, snapshotEndOffset]`；随后 `parseLog(debugLogPath, {startOffset, endOffset})` 重解析全量 GameData（:409–417）并以 `gameData.aiID !== context.senderId` 兜底校验（:418–422）。
- 生成流程：validate → parseContext（失败即写 fallback run 文件）→ 区间重解析+签名 → **时间线转换**（:443–494，错误三分流后直接 return，不留半态）→ ~~chronicle 观察~~（P1 剥离）→ 先写 fallback（:507）→ buildMessages（:509）→ `apiConnection.complete(messages, false, {max_tokens, temperature, __purpose:'incomingLetter'})`（:512–516）→ 非空且签名未过期 → `normalizeCk3String`（:320，≤500 字符，fallback loc key `votc_incoming_letter_fallback_desc`）→ 终版 run 文件（:986–1035，含 `create_artifact journal/scroll` 弹窗与 `buildTimelineSetBlock` :925–942 向 `global_var:votc_incoming_letter_player_scope` 写 node 四元组）→ 历史归档（:1048–1053 先 archiveFuture 过滤）→ summary 保存（:1113–1156）。
- run 文件写入目标：`<userFolderPath>/run/incomingletter_v2_<slotNumber>.txt`，以 `global_var:votc_incoming_letter_<n>` + delivery-id + type 门卫，else 分支输出 `VOTC:INCOMING_LETTER/;/run_skipped/;/…`（:979/:1030）——与 mod 侧到达 widget `run incomingletter_v2_N.txt` 构成回环契约。
- prompt 组装（buildMessages :646–923）：描述脚本 pListLetter.js → 发起者过滤 summaries + `buildBoundedChronologicalBlock` → memory/intelligence 字符串 → `config.incomingLetterPrompt || DEFAULT` 做 `{{senderName}}/{{playerName}}/{{letterLanguage}}` 替换 → 按类型的 reason 正文（:751–858）→ `[system STABLE_POLICY, user context, user request]`（:916–920）。

---

## 文件结构

### A 类：mod 侧从 mod1 直接复制（后按 D 类逐点适配）

| # | 源（voices_of_the_court_mod1/） | 目标（voices_of_the_court_mod2 ce/） | 行数 | 适配要点 |
|---|---|---|---|---|
| 1 | common/scripted_effects/votc_incoming_letter_effects.txt | 同路径 | 2,491 | 引用的外部符号仅剩 checkpoint v2 家族（已就位）；确认无 portrait/log_gamedata 裸调用残留 |
| 2 | events/votc_incoming_letter_events.txt | 同路径 | 2,311 | 纯增量，命名空间全新 |
| 3 | common/scripted_triggers/votc_incoming_letter_triggers.txt | 同路径 | 354 | 纯增量 |
| 4 | common/on_action/votc_incoming_letter_on_actions.txt | 同路径 | 81 | 注册进 8 个原版 on_action，注意与既有注册块并列追加 |
| 5 | common/scripted_guis/votc_incoming_letters.txt | 同路径 | 279 | 纯增量（含 battle report 共享开关，无害保留）|
| 6 | gui/custom_gui/votc_incoming_letters_window.gui | 同路径 | 671 | 开窗命令不变 |
| 7 | gui/event_window_widgets/event_window_widget_incoming_letter_1..8.gui | 同路径 | 17×8 | run 回环契约不变 |
| 8 | common/decisions/votc_incoming_letter_settings.txt | 同路径 | 67 | 决议组改 `decisions`；补 3 个 desc 键 |
| 9 | common/scripted_effects/log_incoming_letter_gamedata_effect.txt | 同路径 | 85 | 剥离肖像 3 行（:10/:15/:20）；`log_character = yes`×5 → `log_character_v2 = yes` |
| 10 | run_test_scripts/votc_test_incoming_*.txt | 同目录 | 17 个 | 头注释自带运行说明与复制目标 |

**明确不复制**：`gui/hud.gui` 按钮（架构决策 1）、`common/defines/00_votc_defines.txt`（NGUI.RENAME_MAX_LENGTH 服务于写信输入框，来信功能不含）、决策组类型文件（改用现有组）。

### B 类：mod2 ce 修改现有文件

| 文件 | 动作 |
|---|---|
| localization/english/talk_l_english.yml、simp_chinese/talk_l_simp_chinese.yml | 追加 43 个 `votc_incoming*` 键 + 3 个新决议 desc 键（修复 mod1 缺失）|
| localization/english/clipboard_codes_l_english.yml 及 simp_chinese 孪生 | 追加 8 个 `votc_incoming_letter_bridge_N` 键 |

### C 类：mod2 ce 新建（开窗桥）

| 文件 | 职责 |
|---|---|
| events/votc_incoming_letters_settings_bridge_events.txt | 小命名空间事件（如 `votc_letters_settings_bridge_event.9001`）：隐藏即时窗口 + 单按钮 widget，onclick 执行 `ExecuteConsoleCommands('GUI.ClearWidgets votc_incoming_letters_window; gui.createwidget gui/custom_gui/votc_incoming_letters_window.gui votc_incoming_letters_window')` 后自动关闭自身；theme 用 `clipboard_transfer_event_theme` 或更中性 theme，option/desc 走英中两语 |
| common/decisions 中追加一条 open-settings 决议（并入 8 号文件的适配或单独小文件） | `trigger_event` 打开上述桥事件；localization 同步 |

### D 类：app 侧改动

| 文件 | 动作 |
|---|---|
| src/main/ClipboardListener.ts | switch 末尾加 `INCOMING_LETTER` 分支 |
| src/main/main.ts | 新增 VOTC:INCOMING_LETTER handler（校验 + sleep(250) + 解析 debug.log 路径 + 实例化生成器）；`promptKeys` 数组补 `incomingLetterPrompt` |
| src/main/letter/IncomingLetterGenerator.ts（新文件，自 1.x 移植改造） | 按「1.x 关键实现细节」改造：剥 agency（构造器单参）、剥 chronicle 观察、summary/memory 取数对齐 2CE 现行形态；协议解析段（parseContext/schema/签名/run 文件模板）逐字节保持 |
| src/main/conversationHistory.ts | 迁入 `saveIncomingLetterHistory` + `archiveFutureLetterHistoryForPlayer`（复用 2CE 已有的 campaign 路径与 updateJsonArrayAtomic）；ⓥ 若 P6 合并已带入则只查漏 |
| src/configWindow/promptsRenderer.ts | prompts 页 textarea 默认值与渲染 |
| public/configWindow/prompts.html | `incomingLetterPrompt` textarea（confID 同名，rows=6，tooltip 复用已有 locale 标签）|
| public/locales/en.json、zh.json | 补 `prompts.incomingLetterPrompt` 相关标签（若 src/shared/locales 已有、JSON 缺失才需要）|
| default_userdata/configs/default_config.json、configs/prompts/en.json 与 zh.json（其余 9 语拷贝英文文案） | 新增键，让 userDataCheck 的目录同步 + mergeConfigsStrict 自动下发给老用户 |
| tests/unit/**（E 类） | 见测试清单 |

### E 类：测试（必须全绿）

| 测试 | 来源/形态 |
|---|---|
| incomingGreatProjectProtocolStatic.test.ts | 自 1.x 移植，MOD_ROOT 改指 `../voices_of_the_court_mod2 ce`，断言应用类型注册表 ↔ mod 上下文 emit 行的静态一致（先例 121d095b）|
| ClipboardListener payload 测试 | 新写：VOTC:INCOMING_LETTER 三载荷顺序 slot/type/deliveryId |
| IncomingLetterGenerator.parseContext 单测 | 新写：合成 debug.log fixture（仿 tests/fixtures/debuglog_p0.txt 做法），覆盖 正常匹配/无 init 行拒绝/deliveryId 不匹配取最新一条/字段越界容错 |
| prompt 构建 shape 单测 | 新写：messages 三段结构、STABLE_POLICY 系统位、{{placeholder}} 替换；不含真实网络调用 |
| 既回归 | timelineBusinessWire.test.ts:481（incoming_letter source 请求键幂等）、timelineTransitionJournal.test.ts:911–971 已经覆盖时间线层，不重复造 |

---

## Task M0: mod 侧预检（voices_of_the_court_mod2 ce 工作区）

- [ ] **Step 1: 两工作区干净**：`git -C "voices_of_the_court_mod2 ce" status --porcelain` 应为空（已知干净）；app 仓同理。
- [ ] **Step 2: ⓥ 复核剩余符号**：
  ```bash
  cd "voices_of_the_court_mod2 ce"
  Test-Path 等价：ls gui/event_window_widgets/event_window_widget_talk_clear.gui   # 桥 widget 定义
  rg -n "votc_letter_delay" common/script_values/ common/scripted_effects/         # 传递距离/延迟脚本值是否已存在
  rg -n "^namespace" events/*.txt                                                  # 再次确认命名空间唯一性
  ```
  若 `votc_letter_delay`/`votc_squared_distance_value` 缺失 → 连同 mod1 `common/script_values/votc_letter_delay.txt`（109 行）一并纳入 A 类复制清单。
- [ ] **Step 3: 记录基线**：`git rev-parse HEAD` 写入提交信息或临时 notes。

## Task M1: A 类复制 + 逐点适配（D 类对应项同步）

- [ ] **Step 1: 十个文件复制**（cp 保字节，天然继承 UTF-8 BOM/CRLF/tab）。
- [ ] **Step 2: log_incoming_letter_gamedata_effect.txt 适配**：删除 ：10、:15、:20 三处肖像调用与 `votc_conversation_characters_list` 块；五处 `log_character = yes`（:43/:46/:56/:61/:80）→ `log_character_v2 = yes`。
- [ ] **Step 3: 决议适配**：`group = votc_tool_group_type` → `decision_group_type = decisions`（对齐 votc_decisions.txt 既有风格）。
- [ ] **Step 4: ⓥ 编译式自查**（CK3 无编译器，用引用核对代替）：
  ```bash
  rg -o "votc_[a-z_0-9]+_effect" common/scripted_effects/votc_incoming_letter_effects.txt | sort -u   # 每个 effect 名都要能在两仓 scripted_effects 中找到定义
  rg -o "votc_[a-z_0-9]+_trigger" common/scripted_triggers/votc_incoming_letter_triggers.txt common/scripted_effects/votc_incoming_letter_effects.txt | sort -u
  ```
- [ ] **Step 5: 提交**：`feat(incoming-letter): port incoming letter family from mod1 (core/effects/events/triggers)`。

## Task M2: 开窗桥 + 决议入口 + 本地化

- [ ] **Step 1: C 类桥事件**（照 §C 规格）；desc/option 英中两语键 `votc_letters_settings_bridge_*`。
- [ ] **Step 2: open-settings 决议 + 3 个缺失 desc 键**一并落实。
- [ ] **Step 3: B 类本地化追加**：43 talk 键 + 8 clipboard_codes 键 + 新增决议/桥键，en + simp_chinese。
- [ ] **Step 4: UTF-8 BOM 自检**（所有触碰过的 yml/txt 前 3 字节必须 `EF BB BF`，包括新复制的 A 类文件）：
  ```bash
  for f in < touched-files >; do head -c 3 "$f" | od -An -tx1; done
  ```
- [ ] **Step 5: 提交**：`feat(incoming-letter): settings bridge event, decisions and localization (en/sc)`。

## Task A0/A1: app 侧剪贴板分支 + 生成器移植（Voices_of_the_Court2 ce 工作区）

- [ ] **Step 1: ClipboardListener 分支 + 单测**（payload 顺序 slot/type/deliveryId）。
- [ ] **Step 2: 迁移 IncomingLetterGenerator.ts**：按 D 类改造清单执行；建议改造顺序＝先删 agency 导入块使 tsc 报错暴露全部耦合点 → 逐一处置 → 协议段零改动校验（对 1.x 源 diff 仅允许出现改造点差异）。
- [ ] **Step 3: conversationHistory 写路径迁入**（saveIncomingLetterHistory / archiveFutureLetterHistoryForPlayer；ⓥ 先 rg 确认 P6 合并未带入）。
- [ ] **Step 4: main.ts handler**：校验序列仿 1.x main.ts:1556–1591；debug.log 路径 `path.join(config.userFolderPath,'logs','debug.log')`；实例化 `new IncomingLetterGenerator(config)`（无第二参）。
- [ ] **Step 5: prompt 四点接线**（main.ts promptKeys / prompts.html / promptsRenderer / default_userdata 双 json 组）；spec：en/zh 写完整翻译，其余 9 语复制英文正文。
- [ ] **Step 6: `npm run build` 0 error → `npm test` 全绿 → 提交**：
  - `feat(letter): accept VOTC:INCOMING_LETTER clipboard command`
  - `feat(letter): port IncomingLetterGenerator with timeline transition`
  - `feat(config): expose incomingLetterPrompt end-to-end`

## Task A2: app 侧静态契约与解析测试

- [ ] **Step 1**: 移植并重定 MOD_ROOT 的协议静态测试；fixture 单测两组；全绿提交：`test(letter): static protocol parity against mod2 ce and context parser coverage`。

## Task V: 安装、同步与游戏内验收（需用户配合）

- [ ] **Step 1: mod 安装与脚本同步**：
  ```bash
  python "voices_of_the_court_mod2 ce/package_mod.py" install
  cp "voices_of_the_court_mod2 ce/run_test_scripts/"*.txt "$USERPROFILE/Documents/Paradox Interactive/Crusader Kings III/run/"
  ```
- [ ] **Step 2: 先过 P6 §11 五项**（campaign id、checkpoint token、对话关闭 CHECKPOINT set、battle snapshot、历史窗口 epoch 过滤）。
- [ ] **Step 3: 来信验收矩阵**（每项看 `%USERPROFILE%\Documents\Paradox Interactive\Crusader Kings III\logs\debug.log`）：
  1. 决议启用来信 → 打开设置窗口（频率四组均可选且能存档读档保持）；
  2. `run votc_test_incoming_<name>.txt` 逐类型触发 17 个脚本（含家书槽 7、诗笺槽 8）→ 出现 `.020N` 剪贴板桥行 → 应用日志见到生成器启动 → 到达弹窗显示 AI 信文 artifact；
  3. 断网/错误 API 配置场景 → 到达弹窗回落 `votc_incoming_letter_fallback_desc` 且 debug.log 有 `run_skipped`/生成失败分流；
  4. 会话历史窗口「信件」tab → 来信以发起者姓名为标题、topic 为副题列出，且按 checkpoint epoch 过滤正确；
  5. 冷却生效：同类信短期内不再复发；关闭决议后脉冲停止；
  6. 存档再载入 → 槽位/冷却/送达 ID 一致，无双发；双档互不污染（复用 P6 双开方法）。
- 任一步失败回到对应 Task 修复；mod 改动后必须重跑 `package_mod.py install` 再验。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| P6 未过实机验收就叠 P1 | 到达链路里 checkpoint bump 由 mod 已 bump 前提支撑（post-bump-node-only），epoch 错位时静默错谱 | 验收矩阵 Step 2 强制 P6 先行；`guardPostBumpNodeOnly` 对 CK3==target 视为已应用，天然幂等 |
| mod 侧引用的外部效果在 mod2 ce 缺定义 | 载入报错 | Task M0/M1 引用核对命令全量列名比对；首次进游戏前再做一次 error.log 通览 |
| 剪贴板桥需要游戏恰好在 `.020N` 时刻运行（提前 1 天的到达预告） | 错过则本次信静默丢失（mod1 同款特性） | 保持行为一致不修；run 脚本调试时可缩短 delay |
| 摘要/memory 取数形态两版不同导致 prompt 上下文漂移 | 信文质量退化但无硬错 | Task A1 Step 2 以 LetterReplyGenerator 现行形态为准对齐；intelligence 缺失记空段并在提交信息注明 |
| 11 语 prompts json 漂移造成老用户拿不到新键 | 设置页出现空 prompt | 代码级 DEFAULT_INCOMING_LETTER_PROMPT 兜底已内置（1.x 设计）；同时靠 synchronizeDirectory 哈希同步新文件 |
| 大体量复制引入 mod1 特有残留引用（portrait/scene/HUD） | 载入错误 | A 类表「明确不复制」清单 + rg 效果名枚举核对双重把关 |

---

## 执行策略

推荐 subagent-driven-development，派发顺序：

1. 子代理 A：Task M0 → M1 → M2（mod 仓库，串行）
2. 子代理 B：Task A0/A1 → A2（app 仓库，可与 A 并行）
3. 主会话：Task V（安装 + 用户配合的游戏内矩阵）

**预计净时：** 10–16 小时代理工时（不含游戏内等待）。价值密度最高的部分（mod 触发体系与 app 生成编排）互相独立，协议两端由冻结 schema 保证合龙。

---

## 附录 A：《全局变量/事件 ID 占用表》骨架（持续维护于本文档附录）

| 变量族 | 归属 | 相互作用 |
|---|---|---|
| `votc_letter_1..9` + `_timer/_sent_day` | 写信线程（mod2 ce 既有）| 来信不复用、不改名 |
| `votc_incoming_letter_1..8` + sender/type + timer/sent_day/delivery_id | 来信槽（本计划）| 与上行并存无冲突；mod1 已验证共存 |
| `votc_incoming_letter_snapshot_sender/player_scope/fact_*` | 来信瞬时事实 globals | 生成快照期存活，事后清理 |
| `votc_incoming_letters_{global_cooldown,<type>_cooldown,family/poetry_*}` | 频率控制 | 读多写一 |
| `votc_checkpoint_epoch/token/pending_token/node_a..b/parent_a..b` | checkpoint v2（P6）| 来信读取 epoch 作 delivery_id、消费 bump/prepare |
| `votc_campaign_id_a..d/bootstrap_kind/timeline_schema/save_snapshot_*` | 协议尾部（P6/P5）| init 尾巴携带，来信 logger 复用 |
| `votc_conversation_session_token/roster_revision/roster_capacity/session_active` | 会话名单 | 来信 logger 带 `\|0` 容错读取，不在会话期为 0 即可 |

事件命名空间占用：mod2 ce 现有 battle_report_event / mcc_event_v2 / message_event / votc_checkpoint_event / votc_silence_ck3_errors_event；本计划新增 votc_incoming_letter_event（与 bridge 命名空间二选一定名，保持单一）。

## 附录 B：明确延后项（防 scope creep）

| 延后项 | 归属 | 依赖原因 |
|---|---|---|
| Agency 投影注入来信（includeInIncomingLetters 开关及其 UI） | P4 | agency 子系统整体未移 |
| 来信喂给编年史观察（observeParsedGameDataForChronicle） | P2 | chronicle 包未移 |
| 时线导出 bundle 的 data/incoming-letters.json 成员 | P2 前置包 | TimelineExport* 家族未移 |
| letters.html 收件箱集成（把 incoming 记录混入 ConfigWindow 信件页列表） | 增强 E1 | MVP 展示面已是历史 tab + 游戏内弹窗；E1 牵涉 LetterManager Store 混排 |
| 其余 9 语 mod yml/app prompts 的真实翻译 | 收尾阶段 | 社区翻译债，回落机制兜底 |
| `on_scheme_discovered` 类型的 scheme_exposed 自然触发 | 与 mod1 保持一致：不注册 | 原因记录在 mod1 on_action 注释（root scope 不符）；run 脚本可手工触发验证 |

## 附录 C：1.x 侧对应测试与本计划的测试映射

- `timelineBusinessWire.test.ts:481`（incoming 请求键/post-bump 语义）→ 已随 P6 在 2CE，无需动作。
- `letterAgencyProjection.test.ts` → **不移植**（agency 剥离）。
- `letterHistoryCharacterSnapshots.test.ts:169`（buildIncomingLetterHistoryRecord T6）→ 移植条件：historyCharacterSnapshots 已在 2CE（P6 已迁），可直接移植。
- `incomingGreatProjectProtocolStatic.test.ts` → 移植 + MOD_ROOT 重定向。
- `letterSnapshotCorrelation.test.ts` 的 ClipboardListener 部分 → 形态参照新写 INCOMING 分支 payload 测试。
