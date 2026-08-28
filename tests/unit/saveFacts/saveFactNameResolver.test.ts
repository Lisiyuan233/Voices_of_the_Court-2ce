import { GameData } from '../../../src/shared/gameData/GameData';
import { Character } from '../../../src/shared/gameData/Character';
import {
    materializeResolvedFactNames,
    resolveEntityDisplayName,
    resolveFactDisplayNames,
    sanitizeDisplayName,
    SAVE_FACT_DISPLAY_NAME_MAX_LENGTH
} from '../../../src/main/saveFacts/SaveFactNameResolver';
import type { SaveFactNameResolverContext } from '../../../src/main/saveFacts/SaveFactNameResolver';
import type { SaveFactNameResolverSnapshot } from '../../../src/main/saveFacts/SaveFactNameResolver';
import type { CanonicalEntityV1, GameFact } from '../../../src/main/saveFacts/saveFactTypes';

const INIT_BASE = ['1001', 'Player', '2002', 'AI', '1066.1.1', 'scene:test', 'Location', 'Controller', '1', '11', '22', '5', '6', '42', '0'];

function makeCharacter(id: number, overrides: { fullName?: string; primaryTitle?: string } = {}): Character {
    const data: string[] = new Array(27).fill('');
    data[0] = String(id);
    data[1] = overrides.fullName ?? `Short${id}`;
    data[2] = overrides.fullName ?? `Full Name ${id}`;
    data[3] = overrides.primaryTitle ?? `County of ${id}`;
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

describe('sanitizeDisplayName', () => {
    it('normalizes Unicode to NFC', () => {
        // "é" as e + combining acute must fold to the precomposed form.
        expect(sanitizeDisplayName('Cafe\u0301')).toBe('Caf\u00E9');
    });

    it('strips NUL, C0 and bidi control characters and collapses whitespace', () => {
        expect(sanitizeDisplayName('Al\u0000ice\u202E  Bob\tSmith')).toBe('Alice Bob Smith');
        expect(sanitizeDisplayName('\u202A\u202BHidden\u202C')).toBe('Hidden');
    });

    it('caps the length at 160 characters', () => {
        const long = 'A'.repeat(200);
        expect(sanitizeDisplayName(long)).toHaveLength(SAVE_FACT_DISPLAY_NAME_MAX_LENGTH);
    });

    it('rejects empty results and raw localization keys', () => {
        expect(sanitizeDisplayName('')).toBeUndefined();
        expect(sanitizeDisplayName('\u202A')).toBeUndefined();
        expect(sanitizeDisplayName('k_france')).toBeUndefined();
        expect(sanitizeDisplayName('dynn_norman')).toBeUndefined();
        expect(sanitizeDisplayName('ERROR:missing')).toBeUndefined();
    });
});

describe('resolveEntityDisplayName priority', () => {
    const ref = { type: 'character', id: '1001' } as const;

    it('priority 1: live GameData fullName wins over cache and sidecar literal', () => {
        const context: SaveFactNameResolverContext = {
            gameData: makeGameData([makeCharacter(1001, { fullName: 'Live Alice' })]),
            store: { resolveEntityName: () => 'Cached Alice' },
            entities: [{ type: 'character', id: '1001', displayNameCandidate: { kind: 'literal', value: 'Sidecar Alice' } }]
        };
        expect(resolveEntityDisplayName(ref, context)).toEqual({
            resolved: true,
            displayName: 'Live Alice',
            source: 'live_character'
        });
    });

    it('priority 2: primary_title object uses the live primaryTitle of the subject', () => {
        const fact = makeFact({
            predicate: 'character.primary_title',
            category: 'realm',
            object: { type: 'title', id: 'k_france' },
            sourcePath: 'character_primary_title'
        });
        const context: SaveFactNameResolverContext = {
            gameData: makeGameData([makeCharacter(1001, { primaryTitle: 'Kingdom of France' })])
        };
        expect(resolveEntityDisplayName({ type: 'title', id: 'k_france' }, context, fact)).toEqual({
            resolved: true,
            displayName: 'Kingdom of France',
            source: 'live_primary_title'
        });
    });

    it('priority 3: campaign entity-name cache is used when live data is absent', () => {
        const context: SaveFactNameResolverContext = {
            gameData: makeGameData([]),
            store: {
                resolveEntityName: (type, id) => (type === 'character' && id === '1001' ? 'Cached Alice' : undefined)
            }
        };
        expect(resolveEntityDisplayName(ref, context)).toEqual({
            resolved: true,
            displayName: 'Cached Alice',
            source: 'entity_name_cache'
        });
    });

    it('priority 4: sidecar literal candidate is sanitized and used', () => {
        const entities: CanonicalEntityV1[] = [
            { type: 'character', id: '1001', displayNameCandidate: { kind: 'literal', value: '  Sidecar   Alice  ' } }
        ];
        expect(resolveEntityDisplayName(ref, { entities })).toEqual({
            resolved: true,
            displayName: 'Sidecar Alice',
            source: 'sidecar_literal'
        });
    });

    it('priority 5: localization_key candidates resolve only through the explicit local map', () => {
        const entities: CanonicalEntityV1[] = [
            { type: 'title', id: 'k_france', displayNameCandidate: { kind: 'localization_key', value: 'k_france' } }
        ];
        const titleRef = { type: 'title', id: 'k_france' } as const;

        expect(resolveEntityDisplayName(titleRef, { entities })).toEqual({ resolved: false });
        expect(resolveEntityDisplayName(titleRef, { entities, localizations: {} })).toEqual({ resolved: false });
        expect(resolveEntityDisplayName(titleRef, { entities, localizations: { k_france: 'Kingdom of France' } })).toEqual({
            resolved: true,
            displayName: 'Kingdom of France',
            source: 'local_mapping'
        });
    });

    it('priority 6: unresolvable entities stay internal and are not renderable', () => {
        const result = resolveEntityDisplayName({ type: 'character', id: '9999' }, {});
        expect(result).toEqual({ resolved: false });
    });

    it('never falls back to an opaque war id as a display name', () => {
        expect(resolveEntityDisplayName({ type: 'war', id: 'war-internal-42' }, {}))
            .toEqual({ resolved: false });
        expect(resolveEntityDisplayName({ type: 'war', id: 'war-internal-42', displayName: 'Border War' }, {}))
            .toMatchObject({ resolved: true, displayName: 'Border War' });
    });

    it('never emits raw localization keys from any source', () => {
        // Live fullName that is itself a raw key must not pass.
        const liveKey = resolveEntityDisplayName(ref, {
            gameData: makeGameData([makeCharacter(1001, { fullName: 'dynn_norman' })])
        });
        expect(liveKey.resolved).toBe(false);

        // Sidecar literal shaped like a raw key must not pass.
        const literalKey = resolveEntityDisplayName(ref, {
            entities: [{ type: 'character', id: '1001', displayNameCandidate: { kind: 'literal', value: 'k_france' } }]
        });
        expect(literalKey.resolved).toBe(false);

        // Cache entry shaped like a raw key must not pass.
        const cacheKey = resolveEntityDisplayName(ref, {
            store: { resolveEntityName: () => 'ERROR:broken' }
        });
        expect(cacheKey.resolved).toBe(false);
    });
});

describe('resolveFactDisplayNames', () => {
    it('is renderable when subject and object both resolve', () => {
        const result = resolveFactDisplayNames(makeFact(), {
            gameData: makeGameData([makeCharacter(1001), makeCharacter(2002)])
        });
        expect(result.renderable).toBe(true);
        expect(result.subject.displayName).toBe('Full Name 1001');
        expect(result.object?.displayName).toBe('Full Name 2002');
    });

    it('keeps the fact but marks it not renderable when the object is unresolved', () => {
        const result = resolveFactDisplayNames(makeFact(), {
            gameData: makeGameData([makeCharacter(1001)])
        });
        expect(result.renderable).toBe(false);
        expect(result.subject.resolved).toBe(true);
        expect(result.object?.resolved).toBe(false);
    });
});

describe('snapshot-backed name materialization', () => {
    const snapshot: SaveFactNameResolverSnapshot = {
        entries: [{
            entityType: 'character',
            id: '1001',
            displayName: 'Historical Alice',
            source: 'live_gamedata',
            checkpointEpoch: 1,
            updatedAt: '2026-08-09T00:00:00.000Z'
        }]
    };

    it('prefers the current extract literal over a historical cache entry', () => {
        const result = resolveEntityDisplayName(
            { type: 'character', id: '1001' },
            {
                nameSnapshot: snapshot,
                entities: [{
                    type: 'character',
                    id: '1001',
                    displayNameCandidate: { kind: 'literal', value: 'Current Alice' }
                }]
            }
        );
        expect(result).toEqual({
            resolved: true,
            displayName: 'Current Alice',
            source: 'sidecar_literal'
        });
    });

    it('materializes only public names and returns safe cache updates', () => {
        const publicFact = makeFact({ visibility: 'public' });
        const internalFact = makeFact({ id: 'internal', visibility: 'omniscient_internal' });
        const result = materializeResolvedFactNames(
            [publicFact, internalFact],
            {
                nameSnapshot: snapshot,
                entities: [
                    { type: 'character', id: '1001', displayNameCandidate: { kind: 'literal', value: 'Current Alice' } },
                    { type: 'character', id: '2002', displayNameCandidate: { kind: 'literal', value: 'Current Bob' } }
                ]
            }
        );

        expect(result.facts[0].subject.displayName).toBe('Current Alice');
        expect(result.facts[0].object?.displayName).toBe('Current Bob');
        expect(result.facts[1].subject.displayName).toBeUndefined();
        expect(result.updates).toEqual([
            { entityType: 'character', id: '1001', displayName: 'Current Alice', source: 'verified_literal' },
            { entityType: 'character', id: '2002', displayName: 'Current Bob', source: 'verified_literal' }
        ]);
        expect(result.unresolvedEntityCount).toBe(0);
    });

    it('counts unresolved public endpoints without writing an ID placeholder', () => {
        const result = materializeResolvedFactNames(
            [makeFact({ visibility: 'public', object: { type: 'character', id: '9999' } })],
            { gameData: makeGameData([makeCharacter(1001)]) }
        );
        expect(result.unresolvedEntityCount).toBe(1);
        expect(result.updates).toEqual([
            { entityType: 'character', id: '1001', displayName: 'Full Name 1001', source: 'live_gamedata' }
        ]);
        expect(result.facts[0].object?.displayName).toBeUndefined();
    });
});
