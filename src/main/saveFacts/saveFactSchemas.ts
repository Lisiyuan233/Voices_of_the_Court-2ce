/**
 * Runtime whitelist validator for the sidecar extraction response
 * (`SaveFactExtractionResultV1`, plan 5.4). Hand-rolled, no external
 * dependency, and never a bare `JSON.parse` + type assertion.
 *
 * Unknown-field policy: unlike the persisted Prompt Workbench DTOs (which
 * ignore unknown keys for forward compatibility), the sidecar response is a
 * strict same-version contract between two components we ship together.
 * Unknown keys are therefore REJECTED at every object level. Rationale:
 * silently stripping unknown keys could hide protocol skew and could let
 * unexpected payload (for example a raw save path) flow into diagnostics.
 * Forward compatibility is handled through `protocolVersion`, not through
 * lenient parsing.
 *
 * Everything is bounded: string length, array length, numeric ranges and
 * object depth all have hard caps, and cyclic or non-plain objects are
 * rejected before any per-field check runs. The public entry point never
 * throws; it returns a discriminated result instead.
 */

import {
    ENTITY_REF_TYPES,
    SAVE_FACT_CATEGORIES,
    SAVE_FACT_ERROR_CODES,
    SAVE_FACT_PREDICATES,
    SAVE_FACT_SOURCE_PATHS,
    SAVE_SOURCE_FORMATS,
    ACTIVITY_TYPE_VALUES,
    WAR_CASUS_BELLI_VALUES,
    WAR_SCORE_BANDS
    , COUNCIL_POSITION_VALUES
    , COURT_POSITION_VALUES
} from './saveFactTypes';
import type {
    CanonicalEntityV1,
    EntityRef,
    ExtractedGameFactV1,
    SaveFactErrorCode,
    SaveFactExtractionResultV1,
    SaveFactResultStatus
} from './saveFactTypes';

export type SaveFactValidationFailureCode =
    | 'NOT_AN_OBJECT'
    | 'CYCLIC_STRUCTURE'
    | 'DEPTH_EXCEEDED'
    | 'ARRAY_TOO_LONG'
    | 'STRING_TOO_LONG'
    | 'INVALID_ID'
    | 'INVALID_ENUM'
    | 'INVALID_TYPE'
    | 'NON_FINITE_NUMBER'
    | 'METRIC_OUT_OF_RANGE'
    | 'MISSING_FIELD'
    | 'UNKNOWN_FIELD'
    | 'UNSUPPORTED_PROTOCOL_VERSION'
    | 'INVALID_PREDICATE'
    | 'INVALID_SOURCE_PATH'
    | 'PROBE_NOT_EMPTY'
    | 'INVALID_WAR_SHAPE'
    | 'INVALID_ACTIVITY_SHAPE'
    | 'INVALID_COURT_SHAPE'
    | 'INVALID_REALM_SHAPE'
    | 'INVALID_JOIN_CANDIDATES';


export type SaveFactValidationResult =
    | { ok: true; value: SaveFactExtractionResultV1 }
    | { ok: false; code: SaveFactValidationFailureCode; path: string; message: string };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Structural depth cap for the whole response document (real depth is ~4). */
export const SAVE_FACT_RESPONSE_MAX_DEPTH = 8;
/** Hard cap applied to ANY array during the structural pre-walk. */
export const SAVE_FACT_RESPONSE_MAX_ARRAY_ANY = 10000;
export const SAVE_FACT_RESPONSE_MAX_FACTS = 500;
export const SAVE_FACT_RESPONSE_MAX_ENTITIES = 250;
export const SAVE_FACT_RESPONSE_MAX_WARNINGS = 100;
export const SAVE_FACT_RESPONSE_MAX_KNOWN_BY = 250;
/** Cap for any single string value (ids, names, fingerprint, versions). */
export const SAVE_FACT_RESPONSE_MAX_STRING_LENGTH = 1024;
/** Cap for short enum-adjacent strings (warning codes, date displays). */
export const SAVE_FACT_RESPONSE_MAX_SHORT_STRING_LENGTH = 128;
/** Byte-count metrics are capped at 1 TiB. */
export const SAVE_FACT_RESPONSE_MAX_BYTES = 2 ** 40;
/** Duration metrics are capped at 24 hours in ms. */
export const SAVE_FACT_RESPONSE_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Emitted-count metrics allow truncation headroom beyond the array caps. */
export const SAVE_FACT_RESPONSE_MAX_EMITTED = 100000;
/** Fact priority is a bounded integer. */
export const SAVE_FACT_RESPONSE_MAX_PRIORITY = 100000;
/** Cap on the `joinCandidates` array (Plan C Task 2b protocol contract). */
export const SAVE_FACT_RESPONSE_MAX_JOIN_CANDIDATES = 512;

/**
 * Ids, fingerprints, version strings and codes must match this pattern:
 * printable, no whitespace, no path separators, no control characters. This
 * keeps save-derived strings from smuggling paths or markup into diagnostics.
 */
export const SAVE_FACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,255}$/;

type Obj = Record<string, unknown>;

class SaveFactValidationError extends Error {
    readonly code: SaveFactValidationFailureCode;
    readonly path: string;

    constructor(code: SaveFactValidationFailureCode, path: string, message: string) {
        super(`${path}: ${message}`);
        this.name = 'SaveFactValidationError';
        this.code = code;
        this.path = path;
    }
}

function fail(code: SaveFactValidationFailureCode, path: string, message: string): never {
    throw new SaveFactValidationError(code, path, message);
}

function isPlainObject(value: unknown): value is Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Structural pre-walk: cyclic graphs, non-plain objects, depth, array size.
// ---------------------------------------------------------------------------

function assertStructurallySafe(value: unknown, path: string): void {
    const seen = new Set<unknown>();
    const walk = (v: unknown, depth: number, p: string): void => {
        if (typeof v !== 'object' || v === null) return;
        if (seen.has(v)) fail('CYCLIC_STRUCTURE', p, 'cyclic structure is not allowed');
        if (!Array.isArray(v) && !isPlainObject(v)) {
            fail('NOT_AN_OBJECT', p, 'only plain objects and arrays are allowed');
        }
        if (depth > SAVE_FACT_RESPONSE_MAX_DEPTH) {
            fail('DEPTH_EXCEEDED', p, `object nesting exceeds maximum depth ${SAVE_FACT_RESPONSE_MAX_DEPTH}`);
        }
        if (Array.isArray(v) && v.length > SAVE_FACT_RESPONSE_MAX_ARRAY_ANY) {
            fail('ARRAY_TOO_LONG', p, `array length ${v.length} exceeds maximum ${SAVE_FACT_RESPONSE_MAX_ARRAY_ANY}`);
        }
        seen.add(v);
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) walk(v[i], depth + 1, `${p}[${i}]`);
        } else {
            for (const key of Object.keys(v as Obj)) {
                walk((v as Obj)[key], depth + 1, `${p}.${key}`);
            }
        }
        seen.delete(v);
    };
    walk(value, 0, path);
}

// ---------------------------------------------------------------------------
// Scalar / container helpers
// ---------------------------------------------------------------------------

function requirePlainObject(value: unknown, path: string, allowedKeys: readonly string[]): Obj {
    if (!isPlainObject(value)) {
        fail('NOT_AN_OBJECT', path, 'expected a plain object');
    }
    for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) {
            fail('UNKNOWN_FIELD', path, `unknown field "${key}" is not part of protocol v1`);
        }
    }
    return value;
}

function requireField(obj: Obj, key: string, path: string): unknown {
    const value = obj[key];
    if (value === undefined) {
        fail('MISSING_FIELD', path, `missing required field "${key}"`);
    }
    return value;
}

function requireString(value: unknown, path: string, maxLength = SAVE_FACT_RESPONSE_MAX_STRING_LENGTH): string {
    if (typeof value !== 'string') fail('INVALID_TYPE', path, 'expected a string');
    if (value.length === 0) fail('INVALID_TYPE', path, 'string must not be empty');
    if (value.length > maxLength) {
        fail('STRING_TOO_LONG', path, `string length ${value.length} exceeds maximum ${maxLength}`);
    }
    return value;
}

function optionalString(value: unknown, path: string, maxLength = SAVE_FACT_RESPONSE_MAX_STRING_LENGTH): string | undefined {
    if (value === undefined) return undefined;
    return requireString(value, path, maxLength);
}

function requireId(value: unknown, path: string): string {
    const str = requireString(value, path);
    if (!SAVE_FACT_ID_PATTERN.test(str)) {
        fail('INVALID_ID', path, `value does not match the id pattern: ${JSON.stringify(str.slice(0, 64))}`);
    }
    return str;
}

/**
 * Manifest ids on ERROR responses: when the save cannot be identified at all
 * (unsupported envelope, truncated header, limit fallback) the sidecar emits
 * an empty snapshotId/sourceFingerprint instead of fabricating one. Only the
 * two manifest hash fields use this lenient variant; every other id stays
 * strict.
 */
function requireIdOrEmpty(value: unknown, path: string): string {
    // requireString rejects empty strings, so the empty-marker case is
    // handled before delegating to it; the length cap still applies.
    if (typeof value !== 'string') {
        fail('INVALID_TYPE', path, 'expected a string');
    }
    if (value.length > SAVE_FACT_RESPONSE_MAX_STRING_LENGTH) {
        fail('STRING_TOO_LONG', path, `string length ${value.length} exceeds maximum ${SAVE_FACT_RESPONSE_MAX_STRING_LENGTH}`);
    }
    if (value !== '' && !SAVE_FACT_ID_PATTERN.test(value)) {
        fail('INVALID_ID', path, `value does not match the id pattern: ${JSON.stringify(value.slice(0, 64))}`);
    }
    return value;
}

function optionalId(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    return requireId(value, path);
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[], code: SaveFactValidationFailureCode = 'INVALID_ENUM'): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        fail(code, path, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
    }
    return value as T;
}

function requireFiniteNumber(value: unknown, path: string): number {
    if (typeof value !== 'number') fail('INVALID_TYPE', path, 'expected a number');
    if (!Number.isFinite(value)) fail('NON_FINITE_NUMBER', path, 'number must be finite');
    return value;
}

function requireIntegerInRange(value: unknown, path: string, min: number, max: number, code: SaveFactValidationFailureCode = 'METRIC_OUT_OF_RANGE'): number {
    const num = requireFiniteNumber(value, path);
    if (!Number.isSafeInteger(num)) fail('NON_FINITE_NUMBER', path, 'expected a safe integer');
    if (num < min || num > max) {
        fail(code, path, `value ${num} is outside the allowed range ${min}..${max}`);
    }
    return num;
}

function optionalIntegerInRange(value: unknown, path: string, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    return requireIntegerInRange(value, path, min, max);
}

function requireArray(value: unknown, path: string, maxLength: number): unknown[] {
    if (!Array.isArray(value)) fail('INVALID_TYPE', path, 'expected an array');
    if (value.length > maxLength) {
        fail('ARRAY_TOO_LONG', path, `array length ${value.length} exceeds maximum ${maxLength}`);
    }
    return value;
}

/**
 * Optional `joinCandidates` (Plan C Task 2b): an array of decimal CK3 runtime
 * ids, ≤512 entries, each a non-empty all-digit string of at most 64 chars.
 * Every deviation fails closed with the single stable code
 * `INVALID_JOIN_CANDIDATES` — never a partial accept.
 */
function validateJoinCandidates(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
        fail('INVALID_JOIN_CANDIDATES', path, 'expected an array of decimal id strings');
    }
    if (value.length > SAVE_FACT_RESPONSE_MAX_JOIN_CANDIDATES) {
        fail(
            'INVALID_JOIN_CANDIDATES',
            path,
            `array length ${value.length} exceeds maximum ${SAVE_FACT_RESPONSE_MAX_JOIN_CANDIDATES}`
        );
    }
    return value.map((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64 || !/^\d+$/.test(entry)) {
            fail(
                'INVALID_JOIN_CANDIDATES',
                `${path}[${i}]`,
                `expected a bounded decimal id string, got ${JSON.stringify(entry)}`
            );
        }
        return entry;
    });
}

// ---------------------------------------------------------------------------
// Nested DTO validators
// ---------------------------------------------------------------------------

const ENTITY_REF_KEYS = ['type', 'id', 'displayName'] as const;

function validateEntityRef(value: unknown, path: string): EntityRef {
    const obj = requirePlainObject(value, path, ENTITY_REF_KEYS);
    const type = requireEnum(requireField(obj, 'type', path), `${path}.type`, ENTITY_REF_TYPES);
    const id = requireId(requireField(obj, 'id', path), `${path}.id`);
    const displayName = optionalString(obj['displayName'], `${path}.displayName`, 256);
    const ref: EntityRef = { type, id };
    if (displayName !== undefined) ref.displayName = displayName;
    return ref;
}

const ENTITY_KEYS = ['type', 'id', 'displayNameCandidate'] as const;
const DISPLAY_NAME_CANDIDATE_KEYS = ['kind', 'value'] as const;

function validateCanonicalEntity(value: unknown, path: string): CanonicalEntityV1 {
    const obj = requirePlainObject(value, path, ENTITY_KEYS);
    const type = requireEnum(requireField(obj, 'type', path), `${path}.type`, ['character', 'title', 'war', 'activity', 'location'] as const);
    const id = requireId(requireField(obj, 'id', path), `${path}.id`);
    const entity: CanonicalEntityV1 = { type, id };
    const candidateRaw = obj['displayNameCandidate'];
    if (candidateRaw !== undefined) {
        const candidate = requirePlainObject(candidateRaw, `${path}.displayNameCandidate`, DISPLAY_NAME_CANDIDATE_KEYS);
        const kind = requireEnum(
            requireField(candidate, 'kind', `${path}.displayNameCandidate`),
            `${path}.displayNameCandidate.kind`,
            ['literal', 'localization_key'] as const
        );
        const candidateValue = requireString(
            requireField(candidate, 'value', `${path}.displayNameCandidate`),
            `${path}.displayNameCandidate.value`
        );
        entity.displayNameCandidate = { kind, value: candidateValue };
    }
    return entity;
}

const FACT_KEYS = [
    'id', 'category', 'subject', 'predicate', 'object', 'value', 'asOfGameDate',
    'source', 'sourcePath', 'confidence', 'visibility', 'knownByCharacterIds',
    'priority', 'sensitivity', 'provenance'
] as const;
const FACT_DATE_KEYS = ['numeric', 'display'] as const;
const FACT_PROVENANCE_KEYS = ['snapshotId', 'campaignId', 'snapshotSequence'] as const;

function validateExtractedFact(value: unknown, path: string): ExtractedGameFactV1 {
    const obj = requirePlainObject(value, path, FACT_KEYS);

    const id = requireId(requireField(obj, 'id', path), `${path}.id`);
    const category = requireEnum(requireField(obj, 'category', path), `${path}.category`, SAVE_FACT_CATEGORIES);
    const subject = validateEntityRef(requireField(obj, 'subject', path), `${path}.subject`);
    const predicate = requireEnum(
        requireField(obj, 'predicate', path),
        `${path}.predicate`,
        SAVE_FACT_PREDICATES,
        'INVALID_PREDICATE'
    );

    const fact: ExtractedGameFactV1 = {
        id,
        category,
        subject,
        predicate,
        asOfGameDate: validateFactDate(requireField(obj, 'asOfGameDate', path), `${path}.asOfGameDate`),
        source: 'save_snapshot',
        sourcePath: requireEnum(
            requireField(obj, 'sourcePath', path),
            `${path}.sourcePath`,
            SAVE_FACT_SOURCE_PATHS,
            'INVALID_SOURCE_PATH'
        ),
        confidence: requireEnum(requireField(obj, 'confidence', path), `${path}.confidence`, ['exact', 'mapped', 'heuristic'] as const),
        visibility: requireEnum(
            requireField(obj, 'visibility', path),
            `${path}.visibility`,
            ['public', 'speaker_known', 'player_known', 'omniscient_internal', 'blocked'] as const
        ),
        priority: optionalIntegerInRange(
            obj['priority'],
            `${path}.priority`,
            -SAVE_FACT_RESPONSE_MAX_PRIORITY,
            SAVE_FACT_RESPONSE_MAX_PRIORITY
        ) ?? 0, // wire-optional: the sidecar does not emit priority yet
        sensitivity: requireEnum(
            requireField(obj, 'sensitivity', path),
            `${path}.sensitivity`,
            ['normal', 'personal', 'political', 'secret', 'system_hidden'] as const
        ),
        provenance: {}
    };

    const source = requireField(obj, 'source', path);
    if (source !== 'save_snapshot') {
        fail('INVALID_ENUM', `${path}.source`, `sidecar facts must have source "save_snapshot", got ${JSON.stringify(source)}`);
    }

    if (obj['object'] !== undefined) fact.object = validateEntityRef(obj['object'], `${path}.object`);

    const rawValue = obj['value'];
    if (rawValue !== undefined) {
        if (typeof rawValue === 'string') {
            fact.value = requireString(rawValue, `${path}.value`);
        } else if (typeof rawValue === 'number') {
            fact.value = requireFiniteNumber(rawValue, `${path}.value`);
        } else if (typeof rawValue === 'boolean') {
            fact.value = rawValue;
        } else {
            fail('INVALID_TYPE', `${path}.value`, 'expected string, number or boolean');
        }
    }

    validateWarFactShape(fact, path);
    validateActivityFactShape(fact, path);
    validateCourtFactShape(fact, path);
    validateDirectRealmFactShape(fact, path);

    const knownBy = obj['knownByCharacterIds'];
    if (knownBy !== undefined) {
        const entries = requireArray(knownBy, `${path}.knownByCharacterIds`, SAVE_FACT_RESPONSE_MAX_KNOWN_BY);
        fact.knownByCharacterIds = entries.map((entry, i) => requireId(entry, `${path}.knownByCharacterIds[${i}]`));
    }

    const provenanceRaw = requireField(obj, 'provenance', path);
    const provenance = requirePlainObject(provenanceRaw, `${path}.provenance`, FACT_PROVENANCE_KEYS);
    const snapshotId = optionalId(provenance['snapshotId'], `${path}.provenance.snapshotId`);
    const campaignId = optionalId(provenance['campaignId'], `${path}.provenance.campaignId`);
    if (snapshotId !== undefined) fact.provenance.snapshotId = snapshotId;
    if (campaignId !== undefined) fact.provenance.campaignId = campaignId;
    const snapshotSequence = optionalIntegerInRange(provenance['snapshotSequence'], `${path}.provenance.snapshotSequence`, 1, Number.MAX_SAFE_INTEGER);
    if (snapshotSequence !== undefined) fact.provenance.snapshotSequence = snapshotSequence;

    return fact;
}

function validateDirectRealmFactShape(fact: ExtractedGameFactV1, path: string): void {
    const isDirectRealmPredicate = fact.predicate === 'character.direct_vassal_of'
        || fact.predicate === 'character.realm_capital';
    if (!isDirectRealmPredicate) return;

    const failShape = (message: string): never => fail('INVALID_REALM_SHAPE', path, message);
    if (fact.category !== 'realm' || fact.subject.type !== 'character' || fact.value !== undefined) {
        failShape('direct realm predicates require realm category, character subject and no value');
    }
    if (fact.predicate === 'character.direct_vassal_of' && fact.object?.type !== 'character') {
        failShape('character.direct_vassal_of requires a character object');
    }
    if (fact.predicate === 'character.realm_capital' && fact.object?.type !== 'title') {
        failShape('character.realm_capital requires a title object');
    }
}

function validateCourtFactShape(fact: ExtractedGameFactV1, path: string): void {
    const failShape = (message: string): never => fail('INVALID_COURT_SHAPE', path, message);
    if (fact.category !== 'court') {
        if (fact.predicate === 'character.council_position' || fact.predicate === 'character.court_position' || fact.predicate === 'character.court_owner') {
            failShape('court predicates require court category');
        }
        return;
    }
    switch (fact.predicate) {
        case 'character.council_position':
            if (fact.subject.type !== 'character' || fact.object !== undefined || typeof fact.value !== 'string' || !(COUNCIL_POSITION_VALUES as readonly string[]).includes(fact.value)) failShape('invalid council position shape');
            break;
        case 'character.court_position':
            if (fact.subject.type !== 'character' || fact.object !== undefined || typeof fact.value !== 'string' || !(COURT_POSITION_VALUES as readonly string[]).includes(fact.value)) failShape('invalid court position shape');
            break;
        case 'character.court_owner':
            if (fact.subject.type !== 'character' || fact.object?.type !== 'character' || fact.value !== undefined) failShape('invalid court owner shape');
            break;
        default:
            failShape(`unsupported court predicate ${fact.predicate}`);
    }
}

function validateWarFactShape(fact: ExtractedGameFactV1, path: string): void {
    const failShape = (message: string): never => fail('INVALID_WAR_SHAPE', path, message);
    if (fact.category !== 'war') {
        if (fact.subject.type === 'war' || fact.object?.type === 'war') {
            failShape('war entity refs are reserved for the war category');
        }
        return;
    }

    switch (fact.predicate) {
        case 'character.at_war':
            if (fact.subject.type !== 'character' || fact.object?.type !== 'war' || fact.value !== undefined) {
                failShape('character.at_war requires character subject, war object and no value');
            }
            break;
        case 'war.attacker':
        case 'war.defender':
            if (fact.subject.type !== 'war'
                || (fact.object?.type !== 'character' && fact.object?.type !== 'title')
                || fact.value !== undefined) {
                failShape(`${fact.predicate} requires war subject, character/title object and no value`);
            }
            break;
        case 'war.casus_belli':
            if (fact.subject.type !== 'war' || fact.object !== undefined
                || typeof fact.value !== 'string'
                || !(WAR_CASUS_BELLI_VALUES as readonly string[]).includes(fact.value)) {
                failShape('war.casus_belli requires war subject and a bounded enum value');
            }
            break;
        case 'character.war_score_band':
            if (fact.subject.type !== 'character' || fact.object?.type !== 'war'
                || typeof fact.value !== 'string'
                || !(WAR_SCORE_BANDS as readonly string[]).includes(fact.value)) {
                failShape('character.war_score_band requires character subject, war object and a bounded score band');
            }
            break;
        default:
            failShape(`unsupported war predicate ${fact.predicate}`);
    }
}

function validateActivityFactShape(fact: ExtractedGameFactV1, path: string): void {
    const failShape = (message: string): never => fail('INVALID_ACTIVITY_SHAPE', path, message);
    const hasActivityEntity = fact.subject.type === 'activity'
        || fact.subject.type === 'location'
        || fact.object?.type === 'activity'
        || fact.object?.type === 'location';
    if (fact.category !== 'activity' && fact.category !== 'location') {
        if (hasActivityEntity) failShape('activity/location entity refs are reserved for activity or location categories');
        return;
    }

    switch (fact.predicate) {
        case 'character.current_activity':
            if (fact.category !== 'activity'
                || fact.subject.type !== 'character'
                || fact.object?.type !== 'activity'
                || typeof fact.value !== 'string'
                || !(ACTIVITY_TYPE_VALUES as readonly string[]).includes(fact.value)) {
                failShape('character.current_activity requires activity category, character subject, activity object and bounded type');
            }
            break;
        case 'character.traveling':
            if (fact.category !== 'activity'
                || fact.subject.type !== 'character'
                || fact.object !== undefined
                || typeof fact.value !== 'boolean') {
                failShape('character.traveling requires activity category, character subject and boolean value');
            }
            break;
        case 'character.public_location':
            if (fact.category !== 'location'
                || fact.subject.type !== 'character'
                || fact.object?.type !== 'location'
                || fact.value !== undefined) {
                failShape('character.public_location requires location category, character subject, location object and no value');
            }
            break;
        case 'activity.location':
            if (fact.category !== 'location'
                || fact.subject.type !== 'activity'
                || fact.object?.type !== 'location'
                || fact.value !== undefined) {
                failShape('activity.location requires location category, activity subject, location object and no value');
            }
            break;
        default:
            failShape(`unsupported activity/location predicate ${fact.predicate}`);
    }
}

function validateFactDate(value: unknown, path: string): { numeric?: number; display?: string } {
    const obj = requirePlainObject(value, path, FACT_DATE_KEYS);
    const out: { numeric?: number; display?: string } = {};
    const numeric = obj['numeric'];
    if (numeric !== undefined) out.numeric = requireFiniteNumber(numeric, `${path}.numeric`);
    const display = optionalString(obj['display'], `${path}.display`, SAVE_FACT_RESPONSE_MAX_SHORT_STRING_LENGTH);
    if (display !== undefined) out.display = display;
    return out;
}

const MANIFEST_KEYS = [
    'snapshotId', 'sourceFingerprint', 'sourceFormat', 'ck3Version',
    'saveGameVersion', 'parserVersion', 'factSchemaVersion'
] as const;

function validateManifest(value: unknown, path: string): SaveFactExtractionResultV1['manifest'] {
    const obj = requirePlainObject(value, path, MANIFEST_KEYS);
    const factSchemaVersion = requireField(obj, 'factSchemaVersion', path);
    if (factSchemaVersion !== 1) {
        fail('UNSUPPORTED_PROTOCOL_VERSION', `${path}.factSchemaVersion`, `expected 1, got ${JSON.stringify(factSchemaVersion)}`);
    }
    const manifest: SaveFactExtractionResultV1['manifest'] = {
        snapshotId: requireIdOrEmpty(requireField(obj, 'snapshotId', path), `${path}.snapshotId`),
        sourceFingerprint: requireIdOrEmpty(requireField(obj, 'sourceFingerprint', path), `${path}.sourceFingerprint`),
        sourceFormat: requireEnum(requireField(obj, 'sourceFormat', path), `${path}.sourceFormat`, SAVE_SOURCE_FORMATS),
        parserVersion: requireId(requireField(obj, 'parserVersion', path), `${path}.parserVersion`),
        factSchemaVersion: 1
    };
    const ck3Version = optionalId(obj['ck3Version'], `${path}.ck3Version`);
    if (ck3Version !== undefined) manifest.ck3Version = ck3Version;
    const saveGameVersion = optionalIntegerInRange(obj['saveGameVersion'], `${path}.saveGameVersion`, 0, Number.MAX_SAFE_INTEGER);
    if (saveGameVersion !== undefined) manifest.saveGameVersion = saveGameVersion;
    return manifest;
}

const IDENTITY_KEYS = [
    'playerCharacterId', 'gameDateNumeric', 'gameDateDisplay', 'campaignIdParts',
    'snapshotSequence', 'snapshotSlot', 'scriptVariableScale'
] as const;

function validateIdentity(value: unknown, path: string): NonNullable<SaveFactExtractionResultV1['identity']> {
    const obj = requirePlainObject(value, path, IDENTITY_KEYS);
    const identity: NonNullable<SaveFactExtractionResultV1['identity']> = {};
    const playerCharacterId = optionalId(obj['playerCharacterId'], `${path}.playerCharacterId`);
    if (playerCharacterId !== undefined) identity.playerCharacterId = playerCharacterId;
    const gameDateNumeric = obj['gameDateNumeric'];
    if (gameDateNumeric !== undefined) identity.gameDateNumeric = requireFiniteNumber(gameDateNumeric, `${path}.gameDateNumeric`);
    const gameDateDisplay = optionalString(obj['gameDateDisplay'], `${path}.gameDateDisplay`, SAVE_FACT_RESPONSE_MAX_SHORT_STRING_LENGTH);
    if (gameDateDisplay !== undefined) identity.gameDateDisplay = gameDateDisplay;
    const partsRaw = obj['campaignIdParts'];
    if (partsRaw !== undefined) {
        const parts = requireArray(partsRaw, `${path}.campaignIdParts`, 4);
        if (parts.length !== 4) fail('INVALID_TYPE', `${path}.campaignIdParts`, 'expected exactly 4 entries');
        identity.campaignIdParts = parts.map((part, i) =>
            requireIntegerInRange(part, `${path}.campaignIdParts[${i}]`, 0, Number.MAX_SAFE_INTEGER)
        ) as [number, number, number, number];
    }
    const snapshotSequence = optionalIntegerInRange(obj['snapshotSequence'], `${path}.snapshotSequence`, 1, Number.MAX_SAFE_INTEGER);
    if (snapshotSequence !== undefined) identity.snapshotSequence = snapshotSequence;
    const snapshotSlot = optionalIntegerInRange(obj['snapshotSlot'], `${path}.snapshotSlot`, 0, 1);
    if (snapshotSlot !== undefined) identity.snapshotSlot = snapshotSlot;
    const scriptVariableScale = obj['scriptVariableScale'];
    if (scriptVariableScale !== undefined) {
        identity.scriptVariableScale = requireFiniteNumber(scriptVariableScale, `${path}.scriptVariableScale`);
    }
    return identity;
}

const WARNING_KEYS = ['code', 'category'] as const;

function validateWarnings(value: unknown, path: string): Array<{ code: string; category?: string }> {
    const entries = requireArray(value, path, SAVE_FACT_RESPONSE_MAX_WARNINGS);
    return entries.map((entry, i) => {
        const obj = requirePlainObject(entry, `${path}[${i}]`, WARNING_KEYS);
        const code = requireString(requireField(obj, 'code', `${path}[${i}]`), `${path}[${i}].code`, SAVE_FACT_RESPONSE_MAX_SHORT_STRING_LENGTH);
        const warning: { code: string; category?: string } = { code };
        const category = optionalString(obj['category'], `${path}[${i}].category`, SAVE_FACT_RESPONSE_MAX_SHORT_STRING_LENGTH);
        if (category !== undefined) warning.category = category;
        return warning;
    });
}

const ERROR_KEYS = ['code'] as const;

function validateError(value: unknown, path: string): { code: SaveFactErrorCode } {
    const obj = requirePlainObject(value, path, ERROR_KEYS);
    return {
        code: requireEnum(requireField(obj, 'code', path), `${path}.code`, SAVE_FACT_ERROR_CODES)
    };
}

const METRICS_KEYS = ['inputBytes', 'decompressedBytes', 'durationMs', 'emittedFacts', 'emittedEntities', 'scannedBytes'] as const;

function validateMetrics(value: unknown, path: string): SaveFactExtractionResultV1['metrics'] {
    const obj = requirePlainObject(value, path, METRICS_KEYS);
    const metrics: SaveFactExtractionResultV1['metrics'] = {
        inputBytes: requireIntegerInRange(requireField(obj, 'inputBytes', path), `${path}.inputBytes`, 0, SAVE_FACT_RESPONSE_MAX_BYTES),
        durationMs: requireIntegerInRange(requireField(obj, 'durationMs', path), `${path}.durationMs`, 0, SAVE_FACT_RESPONSE_MAX_DURATION_MS),
        emittedFacts: requireIntegerInRange(requireField(obj, 'emittedFacts', path), `${path}.emittedFacts`, 0, SAVE_FACT_RESPONSE_MAX_EMITTED),
        emittedEntities: requireIntegerInRange(requireField(obj, 'emittedEntities', path), `${path}.emittedEntities`, 0, SAVE_FACT_RESPONSE_MAX_EMITTED)
    };
    const decompressedBytes = optionalIntegerInRange(obj['decompressedBytes'], `${path}.decompressedBytes`, 0, SAVE_FACT_RESPONSE_MAX_BYTES);
    if (decompressedBytes !== undefined) metrics.decompressedBytes = decompressedBytes;
    const scannedBytes = optionalIntegerInRange(obj['scannedBytes'], `${path}.scannedBytes`, 0, SAVE_FACT_RESPONSE_MAX_BYTES);
    if (scannedBytes !== undefined) metrics.scannedBytes = scannedBytes;
    return metrics;
}

// ---------------------------------------------------------------------------
// Top-level response validator
// ---------------------------------------------------------------------------

const RESPONSE_KEYS = [
    'protocolVersion', 'operation', 'status', 'manifest', 'identity',
    'joinCandidates', 'entities', 'facts', 'warnings', 'error', 'metrics'
] as const;
const RESPONSE_STATUSES: readonly SaveFactResultStatus[] = ['ok', 'partial', 'unsupported', 'invalid'];

/**
 * Validate a parsed (or hand-built) sidecar response against the protocol v2
 * whitelist. Never throws; returns a discriminated result. The returned DTO
 * is rebuilt from known keys only, so no reference to the caller's object
 * graph survives validation.
 */
export function validateSaveFactExtractionResult(input: unknown): SaveFactValidationResult {
    try {
        assertStructurallySafe(input, '$');

        const obj = requirePlainObject(input, '$', RESPONSE_KEYS);

        const protocolVersion = requireField(obj, 'protocolVersion', '$');
        if (protocolVersion !== 2) {
            fail(
                'UNSUPPORTED_PROTOCOL_VERSION',
                '$.protocolVersion',
                `expected 2, got ${JSON.stringify(protocolVersion)}`
            );
        }

        const operation = requireEnum(requireField(obj, 'operation', '$'), '$.operation', ['probe', 'extract'] as const);
        const status = requireEnum(requireField(obj, 'status', '$'), '$.status', RESPONSE_STATUSES);

        const result: SaveFactExtractionResultV1 = {
            protocolVersion: 2,
            operation,
            status,
            manifest: validateManifest(requireField(obj, 'manifest', '$'), '$.manifest'),
            entities: requireArray(requireField(obj, 'entities', '$'), '$.entities', SAVE_FACT_RESPONSE_MAX_ENTITIES)
                .map((entry, i) => validateCanonicalEntity(entry, `$.entities[${i}]`)),
            facts: requireArray(requireField(obj, 'facts', '$'), '$.facts', SAVE_FACT_RESPONSE_MAX_FACTS)
                .map((entry, i) => validateExtractedFact(entry, `$.facts[${i}]`)),
            warnings: validateWarnings(requireField(obj, 'warnings', '$'), '$.warnings'),
            metrics: validateMetrics(requireField(obj, 'metrics', '$'), '$.metrics')
        };

        if (obj['identity'] !== undefined) {
            result.identity = validateIdentity(obj['identity'], '$.identity');
        }
        if (obj['joinCandidates'] !== undefined) {
            result.joinCandidates = validateJoinCandidates(obj['joinCandidates'], '$.joinCandidates');
        }
        if (obj['error'] !== undefined) {
            result.error = validateError(obj['error'], '$.error');
        }

        // Plan 5.4: a probe must not emit entities or facts.
        if (operation === 'probe' && (result.entities.length > 0 || result.facts.length > 0)) {
            fail('PROBE_NOT_EMPTY', '$', 'probe responses must have empty entities and facts arrays');
        }

        return { ok: true, value: result };
    } catch (error) {
        if (error instanceof SaveFactValidationError) {
            return { ok: false, code: error.code, path: error.path, message: error.message };
        }
        return {
            ok: false,
            code: 'INVALID_TYPE',
            path: '$',
            message: error instanceof Error ? error.message : String(error)
        };
    }
}

// P5b deferred (verify/session/delta/agency): 1.x re-exported
// `validateSaveFactCapabilitiesResult`, `validateSaveVerificationRequestV2`
// and `validateSaveVerificationResponseV2` from
// `./saveFactVerificationSchemas` here ("P1-A protocol v2 validators live in a
// separate file..."). That file is not ported to 2CE and the capabilities /
// verification ops are deferred, so the re-export (and the only consumers, the
// agency-facing client op paths) are removed. The v1 extraction validator
// above keeps its strict wire contract and error paths unchanged.
