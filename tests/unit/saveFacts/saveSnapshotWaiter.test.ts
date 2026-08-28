import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SaveSnapshotWaiter,
    type SaveSnapshotFsLike,
    type SaveSnapshotWaitOptions
} from '../../../src/main/saveFacts/SaveSnapshotWaiter';
import type {
    SaveParserRunHandle,
    SaveParserRunOptions,
    SaveParserRunOutcome
} from '../../../src/main/saveFacts/SaveParserClient';
import type { ExpectedSnapshotIdentity } from '../../../src/main/saveFacts/SaveIdentityValidator';
import type { SaveFactExtractionResultV1 } from '../../../src/main/saveFacts/saveFactTypes';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTimer {
    private nowMs = 0;
    private nextId = 1;
    private readonly pending = new Map<number, { at: number; callback: () => void }>();

    readonly now = (): number => this.nowMs;

    readonly setTimeout = (callback: () => void, ms: number): unknown => {
        const id = this.nextId++;
        this.pending.set(id, { at: this.nowMs + ms, callback });
        return id;
    };

    readonly clearTimeout = (handle: unknown): void => {
        this.pending.delete(handle as number);
    };

    advance(ms: number): void {
        const target = this.nowMs + ms;
        for (;;) {
            let nextId: number | undefined;
            let nextAt = Infinity;
            for (const [id, entry] of this.pending) {
                if (entry.at <= target && (entry.at < nextAt || (entry.at === nextAt && id < (nextId ?? id)))) {
                    nextId = id;
                    nextAt = entry.at;
                }
            }
            if (nextId === undefined) break;
            const entry = this.pending.get(nextId);
            this.pending.delete(nextId);
            if (!entry) continue;
            this.nowMs = entry.at;
            entry.callback();
        }
        this.nowMs = target;
    }
}

interface FakeRun {
    options: SaveParserRunOptions;
    cancel: jest.Mock<void, []>;
    resolve(outcome: SaveParserRunOutcome): void;
}

class FakeParserClient {
    readonly runs: FakeRun[] = [];

    readonly start = jest.fn((options: SaveParserRunOptions): SaveParserRunHandle => {
        let resolvePromise!: (outcome: SaveParserRunOutcome) => void;
        const promise = new Promise<SaveParserRunOutcome>((resolve) => {
            resolvePromise = resolve;
        });
        const run: FakeRun = {
            options,
            cancel: jest.fn(() => {
                resolvePromise({ ok: false, code: 'START_SUPERSEDED', detail: 'cancelled' });
            }),
            resolve: (outcome) => resolvePromise(outcome)
        };
        this.runs.push(run);
        return { promise, cancel: run.cancel };
    });
}

function nodeFsLike(): SaveSnapshotFsLike {
    return {
        statSync: (target) => {
            const stat = fs.statSync(target);
            return { size: stat.size, mtimeMs: stat.mtimeMs };
        },
        realpathSync: (target) => fs.realpathSync(target),
        readHeadSync: (target, maxBytes) => {
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
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

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

type IdentityOverrides = Partial<NonNullable<SaveFactExtractionResultV1['identity']>>;

function makeProbeResponse(identityOverrides?: IdentityOverrides): SaveFactExtractionResultV1 {
    return {
        protocolVersion: 2,
        operation: 'probe',
        status: 'ok',
        manifest: {
            snapshotId: 'snap.1',
            sourceFingerprint: 'fp.1',
            sourceFormat: 'unified_text',
            parserVersion: '1.0.0',
            factSchemaVersion: 1
        },
        identity: {
            playerCharacterId: '12345',
            gameDateNumeric: 320000,
            gameDateDisplay: '1100.1.1',
            campaignIdParts: [1, 2, 3, 4],
            snapshotSequence: 42,
            snapshotSlot: 0,
            ...identityOverrides
        },
        entities: [],
        facts: [],
        warnings: [],
        metrics: { inputBytes: 100, durationMs: 5, emittedFacts: 0, emittedEntities: 0 }
    };
}

function okOutcome(identityOverrides?: IdentityOverrides): SaveParserRunOutcome {
    return { ok: true, result: makeProbeResponse(identityOverrides) };
}

interface Harness {
    root: string;
    saveRoot: string;
    target: string;
    timer: FakeTimer;
    client: FakeParserClient;
    waiter: SaveSnapshotWaiter;
    warnings: string[];
}

const tempRoots: string[] = [];

function makeHarness(fsOverride?: SaveSnapshotFsLike): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-waiter-'));
    tempRoots.push(root);
    const saveRoot = path.join(root, 'save games');
    fs.mkdirSync(saveRoot);
    const timer = new FakeTimer();
    const client = new FakeParserClient();
    const warnings: string[] = [];
    const waiter = new SaveSnapshotWaiter({
        client,
        timer,
        fs: fsOverride,
        logger: { warn: (message) => warnings.push(message) },
        settings: { pollIntervalMs: 250 }
    });
    return {
        root,
        saveRoot,
        target: path.join(saveRoot, 'votc_context.ck3'),
        timer,
        client,
        waiter,
        warnings
    };
}

function waitOptions(h: Harness, overrides?: Partial<SaveSnapshotWaitOptions>): SaveSnapshotWaitOptions {
    return {
        userFolderPath: h.root,
        snapshotSlot: 0,
        expected: EXPECTED,
        deadlineMs: 10000,
        ...overrides
    };
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SaveSnapshotWaiter', () => {
    it('returns not_found when the file never appears', async () => {
        const h = makeHarness();
        const waitPromise = h.waiter.wait(waitOptions(h));
        h.timer.advance(10000);
        const result = await waitPromise;
        expect(result.status).toBe('not_found');
        expect(h.client.start).not.toHaveBeenCalled();
    });

    it('probes a stable file and returns matched with the file path and response', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'SNAPSHOT-CONTENT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(750); // 3 stable polls
        expect(h.client.runs).toHaveLength(1);
        expect(h.client.runs[0].options.inputPath).toBe(h.target);
        expect(h.client.runs[0].options.allowedRootPath).toBe(fs.realpathSync(h.saveRoot));
        expect(h.client.runs[0].options.request.operation).toBe('probe');
        expect(h.client.runs[0].options.request.expected).toEqual(EXPECTED);

        h.client.runs[0].resolve(okOutcome());
        const result = await waitPromise;
        expect(result.status).toBe('matched');
        if (result.status === 'matched') {
            expect(result.filePath).toBe(h.target);
            expect(result.response.identity?.snapshotSequence).toBe(42);
        }
    });

    it('keeps waiting past an old file and matches a new file written in chunks', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'OLD-SNAPSHOT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        // The pre-existing old file stabilizes and is probed: old sequence.
        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve(okOutcome({ snapshotSequence: 41 }));
        await flush();

        // Unchanged old fingerprint is never re-probed.
        h.timer.advance(1000);
        expect(h.client.runs).toHaveLength(1);

        // The mod writes the new snapshot in chunks; each change resets the
        // stability streak.
        fs.writeFileSync(h.target, 'NEW-SNAP');
        h.timer.advance(250);
        fs.appendFileSync(h.target, '-CHUNK2');
        h.timer.advance(250);
        fs.appendFileSync(h.target, '-CHUNK3');
        expect(h.client.runs).toHaveLength(1); // still unstable
        h.timer.advance(750); // 3 stable polls on the final content
        expect(h.client.runs).toHaveLength(2);

        h.client.runs[1].resolve(okOutcome());
        const result = await waitPromise;
        expect(result.status).toBe('matched');
    });

    it('detects a content change when size and mtime stay identical', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'AAAAAAAAAA');
        const stat = fs.statSync(h.target);
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve(okOutcome({ snapshotSequence: 41 }));
        await flush();

        // Same length, same mtime, different content: the bounded head
        // fingerprint must still notice.
        fs.writeFileSync(h.target, 'BBBBBBBBBB');
        fs.utimesSync(h.target, stat.atime, stat.mtime);
        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(2);

        h.client.runs[1].resolve(okOutcome());
        const result = await waitPromise;
        expect(result.status).toBe('matched');
    });

    it('retries through read sharing violations', async () => {
        const real = nodeFsLike();
        let failuresLeft = 4; // baseline sample + 3 polls
        const faultFs: SaveSnapshotFsLike = {
            statSync: (target) => {
                if (failuresLeft-- > 0) {
                    const error = new Error('sharing violation') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return real.statSync(target);
            },
            realpathSync: (target) => real.realpathSync(target),
            readHeadSync: (target, maxBytes) => real.readHeadSync(target, maxBytes)
        };
        const h = makeHarness(faultFs);
        fs.writeFileSync(h.target, 'SNAPSHOT-CONTENT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(2500);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve(okOutcome());
        const result = await waitPromise;
        expect(result.status).toBe('matched');
    });

    it('an old sequence keeps waiting, never re-probes the same fingerprint, and the deadline returns the recorded mismatch', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'OLD-SNAPSHOT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve(okOutcome({ snapshotSequence: 41 }));
        await flush();

        // Many more polls on the unchanged file: no second probe.
        h.timer.advance(5000);
        expect(h.client.runs).toHaveLength(1);

        // The overall deadline returns the recorded identity mismatch.
        h.timer.advance(10000);
        const result = await waitPromise;
        expect(result).toMatchObject({
            status: 'mismatch',
            code: 'SAVE_SEQUENCE_MISMATCH',
            filePath: h.target
        });
    });

    it('returns timeout when the file never stabilizes', async () => {
        const h = makeHarness();
        const waitPromise = h.waiter.wait(waitOptions(h));
        for (let i = 0; i < 40; i++) {
            fs.appendFileSync(h.target, `chunk${i};`);
            h.timer.advance(250);
        }
        const result = await waitPromise;
        expect(result.status).toBe('timeout');
    });

    it('a player mismatch is terminal and never repolls', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'WRONG-PLAYER-SNAPSHOT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve(okOutcome({ playerCharacterId: '99999' }));
        const result = await waitPromise;
        expect(result).toMatchObject({ status: 'mismatch', code: 'SAVE_PLAYER_MISMATCH' });
    });

    it('a parser failure is returned as failed with the parser code', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'SNAPSHOT-CONTENT');
        const waitPromise = h.waiter.wait(waitOptions(h));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        h.client.runs[0].resolve({ ok: false, code: 'PARSER_TIMEOUT', detail: 'sidecar too slow' });
        const result = await waitPromise;
        expect(result).toMatchObject({ status: 'failed', code: 'PARSER_TIMEOUT' });
    });

    it('abort before any probe returns superseded', async () => {
        const h = makeHarness();
        const controller = new AbortController();
        const waitPromise = h.waiter.wait(waitOptions(h, { signal: controller.signal }));
        h.timer.advance(500);
        controller.abort();
        const result = await waitPromise;
        expect(result.status).toBe('superseded');
        expect(h.client.start).not.toHaveBeenCalled();
    });

    it('abort during an in-flight probe cancels the probe and returns superseded', async () => {
        const h = makeHarness();
        fs.writeFileSync(h.target, 'SNAPSHOT-CONTENT');
        const controller = new AbortController();
        const waitPromise = h.waiter.wait(waitOptions(h, { signal: controller.signal }));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        controller.abort();
        const result = await waitPromise;
        expect(result.status).toBe('superseded');
        expect(h.client.runs[0].cancel).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the target is a symlink escaping the save games root', async () => {
        const real = nodeFsLike();
        let escapedTarget = '';
        let outside = '';
        const escapedRealpathFs: SaveSnapshotFsLike = {
            statSync: (target) => real.statSync(target),
            realpathSync: (target) => path.resolve(target) === escapedTarget
                ? outside
                : real.realpathSync(target),
            readHeadSync: (target, maxBytes) => real.readHeadSync(target, maxBytes)
        };
        const h = makeHarness(escapedRealpathFs);
        escapedTarget = path.resolve(h.target);
        outside = path.join(h.root, 'outside.ck3');
        // Simulate the realpath result of an escaping symlink without asking
        // Windows for symlink privileges (which ordinary CI users lack).
        fs.writeFileSync(h.target, 'ESCAPED-CONTENT');

        const result = await h.waiter.wait(waitOptions(h));
        expect(result).toMatchObject({ status: 'failed', code: 'SAVE_READ_DENIED' });
        expect(h.client.start).not.toHaveBeenCalled();
    });

    it('uses the slot-suffixed protocol file name for slot 1', async () => {
        const h = makeHarness();
        const slotTarget = path.join(h.saveRoot, 'votc_context_1.ck3');
        fs.writeFileSync(slotTarget, 'SLOT-ONE-SNAPSHOT');
        const expected: ExpectedSnapshotIdentity = { ...EXPECTED, snapshotSlot: 1 };
        const waitPromise = h.waiter.wait(waitOptions(h, { snapshotSlot: 1, expected }));

        h.timer.advance(750);
        expect(h.client.runs).toHaveLength(1);
        expect(h.client.runs[0].options.inputPath).toBe(slotTarget);
        h.client.runs[0].resolve(okOutcome({ snapshotSlot: 1 }));
        const result = await waitPromise;
        expect(result.status).toBe('matched');
    });
});
