/**
 * Save snapshot coordinator (implementation plan Task 13).
 *
 * Single entry point that turns one `VOTC:IN` GameData observation into an
 * immutable `ConversationFactContext` for the Conversation constructor
 * (plan section 4: prepare runs BEFORE `new Conversation`, and a failed
 * preparation returns a status object instead of throwing through the
 * VOTC:IN handler).
 *
 * Responsibilities:
 * - Step 2 (early exits): parser feature disabled, legacy/disabled/
 *   unsupported/truncated/invalid mod snapshot tail, missing numeric date or
 *   campaign identity, and unavailable platform/sidecar all return a typed
 *   empty context immediately — none of them ever starts the file wait.
 * - Step 3 (task key + dedup/preemption): in-flight preparations are keyed by
 *   `campaignId/playerId/sequence/slot`. The same key reuses the same
 *   Promise; a higher sequence for the same campaign/player aborts the stale
 *   task (its waiter/parser runs observe the AbortSignal and settle as
 *   superseded); a lower (or equal) sequence is answered with `superseded`
 *   without touching the file system; different campaign/player preparations
 *   serialize through a single process queue. Completed tasks are removed
 *   from the map in a `finally`, so the map never leaks.
 * - Step 4 (fixed pipeline): waiter (stable candidate + probe + first
 *   identity validation are internal to `SaveSnapshotWaiter`) ->
 *   participant-presence assessment -> verified cache lookup
 *   (`SaveFactStore`) -> extract only on cache miss -> second identity
 *   validation on the extract response -> best-effort atomic cache write ->
 *   immutable context.
 * - Step 5 (total deadline): the budget clock starts when `prepare` is
 *   entered; wait, extract and the cache write each receive only the
 *   remaining ms. A cache write that fails or has no budget left degrades to
 *   an in-memory-only result plus a warning code — verified facts are never
 *   dropped because diagnostics persistence failed.
 * - Step 6 (immutability): the returned context is deeply frozen, the
 *   manifest/baseline facts are rebuilt from validated DTO fields (the raw
 *   sidecar result object is never exposed) and the diagnostics array is a
 *   frozen copy.
 * - Step 7 (error convergence): every failure maps to a status + code and
 *   resolves; ordinary errors never reject. The outermost body is wrapped in
 *   a fail-open try/catch so a programmer invariant can still throw in
 *   development while the production handler always gets a context.
 *
 * Task 14 wiring: authority resolution (`SaveFactAuthorityResolver`), the
 * predicate-registry visibility policy (`SaveFactVisibilityPolicy`) and the
 * bounded `SaveFactIndex` run at the marked integration point in
 * `runPreparation`, uniformly over cached and freshly extracted facts, so a
 * cache hit and a fresh extract produce the same post-policy context. The
 * cache stores the RAW schema-validated extract (pre-authority), because
 * authority depends on the live GameData of THIS conversation start.
 */

import * as path from 'path';
// P5b deferred (verify/session/delta/agency): 1.x routed the localization
// attach through `../ck3Localization/attachLocalizations.js` (a 2CE-unported
// module). That helper only spread `localizations` into the resolver context,
// so this file inlines the same spread at the single call site below. 1.x also
// used `logicalRequestHash` (promptWorkbench/canonicalJson) for the delta
// scope digest; that import is removed with the delta trim.
import type { GameData } from '../../shared/gameData/GameData';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity';
import {
    CampaignIdentityUnavailableError,
    type CampaignIdentitySource
} from '../campaignIdentityResolver';
import type { SaveParserPathResult } from './saveParserPath';
import type { SaveFactSettings } from './saveFactSettings';
import {
    assessParticipantPresence,
    validateSnapshotIdentity,
    type ExpectedSnapshotIdentity
} from './SaveIdentityValidator';
import type { SaveParserRunOutcome, SaveParserRunOptions } from './SaveParserClient';
import type { SaveParserRunHandle } from './SaveParserClient';
import { applySaveFactAuthority } from './SaveFactAuthorityResolver';
import { buildSaveFactIndex } from './SaveFactIndex';
import {
    materializeResolvedFactNames,
    resolveEntityDisplayName
} from './SaveFactNameResolver';
import type { SaveFactNameResolverContext, SaveFactNameResolverSnapshot } from './SaveFactNameResolver';
import { applySaveFactVisibilityPolicy } from './SaveFactVisibilityPolicy';
import { PROBE_REQUEST_LIMITS } from './SaveSnapshotWaiter';
import type {
    SaveSnapshotWaitOptions,
    SaveSnapshotWaitResult
} from './SaveSnapshotWaiter';
import {
    type PersistedSaveFactSnapshotV1,
    type SaveFactCacheRequestKey,
    type SaveFactCheckpointProvenance,
    type EntityNameUpdate,
    type SaveFactEntityNameSnapshot,
    type SaveFactSnapshotInput,
    type SaveFactTimelineContext,
    type VerifiedSaveIdentity
} from './SaveFactStore';
import {
    createEmptyConversationFactContext,
    SAVE_FACT_CATEGORIES
} from './saveFactTypes';
import type {
    CanonicalEntityV1,
    ConversationFactContext,
    ExtractedGameFactV1,
    GameFact,
    SaveFactCategory,
    SaveFactErrorCode,
    SaveFactExtractionRequestV1,
    SaveFactExtractionResultV1,
    SaveFactIndex,
    SaveFactPreparationTelemetry,
    SaveSnapshotManifest
} from './saveFactTypes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Extract request limits. Unlike the waiter's probe (maxFacts: 0), an
 * extract run asks for the bounded participant neighborhood; every cap is a
 * hard protocol bound the sidecar must respect.
 */
export const SAVE_SNAPSHOT_EXTRACT_REQUEST_LIMITS: SaveFactExtractionRequestV1['limits'] = {
    maxFacts: 500,
    maxEntities: 250,
    maxRelatedCharacters: 64,
    maxOutputBytes: 2 * 1024 * 1024,
    maxDecompressedBytes: 512 * 1024 * 1024,
    maxNestingDepth: 512,
    maxScalarBytes: 64 * 1024
};

// P5b deferred (verify/session/delta/agency): the 1.x coordinator also ran a
// bounded business-delta store (`SaveFactDeltaStore`) and an agency verify
// snapshot ref (`SaveFactVerificationSnapshotRef`) after the extract. Both are
// deferred for 2CE: the delta scope digest/epoch, `createDeltaStore` hook,
// `persistDelta` plumbing and `resolveSaveFactDeltaTimelineRelation` helper
// are removed here, and the verify snapshot is no longer planned or attached
// to the context. Cache dedup/preemption, deadline budget and the raw
// pre-authority cache extract are unchanged.

/** Warning code: the extract run finished with `status: 'partial'`. */
export const SAVE_SNAPSHOT_WARNING_EXTRACT_PARTIAL = 'EXTRACT_PARTIAL';
/** Warning code: the derived cache write failed; in-memory facts were kept. */
export const SAVE_SNAPSHOT_WARNING_CACHE_WRITE_FAILED = 'CACHE_WRITE_FAILED';
/** Warning code: no budget remained for the cache write; skipped on purpose. */
export const SAVE_SNAPSHOT_WARNING_CACHE_WRITE_SKIPPED = 'CACHE_WRITE_SKIPPED_DEADLINE';
/** Warning code: an entity-name cache read failed and the prepare continued. */
export const SAVE_SNAPSHOT_WARNING_NAME_CACHE_READ_FAILED = 'ENTITY_NAME_CACHE_READ_FAILED';
/** Warning code: an entity-name cache write failed or was rejected. */
export const SAVE_SNAPSHOT_WARNING_NAME_CACHE_WRITE_FAILED = 'ENTITY_NAME_CACHE_WRITE_FAILED';
/** Warning code: no budget remained to schedule an entity-name write. */
export const SAVE_SNAPSHOT_WARNING_NAME_CACHE_WRITE_SKIPPED = 'ENTITY_NAME_CACHE_WRITE_SKIPPED_DEADLINE';

/** Diagnostics stay bounded no matter how chatty the sidecar warnings are. */
const MAX_WARNING_CODES = 16;

// ---------------------------------------------------------------------------
// Injectable surfaces
// ---------------------------------------------------------------------------

/** Minimal waiter surface; `SaveSnapshotWaiter` satisfies it. */
export interface SaveSnapshotWaiterLike {
    wait(options: SaveSnapshotWaitOptions): Promise<SaveSnapshotWaitResult>;
}

/** Minimal parser client surface; `SaveParserClient` satisfies it. */
export interface SaveSnapshotCoordinatorParserClientLike {
    start(options: SaveParserRunOptions): SaveParserRunHandle;
}

/** Minimal store surface; `SaveFactStore` satisfies it. */
export interface SaveFactStoreLike {
    findCachedSnapshot(
        key: SaveFactCacheRequestKey,
        context?: SaveFactTimelineContext
    ): PersistedSaveFactSnapshotV1 | undefined;
    saveCurrent(
        input: SaveFactSnapshotInput,
        options?: { diagnosticsEnabled?: boolean }
    ): PersistedSaveFactSnapshotV1;
    /** Production path: current snapshot shares the name-cache FIFO. */
    scheduleCurrent?(
        input: SaveFactSnapshotInput,
        options?: { diagnosticsEnabled?: boolean },
        writeDeadline?: number
    ): boolean;
    /** One timeline-filtered read per preparation, never per entity/fact. */
    loadEntityNameSnapshot?(context?: SaveFactTimelineContext): SaveFactEntityNameSnapshot;
    /** Best-effort bounded queue; scheduling must not block conversation start. */
    scheduleEntityNameUpdate?(
        updates: EntityNameUpdate[],
        provenance?: SaveFactCheckpointProvenance,
        writeDeadline?: number
    ): boolean;
    /** App shutdown hook for the scope-owned persistence FIFO. */
    flushOrDiscardPersistence?(deadlineOrTimeoutMs?: number): Promise<{ flushed: boolean; discarded: number }>;
}

/** Minimal clock surface; defaults to `Date.now`. */
export interface SaveSnapshotCoordinatorClockLike {
    now(): number;
}

/** Minimal logger surface; receives codes only, never payload content. */
export interface SaveSnapshotCoordinatorLoggerLike {
    warn(message: string): void;
}

export interface SaveSnapshotCoordinatorDeps {
    /** Snapshot file waiter (owns stability sampling and the identity probe). */
    waiter: SaveSnapshotWaiterLike;
    /** Parser client used for the (heavier) extract run after a probe match. */
    parserClient: SaveSnapshotCoordinatorParserClientLike;
    /** Store factory; the store is scoped to the resolved campaign/player. */
    createStore: (userDataDir: string, identity: CampaignPlayerIdentity) => SaveFactStoreLike;
    // P5b deferred (verify/session/delta/agency): 1.x also accepted an
    // optional `createDeltaStore` factory here; removed with the delta trim.
    /**
     * Campaign identity capture (`requireCampaignIdentity`). Throws
     * `CampaignIdentityUnavailableError` for legacy/unsupported/invalid
     * campaign tails; those failures converge to unavailable/unsupported/
     * mismatch contexts and never fall back to a player-only namespace.
     */
    resolveCampaignIdentity: (source: CampaignIdentitySource) => CampaignPlayerIdentity;
    /** Sidecar executable resolver (platform gate + existence check). */
    resolveParserExecutable: () => SaveParserPathResult;
    /** CK3 user folder (`config.userFolderPath`) for the snapshot file wait. */
    getUserFolderPath: () => string;
    /**
     * Optional timeline/checkpoint context provider. When omitted the cache
     * lookup runs without a registry and the checkpoint provenance falls back
     * to the GameData checkpoint epoch alone.
     */
    getTimelineContext?: (
        gameData: GameData,
        identity: CampaignPlayerIdentity
    ) => SaveFactTimelineContext | undefined;
    /** Injectable clock; defaults to `Date.now`. */
    clock?: SaveSnapshotCoordinatorClockLike;
    /** Logger; receives codes only. */
    logger?: SaveSnapshotCoordinatorLoggerLike;
}

export interface SaveSnapshotCoordinatorPrepareOptions {
    /** App userData dir; root of the campaign/player scoped cache store. */
    appUserDataDir: string;
    /** Normalized settings (`buildSaveFactSettings` output). */
    settings: SaveFactSettings;
    /**
     * Monotonic conversation start generation. The coordinator does not order
     * generations itself (main.ts owns the generation counter and drops stale
     * results); the value is kept for diagnostics and future assertions.
     */
    startGeneration: number;
    /** External cancellation (a newer VOTC:IN start supersedes this one). */
    signal?: AbortSignal;
    /**
     * Conversation-scoped CK3 localization table captured before preparation
     * starts (main process only; never renderer-facing). Undefined preserves
     * the previous behaviour of an absent `nameContext.localizations`.
     */
    localizations?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Task registry (step 3)
// ---------------------------------------------------------------------------

interface PrepareTaskRecord {
    /** `campaignId/playerId/sequence/slot`. */
    key: string;
    /** `campaignId/playerId` — preemption scope. */
    ownerKey: string;
    sequence: number;
    controller: AbortController;
    signal: AbortSignal;
    promise: Promise<ConversationFactContext>;
}

type PreflightResult =
    | { ok: false; context: ConversationFactContext }
    | {
        ok: true;
        identity: CampaignPlayerIdentity;
        expected: ExpectedSnapshotIdentity;
        sequence: number;
        slot: 0 | 1;
        categories: SaveFactCategory[];
    };

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Combine two abort sources without relying on `AbortSignal.any` (not
 * available on all supported runtimes). Listeners are removed when the
 * combined signal fires.
 */
function combineAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
    if (external === undefined) return internal;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (external.aborted || internal.aborted) {
        controller.abort();
        return controller.signal;
    }
    external.addEventListener('abort', onAbort, { once: true });
    internal.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
}

/** Bounded deep freeze for the DTO-shaped context payload. */
function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
    }
    return value;
}

export class SaveSnapshotCoordinator {
    private readonly waiter: SaveSnapshotWaiterLike;
    private readonly parserClient: SaveSnapshotCoordinatorParserClientLike;
    private readonly createStore: SaveSnapshotCoordinatorDeps['createStore'];
    private readonly resolveCampaignIdentity: SaveSnapshotCoordinatorDeps['resolveCampaignIdentity'];
    private readonly resolveParserExecutable: () => SaveParserPathResult;
    private readonly getUserFolderPath: () => string;
    private readonly getTimelineContext?: SaveSnapshotCoordinatorDeps['getTimelineContext'];
    private readonly clock: SaveSnapshotCoordinatorClockLike;
    private readonly logger?: SaveSnapshotCoordinatorLoggerLike;

    private readonly tasks = new Map<string, PrepareTaskRecord>();
    /** One store/FIFO per app-userData + campaign + player scope. */
    private readonly stores = new Map<string, SaveFactStoreLike>();
    /** Serializes tasks of DIFFERENT campaign/player owners (step 3). */
    private queueTail: Promise<unknown> = Promise.resolve();
    private shuttingDown = false;

    constructor(deps: SaveSnapshotCoordinatorDeps) {
        this.waiter = deps.waiter;
        this.parserClient = deps.parserClient;
        this.createStore = deps.createStore;
        this.resolveCampaignIdentity = deps.resolveCampaignIdentity;
        this.resolveParserExecutable = deps.resolveParserExecutable;
        this.getUserFolderPath = deps.getUserFolderPath;
        this.getTimelineContext = deps.getTimelineContext;
        this.clock = deps.clock ?? { now: () => Date.now() };
        this.logger = deps.logger;
    }

    /** Test/diagnostics hook: number of in-flight task records. */
    get pendingTaskCount(): number {
        return this.tasks.size;
    }

    /** Number of campaign/player persistence scopes created after G0. */
    get persistenceScopeCount(): number {
        return this.stores.size;
    }

    /**
     * Stop new work, cancel active preparation and boundedly flush every
     * scope-owned persistence FIFO. The Electron owner calls this once from
     * `before-quit`; a spent deadline discards only not-yet-started writes.
     */
    async shutdownPersistence(deadlineMs = Date.now() + 250): Promise<{ flushed: boolean; discarded: number }> {
        this.shuttingDown = true;
        for (const record of this.tasks.values()) record.controller.abort();
        this.tasks.clear();

        const remainingForPreparation = Math.max(0, deadlineMs - Date.now());
        if (remainingForPreparation > 0) {
            await Promise.race([
                this.queueTail.then(() => undefined, () => undefined),
                new Promise<void>(resolve => setTimeout(resolve, remainingForPreparation))
            ]);
        }

        return this.flushPersistence(deadlineMs);
    }

    /** Flush already-scheduled scope writes without disabling preparation. */
    async flushPersistence(deadlineMs = Date.now() + 250): Promise<{ flushed: boolean; discarded: number }> {
        const stores = [...this.stores.values()];
        const results = await Promise.all(stores.map(async store => {
            if (store.flushOrDiscardPersistence === undefined) return { flushed: true, discarded: 0 };
            try {
                return await store.flushOrDiscardPersistence(deadlineMs);
            } catch {
                return { flushed: false, discarded: 0 };
            }
        }));
        return {
            flushed: results.every(result => result.flushed),
            discarded: results.reduce((sum, result) => sum + result.discarded, 0)
        };
    }

    /**
     * Prepare the immutable fact context for one conversation start. Always
     * resolves with a `ConversationFactContext`; never rejects (step 7).
     */
    prepare(
        gameData: GameData,
        opts: SaveSnapshotCoordinatorPrepareOptions
    ): Promise<ConversationFactContext> {
        if (this.shuttingDown) {
            return Promise.resolve(createEmptyConversationFactContext('superseded', 'START_SUPERSEDED'));
        }
        try {
            return this.startTask(gameData, opts);
        } catch (error) {
            // Fail-open outermost guard (step 7): a programmer invariant may
            // throw in development, but the production VOTC:IN handler always
            // receives a degraded context instead of an exception.
            this.logger?.warn(`[SaveSnapshotCoordinator] prepare failed open: ${describeError(error)}`);
            return Promise.resolve(createEmptyConversationFactContext('failed', 'SAVE_PARSE_FAILED'));
        }
    }

    // -----------------------------------------------------------------------
    // Step 2: early exits
    // -----------------------------------------------------------------------

    private preflight(gameData: GameData, settings: SaveFactSettings): PreflightResult {
        const early = (status: Parameters<typeof createEmptyConversationFactContext>[0], code?: SaveFactErrorCode): PreflightResult => {
            return {
                ok: false,
                context: createEmptyConversationFactContext(status, code)
            };
        };

        // 1. Parser feature disabled — the master switch and the parser gate
        //    are both required before any file or process work may start.
        if (!settings.enabled || !settings.parserEnabled) {
            return early('disabled');
        }

        // 2. Mod snapshot tail: legacy/disabled/unsupported/truncated/invalid
        //    all converge here without ever waiting for a file.
        const extra = gameData.saveSnapshotExtraResult;
        if (extra === undefined) {
            return early('unavailable');
        }
        switch (extra.status) {
            case 'legacy':
                return early('unavailable');
            case 'disabled':
                return early('disabled');
            case 'unsupported':
                return early('unsupported', 'SAVE_VERSION_UNSUPPORTED');
            case 'truncated':
                return early('failed', 'SAVE_TRUNCATED');
            case 'invalid':
                return early('failed', 'SAVE_PARSE_FAILED');
            case 'available':
                break;
        }

        const sequence = gameData.saveSnapshotSequence;
        const slot = gameData.saveSnapshotSlot;
        if (
            typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0 ||
            (slot !== 0 && slot !== 1)
        ) {
            return early('unavailable');
        }

        // 3. Numeric game date (the display date is never a substitute).
        const gameDateNumeric = gameData.gameDate?.totalDays;
        if (typeof gameDateNumeric !== 'number' || !Number.isInteger(gameDateNumeric) || gameDateNumeric <= 0) {
            return early('unavailable');
        }

        // Campaign identity via `requireCampaignIdentity`; a legacy or
        // invalid campaign must NOT fall back to a player-only namespace.
        let identity: CampaignPlayerIdentity;
        try {
            identity = this.resolveCampaignIdentity({
                playerID: gameData.playerID,
                timelineSnapshotResult: gameData.timelineSnapshotResult
            });
        } catch (error) {
            if (error instanceof CampaignIdentityUnavailableError) {
                if (error.code === 'legacy-mod') return early('unavailable');
                if (error.code === 'unsupported-schema') return early('unsupported', 'SAVE_VERSION_UNSUPPORTED');
                return early('mismatch', 'SAVE_CAMPAIGN_MISMATCH');
            }
            return early('failed', 'SAVE_PARSE_FAILED');
        }

        // 4. Platform/sidecar availability — checked before any file wait.
        const parserPath = this.resolveParserExecutable();
        if (!parserPath.ok) {
            return parserPath.kind === 'unsupported'
                ? early('unsupported', 'PARSER_NOT_FOUND')
                : early('unavailable', 'PARSER_NOT_FOUND');
        }

        const categories = SAVE_FACT_CATEGORIES.filter(category => settings.categories[category]);
        const expected: ExpectedSnapshotIdentity = {
            playerCharacterId: identity.playerId,
            participantCharacterIds: collectParticipantIds(gameData),
            gameDateNumeric,
            campaignId: identity.campaignId,
            campaignIdParts: [
                identity.campaignParts.a,
                identity.campaignParts.b,
                identity.campaignParts.c,
                identity.campaignParts.d
            ],
            snapshotSequence: sequence,
            snapshotSlot: slot
        };
        return { ok: true, identity, expected, sequence, slot, categories };
    }

    // -----------------------------------------------------------------------
    // Step 3: task key, dedup, preemption, cross-owner serialization
    // -----------------------------------------------------------------------

    private startTask(
        gameData: GameData,
        opts: SaveSnapshotCoordinatorPrepareOptions
    ): Promise<ConversationFactContext> {
        const preflight = this.preflight(gameData, opts.settings);
        if (!preflight.ok) {
            return Promise.resolve(preflight.context);
        }

        if (opts.signal?.aborted) {
            return Promise.resolve(createEmptyConversationFactContext('superseded', 'START_SUPERSEDED'));
        }

        const { identity, expected, sequence, slot } = preflight;
        const ownerKey = `${identity.campaignId}/${identity.playerId}`;
        const key = `${ownerKey}/${sequence}/${slot}`;

        // Same key: reuse the in-flight promise verbatim.
        const existing = this.tasks.get(key);
        if (existing) {
            // A same-key task may already have been cancelled by the first
            // caller's external generation signal.  Never attach the latest
            // conversation start to that doomed promise.
            if (!existing.signal.aborted) {
                return existing.promise;
            }
            this.tasks.delete(key);
        }

        // Same campaign/player, different key: only a strictly higher
        // sequence may preempt; a lower (or equal) sequence is superseded
        // immediately without any file or process work.
        for (const record of [...this.tasks.values()]) {
            if (record.ownerKey !== ownerKey) continue;
            if (record.sequence >= sequence) {
                return Promise.resolve(createEmptyConversationFactContext('superseded', 'START_SUPERSEDED'));
            }
            record.controller.abort();
            this.tasks.delete(record.key);
        }

        const controller = new AbortController();
        const signal = combineAbortSignals(opts.signal, controller.signal);
        const startedAtMs = this.clock.now();

        const record: PrepareTaskRecord = {
            key,
            ownerKey,
            sequence,
            controller,
            signal,
            promise: undefined as unknown as Promise<ConversationFactContext>
        };

        const run = (): Promise<ConversationFactContext> =>
            this.runPreparation(gameData, opts, preflight, signal, startedAtMs)
                .finally(() => {
                    // Completed tasks leave the map; a preempted record was
                    // already deleted by its successor, so only delete when
                    // the map still points at THIS record.
                    if (this.tasks.get(key) === record) {
                        this.tasks.delete(key);
                    }
                });

        // Different campaign/player: serialize through the single-process
        // queue. A same-owner predecessor was just aborted above, so it
        // settles promptly and the newer task does not wait on real IO.
        const promise = this.queueTail.then(run, run);
        this.queueTail = promise.then(
            () => undefined,
            () => undefined
        );
        record.promise = promise;
        this.tasks.set(key, record);
        return promise;
    }

    private getOrCreateStore(
        appUserDataDir: string,
        identity: CampaignPlayerIdentity
    ): SaveFactStoreLike {
        const scopeKey = JSON.stringify([
            path.resolve(appUserDataDir),
            identity.campaignId,
            identity.playerId
        ]);
        const existing = this.stores.get(scopeKey);
        if (existing !== undefined) return existing;
        const created = this.createStore(appUserDataDir, identity);
        this.stores.set(scopeKey, created);
        return created;
    }

    // -----------------------------------------------------------------------
    // Steps 4-6: wait -> presence -> cache/extract -> persist -> context
    // -----------------------------------------------------------------------

    private async runPreparation(
        gameData: GameData,
        opts: SaveSnapshotCoordinatorPrepareOptions,
        preflight: Extract<PreflightResult, { ok: true }>,
        signal: AbortSignal,
        startedAtMs: number
    ): Promise<ConversationFactContext> {
        try {
            const { settings } = opts;
            const { identity, expected, categories } = preflight;
            const warningCodes: string[] = [];
            const addWarning = (code: string): void => {
                if (warningCodes.length < MAX_WARNING_CODES && !warningCodes.includes(code)) {
                    warningCodes.push(code);
                }
            };
            /** Remaining slice of the total prepare deadline (step 5). */
            const remainingMs = (): number =>
                Math.max(0, Math.floor(settings.prepareDeadlineMs - (this.clock.now() - startedAtMs)));

            if (signal.aborted) {
                return createEmptyConversationFactContext('superseded', 'START_SUPERSEDED');
            }

            // -- 1. Wait for a stable, identity-matched snapshot. The waiter
            //       owns stability sampling, the probe run and the first
            //       identity validation, including old-sequence repoll.
            const waitStartedAtMs = this.clock.now();
            const waitResult = await this.waiter.wait({
                userFolderPath: this.getUserFolderPath(),
                snapshotSlot: expected.snapshotSlot as 0 | 1,
                expected,
                deadlineMs: remainingMs(),
                signal
            });
            const waitDurationMs = elapsedDuration(this.clock.now(), waitStartedAtMs);
            if (waitResult.status !== 'matched') {
                return mapWaitFailure(waitResult);
            }

            const probeResponse = waitResult.response;
            collectSidecarWarnings(probeResponse, addWarning);

            // -- 2. Suspicious participant state (plan Task 11 step 6).
            const presence = assessParticipantPresence(probeResponse, {
                playerCharacterId: expected.playerCharacterId
            });
            if (presence.status === 'reject') {
                return createEmptyConversationFactContext('mismatch', presence.code);
            }
            if (presence.status === 'warning') {
                addWarning(presence.warningCode);
            }

            // P5b deferred (verify/session/delta/agency): 1.x planned an
            // immutable `SaveFactVerificationSnapshotRef` here whenever
            // `settings.agencyVerifyEnabled || settings.characterQueryEnabled`
            // (both flags trimmed from 2CE settings) so Agency verification and
            // Phase 3 character queries could reuse the probe-accepted save.
            // With verification deferred, no snapshot ref is planned or
            // attached to the context.

            const timelineContext = this.getTimelineContext?.(gameData, identity);
            const checkpoint: SaveFactCheckpointProvenance = {
                timelineNodeId: timelineContext?.currentNodeId,
                checkpointEpoch: timelineContext?.checkpointEpoch ?? gameData.votcCheckpointEpoch
            };
            const requestKey = buildCacheRequestKey(probeResponse.manifest, expected, categories);
            const store = this.getOrCreateStore(opts.appUserDataDir, identity);
            // P5b deferred (verify/session/delta/agency): the 1.x coordinator
            // built a `deltaScopeDigest`, created a `SaveFactDeltaStore` and
            // defined a `persistDelta` closure here to fold fresh/cached facts
            // into the business-delta baseline. Removed with the delta trim;
            // the cache request key and store scope are unchanged.

            // Capture the timeline-filtered name cache once. Resolution below
            // is pure with respect to this snapshot, so a large fact set can
            // never multiply synchronous cache reads.
            let nameSnapshot: SaveFactNameResolverSnapshot | undefined;
            if (store.loadEntityNameSnapshot !== undefined) {
                try {
                    const loaded = store.loadEntityNameSnapshot(timelineContext);
                    nameSnapshot = loaded as SaveFactEntityNameSnapshot;
                } catch (error) {
                    addWarning(SAVE_SNAPSHOT_WARNING_NAME_CACHE_READ_FAILED);
                    this.logger?.warn(`[SaveSnapshotCoordinator] name cache lookup failed: ${describeError(error)}`);
                }
            }

            // -- 3. Verified cache lookup: a hit skips the heavier extract
            //       entirely (plan section 4: extract only runs after a probe
            //       match AND a cache miss).
            let cached: PersistedSaveFactSnapshotV1 | undefined;
            const cacheLookupStartedAtMs = this.clock.now();
            try {
                cached = store.findCachedSnapshot(requestKey, timelineContext);
            } catch (error) {
                // A broken cache read degrades to a miss; it must never deny
                // facts that a fresh extract can still provide safely.
                this.logger?.warn(`[SaveSnapshotCoordinator] cache lookup failed: ${describeError(error)}`);
                cached = undefined;
            }
            const cacheLookupDurationMs = elapsedDuration(this.clock.now(), cacheLookupStartedAtMs);
            // -- Task 14 pipeline (authority -> registry visibility -> bounded
            //       index), run uniformly over cached and freshly extracted
            //       facts. Authority reads the LIVE GameData, so it always
            //       re-runs per preparation even on a cache hit; the cache
            //       stores the raw schema-validated extract instead.
            const deriveFacts = (
                manifest: SaveSnapshotManifest,
                entities: CanonicalEntityV1[],
                facts: readonly ExtractedGameFactV1[]
            ): { facts: GameFact[]; index: SaveFactIndex; updates: EntityNameUpdate[] } => {
                const gatedFacts = facts.filter((fact) => settings.directRealmEnabled
                    || (fact.predicate !== 'character.direct_vassal_of'
                        && fact.predicate !== 'character.realm_capital'));
                // P5b deferred (verify/session/delta/agency): 1.x wrapped this
                // in `attachLocalizations(...)` from the (unported)
                // ck3Localization module; that helper only spread
                // `localizations` into the resolver context, so inline it.
                const baseNameContext = {
                    gameData,
                    entities,
                    nameSnapshot,
                    timelineContext
                };
                const nameContext: SaveFactNameResolverContext = opts.localizations === undefined
                    ? baseNameContext
                    : { ...baseNameContext, localizations: opts.localizations };
                const authority = applySaveFactAuthority(gatedFacts, {
                    gameData,
                    resolveName: (ref) => {
                        const resolution = resolveEntityDisplayName(ref, nameContext);
                        return resolution.resolved ? resolution.displayName : undefined;
                    }
                });
                for (const warning of authority.warnings) addWarning(warning.code);
                const visibility = applySaveFactVisibilityPolicy(authority.facts);
                for (const warning of visibility.warnings) addWarning(warning.code);
                const materialized = materializeResolvedFactNames(visibility.facts, nameContext);
                const built = buildSaveFactIndex({
                    facts: materialized.facts,
                    entities,
                    manifest,
                    participantCharacterIds: expected.participantCharacterIds
                });
                for (const warning of built.warnings) addWarning(warning.code);
                return { facts: materialized.facts, index: built.index, updates: materialized.updates };
            };

            const scheduleNameUpdates = (updates: EntityNameUpdate[]): boolean => {
                if (updates.length === 0 || store.scheduleEntityNameUpdate === undefined) return false;
                const deadline = this.clock.now() + remainingMs();
                if (remainingMs() <= 0) {
                    addWarning(SAVE_SNAPSHOT_WARNING_NAME_CACHE_WRITE_SKIPPED);
                    return false;
                }
                try {
                    const scheduled = store.scheduleEntityNameUpdate(updates, checkpoint, deadline);
                    if (!scheduled) {
                        addWarning(SAVE_SNAPSHOT_WARNING_NAME_CACHE_WRITE_SKIPPED);
                    }
                    return scheduled;
                } catch (error) {
                    addWarning(SAVE_SNAPSHOT_WARNING_NAME_CACHE_WRITE_FAILED);
                    this.logger?.warn(`[SaveSnapshotCoordinator] name cache write scheduling failed: ${describeError(error)}`);
                    return false;
                }
            };

            if (cached !== undefined) {
                if (signal.aborted) {
                    return createEmptyConversationFactContext('superseded', 'START_SUPERSEDED');
                }
                const derived = deriveFacts(cached.manifest, cached.entities, cached.facts);
                const nameCacheWriteScheduled = scheduleNameUpdates(derived.updates);
                // Legacy cache rows do not carry extractionStatus. Treat them
                // as incomplete so they can never masquerade as a clean hit.
                if (cached.extractionStatus === 'partial') addWarning(SAVE_SNAPSHOT_WARNING_EXTRACT_PARTIAL);
                return buildAvailableContext(
                    cached.manifest,
                    derived.facts,
                    derived.index,
                    checkpoint,
                    warningCodes,
                    buildPreparationTelemetry({
                        startedAtMs,
                        waitDurationMs,
                        probeDurationMs: safeMetricDuration(probeResponse.metrics.durationMs),
                        extractDurationMs: 0,
                        cacheLookupDurationMs,
                        cacheHit: true,
                        currentCacheWriteScheduled: false,
                        nameCacheWriteScheduled,
                        nowMs: this.clock.now()
                    }),
                    cached.joinCandidates
                );
            }

            if (signal.aborted) {
                return createEmptyConversationFactContext('superseded', 'START_SUPERSEDED');
            }

            // -- 4. Extract (cache miss only). The run gets the smaller of
            //       the parser timeout and the remaining total budget.
            const extractRequest: SaveFactExtractionRequestV1 = {
                protocolVersion: 2,
                operation: 'extract',
                expected,
                categories,
                limits: SAVE_SNAPSHOT_EXTRACT_REQUEST_LIMITS
            };
            let outcome: SaveParserRunOutcome;
            const extractStartedAtMs = this.clock.now();
            try {
                const handle = this.parserClient.start({
                    request: extractRequest,
                    inputPath: waitResult.filePath,
                    allowedRootPath: path.dirname(waitResult.filePath),
                    timeoutMs: Math.max(1, Math.min(settings.parserTimeoutMs, remainingMs())),
                    signal
                });
                outcome = await handle.promise;
            } catch (error) {
                this.logger?.warn(`[SaveSnapshotCoordinator] extract start failed: ${describeError(error)}`);
                return createEmptyConversationFactContext('failed', 'SAVE_PARSE_FAILED');
            }
            const extractDurationMs = elapsedDuration(this.clock.now(), extractStartedAtMs);
            if (!outcome.ok) {
                return mapParserFailure(outcome);
            }

            const extractResult = outcome.result;
            collectSidecarWarnings(extractResult, addWarning);

            if (extractResult.status === 'unsupported') {
                return createEmptyConversationFactContext(
                    'unsupported',
                    extractResult.error?.code ?? 'SAVE_VERSION_UNSUPPORTED'
                );
            }
            if (extractResult.status === 'invalid') {
                return createEmptyConversationFactContext(
                    'failed',
                    extractResult.error?.code ?? 'PARSER_OUTPUT_INVALID'
                );
            }

            // G12/P0-D: probe and extract must describe the same content. The
            // waiter fingerprint is not merely a polling hint once facts are
            // about to be cached/projected; an identity-equivalent replacement
            // between the two sidecar runs must fail closed before any fact is
            // derived or persisted.
            if (extractResult.manifest.sourceFingerprint !== probeResponse.manifest.sourceFingerprint) {
                this.logger?.warn('[SaveSnapshotCoordinator] probe/extract fingerprint mismatch');
                return createEmptyConversationFactContext('mismatch', 'SAVE_IDENTITY_MISMATCH');
            }

            // -- 5. Second identity validation on the extract response. A
            //       `partial` result keeps its identity block; the fixed
            //       validator requires status `ok`, so the partial envelope is
            //       normalized for the check and flagged as a warning.
            const partial = extractResult.status === 'partial';
            const identityChecked: SaveFactExtractionResultV1 = partial
                ? { ...extractResult, status: 'ok', error: undefined }
                : extractResult;
            const verdict = validateSnapshotIdentity(identityChecked, expected, 'extract');
            if (!verdict.ok) {
                return createEmptyConversationFactContext('mismatch', verdict.code);
            }
            if (partial) {
                addWarning(SAVE_SNAPSHOT_WARNING_EXTRACT_PARTIAL);
            }

            // P0-D final revalidation: probe once more after extraction and
            // before deriving/persisting facts. This closes the window where
            // CK3 replaces the fixed-name save after extract completed. P1-A
            // verify still requires the stronger one-handle/bounded-snapshot
            // binding for checks and is not implied by this v1 safeguard.
            if (remainingMs() <= 0) {
                return createEmptyConversationFactContext('timeout', 'PARSER_TIMEOUT');
            }
            const finalProbeRequest: SaveFactExtractionRequestV1 = {
                protocolVersion: 2,
                operation: 'probe',
                expected,
                categories: ['identity'],
                limits: PROBE_REQUEST_LIMITS
            };
            const finalProbeStartedAtMs = this.clock.now();
            let finalProbeOutcome: SaveParserRunOutcome;
            try {
                const handle = this.parserClient.start({
                    request: finalProbeRequest,
                    inputPath: waitResult.filePath,
                    allowedRootPath: path.dirname(waitResult.filePath),
                    timeoutMs: Math.max(1, Math.min(settings.parserTimeoutMs, remainingMs())),
                    signal
                });
                finalProbeOutcome = await handle.promise;
            } catch (error) {
                this.logger?.warn(`[SaveSnapshotCoordinator] final probe start failed: ${describeError(error)}`);
                return createEmptyConversationFactContext('failed', 'SAVE_PARSE_FAILED');
            }
            const finalProbeDurationMs = elapsedDuration(this.clock.now(), finalProbeStartedAtMs);
            if (!finalProbeOutcome.ok) return mapParserFailure(finalProbeOutcome);
            const finalProbeResult = finalProbeOutcome.result;
            const finalVerdict = validateSnapshotIdentity(finalProbeResult, expected, 'probe');
            if (!finalVerdict.ok
                || finalProbeResult.manifest.sourceFingerprint !== probeResponse.manifest.sourceFingerprint
                || finalProbeResult.manifest.sourceFingerprint !== extractResult.manifest.sourceFingerprint) {
                this.logger?.warn('[SaveSnapshotCoordinator] final probe fingerprint/identity mismatch');
                return createEmptyConversationFactContext(
                    'mismatch',
                    finalVerdict.ok ? 'SAVE_IDENTITY_MISMATCH' : finalVerdict.code
                );
            }

            const extractPresence = assessParticipantPresence(extractResult, {
                playerCharacterId: expected.playerCharacterId
            });
            if (extractPresence.status === 'reject') {
                return createEmptyConversationFactContext('mismatch', extractPresence.code);
            }
            if (extractPresence.status === 'warning') {
                addWarning(extractPresence.warningCode);
            }
            if (signal.aborted) {
                return createEmptyConversationFactContext('superseded', 'START_SUPERSEDED');
            }

            // -- 6. Task 14 pipeline over the fresh extract (the cache stores
            //       the raw schema-validated facts; authority/visibility/index
            //       run per preparation because authority reads live GameData).
            const derived = deriveFacts(probeResponse.manifest, extractResult.entities, extractResult.facts);

            // -- 7. Best-effort atomic cache write (step 5): failure or a
            //       spent budget degrades to in-memory-only + warning; the
            //       verified facts are never dropped over a persistence
            //       problem.
            const verifiedIdentity = buildVerifiedIdentity(expected, extractResult);
            const snapshotInput: SaveFactSnapshotInput = {
                requestKey,
                manifest: probeResponse.manifest,
                verifiedIdentity,
                entities: extractResult.entities,
                facts: extractResult.facts,
                extractionStatus: partial ? 'partial' : 'ok',
                checkpoint,
                joinCandidates: extractResult.joinCandidates
            };
            let currentCacheWriteScheduled = false;
            if (remainingMs() <= 0) {
                addWarning(SAVE_SNAPSHOT_WARNING_CACHE_WRITE_SKIPPED);
                this.logger?.warn('[SaveSnapshotCoordinator] cache write skipped: prepare deadline exhausted');
            } else {
                try {
                    if (store.scheduleCurrent !== undefined) {
                        currentCacheWriteScheduled = store.scheduleCurrent(
                            snapshotInput,
                            { diagnosticsEnabled: settings.diagnosticsEnabled },
                            this.clock.now() + remainingMs()
                        );
                        if (!currentCacheWriteScheduled) {
                            addWarning(SAVE_SNAPSHOT_WARNING_CACHE_WRITE_SKIPPED);
                            this.logger?.warn('[SaveSnapshotCoordinator] cache write queue rejected the task');
                        }
                    } else {
                        // Compatibility seam for older injected stores. The
                        // production SaveFactStore always implements the
                        // non-blocking scheduler above.
                        store.saveCurrent(snapshotInput, { diagnosticsEnabled: settings.diagnosticsEnabled });
                        currentCacheWriteScheduled = true;
                    }
                } catch (error) {
                    addWarning(SAVE_SNAPSHOT_WARNING_CACHE_WRITE_FAILED);
                    this.logger?.warn(`[SaveSnapshotCoordinator] cache write failed: ${describeError(error)}`);
                }
            }

            const nameCacheWriteScheduled = scheduleNameUpdates(derived.updates);

            // -- 8. Immutable context (step 6).
            return buildAvailableContext(
                probeResponse.manifest,
                derived.facts,
                derived.index,
                checkpoint,
                warningCodes,
                buildPreparationTelemetry({
                    startedAtMs,
                    waitDurationMs,
                    probeDurationMs: safeMetricDuration(probeResponse.metrics.durationMs) + finalProbeDurationMs,
                    extractDurationMs,
                    cacheLookupDurationMs,
                    cacheHit: false,
                    currentCacheWriteScheduled,
                    nameCacheWriteScheduled,
                    nowMs: this.clock.now()
                }),
                extractResult.joinCandidates
            );
        } catch (error) {
            // Fail-open guard (step 7): ordinary errors never reject.
            this.logger?.warn(`[SaveSnapshotCoordinator] preparation failed open: ${describeError(error)}`);
            return createEmptyConversationFactContext('failed', 'SAVE_PARSE_FAILED');
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Conversation participants as decimal character IDs: the player, the AI
 * partner and every character carried by the GameData init/character lines.
 * Deduped and numerically sorted so the cache request hash is stable.
 */
function collectParticipantIds(gameData: GameData): string[] {
    const ids = new Set<number>();
    const add = (value: unknown): void => {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
            ids.add(value);
        }
    };
    add(gameData.playerID);
    add(gameData.aiID);
    for (const id of gameData.characters?.keys() ?? []) {
        add(id);
    }
    return [...ids].sort((a, b) => a - b).map(id => String(id));
}

function buildCacheRequestKey(
    manifest: SaveSnapshotManifest,
    expected: ExpectedSnapshotIdentity,
    categories: SaveFactCategory[]
): SaveFactCacheRequestKey {
    return {
        sourceFingerprint: manifest.sourceFingerprint,
        parserVersion: manifest.parserVersion,
        factSchemaVersion: 1,
        participantCharacterIds: [...expected.participantCharacterIds],
        categories: [...categories],
        limits: SAVE_SNAPSHOT_EXTRACT_REQUEST_LIMITS,
        campaignId: expected.campaignId,
        playerCharacterId: expected.playerCharacterId,
        gameDateNumeric: expected.gameDateNumeric,
        snapshotSequence: expected.snapshotSequence,
        snapshotSlot: expected.snapshotSlot as 0 | 1
    };
}

function buildVerifiedIdentity(
    expected: ExpectedSnapshotIdentity,
    extractResult: SaveFactExtractionResultV1
): VerifiedSaveIdentity {
    return {
        playerCharacterId: expected.playerCharacterId,
        gameDateNumeric: expected.gameDateNumeric,
        gameDateDisplay: extractResult.identity?.gameDateDisplay,
        campaignIdParts: [...expected.campaignIdParts] as [number, number, number, number],
        snapshotSequence: expected.snapshotSequence,
        snapshotSlot: expected.snapshotSlot as 0 | 1,
        scriptVariableScale: extractResult.identity?.scriptVariableScale
    };
}

/** Map a non-matched waiter result to the degraded context (step 7). */
function mapWaitFailure(
    result: Exclude<SaveSnapshotWaitResult, { status: 'matched' }>
): ConversationFactContext {
    switch (result.status) {
        case 'timeout':
            return createEmptyConversationFactContext('timeout');
        case 'not_found':
            return createEmptyConversationFactContext('unavailable', 'SAVE_NOT_FOUND');
        case 'mismatch':
            return createEmptyConversationFactContext('mismatch', result.code);
        case 'superseded':
            return createEmptyConversationFactContext('superseded', 'START_SUPERSEDED');
        case 'failed':
            if (result.code === 'PARSER_TIMEOUT') {
                return createEmptyConversationFactContext('timeout', result.code);
            }
            if (result.code === 'PARSER_PROTOCOL_UNSUPPORTED') {
                return createEmptyConversationFactContext('unsupported', result.code);
            }
            return createEmptyConversationFactContext('failed', result.code);
    }
}

/** Map a failed parser (extract) outcome to the degraded context (step 7). */
function mapParserFailure(outcome: Extract<SaveParserRunOutcome, { ok: false }>): ConversationFactContext {
    switch (outcome.code) {
        case 'START_SUPERSEDED':
            return createEmptyConversationFactContext('superseded', outcome.code);
        case 'PARSER_TIMEOUT':
            return createEmptyConversationFactContext('timeout', outcome.code);
        case 'PARSER_NOT_FOUND':
            return createEmptyConversationFactContext('unavailable', outcome.code);
        case 'PARSER_PROTOCOL_UNSUPPORTED':
            return createEmptyConversationFactContext('unsupported', outcome.code);
        default:
            return createEmptyConversationFactContext('failed', outcome.code);
    }
}

function collectSidecarWarnings(
    response: SaveFactExtractionResultV1,
    addWarning: (code: string) => void
): void {
    for (const warning of response.warnings) {
        if (typeof warning.code === 'string' && warning.code !== '') {
            addWarning(warning.code);
        }
    }
}

function safeMetricDuration(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) && value >= 0
        ? Math.min(Math.floor(value), 24 * 60 * 60 * 1000)
        : 0;
}

function elapsedDuration(nowMs: number, startedAtMs: number): number {
    return safeMetricDuration(nowMs - startedAtMs);
}

function buildPreparationTelemetry(input: {
    startedAtMs: number;
    waitDurationMs: number;
    probeDurationMs: number;
    extractDurationMs: number;
    cacheLookupDurationMs: number;
    cacheHit: boolean;
    currentCacheWriteScheduled: boolean;
    nameCacheWriteScheduled: boolean;
    nowMs: number;
}): SaveFactPreparationTelemetry {
    return {
        totalDurationMs: elapsedDuration(input.nowMs, input.startedAtMs),
        waitDurationMs: safeMetricDuration(input.waitDurationMs),
        probeDurationMs: safeMetricDuration(input.probeDurationMs),
        extractDurationMs: safeMetricDuration(input.extractDurationMs),
        cacheLookupDurationMs: safeMetricDuration(input.cacheLookupDurationMs),
        cacheHit: input.cacheHit,
        currentCacheWriteScheduled: input.currentCacheWriteScheduled,
        nameCacheWriteScheduled: input.nameCacheWriteScheduled
        // P5b deferred (verify/session/delta/agency): the 1.x telemetry also
        // carried deltaStatus/deltaAddedCount/deltaRemovedCount/
        // deltaChangedCount/deltaWarningCount from the delta observe result;
        // removed with the delta trim.
    };
}

/**
 * Build the frozen success context (step 6). The manifest and the baseline
 * facts are REBUILT from validated DTO fields and deeply frozen — the raw
 * sidecar response object never escapes this module. `facts` are the
 * post-authority/post-visibility facts and `index` the bounded Task 14 index
 * built from them (the index is immutable by construction; it is shared, not
 * copied).
 */
function buildAvailableContext(
    manifest: SaveSnapshotManifest,
    facts: readonly GameFact[],
    factIndex: SaveFactIndex,
    checkpoint: SaveFactCheckpointProvenance,
    warningCodes: readonly string[],
    preparationTelemetry: SaveFactPreparationTelemetry,
    joinCandidates?: readonly string[]
): ConversationFactContext {
    const frozenManifest = deepFreeze<SaveSnapshotManifest>({
        snapshotId: manifest.snapshotId,
        sourceFingerprint: manifest.sourceFingerprint,
        sourceFormat: manifest.sourceFormat,
        ck3Version: manifest.ck3Version,
        saveGameVersion: manifest.saveGameVersion,
        parserVersion: manifest.parserVersion,
        factSchemaVersion: 1
    });

    // The app fills the timeline provenance the sidecar cannot know; every
    // fact is rebuilt field-by-field so no sidecar-owned object is shared.
    const baselineFacts: GameFact[] = facts.map(fact => deepFreeze<GameFact>({
        id: fact.id,
        category: fact.category,
        subject: { ...fact.subject },
        predicate: fact.predicate,
        object: fact.object !== undefined ? { ...fact.object } : undefined,
        value: fact.value,
        asOfGameDate: { ...fact.asOfGameDate },
        source: fact.source,
        sourcePath: fact.sourcePath,
        confidence: fact.confidence,
        visibility: fact.visibility,
        knownByCharacterIds: fact.knownByCharacterIds !== undefined
            ? [...fact.knownByCharacterIds]
            : undefined,
        priority: fact.priority,
        sensitivity: fact.sensitivity,
        provenance: {
            snapshotId: fact.provenance.snapshotId,
            campaignId: fact.provenance.campaignId,
            timelineNodeId: checkpoint.timelineNodeId,
            checkpointEpoch: checkpoint.checkpointEpoch
        }
    }));

    return Object.freeze({
        snapshotStatus: 'available',
        snapshot: frozenManifest,
        // P5b deferred (verify/session/delta/agency): 1.x also attached the
        // planned `verificationSnapshot` here; removed with the verify trim.
        ...(joinCandidates === undefined
            ? {}
            : { joinCandidates: Object.freeze([...joinCandidates]) }),
        baselineFacts: Object.freeze(baselineFacts),
        factIndex,
        diagnostics: Object.freeze({
            warningCodes: Object.freeze([...warningCodes]),
            preparationTelemetry: Object.freeze({ ...preparationTelemetry })
        })
    });
}
