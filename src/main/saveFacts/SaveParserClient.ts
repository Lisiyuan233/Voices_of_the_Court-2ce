/**
 * Save parser (sidecar) process client (implementation plan Task 10).
 *
 * Owns the process/protocol boundary between the app and the
 * `votc-save-facts` Rust sidecar:
 * - The executable path comes from the injected resolver (`saveParserPath`);
 *   this module never probes the filesystem itself.
 * - The child is spawned with fixed options (`shell: false`,
 *   `windowsHide: true`, piped stdio). argv contains ONLY the fixed
 *   subcommand, the containment-verified input/allowed-root absolute paths
 *   (verified by the caller, plan Task 11) and a numeric output cap. The
 *   request JSON travels over stdin and never appears in argv; the request
 *   DTO carries no prompt text, no user message and no API key.
 * - stdin is written once and ended immediately. A stdin stream error is
 *   converged into a parser failure. Because the write happens up front and
 *   every write is guarded by the settled flag, a timed-out or superseded run
 *   never writes again.
 * - stdout is hard-capped (default 2 MiB): crossing the cap kills the child
 *   and fails with `PARSER_OUTPUT_LIMIT`. stderr policy is
 *   truncate-and-continue: only the first 64 KiB are retained (bounded
 *   diagnostics head), the rest is dropped, and the run continues — killing
 *   on chatty stderr would let a noisy sidecar deny an otherwise valid
 *   parse. stderr content is never logged and never returned; logs keep the
 *   error code only.
 * - Timeout and cancellation: an internal deadline kills the child and fails
 *   with `PARSER_TIMEOUT`; an external `AbortSignal` or `handle.cancel()`
 *   (a newer snapshot sequence superseding this run) kills the child and
 *   fails with `START_SUPERSEDED`. The sidecar never starts subprocesses, so
 *   killing the direct child is sufficient; if that ever changes this must
 *   be upgraded to a job-object / process-tree strategy.
 * - A domain result is returned only when the process exited with code 0 and
 *   no signal, stdout is exactly one UTF-8 JSON document (one trailing
 *   newline allowed), the schema whitelist validator accepts it and the
 *   response operation matches the request operation. Every other outcome is
 *   a typed failure — this module never throws and never rejects.
 * - All listeners and the timer are removed when the run settles, so a
 *   settled run holds no references and late process events are inert.
 */

// P5b deferred (verify/session/delta/agency): the 1.x client also ran the
// `capabilities` handshake (agency-only consumer) and the `verify` op, both
// validated by `saveFactVerificationSchemas.ts` (not ported to 2CE). Those op
// paths, their run-option/outcome unions and the response check-id matching
// are removed; only `probe`/`extract` runs remain.

import {
    validateSaveFactExtractionResult
} from './saveFactSchemas';
import type { SaveParserLoggerLike, SaveParserPathResult } from './saveParserPath';
import type {
    SaveFactErrorCode,
    SaveFactExtractionRequestV1,
    SaveFactExtractionResultV1
} from './saveFactTypes';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const SAVE_PARSER_STDOUT_CAP_BYTES = 2 * 1024 * 1024;
export const SAVE_PARSER_STDERR_CAP_BYTES = 64 * 1024;
export const SAVE_PARSER_REQUEST_CAP_BYTES = 64 * 1024;
export const SAVE_PARSER_DEFAULT_TIMEOUT_MS = 10000;

export interface SaveParserClientLimits {
    /** Hard cap for the stdout stream; crossing it kills the child. */
    maxStdoutBytes: number;
    /** Cap for the retained stderr diagnostic head (truncate-and-continue). */
    maxStderrBytes: number;
    /** Cap for the serialized stdin request; crossing it aborts before spawn. */
    maxRequestBytes: number;
}

export const SAVE_PARSER_DEFAULT_LIMITS: SaveParserClientLimits = {
    maxStdoutBytes: SAVE_PARSER_STDOUT_CAP_BYTES,
    maxStderrBytes: SAVE_PARSER_STDERR_CAP_BYTES,
    maxRequestBytes: SAVE_PARSER_REQUEST_CAP_BYTES
};

// ---------------------------------------------------------------------------
// Injectable process surface
// ---------------------------------------------------------------------------

export interface SaveParserWritableLike {
    write(chunk: string): void;
    end(): void;
    on(event: 'error', listener: (error: Error) => void): void;
    removeListener(event: 'error', listener: (error: Error) => void): void;
}

export interface SaveParserReadableLike {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
    removeListener(event: 'data', listener: (chunk: Buffer) => void): void;
}

/**
 * Minimal child-process surface used by the client. The real
 * `child_process.ChildProcess` satisfies this structurally; tests inject an
 * EventEmitter-based fake.
 */
export interface SaveParserChildProcessLike {
    readonly stdin: SaveParserWritableLike;
    readonly stdout: SaveParserReadableLike;
    readonly stderr: SaveParserReadableLike;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    removeListener(event: 'error', listener: (error: Error) => void): void;
    removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    kill(signal?: NodeJS.Signals | number): void;
}

/** Fixed spawn options; the client always passes exactly these values. */
export interface SaveParserSpawnOptions {
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

/** `child_process.spawn`-compatible signature, narrowed to the fixed options. */
export type SaveParserSpawnFn = (
    command: string,
    args: readonly string[],
    options: SaveParserSpawnOptions
) => SaveParserChildProcessLike;

/** Minimal timer surface; defaults to the global setTimeout/clearTimeout. */
export interface SaveParserTimerLike {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realSpawn: SaveParserSpawnFn = (command, args, options) => {
    // Lazy require keeps the module importable in test environments that
    // never spawn a real process.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process') as typeof import('child_process');
    return spawn(command, args as string[], options as object) as unknown as SaveParserChildProcessLike;
};

const realTimer: SaveParserTimerLike = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SaveParserClientDeps {
    /** Executable resolver from `saveParserPath` (or a test double). */
    resolveExecutable: () => SaveParserPathResult;
    /** Spawn function; defaults to the real `child_process.spawn`. */
    spawn?: SaveParserSpawnFn;
    /** Timer; defaults to the global setTimeout/clearTimeout. */
    timer?: SaveParserTimerLike;
    /** Logger; receives error codes only, never sidecar output. */
    logger?: SaveParserLoggerLike;
    /** Hard limits; unspecified fields fall back to the defaults. */
    limits?: Partial<SaveParserClientLimits>;
}

export interface SaveParserExtractionRunOptions {
    request: SaveFactExtractionRequestV1;
    inputPath: string;
    allowedRootPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

/** Extraction-family path run options (probe/extract requests carry a path). */
export type SaveParserPathRequest = SaveFactExtractionRequestV1;
/** Backward-compatible v1 path run options used by the existing coordinator/tests. */
export type SaveParserRunOptions = SaveParserExtractionRunOptions;
// P5b deferred (verify/session/delta/agency): SaveParserAnyRunOptions also
// covered the capabilities and verify run options in 1.x; extraction-only now.
export type SaveParserAnyRunOptions = SaveParserExtractionRunOptions;

export type SaveParserPathRunOptions = SaveParserExtractionRunOptions;

/**
 * Protocol v1 request DTO. Serialized to stdin. The argv subcommand is
 * derived from `request.operation` so the two can never disagree.
 */
export type SaveParserRunOutcome =
    | { ok: true; result: SaveFactExtractionResultV1 }
    | { ok: false; code: SaveFactErrorCode; detail: string };
// P5b deferred (verify/session/delta/agency): SaveParserCapabilitiesRunOutcome
// and SaveParserVerificationRunOutcome removed with their op paths.
export type SaveParserAnyRunOutcome = SaveParserRunOutcome;

export interface SaveParserRunHandle<T = SaveParserRunOutcome> {
    /** Always resolves with a typed outcome; never rejects. */
    readonly promise: Promise<T>;
    /**
     * Supersede this run (a newer snapshot sequence started). Kills the
     * sidecar; the promise resolves with `START_SUPERSEDED`. No-op once the
     * run has settled.
     */
    cancel(): void;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SaveParserClient {
    private readonly resolveExecutable: () => SaveParserPathResult;
    private readonly spawnFn: SaveParserSpawnFn;
    private readonly timer: SaveParserTimerLike;
    private readonly logger?: SaveParserLoggerLike;
    private readonly limits: SaveParserClientLimits;

    constructor(deps: SaveParserClientDeps) {
        this.resolveExecutable = deps.resolveExecutable;
        this.spawnFn = deps.spawn ?? realSpawn;
        this.timer = deps.timer ?? realTimer;
        this.logger = deps.logger;
        this.limits = { ...SAVE_PARSER_DEFAULT_LIMITS, ...deps.limits };
    }

    start(options: SaveParserExtractionRunOptions): SaveParserRunHandle;
    start(options: SaveParserAnyRunOptions): SaveParserRunHandle<SaveParserAnyRunOutcome> {
        let settled = false;
        let resolvePromise!: (outcome: SaveParserAnyRunOutcome) => void;
        const promise = new Promise<SaveParserAnyRunOutcome>((resolve) => {
            resolvePromise = resolve;
        });
        const cleanupTasks: Array<() => void> = [];
        let child: SaveParserChildProcessLike | undefined;

        const settle = (outcome: SaveParserAnyRunOutcome): void => {
            if (settled) return;
            settled = true;
            for (const task of cleanupTasks.splice(0)) {
                try {
                    task();
                } catch {
                    // Cleanup is best-effort and must never throw into settle.
                }
            }
            resolvePromise(outcome);
        };

        const fail = (code: SaveFactErrorCode, detail: string): void => {
            // Logs carry the error code only; sidecar stderr content, save
            // data and response payloads never reach the log.
            this.logger?.warn(`[SaveParserClient] sidecar run failed: code=${code}`);
            settle({ ok: false, code, detail });
        };

        const killChild = (): void => {
            if (!child) return;
            try {
                child.kill();
            } catch {
                // The process is already gone; nothing to reclaim.
            }
        };

        const cancel = (): void => {
            killChild();
            fail('START_SUPERSEDED', 'run superseded by a newer snapshot sequence');
        };

        // -- Pre-spawn gates ------------------------------------------------

        if (options.signal?.aborted) {
            fail('START_SUPERSEDED', 'run superseded before spawn');
            return { promise, cancel };
        }

        let resolved: SaveParserPathResult;
        try {
            resolved = this.resolveExecutable();
        } catch (error) {
            fail('PARSER_NOT_FOUND', `executable resolver failed: ${describeError(error)}`);
            return { promise, cancel };
        }
        if (!resolved.ok) {
            // Both resolver kinds (missing binary, unsupported platform) mean
            // no sidecar can be started; the error-code union has no dedicated
            // platform code, so both collapse to PARSER_NOT_FOUND.
            fail('PARSER_NOT_FOUND', resolved.detail);
            return { promise, cancel };
        }

        let payload: string;
        try {
            payload = JSON.stringify(options.request);
        } catch (error) {
            fail('SAVE_LIMIT_EXCEEDED', `request serialization failed: ${describeError(error)}`);
            return { promise, cancel };
        }
        if (Buffer.byteLength(payload, 'utf8') > this.limits.maxRequestBytes) {
            fail('SAVE_LIMIT_EXCEEDED', `serialized request exceeds ${this.limits.maxRequestBytes} bytes`);
            return { promise, cancel };
        }

        // -- Spawn ------------------------------------------------------------

        const requestedCap = options.request.limits.maxOutputBytes;
        const maxOutputBytes = Number.isFinite(requestedCap) && requestedCap > 0
            ? Math.min(Math.floor(requestedCap), this.limits.maxStdoutBytes)
            : this.limits.maxStdoutBytes;
        const args = [
            options.request.operation,
            '--input',
            options.inputPath,
            '--allowed-root',
            options.allowedRootPath,
            '--max-output-bytes',
            String(maxOutputBytes)
        ];

        try {
            child = this.spawnFn(resolved.executablePath, args, {
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            fail('PARSER_CRASHED', `spawn failed: ${describeError(error)}`);
            return { promise, cancel };
        }
        const proc = child;

        // -- Stream / process listeners --------------------------------------

        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        // stderr policy: truncate-and-continue. Only the first
        // maxStderrBytes are kept as a bounded diagnostics head; the content
        // is never logged and never returned (logs keep codes only).
        const stderrHead: Buffer[] = [];
        let stderrHeadBytes = 0;
        let stderrTruncated = false;

        const onStdoutData = (chunk: Buffer | string): void => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            stdoutBytes += buf.length;
            if (stdoutBytes > this.limits.maxStdoutBytes) {
                killChild();
                fail('PARSER_OUTPUT_LIMIT', `sidecar stdout exceeded ${this.limits.maxStdoutBytes} bytes`);
                return;
            }
            stdoutChunks.push(buf);
        };

        const onStderrData = (chunk: Buffer | string): void => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            if (stderrHeadBytes < this.limits.maxStderrBytes) {
                const head = buf.subarray(0, this.limits.maxStderrBytes - stderrHeadBytes);
                stderrHead.push(head);
                stderrHeadBytes += head.length;
            }
            if (buf.length > 0 && !stderrTruncated && stderrHeadBytes >= this.limits.maxStderrBytes) {
                stderrTruncated = true;
                this.logger?.warn('[SaveParserClient] sidecar stderr exceeded cap; diagnostic buffer truncated');
            }
        };

        const onStdinError = (): void => {
            // EPIPE and friends: the sidecar closed stdin early. Converge to a
            // parser failure; a later close event cannot resurrect the run.
            killChild();
            fail('PARSER_CRASHED', 'sidecar stdin stream failed');
        };

        const onProcessError = (error: Error): void => {
            // Async spawn failure (e.g. ENOENT between resolve and spawn).
            // Only the error name is used; messages may embed paths.
            killChild();
            fail('PARSER_CRASHED', `sidecar process error: ${error.name}`);
        };

        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
            if (settled) return;
            if (code !== 0 || signal !== null) {
                fail('PARSER_CRASHED', `sidecar exited with code ${String(code)} signal ${String(signal)}`);
                return;
            }
            if (stdoutBytes === 0) {
                fail('PARSER_OUTPUT_INVALID', 'sidecar produced empty stdout');
                return;
            }

            const raw = Buffer.concat(stdoutChunks, stdoutBytes);
            const text = raw.toString('utf8');
            // Strict UTF-8 gate: an invalid byte sequence decodes to U+FFFD
            // and no longer round-trips.
            if (!Buffer.from(text, 'utf8').equals(raw)) {
                fail('PARSER_OUTPUT_INVALID', 'sidecar stdout is not valid UTF-8');
                return;
            }
            let documentText = text;
            if (documentText.charCodeAt(0) === 0xfeff) documentText = documentText.slice(1);
            // The protocol allows a single trailing newline; trailing
            // whitespace is stripped, anything else after the document fails
            // JSON.parse below (which also rejects multiple JSON documents).
            documentText = documentText.trimEnd();
            if (documentText === '') {
                fail('PARSER_OUTPUT_INVALID', 'sidecar stdout contained only whitespace');
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(documentText);
            } catch {
                fail('PARSER_OUTPUT_INVALID', 'sidecar stdout is not a single JSON document');
                return;
            }

            const validation = validateSaveFactExtractionResult(parsed);
            if (!validation.ok) {
                if (validation.code === 'UNSUPPORTED_PROTOCOL_VERSION') {
                    fail('PARSER_PROTOCOL_UNSUPPORTED', `unsupported protocol version at ${validation.path}`);
                } else {
                    fail('PARSER_OUTPUT_INVALID', `response failed validation (${validation.code} at ${validation.path})`);
                }
                return;
            }
            if (validation.value.operation !== options.request.operation) {
                fail(
                    'PARSER_OUTPUT_INVALID',
                    `response operation '${validation.value.operation}' does not match request '${options.request.operation}'`
                );
                return;
            }
            // P5b deferred (verify/session/delta/agency): 1.x additionally
            // validated the verify-op response's check-id set here; removed
            // with the verify op.
            settle({ ok: true, result: validation.value } as SaveParserAnyRunOutcome);
        };

        proc.stdout.on('data', onStdoutData);
        proc.stderr.on('data', onStderrData);
        proc.stdin.on('error', onStdinError);
        proc.on('error', onProcessError);
        proc.on('close', onClose);
        cleanupTasks.push(() => {
            proc.stdout.removeListener('data', onStdoutData);
            proc.stderr.removeListener('data', onStderrData);
            proc.stdin.removeListener('error', onStdinError);
            proc.removeListener('error', onProcessError);
            proc.removeListener('close', onClose);
        });

        // -- Deadline and external cancellation -------------------------------

        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? Math.floor(options.timeoutMs)
            : SAVE_PARSER_DEFAULT_TIMEOUT_MS;
        const timerHandle = this.timer.setTimeout(() => {
            killChild();
            fail('PARSER_TIMEOUT', `sidecar exceeded timeout of ${timeoutMs} ms`);
        }, timeoutMs);
        cleanupTasks.push(() => this.timer.clearTimeout(timerHandle));

        const signal = options.signal;
        if (signal) {
            const onAbort = (): void => {
                killChild();
                fail('START_SUPERSEDED', 'run aborted via AbortSignal');
            };
            signal.addEventListener('abort', onAbort);
            cleanupTasks.push(() => signal.removeEventListener('abort', onAbort));
        }

        // -- stdin lifecycle ---------------------------------------------------
        // Written once and ended immediately; guarded by the settled flag so
        // a run that already timed out or was superseded never writes again.

        if (!settled) {
            try {
                proc.stdin.write(payload);
                proc.stdin.end();
            } catch (error) {
                killChild();
                fail('PARSER_CRASHED', `failed to write request to sidecar stdin: ${describeError(error)}`);
            }
        }

        return { promise, cancel };
    }
}
