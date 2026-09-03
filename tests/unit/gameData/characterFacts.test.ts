import { Character, EXTENDED_FACTS_SCENE_TOKEN_BUDGET, EXTENDED_FACTS_SCENE_BUDGET_EXHAUSTED_MARKER } from '../../../src/shared/gameData/Character';
import { GameData } from '../../../src/shared/gameData/GameData';

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

    it('omits non-finite numbers instead of rendering NaN', () => {
        const c = makeAi();
        c.stress = { value: NaN, level: 'Broken', progress: NaN };
        (c.personaNumbers as any).honor = NaN;
        const text = c.getExtendedFactsDescription();
        expect(text).not.toContain('NaN');
        expect(text).toContain('Stress'); // 其余节不受影响
    });

    it('omits legitimacy level when non-finite and renders stress without empty level', () => {
        const c = makeAi();
        c.stress = { value: 42, level: '', progress: NaN };
        c.legitimacy = { value: 55, level: NaN, type: 'Feudal Legacy' };
        const text = c.getExtendedFactsDescription();
        expect(text.split('\n')).toContain('Stress: 42');
        expect(text).toContain('Legitimacy: 55 (Feudal Legacy)');
        expect(text).not.toContain('level');
    });

    it('caps long list sections and reports overflow', () => {
        const c = makeAi();
        c.maaRegiments = Array.from({ length: 12 }, (_, i) => ({ name: `Reg ${i}`, isPersonal: false, menAlive: 10 }));
        let text = c.getExtendedFactsDescription();
        expect(text).toContain('Reg 7');
        expect(text).not.toContain('Reg 8');
        expect(text).toContain('+4 more');
        c.modifiers = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, name: `Mod ${i}`, desc: '' }));
        text = c.getExtendedFactsDescription();
        expect(text).toContain('+5 more');
        expect(text).not.toContain('Mod 20');
    });
});

describe('scene-wide extended facts budget', () => {
    const MARKER = EXTENDED_FACTS_SCENE_BUDGET_EXHAUSTED_MARKER;

    function makeGameData(): GameData {
        const data = new Array(10).fill('');
        data[0] = '1'; data[1] = 'Player'; data[2] = '2'; data[3] = 'AI'; data[4] = '1066.09.15';
        return new GameData(data);
    }

    // Facts heavy enough that one render approaches the 600-token per-character cap.
    function makeHeavyChar(id: number): Character {
        const c = new Character(new Array(27).fill(''));
        c.id = id;
        c.shortName = `Char ${id}`;
        c.fullName = `Character ${id}`;
        c.stress = { value: 42, level: 'Stressed', progress: 30 };
        c.laws = Array.from({ length: 20 }, (_, i) => `Crown Authority Level ${i} With A Rather Long Title For Testing`);
        c.maaRegiments = Array.from({ length: 12 }, (_, i) => ({ name: `Regiment ${i} of character ${id}`, isPersonal: true, menAlive: 100 + i }));
        c.modifiers = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, name: `Modifier ${i} of character ${id} with a fairly long descriptive name`, desc: '' }));
        c.personaNumbers = { boldness: 40, compassion: 10, energy: 60, greed: 70, honor: 50, rationality: 45, sociability: 30, vengefulness: 20, zeal: 55 };
        return c;
    }

    // Mirrors the renderer cost (chars/4 + 1 per section) so tests can account tokens exactly.
    function estimateTokens(text: string): number {
        if (!text) return 0;
        return text.split('\n').reduce((sum, line) => sum + Math.ceil(line.length / 4) + 1, 0);
    }

    function buildScene(charCount: number): { gameData: GameData; chars: Character[] } {
        const gameData = makeGameData();
        const chars: Character[] = [];
        for (let i = 0; i < charCount; i++) {
            const char = makeHeavyChar(100 + i);
            chars.push(char);
            gameData.addCharacter(char.id, char);
        }
        return { gameData, chars };
    }

    it('keeps cumulative rendering within the scene budget, preserves AI-first order, and marks the rest', () => {
        const { gameData, chars } = buildScene(12);
        // Description scripts render the AI first, then the other characters
        // in scene order; the budget is charged in exactly that call order.
        const outputs = chars.map(c => c.getExtendedFactsDescription());

        const nonMarker = outputs.filter(o => o !== MARKER);
        expect(nonMarker.length).toBeGreaterThan(1);
        const totalTokens = nonMarker.reduce((sum, text) => sum + estimateTokens(text), 0);
        expect(totalTokens).toBeLessThanOrEqual(EXTENDED_FACTS_SCENE_TOKEN_BUDGET);

        // AI（第一个调用）完整保留，且不超过单角色 600 上限。
        expect(outputs[0]).not.toContain('omitted');
        expect(estimateTokens(outputs[0])).toBeLessThanOrEqual(600);

        // 预算耗尽后出现省略标记，且后续角色全部整段省略。
        const firstMarkerIndex = outputs.indexOf(MARKER);
        expect(firstMarkerIndex).toBeGreaterThan(0);
        expect(outputs.slice(firstMarkerIndex)).toEqual(new Array(outputs.length - firstMarkerIndex).fill(MARKER));
        // 耗尽后预算正好归零，不会出现碎片式部分渲染。
        expect(gameData.extendedFactsSceneBudget.remainingTokens).toBe(0);
    });

    it('renders granted characters exactly like the plain per-character render', () => {
        const standalone = makeHeavyChar(100);
        const { chars } = buildScene(1);
        expect(chars[0].getExtendedFactsDescription()).toBe(standalone.getExtendedFactsDescription());
    });

    it('resets the budget per prompt build via resetExtendedFactsSceneBudget', () => {
        const { gameData, chars } = buildScene(12);
        chars.forEach(c => c.getExtendedFactsDescription());
        expect(chars[chars.length - 1].getExtendedFactsDescription()).toBe(MARKER);

        gameData.resetExtendedFactsSceneBudget();
        expect(gameData.extendedFactsSceneBudget.remainingTokens).toBe(EXTENDED_FACTS_SCENE_TOKEN_BUDGET);
        expect(chars[chars.length - 1].getExtendedFactsDescription()).not.toBe(MARKER);
    });

    it('a fresh GameData (re-parse) starts with a fresh budget', () => {
        const exhausted = buildScene(12);
        exhausted.chars.forEach(c => c.getExtendedFactsDescription());
        expect(exhausted.chars[0].getExtendedFactsDescription()).toBe(MARKER);

        const fresh = buildScene(2);
        const text = fresh.chars[0].getExtendedFactsDescription();
        expect(text).not.toBe(MARKER);
        expect(text).toContain('Stress: 42');
    });

    it('charges only what was rendered', () => {
        const { gameData, chars } = buildScene(3);
        const outputs = chars.map(c => c.getExtendedFactsDescription());
        expect(outputs.every(o => o !== MARKER)).toBe(true);
        const spent = EXTENDED_FACTS_SCENE_TOKEN_BUDGET - gameData.extendedFactsSceneBudget.remainingTokens;
        expect(spent).toBe(outputs.reduce((sum, text) => sum + estimateTokens(text), 0));
    });

    it('budget link is non-enumerable and a revived GameData hands out a fresh budget', () => {
        const { gameData, chars } = buildScene(1);
        expect(Object.keys(chars[0])).not.toContain('sceneFactsBudget');
        expect(JSON.stringify(chars[0])).not.toContain('remainingTokens');

        const plainChar = JSON.parse(JSON.stringify(chars[0]));
        const revived = GameData.fromPlainObject({ playerID: 1, aiID: 2, characters: { '100': plainChar } });
        const revivedChar = revived.getCharacterById(100);
        expect(revivedChar).toBeDefined();
        expect(revivedChar!.getExtendedFactsDescription()).toContain('Stress: 42');
        expect(revived.extendedFactsSceneBudget.remainingTokens).toBeLessThan(EXTENDED_FACTS_SCENE_TOKEN_BUDGET);
    });

    it('characters with no extended facts stay silent even under an exhausted budget', () => {
        const gameData = makeGameData();
        const bare = new Character(new Array(27).fill(''));
        bare.id = 100;
        gameData.addCharacter(bare.id, bare);
        gameData.extendedFactsSceneBudget.remainingTokens = 0;
        expect(bare.getExtendedFactsDescription()).toBe('');
    });
});
