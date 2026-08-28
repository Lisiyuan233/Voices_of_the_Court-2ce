import { formatMilitaryBrief } from '../../src/main/conversation/militaryBrief';
import type { MilitarySnapshot, WarInfo, ArmyInfo } from '../../src/shared/gameData/GameData';

function makeSnapshot(overrides: Partial<MilitarySnapshot> = {}): MilitarySnapshot {
    return {
        snapshotId: '1066.1.1',
        snapshotDate: '1066.1.1',
        wars: new Map<number, WarInfo>(),
        armies: [],
        attendees: [],
        events: [],
        complete: true,
        ...overrides
    };
}

function makeWar(overrides: Partial<WarInfo> = {}): WarInfo {
    return {
        id: 101,
        name: 'War of succession',
        startDate: '1066.1.1',
        playerSide: 'attacker',
        primaryAttacker: { id: 1001, name: 'Player' },
        primaryDefender: { id: 3001, name: 'Duke Enemy' },
        casusBelli: 'war_conquest',
        targetTitle: { id: 'e_france', name: 'France' },
        score: { total: 65, battles: 40, occupation: 25, imprisonment: 0, ticking: 0, perspective: 'attacker' },
        participants: [],
        armies: [],
        sieges: [],
        truncation: { total: 2, omitted: 0 },
        ...overrides
    };
}

function makeArmy(overrides: Partial<ArmyInfo> = {}): ArmyInfo {
    return {
        id: 51,
        owner: { id: 1001, name: 'Player' },
        side: 'attacker',
        isPlayerOwned: true,
        possibleWarAssociation: true,
        soldiers: 1000,
        maxSoldiers: 1200,
        levies: 700,
        menAtArms: 300,
        location: { id: 401, name: 'Paris' },
        state: { gathering: true, moving: false, embarked: false, retreating: false, inCombat: false, inSiege: false },
        regiments: [],
        ...overrides
    };
}

describe('formatMilitaryBrief', () => {
    it('returns empty string for missing, incomplete or war-less snapshots', () => {
        expect(formatMilitaryBrief(undefined)).toBe('');
        expect(formatMilitaryBrief(null)).toBe('');
        expect(formatMilitaryBrief(makeSnapshot({ complete: false }))).toBe('');
        expect(formatMilitaryBrief(makeSnapshot())).toBe('');
    });

    it('renders wars in English with advantage phrasing from the attacker perspective', () => {
        const brief = formatMilitaryBrief(makeSnapshot({
            wars: new Map([[101, makeWar()]])
        }), { lang: 'en' });

        expect(brief).toContain('Military situation snapshot: 1066.1.1');
        expect(brief).toContain('War #101: War of succession.');
        expect(brief).toContain('Our side is the attacker.');
        expect(brief).toContain('we hold a clear advantage');
        expect(brief).toContain('Occupation: some advantage');
        expect(brief).toContain('Target: France.');
        expect(brief).toContain('[Data limits:');
    });

    it('flips the advantage phrasing when the player is the defender', () => {
        const brief = formatMilitaryBrief(makeSnapshot({
            wars: new Map([[101, makeWar({ playerSide: 'defender' })]])
        }), { lang: 'en' });

        // score.total 65 attacker-perspective -> -65 for the defender
        expect(brief).toContain('we are at a clear disadvantage');
        expect(brief).toContain('Field battles: significant disadvantage');
    });

    it('renders the Chinese table for zh, including attendee role labels', () => {
        const snapshot = makeSnapshot({
            wars: new Map([[101, makeWar({
                participants: [{
                    character: { id: 3001, name: 'Duke Enemy' },
                    side: 'defender' as const,
                    militaryStrength: 4000
                }],
                sieges: [{
                    id: 7,
                    warId: 101,
                    location: { id: 402, name: 'Rouen' },
                    commander: { id: 3001, name: 'Duke Enemy' },
                    attackerMen: 900,
                    defenderMen: 250,
                    progress: 45
                }]
            })]]),
            armies: [makeArmy({
                commandSlot: 1,
                regiments: [{ typeName: 'men_at_arms', count: 200, max: 200, isMAA: true }]
            })],
            events: [{ date: '1066.1.10', type: 'war_started', payload: 'war' }],
            attendees: [{
                character: { id: 2002, name: 'Marshal' },
                roles: ['marshal'],
                commandSlots: [],
                canCommandPlayerArmies: true
            }]
        });

        const brief = formatMilitaryBrief(snapshot, { lang: 'zh' });
        expect(brief).toContain('[军事态势快照：1066.1.1');
        expect(brief).toContain('你方为进攻方');
        expect(brief).toContain('我方占明显优势');
        expect(brief).toContain('参战者：');
        expect(brief).toContain('Duke Enemy（守方），兵力 4000');
        expect(brief).toContain('围城（可能与多场战争有关');
        expect(brief).toContain('统帅 Duke Enemy');
        expect(brief).toContain('【玩家军队，slot 1】');
        expect(brief).toContain('兵团构成：men_at_arms 200/200');
        expect(brief).toContain('近期事件：');
        expect(brief).toContain('军事会议与会者：');
        expect(brief).toContain('Marshal（元帅，可被任命）');
        expect(brief).toContain('[数据限制：');
    });

    it('marks non-appointable attendees and unknown roles in English', () => {
        const brief = formatMilitaryBrief(makeSnapshot({
            wars: new Map([[101, makeWar()]]),
            attendees: [
                {
                    character: { id: 2004, name: 'Old Adviser' },
                    roles: ['war_leader_adviser'],
                    commandSlots: [],
                    canCommandPlayerArmies: false
                },
                {
                    character: { id: 2005, name: 'Mystery Guest' },
                    roles: ['some_unknown_role' as never],
                    commandSlots: [],
                    canCommandPlayerArmies: false
                }
            ]
        }), { lang: 'en' });

        expect(brief).toContain('Old Adviser (war adviser, not appointable)');
        // Role tokens the formatter does not know render as-is; parser-side
        // clamping to war_leader_adviser is covered by parseLogMilitary.test.ts
        expect(brief).toContain('Mystery Guest (some_unknown_role, not appointable)');
    });

    it('respects maxChars by dropping list lines that no longer fit', () => {
        const snapshot = makeSnapshot({
            wars: new Map([[101, makeWar({
                participants: Array.from({ length: 20 }, (_, i) => ({
                    character: { id: 4000 + i, name: `Commander ${i}` },
                    side: 'attacker' as const,
                    militaryStrength: 1000 + i
                }))
            })]]),
            armies: [makeArmy()]
        });

        const full = formatMilitaryBrief(snapshot, { lang: 'en' });
        const tight = formatMilitaryBrief(snapshot, { lang: 'en', maxChars: 400 });

        expect(full).toContain('Armies');
        expect(full).toContain('Commander 19');
        expect(tight.length).toBeLessThan(full.length);
        expect(tight).not.toContain('Regiments:');
        expect(tight).toContain('Commander 0');
    });
});
