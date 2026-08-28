/**
 * Task 19 coverage: buildSaveFactSettings normalization (steps 1-2, via the
 * `saveFacts` settings bag — 2CE Config has no flat save-fact keys yet) and
 * the renderer-safe diagnostics DTO builder (step 6).
 */

import {
    buildSaveFactSettings,
    SAVE_FACT_DEFAULTS
} from '../../../src/main/saveFacts/saveFactSettings';
import {
    buildSaveFactDiagnosticsDto,
    createEmptyConversationFactContext
} from '../../../src/main/saveFacts/saveFactTypes';
import type {
    ConversationFactContext,
    GameFact
} from '../../../src/main/saveFacts/saveFactTypes';
import { SAVE_SNAPSHOT_FIXED_FILE_NAME } from '../../../src/shared/gameData/saveSnapshotProtocol';
import type { Config } from '../../../src/shared/Config';

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
        visibility: 'public',
        priority: 0,
        sensitivity: 'normal',
        provenance: {},
        ...overrides
    };
}

describe('buildSaveFactSettings via the saveFacts settings bag', () => {
    it('keeps every default for an old config without the new keys', () => {
        const settings = buildSaveFactSettings({} as Partial<Config>);
        expect(settings.enabled).toBe(false);
        expect(settings.parserEnabled).toBe(false);
        expect(settings.promptEnabled).toBe(false);
        expect(settings.prepareDeadlineMs).toBe(SAVE_FACT_DEFAULTS.prepareDeadlineMs);
        expect(settings.parserTimeoutMs).toBe(SAVE_FACT_DEFAULTS.parserTimeoutMs);
        expect(settings.baselineTokenBudget).toBe(SAVE_FACT_DEFAULTS.baselineTokenBudget);
        expect(settings.dynamicTokenBudget).toBe(SAVE_FACT_DEFAULTS.dynamicTokenBudget);
        expect(settings.diagnosticsEnabled).toBe(false);
        expect(settings.categories).toEqual({ identity: true, family: true, realm: true, war: false, activity: true, location: true, court: true });
        expect(settings.snapshotFileName).toBe(SAVE_SNAPSHOT_FIXED_FILE_NAME);
    });

    it('maps the parsing/prompt/diagnostics flags through the bag', () => {
        const settings = buildSaveFactSettings({
            saveFacts: {
                enabled: true,
                parserEnabled: true,
                promptEnabled: true,
                diagnosticsEnabled: true
            }
        });
        expect(settings.enabled).toBe(true);
        expect(settings.parserEnabled).toBe(true);
        expect(settings.promptEnabled).toBe(true);
        expect(settings.diagnosticsEnabled).toBe(true);
    });

    it('forces prompt off when parsing is disabled', () => {
        const settings = buildSaveFactSettings({
            saveFacts: { promptEnabled: true }
        });
        expect(settings.parserEnabled).toBe(false);
        expect(settings.promptEnabled).toBe(false);
    });

    it('clamps timeouts and token budgets, capping the parser timeout by the deadline', () => {
        const settings = buildSaveFactSettings({
            saveFacts: {
                enabled: true,
                parserEnabled: true,
                prepareDeadlineMs: 999999,
                parserTimeoutMs: 999999,
                baselineTokenBudget: -50,
                dynamicTokenBudget: 5000
            }
        });
        expect(settings.prepareDeadlineMs).toBe(60000);
        expect(settings.parserTimeoutMs).toBe(30000);
        expect(settings.baselineTokenBudget).toBe(0);
        expect(settings.dynamicTokenBudget).toBe(2000);

        const smallDeadline = buildSaveFactSettings({
            saveFacts: {
                enabled: true,
                parserEnabled: true,
                prepareDeadlineMs: 5000,
                parserTimeoutMs: 30000
            }
        });
        expect(smallDeadline.parserTimeoutMs).toBe(5000);
    });

    it('maps the family/realm category toggles and defaults them on', () => {
        const settings = buildSaveFactSettings({
            saveFacts: {
                enabled: true,
                parserEnabled: true,
                categories: { family: false }
            }
        });
        expect(settings.categories).toEqual({ identity: true, family: false, realm: true, war: false, activity: true, location: true, court: true });
    });

    it('keeps war category opt-in even when the parser and prompt are enabled', () => {
        const disabled = buildSaveFactSettings({ saveFacts: { enabled: true, parserEnabled: true, promptEnabled: true } });
        expect(disabled.categories.war).toBe(false);
        const nestedEnabled = buildSaveFactSettings({
            saveFacts: { enabled: true, parserEnabled: true, promptEnabled: true, categories: { war: true } }
        });
        expect(nestedEnabled.categories.war).toBe(true);
    });
});

describe('buildSaveFactDiagnosticsDto', () => {
    it('summarizes a degraded context without optional fields', () => {
        const dto = buildSaveFactDiagnosticsDto(createEmptyConversationFactContext('disabled'));
        expect(dto.status).toBe('disabled');
        expect(dto.code).toBeUndefined();
        expect(dto.sourceFormat).toBeUndefined();
        expect(dto.factCount).toBe(0);
        expect(dto.entityCount).toBe(0);
        expect(dto.categoryCounts).toEqual({});
        expect(dto.injectedFactCount).toBe(0);
        expect(dto.injectedTokenCount).toBe(0);
        expect(dto.warningCodes).toEqual([]);
    });

    it('aggregates an available context and never leaks IDs or fingerprints', () => {
        const context: ConversationFactContext = {
            snapshotStatus: 'available',
            snapshot: {
                snapshotId: 'snap-secret',
                sourceFingerprint: 'fp-secret',
                sourceFormat: 'zip_text',
                ck3Version: '1.13.0',
                parserVersion: '0.1.0',
                factSchemaVersion: 1
            },
            baselineFacts: [
                makeFact(),
                makeFact({ id: 'fact-2', category: 'realm', predicate: 'character.liege' }),
                makeFact({
                    id: 'fact-3',
                    subject: { type: 'character', id: '3003' },
                    object: undefined,
                    asOfGameDate: { numeric: 500000, display: '1135.6.1' }
                })
            ],
            diagnostics: { warningCodes: ['EXTRACT_PARTIAL'] }
        };
        const dto = buildSaveFactDiagnosticsDto(context);
        expect(dto.status).toBe('available');
        expect(dto.sourceFormat).toBe('zip_text');
        expect(dto.ck3Version).toBe('1.13.0');
        expect(dto.parserVersion).toBe('0.1.0');
        expect(dto.factCount).toBe(3);
        // characters 1001, 2002, 3003 — the shared 1001/2002 pair is deduped.
        expect(dto.entityCount).toBe(3);
        expect(dto.categoryCounts).toEqual({ family: 2, realm: 1 });
        expect(dto.asOfGameDateDisplay).toBe('1135.6.1');
        expect(dto.warningCodes).toEqual(['EXTRACT_PARTIAL']);
        expect(JSON.stringify(dto)).not.toContain('snap-secret');
        expect(JSON.stringify(dto)).not.toContain('fp-secret');
    });
});
