import {
    buildSaveFactIndex,
    SAVE_FACT_INDEX_MAX_ENTITIES,
    SAVE_FACT_INDEX_MAX_FACTS,
    SAVE_FACT_INDEX_WARNING_ENTITIES_TRUNCATED,
    SAVE_FACT_INDEX_WARNING_FACTS_TRUNCATED,
    saveFactEntityKey
} from '../../../src/main/saveFacts/SaveFactIndex';
import type { GameFact, SaveSnapshotManifest } from '../../../src/main/saveFacts/saveFactTypes';

const MANIFEST: SaveSnapshotManifest = {
    snapshotId: 'snap-1',
    sourceFingerprint: 'fp-abc123',
    sourceFormat: 'zip_text',
    parserVersion: '1.0.0',
    factSchemaVersion: 1
};

function makeFact(overrides: Partial<GameFact> = {}): GameFact {
    return {
        id: 'fact-1',
        category: 'family',
        subject: { type: 'character', id: '1001' },
        predicate: 'character.spouse',
        object: { type: 'character', id: '2002' },
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

function build(facts: readonly GameFact[], overrides: Partial<Parameters<typeof buildSaveFactIndex>[0]> = {}) {
    return buildSaveFactIndex({
        facts,
        entities: [
            { type: 'character', id: '1001' },
            { type: 'character', id: '2002' }
        ],
        manifest: MANIFEST,
        participantCharacterIds: ['1001'],
        ...overrides
    });
}

describe('buildSaveFactIndex', () => {
    it('indexes facts by subject, object, category and predicate with type:id keys', () => {
        const fact = makeFact();
        const { index, warnings } = build([fact]);

        expect(warnings).toEqual([]);
        expect(index.snapshot).toBe(MANIFEST);
        expect(index.factCount).toBe(1);
        expect(index.entityCount).toBe(2);
        expect(index.queryBySubject('character:1001')).toEqual([fact]);
        expect(index.queryByObject('character:2002')).toEqual([fact]);
        expect(index.queryByCategory('family')).toEqual([fact]);
        expect(index.queryByPredicate('character.spouse')).toEqual([fact]);
    });

    it('returns frozen empty arrays for unknown keys', () => {
        const { index } = build([makeFact()]);
        expect(index.queryBySubject('character:9999')).toEqual([]);
        expect(index.queryByObject('character:1001')).toEqual([]);
        expect(index.queryByCategory('realm')).toEqual([]);
        expect(index.queryByPredicate('character.liege')).toEqual([]);
        expect(Object.isFrozen(index.queryBySubject('character:9999'))).toBe(true);
    });

    it('exposes only frozen copies, never mutable internal state', () => {
        const { index } = build([makeFact()]);
        const facts = index.queryBySubject('character:1001');
        expect(Object.isFrozen(facts)).toBe(true);
        expect(() => {
            (facts as GameFact[]).push(makeFact({ id: 'fact-evil' }));
        }).toThrow();
        expect(index.queryBySubject('character:1001')).toHaveLength(1);
        // No Map-bearing properties are reachable on the query surface.
        expect((index as unknown as Record<string, unknown>)['bySubject']).toBeUndefined();
        expect((index as unknown as Record<string, unknown>)['byPredicate']).toBeUndefined();
    });

    it('computes participantDistance as BFS hops over the fact graph', () => {
        const spouse = makeFact({ id: 'fact-spouse' });
        const parent = makeFact({
            id: 'fact-parent',
            subject: { type: 'character', id: '2002' },
            predicate: 'character.parent',
            object: { type: 'character', id: '3003' },
            sourcePath: 'character_father'
        });
        const unrelated = makeFact({
            id: 'fact-unrelated',
            subject: { type: 'character', id: '4004' },
            predicate: 'character.liege',
            object: { type: 'character', id: '5005' },
            sourcePath: 'character_liege',
            category: 'realm'
        });
        const { index } = build([spouse, parent, unrelated]);

        expect(index.participantDistance('character:1001')).toBe(0);
        expect(index.participantDistance('character:2002')).toBe(1);
        expect(index.participantDistance('character:3003')).toBe(2);
        expect(index.participantDistance('character:4004')).toBeUndefined();
        expect(index.participantDistance('character:5005')).toBeUndefined();
    });

    it('truncates facts beyond the cap and warns instead of trusting the sidecar', () => {
        const facts: GameFact[] = [];
        for (let i = 0; i < SAVE_FACT_INDEX_MAX_FACTS + 10; i++) {
            facts.push(makeFact({ id: `fact-${i}` }));
        }
        const { index, warnings } = build(facts);

        expect(index.factCount).toBe(SAVE_FACT_INDEX_MAX_FACTS);
        expect(warnings).toEqual([{ code: SAVE_FACT_INDEX_WARNING_FACTS_TRUNCATED }]);
    });

    it('truncates entities beyond the cap and warns', () => {
        const entities = [];
        for (let i = 0; i < SAVE_FACT_INDEX_MAX_ENTITIES + 5; i++) {
            entities.push({ type: 'character', id: String(1000 + i) });
        }
        const { index, warnings } = build([makeFact()], { entities });

        expect(index.entityCount).toBe(SAVE_FACT_INDEX_MAX_ENTITIES);
        expect(warnings).toEqual([{ code: SAVE_FACT_INDEX_WARNING_ENTITIES_TRUNCATED }]);
    });
});

describe('saveFactEntityKey', () => {
    it('uses the type:id form', () => {
        expect(saveFactEntityKey({ type: 'character', id: '1001' })).toBe('character:1001');
        expect(saveFactEntityKey({ type: 'title', id: 'k_france' })).toBe('title:k_france');
    });
});
