/**
 * Strict save snapshot identity validator (implementation plan Task 11
 * steps 5-6).
 *
 * A sidecar probe response is only accepted as "this is the snapshot the
 * conversation is waiting for" when EVERY checkpoint passes, in a fixed
 * order:
 *
 * 1. protocol / operation / status — protocol v1, the operation the caller
 *    requested, result status `ok`, no error block;
 * 2. player decimal character ID — exact string equality with the expected
 *    decimal ID (`SAVE_PLAYER_MISMATCH`);
 * 3. campaign identity — all four campaign id parts equal to the
 *    `requireCampaignIdentity` result captured at operation start
 *    (`SAVE_CAMPAIGN_MISMATCH`);
 * 4. snapshot sequence (`SAVE_SEQUENCE_MISMATCH`);
 * 5. snapshot slot (`SAVE_SLOT_MISMATCH`);
 * 6. numeric game date — exact integer equality (`SAVE_DATE_MISMATCH`).
 *
 * Any failure returns a typed mismatch code and NO facts: the validator
 * never returns payload data alongside a failure. The display date is
 * diagnostics-only and is never used as a lenient substitute for the
 * numeric date. Envelope-level failures (wrong protocol/operation/status,
 * missing identity block) collapse to `SAVE_IDENTITY_MISMATCH` because no
 * more specific claim can be made about an envelope that is not a valid
 * answer to the request.
 *
 * Step 6 (suspicious state) is covered by `assessParticipantPresence`: when
 * the sidecar reports `PARTICIPANT_NOT_FOUND` warnings, a missing
 * conversation participant degrades to a warning (the identity itself can
 * still hold; the participant's facts are refused downstream), while a
 * missing PLAYER contradicts the identity and rejects the whole snapshot.
 *
 * This module is pure: no IO, no timers, no logging, and it never throws.
 */

import type {
    SaveFactExtractionRequestV1,
    SaveFactExtractionResultV1,
    SaveFactOperation
} from './saveFactTypes';

// ---------------------------------------------------------------------------
// Codes and result types
// ---------------------------------------------------------------------------

export const SAVE_IDENTITY_MISMATCH_CODES = [
    'SAVE_IDENTITY_MISMATCH',
    'SAVE_PLAYER_MISMATCH',
    'SAVE_CAMPAIGN_MISMATCH',
    'SAVE_SEQUENCE_MISMATCH',
    'SAVE_SLOT_MISMATCH',
    'SAVE_DATE_MISMATCH'
] as const;
export type SaveIdentityMismatchCode = (typeof SAVE_IDENTITY_MISMATCH_CODES)[number];

/**
 * The identity the conversation captured at operation start (via
 * `requireCampaignIdentity` plus the save snapshot protocol tail). This is
 * exactly the `expected` block of the sidecar request DTO, so the request
 * and the validation can never disagree about what was asked for.
 */
export type ExpectedSnapshotIdentity = SaveFactExtractionRequestV1['expected'];

/** The verified identity, returned only when every checkpoint passed. */
export interface VerifiedSnapshotIdentity {
    playerCharacterId: string;
    campaignIdParts: [number, number, number, number];
    snapshotSequence: number;
    snapshotSlot: number;
    gameDateNumeric: number;
    /** Diagnostics-only; never compared. */
    gameDateDisplay?: string;
}

export type SaveIdentityValidationResult =
    | { ok: true; identity: VerifiedSnapshotIdentity }
    | { ok: false; code: SaveIdentityMismatchCode; detail: string };

// ---------------------------------------------------------------------------
// Identity validation (plan step 5)
// ---------------------------------------------------------------------------

function mismatch(code: SaveIdentityMismatchCode, detail: string): SaveIdentityValidationResult {
    return { ok: false, code, detail };
}

function campaignPartsEqual(
    actual: readonly number[],
    expected: readonly number[]
): boolean {
    return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

/**
 * Validate a sidecar response against the expected identity. The checks run
 * in the fixed plan order; the first failure wins so the reported code is
 * deterministic.
 *
 * @param response schema-validated sidecar response (probe or extract).
 * @param expected identity captured at operation start.
 * @param expectedOperation the operation the request asked for; the
 *        response must answer the same operation.
 */
export function validateSnapshotIdentity(
    response: SaveFactExtractionResultV1,
    expected: ExpectedSnapshotIdentity,
    expectedOperation: SaveFactOperation
): SaveIdentityValidationResult {
    // 1. protocol / operation / status.
    if (response.protocolVersion !== 2) {
        return mismatch(
            'SAVE_IDENTITY_MISMATCH',
            `unsupported response protocol version ${String(response.protocolVersion)}`
        );
    }
    if (response.operation !== expectedOperation) {
        return mismatch(
            'SAVE_IDENTITY_MISMATCH',
            `response operation '${response.operation}' does not match request '${expectedOperation}'`
        );
    }
    if (response.status !== 'ok' || response.error !== undefined) {
        return mismatch(
            'SAVE_IDENTITY_MISMATCH',
            `response status is '${response.status}'${response.error ? ` with error ${response.error.code}` : ''}`
        );
    }

    const identity = response.identity;
    if (!identity) {
        return mismatch('SAVE_IDENTITY_MISMATCH', 'response carries no identity block');
    }

    // 2. player decimal character ID.
    if (identity.playerCharacterId === undefined || identity.playerCharacterId !== expected.playerCharacterId) {
        return mismatch(
            'SAVE_PLAYER_MISMATCH',
            `expected player '${expected.playerCharacterId}', got '${String(identity.playerCharacterId)}'`
        );
    }

    // 3. campaign identity (four parts, exact).
    if (
        identity.campaignIdParts === undefined ||
        !campaignPartsEqual(identity.campaignIdParts, expected.campaignIdParts)
    ) {
        return mismatch(
            'SAVE_CAMPAIGN_MISMATCH',
            `expected campaign parts [${expected.campaignIdParts.join(',')}], got [${(identity.campaignIdParts ?? []).join(',')}]`
        );
    }

    // 4. snapshot sequence.
    if (identity.snapshotSequence === undefined || identity.snapshotSequence !== expected.snapshotSequence) {
        return mismatch(
            'SAVE_SEQUENCE_MISMATCH',
            `expected sequence ${expected.snapshotSequence}, got ${String(identity.snapshotSequence)}`
        );
    }

    // 5. snapshot slot.
    if (identity.snapshotSlot === undefined || identity.snapshotSlot !== expected.snapshotSlot) {
        return mismatch(
            'SAVE_SLOT_MISMATCH',
            `expected slot ${expected.snapshotSlot}, got ${String(identity.snapshotSlot)}`
        );
    }

    // 6. numeric game date, exact equality. The display date is
    //    diagnostics-only and is never used as a substitute.
    if (identity.gameDateNumeric === undefined || identity.gameDateNumeric !== expected.gameDateNumeric) {
        return mismatch(
            'SAVE_DATE_MISMATCH',
            `expected game date ${expected.gameDateNumeric}, got ${String(identity.gameDateNumeric)}`
        );
    }

    return {
        ok: true,
        identity: {
            playerCharacterId: identity.playerCharacterId,
            campaignIdParts: identity.campaignIdParts,
            snapshotSequence: identity.snapshotSequence,
            snapshotSlot: identity.snapshotSlot,
            gameDateNumeric: identity.gameDateNumeric,
            gameDateDisplay: identity.gameDateDisplay
        }
    };
}

// ---------------------------------------------------------------------------
// Suspicious participant state (plan step 6)
// ---------------------------------------------------------------------------

/** Sidecar warning code: a conversation participant is absent from the save. */
export const SAVE_PARTICIPANT_NOT_FOUND_WARNING = 'PARTICIPANT_NOT_FOUND';

/** Cap on reported missing participant ids (diagnostics stay bounded). */
export const SAVE_MAX_MISSING_PARTICIPANT_IDS = 100;

export type SaveParticipantPresenceAssessment =
    | { status: 'clear' }
    | {
        status: 'warning';
        warningCode: typeof SAVE_PARTICIPANT_NOT_FOUND_WARNING;
        missingParticipantIds: readonly string[];
    }
    | { status: 'reject'; code: 'SAVE_PLAYER_MISMATCH'; detail: string };

/**
 * Assess `PARTICIPANT_NOT_FOUND` warnings on an otherwise identity-valid
 * response. The sidecar puts the missing character's decimal ID in the
 * warning's `category` field.
 *
 * - No such warning -> `clear`.
 * - One or more missing participants -> `warning`: the snapshot identity
 *   itself can still hold, but every fact about the missing participants
 *   must be refused downstream and the snapshot carries the warning.
 * - The PLAYER itself is missing -> `reject`: the save contradicts the
 *   conversation's own identity, so the whole snapshot is refused.
 */
export function assessParticipantPresence(
    response: SaveFactExtractionResultV1,
    expected: { playerCharacterId: string }
): SaveParticipantPresenceAssessment {
    const missing = new Set<string>();
    for (const warning of response.warnings) {
        if (warning.code !== SAVE_PARTICIPANT_NOT_FOUND_WARNING) continue;
        if (typeof warning.category === 'string' && warning.category !== '') {
            if (missing.size < SAVE_MAX_MISSING_PARTICIPANT_IDS) {
                missing.add(warning.category);
            }
        }
    }
    if (missing.size === 0) {
        return { status: 'clear' };
    }
    if (missing.has(expected.playerCharacterId)) {
        return {
            status: 'reject',
            code: 'SAVE_PLAYER_MISMATCH',
            detail: `player '${expected.playerCharacterId}' is absent from the save snapshot`
        };
    }
    return {
        status: 'warning',
        warningCode: SAVE_PARTICIPANT_NOT_FOUND_WARNING,
        missingParticipantIds: Object.freeze([...missing].sort())
    };
}
