import {
    assessParticipantPresence,
    SAVE_PARTICIPANT_NOT_FOUND_WARNING,
    validateSnapshotIdentity,
    type ExpectedSnapshotIdentity
} from '../../../src/main/saveFacts/SaveIdentityValidator';
import type { SaveFactExtractionResultV1 } from '../../../src/main/saveFacts/saveFactTypes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXPECTED: ExpectedSnapshotIdentity = {
    playerCharacterId: '12345',
    participantCharacterIds: ['12345', '678'],
    gameDateNumeric: 320000,
    campaignId: 'camp.1',
    campaignIdParts: [1, 2, 3, 4],
    snapshotSequence: 42,
    snapshotSlot: 0
};

type IdentityBlock = NonNullable<SaveFactExtractionResultV1['identity']>;

function makeIdentity(overrides?: Partial<IdentityBlock>): IdentityBlock {
    return {
        playerCharacterId: '12345',
        gameDateNumeric: 320000,
        gameDateDisplay: '1100.1.1',
        campaignIdParts: [1, 2, 3, 4],
        snapshotSequence: 42,
        snapshotSlot: 0,
        ...overrides
    };
}

function makeResponse(overrides?: {
    identity?: IdentityBlock | undefined;
    dropIdentity?: boolean;
    status?: SaveFactExtractionResultV1['status'];
    operation?: SaveFactExtractionResultV1['operation'];
    protocolVersion?: number;
    withError?: boolean;
    warnings?: Array<{ code: string; category?: string }>;
}): SaveFactExtractionResultV1 {
    const response: SaveFactExtractionResultV1 = {
        protocolVersion: (overrides?.protocolVersion ?? 2) as 2,
        operation: overrides?.operation ?? 'probe',
        status: overrides?.status ?? 'ok',
        manifest: {
            snapshotId: 'snap.1',
            sourceFingerprint: 'fp.1',
            sourceFormat: 'unified_text',
            parserVersion: '1.0.0',
            factSchemaVersion: 1
        },
        identity: overrides?.dropIdentity ? undefined : (overrides?.identity ?? makeIdentity()),
        entities: [],
        facts: [],
        warnings: overrides?.warnings ?? [],
        error: overrides?.withError ? { code: 'SAVE_PARSE_FAILED' } : undefined,
        metrics: { inputBytes: 100, durationMs: 5, emittedFacts: 0, emittedEntities: 0 }
    };
    return response;
}

// ---------------------------------------------------------------------------
// validateSnapshotIdentity
// ---------------------------------------------------------------------------

describe('validateSnapshotIdentity', () => {
    it('accepts a fully matching probe identity', () => {
        const result = validateSnapshotIdentity(makeResponse(), EXPECTED, 'probe');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.identity.playerCharacterId).toBe('12345');
            expect(result.identity.campaignIdParts).toEqual([1, 2, 3, 4]);
            expect(result.identity.snapshotSequence).toBe(42);
            expect(result.identity.snapshotSlot).toBe(0);
            expect(result.identity.gameDateNumeric).toBe(320000);
            expect(result.identity.gameDateDisplay).toBe('1100.1.1');
        }
    });

    it('rejects a future protocol version as SAVE_IDENTITY_MISMATCH', () => {
        const result = validateSnapshotIdentity(makeResponse({ protocolVersion: 3 }), EXPECTED, 'probe');
        expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
    });

    it('rejects an operation mismatch as SAVE_IDENTITY_MISMATCH', () => {
        const result = validateSnapshotIdentity(makeResponse({ operation: 'extract' }), EXPECTED, 'probe');
        expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
    });

    it('rejects a non-ok status as SAVE_IDENTITY_MISMATCH', () => {
        for (const status of ['partial', 'unsupported', 'invalid'] as const) {
            const result = validateSnapshotIdentity(makeResponse({ status }), EXPECTED, 'probe');
            expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
        }
    });

    it('rejects a response carrying an error block', () => {
        const result = validateSnapshotIdentity(makeResponse({ withError: true }), EXPECTED, 'probe');
        expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
    });

    it('rejects a response without an identity block', () => {
        const result = validateSnapshotIdentity(makeResponse({ dropIdentity: true }), EXPECTED, 'probe');
        expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
    });

    it('envelope failures win over field mismatches (fixed order)', () => {
        const response = makeResponse({
            operation: 'extract',
            identity: makeIdentity({ playerCharacterId: '99999' })
        });
        const result = validateSnapshotIdentity(response, EXPECTED, 'probe');
        expect(result).toMatchObject({ ok: false, code: 'SAVE_IDENTITY_MISMATCH' });
    });

    it('rejects a wrong player as SAVE_PLAYER_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ playerCharacterId: '99999' }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_PLAYER_MISMATCH' });
    });

    it('rejects a missing player id as SAVE_PLAYER_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ playerCharacterId: undefined }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_PLAYER_MISMATCH' });
    });

    it('player mismatch wins over campaign mismatch (fixed order)', () => {
        const result = validateSnapshotIdentity(
            makeResponse({
                identity: makeIdentity({ playerCharacterId: '99999', campaignIdParts: [9, 9, 9, 9] })
            }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_PLAYER_MISMATCH' });
    });

    it('rejects a wrong campaign part as SAVE_CAMPAIGN_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ campaignIdParts: [1, 2, 3, 5] }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_CAMPAIGN_MISMATCH' });
    });

    it('campaign mismatch wins over sequence mismatch (fixed order)', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ campaignIdParts: [9, 9, 9, 9], snapshotSequence: 41 }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_CAMPAIGN_MISMATCH' });
    });

    it('rejects an old sequence as SAVE_SEQUENCE_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ snapshotSequence: 41 }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_SEQUENCE_MISMATCH' });
    });

    it('sequence mismatch wins over slot and date mismatches (fixed order)', () => {
        const result = validateSnapshotIdentity(
            makeResponse({
                identity: makeIdentity({ snapshotSequence: 41, snapshotSlot: 1, gameDateNumeric: 1 })
            }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_SEQUENCE_MISMATCH' });
    });

    it('rejects a wrong slot as SAVE_SLOT_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ snapshotSlot: 1 }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_SLOT_MISMATCH' });
    });

    it('slot mismatch wins over date mismatch (fixed order)', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ snapshotSlot: 1, gameDateNumeric: 1 }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_SLOT_MISMATCH' });
    });

    it('rejects a wrong numeric game date as SAVE_DATE_MISMATCH', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ gameDateNumeric: 320001 }) }),
            EXPECTED,
            'probe'
        );
        expect(result).toMatchObject({ ok: false, code: 'SAVE_DATE_MISMATCH' });
    });

    it('ignores the display date: different display with equal numeric date still matches', () => {
        const result = validateSnapshotIdentity(
            makeResponse({ identity: makeIdentity({ gameDateDisplay: 'totally different display' }) }),
            EXPECTED,
            'probe'
        );
        expect(result.ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// assessParticipantPresence
// ---------------------------------------------------------------------------

describe('assessParticipantPresence', () => {
    it('is clear when no participant warnings are present', () => {
        const result = assessParticipantPresence(makeResponse(), EXPECTED);
        expect(result).toEqual({ status: 'clear' });
    });

    it('ignores unrelated warning codes', () => {
        const result = assessParticipantPresence(
            makeResponse({ warnings: [{ code: 'SOME_OTHER_WARNING', category: '678' }] }),
            EXPECTED
        );
        expect(result).toEqual({ status: 'clear' });
    });

    it('returns a warning when a conversation participant is missing', () => {
        const result = assessParticipantPresence(
            makeResponse({ warnings: [{ code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '678' }] }),
            EXPECTED
        );
        expect(result).toMatchObject({
            status: 'warning',
            warningCode: SAVE_PARTICIPANT_NOT_FOUND_WARNING,
            missingParticipantIds: ['678']
        });
    });

    it('deduplicates and sorts missing participant ids', () => {
        const result = assessParticipantPresence(
            makeResponse({
                warnings: [
                    { code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '900' },
                    { code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '678' },
                    { code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '678' }
                ]
            }),
            EXPECTED
        );
        expect(result).toMatchObject({ status: 'warning', missingParticipantIds: ['678', '900'] });
    });

    it('rejects the whole snapshot when the player itself is missing', () => {
        const result = assessParticipantPresence(
            makeResponse({
                warnings: [
                    { code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '678' },
                    { code: SAVE_PARTICIPANT_NOT_FOUND_WARNING, category: '12345' }
                ]
            }),
            EXPECTED
        );
        expect(result).toMatchObject({ status: 'reject', code: 'SAVE_PLAYER_MISMATCH' });
    });
});
