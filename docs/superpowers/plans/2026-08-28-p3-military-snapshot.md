# P3 军事快照 + 军事会议 迁移实施计划（mod1/1.x → mod2 ce/2CE）

> 日期：2026-08-28 · 上游：《VOTC_合并迁移方案.md》§P3 · 前置：P0/P6/P1/P2 已完成并提交
> 源探索记录：1.x 解析核心在 `Voices_of_the_Court1/src/shared/gameData/GameDataRecordAccumulator.ts`（非 parseLog）；2CE 侧 `GameData.ts` 的 MilitarySnapshot 类型簇与 `militarySnapshot` 字段已随类型迁移预先就位（:87-222, :356），但无任何解析/生产方。

## 0. 范围

- mod 侧：军事会议决议入口、名册构建 effect、战争/围城/军队快照导出、近期事件环形缓冲、3 个追踪 on_action、4 个 run 验证脚本。
- app 侧：parseLog 新增 10 个 dataType 分支、军事简报格式化器（en/zh）、对话提示词注入、战报提示词尾部快照注入。
- 明确不做（沿用 1.x 实态）：任命指挥官 action（`appointCommander.js`，1.x 已有但依赖 action 框架，随 P4 评估）；编年史/Agency 对快照的消费；战报专用军事 tag 扩展。

## 1. 源端核对结论（探索代理曾疑似的 army 行字段错位系误读）

逐一核对 `00a_votc_military_army_log_effects.txt` 源文后确认：mod1 的 army 行实际发射**两个**占位（`army/;/0/;/0/;/[ArmyId]/…`），与 1.x 累加器字段表（`data[1]`=unused、`data[2]`=id）及测试 fixture 完全一致，**无错位缺陷**。因此 2CE 契约与 1.x 逐字段 1:1，不引入任何偏离。唯一实质对齐点：mod1 兜底席位角色名 `court_adviser`/`vassal_adviser` 不在应用的 `MilitaryAttendeeRole` 联合类型内——mod 侧统一改发联合类型已有的 `war_leader_adviser`；解析端对未知角色名仍宽容处理。

## 2. 契约：dataType 字段序（`/;/` 切分，splice 后 data[0]=rootId 槽）

| dataType | 字段序（data[1] 起） |
|---|---|
| `military_snapshot` | snapshotId（=日期串）, snapshotDate, 版本(1)（多余字段忽略） |
| `war` | id, name, startDate, playerSide(attacker/defender), attackerId, attackerName, defenderId, defenderName, casusBelli, targetTitleId, targetTitleName, scoreTotal, scoreBattles, scoreOccupation, scoreImprisonment, scoreTicking（rootId 槽=warId 第一份拷贝，data[1]=id 第二份） |
| `war_participant` | warId, charId, name, side, militaryStrength |
| `army` | 占位0, armyId, ownerId, ownerName, commanderId, commanderName, side, isPlayerOwned('1'), soldiers, maxSoldiers, levies, 占位0, quality, locId, locName, supply, supplyChange, attrition, gathering, moving, embarked, retreating, inCombat(恒 no), inSiege, commandSlot, name, maxLevies, maxMAA, knights, gatheringDaysLeft, disembarkPenaltyDays, attritionPct（rootId 槽=0；menAtArms=soldiers−levies app 端推导） |
| `army_regiment` | typeName, count, max, isLevies, isMAA, isKnight, name（rootId 槽=0；app 端挂到最近一条 army=块级 lastArmyId） |
| `siege` | warId(第二份), siegeId, provinceId, provinceName, commanderId, commanderName, attackerMen, defenderMen, progress（rootId 槽=warId 第一份） |
| `war_event` | date, type, payload |
| `military_attendee` | name, role, commandSlot(数字或空), canCommand（rootId 槽=charId；同 charId 多行合并 roles） |
| `military_snapshot_complete` | （无字段，置 complete=true） |
| `war_truncation` | warId, total, omitted(1/0) |

发射端上限（mod，与 1.x 一致）：wars≤5、participants≤20/战争、sieges≤4、armies≤8、环形缓冲 5 槽、骑士≤10、名册总 cap 16（对齐 2CE `mcc_character_0..15` 槽位，1.x 为无限累加——此处收紧）。

## 3. mod 侧任务（`voices_of_the_court_mod2 ce/`，全部新增文件 UTF-8 BOM）

- **M1** `common/scripted_effects/votc_military_effects.txt`（新，整合 mod1 五个 effect 文件）：
  - `votc_record_military_event_effect`（{TYPE,PAYLOAD}，玩家身上 5 槽环形缓冲 `votc_military_event_N_{date,type,payload}`）
  - `votc_log_saved_player_army_effect`（army+army_regiment 发射；slot 变量由调用方管理）
  - `votc_log_player_armies_effect` / `votc_clear_military_army_slots` / `votc_log_military_events_effect`
  - `votc_log_military_snapshot_effect`（主发射器，快照 id=当前日期串）
  - `votc_build_military_council_roster_effect`（改写：填充 2CE 的根变量列表 `mcc_characters_selected`（元帅置顶，总 cap 16），不引入 mod1 的 `votc_conversation_characters_list`/`talk_second_scope`/肖像槽 effect——2CE 由 `log_gamedata_v3s` 的 `mcc_characters_list_v2`+`mcc_character_N` 机制原生处理）
- **M2** `events/votc_military_tracking_events.txt`（新）：`votc_military_tracking.0001/0002/0003`（war_started/siege_completed/war_join 写环形缓冲；root=player 判定沿用 mod1 的 scope:attacker/defender 归属检查）
- **M3** `common/on_action/votc_military_tracking_on_actions.txt`（新）：`on_war_started`/`on_siege_completion`/`on_join_war_as_secondary` 追加上述事件（与 incoming_letter 的同名 on_action 并列共存，CK3 多文件合并语义）
- **M4** 军事会议入口事件：`events/mcc_events_v2.txt` 追加 `mcc_event_v2.9100`——镜像 `mcc_event_v2.8999`（`desc = talk_event.9001.desc` + `event_window_widget_talk_v2` 剪贴板桥，无新增 clipboard loc），immediate：设 `talk_scene = flag:talk_scene_military_council` → `votc_init_checkpoint_effect` → `votc_build_military_council_roster_effect` → `scope:recipient`（=元帅）`log_gamedata_v3s` → 玩家 scope 发 `military_attendee` 行 + `votc_log_military_snapshot_effect`（顺序保证 init 行先于快照行）
- **M5** `common/decisions/votc_decisions.txt` 追加 `votc_military_council_decision`（player-only、`is_at_war = yes`、ai 0；设 talk_scene 后 trigger_event 9100）；loc：`talk_l_english.yml` + `talk_l_simp_chinese.yml` 四键（name/desc/tooltip/confirm）
- **M6** `run_test_scripts/`：移植 `votc_test_military_council.txt`（触发 9100）、`votc_test_military_roster.txt`、`votc_test_army_debug.txt`（army 行真实验证）；`votc_test_cleanup.txt` 已含军事变量清理，核对补齐 `votc_military_event_*`

## 4. app 侧任务（`Voices_of_the_Court2 ce/`）

- **A1** `src/shared/gameData/parseLog.ts`：按 §2 契约新增 10 个 case；块级状态 `lastArmyId`；`military_snapshot` 惰性建快照对象（含 init-less 容忍：无 init 时创建裸 GameData，供 A4 复用）；`military_snapshot_complete` 收口。GameData 侧类型已就位，仅当角色名缺失时以 `{id,name}` 桩建 Character
- **A2** `src/main/conversation/militaryBrief.ts`（新）：移植 1.x `militaryBrief.js` 的 `formatMilitaryBrief(snapshot, lang, {maxChars=12000})`——战争（含角色扮演优势换势、分项分数）、围城、军队（含玩家军队槽标注/兵团构成）、近期事件、与会者名单；内联 en/zh 双语表（LLM 提示词文本，不进 locales 文件），超限硬截断
- **A3** `src/main/conversation/promptBuilder.ts`：`buildChatPrompt` 在 description 注入点后追加军事简报 system 消息（门控 `militarySnapshot?.complete && wars.size>0`；快照仅在军事会议块中存在，天然场景门控）
- **A4** `src/main/battleReport/BattleReportGenerator.ts`：新增 `readLastMilitarySnapshotFromLog`（parseLog.ts 导出：尾扫 256KB 块定位最后一个 `military_snapshot…complete` 字节区间，经 snapshotRange 复用同一解析器），在 `buildBattleReportPrompt` 追加压缩版战区简报（maxChars 4000）；找不到/损坏则静默跳过
- **A5** `src/shared/gameData/GameData.ts`：`MilitaryAttendeeRole` 若缺 `war_leader_adviser` 补齐；无其他改动

## 5. 测试

- `tests/unit/gameData/parseLogMilitary.test.ts`：完整块 fixture（init→attendee→snapshot→war×2→participants→截断→army×2+regiments→siege→war_event→complete），断言 wars Map/军队 menAtArms 推导/regiment 归属 lastArmyId/attendee 合并/截断标记；另测 init-less 军事块单独可解析
- `tests/unit/militaryBrief.test.ts`：双语渲染、空快照返回空串、maxChars 截断、defender 视角优势翻转
- `tests/unit/militaryProtocolStatic.test.ts`（模板=incomingGreatProjectProtocolStatic）：mod effect 存在且括号平衡、决议/on_action 注册、run 脚本在位、mod 发射模板 ↔ app case 字段序正则互证、army 双占位契约双向钉死

## 6. 验证与交付

1. `npm run build` + `npm test` 全绿；mod 侧 `rg` 引用核对（effect 名、事件 id、loc key）
2. 分仓提交：mod 仓 `feat(military): port military council and war/siege/army snapshot exporters from mod1`；app 仓 `feat(military): parse military snapshot block, brief formatter and prompt injection`
3. 游戏内验证（需用户）：`run votc_test_military_council` 全链路、战时决议开会议、战报含战区简报；run 脚本复制到 CK3 run 目录
4. 已知风险：`can_be_commander_now_trigger` 等原版触发器跨版本可用性（1.19 对照原版文件核对）；military_council 场景 2CE 聊天窗口无专属背景（回落默认，不阻塞）
