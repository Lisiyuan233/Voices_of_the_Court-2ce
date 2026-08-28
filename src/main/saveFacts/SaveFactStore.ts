/**
 * Campaign/player scoped save-fact cache store (implementation plan Task 12).
 *
 * Owns every file under
 *   <userData>/votc_data/campaigns/<campaignId>/players/<playerId>/save_facts/
 * and nothing else. In particular it NEVER touches `<userFolderPath>/save games`
 * or any raw `.ck3` location; the persisted record contains no raw save path,
 * no raw save subtree, no prompt content and no secrets/schemes.
 *
 * Responsibilities (plan Task 12 steps 2-7):
 * - step 2: persisted `current.json` schema (`PersistedSaveFactSnapshotV1`).
 * - step 3: atomic writes via `writeJsonAtomic` (tmp/fsync/rename, never
 *   deletes the previous `current.json` on failure) plus a containment check
 *   that the resolved target stays inside this identity's `save_facts/` dir.
 * - step 4: cache hit only when source fingerprint, parser/fact schema
 *   versions, participant IDs, categories, limits and
 *   campaign/player/date/sequence/slot all match (extraction request hash).
 * - step 5: every cached record carries checkpoint/timeline provenance and
 *   historical snapshots are filtered through `isRecordVisibleForContext`, so
 *   sibling/descendant-branch snapshots never enter the current conversation.
 * - step 6: retention — default mode maintains `current.json` only; the
 *   diagnostics mode additionally keeps the newest 3 compact snapshots and
 *   only ever deletes files inside `save_facts/snapshots/` that match the
 *   VOTC snapshot naming AND the persisted schema. Corrupt cache files are
 *   quarantined as `.corrupt.<timestamp>` siblings, never treated as an
 *   empty-but-successful load.
 * - step 7: entity-name cache with campaign/player/timeline provenance. Only
 *   names observed via live GameData or a verified literal source are stored;
 *   raw localization keys (`k_*`, `dynn_*`, `ERROR:*`) never become display
 *   names and never overwrite a good name.
 *
 * Validator note: `saveFactSchemas.ts` only validates the sidecar wire
 * response (`SaveFactExtractionResultV1`). The persisted `current.json` is a
 * different document (adds checkpoint/timeline provenance, request hash,
 * createdAt, ...), so this module carries its own explicit whitelist
 * validator (`validatePersistedSaveFactSnapshot`) instead of reusing the wire
 * validator.
 */

import fs from 'fs';
import path from 'path';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity';
import {
    saveFactsCurrentPath,
    saveFactsDir,
    saveFactsEntityNamesPath,
    saveFactsSnapshotsDir
} from '../campaignDataPaths';
// P5b deferred (verify/session/delta/agency): 1.x imported the sync atomic
// writer from `../promptWorkbench/atomicJson`, a module 2CE does not have.
// 2CE's shared writers have different contracts (history/historyAtomicJson is
// async with swap-manifest semantics; chronicle/chronicleAtomicJson asserts
// chronicle-dir containment), so the save-fact store keeps the 1.x
// tmp/fsync/rename protocol via the local `writeJsonAtomicSync` helper below.
import { logicalRequestHash } from '../promptWorkbench/canonicalJson';
import { isRecordVisibleForContext } from '../timelineManager';
import type { TimelineRegistry } from '../timelineManager';
import {
    ENTITY_REF_TYPES,
    SAVE_FACT_CATEGORIES,
    SAVE_FACT_PREDICATES,
    SAVE_FACT_SOURCE_PATHS,
    SAVE_SOURCE_FORMATS
} from './saveFactTypes';
import type {
    CanonicalEntityV1,
    ExtractedGameFactV1,
    SaveFactCategory,
    SaveFactExtractionRequestV1,
    SaveSnapshotManifest
} from './saveFactTypes';
import { SAVE_FACT_ID_PATTERN } from './saveFactSchemas';
import {
    SaveFactPersistenceQueue,
    type SaveFactPersistenceQueueOptions,
    type SaveFactPersistenceWarningCode
} from './SaveFactPersistenceQueue';

// P5b deferred (verify/session/delta/agency): 1.x imported this bound from
// `shared/conversationJoinTypes` (a module 2CE does not have). The
// joinCandidates field itself still flows harmlessly through the extraction
// JSON and the persisted record, so only the constant is inlined (value
// identical to 1.x `JOIN_CANDIDATES_MAX = 512`).
const JOIN_CANDIDATES_MAX = 512;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SaveFactStoreErrorCode =
    | 'PATH_ESCAPE'
    | 'WRITE_FAILED';

export class SaveFactStoreError extends Error {
    readonly code: SaveFactStoreErrorCode;

    constructor(code: SaveFactStoreErrorCode, message: string) {
        super(message);
        this.name = 'SaveFactStoreError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Persisted schema (plan Task 12 step 2)
// ---------------------------------------------------------------------------

export const PERSISTED_SAVE_FACT_SCHEMA_VERSION = 1 as const;
/** Wire responses are capped at 2 MiB; charge that full cap without serializing on the prepare path. */
const SCHEDULED_CURRENT_ESTIMATED_BYTES = 2 * 1024 * 1024;

/** Checkpoint/timeline provenance attached to every cached record. */
export interface SaveFactCheckpointProvenance {
    timelineNodeId?: string;
    checkpointEpoch?: number;
}

/**
 * Identity fields verified against the live GameData context before the
 * snapshot was accepted (plan Task 11). `playerCharacterId`,
 * `gameDateNumeric`, `snapshotSequence` and `snapshotSlot` are required: the
 * cache key compare (step 4) reads them back from the persisted record.
 */
export interface VerifiedSaveIdentity {
    playerCharacterId: string;
    gameDateNumeric: number;
    gameDateDisplay?: string;
    campaignIdParts?: [number, number, number, number];
    snapshotSequence: number;
    snapshotSlot: 0 | 1;
    scriptVariableScale?: number;
}

/**
 * `current.json` document. Compact entities/facts use the sidecar DTO shapes
 * (already registry-predicate allowlisted); timeline provenance lives at the
 * record level because the sidecar cannot know it. Deliberately absent: raw
 * `.ck3` path, raw save subtree, prompt content, secrets/schemes.
 */
export interface PersistedSaveFactSnapshotV1 {
    schemaVersion: typeof PERSISTED_SAVE_FACT_SCHEMA_VERSION;
    campaignId: string;
    playerId: string;
    checkpoint: SaveFactCheckpointProvenance;
    sourceFingerprint: string;
    extractionRequestHash: string;
    manifest: SaveSnapshotManifest;
    verifiedIdentity: VerifiedSaveIdentity;
    entities: CanonicalEntityV1[];
    facts: ExtractedGameFactV1[];
    /** Missing on legacy cache entries; delta consumers must treat that as incomplete. */
    extractionStatus?: 'ok' | 'partial';
    /**
     * Ordered decimal CK3 runtime ids of the same-location join candidates
     * (Plan C Task 2b / Task 3A). Optional additive transport for the join
     * coordinator; absent on legacy cache entries, which degrade to
     * `candidates_missing` (fail-closed). Never renderer-facing.
     */
    joinCandidates?: string[];
    /** ISO-8601 creation timestamp of this cache record. */
    createdAt: string;
    parserVersion: string;
    factSchemaVersion: 1;
}

/**
 * Every component that must match for a cache hit (plan Task 12 step 4).
 * Participant IDs and categories are order-insensitive (sorted before
 * hashing); a different participant set must never reuse an incomplete
 * extraction just because the source fingerprint matches.
 */
export interface SaveFactCacheRequestKey {
    sourceFingerprint: string;
    parserVersion: string;
    factSchemaVersion: 1;
    participantCharacterIds: string[];
    categories: SaveFactCategory[];
    limits: SaveFactExtractionRequestV1['limits'];
    campaignId: string;
    playerCharacterId: string;
    gameDateNumeric: number;
    snapshotSequence: number;
    snapshotSlot: 0 | 1;
}

export interface SaveFactSnapshotInput {
    requestKey: SaveFactCacheRequestKey;
    manifest: SaveSnapshotManifest;
    verifiedIdentity: VerifiedSaveIdentity;
    entities: CanonicalEntityV1[];
    facts: ExtractedGameFactV1[];
    extractionStatus: 'ok' | 'partial';
    checkpoint: SaveFactCheckpointProvenance;
    /** Optional additive join-candidate transport (see PersistedSaveFactSnapshotV1). */
    joinCandidates?: readonly string[];
}

/**
 * sha256 over the canonical JSON of the full request key (participants and
 * categories sorted), using the shared canonical-JSON protocol so the hash is
 * stable across key insertion order and process restarts.
 */
export function computeExtractionRequestHash(key: SaveFactCacheRequestKey): string {
    return logicalRequestHash({
        sourceFingerprint: key.sourceFingerprint,
        parserVersion: key.parserVersion,
        factSchemaVersion: key.factSchemaVersion,
        participantCharacterIds: [...key.participantCharacterIds].sort(),
        categories: [...key.categories].sort(),
        limits: key.limits,
        campaignId: key.campaignId,
        playerCharacterId: key.playerCharacterId,
        gameDateNumeric: key.gameDateNumeric,
        snapshotSequence: key.snapshotSequence,
        snapshotSlot: key.snapshotSlot
    });
}

// ---------------------------------------------------------------------------
// Timeline visibility (plan Task 12 step 5)
// ---------------------------------------------------------------------------

export interface SaveFactTimelineContext {
    registry?: TimelineRegistry;
    currentNodeId?: string;
    checkpointEpoch?: number;
}

function isProvenanceVisible(
    provenance: SaveFactCheckpointProvenance,
    context?: SaveFactTimelineContext
): boolean {
    return isRecordVisibleForContext(
        context?.registry,
        context?.currentNodeId,
        {
            votcTimelineNodeId: provenance.timelineNodeId,
            votcCheckpointEpoch: provenance.checkpointEpoch
        },
        context?.checkpointEpoch
    );
}

// ---------------------------------------------------------------------------
// Persisted-record whitelist validator (plan Task 12 step 2 note)
// ---------------------------------------------------------------------------

export type PersistedSnapshotValidationResult =
    | { ok: true; value: PersistedSaveFactSnapshotV1 }
    | { ok: false; path: string; message: string };

type Obj = Record<string, unknown>;

class PersistedValidationError extends Error {
    readonly path: string;

    constructor(path: string, message: string) {
        super(`${path}: ${message}`);
        this.name = 'PersistedValidationError';
        this.path = path;
    }
}

function fail(path: string, message: string): never {
    throw new PersistedValidationError(path, message);
}

function isPlainObject(value: unknown): value is Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function requireObject(value: unknown, path: string, allowedKeys: readonly string[]): Obj {
    if (!isPlainObject(value)) fail(path, 'expected a plain object');
    for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) {
            fail(path, `unknown field "${key}" is not part of the persisted schema`);
        }
    }
    return value;
}

function requireField(obj: Obj, key: string, path: string): unknown {
    const value = obj[key];
    if (value === undefined) fail(path, `missing required field "${key}"`);
    return value;
}

function requireString(value: unknown, path: string, maxLength = 1024): string {
    if (typeof value !== 'string') fail(path, 'expected a string');
    if (value.length === 0) fail(path, 'string must not be empty');
    if (value.length > maxLength) fail(path, `string length ${value.length} exceeds maximum ${maxLength}`);
    return value;
}

function optionalString(value: unknown, path: string, maxLength = 1024): string | undefined {
    if (value === undefined) return undefined;
    return requireString(value, path, maxLength);
}

function requireId(value: unknown, path: string): string {
    const str = requireString(value, path);
    if (!SAVE_FACT_ID_PATTERN.test(str)) {
        fail(path, `value does not match the id pattern: ${JSON.stringify(str.slice(0, 64))}`);
    }
    return str;
}

function optionalId(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    return requireId(value, path);
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        fail(path, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
    }
    return value as T;
}

function requireFiniteNumber(value: unknown, path: string): number {
    if (typeof value !== 'number') fail(path, 'expected a number');
    if (!Number.isFinite(value)) fail(path, 'number must be finite');
    return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
    const num = requireFiniteNumber(value, path);
    if (!Number.isSafeInteger(num)) fail(path, 'expected a safe integer');
    if (num < min || num > max) fail(path, `value ${num} is outside the allowed range ${min}..${max}`);
    return num;
}

function optionalInteger(value: unknown, path: string, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    return requireInteger(value, path, min, max);
}

function requireArray(value: unknown, path: string, maxLength: number): unknown[] {
    if (!Array.isArray(value)) fail(path, 'expected an array');
    if (value.length > maxLength) fail(path, `array length ${value.length} exceeds maximum ${maxLength}`);
    return value;
}

const PERSISTED_CHECKPOINT_KEYS = ['timelineNodeId', 'checkpointEpoch'] as const;

function validateCheckpoint(value: unknown, path: string): SaveFactCheckpointProvenance {
    const obj = requireObject(value, path, PERSISTED_CHECKPOINT_KEYS);
    const out: SaveFactCheckpointProvenance = {};
    const nodeId = optionalString(obj['timelineNodeId'], `${path}.timelineNodeId`, 256);
    if (nodeId !== undefined) out.timelineNodeId = nodeId;
    const epoch = optionalInteger(obj['checkpointEpoch'], `${path}.checkpointEpoch`, 0, Number.MAX_SAFE_INTEGER);
    if (epoch !== undefined) out.checkpointEpoch = epoch;
    return out;
}

const PERSISTED_MANIFEST_KEYS = [
    'snapshotId', 'sourceFingerprint', 'sourceFormat', 'ck3Version',
    'saveGameVersion', 'parserVersion', 'factSchemaVersion'
] as const;

function validatePersistedManifest(value: unknown, path: string): SaveSnapshotManifest {
    const obj = requireObject(value, path, PERSISTED_MANIFEST_KEYS);
    if (requireField(obj, 'factSchemaVersion', path) !== 1) {
        fail(`${path}.factSchemaVersion`, 'expected 1');
    }
    const manifest: SaveSnapshotManifest = {
        snapshotId: requireId(requireField(obj, 'snapshotId', path), `${path}.snapshotId`),
        sourceFingerprint: requireId(requireField(obj, 'sourceFingerprint', path), `${path}.sourceFingerprint`),
        sourceFormat: requireEnum(requireField(obj, 'sourceFormat', path), `${path}.sourceFormat`, SAVE_SOURCE_FORMATS),
        parserVersion: requireId(requireField(obj, 'parserVersion', path), `${path}.parserVersion`),
        factSchemaVersion: 1
    };
    const ck3Version = optionalId(obj['ck3Version'], `${path}.ck3Version`);
    if (ck3Version !== undefined) manifest.ck3Version = ck3Version;
    const saveGameVersion = optionalInteger(obj['saveGameVersion'], `${path}.saveGameVersion`, 0, Number.MAX_SAFE_INTEGER);
    if (saveGameVersion !== undefined) manifest.saveGameVersion = saveGameVersion;
    return manifest;
}

const PERSISTED_IDENTITY_KEYS = [
    'playerCharacterId', 'gameDateNumeric', 'gameDateDisplay', 'campaignIdParts',
    'snapshotSequence', 'snapshotSlot', 'scriptVariableScale'
] as const;

function validateVerifiedIdentity(value: unknown, path: string): VerifiedSaveIdentity {
    const obj = requireObject(value, path, PERSISTED_IDENTITY_KEYS);
    const identity: VerifiedSaveIdentity = {
        playerCharacterId: requireId(requireField(obj, 'playerCharacterId', path), `${path}.playerCharacterId`),
        gameDateNumeric: requireFiniteNumber(requireField(obj, 'gameDateNumeric', path), `${path}.gameDateNumeric`),
        snapshotSequence: requireInteger(requireField(obj, 'snapshotSequence', path), `${path}.snapshotSequence`, 1, Number.MAX_SAFE_INTEGER),
        snapshotSlot: requireInteger(requireField(obj, 'snapshotSlot', path), `${path}.snapshotSlot`, 0, 1) as 0 | 1
    };
    const display = optionalString(obj['gameDateDisplay'], `${path}.gameDateDisplay`, 128);
    if (display !== undefined) identity.gameDateDisplay = display;
    const partsRaw = obj['campaignIdParts'];
    if (partsRaw !== undefined) {
        const parts = requireArray(partsRaw, `${path}.campaignIdParts`, 4);
        if (parts.length !== 4) fail(`${path}.campaignIdParts`, 'expected exactly 4 entries');
        identity.campaignIdParts = parts.map((part, i) =>
            requireInteger(part, `${path}.campaignIdParts[${i}]`, 0, Number.MAX_SAFE_INTEGER)
        ) as [number, number, number, number];
    }
    const scale = obj['scriptVariableScale'];
    if (scale !== undefined) identity.scriptVariableScale = requireFiniteNumber(scale, `${path}.scriptVariableScale`);
    return identity;
}

const PERSISTED_ENTITY_KEYS = ['type', 'id', 'displayNameCandidate'] as const;
const PERSISTED_NAME_CANDIDATE_KEYS = ['kind', 'value'] as const;

function validatePersistedEntity(value: unknown, path: string): CanonicalEntityV1 {
    const obj = requireObject(value, path, PERSISTED_ENTITY_KEYS);
    const entity: CanonicalEntityV1 = {
        type: requireEnum(requireField(obj, 'type', path), `${path}.type`, ['character', 'title', 'war', 'activity', 'location'] as const),
        id: requireId(requireField(obj, 'id', path), `${path}.id`)
    };
    const candidateRaw = obj['displayNameCandidate'];
    if (candidateRaw !== undefined) {
        const candidate = requireObject(candidateRaw, `${path}.displayNameCandidate`, PERSISTED_NAME_CANDIDATE_KEYS);
        entity.displayNameCandidate = {
            kind: requireEnum(
                requireField(candidate, 'kind', `${path}.displayNameCandidate`),
                `${path}.displayNameCandidate.kind`,
                ['literal', 'localization_key'] as const
            ),
            value: requireString(
                requireField(candidate, 'value', `${path}.displayNameCandidate`),
                `${path}.displayNameCandidate.value`
            )
        };
    }
    return entity;
}

const PERSISTED_ENTITY_REF_KEYS = ['type', 'id', 'displayName'] as const;

function validatePersistedEntityRef(value: unknown, path: string): ExtractedGameFactV1['subject'] {
    const obj = requireObject(value, path, PERSISTED_ENTITY_REF_KEYS);
    const ref: ExtractedGameFactV1['subject'] = {
        type: requireEnum(requireField(obj, 'type', path), `${path}.type`, ENTITY_REF_TYPES),
        id: requireId(requireField(obj, 'id', path), `${path}.id`)
    };
    const displayName = optionalString(obj['displayName'], `${path}.displayName`, 256);
    if (displayName !== undefined) ref.displayName = displayName;
    return ref;
}

const PERSISTED_FACT_KEYS = [
    'id', 'category', 'subject', 'predicate', 'object', 'value', 'asOfGameDate',
    'source', 'sourcePath', 'confidence', 'visibility', 'knownByCharacterIds',
    'priority', 'sensitivity', 'provenance'
] as const;
const PERSISTED_FACT_DATE_KEYS = ['numeric', 'display'] as const;
const PERSISTED_FACT_PROVENANCE_KEYS = ['snapshotId', 'campaignId', 'snapshotSequence'] as const;

function validatePersistedFact(value: unknown, path: string): ExtractedGameFactV1 {
    const obj = requireObject(value, path, PERSISTED_FACT_KEYS);

    const fact: ExtractedGameFactV1 = {
        id: requireId(requireField(obj, 'id', path), `${path}.id`),
        category: requireEnum(requireField(obj, 'category', path), `${path}.category`, SAVE_FACT_CATEGORIES),
        subject: validatePersistedEntityRef(requireField(obj, 'subject', path), `${path}.subject`),
        predicate: requireEnum(requireField(obj, 'predicate', path), `${path}.predicate`, SAVE_FACT_PREDICATES),
        asOfGameDate: (() => {
            const dateObj = requireObject(requireField(obj, 'asOfGameDate', path), `${path}.asOfGameDate`, PERSISTED_FACT_DATE_KEYS);
            const out: ExtractedGameFactV1['asOfGameDate'] = {};
            if (dateObj['numeric'] !== undefined) {
                out.numeric = requireFiniteNumber(dateObj['numeric'], `${path}.asOfGameDate.numeric`);
            }
            const display = optionalString(dateObj['display'], `${path}.asOfGameDate.display`, 128);
            if (display !== undefined) out.display = display;
            return out;
        })(),
        source: 'save_snapshot',
        sourcePath: requireEnum(requireField(obj, 'sourcePath', path), `${path}.sourcePath`, SAVE_FACT_SOURCE_PATHS),
        confidence: requireEnum(requireField(obj, 'confidence', path), `${path}.confidence`, ['exact', 'mapped', 'heuristic'] as const),
        visibility: requireEnum(
            requireField(obj, 'visibility', path),
            `${path}.visibility`,
            ['public', 'speaker_known', 'player_known', 'omniscient_internal', 'blocked'] as const
        ),
        priority: obj['priority'] === undefined
            ? 0 // wire-optional on extract; persisted records written by older builds may omit it
            : requireInteger(requireField(obj, 'priority', path), `${path}.priority`, -100000, 100000),
        sensitivity: requireEnum(
            requireField(obj, 'sensitivity', path),
            `${path}.sensitivity`,
            ['normal', 'personal', 'political', 'secret', 'system_hidden'] as const
        ),
        provenance: {}
    };

    if (requireField(obj, 'source', path) !== 'save_snapshot') {
        fail(`${path}.source`, 'persisted facts must have source "save_snapshot"');
    }

    if (obj['object'] !== undefined) fact.object = validatePersistedEntityRef(obj['object'], `${path}.object`);

    const rawValue = obj['value'];
    if (rawValue !== undefined) {
        if (typeof rawValue === 'string') {
            fact.value = requireString(rawValue, `${path}.value`);
        } else if (typeof rawValue === 'number') {
            fact.value = requireFiniteNumber(rawValue, `${path}.value`);
        } else if (typeof rawValue === 'boolean') {
            fact.value = rawValue;
        } else {
            fail(`${path}.value`, 'expected string, number or boolean');
        }
    }

    const knownBy = obj['knownByCharacterIds'];
    if (knownBy !== undefined) {
        const entries = requireArray(knownBy, `${path}.knownByCharacterIds`, 250);
        fact.knownByCharacterIds = entries.map((entry, i) => requireId(entry, `${path}.knownByCharacterIds[${i}]`));
    }

    const provenance = requireObject(requireField(obj, 'provenance', path), `${path}.provenance`, PERSISTED_FACT_PROVENANCE_KEYS);
    const snapshotId = optionalId(provenance['snapshotId'], `${path}.provenance.snapshotId`);
    if (snapshotId !== undefined) fact.provenance.snapshotId = snapshotId;
    const campaignId = optionalId(provenance['campaignId'], `${path}.provenance.campaignId`);
    if (campaignId !== undefined) fact.provenance.campaignId = campaignId;
    const snapshotSequenceRaw = provenance['snapshotSequence'];
    if (snapshotSequenceRaw !== undefined) {
        fact.provenance.snapshotSequence = requireInteger(snapshotSequenceRaw, `${path}.provenance.snapshotSequence`, 1, Number.MAX_SAFE_INTEGER);
    }

    return fact;
}

const PERSISTED_SNAPSHOT_KEYS = [
    'schemaVersion', 'campaignId', 'playerId', 'checkpoint', 'sourceFingerprint',
    'extractionRequestHash', 'manifest', 'verifiedIdentity', 'entities', 'facts',
    'extractionStatus', 'joinCandidates', 'createdAt', 'parserVersion', 'factSchemaVersion'
] as const;

/**
 * Validated join-candidate list (Plan C Task 2b). Mirrors the wire validator:
 * at most `JOIN_CANDIDATES_MAX` entries, each a non-empty all-digit string of
 * at most 64 chars. Any deviation fails the whole record closed.
 */
function validateJoinCandidates(value: unknown, path: string): string[] {
    const entries = requireArray(value, path, JOIN_CANDIDATES_MAX);
    return entries.map((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64 || !/^\d+$/.test(entry)) {
            fail(path, `joinCandidates[${i}] must be a bounded decimal id string`);
        }
        return entry;
    });
}

/**
 * Explicit whitelist validator for the persisted `current.json` document.
 * The sidecar wire validator in `saveFactSchemas.ts` does NOT cover this
 * schema; unknown keys are rejected at every object level and the cross-field
 * consistency between the top-level fingerprint/versions and the embedded
 * manifest is enforced. Never throws; returns a discriminated result.
 */
export function validatePersistedSaveFactSnapshot(input: unknown): PersistedSnapshotValidationResult {
    try {
        const obj = requireObject(input, '$', PERSISTED_SNAPSHOT_KEYS);

        if (requireField(obj, 'schemaVersion', '$') !== PERSISTED_SAVE_FACT_SCHEMA_VERSION) {
            fail('$.schemaVersion', `expected ${PERSISTED_SAVE_FACT_SCHEMA_VERSION}`);
        }

        const record: PersistedSaveFactSnapshotV1 = {
            schemaVersion: PERSISTED_SAVE_FACT_SCHEMA_VERSION,
            campaignId: requireString(requireField(obj, 'campaignId', '$'), '$.campaignId', 256),
            playerId: requireString(requireField(obj, 'playerId', '$'), '$.playerId', 256),
            checkpoint: validateCheckpoint(requireField(obj, 'checkpoint', '$'), '$.checkpoint'),
            sourceFingerprint: requireId(requireField(obj, 'sourceFingerprint', '$'), '$.sourceFingerprint'),
            extractionRequestHash: requireString(
                requireField(obj, 'extractionRequestHash', '$'),
                '$.extractionRequestHash',
                128
            ),
            manifest: validatePersistedManifest(requireField(obj, 'manifest', '$'), '$.manifest'),
            verifiedIdentity: validateVerifiedIdentity(requireField(obj, 'verifiedIdentity', '$'), '$.verifiedIdentity'),
            entities: requireArray(requireField(obj, 'entities', '$'), '$.entities', 250)
                .map((entry, i) => validatePersistedEntity(entry, `$.entities[${i}]`)),
            facts: requireArray(requireField(obj, 'facts', '$'), '$.facts', 500)
                .map((entry, i) => validatePersistedFact(entry, `$.facts[${i}]`)),
            createdAt: requireString(requireField(obj, 'createdAt', '$'), '$.createdAt', 64),
            parserVersion: requireId(requireField(obj, 'parserVersion', '$'), '$.parserVersion'),
            factSchemaVersion: 1
        };
        if (obj['extractionStatus'] !== undefined) {
            record.extractionStatus = requireEnum(
                obj['extractionStatus'],
                '$.extractionStatus',
                ['ok', 'partial'] as const
            );
        }
        if (obj['joinCandidates'] !== undefined) {
            record.joinCandidates = validateJoinCandidates(obj['joinCandidates'], '$.joinCandidates');
        }

        if (requireField(obj, 'factSchemaVersion', '$') !== 1) {
            fail('$.factSchemaVersion', 'expected 1');
        }
        // Cross-field consistency: the top-level copies must agree with the
        // embedded manifest so a cache record cannot mix two extractions.
        if (record.manifest.sourceFingerprint !== record.sourceFingerprint) {
            fail('$.sourceFingerprint', 'does not match manifest.sourceFingerprint');
        }
        if (record.manifest.parserVersion !== record.parserVersion) {
            fail('$.parserVersion', 'does not match manifest.parserVersion');
        }
        if (record.manifest.factSchemaVersion !== record.factSchemaVersion) {
            fail('$.factSchemaVersion', 'does not match manifest.factSchemaVersion');
        }

        return { ok: true, value: record };
    } catch (error) {
        if (error instanceof PersistedValidationError) {
            return { ok: false, path: error.path, message: error.message };
        }
        return {
            ok: false,
            path: '$',
            message: error instanceof Error ? error.message : String(error)
        };
    }
}

// ---------------------------------------------------------------------------
// Path containment (plan Task 12 step 3)
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth containment check: the resolved write target must be a
 * file strictly inside this identity's `save_facts/` directory. Throws
 * `SaveFactStoreError` with code `PATH_ESCAPE` otherwise.
 */
export function assertSaveFactsContainment(saveFactsBaseDir: string, targetPath: string): void {
    const resolvedBase = path.resolve(saveFactsBaseDir);
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(resolvedBase, resolvedTarget);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new SaveFactStoreError(
            'PATH_ESCAPE',
            `refusing to write outside the save_facts directory: "${targetPath}"`
        );
    }
}

// ---------------------------------------------------------------------------
// Atomic write (plan Task 12 step 3)
// ---------------------------------------------------------------------------

/**
 * P5b deferred (verify/session/delta/agency): local sync replacement for the
 * 1.x `promptWorkbench/atomicJson.writeJsonAtomic` (module not ported to 2CE;
 * 2CE's shared history/chronicle writers have different contracts). Same
 * durability protocol as 1.x: sibling tmp file -> fsync -> rename ->
 * best-effort parent-dir fsync. Cleans up its own tmp file on failure and
 * never deletes the existing target.
 */
function writeJsonAtomicSync(filePath: string, value: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const payload = JSON.stringify(value, null, '\t');

    let fd: number | undefined;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeFileSync(fd, payload, 'utf8');
        try {
            fs.fsyncSync(fd);
        } catch {
            // fsync unsupported on some platforms/filesystems; continue.
        }
        try {
            fs.closeSync(fd);
        } catch {
            // Non-fatal.
        }
        fd = undefined;
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        throw error;
    }

    try {
        const dirFd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(dirFd);
        } finally {
            try { fs.closeSync(dirFd); } catch { /* ignore */ }
        }
    } catch {
        // Best-effort durability for the rename only.
    }
}

// ---------------------------------------------------------------------------
// Corrupt-file quarantine (plan Task 12 step 6)
// ---------------------------------------------------------------------------

/**
 * Move a corrupt cache file to a `.corrupt.<UTC timestamp>` sibling and
 * remove the original so a later write can recreate it. The corrupt content
 * is preserved for diagnosis; a corrupt cache is NEVER reported as an
 * empty-but-successful load. Returns the quarantine path, or `undefined` if
 * quarantine failed (the original is left in place then).
 */
function quarantineCorruptFile(filePath: string): string | undefined {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }

    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    let candidate = path.join(dir, `${base}.corrupt.${timestamp}`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base}.corrupt.${timestamp}.${suffix}`);
        suffix++;
    }

    try {
        fs.writeFileSync(candidate, content, 'utf8');
    } catch {
        return undefined;
    }
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Non-fatal: the quarantine copy exists; the original remains too.
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Snapshot retention (plan Task 12 step 6)
// ---------------------------------------------------------------------------

/** Diagnostics mode keeps at most this many compact snapshots. */
export const SAVE_FACT_SNAPSHOT_RETENTION = 3;

/**
 * VOTC-derived snapshot file names: `snapshot-<yyyyMMddHHmmssSSS>-<snapshotId>.json`.
 * Only files matching this pattern AND the persisted schema are ever
 * considered for retention deletion; anything else in the directory is left
 * untouched.
 */
const SNAPSHOT_FILE_PATTERN = /^snapshot-\d{17}-[A-Za-z0-9][A-Za-z0-9_.:\-]{0,255}\.json$/;

function snapshotFileName(record: PersistedSaveFactSnapshotV1): string {
    const compactTimestamp = record.createdAt.replace(/[^0-9]/g, '').padEnd(17, '0').slice(0, 17);
    return `snapshot-${compactTimestamp}-${record.manifest.snapshotId}.json`;
}

// ---------------------------------------------------------------------------
// Entity-name cache (plan Task 12 step 7)
// ---------------------------------------------------------------------------

export type EntityNameSource = 'live_gamedata' | 'verified_literal';

export interface EntityNameUpdate {
    entityType: 'character' | 'title';
    id: string;
    displayName: string;
    source: EntityNameSource;
}

export interface EntityNameEntry extends EntityNameUpdate {
    timelineNodeId?: string;
    checkpointEpoch?: number;
    updatedAt: string;
}

/** Current on-disk format. v1 is accepted only through explicit migration. */
export const PERSISTED_ENTITY_NAME_SCHEMA_VERSION = 2 as const;

export interface PersistedEntityNameCacheV2 {
    schemaVersion: typeof PERSISTED_ENTITY_NAME_SCHEMA_VERSION;
    campaignId: string;
    playerId: string;
    /** Multiple entries are intentional: provenance is part of the key. */
    entries: EntityNameEntry[];
}

export interface SaveFactEntityNameSnapshot {
    readonly entries: readonly EntityNameEntry[];
    readonly timelineContext?: SaveFactTimelineContext;
}

export interface PersistedEntityNameCacheV1 {
    schemaVersion: 1;
    campaignId: string;
    playerId: string;
    entries: EntityNameEntry[];
}

export interface EntityNameUpdateResult {
    accepted: number;
    rejected: Array<{ id: string; displayName: string; reason: string }>;
}

/**
 * Raw CK3 localization keys must never become a display name (plan Task 12
 * step 7 / Task 14 step 2): `k_*` title keys, `dynn_*` dynasty keys and
 * `ERROR:*` fallback markers are all rejected.
 */
const RAW_LOC_KEY_PATTERN = /^(?:k_|dynn_|ERROR:)/;

export function looksLikeRawLocKey(name: string): boolean {
    return RAW_LOC_KEY_PATTERN.test(name.trim());
}

const ENTITY_NAME_SOURCE_PRECEDENCE: Record<EntityNameSource, number> = {
    verified_literal: 1,
    live_gamedata: 2
};

export const SAVE_FACT_ENTITY_NAME_MAX_ENTRIES = 2048;
export const SAVE_FACT_ENTITY_NAME_MAX_ENTRIES_PER_ENTITY = 16;

const ENTITY_NAME_CACHE_KEYS = ['schemaVersion', 'campaignId', 'playerId', 'entries'] as const;
const ENTITY_NAME_ENTRY_KEYS = [
    'entityType', 'id', 'displayName', 'source', 'timelineNodeId', 'checkpointEpoch', 'updatedAt'
] as const;

function validateEntityNameCacheV1(input: unknown): PersistedEntityNameCacheV1 | undefined {
    try {
        const obj = requireObject(input, '$', ENTITY_NAME_CACHE_KEYS);
        if (requireField(obj, 'schemaVersion', '$') !== 1) fail('$.schemaVersion', 'expected 1');
        const entries = requireArray(requireField(obj, 'entries', '$'), '$.entries', 10000)
            .map((entry, i): EntityNameEntry => {
                const entryObj = requireObject(entry, `$.entries[${i}]`, ENTITY_NAME_ENTRY_KEYS);
                const out: EntityNameEntry = {
                    entityType: requireEnum(
                        requireField(entryObj, 'entityType', `$.entries[${i}]`),
                        `$.entries[${i}].entityType`,
                        ['character', 'title'] as const
                    ),
                    id: requireId(requireField(entryObj, 'id', `$.entries[${i}]`), `$.entries[${i}].id`),
                    displayName: requireString(
                        requireField(entryObj, 'displayName', `$.entries[${i}]`),
                        `$.entries[${i}].displayName`,
                        256
                    ),
                    source: requireEnum(
                        requireField(entryObj, 'source', `$.entries[${i}]`),
                        `$.entries[${i}].source`,
                        ['live_gamedata', 'verified_literal'] as const
                    ),
                    updatedAt: requireString(
                        requireField(entryObj, 'updatedAt', `$.entries[${i}]`),
                        `$.entries[${i}].updatedAt`,
                        64
                    )
                };
                const nodeId = optionalString(entryObj['timelineNodeId'], `$.entries[${i}].timelineNodeId`, 256);
                if (nodeId !== undefined) out.timelineNodeId = nodeId;
                const epoch = optionalInteger(entryObj['checkpointEpoch'], `$.entries[${i}].checkpointEpoch`, 0, Number.MAX_SAFE_INTEGER);
                if (epoch !== undefined) out.checkpointEpoch = epoch;
                return out;
            });
        return {
            schemaVersion: 1,
            campaignId: requireString(requireField(obj, 'campaignId', '$'), '$.campaignId', 256),
            playerId: requireString(requireField(obj, 'playerId', '$'), '$.playerId', 256),
            entries
        };
    } catch {
        return undefined;
    }
}

function validateEntityNameCacheV2(input: unknown): PersistedEntityNameCacheV2 | undefined {
    try {
        const obj = requireObject(input, '$', ENTITY_NAME_CACHE_KEYS);
        if (requireField(obj, 'schemaVersion', '$') !== PERSISTED_ENTITY_NAME_SCHEMA_VERSION) {
            fail('$.schemaVersion', `expected ${PERSISTED_ENTITY_NAME_SCHEMA_VERSION}`);
        }
        const entries = requireArray(requireField(obj, 'entries', '$'), '$.entries', SAVE_FACT_ENTITY_NAME_MAX_ENTRIES)
            .map((entry, i): EntityNameEntry => {
                const entryObj = requireObject(entry, `$.entries[${i}]`, ENTITY_NAME_ENTRY_KEYS);
                const out: EntityNameEntry = {
                    entityType: requireEnum(requireField(entryObj, 'entityType', `$.entries[${i}]`), `$.entries[${i}].entityType`, ['character', 'title'] as const),
                    id: requireId(requireField(entryObj, 'id', `$.entries[${i}]`), `$.entries[${i}].id`),
                    displayName: requireString(requireField(entryObj, 'displayName', `$.entries[${i}]`), `$.entries[${i}].displayName`, 256),
                    source: requireEnum(requireField(entryObj, 'source', `$.entries[${i}]`), `$.entries[${i}].source`, ['live_gamedata', 'verified_literal'] as const),
                    updatedAt: requireString(requireField(entryObj, 'updatedAt', `$.entries[${i}].updatedAt`), `$.entries[${i}].updatedAt`, 64)
                };
                const nodeId = optionalString(entryObj['timelineNodeId'], `$.entries[${i}].timelineNodeId`, 256);
                if (nodeId !== undefined) out.timelineNodeId = nodeId;
                const epoch = optionalInteger(entryObj['checkpointEpoch'], `$.entries[${i}].checkpointEpoch`, 0, Number.MAX_SAFE_INTEGER);
                if (epoch !== undefined) out.checkpointEpoch = epoch;
                return out;
            });
        return {
            schemaVersion: PERSISTED_ENTITY_NAME_SCHEMA_VERSION,
            campaignId: requireString(requireField(obj, 'campaignId', '$'), '$.campaignId', 256),
            playerId: requireString(requireField(obj, 'playerId', '$'), '$.playerId', 256),
            entries
        };
    } catch {
        return undefined;
    }
}

/** v1 migration is explicit: one old record becomes one v2 provenance record. */
function migrateEntityNameCacheV1(input: unknown): PersistedEntityNameCacheV2 | undefined {
    const legacy = validateEntityNameCacheV1(input);
    if (legacy === undefined) return undefined;
    return {
        schemaVersion: PERSISTED_ENTITY_NAME_SCHEMA_VERSION,
        campaignId: legacy.campaignId,
        playerId: legacy.playerId,
        entries: legacy.entries.map(entry => ({ ...entry }))
    };
}

function sameProvenance(
    entry: Pick<EntityNameEntry, 'timelineNodeId' | 'checkpointEpoch'>,
    provenance?: SaveFactCheckpointProvenance
): boolean {
    return entry.timelineNodeId === provenance?.timelineNodeId
        && entry.checkpointEpoch === provenance?.checkpointEpoch;
}

function retainEntityNameEntries(entries: EntityNameEntry[]): void {
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts = new Map<string, number>();
    const retained: EntityNameEntry[] = [];
    for (const entry of entries) {
        const key = `${entry.entityType}:${entry.id}`;
        const count = counts.get(key) ?? 0;
        if (count >= SAVE_FACT_ENTITY_NAME_MAX_ENTRIES_PER_ENTITY) continue;
        if (retained.length >= SAVE_FACT_ENTITY_NAME_MAX_ENTRIES) break;
        counts.set(key, count + 1);
        retained.push(entry);
    }
    entries.splice(0, entries.length, ...retained);
}

function chooseBestEntityNameEntry(
    candidates: readonly EntityNameEntry[],
    context?: SaveFactTimelineContext
): EntityNameEntry | undefined {
    if (candidates.length === 0) return undefined;
    const ancestorOrder = context?.registry !== undefined && context.currentNodeId !== undefined
        ? context.registry.getAncestors(context.currentNodeId)
        : [];
    return [...candidates].sort((a, b) => {
        const aDistance = a.timelineNodeId === undefined ? Number.MAX_SAFE_INTEGER : ancestorOrder.indexOf(a.timelineNodeId);
        const bDistance = b.timelineNodeId === undefined ? Number.MAX_SAFE_INTEGER : ancestorOrder.indexOf(b.timelineNodeId);
        const normalizedA = aDistance < 0 ? Number.MAX_SAFE_INTEGER - 1 : aDistance;
        const normalizedB = bDistance < 0 ? Number.MAX_SAFE_INTEGER - 1 : bDistance;
        if (normalizedA !== normalizedB) return normalizedA - normalizedB;
        const aEpoch = a.checkpointEpoch ?? Number.NEGATIVE_INFINITY;
        const bEpoch = b.checkpointEpoch ?? Number.NEGATIVE_INFINITY;
        if (aEpoch !== bEpoch) return bEpoch - aEpoch;
        const sourceDelta = ENTITY_NAME_SOURCE_PRECEDENCE[b.source] - ENTITY_NAME_SOURCE_PRECEDENCE[a.source];
        if (sourceDelta !== 0) return sourceDelta;
        return b.updatedAt.localeCompare(a.updatedAt);
    })[0];
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

export type SaveFactCurrentLoadResult =
    | { status: 'ok'; record: PersistedSaveFactSnapshotV1 }
    | { status: 'missing' }
    | { status: 'corrupt'; reason: string; quarantinePath?: string };

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SaveFactStore {
    private readonly userDataDir: string;
    private readonly identity: CampaignPlayerIdentity;
    private readonly persistenceQueue: SaveFactPersistenceQueue;
    /** Latest verified record queued but not yet attempted on disk. */
    private pendingCurrent?: PersistedSaveFactSnapshotV1;

    constructor(
        userDataDir: string,
        identity: CampaignPlayerIdentity,
        options: SaveFactPersistenceQueueOptions & { onWarning?: (code: SaveFactPersistenceWarningCode) => void } = {}
    ) {
        this.userDataDir = userDataDir;
        this.identity = identity;
        this.persistenceQueue = new SaveFactPersistenceQueue(options);
    }

    /** This identity's save_facts directory (created lazily on write). */
    get dir(): string {
        return saveFactsDir(this.userDataDir, this.identity);
    }

    /**
     * Persist a freshly extracted snapshot as `current.json` (plan steps 2-4).
     * The write is atomic (tmp/fsync/rename) and contained; a failed write
     * never deletes the previous `current.json`. When `diagnosticsEnabled` is
     * true a compact copy is also kept under `snapshots/` and retention prunes
     * to the newest 3 VOTC-derived snapshots.
     */
    saveCurrent(
        input: SaveFactSnapshotInput,
        options?: { diagnosticsEnabled?: boolean }
    ): PersistedSaveFactSnapshotV1 {
        const record = this.buildCurrentRecord(input);
        this.persistCurrentRecord(record, options);
        return record;
    }

    /**
     * Queue the current snapshot on the same campaign/player FIFO used by
     * entity-name updates. The verified record is immediately available as
     * an in-process cache hit; Conversation never waits for disk persistence.
     */
    scheduleCurrent(
        input: SaveFactSnapshotInput,
        options?: { diagnosticsEnabled?: boolean },
        writeDeadline?: number
    ): boolean {
        if (writeDeadline !== undefined && writeDeadline <= Date.now()) return false;
        const record = this.buildCurrentRecord(input);
        this.pendingCurrent = record;
        const scheduled = this.persistenceQueue.schedule(
            () => {
                try {
                    this.persistCurrentRecord(record, options);
                } finally {
                    if (this.pendingCurrent === record) this.pendingCurrent = undefined;
                }
            },
            SCHEDULED_CURRENT_ESTIMATED_BYTES,
            { failed: 'CURRENT_CACHE_WRITE_FAILED', skipped: 'CURRENT_CACHE_WRITE_SKIPPED' }
        );
        if (!scheduled && this.pendingCurrent === record) this.pendingCurrent = undefined;
        return scheduled;
    }

    private buildCurrentRecord(input: SaveFactSnapshotInput): PersistedSaveFactSnapshotV1 {
        return {
            schemaVersion: PERSISTED_SAVE_FACT_SCHEMA_VERSION,
            campaignId: this.identity.campaignId,
            playerId: this.identity.playerId,
            checkpoint: { ...input.checkpoint },
            sourceFingerprint: input.manifest.sourceFingerprint,
            extractionRequestHash: computeExtractionRequestHash(input.requestKey),
            manifest: input.manifest,
            verifiedIdentity: input.verifiedIdentity,
            entities: input.entities,
            facts: input.facts,
            extractionStatus: input.extractionStatus,
            ...(input.joinCandidates === undefined
                ? {}
                : { joinCandidates: [...input.joinCandidates] }),
            createdAt: new Date().toISOString(),
            parserVersion: input.manifest.parserVersion,
            factSchemaVersion: input.manifest.factSchemaVersion
        };
    }

    private persistCurrentRecord(
        record: PersistedSaveFactSnapshotV1,
        options?: { diagnosticsEnabled?: boolean }
    ): void {
        this.writeContainedJson(saveFactsCurrentPath(this.userDataDir, this.identity), record);

        if (options?.diagnosticsEnabled === true) {
            const snapshotsDir = saveFactsSnapshotsDir(this.userDataDir, this.identity);
            this.writeContainedJson(path.join(snapshotsDir, snapshotFileName(record)), record);
            this.pruneSnapshots(SAVE_FACT_SNAPSHOT_RETENTION);
        }
    }

    /**
     * Load `current.json`. A corrupt (unparseable or schema-invalid) file is
     * quarantined to a `.corrupt.<timestamp>` sibling and reported as
     * `corrupt`, never as an empty success.
     */
    loadCurrent(): SaveFactCurrentLoadResult {
        const filePath = saveFactsCurrentPath(this.userDataDir, this.identity);
        let raw: string;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch {
            return { status: 'missing' };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            const quarantinePath = quarantineCorruptFile(filePath);
            return {
                status: 'corrupt',
                reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
                quarantinePath
            };
        }

        const validation = validatePersistedSaveFactSnapshot(parsed);
        if (!validation.ok) {
            const quarantinePath = quarantineCorruptFile(filePath);
            return { status: 'corrupt', reason: validation.message, quarantinePath };
        }

        const record = validation.value;
        // The record is only meaningful for the identity namespace it lives in.
        if (record.campaignId !== this.identity.campaignId || record.playerId !== this.identity.playerId) {
            const quarantinePath = quarantineCorruptFile(filePath);
            return { status: 'corrupt', reason: 'record identity does not match its directory', quarantinePath };
        }

        return { status: 'ok', record };
    }

    /**
     * Cache lookup (plan step 4 + 5): returns the current snapshot only when
     * it is visible from the given timeline context AND every cache-key
     * component matches — source fingerprint, parser/fact schema versions,
     * participant IDs, categories, limits, and
     * campaign/player/date/sequence/slot (all covered by the extraction
     * request hash, re-checked field-by-field as defense in depth).
     */
    findCachedSnapshot(
        key: SaveFactCacheRequestKey,
        context?: SaveFactTimelineContext
    ): PersistedSaveFactSnapshotV1 | undefined {
        const record = this.pendingCurrent ?? (() => {
            const loaded = this.loadCurrent();
            return loaded.status === 'ok' ? loaded.record : undefined;
        })();
        if (record === undefined) return undefined;

        if (!isProvenanceVisible(record.checkpoint, context)) return undefined;
        if (record.extractionRequestHash !== computeExtractionRequestHash(key)) return undefined;

        // Defense in depth on top of the hash: identity components are
        // compared explicitly so a hash collision or hand-edited record can
        // never serve facts for the wrong campaign/player/date/slot.
        if (record.campaignId !== key.campaignId) return undefined;
        if (record.manifest.sourceFingerprint !== key.sourceFingerprint) return undefined;
        if (record.manifest.parserVersion !== key.parserVersion) return undefined;
        if (record.manifest.factSchemaVersion !== key.factSchemaVersion) return undefined;
        if (record.verifiedIdentity.playerCharacterId !== key.playerCharacterId) return undefined;
        if (record.verifiedIdentity.gameDateNumeric !== key.gameDateNumeric) return undefined;
        if (record.verifiedIdentity.snapshotSequence !== key.snapshotSequence) return undefined;
        if (record.verifiedIdentity.snapshotSlot !== key.snapshotSlot) return undefined;

        return record;
    }

    /**
     * List retained diagnostics snapshots visible from the given timeline
     * context (plan step 5): records from sibling or descendant branches are
     * filtered out via `isRecordVisibleForContext`. Files that do not match
     * the VOTC snapshot naming/schema are ignored (and never deleted here).
     */
    listVisibleSnapshots(context?: SaveFactTimelineContext): PersistedSaveFactSnapshotV1[] {
        const snapshotsDir = saveFactsSnapshotsDir(this.userDataDir, this.identity);
        let names: string[];
        try {
            names = fs.readdirSync(snapshotsDir);
        } catch {
            return [];
        }

        const visible: PersistedSaveFactSnapshotV1[] = [];
        for (const name of names) {
            if (!SNAPSHOT_FILE_PATTERN.test(name)) continue;
            const record = this.readSnapshotFile(path.join(snapshotsDir, name));
            if (record === undefined) continue;
            if (record.campaignId !== this.identity.campaignId || record.playerId !== this.identity.playerId) continue;
            if (!isProvenanceVisible(record.checkpoint, context)) continue;
            visible.push(record);
        }
        visible.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return visible;
    }

    /**
     * Retention (plan step 6): keep the newest `keep` VOTC-derived snapshots
     * and delete the older ones. A file is only deletable when its name
     * matches the VOTC snapshot pattern AND its content validates against the
     * persisted schema; foreign or unparseable files are always preserved.
     * Only `save_facts/snapshots/` is touched — never the CK3 `save games`
     * folder or anything else.
     */
    pruneSnapshots(keep: number = SAVE_FACT_SNAPSHOT_RETENTION): void {
        const snapshotsDir = saveFactsSnapshotsDir(this.userDataDir, this.identity);
        let names: string[];
        try {
            names = fs.readdirSync(snapshotsDir);
        } catch {
            return;
        }

        const derived: string[] = [];
        for (const name of names) {
            if (!SNAPSHOT_FILE_PATTERN.test(name)) continue;
            if (this.readSnapshotFile(path.join(snapshotsDir, name)) === undefined) continue;
            derived.push(name);
        }

        // Newest first: the zero-padded 17-digit timestamp sorts lexically.
        derived.sort().reverse();
        for (const name of derived.slice(Math.max(0, keep))) {
            const target = path.join(snapshotsDir, name);
            try {
                assertSaveFactsContainment(this.dir, target);
                fs.unlinkSync(target);
            } catch {
                // Best-effort pruning; a file that cannot be removed is kept.
            }
        }
    }

    /**
     * Merge entity display names observed from live GameData or a verified
     * literal source into the campaign/player entity-name cache (plan step 7).
     * Entries are stamped with the given checkpoint/timeline provenance. Raw
     * localization keys (`k_*`, `dynn_*`, `ERROR:*`) and otherwise unusable
     * names are rejected and never overwrite a stored name. Live GameData
     * names outrank verified-literal ones; a literal never replaces a live
     * name.
     */
    updateEntityNames(
        updates: EntityNameUpdate[],
        provenance?: SaveFactCheckpointProvenance
    ): EntityNameUpdateResult {
        const cache = this.loadEntityNameCache();
        const result: EntityNameUpdateResult = { accepted: 0, rejected: [] };

        for (const update of updates) {
            const displayName = update.displayName.trim();
            const rejection = this.validateNameUpdate(update, displayName);
            if (rejection !== undefined) {
                result.rejected.push({ id: update.id, displayName: update.displayName, reason: rejection });
                continue;
            }

            const existing = cache.entries.find(entry =>
                entry.entityType === update.entityType
                && entry.id === update.id
                && sameProvenance(entry, provenance)
            );
            if (
                existing !== undefined
                && ENTITY_NAME_SOURCE_PRECEDENCE[update.source] < ENTITY_NAME_SOURCE_PRECEDENCE[existing.source]
            ) {
                result.rejected.push({
                    id: update.id,
                    displayName: update.displayName,
                    reason: `source "${update.source}" does not outrank stored "${existing.source}"`
                });
                continue;
            }

            const entry: EntityNameEntry = {
                entityType: update.entityType,
                id: update.id,
                displayName,
                source: update.source,
                updatedAt: new Date().toISOString()
            };
            if (provenance?.timelineNodeId !== undefined) entry.timelineNodeId = provenance.timelineNodeId;
            if (provenance?.checkpointEpoch !== undefined) entry.checkpointEpoch = provenance.checkpointEpoch;

            if (existing === undefined) {
                cache.entries.push(entry);
            } else {
                cache.entries[cache.entries.indexOf(existing)] = entry;
            }
            result.accepted++;
        }

        retainEntityNameEntries(cache.entries);

        if (updates.length > 0) {
            this.writeContainedJson(saveFactsEntityNamesPath(this.userDataDir, this.identity), cache);
        }
        return result;
    }

    /**
     * Schedule an entity-name write and return immediately. The queued task
     * uses the existing synchronous API, so old callers retain its semantics.
     */
    scheduleEntityNameUpdate(
        updates: EntityNameUpdate[],
        provenance?: SaveFactCheckpointProvenance,
        writeDeadline?: number
    ): boolean {
        if (writeDeadline !== undefined && writeDeadline <= Date.now()) return false;
        const estimatedBytes = Buffer.byteLength(JSON.stringify({ updates, provenance }), 'utf8');
        return this.persistenceQueue.schedule(
            () => { this.updateEntityNames(updates, provenance); },
            estimatedBytes
        );
    }

    /** Flush queued writes before a deadline, otherwise discard the tail. */
    flushOrDiscardPersistence(deadlineOrTimeoutMs?: number): Promise<{ flushed: boolean; discarded: number }> {
        return this.persistenceQueue.flushOrDiscard(deadlineOrTimeoutMs);
    }

    /** Alias for shutdown/owner code that uses the queue's terminology. */
    flushOrDiscard(deadlineOrTimeoutMs?: number): Promise<{ flushed: boolean; discarded: number }> {
        return this.flushOrDiscardPersistence(deadlineOrTimeoutMs);
    }

    /** Read and timeline-filter the name cache exactly once for a prepare. */
    loadEntityNameSnapshot(context?: SaveFactTimelineContext): SaveFactEntityNameSnapshot {
        const cache = this.loadEntityNameCache();
        const entries = cache.entries
            .filter(entry => isProvenanceVisible(
                { timelineNodeId: entry.timelineNodeId, checkpointEpoch: entry.checkpointEpoch },
                context
            ))
            .map(entry => Object.freeze({ ...entry }));
        return Object.freeze({
            entries: Object.freeze(entries),
            timelineContext: context === undefined ? undefined : Object.freeze({ ...context })
        });
    }

    /**
     * Resolve a cached display name visible from the given timeline context.
     * Stored raw loc keys can never be returned (they are rejected on write,
     * and filtered again here as defense in depth).
     */
    resolveEntityName(
        entityType: 'character' | 'title',
        id: string,
        context?: SaveFactTimelineContext
    ): string | undefined {
        const snapshot = this.loadEntityNameSnapshot(context);
        const candidates = snapshot.entries.filter(candidate => candidate.entityType === entityType && candidate.id === id);
        const entry = chooseBestEntityNameEntry(candidates, context);
        if (entry === undefined) return undefined;
        if (looksLikeRawLocKey(entry.displayName)) return undefined;
        return entry.displayName;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** Containment-checked atomic JSON write (plan step 3). */
    private writeContainedJson(targetPath: string, value: unknown): void {
        try {
            assertSaveFactsContainment(this.dir, targetPath);
        } catch (error) {
            if (error instanceof SaveFactStoreError) throw error;
            throw new SaveFactStoreError('WRITE_FAILED', String(error));
        }
        writeJsonAtomicSync(targetPath, value);
    }

    private readSnapshotFile(filePath: string): PersistedSaveFactSnapshotV1 | undefined {
        let raw: string;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
        try {
            const validation = validatePersistedSaveFactSnapshot(JSON.parse(raw));
            return validation.ok ? validation.value : undefined;
        } catch {
            return undefined;
        }
    }

    private loadEntityNameCache(): PersistedEntityNameCacheV2 {
        const filePath = saveFactsEntityNamesPath(this.userDataDir, this.identity);
        const empty: PersistedEntityNameCacheV2 = {
            schemaVersion: PERSISTED_ENTITY_NAME_SCHEMA_VERSION,
            campaignId: this.identity.campaignId,
            playerId: this.identity.playerId,
            entries: []
        };

        let raw: string;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch {
            return empty;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            quarantineCorruptFile(filePath);
            return empty;
        }

        const parsedObject = isPlainObject(parsed) ? parsed : undefined;
        const schemaVersion = parsedObject?.['schemaVersion'];
        // v1 is migrated by an explicit version branch. Unknown/malformed
        // versions are quarantined rather than guessed as the current shape.
        const validated = schemaVersion === 1
            ? migrateEntityNameCacheV1(parsed)
            : schemaVersion === PERSISTED_ENTITY_NAME_SCHEMA_VERSION
                ? validateEntityNameCacheV2(parsed)
                : undefined;
        if (validated === undefined) {
            quarantineCorruptFile(filePath);
            return empty;
        }
        if (validated.campaignId !== this.identity.campaignId || validated.playerId !== this.identity.playerId) {
            quarantineCorruptFile(filePath);
            return empty;
        }
        return validated;
    }

    private validateNameUpdate(update: EntityNameUpdate, trimmedName: string): string | undefined {
        if (!SAVE_FACT_ID_PATTERN.test(update.id)) {
            return `entity id does not match the id pattern: ${JSON.stringify(update.id.slice(0, 64))}`;
        }
        if (trimmedName.length === 0) {
            return 'display name must not be empty';
        }
        if (trimmedName.length > 256) {
            return `display name length ${trimmedName.length} exceeds maximum 256`;
        }
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001F]/.test(trimmedName)) {
            return 'display name contains control characters';
        }
        if (looksLikeRawLocKey(trimmedName)) {
            return 'raw localization keys (k_*, dynn_*, ERROR:*) can never become display names';
        }
        return undefined;
    }
}
