import { GameData } from '../../../src/shared/gameData/GameData';
import type { MilitarySnapshot, WarInfo } from '../../../src/shared/gameData/GameData';
import { Character } from '../../../src/shared/gameData/Character';
import {
    applySaveFactAuthority,
    FACT_CONFLICT_LIVE,
    FACT_SOURCE_REJECTED
} from '../../../src/main/saveFacts/SaveFactAuthorityResolver';
import type { GameFact } from '../../../src/main/saveFacts/saveFactTypes';

const INIT_BASE = ['1001', 'Player', '2002', 'AI', '1066.1.1', 'scene:test', 'Location', 'Controller', '1', '11', '22', '5', '6', '42', '0'];

function makeCharacter(
    id: number,
    overrides: { fullName?: string; primaryTitle?: string; liege?: string; consort?: string } = {}
): Character {
    const data: string[] = new Array(27).fill('');
    data[0] = String(id);
    data[1] = overrides.fullName ?? `Short${id}`;
    data[2] = overrides.fullName ?? `Full Name ${id}`;
    data[3] = overrides.primaryTitle ?? '';
    data[12] = overrides.liege ?? '';
    data[13] = overrides.consort ?? '';
    return new Character(data);
}

function makeGameData(characters: Character[]): GameData {
    const gameData = new GameData([...INIT_BASE]);
    for (const character of characters) {
        gameData.characters.set(character.id, character);
    }
    return gameData;
}

function makeFact(overrides: Partial<GameFact> = {}): GameFact {
    return {
        id: 'fact-1',
        category: 'family',
        subject: { type: 'character', id: '1001' },
        predicate: 'character.spouse',
        object: { type: 'character', id: '2002', displayName: 'Save Alice' },
        asOfGameDate: { numeric: 402123, display: '1100.1.1' },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'omniscient_internal',
        priority: 10,
        sensitivity: 'normal',
        provenance: {},
        ...overrides
    };
}

function makeWar(overrides: Partial<WarInfo> = {}): WarInfo {
    return {
        id: 7001,
        name: 'Live Northern War',
        playerSide: 'attacker',
        primaryAttacker: { id: 1001, name: 'Live Player' },
        primaryDefender: { id: 2002, name: 'Live Defender' },
        score: { total: 60, perspective: 'attacker' },
        participants: [
            { character: { id: 1001, name: 'Live Player' }, side: 'attacker' },
            { character: { id: 2002, name: 'Live Defender' }, side: 'defender' }
        ],
        armies: [],
        sieges: [],
        truncation: { total: 2, omitted: 0 },
        ...overrides
    };
}

function attachMilitarySnapshot(
    gameData: GameData,
    war: WarInfo = makeWar(),
    complete = true
): GameData {
    const snapshot: MilitarySnapshot = {
        snapshotId: 'live-military-1',
        snapshotDate: '1100.1.1',
        wars: new Map([[war.id, war]]),
        armies: [],
        attendees: [],
        events: [],
        complete
    };
    gameData.militarySnapshot = snapshot;
    return gameData;
}

function makeWarFact(overrides: Partial<GameFact> = {}): GameFact {
    return makeFact({
        id: 'fact-war',
        category: 'war',
        subject: { type: 'character', id: '1001' },
        predicate: 'character.at_war',
        object: { type: 'war', id: '7001', displayName: 'Save Northern War' },
        sourcePath: 'character_at_war',
        sensitivity: 'political',
        ...overrides
    });
}

describe('applySaveFactAuthority', () => {
    it('applies live fullName to both ends of a fact (GameData wins for names)', () => {
        const gameData = makeGameData([
            makeCharacter(1001, { fullName: 'Live Player' }),
            makeCharacter(2002, { fullName: 'Live Alice' })
        ]);
        const { facts, warnings } = applySaveFactAuthority([makeFact()], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
        expect(facts[0].subject.displayName).toBe('Live Player');
        expect(facts[0].object?.displayName).toBe('Live Alice');
    });

    it('keeps a spouse fact whose save name agrees with the live consort text', () => {
        const gameData = makeGameData([makeCharacter(1001, { consort: 'Save Alice' })]);
        const { facts, warnings } = applySaveFactAuthority([makeFact()], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
        expect(facts[0].object?.displayName).toBe('Save Alice');
    });

    it('drops a conflicting spouse fact and records FACT_CONFLICT_LIVE without content', () => {
        const gameData = makeGameData([makeCharacter(1001, { consort: 'Live Bertha' })]);
        const { facts, warnings } = applySaveFactAuthority([makeFact()], { gameData });

        expect(facts).toEqual([]);
        expect(warnings).toEqual([{ code: FACT_CONFLICT_LIVE, category: 'family' }]);
        // Diagnostics carry code + category only — never the conflicting names.
        expect(JSON.stringify(warnings)).not.toContain('Live Bertha');
        expect(JSON.stringify(warnings)).not.toContain('Save Alice');
    });

    it('drops a conflicting liege fact and records FACT_CONFLICT_LIVE', () => {
        const gameData = makeGameData([makeCharacter(1001, { liege: 'Live Liege' })]);
        const fact = makeFact({
            predicate: 'character.liege',
            category: 'realm',
            object: { type: 'character', id: '3003', displayName: 'Save Liege' },
            sourcePath: 'character_liege'
        });
        const { facts, warnings } = applySaveFactAuthority([fact], { gameData });

        expect(facts).toEqual([]);
        expect(warnings).toEqual([{ code: FACT_CONFLICT_LIVE, category: 'realm' }]);
    });

    it('keeps the save fact when live GameData has no consort/liege text (save provides structure)', () => {
        const gameData = makeGameData([makeCharacter(1001)]);
        const { facts, warnings } = applySaveFactAuthority([makeFact()], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
        expect(facts[0].object?.displayName).toBe('Save Alice');
    });

    it('treats a live consort shaped like a raw localization key as missing', () => {
        const gameData = makeGameData([makeCharacter(1001, { consort: 'k_france' })]);
        const { facts, warnings } = applySaveFactAuthority([makeFact()], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
    });

    it('rewrites primary_title object display from live GameData (never drops)', () => {
        const gameData = makeGameData([makeCharacter(1001, { primaryTitle: 'Kingdom of France' })]);
        const fact = makeFact({
            predicate: 'character.primary_title',
            category: 'realm',
            object: { type: 'title', id: 'k_france', displayName: 'Stale Title Name' },
            sourcePath: 'character_primary_title'
        });
        const { facts, warnings } = applySaveFactAuthority([fact], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
        expect(facts[0].object?.displayName).toBe('Kingdom of France');
    });

    it('keeps parent facts untouched (no live text authority for parents)', () => {
        const gameData = makeGameData([makeCharacter(1001)]);
        const fact = makeFact({
            predicate: 'character.parent',
            object: { type: 'character', id: '3003', displayName: 'Save Father' },
            sourcePath: 'character_father'
        });
        const { facts, warnings } = applySaveFactAuthority([fact], { gameData });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
        expect(facts[0].object?.displayName).toBe('Save Father');
    });

    it('accepts consistently mapped live war facts and uses the live war display name', () => {
        const gameData = attachMilitarySnapshot(makeGameData([
            makeCharacter(1001, { fullName: 'Live Player' }),
            makeCharacter(2002, { fullName: 'Live Defender' })
        ]));
        const attacker = makeWarFact({
            id: 'fact-attacker',
            subject: { type: 'war', id: '7001', displayName: 'Stale War Name' },
            predicate: 'war.attacker',
            object: { type: 'character', id: '1001' },
            sourcePath: 'war_attacker'
        });
        const score = makeWarFact({
            id: 'fact-score',
            predicate: 'character.war_score_band',
            value: 'winning',
            sourcePath: 'character_war_score_band',
            confidence: 'mapped'
        });
        const defenderScore = makeWarFact({
            id: 'fact-defender-score',
            subject: { type: 'character', id: '2002' },
            predicate: 'character.war_score_band',
            value: 'losing',
            sourcePath: 'character_war_score_band',
            confidence: 'mapped'
        });

        const { facts, warnings } = applySaveFactAuthority([
            makeWarFact(),
            attacker,
            score,
            defenderScore
        ], { gameData });

        expect(warnings).toEqual([]);
        expect(facts.map(fact => fact.id)).toEqual([
            'fact-war',
            'fact-attacker',
            'fact-score',
            'fact-defender-score'
        ]);
        expect(facts[0].object?.displayName).toBe('Live Northern War');
        expect(facts[1].subject.displayName).toBe('Live Northern War');
        expect(facts[2].value).toBe('winning');
        // The exact live score is used only to choose a bounded band; it is
        // never copied into an accepted fact.
        expect(facts[2]).not.toHaveProperty('score');
        expect(facts[2]).not.toHaveProperty('total');
        expect(facts[3].value).toBe('losing');
    });

    it('drops conflicting primary-side and participant-relative score facts with safe warnings', () => {
        const gameData = attachMilitarySnapshot(makeGameData([makeCharacter(1001)]));
        const attacker = makeWarFact({
            id: 'fact-attacker-conflict',
            subject: { type: 'war', id: '7001' },
            predicate: 'war.attacker',
            object: { type: 'character', id: '3003', displayName: 'Save Other Attacker' },
            sourcePath: 'war_attacker'
        });
        const score = makeWarFact({
            id: 'fact-score-conflict',
            predicate: 'character.war_score_band',
            value: 'losing',
            sourcePath: 'character_war_score_band',
            confidence: 'mapped'
        });

        const { facts, warnings } = applySaveFactAuthority([attacker, score], { gameData });

        expect(facts).toEqual([]);
        expect(warnings).toEqual([
            { code: FACT_CONFLICT_LIVE, category: 'war' },
            { code: FACT_CONFLICT_LIVE, category: 'war' }
        ]);
        const serializedWarnings = JSON.stringify(warnings);
        expect(serializedWarnings).not.toContain('Live Northern War');
        expect(serializedWarnings).not.toContain('3003');
        expect(serializedWarnings).not.toContain('60');
    });

    it('keeps save war facts when the live snapshot is missing or incomplete', () => {
        const fact = makeWarFact({
            predicate: 'character.war_score_band',
            value: 'losing',
            sourcePath: 'character_war_score_band',
            confidence: 'mapped'
        });
        const noSnapshot = applySaveFactAuthority([fact], { gameData: makeGameData([makeCharacter(1001)]) });
        const incomplete = applySaveFactAuthority([fact], {
            gameData: attachMilitarySnapshot(makeGameData([makeCharacter(1001)]), makeWar(), false)
        });

        expect(noSnapshot.facts).toHaveLength(1);
        expect(noSnapshot.facts[0]).toMatchObject({ id: 'fact-war', value: 'losing' });
        expect(noSnapshot.facts[0].object?.displayName).toBe('Save Northern War');
        expect(noSnapshot.warnings).toEqual([]);
        expect(incomplete.facts).toHaveLength(1);
        expect(incomplete.facts[0]).toMatchObject({ id: 'fact-war', value: 'losing' });
        expect(incomplete.facts[0].object?.displayName).toBe('Save Northern War');
        expect(incomplete.warnings).toEqual([]);
    });

    it('does not guess when war/participant/side identities cannot be mapped exactly', () => {
        const gameData = attachMilitarySnapshot(makeGameData([makeCharacter(1001)]));
        const nonCanonicalWar = makeWarFact({
            object: { type: 'war', id: '07001', displayName: 'Save War' }
        });
        const titleSide = makeWarFact({
            id: 'fact-title-side',
            subject: { type: 'war', id: '7001' },
            predicate: 'war.attacker',
            object: { type: 'title', id: 'k_example' },
            sourcePath: 'war_attacker'
        });
        const unknownParticipantScore = makeWarFact({
            id: 'fact-unknown-side',
            subject: { type: 'character', id: '3003' },
            predicate: 'character.war_score_band',
            value: 'losing',
            sourcePath: 'character_war_score_band',
            confidence: 'mapped'
        });

        const { facts, warnings } = applySaveFactAuthority([
            nonCanonicalWar,
            titleSide,
            unknownParticipantScore
        ], { gameData });

        expect(facts.map(fact => fact.id)).toEqual(['fact-war', 'fact-title-side', 'fact-unknown-side']);
        expect(warnings).toEqual([]);
    });

    it('rejects chronicle and conversation claims as hard facts', () => {
        const chronicle = makeFact({ source: 'chronicle' });
        const claim = makeFact({ id: 'fact-2', source: 'conversation_history' });
        const { facts, warnings } = applySaveFactAuthority([chronicle, claim], {});

        expect(facts).toEqual([]);
        expect(warnings).toEqual([
            { code: FACT_SOURCE_REJECTED, category: 'family' },
            { code: FACT_SOURCE_REJECTED, category: 'family' }
        ]);
    });

    it('resolves save-side object names through the provided resolver for conflict checks', () => {
        const gameData = makeGameData([makeCharacter(1001, { consort: 'Live Bertha' })]);
        const fact = makeFact({ object: { type: 'character', id: '2002' } });
        const { facts, warnings } = applySaveFactAuthority([fact], {
            gameData,
            resolveName: ref => (ref.id === '2002' ? 'Live Bertha' : undefined)
        });

        expect(warnings).toEqual([]);
        expect(facts).toHaveLength(1);
    });

    it('does not mutate the input facts', () => {
        const gameData = makeGameData([makeCharacter(1001, { fullName: 'Live Player' })]);
        const fact = makeFact();
        const before = JSON.stringify(fact);
        applySaveFactAuthority([fact], { gameData });
        expect(JSON.stringify(fact)).toBe(before);
    });
});
