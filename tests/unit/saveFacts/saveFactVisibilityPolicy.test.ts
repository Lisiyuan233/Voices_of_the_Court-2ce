import {
    applySaveFactVisibilityPolicy,
    evaluateFactVisibility,
    FACT_CONFIDENCE_BELOW_THRESHOLD,
    FACT_HIDDEN_FIELD_GUARD,
    FACT_PREDICATE_UNKNOWN,
    FACT_SOURCE_PATH_REJECTED,
    getPredicatePolicy,
    projectPublicFacts,
    SAVE_FACT_PREDICATE_REGISTRY
} from '../../../src/main/saveFacts/SaveFactVisibilityPolicy';
import { buildSaveFactIndex } from '../../../src/main/saveFacts/SaveFactIndex';
import { validateSaveFactExtractionResult } from '../../../src/main/saveFacts/saveFactSchemas';
import { SAVE_FACT_PREDICATES } from '../../../src/main/saveFacts/saveFactTypes';
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

describe('SAVE_FACT_PREDICATE_REGISTRY (plan 5.5)', () => {
    it('registers every v1 allowlisted predicate except the 2026-08-12 unsupported P1-D ones', () => {
        const registered = Object.keys(SAVE_FACT_PREDICATE_REGISTRY).sort();
        const expected = SAVE_FACT_PREDICATES
            .filter(predicate => ![
                'character.current_activity',
                'character.traveling',
                'activity.location',
                'character.council_position',
                'character.court_position'
            ].includes(predicate))
            .sort();
        expect(registered).toEqual(expected);
        // Unsupported predicates fall back to unknown → blocked.
        for (const predicate of ['character.current_activity', 'character.traveling', 'activity.location', 'character.council_position', 'character.court_position']) {
            expect(getPredicatePolicy(predicate)).toBeUndefined();
            expect(evaluateFactVisibility(makeFact({
                predicate: predicate as GameFact['predicate'],
                category: predicate.startsWith('activity') ? 'activity' : 'court',
                sourcePath: 'character_spouse',
                value: predicate === 'character.traveling' ? true : undefined
            }))).toMatchObject({ visibility: 'blocked', reason: FACT_PREDICATE_UNKNOWN });
        }
    });

    it('upgrades spouse/parent/child/liege/primary_title to public with plan sensitivities', () => {
        for (const predicate of ['character.spouse', 'character.parent', 'character.child'] as const) {
            expect(SAVE_FACT_PREDICATE_REGISTRY[predicate]!.upgradeTo).toBe('public');
            expect(SAVE_FACT_PREDICATE_REGISTRY[predicate]!.sensitivity).toBe('personal');
        }
        for (const predicate of ['character.liege', 'character.primary_title'] as const) {
            expect(SAVE_FACT_PREDICATE_REGISTRY[predicate]!.upgradeTo).toBe('public');
            expect(SAVE_FACT_PREDICATE_REGISTRY[predicate]!.sensitivity).toBe('political');
        }
    });

    it('keeps title.holder omniscient_internal as an internal reverse index', () => {
        const policy = SAVE_FACT_PREDICATE_REGISTRY['title.holder']!;
        expect(policy.upgradeTo).toBe('omniscient_internal');
        expect(policy.allowedSourcePaths).toEqual(['title_holder']);
    });

    it('registers every war predicate as public only through its exact source path', () => {
        const warPolicies = [
            ['character.at_war', 'character_at_war'],
            ['war.attacker', 'war_attacker'],
            ['war.defender', 'war_defender'],
            ['war.casus_belli', 'war_casus_belli'],
            ['character.war_score_band', 'character_war_score_band']
        ] as const;
        for (const [predicate, sourcePath] of warPolicies) {
            const policy = SAVE_FACT_PREDICATE_REGISTRY[predicate]!;
            expect(policy.upgradeTo).toBe('public');
            expect(policy.allowedSourcePaths).toEqual([sourcePath]);
        }
    });

    it('enables the hidden-field guard and a render template on every registered predicate', () => {
        for (const predicate of Object.keys(SAVE_FACT_PREDICATE_REGISTRY) as (keyof typeof SAVE_FACT_PREDICATE_REGISTRY)[]) {
            const policy = SAVE_FACT_PREDICATE_REGISTRY[predicate]!;
            expect(policy.hiddenFieldGuard).toBe(true);
            expect(policy.renderTemplateId).toMatch(/^savefact\./);
        }
    });
});

describe('evaluateFactVisibility', () => {
    it('upgrades a clean registry fact to public', () => {
        expect(evaluateFactVisibility(makeFact())).toMatchObject({ visibility: 'public' });
    });

    it('blocks unknown predicates (no default public)', () => {
        const fact = makeFact({ predicate: 'character.real_father' });
        expect(evaluateFactVisibility(fact)).toMatchObject({
            visibility: 'blocked',
            reason: FACT_PREDICATE_UNKNOWN
        });
        expect(getPredicatePolicy('character.real_father')).toBeUndefined();
    });

    it('blocks a forged sourcePath even for a registered predicate', () => {
        const fact = makeFact({ sourcePath: 'character_father' });
        expect(evaluateFactVisibility(fact)).toMatchObject({
            visibility: 'blocked',
            reason: FACT_SOURCE_PATH_REJECTED
        });
    });

    it('blocks facts carrying hidden semantics (secret/system_hidden sensitivity)', () => {
        expect(evaluateFactVisibility(makeFact({ sensitivity: 'secret' }))).toMatchObject({
            visibility: 'blocked',
            reason: FACT_HIDDEN_FIELD_GUARD
        });
        expect(evaluateFactVisibility(makeFact({ sensitivity: 'system_hidden' }))).toMatchObject({
            visibility: 'blocked',
            reason: FACT_HIDDEN_FIELD_GUARD
        });
    });

    it('holds facts below the confidence threshold at omniscient_internal', () => {
        expect(evaluateFactVisibility(makeFact({ confidence: 'heuristic' }))).toMatchObject({
            visibility: 'omniscient_internal',
            reason: FACT_CONFIDENCE_BELOW_THRESHOLD
        });
        // primary_title accepts mapped confidence.
        const titleFact = makeFact({
            predicate: 'character.primary_title',
            object: { type: 'title', id: 'k_france' },
            sourcePath: 'character_primary_title',
            confidence: 'mapped'
        });
        expect(evaluateFactVisibility(titleFact).visibility).toBe('public');
    });

    it('ignores the sidecar-claimed visibility entirely', () => {
        // title.holder never upgrades even if the sidecar shouts "public".
        const fact = makeFact({
            predicate: 'title.holder',
            subject: { type: 'title', id: 'k_france' },
            sourcePath: 'title_holder',
            visibility: 'public'
        });
        expect(evaluateFactVisibility(fact).visibility).toBe('omniscient_internal');
        // And a spouse fact claiming "blocked" still upgrades on its own merits.
        expect(evaluateFactVisibility(makeFact({ visibility: 'blocked' })).visibility).toBe('public');
    });
});

describe('applySaveFactVisibilityPolicy + projectPublicFacts', () => {
    it('projects only registry-proven public facts', () => {
        const clean = makeFact({ id: 'fact-clean' });
        const heldBack = makeFact({ id: 'fact-held', confidence: 'heuristic' });
        const blocked = makeFact({ id: 'fact-blocked', sensitivity: 'secret' });
        const { facts, warnings } = applySaveFactVisibilityPolicy([clean, heldBack, blocked]);

        expect(facts.map(f => f.visibility)).toEqual(['public', 'omniscient_internal', 'blocked']);
        expect(warnings).toEqual([{ code: FACT_HIDDEN_FIELD_GUARD, category: 'family' }]);
        expect(projectPublicFacts(facts).map(f => f.id)).toEqual(['fact-clean']);
    });
});

// ---------------------------------------------------------------------------
// Secret regression sentinels (plan Task 14 step 6)
// ---------------------------------------------------------------------------

function sidecarResponse(facts: unknown[]): unknown {
    return {
        protocolVersion: 2,
        operation: 'extract',
        status: 'ok',
        manifest: MANIFEST,
        entities: [],
        facts,
        warnings: [],
        metrics: { inputBytes: 100, durationMs: 5, emittedFacts: facts.length, emittedEntities: 0 }
    };
}

function maliciousFact(predicate: string, overrides: Record<string, unknown> = {}): unknown {
    return {
        id: 'fact-evil',
        category: 'family',
        subject: { type: 'character', id: '1001' },
        predicate,
        object: { type: 'character', id: '2002', displayName: 'SECRET-CONTENT-MARKER' },
        asOfGameDate: { numeric: 402123 },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'public',
        priority: 999,
        sensitivity: 'secret',
        provenance: {},
        ...overrides
    };
}

describe('secret regression sentinels', () => {
    it('schema rejects secret/scheme/real_father/AI-strategy predicates outright', () => {
        for (const predicate of ['secret.owner', 'scheme.target', 'character.real_father', 'ai.strategy']) {
            const result = validateSaveFactExtractionResult(sidecarResponse([maliciousFact(predicate)]));
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.code).toBe('INVALID_PREDICATE');
        }
    });

    it('registry blocks forged sourcePath / hidden semantics; facts never become prompt candidates', () => {
        const forgedPath = makeFact({
            id: 'fact-forged',
            predicate: 'character.parent',
            sourcePath: 'character_spouse' // parent facts may only come from parent/child evidence
        });
        const hidden = makeFact({ id: 'fact-hidden', sensitivity: 'secret' });
        const { facts, warnings } = applySaveFactVisibilityPolicy([forgedPath, hidden]);

        expect(facts.map(f => f.visibility)).toEqual(['blocked', 'blocked']);
        expect(warnings).toEqual([
            { code: FACT_SOURCE_PATH_REJECTED, category: 'family' },
            { code: FACT_HIDDEN_FIELD_GUARD, category: 'family' }
        ]);

        // Even after indexing, blocked facts are not prompt candidates.
        const { index } = buildSaveFactIndex({
            facts,
            entities: [
                { type: 'character', id: '1001' },
                { type: 'character', id: '2002' }
            ],
            manifest: MANIFEST,
            participantCharacterIds: ['1001']
        });
        expect(projectPublicFacts(index.queryByPredicate('character.parent'))).toEqual([]);
        expect(projectPublicFacts(index.queryByPredicate('character.spouse'))).toEqual([]);
        expect(projectPublicFacts(index.queryByCategory('family'))).toEqual([]);
    });

    it('diagnostics record code/category only, never fact content', () => {
        const secretName = 'SECRET-CONTENT-MARKER';
        const fact = makeFact({
            sensitivity: 'secret',
            object: { type: 'character', id: '2002', displayName: secretName },
            value: secretName
        });
        const { warnings } = applySaveFactVisibilityPolicy([fact]);

        expect(warnings.length).toBeGreaterThan(0);
        expect(JSON.stringify(warnings)).not.toContain(secretName);
    });
});
