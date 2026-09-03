import {
    validateSaveFactCapabilitiesResult,
    validateSaveFactExtractionResult,
    SAVE_FACT_RESPONSE_MAX_FACTS,
    SAVE_FACT_RESPONSE_MAX_ENTITIES,
    SAVE_FACT_RESPONSE_MAX_DEPTH,
    SAVE_FACT_RESPONSE_MAX_STRING_LENGTH,
    SAVE_FACT_RESPONSE_MAX_BYTES
} from '../../../src/main/saveFacts/saveFactSchemas';
// P5b deferred (verify/session/delta/agency): 1.x also imported
// validateSaveVerificationRequestV2 / validateSaveVerificationResponseV2 here;
// those unported saveFactVerificationSchemas validators and their tests stay
// trimmed. The capabilities validator is the minimal F16 port.
import { buildSaveFactSettings, SAVE_FACT_DEFAULTS } from '../../../src/main/saveFacts/saveFactSettings';
import { createEmptyConversationFactContext } from '../../../src/main/saveFacts/saveFactTypes';
import { SAVE_SNAPSHOT_FIXED_FILE_NAME } from '../../../src/shared/gameData/saveSnapshotProtocol';

function validFact() {
    return {
        id: 'fact:0001',
        category: 'family',
        subject: { type: 'character', id: '14233' },
        predicate: 'character.spouse',
        object: { type: 'character', id: '15107', displayName: 'Li' },
        asOfGameDate: { numeric: 349638, display: '957.11.29' },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'public',
        priority: 10,
        sensitivity: 'personal',
        provenance: { snapshotId: 'snap:1', campaignId: 'campaign:1' }
    };
}

function validResponse(overrides: Record<string, unknown> = {}) {
    return {
        protocolVersion: 2,
        operation: 'extract',
        status: 'ok',
        manifest: {
            snapshotId: 'snap:1',
            sourceFingerprint: 'abc123:def456',
            sourceFormat: 'zip_text',
            ck3Version: '1.12.5',
            saveGameVersion: 142,
            parserVersion: '0.1.0',
            factSchemaVersion: 1
        },
        identity: {
            playerCharacterId: '14233',
            gameDateNumeric: 349638,
            gameDateDisplay: '957.11.29',
            campaignIdParts: [7, 11, 22, 33],
            snapshotSequence: 42,
            snapshotSlot: 0,
            scriptVariableScale: 1000
        },
        entities: [
            { type: 'character', id: '14233', displayNameCandidate: { kind: 'literal', value: 'Zhang' } },
            { type: 'title', id: 'd_hedong' }
        ],
        facts: [validFact()],
        warnings: [{ code: 'SAVE_LIMIT_EXCEEDED', category: 'realm' }],
        metrics: {
            inputBytes: 1024,
            decompressedBytes: 4096,
            durationMs: 120,
            emittedFacts: 1,
            emittedEntities: 2
        },
        ...overrides
    };
}

describe('validateSaveFactExtractionResult', () => {
    it('accepts a fully valid extract response and returns a narrowed DTO', () => {
        const result = validateSaveFactExtractionResult(validResponse());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.protocolVersion).toBe(2);
        expect(result.value.operation).toBe('extract');
        expect(result.value.status).toBe('ok');
        expect(result.value.manifest.factSchemaVersion).toBe(1);
        expect(result.value.entities).toHaveLength(2);
        expect(result.value.facts).toHaveLength(1);
        expect(result.value.facts[0].predicate).toBe('character.spouse');
        expect(result.value.identity?.campaignIdParts).toEqual([7, 11, 22, 33]);
    });

    it('accepts the minimal strict war entity and predicate shapes', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            entities: [
                { type: 'character', id: '14233', displayNameCandidate: { kind: 'literal', value: 'Zhang' } },
                { type: 'war', id: 'war-1', displayNameCandidate: { kind: 'literal', value: 'Northern War' } }
            ],
            facts: [{
                ...validFact(),
                id: 'war-fact-1',
                category: 'war',
                subject: { type: 'character', id: '14233' },
                predicate: 'character.war_score_band',
                object: { type: 'war', id: 'war-1' },
                value: 'winning',
                sourcePath: 'character_war_score_band',
                sensitivity: 'political'
            }]
        }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.facts[0].category).toBe('war');
    });

    it('rejects a war predicate with the wrong endpoint shape or an unbounded value', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            entities: [{ type: 'war', id: 'war-1' }],
            facts: [{
                ...validFact(),
                id: 'war-fact-invalid',
                category: 'war',
                subject: { type: 'war', id: 'war-1' },
                predicate: 'character.war_score_band',
                object: { type: 'war', id: 'war-1' },
                value: '42',
                sourcePath: 'character_war_score_band',
                sensitivity: 'political'
            }]
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_WAR_SHAPE' });
    });

    it('accepts a partial response with warnings', () => {
        const result = validateSaveFactExtractionResult(validResponse({ status: 'partial' }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.status).toBe('partial');
    });

    it('accepts an unsupported response carrying a known error code', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            status: 'unsupported',
            facts: [],
            entities: [],
            error: { code: 'SAVE_BINARY_UNSUPPORTED' }
        }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.error?.code).toBe('SAVE_BINARY_UNSUPPORTED');
    });

    it('accepts the binary melt version-gate error code', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            status: 'unsupported',
            facts: [],
            entities: [],
            error: { code: 'SAVE_TOKEN_VERSION_MISMATCH' }
        }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.error?.code).toBe('SAVE_TOKEN_VERSION_MISMATCH');
    });

    it('rejects an unknown error code', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            status: 'invalid',
            error: { code: 'SOMETHING_ELSE' }
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_ENUM' });
    });

    it('rejects a future protocol version', () => {
        const result = validateSaveFactExtractionResult(validResponse({ protocolVersion: 3 }));
        expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' });
    });

    it('rejects an old sidecar v1 response (no cross-version compat)', () => {
        const result = validateSaveFactExtractionResult(validResponse({ protocolVersion: 1 }));
        expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' });
    });

    it('accepts an optional ordered decimal joinCandidates array', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            joinCandidates: ['13206', '33435']
        }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.joinCandidates).toEqual(['13206', '33435']);
    });

    it('accepts an empty joinCandidates array (new mod, no same-location candidates)', () => {
        const result = validateSaveFactExtractionResult(validResponse({ joinCandidates: [] }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.joinCandidates).toEqual([]);
    });

    it('rejects non-array joinCandidates', () => {
        const result = validateSaveFactExtractionResult(validResponse({ joinCandidates: '13206' }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects non-decimal joinCandidates entries', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            joinCandidates: ['13206', 'char_33435']
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects joinCandidates entries that are not strings', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            joinCandidates: ['13206', 33435]
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects over-long joinCandidates arrays', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            joinCandidates: Array.from({ length: 513 }, (_, i) => String(i))
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects over-long decimal joinCandidates entries', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            joinCandidates: ['9'.repeat(65)]
        }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects an empty-string joinCandidates entry', () => {
        const result = validateSaveFactExtractionResult(validResponse({ joinCandidates: [''] }));
        expect(result).toMatchObject({ ok: false, code: 'INVALID_JOIN_CANDIDATES' });
    });

    it('rejects a future fact schema version in the manifest', () => {
        const response = validResponse();
        (response.manifest as Record<string, unknown>).factSchemaVersion = 2;
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' });
    });

    it('rejects over-long strings', () => {
        const response = validResponse();
        response.manifest.snapshotId = 'x'.repeat(SAVE_FACT_RESPONSE_MAX_STRING_LENGTH + 1);
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'STRING_TOO_LONG' });
    });

    it('rejects ids that do not match the id pattern', () => {
        const response = validResponse();
        response.manifest.snapshotId = 'bad id with spaces';
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'INVALID_ID' });
    });

    it('rejects objects nested deeper than the depth cap', () => {
        let deep: unknown = 1;
        for (let i = 0; i < SAVE_FACT_RESPONSE_MAX_DEPTH + 2; i++) deep = { nested: deep };
        const result = validateSaveFactExtractionResult(validResponse({ identity: deep }));
        expect(result).toMatchObject({ ok: false, code: 'DEPTH_EXCEEDED' });
    });

    it('rejects fact arrays beyond the cap', () => {
        const facts = Array.from({ length: SAVE_FACT_RESPONSE_MAX_FACTS + 1 }, (_, i) => ({
            ...validFact(),
            id: `fact:${i}`
        }));
        const result = validateSaveFactExtractionResult(validResponse({ facts }));
        expect(result).toMatchObject({ ok: false, code: 'ARRAY_TOO_LONG' });
    });

    it('rejects entity arrays beyond the cap', () => {
        const entities = Array.from({ length: SAVE_FACT_RESPONSE_MAX_ENTITIES + 1 }, (_, i) => ({
            type: 'character',
            id: `c${i}`
        }));
        const result = validateSaveFactExtractionResult(validResponse({ entities }));
        expect(result).toMatchObject({ ok: false, code: 'ARRAY_TOO_LONG' });
    });

    it('rejects non-finite metric numbers', () => {
        const response = validResponse();
        (response.metrics as Record<string, unknown>).durationMs = Number.POSITIVE_INFINITY;
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'NON_FINITE_NUMBER' });
    });

    it('rejects metric values beyond the cap', () => {
        const response = validResponse();
        response.metrics.inputBytes = SAVE_FACT_RESPONSE_MAX_BYTES + 1;
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'METRIC_OUT_OF_RANGE' });
    });

    it('rejects cyclic test objects', () => {
        const response = validResponse();
        (response as Record<string, unknown>).manifest = response as never;
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'CYCLIC_STRUCTURE' });
    });

    it('rejects prototype-pollution keys parsed from JSON', () => {
        const parsed = JSON.parse('{"__proto__": {"polluted": true}, "protocolVersion": 1}');
        const result = validateSaveFactExtractionResult(parsed);
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' });
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('rejects objects with a tampered prototype', () => {
        const weird = Object.create({ sneaky: true });
        weird.protocolVersion = 1;
        const result = validateSaveFactExtractionResult(weird);
        expect(result).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
    });

    it('rejects unexpected raw-path fields anywhere in the response', () => {
        const result = validateSaveFactExtractionResult(validResponse({ rawSavePath: 'C:\\Users\\A\\save.ck3' }));
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' });
    });

    it('rejects unknown fields nested inside the manifest', () => {
        const response = validResponse();
        (response.manifest as Record<string, unknown>).absoluteInputPath = '/home/user/save.ck3';
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' });
    });

    it('rejects facts with predicates outside the registry', () => {
        const response = validResponse();
        (response.facts[0] as Record<string, unknown>).predicate = 'character.secret_lover';
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'INVALID_PREDICATE' });
    });

    it('rejects facts whose source is not save_snapshot', () => {
        const response = validResponse();
        (response.facts[0] as Record<string, unknown>).source = 'live_gamedata';
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'INVALID_ENUM' });
    });

    it('rejects facts with a non-canonical source path', () => {
        const response = validResponse();
        (response.facts[0] as Record<string, unknown>).sourcePath = 'gamestate.characters.14233.father';
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'INVALID_SOURCE_PATH' });
    });

    it('rejects probe responses that carry entities or facts', () => {
        const result = validateSaveFactExtractionResult(validResponse({ operation: 'probe' }));
        expect(result).toMatchObject({ ok: false, code: 'PROBE_NOT_EMPTY' });
    });

    it('accepts an empty probe response', () => {
        const result = validateSaveFactExtractionResult(validResponse({
            operation: 'probe',
            entities: [],
            facts: []
        }));
        expect(result.ok).toBe(true);
    });

    it('rejects missing required fields', () => {
        const response = validResponse();
        delete (response as Record<string, unknown>).metrics;
        const result = validateSaveFactExtractionResult(response);
        expect(result).toMatchObject({ ok: false, code: 'MISSING_FIELD' });
    });

    it('does not retain references to the input object graph', () => {
        const input = validResponse();
        const result = validateSaveFactExtractionResult(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.manifest).not.toBe(input.manifest);
        expect(result.value.facts[0]).not.toBe(input.facts[0]);
        expect(result.value.facts[0].subject).not.toBe(input.facts[0].subject);
    });
});

// P5b deferred (verify/session/delta/agency): the 1.x suite also ran the
// 'P1-A typed verification schemas' describe block (verify request/response
// validators); trimmed with the verify/session op paths. The capabilities
// whitelist validator below is the minimal F16 port (binary_save_support
// contract); its two binarySaveSupport tests are ported from 1.x 0bdb63c.

describe('validateSaveFactCapabilitiesResult', () => {
    it('accepts capabilities with binarySaveSupport', () => {
        const result = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [{ operation: 'probe', protocolVersion: 2 }],
            parserVersion: '0.2.0',
            binarySaveSupport: { status: 'ok', tokenTableVersion: '1.19.0.6' }
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.binarySaveSupport).toEqual({
                status: 'ok',
                tokenTableVersion: '1.19.0.6'
            });
        }
    });

    it('rejects capabilities with malformed binarySaveSupport', () => {
        const result = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [{ operation: 'probe', protocolVersion: 2 }],
            binarySaveSupport: { status: 'maybe', tokenTableVersion: '1.19.0.6' }
        });
        expect(result.ok).toBe(false);
    });

    it('accepts a capabilities response without binarySaveSupport (optional field)', () => {
        const result = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [{ operation: 'extract', protocolVersion: 2 }]
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.binarySaveSupport).toBeUndefined();
    });

    it('rejects an unsupported-protocol binarySaveSupport block', () => {
        const result = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [],
            binarySaveSupport: { status: 'ok', tokenTableVersion: '1.19.0.6', extra: true }
        });
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' });
    });

    it('enforces the frozen operation/version pairing (session is v3 only)', () => {
        const legacySession = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [{ operation: 'session', protocolVersion: 2 }]
        });
        expect(legacySession).toMatchObject({ ok: false, code: 'INVALID_VALUE' });

        const v3Session = validateSaveFactCapabilitiesResult({
            protocolVersion: 1,
            operation: 'capabilities',
            status: 'ok',
            capabilities: [{ operation: 'session', protocolVersion: 3 }]
        });
        expect(v3Session.ok).toBe(true);
    });

    it('rejects a future capabilities protocol version', () => {
        const result = validateSaveFactCapabilitiesResult({
            protocolVersion: 2,
            operation: 'capabilities',
            status: 'ok',
            capabilities: []
        });
        expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' });
    });
});

describe('buildSaveFactSettings', () => {
    it('returns safe defaults for an old config without any new fields', () => {
        const settings = buildSaveFactSettings({});
        // P5b deferred (verify/session/delta/agency): the 1.x default shape
        // also carried agencyVerifyEnabled/characterQueryEnabled/deltaEnabled;
        // those flags are trimmed from 2CE settings.
        expect(settings).toEqual({
            enabled: false,
            parserEnabled: false,
            promptEnabled: false,
            snapshotFileName: SAVE_SNAPSHOT_FIXED_FILE_NAME,
            prepareDeadlineMs: SAVE_FACT_DEFAULTS.prepareDeadlineMs,
            parserTimeoutMs: SAVE_FACT_DEFAULTS.parserTimeoutMs,
            pollIntervalMs: SAVE_FACT_DEFAULTS.pollIntervalMs,
            baselineTokenBudget: SAVE_FACT_DEFAULTS.baselineTokenBudget,
            dynamicTokenBudget: SAVE_FACT_DEFAULTS.dynamicTokenBudget,
            categories: { identity: true, family: true, realm: true, war: false, activity: true, location: true, court: true },
            directRealmEnabled: true,
            diagnosticsEnabled: false
        });
    });

    it('treats undefined config as fully defaulted', () => {
        expect(buildSaveFactSettings(undefined).enabled).toBe(false);
    });

    it('normalizes booleans strictly: truthy non-true values mean false', () => {
        const settings = buildSaveFactSettings({
            // Deliberately malformed input: truthy non-true values must mean false.
            saveFacts: { enabled: 1, parserEnabled: 'yes', promptEnabled: true } as any
        });
        expect(settings.enabled).toBe(false);
        expect(settings.parserEnabled).toBe(false);
        expect(settings.promptEnabled).toBe(false);
    });

    it('clamps out-of-range numeric settings', () => {
        const settings = buildSaveFactSettings({
            saveFacts: {
                prepareDeadlineMs: 999999,
                parserTimeoutMs: -5,
                pollIntervalMs: 0,
                baselineTokenBudget: 100000,
                dynamicTokenBudget: Number.NaN
            }
        });
        expect(settings.prepareDeadlineMs).toBe(60000);
        expect(settings.parserTimeoutMs).toBe(500);
        expect(settings.pollIntervalMs).toBe(50);
        expect(settings.baselineTokenBudget).toBe(2000);
        expect(settings.dynamicTokenBudget).toBe(SAVE_FACT_DEFAULTS.dynamicTokenBudget);
    });

    it('caps the parser timeout at the total preparation deadline', () => {
        const settings = buildSaveFactSettings({
            saveFacts: { prepareDeadlineMs: 2000, parserTimeoutMs: 30000 }
        });
        expect(settings.parserTimeoutMs).toBe(2000);
    });

    it('forces effective promptEnabled=false when the parser is disabled', () => {
        const settings = buildSaveFactSettings({
            saveFacts: { enabled: true, parserEnabled: false, promptEnabled: true }
        });
        expect(settings.enabled).toBe(true);
        expect(settings.parserEnabled).toBe(false);
        expect(settings.promptEnabled).toBe(false);
    });

    it('forces parserEnabled=false when the feature itself is disabled', () => {
        const settings = buildSaveFactSettings({
            saveFacts: { enabled: false, parserEnabled: true, promptEnabled: true }
        });
        expect(settings.parserEnabled).toBe(false);
        expect(settings.promptEnabled).toBe(false);
    });

    it('keeps only allowlisted categories and normalizes their flags strictly', () => {
        const settings = buildSaveFactSettings({
            saveFacts: {
                // Deliberately malformed input (non-boolean flag, unknown key).
                categories: { identity: false, family: true, realm: 1, secrets: true } as any
            }
        });
        expect(settings.categories).toEqual({ identity: false, family: true, realm: false, war: false, activity: true, location: true, court: true });
        expect('secrets' in settings.categories).toBe(false);
    });

    it('never takes the snapshot file name from user text', () => {
        const settings = buildSaveFactSettings({
            saveFacts: { snapshotFileName: '../../evil.ck3' } as never
        });
        expect(settings.snapshotFileName).toBe('votc_context.ck3');
    });
});

describe('createEmptyConversationFactContext', () => {
    it('produces a frozen empty context with the given status and code', () => {
        const context = createEmptyConversationFactContext('timeout', 'PARSER_TIMEOUT');
        expect(context.snapshotStatus).toBe('timeout');
        expect(context.snapshot).toBeUndefined();
        expect(context.factIndex).toBeUndefined();
        expect(context.baselineFacts).toEqual([]);
        expect(context.diagnostics.errorCode).toBe('PARSER_TIMEOUT');
        expect(context.diagnostics.warningCodes).toEqual([]);
        expect(Object.isFrozen(context.baselineFacts)).toBe(true);
        expect(Object.isFrozen(context.diagnostics.warningCodes)).toBe(true);
        expect(Object.isFrozen(context.diagnostics)).toBe(true);
        expect(Object.isFrozen(context)).toBe(true);
    });

    it('works without an error code for non-error statuses', () => {
        const context = createEmptyConversationFactContext('disabled');
        expect(context.diagnostics.errorCode).toBeUndefined();
        expect(context.baselineFacts).toHaveLength(0);
    });
});
