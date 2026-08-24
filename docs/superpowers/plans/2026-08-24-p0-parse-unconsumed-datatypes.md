# P0 白得解析：消费 mod2 ce 已输出但未解析的数据类型 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 2CE 的 `parseLog.ts` 解析 mod 已经输出但被丢弃的 15 类 `VOTC:IN` 数据（stress/legitimacy/income/treasury/influence/herd/levies_*/maa/troops_eob/laws/persona_numbers/modifier/k_secret），落到 `Character` 新字段，并以带 token 上限的紧凑文本注入会话提示词。

**Architecture:** 全部改动集中在共享数据层（`src/shared/gameData/`）与三个标准描述脚本；`parseLog.ts` 的 switch 追加分支（纯增量，不动既有分支）；k_secret 用 pending 状态机（仿 relatives 模式）；渲染走 `Character.getExtendedFactsDescription()`（仿既有 `getRelativesDescription`），token 上限用 chars/4 估算截断（与 `calculateTokensFromText` 的 fallback 口径一致）。不新增 config 键（YAGNI，常量上限 600 tokens，后续需要再接 config）。

**Tech Stack:** TypeScript (strict, commonjs)、ts-jest + Jest 29（本阶段首次引入测试基建）、无新运行时依赖。

**规格来源:** `docs/superpowers/specs/2026-08-24-votc-full-alignment-design.md` §3/P0、§4.1。
**协议格式来源:** `voices_of_the_court_mod2 ce/common/scripted_effects/log_character_v2_effect.txt` 与 `log_modifiers_generated.txt`（下述字段顺序均已逐行核对）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `package.json` | Modify | 加 `test` 脚本与 jest devDeps |
| `jest.config.js` | Create | 测试配置（node 环境，ts-jest preset） |
| `tests/fixtures/debuglog_p0.txt` | Create | 覆盖全部新 dataType 的合成日志样本 |
| `tests/fixtures/debuglog_p0_fallbacks.txt` | Create | 边界样本（legitimacy=no、空 law 等） |
| `tests/unit/gameData/parseLogP0.test.ts` | Create | 解析断言 |
| `tests/unit/gameData/characterFacts.test.ts` | Create | 渲染/token 截断断言 |
| `src/shared/gameData/GameData.ts` | Modify | 新增 5 个导出 type |
| `src/shared/gameData/Character.ts` | Modify | 新增字段/初始化/fromPlainObject 兜底/渲染方法 |
| `src/shared/gameData/parseLog.ts` | Modify | switch 追加 15 分支 + 状态机 + 辅助函数 |
| `default_userdata/scripts/prompts/description/standard/pListMcc.js` | Modify | 注入 facts 块 |
| `default_userdata/scripts/prompts/description/standard/pListMcc2.js` | Modify | 同上 |
| `default_userdata/scripts/prompts/description/standard/pListMccZh.js` | Modify | 同上 |

注意：`default_userdata/scripts/prompts/description/standard/` 是应用拥有的默认脚本（每次启动会被重新复制覆盖用户目录同名文件），用户定制在 `custom/`，按仓库约定可以修改 standard。

---

### Task 0: 测试基建（jest + ts-jest）

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`
- Test: `tests/unit/gameData/infra.test.ts`

- [ ] **Step 1: 安装 devDependencies**（仅本项目内安装）

```bash
npm install --save-dev jest@^29 ts-jest@^29 @types/jest@^29
```

- [ ] **Step 2: 创建 `jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/unit/**/*.test.ts'],
    clearMocks: true,
};
```

- [ ] **Step 3: 在 `package.json` 的 `"scripts"` 中加入**

```json
"test": "jest"
```

- [ ] **Step 4: 写冒烟测试 `tests/unit/gameData/infra.test.ts`**

```ts
describe('jest infra', () => {
    it('compiles and runs TypeScript', () => {
        expect(1 + 1).toBe(2);
    });
});
```

- [ ] **Step 5: 运行验证**

Run: `npm test`
Expected: PASS（1 个测试套件，1 个测试通过）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json jest.config.js tests/unit/gameData/infra.test.ts
git commit -m "chore: 引入 jest/ts-jest 测试基建"
```

---

### Task 1: 合成日志 fixture

**Files:**
- Create: `tests/fixtures/debuglog_p0.txt`
- Create: `tests/fixtures/debuglog_p0_fallbacks.txt`

- [ ] **Step 1: 写主 fixture `tests/fixtures/debuglog_p0.txt`**

每行的字段顺序与 mod 发射端逐一对应（已核对 mod 脚本；行尾 `/;/` 怪癖也保留）：

```text
VOTC:IN/;/init/;/1000/;/Player One/;/2000/;/Duke AI/;/1187.01.01/;/talk_scene_council/;/Some County/;/Player One/;/123456/;/9
VOTC:IN/;/character/;/2000/;/Duke AI/;/Duke AI the Wise/;/Duchy of Somewhere/;/he/;/34/;/250/;/20/;/Heterosexual/;/ambitious, brave/;/10/;/1/;/King Bob/;/None/;/Frankish/;/Catholic/;/House de Somewhere/;/1/;/AI/;/Some County/;/King Bob/;/12/;/1/;/feudal/;/1/;/Councillor, Marshal/;/duchy
VOTC:IN/;/stress/;/2000/;/42/;/Stressed/;/30
VOTC:IN/;/legitimacy/;/2000/;/55/;/3/;/Feudal Legacy/;/40/;/35/;/50
VOTC:IN/;/income/;/2000/;/250/;/3.25/;/STARTMULTILINE#Gold from domains: 4.5#Taxes: -1.25#ENDMULTILINE
VOTC:IN/;/treasury/;/2000/;/500/;/STARTMULTILINE#Treasury: 500 gold#ENDMULTILINE
VOTC:IN/;/influence/;/2000/;/120/;/STARTMULTILINE#Influence: 120#ENDMULTILINE/;/
VOTC:IN/;/herd/;/2000/;/800/;/STARTMULTILINE#Herd breakdown here#ENDMULTILINE
VOTC:IN/;/levies_vassals/;/2000/;/1200
VOTC:IN/;/levies_dom/;/2000/;/400
VOTC:IN/;/levies_dom/;/2000/;/450
VOTC:IN/;/levies_theo/;/2000/;/100
VOTC:IN/;/maa/;/2000/;/Armored Footmen/;/1/;/120
VOTC:IN/;/maa/;/2000/;/Spearmen/;/0/;/80
VOTC:IN/;/troops_eob/;/2000/;
VOTC:IN/;/laws/;/2000/;/Crown Authority III
VOTC:IN/;/laws/;/2000/;/Male Preference Succession
VOTC:IN/;/laws/;/2000/;/High Tax
VOTC:IN/;/persona_numbers/;/2000/;/40/;/10/;/60/;/70/;/50/;/45/;/30/;/20/;/55
VOTC:IN/;/modifier/;/2000/;/mod_wounded/;/Wounded/;/This character is wounded and suffers penalties.
VOTC:IN/;/modifier/;/2000/;/mod_drunk/;/Drunk/;/This character is drunk.
VOTC:IN/;/k_secret/;/2000/;/Murdered Father/;/He murdered his father./;/Murder/;/secret_murder
VOTC:IN/;/k_secret_owner/;/2000/;/3000/;/Count Bad
VOTC:IN/;/k_secret_is_criminal/;/2000/;
VOTC:IN/;/k_secret_target/;/2000/;/3000/;/Count Bad
VOTC:IN/;/k_secret_spent/;/2000/;/no
VOTC:IN/;/k_secret_can_be_exposed/;/2000/;/yes
VOTC:IN/;/k_secret_knower/;/2000/;/Murdered Father/;/4000/;/Bishop Curious
VOTC:IN/;/k_secret_eob/;/2000/;
```

- [ ] **Step 2: 写边界 fixture `tests/fixtures/debuglog_p0_fallbacks.txt`**

```text
VOTC:IN/;/init/;/1000/;/Player One/;/2000/;/Duke AI/;/1187.01.01/;/talk_scene_council/;/Some County/;/Player One/;/123456/;/9
VOTC:IN/;/character/;/2000/;/Duke AI/;/Duke AI the Wise/;/Duchy of Somewhere/;/he/;/34/;/250/;/20/;/Heterosexual/;/ambitious, brave/;/10/;/1/;/King Bob/;/None/;/Frankish/;/Catholic/;/House de Somewhere/;/1/;/AI/;/Some County/;/King Bob/;/12/;/1/;/feudal/;/1/;/Councillor, Marshal/;/duchy
VOTC:IN/;/legitimacy/;/2000/;/no
VOTC:IN/;/laws/;/2000/;
VOTC:IN/;/troops_eob/;/2000/;
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/debuglog_p0.txt tests/fixtures/debuglog_p0_fallbacks.txt
git commit -m "test: 新增 P0 数据类型合成日志 fixture"
```

---

### Task 2: 标量状态组（stress / legitimacy / income / treasury / influence / herd）

**Files:**
- Modify: `src/shared/gameData/GameData.ts`
- Modify: `src/shared/gameData/Character.ts`
- Modify: `src/shared/gameData/parseLog.ts`
- Test: `tests/unit/gameData/parseLogP0.test.ts`

- [ ] **Step 1: 写失败测试（文件新建）`tests/unit/gameData/parseLogP0.test.ts`**

```ts
import { parseLog } from '../../../../src/shared/gameData/parseLog';
import path from 'path';

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'debuglog_p0.txt');
const FIXTURE_FB = path.join(__dirname, '..', '..', 'fixtures', 'debuglog_p0_fallbacks.txt');

async function aiChar(file: string) {
    const gd = await parseLog(file);
    expect(gd).toBeDefined();
    const ai = gd!.characters.get(2000)!;
    expect(ai).toBeDefined();
    return ai;
}

describe('P0 scalar state datatypes', () => {
    it('parses stress', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.stress).toEqual({ value: 42, level: 'Stressed', progress: 30 });
    });

    it('parses legitimacy with expectations', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.legitimacy).toEqual({
            value: 55, level: 3, type: 'Feudal Legacy',
            powerfulVassalExpectation: '40', vassalExpectation: '35', liegeExpectation: '50'
        });
    });

    it('handles legitimacy "no" fallback', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.legitimacy).toBeUndefined();
    });

    it('parses income with multiline breakdown', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.incomeGold).toBe(250);
        expect(ai.incomeBalance).toBeCloseTo(3.25);
        expect(ai.incomeBreakdown).toContain('Gold from domains: 4.5');
        expect(ai.incomeBreakdown).not.toContain('ENDMULTILINE');
    });

    it('parses treasury / influence / herd', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.treasuryAmount).toBe(500);
        expect(ai.treasuryTooltip).toContain('Treasury: 500 gold');
        expect(ai.influenceAmount).toBe(120);
        expect(ai.herdAmount).toBe(800);
        expect(ai.herdBreakdown).toBe('Herd breakdown here');
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parseLogP0`
Expected: FAIL（TS 编译错误：属性 `stress` 等不存在）

- [ ] **Step 3: 在 `GameData.ts` 的 `export type Relative = {...}` 之后追加类型**

```ts
export type StressInfo = {
    value: number;
    level: string;
    progress: number;
}

export type LegitimacyInfo = {
    value: number;
    level: number;
    type: string;
    powerfulVassalExpectation?: string;
    vassalExpectation?: string;
    liegeExpectation?: string;
}

export type MaaRegiment = {
    name: string;
    isPersonal: boolean;
    menAlive: number;
}

export type KnownSecret = {
    name: string;
    desc: string;
    category: string;
    type: string;
    ownerId?: number;
    ownerName?: string;
    targetId?: number;
    targetName?: string;
    isCriminal?: boolean;
    isShunned?: boolean;
    spent?: boolean;
    canBeExposed?: boolean;
    otherKnowers: { id: number; name: string }[];
}

export type CharacterModifier = {
    id: string;
    name: string;
    desc: string;
}

export type PersonaNumbers = {
    boldness: number; compassion: number; energy: number; greed: number; honor: number;
    rationality: number; sociability: number; vengefulness: number; zeal: number;
}
```

- [ ] **Step 4: 在 `Character.ts` 顶部扩展 import 并加字段**

import 行改为：

```ts
import {Memory, Trait, OpinionModifier, Secret, Relative, StressInfo, LegitimacyInfo, MaaRegiment, KnownSecret, CharacterModifier, PersonaNumbers} from "./GameData"
```

在 `birthTotalDays?: number;` 之后加：

```ts
    // --- P0 extended facts ---
    stress?: StressInfo;
    legitimacy?: LegitimacyInfo;
    incomeGold?: number;
    incomeBalance?: number;
    incomeBreakdown?: string;
    treasuryAmount?: number;
    treasuryTooltip?: string;
    influenceAmount?: number;
    influenceTooltip?: string;
    herdAmount?: number;
    herdBreakdown?: string;
```

- [ ] **Step 5: 在 `parseLog.ts` 顶部加辅助函数（放在 `removeTooltip` 之前）并加 switch 分支**

```ts
function extractMultilinePayload(element: string | undefined): string {
    if (!element) return "";
    const startIdx = element.indexOf('STARTMULTILINE');
    if (startIdx === -1) return element.trim();
    let payloadStart = startIdx + 'STARTMULTILINE'.length;
    if (element[payloadStart] === '#') payloadStart += 1;
    const endIdx = element.lastIndexOf('#ENDMULTILINE');
    const payloadEnd = endIdx === -1 ? element.length : endIdx;
    return element.slice(payloadStart, payloadEnd).trim();
}
```

在 switch 中 `case "init":` 之前插入：

```ts
                case "stress": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.stress = { value: Number(data[1]), level: data[2], progress: Number(data[3]) };
                    break;
                }
                case "legitimacy": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    if (data[1] === 'no') { c.legitimacy = undefined; break; }
                    c.legitimacy = {
                        value: Number(data[1]), level: Number(data[2]), type: data[3],
                        powerfulVassalExpectation: data[4], vassalExpectation: data[5], liegeExpectation: data[6]
                    };
                    break;
                }
                case "income": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.incomeGold = Number(data[1]);
                    c.incomeBalance = Number(data[2]);
                    c.incomeBreakdown = extractMultilinePayload(data[3]);
                    break;
                }
                case "treasury": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.treasuryAmount = Number(data[1]);
                    c.treasuryTooltip = extractMultilinePayload(data[2]);
                    break;
                }
                case "influence": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.influenceAmount = Number(data[1]);
                    c.influenceTooltip = extractMultilinePayload(data[2]);
                    break;
                }
                case "herd": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.herdAmount = Number(data[1]);
                    c.herdBreakdown = extractMultilinePayload(data[2]);
                    break;
                }
```

- [ ] **Step 6: 运行验证通过**

Run: `npm test -- parseLogP0`
Expected: PASS（5 个测试）

- [ ] **Step 7: Commit**

```bash
git add src/shared/gameData/GameData.ts src/shared/gameData/Character.ts src/shared/gameData/parseLog.ts tests/unit/gameData/parseLogP0.test.ts
git commit -m "feat: 解析 stress/legitimacy/income/treasury/influence/herd 数据类型"
```

---

### Task 3: 兵力组（levies_vassals / levies_dom / levies_theo / maa / troops_eob）

**Files:** 同 Task 2 的三个源文件 + 测试文件

- [ ] **Step 1: 追加失败测试到 `parseLogP0.test.ts`**

```ts
describe('P0 troops datatypes', () => {
    it('parses levies and sums multiple levies_dom lines', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.vassalLeviesTotal).toBe(1200);
        expect(ai.domainLevyHoldings).toEqual([400, 450]);
        expect(ai.getTotalDomainLevies()).toBe(850);
        expect(ai.theocraticLeaseLevies).toBe(100);
    });

    it('parses men-at-arms regiments', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.maaRegiments).toEqual([
            { name: 'Armored Footmen', isPersonal: true, menAlive: 120 },
            { name: 'Spearmen', isPersonal: false, menAlive: 80 },
        ]);
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parseLogP0`
Expected: FAIL（`vassalLeviesTotal` 等不存在）

- [ ] **Step 3: `Character.ts` 字段与方法**

字段区追加：

```ts
    vassalLeviesTotal?: number;
    domainLevyHoldings: number[];
    theocraticLeaseLevies?: number;
    maaRegiments: MaaRegiment[];
```

构造器初始化区（`this.relatives = [];` 旁）追加：

```ts
            this.domainLevyHoldings = [];
            this.maaRegiments = [];
```

类方法区（`getRelativesDescription` 之前）追加：

```ts
    /**
     * Sum of all domain holding levy sizes logged this snapshot.
     */
    getTotalDomainLevies(): number {
        return this.domainLevyHoldings.reduce((sum, n) => sum + n, 0);
    }
```

`fromPlainObject` 改为对缺失数组兜底（老存档反序列化安全）。本任务先写前两行，后续 Task 4/5/6 各自补入自己字段的兜底行：

```ts
    static fromPlainObject(obj: any): Character {
        const instance = new Character(new Array(27).fill(''));
        Object.assign(instance, obj);
        instance.domainLevyHoldings ??= [];
        instance.maaRegiments ??= [];
        return instance;
    }
```

- [ ] **Step 4: `parseLog.ts` 分支**

```ts
                case "levies_vassals": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.vassalLeviesTotal = Number(data[1]);
                    break;
                }
                case "levies_dom": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.domainLevyHoldings.push(Number(data[1]));
                    break;
                }
                case "levies_theo": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.theocraticLeaseLevies = Number(data[1]);
                    break;
                }
                case "maa": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.maaRegiments.push({
                        name: data[1],
                        isPersonal: data[2] === '1' || data[2]?.toLowerCase() === 'yes',
                        menAlive: Number(data[3])
                    });
                    break;
                }
                case "troops_eob":
                    break;
```

- [ ] **Step 5: 运行验证**

Run: `npm test -- parseLogP0`
Expected: PASS（7 个测试）

- [ ] **Step 6: Commit**

```bash
git add src/shared/gameData/Character.ts src/shared/gameData/parseLog.ts tests/unit/gameData/parseLogP0.test.ts
git commit -m "feat: 解析兵力数据类型（levies/maa）"
```

---

### Task 4: laws + persona_numbers

**Files:** 同上

- [ ] **Step 1: 失败测试**

```ts
describe('P0 laws & persona', () => {
    it('collects non-empty laws in emission order', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.laws).toEqual(['Crown Authority III', 'Male Preference Succession', 'High Tax']);
    });

    it('filters empty law placeholders in fallback fixture', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.laws).toEqual([]);
    });

    it('parses nine persona axes in fixed order', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.personaNumbers).toEqual({
            boldness: 40, compassion: 10, energy: 60, greed: 70, honor: 50,
            rationality: 45, sociability: 30, vengefulness: 20, zeal: 55
        });
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parseLogP0`
Expected: FAIL

- [ ] **Step 3: 实现**

`Character.ts` 字段：

```ts
    laws: string[];
    personaNumbers?: PersonaNumbers;
```

构造器初始化：`this.laws = [];`
`fromPlainObject` 补一行：`instance.laws ??= [];`

`parseLog.ts` 分支（`laws` 用发射端固定顺序的组名标注，便于渲染）：

```ts
                case "laws": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    const LAW_GROUP_ORDER = [
                        'realm authority', 'crown law', 'mandala laws', 'succession order',
                        'succession gender', 'elective succession', 'appointment succession',
                        'treasury budget military', 'treasury budget ministry', 'treasury budget salary'
                    ];
                    const name = (data[1] || '').trim();
                    if (!name || name === '-' || name === '—' || name.toLowerCase() === 'no') break;
                    if (c.laws.length < LAW_GROUP_ORDER.length) c.laws.push(name);
                    break;
                }
                case "persona_numbers": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.personaNumbers = {
                        boldness: Number(data[1]), compassion: Number(data[2]), energy: Number(data[3]),
                        greed: Number(data[4]), honor: Number(data[5]), rationality: Number(data[6]),
                        sociability: Number(data[7]), vengefulness: Number(data[8]), zeal: Number(data[9])
                    };
                    break;
                }
```

（`LAW_GROUP_ORDER` 当前仅作长度护栏；渲染阶段不需要组名。）

- [ ] **Step 4: 运行验证**

Run: `npm test -- parseLogP0`
Expected: PASS（10 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/shared/gameData/Character.ts src/shared/gameData/parseLog.ts tests/unit/gameData/parseLogP0.test.ts
git commit -m "feat: 解析法律与人格九轴数据类型"
```

---

### Task 5: modifier（含 60 条硬上限）

**Files:** 同上

- [ ] **Step 1: 失败测试**

```ts
describe('P0 modifiers', () => {
    it('parses modifier id/name/desc pairs', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.modifiers).toEqual([
            { id: 'mod_wounded', name: 'Wounded', desc: 'This character is wounded and suffers penalties.' },
            { id: 'mod_drunk', name: 'Drunk', desc: 'This character is drunk.' },
        ]);
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parseLogP0`
Expected: FAIL

- [ ] **Step 3: 实现**

`Character.ts`：`modifiers: CharacterModifier[];` + 构造器 `this.modifiers = [];` + `fromPlainObject` 补 `instance.modifiers ??= [];`

`parseLog.ts`（文件顶部常量区，`readLastRelevantBlock` 外层函数体内或模块级均可，选模块级）：

```ts
const MAX_MODIFIERS_PER_CHARACTER = 60;
```

分支：

```ts
                case "modifier": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    if (c.modifiers.length >= MAX_MODIFIERS_PER_CHARACTER) {
                        console.warn(`Character ${rootID} exceeded modifier cap (${MAX_MODIFIERS_PER_CHARACTER}); dropping "${data[1]}".`);
                        break;
                    }
                    c.modifiers.push({ id: data[1], name: data[2], desc: data[3] });
                    break;
                }
```

- [ ] **Step 4: 运行验证**

Run: `npm test -- parseLogP0`
Expected: PASS（11 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/shared/gameData/Character.ts src/shared/gameData/parseLog.ts tests/unit/gameData/parseLogP0.test.ts
git commit -m "feat: 解析角色修正(modifier)并设 60 条上限"
```

---

### Task 6: k_secret 已知秘密状态机

**Files:** 同上

- [ ] **Step 1: 失败测试**

```ts
describe('P0 known secrets', () => {
    it('assembles a full known-secret block until eob', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.knownSecrets).toHaveLength(1);
        const ks = ai.knownSecrets[0];
        expect(ks.name).toBe('Murdered Father');
        expect(ks.desc).toBe('He murdered his father.');
        expect(ks.category).toBe('Murder');
        expect(ks.type).toBe('secret_murder');
        expect(ks.ownerId).toBe(3000);
        expect(ks.ownerName).toBe('Count Bad');
        expect(ks.isCriminal).toBe(true);
        expect(ks.isShunned).toBeUndefined();
        expect(ks.targetId).toBe(3000);
        expect(ks.spent).toBe(false);
        expect(ks.canBeExposed).toBe(true);
        expect(ks.otherKnowers).toEqual([{ id: 4000, name: 'Bishop Curious' }]);
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parseLogP0`
Expected: FAIL

- [ ] **Step 3: 实现**

`Character.ts`：`knownSecrets: KnownSecret[];` + 构造器 `this.knownSecrets = [];` + `fromPlainObject` 补 `instance.knownSecrets ??= [];`

`parseLog.ts`：在 `const deferredRelations ...` 声明旁加待定容器：

```ts
    const pendingKnownSecrets = new Map<number, Partial<KnownSecret> & { otherKnowers: { id: number; name: string }[] }>();
```

分支：

```ts
                case "k_secret": {
                    if (!gameData) continue;
                    if (!gameData.characters.has(rootID)) break;
                    pendingKnownSecrets.set(rootID, {
                        name: data[1], desc: data[2], category: data[3], type: data[4],
                        otherKnowers: []
                    });
                    break;
                }
                case "k_secret_owner": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.ownerId = Number(data[1]); p.ownerName = data[2];
                    break;
                }
                case "k_secret_is_criminal": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.isCriminal = true;
                    break;
                }
                case "k_secret_is_shunned": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.isShunned = true;
                    break;
                }
                case "k_secret_target": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.targetId = Number(data[1]); p.targetName = data[2];
                    break;
                }
                case "k_secret_spent": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.spent = data[1] === 'yes';
                    break;
                }
                case "k_secret_can_be_exposed": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.canBeExposed = data[1] === 'yes';
                    break;
                }
                case "k_secret_knower": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.otherKnowers.push({ id: Number(data[2]), name: data[3] });
                    break;
                }
                case "k_secret_eob": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    const c = gameData?.characters.get(rootID);
                    if (c) {
                        c.knownSecrets.push({
                            name: p.name ?? "", desc: p.desc ?? "", category: p.category ?? "", type: p.type ?? "",
                            ownerId: p.ownerId, ownerName: p.ownerName,
                            targetId: p.targetId, targetName: p.targetName,
                            isCriminal: p.isCriminal, isShunned: p.isShunned,
                            spent: p.spent, canBeExposed: p.canBeExposed,
                            otherKnowers: p.otherKnowers
                        });
                    }
                    pendingKnownSecrets.delete(rootID);
                    break;
                }
```

同时把 `GameData` import 行补上 `KnownSecret`（若 Task 2 已整批导入则跳过）。

- [ ] **Step 4: 运行验证**

Run: `npm test -- parseLogP0`
Expected: PASS（12 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/shared/gameData/Character.ts src/shared/gameData/parseLog.ts tests/unit/gameData/parseLogP0.test.ts
git commit -m "feat: 解析已知秘密(k_secret)块状态机"
```

---

### Task 7: getExtendedFactsDescription 渲染 + token 上限

**Files:**
- Modify: `src/shared/gameData/Character.ts`
- Test: `tests/unit/gameData/characterFacts.test.ts`

- [ ] **Step 1: 失败测试（新建文件）**

```ts
import { Character } from '../../../../src/shared/gameData/Character';

function makeAi(): Character {
    const c = new Character(new Array(27).fill(''));
    c.id = 2000; c.shortName = 'Duke AI'; c.fullName = 'Duke AI the Wise';
    c.stress = { value: 42, level: 'Stressed', progress: 30 };
    c.legitimacy = { value: 55, level: 3, type: 'Feudal Legacy', powerfulVassalExpectation: '40', vassalExpectation: '35', liegeExpectation: '50' };
    c.incomeGold = 250; c.incomeBalance = 3.25; c.incomeBreakdown = 'Gold from domains: 4.5; Taxes: -1.25';
    c.treasuryAmount = 500; c.treasuryTooltip = 'Treasury: 500 gold';
    c.vassalLeviesTotal = 1200; c.domainLevyHoldings = [400, 450]; c.theocraticLeaseLevies = 100;
    c.maaRegiments = [{ name: 'Armored Footmen', isPersonal: true, menAlive: 120 }];
    c.laws = ['Crown Authority III', 'High Tax'];
    c.personaNumbers = { boldness: 40, compassion: 10, energy: 60, greed: 70, honor: 50, rationality: 45, sociability: 30, vengefulness: 20, zeal: 55 };
    c.knownSecrets = [{
        name: 'Murdered Father', desc: 'He murdered his father.', category: 'Murder', type: 'secret_murder',
        ownerId: 3000, ownerName: 'Count Bad', targetId: 3000, targetName: 'Count Bad',
        isCriminal: true, spent: false, canBeExposed: true, otherKnowers: [{ id: 4000, name: 'Bishop Curious' }]
    }];
    c.modifiers = [{ id: 'mod_wounded', name: 'Wounded', desc: 'This character is wounded.' }];
    return c;
}

describe('getExtendedFactsDescription', () => {
    it('renders all populated sections', () => {
        const text = makeAi().getExtendedFactsDescription();
        expect(text).toContain('Stress: 42 (Stressed, 30%)');
        expect(text).toContain('Legitimacy: 55');
        expect(text).toContain('powerful vassals expect 40');
        expect(text).toContain('monthly balance 3.25');
        expect(text).toContain('domain levies 850');   // 400+450 求和
        expect(text).toContain('Armored Footmen (personal, 120)');
        expect(text).toContain('Laws: Crown Authority III; High Tax');
        expect(text).toContain('boldness 40');
        expect(text).toContain('Known secrets:');
        expect(text).toContain('owned by Count Bad');
        expect(text).toContain('Notable modifiers: Wounded');
    });

    it('returns empty string when nothing is set', () => {
        const bare = new Character(new Array(27).fill(''));
        expect(bare.getExtendedFactsDescription()).toBe('');
    });

    it('respects token budget (chars/4 estimate)', () => {
        const c = makeAi();
        const text = c.getExtendedFactsDescription(20); // 极小预算
        expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(24); // 允许单节粒度误差
        expect(text.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- characterFacts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 在 `Character.ts` 的 `getRelativesDescription` 方法之后实现**

```ts
    /**
     * Compact, prompt-ready rendering of P0 extended facts.
     * Token budget uses the chars/4 heuristic (same as calculateTokensFromText fallback).
     * Sections are added in priority order; once the budget is hit, remaining sections are dropped.
     */
    getExtendedFactsDescription(maxTokens: number = 600): string {
        const trimText = (s: string | undefined, max = 240): string =>
            s && s.trim() ? s.trim().slice(0, max) : "";

        const sections: string[] = [];

        if (this.stress) {
            sections.push(`Stress: ${this.stress.value} (${this.stress.level}, ${this.stress.progress}%)`);
        }

        if (this.legitimacy) {
            const l = this.legitimacy;
            const expectations = [
                l.powerfulVassalExpectation && `powerful vassals expect ${l.powerfulVassalExpectation}`,
                l.vassalExpectation && `vassals expect ${l.vassalExpectation}`,
                l.liegeExpectation && `liege expects ${l.liegeExpectation}`
            ].filter(Boolean) as string[];
            sections.push(`Legitimacy: ${l.value} (level ${l.level}${l.type ? ', ' + l.type : ''})${expectations.length ? '; ' + expectations.join(', ') : ''}`);
        }

        const financeParts: string[] = [];
        if (this.incomeGold !== undefined || this.incomeBalance !== undefined) {
            financeParts.push(`gold ${this.incomeGold ?? '?'}, monthly balance ${this.incomeBalance ?? '?'}`);
        }
        const balanceDetail = trimText(this.incomeBreakdown);
        if (balanceDetail) financeParts.push(`balance detail: ${balanceDetail}`);
        if (this.treasuryAmount !== undefined) {
            const tt = trimText(this.treasuryTooltip, 120);
            financeParts.push(`treasury ${this.treasuryAmount}${tt ? ' (' + tt + ')' : ''}`);
        }
        if (this.influenceAmount !== undefined) financeParts.push(`influence ${this.influenceAmount}`);
        if (this.herdAmount !== undefined) {
            const hb = trimText(this.herdBreakdown, 120);
            financeParts.push(`herd ${this.herdAmount}${hb ? ' (' + hb + ')' : ''}`);
        }
        if (financeParts.length > 0) sections.push(`Finances: ${financeParts.join('; ')}`);

        const troopParts: string[] = [];
        if (this.vassalLeviesTotal !== undefined) troopParts.push(`vassal levies ${this.vassalLeviesTotal}`);
        if (this.domainLevyHoldings.length > 0) troopParts.push(`domain levies ${this.getTotalDomainLevies()}`);
        if (this.theocraticLeaseLevies !== undefined) troopParts.push(`theocratic lease ${this.theocraticLeaseLevies}`);
        if (this.maaRegiments.length > 0) {
            troopParts.push('men-at-arms: ' + this.maaRegiments.map(r => `${r.name} (${r.isPersonal ? 'personal' : 'non-personal'}, ${r.menAlive})`).join(', '));
        }
        if (troopParts.length > 0) sections.push(`Troops: ${troopParts.join('; ')}`);

        if (this.laws.length > 0) sections.push(`Laws: ${this.laws.join('; ')}`);

        if (this.personaNumbers) {
            const p = this.personaNumbers;
            sections.push(`Personality axes (0-100): boldness ${p.boldness}, compassion ${p.compassion}, energy ${p.energy}, greed ${p.greed}, honor ${p.honor}, rationality ${p.rationality}, sociability ${p.sociability}, vengefulness ${p.vengefulness}, zeal ${p.zeal}`);
        }

        if (this.knownSecrets.length > 0) {
            const secretLines = this.knownSecrets.map(ks => {
                const flags = [
                    ks.isCriminal ? 'criminal' : (ks.isShunned ? 'shunned' : ''),
                    ks.spent ? 'spent' : '',
                    ks.canBeExposed ? 'can be exposed' : ''
                ].filter(Boolean).join(', ');
                const who = [ks.targetId ? `targets ${ks.targetName ?? ks.targetId}` : '',
                             ks.ownerId ? `owned by ${ks.ownerName ?? ks.ownerId}` : ''].filter(Boolean).join(', ');
                const knowers = ks.otherKnowers.length > 0 ? `; also known by ${ks.otherKnowers.map(k => k.name).join(', ')}` : '';
                return `${ks.name}${who ? ' (' + who + ')' : ''}${flags ? ' [' + flags + ']' : ''}${knowers}`;
            });
            sections.push(`Known secrets: ${secretLines.join(' | ')}`);
        }

        if (this.modifiers.length > 0) {
            sections.push(`Notable modifiers: ${this.modifiers.map(m => m.name).join(', ')}`);
        }

        let output = "";
        let usedTokens = 0;
        for (const section of sections) {
            const cost = Math.ceil(section.length / 4) + 1; // +1 for newline
            if (usedTokens + cost > maxTokens) break;
            output += (output ? "\n" : "") + section;
            usedTokens += cost;
        }
        return output.trim();
    }
```

- [ ] **Step 4: 运行验证**

Run: `npm test -- characterFacts`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add src/shared/gameData/Character.ts tests/unit/gameData/characterFacts.test.ts
git commit -m "feat: Character.getExtendedFactsDescription 渲染与 token 预算"
```

---

### Task 8: 描述脚本接入 + 全量验收

**Files:**
- Modify: `default_userdata/scripts/prompts/description/standard/pListMcc.js`
- Modify: `default_userdata/scripts/prompts/description/standard/pListMcc2.js`
- Modify: `default_userdata/scripts/prompts/description/standard/pListMccZh.js`

- [ ] **Step 1: 三个文件同样处理 —— 在底部 `function relatives(char){...}` 之后添加兄弟函数**

```js
    function extendedFacts(char){
        if (typeof char.getExtendedFactsDescription === 'function') {
            return char.getExtendedFactsDescription() || null;
        }
        return null;
    }
```

- [ ] **Step 2: 在每个调用点后并列插入**

各文件的精确锚点（已核对行号，以内容为准）：
- `pListMcc.js`：第 105 行 `relatives(ai),` 后加 `extendedFacts(ai),`；第 139 行 `relatives(char),` 后加 `extendedFacts(char),`
- `pListMcc2.js`：第 83 行 `relatives(ai),` 后加 `extendedFacts(ai),`；第 117 行 `relatives(value),` 后加 `extendedFacts(value),`
- `pListMccZh.js`：第 101 行 `relatives(ai),` 后加 `extendedFacts(ai),`；第 135 行 `relatives(value),` 后加 `extendedFacts(value),`

（说明：facts 文本为英文键值风格；中文脚本中混排英文事实标签是本阶段接受的折衷，本地化包装留给后续阶段统一处理。）

- [ ] **Step 3: 全量构建 + 测试**

Run: `npm run build && npm test`
Expected: build 无错误；全部测试 PASS（infra 1 + parseLogP0 12 + characterFacts 3 = 16）

- [ ] **Step 4: 手工冒烟（可选但推荐）**

启动应用进游戏触发一次对话，检查聊天窗口场景描述/首条回复中出现 Stress/Legitimacy 等事实段落；或临时在 `main.ts` 对话开始处打印 `(gameData.characters.get(aiID) as any).getExtendedFactsDescription()` 观察输出后移除。

- [ ] **Step 5: Commit**

```bash
git add default_userdata/scripts/prompts/description/standard/pListMcc.js default_userdata/scripts/prompts/description/standard/pListMcc2.js default_userdata/scripts/prompts/description/standard/pListMccZh.js
git commit -m "feat: 标准描述脚本注入扩展角色事实(P0)"
```

---

## 已知边界（记录于代码注释即可，不阻塞验收）

1. `income/treasury/influence/herd` 的多行 breakdown 若被 CK3 以真实换行拆成多条物理日志行，只有第一行能被解析（现有 VOTC:IN 过滤会丢弃非 VOTC 行）——表现为细节缺失，不致错值。
2. `laws` 依赖发射端固定顺序做长度护栏；若未来 mod 增删法律组需同步此上限。
3. modifier 上限 60 条为提示词预算保护，超限丢弃并 warn。
