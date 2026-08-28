/**
 * Save-fact display-name resolution (implementation plan Task 14 step 2).
 *
 * Resolution priority for an entity display name:
 *   1. live `GameData.characters` entry with the same id -> `fullName`;
 *   2. live GameData localized fields (a `character.primary_title` fact's
 *      object title, and a canonically mapped complete military war name);
 *   3. current snapshot `displayNameCandidate` literal or explicit mapping,
 *      passed through the sanitizer;
 *   4. timeline-filtered campaign entity-name cache;
 *   5. compatibility store lookup for isolated legacy callers;
 *   6. unresolved: the fact is kept internally but reported not renderable.
 *
 * Anything shaped like a raw CK3 localization key (`k_*`, `dynn_*`,
 * `ERROR:*`) is NEVER emitted as a display name, regardless of source.
 */

import type { GameData } from '../../shared/gameData/GameData';
import type { Character } from '../../shared/gameData/Character';
import { looksLikeRawLocKey } from './SaveFactStore';
import type {
    EntityNameEntry,
    EntityNameUpdate,
    SaveFactStore,
    SaveFactTimelineContext
} from './SaveFactStore';
import type { CanonicalEntityV1, EntityRef, GameFact } from './saveFactTypes';

/** Hard cap for any resolved display name (characters, not bytes). */
export const SAVE_FACT_DISPLAY_NAME_MAX_LENGTH = 160;

/** Control characters that are really whitespace: folded, not stripped. */
// eslint-disable-next-line no-control-regex
const CONTROL_WHITESPACE_PATTERN = /[\t\n\r]/g;
/** C0 controls (minus whitespace), DEL, and bidi/format controls that must never reach a prompt. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Sanitize a candidate display name: Unicode NFC, fold tab/newline controls
 * into whitespace, strip NUL/C0/DEL and bidi control characters, collapse
 * whitespace, cap at 160 chars. Returns `undefined` when nothing usable
 * remains or the value is a raw localization key (`k_*`, `dynn_*`, `ERROR:*`).
 */
export function sanitizeDisplayName(input: string): string | undefined {
    if (typeof input !== 'string' || input.length === 0) return undefined;
    const normalized = input
        .normalize('NFC')
        .replace(CONTROL_WHITESPACE_PATTERN, ' ')
        .replace(CONTROL_CHAR_PATTERN, '')
        .replace(WHITESPACE_PATTERN, ' ')
        .trim()
        .slice(0, SAVE_FACT_DISPLAY_NAME_MAX_LENGTH)
        .trim();
    if (normalized.length === 0) return undefined;
    if (looksLikeRawLocKey(normalized)) return undefined;
    return normalized;
}

export type EntityNameResolutionSource =
    | 'live_character'
    | 'live_primary_title'
    | 'live_war'
    | 'entity_name_cache'
    | 'sidecar_literal'
    | 'local_mapping';

export interface EntityNameResolution {
    resolved: boolean;
    displayName?: string;
    source?: EntityNameResolutionSource;
}

export interface SaveFactNameResolverContext {
    gameData?: GameData;
    /** Validated sidecar entities, used for literal/localization_key candidates. */
    entities?: readonly CanonicalEntityV1[];
    /** One timeline-filtered cache snapshot captured at prepare start. */
    nameSnapshot?: SaveFactNameResolverSnapshot;
    /** Compatibility campaign entity-name lookup for isolated callers. */
    store?: Pick<SaveFactStore, 'resolveEntityName'>;
    timelineContext?: SaveFactTimelineContext;
    /**
     * Explicit local mapping for supported localization keys (priority 5).
     * First release ships the mechanism only; callers may pass an empty map.
     */
    localizations?: Readonly<Record<string, string>>;
}

/**
 * Immutable, per-prepare view of the entity-name cache. Production callers
 * must provide this instead of resolving through the store for every fact;
 * the latter would turn a bounded preparation into fact-count-dependent I/O.
 */
export interface SaveFactNameResolverSnapshot {
    readonly entries: readonly EntityNameEntry[];
    readonly timelineContext?: SaveFactTimelineContext;
}

export interface ResolvedFactNames {
    subject: EntityNameResolution;
    object?: EntityNameResolution;
    /** False when any name the fact needs could not be resolved; the fact is kept internally. */
    renderable: boolean;
}

/** Live character lookup: save entity ids are strings, GameData keys are numbers. */
function findLiveCharacter(gameData: GameData | undefined, id: string): Character | undefined {
    if (gameData === undefined || !/^\d+$/.test(id)) return undefined;
    return gameData.characters.get(Number(id));
}

function resolved(displayName: string, source: EntityNameResolutionSource): EntityNameResolution {
    return { resolved: true, displayName, source };
}

const UNRESOLVED: EntityNameResolution = Object.freeze({ resolved: false });

function findEntityCandidate(
    entities: readonly CanonicalEntityV1[] | undefined,
    ref: EntityRef
): CanonicalEntityV1['displayNameCandidate'] | undefined {
    if (entities === undefined) return undefined;
    if (!['character', 'title', 'war', 'activity', 'location'].includes(ref.type)) return undefined;
    return entities.find(entity => entity.type === ref.type && entity.id === ref.id)?.displayNameCandidate;
}

const NAME_SOURCE_PRECEDENCE: Readonly<Record<EntityNameEntry['source'], number>> = {
    verified_literal: 1,
    live_gamedata: 2
};

function findSnapshotName(
    snapshot: SaveFactNameResolverSnapshot | undefined,
    ref: EntityRef
): string | undefined {
    if (snapshot === undefined || !['character', 'title', 'activity', 'location'].includes(ref.type)) return undefined;
    const candidates = snapshot.entries.filter(entry => entry.entityType === ref.type && entry.id === ref.id);
    if (candidates.length === 0) return undefined;

    const ancestors = snapshot.timelineContext?.registry !== undefined
        && snapshot.timelineContext.currentNodeId !== undefined
        ? snapshot.timelineContext.registry.getAncestors(snapshot.timelineContext.currentNodeId)
        : [];
    const distance = (entry: EntityNameEntry): number => {
        if (entry.timelineNodeId === undefined) return Number.MAX_SAFE_INTEGER;
        const index = ancestors.indexOf(entry.timelineNodeId);
        return index < 0 ? Number.MAX_SAFE_INTEGER - 1 : index;
    };
    const selected = [...candidates].sort((a, b) => {
        const distanceDelta = distance(a) - distance(b);
        if (distanceDelta !== 0) return distanceDelta;
        const epochDelta = (b.checkpointEpoch ?? Number.NEGATIVE_INFINITY)
            - (a.checkpointEpoch ?? Number.NEGATIVE_INFINITY);
        if (epochDelta !== 0) return epochDelta;
        const sourceDelta = NAME_SOURCE_PRECEDENCE[b.source] - NAME_SOURCE_PRECEDENCE[a.source];
        if (sourceDelta !== 0) return sourceDelta;
        return b.updatedAt.localeCompare(a.updatedAt);
    })[0];
    return sanitizeDisplayName(selected.displayName);
}

function updateForResolution(
    ref: EntityRef,
    resolution: EntityNameResolution
): EntityNameUpdate | undefined {
    if (!resolution.resolved || resolution.displayName === undefined) return undefined;
    if (ref.type !== 'character' && ref.type !== 'title') return undefined;
    const source = resolution.source === 'live_character' || resolution.source === 'live_primary_title'
        ? 'live_gamedata'
        : resolution.source === 'sidecar_literal' || resolution.source === 'local_mapping'
            ? 'verified_literal'
            : undefined;
    return source === undefined
        ? undefined
        : { entityType: ref.type, id: ref.id, displayName: resolution.displayName, source };
}

/**
 * Resolve the display name for one entity reference following the plan's
 * priority order. `viaFact` enables priority 2 (live localized fields) for
 * the object of a `character.primary_title` fact.
 */
export function resolveEntityDisplayName(
    ref: EntityRef,
    context: SaveFactNameResolverContext,
    viaFact?: GameFact
): EntityNameResolution {
    // Priority 1: live GameData character fullName.
    if (ref.type === 'character') {
        const live = findLiveCharacter(context.gameData, ref.id);
        const fullName = live !== undefined ? sanitizeDisplayName(live.fullName) : undefined;
        if (fullName !== undefined) return resolved(fullName, 'live_character');
    }

    // Priority 2: live GameData localized fields (primary title display).
    if (
        ref.type === 'title'
        && viaFact !== undefined
        && viaFact.predicate === 'character.primary_title'
        && viaFact.object !== undefined
        && saveFactRefEquals(viaFact.object, ref)
    ) {
        const live = findLiveCharacter(context.gameData, viaFact.subject.id);
        const primaryTitle = live !== undefined ? sanitizeDisplayName(live.primaryTitle) : undefined;
        if (primaryTitle !== undefined) return resolved(primaryTitle, 'live_primary_title');
    }

    // A complete military snapshot is the display authority for the same
    // canonical war id. Save-side war names remain the fallback when the live
    // snapshot is absent, incomplete, capped away, or cannot map the id
    // exactly.
    if (ref.type === 'war' && context.gameData?.militarySnapshot?.complete === true
        && /^(0|[1-9]\d*)$/.test(ref.id)) {
        const numericId = Number(ref.id);
        if (Number.isSafeInteger(numericId) && String(numericId) === ref.id) {
            const liveWar = context.gameData.militarySnapshot.wars.get(numericId);
            const liveWarName = liveWar !== undefined ? sanitizeDisplayName(liveWar.name) : undefined;
            if (liveWarName !== undefined) return resolved(liveWarName, 'live_war');
        }
    }

    const candidate = findEntityCandidate(context.entities, ref);

    // Priority 3: current extract/cache sidecar literal candidate, sanitized.
    if (candidate?.kind === 'literal') {
        const sanitized = sanitizeDisplayName(candidate.value);
        if (sanitized !== undefined) return resolved(sanitized, 'sidecar_literal');
    }

    // A validated fact endpoint may carry the same current-snapshot literal.
    // It is only a fallback after the canonical entity table candidate.
    const refDisplayName = sanitizeDisplayName(ref.displayName ?? '');
    if (refDisplayName !== undefined) return resolved(refDisplayName, 'sidecar_literal');

    // Priority 4: explicit local mapping for supported localization keys.
    if (candidate?.kind === 'localization_key' && context.localizations !== undefined) {
        const mapped = context.localizations[candidate.value];
        const sanitized = mapped !== undefined ? sanitizeDisplayName(mapped) : undefined;
        if (sanitized !== undefined) return resolved(sanitized, 'local_mapping');
    }

    // Priority 5: one-time timeline-filtered campaign cache snapshot.
    const snapshotName = findSnapshotName(context.nameSnapshot, ref);
    if (snapshotName !== undefined) return resolved(snapshotName, 'entity_name_cache');

    // Compatibility fallback for older isolated callers/tests. Production
    // preparation supplies `nameSnapshot` and never reaches this I/O-shaped
    // surface, so entity count cannot amplify cache reads on the hot path.
    if (context.store !== undefined && (ref.type === 'character' || ref.type === 'title')) {
        const cached = context.store.resolveEntityName(ref.type, ref.id, context.timelineContext);
        const sanitized = cached !== undefined ? sanitizeDisplayName(cached) : undefined;
        if (sanitized !== undefined) return resolved(sanitized, 'entity_name_cache');
    }

    // War ids are opaque internal correlation keys. There is intentionally no
    // `ref.id` fallback here: a war without a validated literal or explicit
    // safe mapping remains unresolved and cannot enter the prompt.
    // Priority 6: unresolved — kept internally, not renderable.
    return UNRESOLVED;
}

function saveFactRefEquals(a: EntityRef, b: EntityRef): boolean {
    return a.type === b.type && a.id === b.id;
}

/**
 * Resolve both ends of a fact. `renderable` is false when the subject, or a
 * present object, has no resolvable display name; the fact itself is retained
 * for internal indexing either way.
 */
export function resolveFactDisplayNames(
    fact: GameFact,
    context: SaveFactNameResolverContext
): ResolvedFactNames {
    const subject = resolveEntityDisplayName(fact.subject, context, fact);
    const object = fact.object !== undefined
        ? resolveEntityDisplayName(fact.object, context, fact)
        : undefined;
    const renderable = subject.resolved && (object === undefined || object.resolved);
    return { subject, object, renderable };
}

/**
 * Materialize names only for facts that the registry has made public. Internal
 * and blocked facts remain ID-bearing records for indexing, but their names
 * are never copied into the cross-session cache or into the public context.
 */
export function materializeResolvedFactNames(
    facts: readonly GameFact[],
    context: SaveFactNameResolverContext & { nameSnapshot?: SaveFactNameResolverSnapshot }
): {
    facts: GameFact[];
    updates: EntityNameUpdate[];
    unresolvedEntityCount: number;
} {
    const updates = new Map<string, EntityNameUpdate>();
    const unresolved = new Set<string>();
    const materialized = facts.map(fact => {
        if (fact.visibility !== 'public') return fact;
        const names = resolveFactDisplayNames(fact, context);
        const subjectUpdate = updateForResolution(fact.subject, names.subject);
        const objectUpdate = fact.object !== undefined && names.object !== undefined
            ? updateForResolution(fact.object, names.object)
            : undefined;
        for (const update of [subjectUpdate, objectUpdate]) {
            if (update === undefined) continue;
            const key = `${update.entityType}:${update.id}`;
            const existing = updates.get(key);
            if (existing === undefined || (existing.source === 'verified_literal' && update.source === 'live_gamedata')) {
                updates.set(key, update);
            }
        }
        if (!names.subject.resolved) unresolved.add(`${fact.subject.type}:${fact.subject.id}`);
        if (fact.object !== undefined && names.object !== undefined && !names.object.resolved) {
            unresolved.add(`${fact.object.type}:${fact.object.id}`);
        }
        return {
            ...fact,
            subject: names.subject.resolved && names.subject.displayName !== undefined
                ? { ...fact.subject, displayName: names.subject.displayName }
                : { ...fact.subject },
            object: fact.object === undefined
                ? undefined
                : names.object?.resolved && names.object.displayName !== undefined
                    ? { ...fact.object, displayName: names.object.displayName }
                    : { ...fact.object }
        };
    });
    return {
        facts: materialized,
        updates: [...updates.values()],
        unresolvedEntityCount: unresolved.size
    };
}
