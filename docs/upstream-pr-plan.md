# 上游 PR 任务总文档（2CE → szmania/Voices_of_the_Court）

> 创建：2026-09-19。用途：记录向 2CE 上游仓库开 PR 的全部事实基础、策略、已完成进度、
> 固定工作流与剩余任务。后续会话直接读本文件即可续作，无需重新调查。
> 本文件是内部工作文档，**不进入上游 PR**。

---

## 1. 仓库关系与关键事实（已验证）

| 项目 | 事实 |
|---|---|
| 上游 | https://github.com/szmania/Voices_of_the_Court （本身是 fork；网络源头 Demeter29，父 MrAndroPC） |
| 上游活跃度 | 2026-06-07 之后 298 个提交（126 文件 +19.3k/-4.7k）；接受外部 PR（#8、#14 先例） |
| 本地 fork | https://github.com/Lisiyuan233/Voices_of_the_Court-2ce （gh 账号 Lisiyuan233，ADMIN 权限） |
| 本地 remote | `origin` = Niancian1（已 404，**保留不动**）；`upstream` = szmania；`fork` = Lisiyuan233/Voices_of_the_Court-2ce |
| 真实内容分叉点 | **2026-06-07**：上游 `ff19e59b` ≡ 本地 `6fcf2635`（代码树完全一致） |
| 历史重写假象 | 本地 2164 提交中 2106 个与上游提交树哈希一一对应（SHA 不同）；git merge-base 误报为 2024-10-14，**不能信** |
| 本地独有工作 | 58 个提交（2026-07-09 → 09-12，P0–P6）+ 未提交的 letter delivery gate WIP |
| 行尾约定 | 上游 blob **100% CRLF**；本地重建线 **全 LF**。这是所有"整文件冲突"的根源 |
| 冲突面 | 两边都实质改过的文件共 **51 个**（已用"去 \r 比哈希"过滤纯行尾噪音；111/451 个本地文件是纯行尾改动） |

调查方法（树哈希法）：`git log --format="%T %h %cd"` 双方建树映射 → awk 交集 → 找最新匹配对。
merge-base 在历史重写场景下失效，一切以树哈希为准。

---

## 2026-09-20 维护者反馈后的路线修订（优先于下文旧快照）

- #15 的合并前置条件：完成旧对话、摘要/记忆、日记、信件历史兼容；不能把保证旧数据可用的必要工作全部推迟到 history PR。当前仍未完成，后续功能顺序不等于允许跳过兼容验收。
- Prompts 页旧 config.prompts 访问已修复并推送 #15：`917578862680131fd4938477a44886584d55a7c2`。统一由现有预设编辑器加载/保存，拒绝过时 prompt config-change 写入；这是上游基线同样可复现的问题。修复位于独立 worktree `F:/github/votc/pr15-prompts-fix`、分支 `codex/pr15-prompts-fix`；原 main 的 letter WIP 保留未动。
- 兼容验收使用升级前用户数据，覆盖重启、读旧档、战役/玩家隔离；保留原始数据与自定义项。旧记录归属不明确时保留并提供显式恢复/导入路径，禁止静默丢弃或混入另一战役。
- 配套 mod 按功能向 https://github.com/szmania/voices_of_the_court_mod 拆 PR：P0/P6 协议与升级兼容 → 来信/投递 → 编年史 → 军事快照 → 存档快照 → 战报（军事之后）→ 剩余历史/日记接线。尚未开出这些 mod PR。
- 每个跨仓库功能互链 app/mod PR，标明配对版本，提供限定范围的测试包。现有全量开发 mod 包不能直接作为单个 mod PR 的范围。
- 对外英文路线图见 docs/upstream-pr-roadmap.en.md；原路线图评论、兼容性评论和 PR 描述均已同步更新。修复说明：https://github.com/szmania/Voices_of_the_Court/pull/15#issuecomment-5749361775 。
- 本轮验证：完整 TypeScript build 通过（独立验证目录补充 adm-zip/types，使用 `npm run build -- --project F:/github/votc/pr15-validation-deps/tsconfig.validation.json`）；4 个 Node/jsdom 场景通过；全量 Jest 555 PASS / 1 既有断言失败，另 21 个加载失败，失败集合与基线 `57716b6f` 完全一致。旧数据兼容和 CK3 升级验收仍待后续完成。

## 2. 总体策略

1. **不做整史合并/cherry-pick 历史**：从 `upstream/main`（或已合并的功能分支）新开分支，按功能 cherry-pick 本地 58 提交中的对应区间。
2. **绝对不进 PR 的东西**：
   - LF 规范化提交 `4973f9aa`（chore: normalize line endings to LF）和 `ed6ff627`（.gitattributes/.editorconfig）；
   - 内部计划文档 `docs/superpowers/plans/*`（误入时用 filter-branch 剥离）；
   - 引入 jest 基建的提交 `ad722064`（上游已有更新的 jest 30 + ts-jest 体系）；
   - 读仓库外 CK3 mod 目录的跨仓库契约测试（`timelineProtocolStatic.test.ts`，上游跑不了）。
3. **行尾纪律**：合并结果必须整体 CRLF（`sed 's/$/\r/'`）；上游未改行字节级不动；新增文件保持 LF 可接受（已在 PR #15 实践）。
4. **语义对齐原则**：上游的重构（方法改名、参数新增、模块抽取）一律保留，本地功能作为增量叠加；上游现有行为（如 `mcc_event_v2.9002/9003` 触发）不被替换，只做超集扩展。
5. **基线对比验证**：上游 main 自带红色测试（21 个套件加载失败 + 1 个 token 计数断言失败）。
   每个分支必须证明失败集合与纯净 `upstream/main` 基线**完全一致**，才算零回归。

---

## 3. PR 拆分清单与状态

依赖顺序（用户定稿）：**P0 → P6 → P1 → P2 → P3 → P5 → history**（来信依赖时间线）。

| # | PR | 状态 | 分支 / 链接 | 来源提交 |
|---|---|---|---|---|
| 1 | P0 gameData 解析 + P6 timeline v2 | ✅ **已开 PR** | `feat/p6-timeline-v2` → [szmania#15](https://github.com/szmania/Voices_of_the_Court/pull/15)（27 提交，含 `feat/p0-parse-datatypes` 备份分支） | 见 §5.1/§5.2 |
| 2 | P1 incoming letters | ⬜ 待做（等 #15 合并后出分支） | — | `d440f55c` `626fab83` `42ea479f` `08f67c27` `da1d60d6`（`75cdf5d8` docs 排除） |
| 3 | delivery gate 增量 | ⬜ P1 之后 | 本地 main 未提交 WIP：`letterDeliveryGate.ts` + 8 个修改文件 + 7 个测试 | （无 SHA，工作区） |
| 4 | P2 chronicle | ⬜ | — | `61f8816d` `04188f46` `66fa4645`（`cc305bc3` docs 排除） |
| 5 | P3 military snapshot | ⬜ | — | `0732653c` |
| 6 | P5 save-facts | ⬜ 可拆两个（Rust sidecar 零冲突先行） | — | `20e16c88`（含 `tools/votc-save-facts` 全新 Rust 项目） |
| 7 | **battle report 战报** | ⬜ **独立 PR（排在 P3 之后）**。注意：`src/main/battleReport/` 目录已随 `f3a8c166` 进入 PR #15 但**完全未接线**（main.ts 零引用、encoder=null，PR 描述已声明）；本 PR 的内容 = `90b97eef`（战报提示+建议 prompt 修复、12 语言 prompts、battleReport.html+renderer）+ main.ts 接线（本地 main 有 8 处引用：on_war_started 中继、快照挂接）+ settings.html 导航项 + `0732653c` 剩余适配（其 25 行 BattleReportGenerator 增量若与 P3 重叠则随 P3 先走）。encoder 从 null 换成真实 `tiktokenEncoder`。 | — | `90b97eef`（主体）+ `0732653c` 残余 |
| 8 | history/checkpoint + 7 月存档日记 | ⬜ | — | `90b97eef` 之外的 `b4f4985f` `d14cab00`（7 月）+ `5aeae316`（BOM run 脚本，可独立小 PR） |
| 9 | 评审修复 | ⬜ 随各功能 PR 分摊 | — | `4ba746dc` `bff1ef49` `b042a71b` `3d71d687` `491e7b60` `5c1a06f0` `1f6fabcd` |

### PR #15 已做的范围收缩（后续 PR 要接手）

- `9e17f3a3` 中 `Conversation.loadHistory/_saveHistoryToFile` 的 campaign 目录路由重写被丢弃（取 ours），
  依赖本地线整体历史重构，与上游结构不可缝合 → history PR 的候选内容。
- `BattleReportGenerator.ts`（随 `f3a8c166` 进入）未接线：`ApiConnection` encoder 传 `null`，
  `complete()` 返回 `MessageChunk|string` 已做归一 → battle-report PR 接线。
- `Summary` 接口新增可选字段 `votcCheckpointEpoch` / `votcTimelineNodeId`（v2 协议面）。

---

## 4. 各 PR 预期冲突面（51 文件冲突面的功能归属）

高危区（上游同期也在重构）：
- `src/main/conversation/*`（Conversation.ts、promptBuilder、checkActions、sceneDescriptionBuilder、suggestionBuilder）——上游 memory compaction 大改；
- `src/main/main.ts`（上游 2610 行 vs 本地 3274 行）；
- `src/main/summaryManager.ts`、`src/main/conversationHistory.ts`；
- `src/shared/gameData/parseLog.ts`（上游 543 行 vs 本地 1030 行）；
- `src/main/letter/*` 上游同名旧版（LetterManager 488 vs 本地 1009）。

低危区（上游基本没有，PR 主体为纯新增）：
- `src/main/chronicle/`、`src/main/saveFacts/`、`src/main/history/`、`src/main/battleReport/`、
  `tools/votc-save-facts/`、`agency/`、`campaign*`、`promptWorkbench/`、`timeline*`（f3a8c166 引入的全套）。

i18n / prompts：`public/locales/*.json` ×12、`default_userdata/configs/prompts/*.json` ×12 —— 每个功能 PR 都可能碰到，逐 key 叠加，保留上游行尾。

P1（letters）具体预期：letter 4 个上游同名文件（Letter.ts / LetterManager.ts / LetterReplyGenerator.ts / parseLogForLetters.ts）
+ main.ts 钩子 + locales + incomingLetterPrompt 配置端到端（626fab83）。

---

## 5. 固定工作流（SOP）

### 5.1 分支准备

```bash
cd "F:\github\votc\Voices_of_the_Court2 ce"
git stash push -m "letter WIP during PR work"        # 保住未提交 WIP（untracked 文件自然留在原地）
git checkout -b feat/pX-xxx upstream/main            # 或已合并功能分支
npm install --no-audit --no-fund --quiet             # 上游 lock 与 package.json 不同步，npm ci 不可用！
git checkout HEAD -- package-lock.json package.json  # npm install 会重写 lockfile，必须还原
```

### 5.2 cherry-pick + 自动冲突解决（配方脚本 /tmp/p0resolve.sh）

```bash
git cherry-pick <SHA...>        # 显式列出（区间会带上要排除的 docs/测试提交）
bash /tmp/p0resolve.sh          # 循环：对每个未合并文件做 LF 空间三方合并 → CRLF 还原 → add → continue
```

脚本核心逻辑（已验证）：
1. `git show "$c^:$f"`（base，LF）/ `git show "$c:$f"`（theirs，LF）；
2. `git checkout --ours "$f"` 后 `tr -d '\r'` 得 ours-LF；
3. `git merge-file` 在 LF 空间合并；
4. 无冲突 → `sed 's/$/\r/'` 写回（上游未改行字节级保真）+ `git add`；有冲突 → 停下人工处理。

人工解决时的既有工具：
- **整块取 theirs/ours**：`awk '/^<<<<<<< upstream$/{skip=1;next} /^=======$/{keep=1;next} /^>>>>>>> p0$/{skip=0;keep=0;next} skip&&!keep{next} {print}'`
- **外科手术**：python 处理（注意 `cygpath -w /tmp`，且文件是 CRLF，先 `replace('\r\n','\n')` 归一）；
- **按行号区段拼接**（两套算法不可缝合时）：从 theirs 取完整函数区段替换 merged 同区域。

### 5.3 验证

```bash
npm run build                                    # tsc，须零错误
npx jest $(git ls-tree -r HEAD --name-only | grep -E "^tests/.*\.test\.(ts|js)$" | tr '\n' ' ') --runInBand
```

基线对比协议（必做）：
1. `git checkout -q upstream/main`，跑同一测试清单，存失败集合；
2. 切回功能分支跑同一清单；
3. `diff` 两个集合 —— **必须完全一致**（分支只允许新增 PASS 套件）。
   已知基线：21 个套件加载失败（compaction 系、votc146、main.test、simple 等）+ compactionCrossLanguage 的 token 计数断言失败。

### 5.4 收尾

```bash
git checkout -q main && git stash pop            # 恢复 WIP
npm install --no-audit --no-fund --quiet         # node_modules 切回 main 依赖树
git status --short package-lock.json package.json  # 确认 lockfile 未被污染
git push -u fork feat/pX-xxx
gh pr create --repo szmania/Voices_of_the_Court --head Lisiyuan233:feat/pX-xxx --base main --title "..." --body "..."
```

PR 描述用英文；必须写明：验证方式、基线对比结论、mod 侧/跨仓库内容的排除说明、范围收缩点。

### 5.5 教训清单（踩过的坑）

1. **diff3 会"吃行"**：双方在同一函数区重构时，diff3 可能把 theirs 侧的赋值行（如
   `nextCheckpointEpoch`）静默丢掉、或把双方续行都保留造成重复块 —— 合并后必须
   `npm run build` + 通读缝合区。
2. **冲突块数量要用 grep 数**，不要相信 `head` 截断的输出（曾漏掉第 4 个块导致标记文件被提交；
   用 `git commit --amend` + 重置修复过一次）。
3. **`grep -c` 计数为 0 时返回码 1**，会打断 `&&` 链 —— 验证类 grep 后不要直接接关键动作。
4. **python 看不到 Git Bash 的 /tmp**，要 `cygpath -w`；写文件前所有 assert 先跑完，失败绝不落盘。
5. **filter-branch 前必须无未暂存改动**（`git status` 里连 ` D` 都不行）；内部文档/测试剥离用
   `--index-filter "git rm --cached --ignore-unmatch -q '<path>'" --prune-empty`。
6. `npm ci` 在上游 lock 上必然失败（upstream 自己的 lock 不同步）；`npm install` 必做但必须还原 lockfile。
7. git 的 `--name-only`/`--quiet` 对 blob 级变更敏感、对文本级无感知；判断真实改动用"去 \r 比哈希"。

---

## 6. 当前状态快照（2026-09-19，评审修复后）

- PR #15 已开并完成**三轮本地 GPT 预审修复**：
  - 第一轮（4 项：玩家切换清空 / 注册表双重 votc_data / timeline 脚本接投递链 / 历史读写同步）→ `c013321f`。
  - 第二轮（4 项：延迟投递时间线倒退 / POSIX+UNC 路径破坏 / 重启丢脚本 / 战役历史串味）→ `cc350f18`。
  - 第三轮（3 项：注册表 max-epoch 不代表当前分支 / 兜底脚本到不了游戏 / 聊天历史误用提示词上限）→ `efd2c553`：
    ①投递校验从"注册表 max epoch"改为"注册表**最后提交的节点 head**"（每个 checkpoint bump 都是一次
    transition 提交，最新 createdAt 的节点即当前分支头；按 createdAt 平局时比 nodeId）——同 epoch 兄弟
    分支不再被覆盖、废弃高 epoch 分支不再误伤当前分支，Letter 新增 `timelineNodeId`；②生成失败时兜底块
    额外写入 CK3 `run/letters.txt`（新 `LetterManager.deliverLetterFallback`），app-data 的 letterN.txt
    保留为诊断副本——否则信件线程在存档里悬空；③`loadHistory` 改用 `maxConversationsInHistoryWindow`
    加载（窗口 15），提示词侧由既有的 `withLimitedHistory()` 切到 `maxHistoricalConversations`（5）。
- 实机测试材料已发布（2026-09-19）：配套 mod 打包为
  [pr15-mod-test-1 Release](https://github.com/Lisiyuan233/Voices_of_the_Court-2ce/releases/tag/pr15-mod-test-1)
  （`package_mod.py package` 产物 + 未提交的 R6 province-scope 修复），PR 评论附英文安装/测试清单
  （已扩为时间线全量验收版）：
  [PR#15 评论](https://github.com/szmania/Voices_of_the_Court/pull/15#issuecomment-5741869712)。
  mod 仓库 `events/votc_incoming_letter_events.txt` 的该修复仍未提交（属 mod 仓库待办）。
- **实机验收清单（完整版，中文对照）**——逐条均给出可观察断言：
  1. 回信投递：artifact 收到、`letters.txt` 被 LETTER_ACCEPTED 回执清空、线程不悬挂。
  2. 延迟投递不倒退：挂起期间推进对话，投递后 `letters.txt` 不含发送时节点/epoch，app 日志有 skip 警告，信件本体送达。
  3. 失败兜底 + 回执：LLM 失败 → `letters.txt` 收到兜底块 → ~2s 内 runner 执行（fallback 弹窗 + 线程变量清除）
     → `debug.log` 出现 `VOTC:FALLBACK/;/applied` → `letters.txt` 自动清空、无刷屏。
  4. **对话关闭转换**：关闭对话 → app 控制台 `Timeline node created: <a-b> (parent: ...)`；`debug.log` 出现
     `VOTC:CHECKPOINT/;/set/;/<charId>/;/<epoch>/;/<nodeA>/;/<nodeB>/;/<parentA>/;/<parentB>`；CK3 `run/votc.txt`
     瞬时含 `global_var:talk_first_scope = { set_variable ... }` + `mcc_event_v2.9002/9003`（~800ms 后清除）；
     再次关闭 epoch 递增且节点链到上一个。
  5. **读档续链**：关闭对话 → 存档 → 再关闭一次（epoch 前进）→ 读回旧档 → 再关闭：新节点应链到**所读存档**
     的节点（废弃后段的兄弟分支）、epoch 从所读存档续起、无注册表损坏报告——即第三轮节点头校验的实机对应。
  6. 历史窗口 15 条 / 提示词 5 条（`withLimitedHistory` 切片）。
  7. **P0 扩展事实**：会话期间 `debug.log` 出现新数据类型（`stress`/`legitimacy`/`income`/`laws`/`modifier`/
     `k_secret` 等）且解析无错误；携带此类数据的角色在提示词中出现扩展事实段（`pListMcc*.js` 注入），
     LLM 能在对话中引用压力/法律/已知秘密。
  - 范围外：BattleReportGenerator 未接线不入验收；incoming letter 的**生成**（P1）不在本 PR；
    摘要/日记的 epoch 穿线推迟到 history PR。
- 回归测试累计 15 项全部入库（见第四轮条目），全部通过。
  - 第四轮（3 项：兜底无回执导致 letters.txt 每 2s 重跑刷屏 / 单通道覆盖 / saveLetterHistory 失败绕过兜底）
    → `06e00936`：①兜底块 if/else 两分支都打 `VOTC:FALLBACK/;/applied|skipped` 回执（前缀**刻意避开
    VOTC:LETTER 子串**——parseLogForLetters 会把任何 VOTC:LETTER 行当信件导入，旧 run_skipped 行有被
    当假信重新导入的风险），`processLogLine` 尾随到回执即 `clearLettersFile`，轮询停止；同时旧
    run_skipped 行改用新前缀 + 导入解析器显式跳过 run_skipped；②单通道覆盖限制**接受并文档化**
    （deliverLetter/deliverLetterFallback 均有 single-channel 注释，按槽位分文件需 mod 侧改造）；
    ③`saveLetterHistory` 返回 null 也接入兜底（persist 失败不再悬挂线程）。四轮回归测试 15 项全入库
    （pr15Review/Second/Third/Fourth），15/15 通过。
  - 经验：deliverLetter 无法从调用方拿到当前快照（测试直接调用），持久化注册表的"最后提交节点"是
    当前分支头的可靠代理；`Letter` 的 timeline 载荷字段（script/epoch/nodeId/campaignId/playerId）
    必须在 saveLetterHistory 内随 JSON 持久化并在返回对象上再赋值（兼容 mock 与重启水合两条路）。
    补丁脚本里凡是含 `\t`、`\\\\` 等 JS 转义序列的锚点，python 字符串必须再翻倍转义——四次翻车后
    的定式：**锚点先用 repr 验证文件字节，能索引切片就不要全串匹配**。
- 关键教训新增：`campaignRootOf` 的正则修复两次被 bash/python 转义层吃掉反斜杠（`\\\\/`→`\/`），
  **写含反斜杠正则的补丁必须用 Write 工具落盘脚本**，heredoc/`-c` 转义不可靠。
- 本地 main：领先 origin/main 2 个提交（`5c1a06f0`、`1f6fabcd`）；letter delivery gate WIP 已恢复到工作区（未提交）。
- node_modules 已切回 main 依赖树；lockfile 干净。
- `feat/p0-parse-datatypes` 已推送 fork 作为备份。
- 暂存/恢复循环已全部完成，无遗留 stash。
- 评审者复现测试副本在 `F:\github\votc\review-pr15\`（其 build 失败仅因其 node_modules 缺 adm-zip，非分支问题）。

## 7. 待办（按优先级）

1. 修复 Prompts 页报错，并在 #15 合并前完成旧数据兼容与升级验收（见顶部修订）；同步拆出配套 mod PR。以上完成且 #15 合并后 `git fetch upstream && git checkout -b feat/p1-incoming-letters upstream/main`。
2. P1 letters：cherry-pick §3 表中 5 个提交 + delivery gate WIP 作为增量提交；
   冲突点 = letter 4 同名文件 + main.ts + locales/prompts。
3. P2 chronicle（低危，纯新增为主）→ P3 military → P5 save-facts（Rust sidecar 可先行，零冲突）。
4. history/checkpoint PR：7 月提交（`b4f4985f` `d14cab00`）+ 9e17f3a3 被丢弃的 campaign 路由 + `5aeae316`（BOM，可拆独立小 PR）。
5. battle report PR：见 §3 表第 7 项——`90b97eef` 主体 + main.ts 接线（on_war_started 中继）+ configWindow 页面/导航 + encoder 接真实值；排在 P3 military 之后（共享 BattleReportGenerator 类型面）。实机验收时 war 触发一条战报、`battleReportRunScript` 写 run 文件、游戏内收到战报事件。
6. 每个 PR 合并后：后续分支基于新的 upstream/main 重出（fork 上的旧分支保留作历史）。
