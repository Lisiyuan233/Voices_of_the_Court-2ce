import { SaveFactPersistenceQueue } from '../../../src/main/saveFacts/SaveFactPersistenceQueue';

describe('SaveFactPersistenceQueue', () => {
    it('returns from schedule before starting a synchronous persistence task', async () => {
        const queue = new SaveFactPersistenceQueue();
        const calls: string[] = [];

        expect(queue.schedule(() => { calls.push('ran'); }, 1)).toBe(true);
        expect(calls).toEqual([]);

        await expect(queue.flushOrDiscard(1000)).resolves.toEqual({ flushed: true, discarded: 0 });
        expect(calls).toEqual(['ran']);
    });

    it('lets promise continuations run before starting synchronous persistence', async () => {
        const queue = new SaveFactPersistenceQueue();
        const calls: string[] = [];

        queue.schedule(() => { calls.push('persisted'); }, 1);
        await Promise.resolve();
        expect(calls).toEqual([]);

        await queue.flushOrDiscard(1000);
        expect(calls).toEqual(['persisted']);
    });

    it('keeps deferred tasks in FIFO order', async () => {
        const queue = new SaveFactPersistenceQueue();
        const calls: number[] = [];

        queue.schedule(() => { calls.push(1); });
        queue.schedule(() => { calls.push(2); });
        await queue.flushOrDiscard(1000);

        expect(calls).toEqual([1, 2]);
    });

    it('reports task-specific skipped and failed warning codes', async () => {
        const warnings: string[] = [];
        const queue = new SaveFactPersistenceQueue({ maxItems: 1, onWarning: code => warnings.push(code) });

        expect(queue.schedule(
            () => { throw new Error('disk full'); },
            1,
            { failed: 'CURRENT_CACHE_WRITE_FAILED', skipped: 'CURRENT_CACHE_WRITE_SKIPPED' }
        )).toBe(true);
        expect(queue.schedule(
            () => undefined,
            1,
            { failed: 'CURRENT_CACHE_WRITE_FAILED', skipped: 'CURRENT_CACHE_WRITE_SKIPPED' }
        )).toBe(false);

        await queue.flushOrDiscard(1000);
        expect(warnings).toEqual(['CURRENT_CACHE_WRITE_SKIPPED', 'CURRENT_CACHE_WRITE_FAILED']);
    });

    it('keeps the active task inside the byte bound', async () => {
        const warnings: string[] = [];
        const queue = new SaveFactPersistenceQueue({
            maxBytes: 3,
            onWarning: code => warnings.push(code)
        });
        let release!: () => void;
        let markStarted!: () => void;
        const blocker = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { markStarted = resolve; });

        expect(queue.schedule(async () => {
            markStarted();
            await blocker;
        }, 2)).toBe(true);
        await started;

        expect(queue.pendingBytes).toBe(2);
        expect(queue.schedule(() => undefined, 2)).toBe(false);
        expect(warnings).toEqual(['ENTITY_NAME_CACHE_WRITE_SKIPPED']);

        release();
        await expect(queue.flushOrDiscard(1000)).resolves.toEqual({ flushed: true, discarded: 0 });
        expect(queue.pendingBytes).toBe(0);
    });
});
