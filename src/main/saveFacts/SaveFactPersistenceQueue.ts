/**
 * Small best-effort FIFO for save-fact sidecar persistence.
 *
 * The queue deliberately knows nothing about save facts.  Tasks are started
 * in insertion order, failures are contained, and the queue never exposes a
 * rejected promise to a fire-and-forget caller.
 */

export const DEFAULT_SAVE_FACT_PERSISTENCE_QUEUE_MAX_ITEMS = 32;
// One extracted response may be as large as the coordinator's 2 MiB output
// cap. Keep room for one current snapshot plus the small name-cache tail,
// while still bounding fire-and-forget persistence growth.
export const DEFAULT_SAVE_FACT_PERSISTENCE_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SAVE_FACT_PERSISTENCE_FLUSH_TIMEOUT_MS = 250;

export type SaveFactPersistenceWarningCode =
    | 'CURRENT_CACHE_WRITE_FAILED'
    | 'CURRENT_CACHE_WRITE_SKIPPED'
    | 'ENTITY_NAME_CACHE_WRITE_FAILED'
    | 'ENTITY_NAME_CACHE_WRITE_SKIPPED';

export interface SaveFactPersistenceTaskWarningCodes {
    failed: SaveFactPersistenceWarningCode;
    skipped: SaveFactPersistenceWarningCode;
}

export interface SaveFactPersistenceQueueOptions {
    maxItems?: number;
    maxBytes?: number;
    onWarning?: (code: SaveFactPersistenceWarningCode) => void;
}

export interface SaveFactPersistenceFlushResult {
    flushed: boolean;
    discarded: number;
}

interface QueueItem {
    task: () => void | Promise<void>;
    bytes: number;
    warnings: SaveFactPersistenceTaskWarningCodes;
}

const DEFAULT_TASK_WARNING_CODES: SaveFactPersistenceTaskWarningCodes = {
    failed: 'ENTITY_NAME_CACHE_WRITE_FAILED',
    skipped: 'ENTITY_NAME_CACHE_WRITE_SKIPPED'
};

function positiveFinite(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A bounded, serial, best-effort persistence queue.
 *
 * `flushOrDiscard` accepts either an absolute deadline (the normal production
 * form) or a short duration in milliseconds (convenient for callers/tests).
 */
export class SaveFactPersistenceQueue {
    private readonly maxItems: number;
    private readonly maxBytes: number;
    private readonly onWarning?: (code: SaveFactPersistenceWarningCode) => void;
    private readonly items: QueueItem[] = [];
    private queuedBytes = 0;
    private runningBytes = 0;
    private running = false;
    private pumpScheduled = false;
    private idleWaiters: Array<() => void> = [];

    constructor(options: SaveFactPersistenceQueueOptions = {}) {
        this.maxItems = positiveFinite(options.maxItems, DEFAULT_SAVE_FACT_PERSISTENCE_QUEUE_MAX_ITEMS);
        this.maxBytes = positiveFinite(options.maxBytes, DEFAULT_SAVE_FACT_PERSISTENCE_QUEUE_MAX_BYTES);
        this.onWarning = options.onWarning;
    }

    get pendingCount(): number {
        return this.items.length + (this.running ? 1 : 0);
    }

    get pendingBytes(): number {
        return this.queuedBytes + this.runningBytes;
    }

    /** Schedule a task without waiting for it to execute. */
    schedule(
        task: () => void | Promise<void>,
        estimatedBytes = 0,
        warnings: SaveFactPersistenceTaskWarningCodes = DEFAULT_TASK_WARNING_CODES
    ): boolean {
        const bytes = Math.max(0, Number.isFinite(estimatedBytes) ? Math.floor(estimatedBytes) : 0);
        if (
            this.items.length + (this.running ? 1 : 0) >= this.maxItems
            || this.queuedBytes + this.runningBytes + bytes > this.maxBytes
        ) {
            this.warn(warnings.skipped);
            return false;
        }

        this.items.push({ task, bytes, warnings });
        this.queuedBytes += bytes;
        this.schedulePump();
        return true;
    }

    /** Drop work that has not started.  The active task is allowed to finish. */
    discard(): number {
        const discarded = this.items.length;
        this.items.length = 0;
        this.queuedBytes = 0;
        this.resolveIdleIfNeeded();
        return discarded;
    }

    /** Flush until idle, or discard the not-yet-started tail at the deadline. */
    async flushOrDiscard(deadlineOrTimeoutMs = Date.now() + DEFAULT_SAVE_FACT_PERSISTENCE_FLUSH_TIMEOUT_MS): Promise<SaveFactPersistenceFlushResult> {
        const deadline = deadlineOrTimeoutMs < 1_000_000_000_000
            ? Date.now() + Math.max(0, deadlineOrTimeoutMs)
            : deadlineOrTimeoutMs;
        if (!this.running && this.items.length === 0) return { flushed: true, discarded: 0 };

        const flushed = await new Promise<boolean>(resolve => {
            this.idleWaiters.push(() => resolve(true));
            const remaining = Math.max(0, deadline - Date.now());
            const timer = setTimeout(() => {
                const index = this.idleWaiters.findIndex(waiter => waiter === onIdle);
                if (index >= 0) this.idleWaiters.splice(index, 1);
                resolve(false);
            }, remaining);
            const onIdle = (): void => {
                clearTimeout(timer);
                resolve(true);
            };
            this.idleWaiters[this.idleWaiters.length - 1] = onIdle;
        });

        if (flushed) return { flushed: true, discarded: 0 };
        return { flushed: false, discarded: this.discard() };
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.items.length > 0) {
                const item = this.items.shift()!;
                this.queuedBytes -= item.bytes;
                this.runningBytes = item.bytes;
                try {
                    await item.task();
                } catch {
                    this.warn(item.warnings.failed);
                } finally {
                    this.runningBytes = 0;
                }
            }
        } finally {
            this.running = false;
            this.resolveIdleIfNeeded();
        }
    }

    /**
     * Starting an async function still runs synchronously until its first
     * suspension point. Use the next event-loop turn (not a microtask), so a
     * caller awaiting `prepare()` receives the in-memory context before a
     * synchronous filesystem task can occupy the main thread.
     */
    private schedulePump(): void {
        if (this.running || this.pumpScheduled) return;
        this.pumpScheduled = true;
        setImmediate(() => {
            this.pumpScheduled = false;
            void this.pump();
        });
    }

    private resolveIdleIfNeeded(): void {
        if (this.running || this.items.length > 0) return;
        const waiters = this.idleWaiters.splice(0);
        for (const waiter of waiters) waiter();
    }

    private warn(code: SaveFactPersistenceWarningCode): void {
        try {
            this.onWarning?.(code);
        } catch {
            // Diagnostics must never turn best-effort persistence into an
            // unhandled rejection or a conversation failure.
        }
    }
}
