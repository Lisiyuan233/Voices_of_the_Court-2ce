/**
 * Save snapshot file waiter (implementation plan Task 11 steps 1-4).
 *
 * Waits for the CK3 mod's snapshot save to appear, stabilize and prove its
 * identity, then hands the verified file to the caller.
 *
 * State machine (per `wait` call, fully isolated):
 *
 *   resolve -> poll -> stable -> probe -> matched
 *                  ^      |        |
 *                  |      |        +-- identity ok .......... matched (done)
 *                  |      |        +-- old seq/campaign/date . record
 *                  |      |           fingerprint, repoll (back to poll)
 *                  |      |        +-- player/slot/envelope .. mismatch (done)
 *                  |      |        +-- parser failure ........ failed (done)
 *                  |      +-- fingerprint unstable/missing/sharing-violation
 *                  |          -> reset streak, stay in poll
 *                  +-- deadline: mismatch (recorded identity) / not_found
 *                     (file never seen) / timeout (seen but never matched)
 *                  +-- AbortSignal: superseded (done, in-flight probe killed)
 *
 * Step 1 (single target path): the target is ALWAYS
 * `<userFolderPath>/save games/<protocol constant file name>` — slot 0 uses
 * `SAVE_SNAPSHOT_FIXED_FILE_NAME`, slot 1 the slot-suffixed name from
 * `saveSnapshotProtocol`. Character names, player names or renderer text are
 * NEVER accepted as path components. The save-games root is resolved with
 * `realpath` once at start; before the baseline fingerprint and before every
 * probe the target's realpath must stay inside that real root (symlink
 * escape -> failed).
 *
 * Step 2 (old fingerprint): the current target's exists/size/mtime plus a
 * bounded head-content fingerprint are captured when the wait starts. A
 * pre-existing old file is not an error; the poll loop simply probes it,
 * records the old identity and keeps waiting.
 *
 * Step 3 (stability sampling): every `pollIntervalMs` the target is sampled.
 * A fingerprint is `size:mtimeMs:sha(head bytes)`-style — the bounded head
 * read makes "same size+mtime but different content" (coarse mtime
 * granularity) detectable. Three consecutive identical fingerprints mark the
 * file stable. Missing file, create->rename gaps and read sharing
 * violations (EACCES/EBUSY/EPERM) reset the streak and are retried; a size
 * that pauses then grows also resets the streak naturally.
 *
 * Step 4 (old sequence keeps waiting): a stable candidate whose probe only
 * shows an old sequence/campaign/date is NOT an immediate mismatch. Its
 * fingerprint is added to the probed set (the same fingerprint is never
 * probed twice) and polling resumes. Only when the overall deadline arrives
 * is the recorded mismatch (or not_found/timeout) returned. Player/slot and
 * envelope mismatches are terminal immediately: the file is a valid answer
 * for a DIFFERENT conversation, so waiting cannot fix it.
 *
 * The total deadline is passed in from the caller (remaining preparation
 * budget); the waiter adds no timeout of its own. Per-probe timeouts are
 * capped by the remaining budget. This module never throws and never
 * rejects: every outcome is a typed `SaveSnapshotWaitResult`.
 */

import * as path from 'path';
import {
    SAVE_SNAPSHOT_FIXED_FILE_NAME,
    SAVE_SNAPSHOT_SLOT_FILE_NAMES
} from '../../shared/gameData/saveSnapshotProtocol';
import { SAVE_FACT_DEFAULTS } from './saveFactSettings';
import type {
    SaveFactErrorCode,
    SaveFactExtractionRequestV1,
    SaveFactExtractionResultV1
} from './saveFactTypes';
import type { SaveParserRunHandle, SaveParserRunOptions } from './SaveParserClient';
import {
    validateSnapshotIdentity,
    type ExpectedSnapshotIdentity,
    type SaveIdentityMismatchCode
} from './SaveIdentityValidator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consecutive identical samples required before a file counts as stable. */
export const SAVE_SNAPSHOT_STABLE_POLLS_REQUIRED = 3;
/** Bounded head read for the quick content fingerprint. */
export const SAVE_SNAPSHOT_QUICK_FINGERPRINT_BYTES = 4096;
/** Fixed directory name under the CK3 user folder. */
export const SAVE_SNAPSHOT_SAVE_GAMES_DIR_NAME = 'save games';

/**
 * Probe requests extract nothing; the limits exist only because the request
 * DTO requires them. The output cap stays small because a probe response
 * carries identity, manifest, warnings and metrics only.
 */
export const PROBE_REQUEST_LIMITS: SaveFactExtractionRequestV1['limits'] = {
    maxFacts: 0,
    maxEntities: 0,
    maxRelatedCharacters: 0,
    maxOutputBytes: 64 * 1024,
    maxDecompressedBytes: 64 * 1024 * 1024,
    maxNestingDepth: 8,
    maxScalarBytes: 1024
};

/**
 * Identity mismatches that mean "this is an OLD snapshot of the same
 * conversation" — record the fingerprint and keep waiting. Player/slot and
 * envelope mismatches are terminal (see module docstring).
 */
const REPOLL_MISMATCH_CODES: ReadonlySet<SaveIdentityMismatchCode> = new Set([
    'SAVE_SEQUENCE_MISMATCH',
    'SAVE_CAMPAIGN_MISMATCH',
    'SAVE_DATE_MISMATCH'
]);

/** Transient filesystem error codes (read sharing violation and friends). */
const TRANSIENT_FS_ERROR_CODES: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM']);
const MISSING_FS_ERROR_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

// ---------------------------------------------------------------------------
// Injectable surfaces
// ---------------------------------------------------------------------------

export interface SaveSnapshotStatLike {
    size: number;
    mtimeMs: number;
}

/**
 * Minimal synchronous fs surface. All methods throw NodeJS-style errors
 * (with a `code` property); the waiter maps them to retry/fail decisions.
 */
export interface SaveSnapshotFsLike {
    statSync(target: string): SaveSnapshotStatLike;
    realpathSync(target: string): string;
    /** Read at most `maxBytes` from the start of the file. */
    readHeadSync(target: string, maxBytes: number): Buffer;
}

/** Minimal parser client surface; `SaveParserClient` satisfies it. */
export interface SaveSnapshotParserClientLike {
    start(options: SaveParserRunOptions): SaveParserRunHandle;
}

/** Minimal timer surface; defaults to the global timers plus `Date.now`. */
export interface SaveSnapshotTimerLike {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
}

/** Minimal logger surface; codes only, never file content. */
export interface SaveSnapshotWaiterLoggerLike {
    warn(message: string): void;
}

const realFs: SaveSnapshotFsLike = {
    statSync: (target) => {
        // Lazy require keeps the module importable in tests that never touch
        // the real filesystem.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const stat = (require('fs') as typeof import('fs')).statSync(target);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    realpathSync: (target) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return (require('fs') as typeof import('fs')).realpathSync(target);
    },
    readHeadSync: (target, maxBytes) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');
        const fd = fs.openSync(target, 'r');
        try {
            const buffer = Buffer.alloc(maxBytes);
            const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
            return buffer.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    }
};

const realTimer: SaveSnapshotTimerLike = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    now: () => Date.now()
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SaveSnapshotWaiterSettings {
    /** File-stability poll interval. */
    pollIntervalMs: number;
}

export interface SaveSnapshotWaiterDeps {
    /** Parser client used for identity probes. Required. */
    client: SaveSnapshotParserClientLike;
    /** Injectable fs; defaults to the real `fs` module. */
    fs?: SaveSnapshotFsLike;
    /** Injectable timer; defaults to the global timers. */
    timer?: SaveSnapshotTimerLike;
    /** Logger; receives codes only, never file content. */
    logger?: SaveSnapshotWaiterLoggerLike;
    /** Settings; unspecified fields fall back to the defaults. */
    settings?: Partial<SaveSnapshotWaiterSettings>;
}

export interface SaveSnapshotWaitOptions {
    /** CK3 user folder (`config.userFolderPath`). */
    userFolderPath: string;
    /** Snapshot slot from the save snapshot protocol tail. First release: 0. */
    snapshotSlot: 0 | 1;
    /** Expected identity captured at operation start. */
    expected: ExpectedSnapshotIdentity;
    /**
     * Total remaining preparation budget in ms. The waiter adds no timeout
     * of its own; this deadline is the only one.
     */
    deadlineMs: number;
    /** External cancellation (a newer snapshot sequence supersedes this wait). */
    signal?: AbortSignal;
}

export type SaveSnapshotWaitResult =
    | { status: 'matched'; filePath: string; response: SaveFactExtractionResultV1 }
    | { status: 'timeout'; detail: string }
    | { status: 'mismatch'; code: SaveIdentityMismatchCode; detail: string; filePath: string }
    | { status: 'not_found'; detail: string }
    | { status: 'superseded'; detail: string }
    | { status: 'failed'; code: SaveFactErrorCode; detail: string };

// ---------------------------------------------------------------------------
// Internal sampling
// ---------------------------------------------------------------------------

type SampleResult =
    | { kind: 'ok'; fingerprint: string }
    | { kind: 'missing' }
    | { kind: 'transient' }
    | { kind: 'error'; detail: string };

function errorCode(error: unknown): string | undefined {
    return (error as { code?: unknown } | null | undefined)?.code as string | undefined;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SaveSnapshotWaiter {
    private readonly client: SaveSnapshotParserClientLike;
    private readonly fs: SaveSnapshotFsLike;
    private readonly timer: SaveSnapshotTimerLike;
    private readonly logger?: SaveSnapshotWaiterLoggerLike;
    private readonly settings: SaveSnapshotWaiterSettings;

    constructor(deps: SaveSnapshotWaiterDeps) {
        this.client = deps.client;
        this.fs = deps.fs ?? realFs;
        this.timer = deps.timer ?? realTimer;
        this.logger = deps.logger;
        this.settings = {
            pollIntervalMs: deps.settings?.pollIntervalMs ?? SAVE_FACT_DEFAULTS.pollIntervalMs
        };
    }

    /**
     * Wait for the snapshot file. Always resolves with a typed result;
     * never rejects, never throws.
     */
    wait(options: SaveSnapshotWaitOptions): Promise<SaveSnapshotWaitResult> {
        let resolvePromise!: (result: SaveSnapshotWaitResult) => void;
        const promise = new Promise<SaveSnapshotWaitResult>((resolve) => {
            resolvePromise = resolve;
        });
        let settled = false;
        const cleanupTasks: Array<() => void> = [];
        const settle = (result: SaveSnapshotWaitResult): void => {
            if (settled) return;
            settled = true;
            for (const task of cleanupTasks.splice(0)) {
                try {
                    task();
                } catch {
                    // Cleanup is best-effort and must never throw into settle.
                }
            }
            resolvePromise(result);
        };

        // -- Step 1: resolve the single target path --------------------------
        // The file name ALWAYS comes from the protocol constants; no
        // character/player/renderer text ever reaches the path.
        const fileName = options.snapshotSlot === 0
            ? SAVE_SNAPSHOT_FIXED_FILE_NAME
            : SAVE_SNAPSHOT_SLOT_FILE_NAMES[options.snapshotSlot];
        const saveRoot = path.join(options.userFolderPath, SAVE_SNAPSHOT_SAVE_GAMES_DIR_NAME);
        const targetPath = path.join(saveRoot, fileName);

        let realRoot: string;
        try {
            realRoot = this.fs.realpathSync(saveRoot);
        } catch (error) {
            settle({
                status: 'failed',
                code: 'SAVE_NOT_FOUND',
                detail: `save games root cannot be resolved: ${describeError(error)}`
            });
            return promise;
        }

        /**
         * Containment re-check: the target's realpath must stay inside the
         * real save-games root. A missing target is trivially contained (the
         * check re-runs before every probe); a symlink escaping the root is
         * a hard failure.
         */
        const isContained = (): boolean => {
            let realTarget: string;
            try {
                realTarget = this.fs.realpathSync(targetPath);
            } catch {
                return true;
            }
            return realTarget.startsWith(realRoot + path.sep);
        };

        // -- Wait state --------------------------------------------------------

        const startedAt = this.timer.now();
        const deadlineAt = startedAt + Math.max(0, Math.floor(options.deadlineMs));
        let everExisted = false;
        let lastFingerprint: string | null = null;
        let stableStreak = 0;
        const probedFingerprints = new Set<string>();
        let lastRepollMismatch: { code: SaveIdentityMismatchCode; detail: string } | null = null;
        let activeProbe: SaveParserRunHandle | null = null;
        let pollHandle: unknown = null;

        const fail = (code: SaveFactErrorCode, detail: string): void => {
            this.logger?.warn(`[SaveSnapshotWaiter] wait failed: code=${code}`);
            settle({ status: 'failed', code, detail });
        };

        const onDeadline = (): void => {
            if (settled) return;
            if (activeProbe) activeProbe.cancel();
            if (lastRepollMismatch) {
                settle({
                    status: 'mismatch',
                    code: lastRepollMismatch.code,
                    detail: lastRepollMismatch.detail,
                    filePath: targetPath
                });
            } else if (!everExisted) {
                settle({ status: 'not_found', detail: `snapshot file '${fileName}' never appeared` });
            } else {
                settle({ status: 'timeout', detail: 'snapshot file never stabilized with a matching identity' });
            }
        };

        const onAbort = (): void => {
            if (settled) return;
            if (activeProbe) activeProbe.cancel();
            settle({ status: 'superseded', detail: 'wait superseded by a newer snapshot sequence' });
        };

        // -- Step 2: baseline old fingerprint ----------------------------------
        // A pre-existing old file is not an error; the poll loop probes it,
        // records the old identity and keeps waiting.
        const baseline = this.sample(targetPath);
        if (baseline.kind === 'ok') {
            everExisted = true;
            if (!isContained()) {
                fail('SAVE_READ_DENIED', 'snapshot target escapes the save games root');
                return promise;
            }
        } else if (baseline.kind === 'error') {
            fail('SAVE_READ_DENIED', baseline.detail);
            return promise;
        }

        // -- Probe --------------------------------------------------------------

        const runProbe = async (): Promise<void> => {
            const request: SaveFactExtractionRequestV1 = {
                protocolVersion: 2,
                operation: 'probe',
                expected: options.expected,
                categories: ['identity'],
                limits: PROBE_REQUEST_LIMITS
            };
            const remainingMs = Math.max(1, Math.floor(deadlineAt - this.timer.now()));
            let handle: SaveParserRunHandle;
            try {
                handle = this.client.start({
                    request,
                    inputPath: targetPath,
                    allowedRootPath: realRoot,
                    timeoutMs: remainingMs,
                    signal: options.signal
                });
            } catch (error) {
                fail('SAVE_PARSE_FAILED', `probe could not be started: ${describeError(error)}`);
                return;
            }
            activeProbe = handle;
            const outcome = await handle.promise;
            activeProbe = null;
            if (settled) return;

            if (!outcome.ok) {
                if (outcome.code === 'START_SUPERSEDED') {
                    settle({ status: 'superseded', detail: outcome.detail });
                } else {
                    fail(outcome.code, outcome.detail);
                }
                return;
            }

            const verdict = validateSnapshotIdentity(outcome.result, options.expected, 'probe');
            if (verdict.ok) {
                settle({ status: 'matched', filePath: targetPath, response: outcome.result });
                return;
            }
            if (REPOLL_MISMATCH_CODES.has(verdict.code)) {
                // Old snapshot of the same conversation: fingerprint already
                // recorded in the probed set; keep waiting for a change.
                this.logger?.warn(`[SaveSnapshotWaiter] probe returned old identity: code=${verdict.code}; continuing to wait`);
                lastRepollMismatch = { code: verdict.code, detail: verdict.detail };
                return;
            }
            settle({
                status: 'mismatch',
                code: verdict.code,
                detail: verdict.detail,
                filePath: targetPath
            });
        };

        // -- Step 3/4: poll -> stable -> probe loop ------------------------------

        const poll = (): void => {
            if (settled) return;
            if (this.timer.now() >= deadlineAt) {
                onDeadline();
                return;
            }

            const sample = this.sample(targetPath);
            if (sample.kind === 'error') {
                fail('SAVE_READ_DENIED', sample.detail);
                return;
            }
            if (sample.kind !== 'ok') {
                // Missing file (not yet written, create->rename gap) or a
                // transient sharing violation: retry, stability unconfirmed.
                stableStreak = 0;
                lastFingerprint = null;
                schedulePoll();
                return;
            }

            everExisted = true;
            const fingerprint = sample.fingerprint;
            if (fingerprint === lastFingerprint) {
                stableStreak += 1;
            } else {
                lastFingerprint = fingerprint;
                stableStreak = 1;
            }

            if (
                stableStreak >= SAVE_SNAPSHOT_STABLE_POLLS_REQUIRED &&
                !probedFingerprints.has(fingerprint)
            ) {
                if (!isContained()) {
                    fail('SAVE_READ_DENIED', 'snapshot target escapes the save games root');
                    return;
                }
                // Dedup BEFORE the probe so the same fingerprint can never
                // start two probes, even if the streak rebuilds afterwards.
                probedFingerprints.add(fingerprint);
                stableStreak = 0;
                lastFingerprint = null;
                void runProbe().then(() => {
                    if (!settled) schedulePoll();
                });
                return;
            }
            schedulePoll();
        };

        const schedulePoll = (): void => {
            pollHandle = this.timer.setTimeout(poll, this.settings.pollIntervalMs);
        };

        // -- Deadline and external cancellation ---------------------------------

        const signal = options.signal;
        if (signal?.aborted) {
            settle({ status: 'superseded', detail: 'wait superseded before it started' });
            return promise;
        }
        if (signal) {
            signal.addEventListener('abort', onAbort);
            cleanupTasks.push(() => signal.removeEventListener('abort', onAbort));
        }

        const deadlineHandle = this.timer.setTimeout(onDeadline, Math.max(0, deadlineAt - this.timer.now()));
        cleanupTasks.push(() => this.timer.clearTimeout(deadlineHandle));
        cleanupTasks.push(() => {
            if (pollHandle !== null) this.timer.clearTimeout(pollHandle);
        });

        schedulePoll();
        return promise;
    }

    /**
     * Sample the target's fingerprint: `size:mtimeMs:head-hex`. The bounded
     * head read makes content changes visible even when size and mtime stay
     * identical (coarse mtime granularity).
     */
    private sample(targetPath: string): SampleResult {
        let stat: SaveSnapshotStatLike;
        try {
            stat = this.fs.statSync(targetPath);
        } catch (error) {
            return this.mapFsError('stat', error);
        }
        let head: Buffer;
        try {
            head = this.fs.readHeadSync(targetPath, SAVE_SNAPSHOT_QUICK_FINGERPRINT_BYTES);
        } catch (error) {
            return this.mapFsError('read', error);
        }
        return { kind: 'ok', fingerprint: `${stat.size}:${stat.mtimeMs}:${head.toString('hex')}` };
    }

    private mapFsError(operation: 'stat' | 'read', error: unknown): SampleResult {
        const code = errorCode(error);
        if (code !== undefined && MISSING_FS_ERROR_CODES.has(code)) {
            return { kind: 'missing' };
        }
        if (code !== undefined && TRANSIENT_FS_ERROR_CODES.has(code)) {
            return { kind: 'transient' };
        }
        return {
            kind: 'error',
            detail: `snapshot ${operation} failed${code ? ` (${code})` : ''}: ${describeError(error)}`
        };
    }
}
