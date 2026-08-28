import { EventEmitter } from 'events';
import {
    SaveParserClient,
    type SaveParserClientLimits,
    type SaveParserRunOptions,
    type SaveParserSpawnFn,
    type SaveParserSpawnOptions
} from '../../../src/main/saveFacts/SaveParserClient';
import type { SaveParserPathResult } from '../../../src/main/saveFacts/saveParserPath';
import type { SaveFactExtractionRequestV1 } from '../../../src/main/saveFacts/saveFactTypes';
// P5b deferred (verify/session/delta/agency): the capabilities handshake and
// the verify op (and their saveFactTypes request DTOs) are trimmed from the
// 2CE client along with the unported saveFactVerificationSchemas validators;
// the two tests that exercised them are removed accordingly.

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWritable extends EventEmitter {
    readonly written: string[] = [];
    ended = false;

    write(chunk: string): void {
        this.written.push(chunk);
    }

    end(): void {
        this.ended = true;
    }
}

class FakeChildProcess extends EventEmitter {
    readonly stdin = new FakeWritable();
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly kill = jest.fn((): boolean => true);
}

class FakeTimer {
    private nextId = 1;
    readonly pending = new Map<number, { callback: () => void; ms: number }>();
    readonly cleared: number[] = [];

    readonly setTimeout = (callback: () => void, ms: number): unknown => {
        const id = this.nextId++;
        this.pending.set(id, { callback, ms });
        return id;
    };

    readonly clearTimeout = (handle: unknown): void => {
        const id = handle as number;
        this.cleared.push(id);
        this.pending.delete(id);
    };

    fireAll(): void {
        for (const entry of [...this.pending.values()]) {
            entry.callback();
        }
    }
}

interface SpawnCall {
    command: string;
    args: readonly string[];
    options: SaveParserSpawnOptions;
}

interface Harness {
    client: SaveParserClient;
    child: FakeChildProcess;
    spawnCalls: SpawnCall[];
    timer: FakeTimer;
    warnings: string[];
    resolveExecutable: jest.Mock<SaveParserPathResult, []>;
}

const FAKE_EXE = 'C:\\tools\\votc-save-facts.exe';

function makeHarness(overrides?: {
    resolveResult?: SaveParserPathResult;
    limits?: Partial<SaveParserClientLimits>;
}): Harness {
    const child = new FakeChildProcess();
    const spawnCalls: SpawnCall[] = [];
    const spawn: SaveParserSpawnFn = (command, args, options) => {
        spawnCalls.push({ command, args: [...args], options });
        return child;
    };
    const resolveExecutable = jest.fn(
        (): SaveParserPathResult => overrides?.resolveResult ?? { ok: true, executablePath: FAKE_EXE }
    );
    const timer = new FakeTimer();
    const warnings: string[] = [];
    const client = new SaveParserClient({
        resolveExecutable,
        spawn,
        timer,
        logger: { warn: (message: string) => warnings.push(message) },
        limits: overrides?.limits
    });
    return { client, child, spawnCalls, timer, warnings, resolveExecutable };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRequest(operation: 'probe' | 'extract' = 'extract'): SaveFactExtractionRequestV1 {
    return {
        protocolVersion: 2,
        operation,
        expected: {
            playerCharacterId: 'char.player',
            participantCharacterIds: ['char.a', 'char.b'],
            gameDateNumeric: 320000,
            campaignId: 'camp.1',
            campaignIdParts: [1, 2, 3, 4],
            snapshotSequence: 7,
            snapshotSlot: 0
        },
        categories: ['identity', 'family'],
        limits: {
            maxFacts: 100,
            maxEntities: 50,
            maxRelatedCharacters: 25,
            maxOutputBytes: 1024,
            maxDecompressedBytes: 4096,
            maxNestingDepth: 8,
            maxScalarBytes: 256
        }
    };
}

function makeRunOptions(
    request: SaveFactExtractionRequestV1,
    extra?: Partial<SaveParserRunOptions>
): SaveParserRunOptions {
    return {
        request,
        inputPath: 'C:\\saves\\votc_context.ck3',
        allowedRootPath: 'C:\\saves',
        timeoutMs: 5000,
        ...extra
    };
}

function makeFact(): Record<string, unknown> {
    return {
        id: 'fact.0001',
        category: 'family',
        subject: { type: 'character', id: 'char.a' },
        predicate: 'character.spouse',
        object: { type: 'character', id: 'char.b' },
        asOfGameDate: { numeric: 320000 },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'public',
        priority: 10,
        sensitivity: 'personal',
        provenance: { snapshotId: 'snap.0001' }
    };
}

function makeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        protocolVersion: 2,
        operation: 'extract',
        status: 'ok',
        manifest: {
            snapshotId: 'snap.0001',
            sourceFingerprint: 'fp.0123abcd',
            sourceFormat: 'unified_text',
            parserVersion: '0.1.0',
            factSchemaVersion: 1
        },
        entities: [
            { type: 'character', id: 'char.a' },
            { type: 'character', id: 'char.b', displayNameCandidate: { kind: 'literal', value: 'Alice' } }
        ],
        facts: [makeFact()],
        warnings: [],
        metrics: { inputBytes: 1024, durationMs: 12, emittedFacts: 1, emittedEntities: 2 },
        ...overrides
    };
}

/** Push a raw string or a JSON-serialized object (plus trailing newline) and close. */
function respondWith(
    child: FakeChildProcess,
    body: unknown,
    exitCode: number | null = 0,
    exitSignal: NodeJS.Signals | null = null
): void {
    if (body !== null) {
        const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
        child.stdout.emit('data', Buffer.from(text, 'utf8'));
    }
    child.emit('close', exitCode, exitSignal);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SaveParserClient', () => {
    // P5b deferred (verify/session/delta/agency): the 1.x suite also covered
    // the no-I/O capabilities handshake and the fail-closed verify response;
    // both op paths are trimmed from the 2CE client.

    it('returns the validated domain result for a successful extract', async () => {
        const h = makeHarness();
        const request = makeRequest('extract');
        const handle = h.client.start(makeRunOptions(request));

        // Fixed spawn contract.
        expect(h.spawnCalls).toHaveLength(1);
        const call = h.spawnCalls[0];
        expect(call.command).toBe(FAKE_EXE);
        expect(call.options).toEqual({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        expect(call.args).toEqual([
            'extract',
            '--input',
            'C:\\saves\\votc_context.ck3',
            '--allowed-root',
            'C:\\saves',
            '--max-output-bytes',
            '1024'
        ]);

        // The request JSON went over stdin, never into argv, and carries no
        // prompt/user-text fields.
        const payload = h.child.stdin.written.join('');
        expect(JSON.parse(payload)).toEqual(request);
        expect(payload).not.toContain('recentUserText');
        expect(payload).not.toContain('prompt');
        expect(payload).not.toContain('apiKey');
        for (const arg of call.args) {
            expect(arg).not.toContain('"protocolVersion"');
        }
        expect(h.child.stdin.ended).toBe(true);

        respondWith(h.child, makeResponse());
        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.result.operation).toBe('extract');
            expect(outcome.result.status).toBe('ok');
            expect(outcome.result.facts).toHaveLength(1);
            expect(outcome.result.entities).toHaveLength(2);
        }
    });

    it('runs a probe with an ok result and empty collections', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('probe')));
        expect(h.spawnCalls[0].args[0]).toBe('probe');

        respondWith(h.child, makeResponse({ operation: 'probe', entities: [], facts: [] }));
        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.result.operation).toBe('probe');
            expect(outcome.result.facts).toHaveLength(0);
        }
    });

    it('passes a partial status through as a domain result', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, makeResponse({ status: 'partial', warnings: [{ code: 'SAVE_LIMIT_EXCEEDED' }] }));
        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.result.status).toBe('partial');
            expect(outcome.result.warnings).toHaveLength(1);
        }
    });

    it('passes an unsupported status with an error code through as a domain result', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(
            h.child,
            makeResponse({ status: 'unsupported', entities: [], facts: [], error: { code: 'SAVE_BINARY_UNSUPPORTED' } })
        );
        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.result.status).toBe('unsupported');
            expect(outcome.result.error?.code).toBe('SAVE_BINARY_UNSUPPORTED');
        }
    });

    it('returns PARSER_NOT_FOUND when the resolver fails and never spawns', async () => {
        const h = makeHarness({
            resolveResult: { ok: false, kind: 'PARSER_NOT_FOUND', detail: 'missing binary' }
        });
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_NOT_FOUND', detail: 'missing binary' });
        expect(h.spawnCalls).toHaveLength(0);
        expect(h.timer.pending.size).toBe(0);
    });

    it('rejects a request over 64 KiB before spawning', async () => {
        const h = makeHarness();
        const request = makeRequest('extract');
        request.expected.participantCharacterIds = [`char.${'x'.repeat(70000)}`];
        const handle = h.client.start(makeRunOptions(request));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'SAVE_LIMIT_EXCEEDED' });
        expect(h.spawnCalls).toHaveLength(0);
        expect(h.timer.pending.size).toBe(0);
    });

    it('kills the sidecar and returns PARSER_TIMEOUT at the deadline', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        expect(h.timer.pending.size).toBe(1);

        h.timer.fireAll();
        expect(h.child.kill).toHaveBeenCalledTimes(1);

        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_TIMEOUT' });
        expect(h.warnings.some((w) => w.includes('PARSER_TIMEOUT'))).toBe(true);

        // A late close event is inert and cannot change the outcome.
        respondWith(h.child, makeResponse());
        const again = await handle.promise;
        expect(again).toMatchObject({ ok: false, code: 'PARSER_TIMEOUT' });
    });

    it('kills the sidecar and returns START_SUPERSEDED on AbortSignal', async () => {
        const h = makeHarness();
        const controller = new AbortController();
        const handle = h.client.start(makeRunOptions(makeRequest('extract'), { signal: controller.signal }));

        controller.abort();
        expect(h.child.kill).toHaveBeenCalledTimes(1);

        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'START_SUPERSEDED' });
    });

    it('does not spawn at all when the signal is already aborted', async () => {
        const h = makeHarness();
        const controller = new AbortController();
        controller.abort();
        const handle = h.client.start(makeRunOptions(makeRequest('extract'), { signal: controller.signal }));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'START_SUPERSEDED' });
        expect(h.spawnCalls).toHaveLength(0);
    });

    it('kills the sidecar and returns START_SUPERSEDED on cancel()', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        handle.cancel();
        expect(h.child.kill).toHaveBeenCalledTimes(1);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'START_SUPERSEDED' });
    });

    it('returns PARSER_CRASHED on a non-zero exit code', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, null, 2);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_CRASHED' });
        if (!outcome.ok) expect(outcome.detail).toContain('code 2');
    });

    it('returns PARSER_CRASHED on a signal exit', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, null, null, 'SIGTERM');
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_CRASHED' });
    });

    it('returns PARSER_CRASHED when the process emits an error event', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        h.child.emit('error', new Error('spawn ENOENT'));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_CRASHED' });
        expect(h.child.kill).toHaveBeenCalledTimes(1);
    });

    it('returns PARSER_CRASHED when the stdin stream fails', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        h.child.stdin.emit('error', new Error('EPIPE'));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_CRASHED' });
        expect(h.child.kill).toHaveBeenCalledTimes(1);
    });

    it('kills the sidecar and returns PARSER_OUTPUT_LIMIT when stdout exceeds the cap', async () => {
        const h = makeHarness({ limits: { maxStdoutBytes: 16 } });
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        h.child.stdout.emit('data', Buffer.alloc(32, 0x61));
        expect(h.child.kill).toHaveBeenCalledTimes(1);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_LIMIT' });
    });

    it('truncates stderr at the cap, continues the run and logs no content', async () => {
        const h = makeHarness({ limits: { maxStderrBytes: 8 } });
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        h.child.stderr.emit('data', Buffer.alloc(64, 0x61)); // 64 x 'a'
        respondWith(h.child, makeResponse());

        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);
        expect(h.warnings.some((w) => w.includes('stderr exceeded cap'))).toBe(true);
        // No log line ever carries stderr content.
        expect(h.warnings.some((w) => w.includes('aaaa'))).toBe(false);
    });

    it('returns PARSER_OUTPUT_INVALID for invalid JSON', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, 'this is not json');
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('returns PARSER_OUTPUT_INVALID for empty stdout', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, null, 0);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('returns PARSER_OUTPUT_INVALID for multiple JSON documents', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        const doc = JSON.stringify(makeResponse());
        respondWith(h.child, `${doc}\n${doc}\n`);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('returns PARSER_OUTPUT_INVALID for non-UTF-8 stdout', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        h.child.stdout.emit('data', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
        h.child.emit('close', 0, null);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('returns PARSER_PROTOCOL_UNSUPPORTED for a future protocol version', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, makeResponse({ protocolVersion: 3 }));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_PROTOCOL_UNSUPPORTED' });
    });

    it('returns PARSER_OUTPUT_INVALID when the response operation mismatches the request', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, makeResponse({ operation: 'probe', entities: [], facts: [] }));
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('returns PARSER_OUTPUT_INVALID when the response violates the schema whitelist', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        const response = makeResponse();
        delete response['metrics'];
        respondWith(h.child, response);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_OUTPUT_INVALID' });
    });

    it('removes all listeners and clears the timer after the run settles', async () => {
        const h = makeHarness();
        const controller = new AbortController();
        const handle = h.client.start(makeRunOptions(makeRequest('extract'), { signal: controller.signal }));

        respondWith(h.child, makeResponse());
        const outcome = await handle.promise;
        expect(outcome.ok).toBe(true);

        expect(h.child.listenerCount('close')).toBe(0);
        expect(h.child.listenerCount('error')).toBe(0);
        expect(h.child.stdout.listenerCount('data')).toBe(0);
        expect(h.child.stderr.listenerCount('data')).toBe(0);
        expect(h.child.stdin.listenerCount('error')).toBe(0);
        expect(h.timer.pending.size).toBe(0);
        expect(h.timer.cleared).toHaveLength(1);

        // Post-settle events are inert: no extra kill, no changed outcome.
        h.child.emit('close', 1, null);
        controller.abort();
        expect(h.child.kill).not.toHaveBeenCalled();
        const again = await handle.promise;
        expect(again.ok).toBe(true);
    });

    it('cleans up listeners and timer on the failure path too', async () => {
        const h = makeHarness();
        const handle = h.client.start(makeRunOptions(makeRequest('extract')));
        respondWith(h.child, null, 1);
        const outcome = await handle.promise;
        expect(outcome).toMatchObject({ ok: false, code: 'PARSER_CRASHED' });

        expect(h.child.listenerCount('close')).toBe(0);
        expect(h.child.listenerCount('error')).toBe(0);
        expect(h.child.stdout.listenerCount('data')).toBe(0);
        expect(h.child.stderr.listenerCount('data')).toBe(0);
        expect(h.child.stdin.listenerCount('error')).toBe(0);
        expect(h.timer.pending.size).toBe(0);
        expect(h.timer.cleared).toHaveLength(1);
    });
});
