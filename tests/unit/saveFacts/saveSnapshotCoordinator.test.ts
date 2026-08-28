import {
    SaveSnapshotCoordinator,
    SAVE_SNAPSHOT_WARNING_CACHE_WRITE_FAILED,
    SAVE_SNAPSHOT_WARNING_EXTRACT_PARTIAL,
    type SaveSnapshotCoordinatorPrepareOptions
} from '../../../src/main/saveFacts/SaveSnapshotCoordinator';
// P5b deferred (verify/session/delta/agency): 1.x also imported
// resolveSaveFactDeltaTimelineRelation and SaveFactDeltaStoreLike here; both
// are trimmed from the coordinator together with the delta store plumbing.
import type {
    SaveSnapshotWaitOptions,
    SaveSnapshotWaitResult
} from '../../../src/main/saveFacts/SaveSnapshotWaiter';
import type {
    SaveParserRunHandle,
    SaveParserRunOptions,
    SaveParserRunOutcome
} from '../../../src/main/saveFacts/SaveParserClient';
import type { SaveParserPathResult } from '../../../src/main/saveFacts/saveParserPath';
import { buildSaveFactSettings } from '../../../src/main/saveFacts/saveFactSettings';
import { CampaignIdentityUnavailableError } from '../../../src/main/campaignIdentityResolver';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';
import type { GameData } from '../../../src/shared/gameData/GameData';
import { TimelineRegistry } from '../../../src/main/timelineManager';
import {
    createEmptyConversationFactContext
} from '../../../src/main/saveFacts/saveFactTypes';
import type {
    ExtractedGameFactV1,
    SaveFactExtractionResultV1
} from '../../../src/main/saveFacts/saveFactTypes';
import type {
    PersistedSaveFactSnapshotV1,
    SaveFactSnapshotInput
} from '../../../src/main/saveFacts/SaveFactStore';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClock {
    nowMs = 0;
    readonly now = (): number => this.nowMs;
}

interface FakeWaitCall {
    options: SaveSnapshotWaitOptions;
    resolve(result: SaveSnapshotWaitResult): void;
}

/**
 * Queued waiter: every call parks until the test resolves it. Honors the
 * abort signal the way the real waiter does (settle as superseded).
 */
class FakeWaiter {
    readonly calls: FakeWaitCall[] = [];

    readonly wait = jest.fn((options: SaveSnapshotWaitOptions): Promise<SaveSnapshotWaitResult> => {
        return new Promise<SaveSnapshotWaitResult>((resolve) => {
            const call: FakeWaitCall = { options, resolve };
            this.calls.push(call);
            options.signal?.addEventListener('abort', () => {
                resolve({ status: 'superseded', detail: 'wait superseded by a newer snapshot sequence' });
            });
        });
    });

    resolveLast(result: SaveSnapshotWaitResult): void {
        const call = this.calls[this.calls.length - 1];
        if (!call) throw new Error('no waiter call to resolve');
        call.resolve(result);
    }
}

interface FakeParserRun {
    options: SaveParserRunOptions;
    cancel: jest.Mock<void, []>;
    resolve(outcome: SaveParserRunOutcome): void;
}

class FakeParserClient {
    readonly runs: FakeParserRun[] = [];

    readonly start = jest.fn((options: SaveParserRunOptions): SaveParserRunHandle => {
        let resolvePromise!: (outcome: SaveParserRunOutcome) => void;
        const promise = new Promise<SaveParserRunOutcome>((resolve) => {
            resolvePromise = resolve;
        });
        const run: FakeParserRun = {
            options,
            cancel: jest.fn(() => {
                resolvePromise({ ok: false, code: 'START_SUPERSEDED', detail: 'cancelled' });
            }),
            resolve: (outcome) => resolvePromise(outcome)
        };
        this.runs.push(run);
        return { promise, cancel: run.cancel };
    });

    resolveLast(outcome: SaveParserRunOutcome): void {
        const run = this.runs[this.runs.length - 1];
        if (!run) throw new Error('no parser run to resolve');
        run.resolve(outcome);
    }
}

class FakeStore {
    cached: PersistedSaveFactSnapshotV1 | undefined;
    throwOnSave: Error | undefined;
    readonly saved: SaveFactSnapshotInput[] = [];

    readonly findCachedSnapshot = jest.fn((): PersistedSaveFactSnapshotV1 | undefined => this.cached);

    readonly saveCurrent = jest.fn((input: SaveFactSnapshotInput): PersistedSaveFactSnapshotV1 => {
        if (this.throwOnSave) throw this.throwOnSave;
        this.saved.push(input);
        return {} as PersistedSaveFactSnapshotV1;
    });

    readonly scheduleCurrent = jest.fn((input: SaveFactSnapshotInput): boolean => {
        if (this.throwOnSave) throw this.throwOnSave;
        this.saved.push(input);
        return true;
    });

    readonly flushOrDiscardPersistence = jest.fn(async () => ({ flushed: true, discarded: 0 }));
}

class FakeLogger {
    readonly warnings: string[] = [];
    readonly warn = (message: string): void => {
        this.warnings.push(message);
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

const IDENTITY: CampaignPlayerIdentity = {
    protocolSchema: 2,
    campaignSchema: 1,
    campaignId: '1-2-3-4',
    campaignParts: { a: 1, b: 2, c: 3, d: 4 },
    playerId: '12345'
};

const IDENTITY_B: CampaignPlayerIdentity = {
    ...IDENTITY,
    playerId: '999'
};

interface GameDataOverrides {
    sequence?: number;
    playerID?: number;
    extraResult?: GameData['saveSnapshotExtraResult'];
    withGameDate?: boolean;
}

function makeGameData(overrides: GameDataOverrides = {}): GameData {
    const sequence = overrides.sequence ?? 42;
    const withGameDate = overrides.withGameDate !== false;
    return {
        playerID: overrides.playerID ?? 12345,
        aiID: 678,
        votcCheckpointEpoch: 7,
        gameDate: withGameDate
            ? { totalDays: 320000, year: 1100, month: 1, day: 1, display: '1100.1.1' }
            : undefined,
        saveSnapshotExtraResult: overrides.extraResult ?? {
            status: 'available',
            protocolVersion: 1,
            sequence,
            slot: 0
        },
        saveSnapshotSequence: overrides.extraResult === undefined ? sequence : undefined,
        saveSnapshotSlot: overrides.extraResult === undefined ? 0 : undefined,
        characters: new Map<number, unknown>([[12345, {}], [678, {}]])
    } as unknown as GameData;
}

function makeSettings(enabled = true): ReturnType<typeof buildSaveFactSettings> {
    return buildSaveFactSettings({
        saveFacts: { enabled, parserEnabled: true, prepareDeadlineMs: 15000 }
    });
}

function makePrepareOptions(overrides?: Partial<SaveSnapshotCoordinatorPrepareOptions>): SaveSnapshotCoordinatorPrepareOptions {
    return {
        appUserDataDir: '/fake/userData',
        settings: makeSettings(),
        startGeneration: 1,
        ...overrides
    };
}

function makeManifest(): SaveFactExtractionResultV1['manifest'] {
    return {
        snapshotId: 'snap.1',
        sourceFingerprint: 'fp.1',
        sourceFormat: 'unified_text',
        parserVersion: '1.0.0',
        factSchemaVersion: 1
    };
}

type IdentityOverrides = Partial<NonNullable<SaveFactExtractionResultV1['identity']>>;

function makeIdentityBlock(overrides?: IdentityOverrides): NonNullable<SaveFactExtractionResultV1['identity']> {
    return {
        playerCharacterId: '12345',
        gameDateNumeric: 320000,
        gameDateDisplay: '1100.1.1',
        campaignIdParts: [1, 2, 3, 4],
        snapshotSequence: 42,
        snapshotSlot: 0,
        ...overrides
    };
}

function makeProbeResponse(sequence = 42): SaveFactExtractionResultV1 {
    return {
        protocolVersion: 2,
        operation: 'probe',
        status: 'ok',
        manifest: makeManifest(),
        identity: makeIdentityBlock({ snapshotSequence: sequence }),
        entities: [],
        facts: [],
        warnings: [],
        metrics: { inputBytes: 100, durationMs: 5, emittedFacts: 0, emittedEntities: 0 }
    };
}

function makeExtractResponse(
    facts: ExtractedGameFactV1[],
    status: 'ok' | 'partial' = 'ok',
    sequence = 42
): SaveFactExtractionResultV1 {
    return {
        protocolVersion: 2,
        operation: 'extract',
        status,
        manifest: makeManifest(),
        identity: makeIdentityBlock({ snapshotSequence: sequence }),
        entities: [{ type: 'character', id: '12345' }],
        facts,
        warnings: [],
        metrics: { inputBytes: 100, durationMs: 20, emittedFacts: facts.length, emittedEntities: 1 }
    };
}

function makeFact(id = 'fact.1'): ExtractedGameFactV1 {
    return {
        id,
        category: 'family',
        subject: { type: 'character', id: '12345' },
        predicate: 'character.spouse',
        object: { type: 'character', id: '678' },
        asOfGameDate: { numeric: 320000 },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'public',
        priority: 10,
        sensitivity: 'normal',
        provenance: { snapshotId: 'snap.1', campaignId: '1-2-3-4' }
    };
}

function makeCachedRecord(
    facts: ExtractedGameFactV1[],
    extractionStatus: PersistedSaveFactSnapshotV1['extractionStatus'] = 'ok'
): PersistedSaveFactSnapshotV1 {
    return {
        schemaVersion: 1,
        campaignId: '1-2-3-4',
        playerId: '12345',
        checkpoint: {},
        sourceFingerprint: 'fp.1',
        extractionRequestHash: 'hash.1',
        manifest: makeManifest(),
        verifiedIdentity: {
            playerCharacterId: '12345',
            gameDateNumeric: 320000,
            snapshotSequence: 42,
            snapshotSlot: 0
        },
        entities: [],
        facts,
        extractionStatus,
        createdAt: '2026-07-30T00:00:00.000Z',
        parserVersion: '1.0.0',
        factSchemaVersion: 1
    };
}

interface Harness {
    coordinator: SaveSnapshotCoordinator;
    waiter: FakeWaiter;
    parser: FakeParserClient;
    store: FakeStore;
    clock: FakeClock;
    logger: FakeLogger;
    createStore: jest.Mock;
}

function makeHarness(deps?: {
    resolveCampaignIdentity?: (source: { playerID: number }) => CampaignPlayerIdentity;
    resolveParserExecutable?: () => SaveParserPathResult;
}): Harness {
    const waiter = new FakeWaiter();
    const parser = new FakeParserClient();
    const store = new FakeStore();
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const createStore = jest.fn(() => store);
    const coordinator = new SaveSnapshotCoordinator({
        waiter,
        parserClient: parser,
        createStore,
        resolveCampaignIdentity: deps?.resolveCampaignIdentity ?? (() => IDENTITY),
        resolveParserExecutable: deps?.resolveParserExecutable ?? (() => ({
            ok: true,
            executablePath: '/fake/votc-save-facts.exe'
        })),
        getUserFolderPath: () => '/fake/ck3-user',
        clock,
        logger
    });
    return { coordinator, waiter, parser, store, clock, logger, createStore };
}

function makeFailFastSpy(name: string): jest.Mock {
    return jest.fn(() => {
        throw new Error(`G0 unexpected save-facts I/O: ${name}`);
    });
}

function makeZeroIoHarness(): {
    coordinator: SaveSnapshotCoordinator;
    spies: Record<string, jest.Mock>;
} {
    const spies = {
        createStore: makeFailFastSpy('createStore'),
        getTimelineContext: makeFailFastSpy('getTimelineContext'),
        getUserFolderPath: makeFailFastSpy('getUserFolderPath'),
        resolveParserExecutable: makeFailFastSpy('resolveParserExecutable'),
        resolveCampaignIdentity: makeFailFastSpy('resolveCampaignIdentity'),
        waiter: makeFailFastSpy('waiter.wait'),
        parserClient: makeFailFastSpy('parserClient.start')
    };
    const coordinator = new SaveSnapshotCoordinator({
        waiter: { wait: spies.waiter },
        parserClient: { start: spies.parserClient },
        createStore: spies.createStore,
        resolveCampaignIdentity: spies.resolveCampaignIdentity,
        resolveParserExecutable: spies.resolveParserExecutable,
        getUserFolderPath: spies.getUserFolderPath,
        getTimelineContext: spies.getTimelineContext,
        clock: { now: () => 0 }
    });
    return { coordinator, spies };
}

function expectEmptyEarlyContext(
    context: Awaited<ReturnType<SaveSnapshotCoordinator['prepare']>>,
    status: string,
    errorCode?: string
): void {
    expect(context.snapshotStatus).toBe(status);
    expect(context.diagnostics.errorCode).toBe(errorCode);
    expect(context.baselineFacts).toEqual([]);
    expect(context.factIndex).toBeUndefined();
    expect(context.diagnostics.warningCodes).toEqual([]);
    expect(context.diagnostics).not.toHaveProperty('factCount');
}

/**
 * Drive a full successful preparation: resolve the parked waiter with a
 * matched probe, then the parked extract run with the given response.
 */
async function completeSuccessfulFlow(
    harness: Harness,
    extractResponse: SaveFactExtractionResultV1,
    sequence = 42,
    finalProbeResponse: SaveFactExtractionResultV1 = makeProbeResponse(sequence)
): Promise<void> {
    harness.waiter.resolveLast({ status: 'matched', filePath: '/fake/ck3-user/save games/votc_context.ck3', response: makeProbeResponse(sequence) });
    await flush();
    harness.parser.resolveLast({ ok: true, result: extractResponse });
    await flush();
    expect(harness.parser.runs[harness.parser.runs.length - 1].options.request.operation).toBe('probe');
    harness.parser.resolveLast({ ok: true, result: finalProbeResponse });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SaveSnapshotCoordinator', () => {
    describe('§6 G0: non-debug save-facts zero-I/O gate', () => {
        const cases: Array<{
            name: string;
            gameData: GameData;
            settings: ReturnType<typeof makeSettings>;
            status: string;
            errorCode?: string;
        }> = [
            {
                name: 'feature-disabled settings',
                gameData: makeGameData(),
                settings: makeSettings(false),
                status: 'disabled'
            },
            {
                name: 'disabled 0/0/0 tail',
                gameData: makeGameData({ extraResult: { status: 'disabled' } }),
                settings: makeSettings(),
                status: 'disabled'
            },
            {
                name: 'legacy tail',
                gameData: makeGameData({ extraResult: { status: 'legacy' } }),
                settings: makeSettings(),
                status: 'unavailable'
            },
            {
                name: 'unsupported tail',
                gameData: makeGameData({ extraResult: { status: 'unsupported', protocolVersion: 2 } }),
                settings: makeSettings(),
                status: 'unsupported',
                errorCode: 'SAVE_VERSION_UNSUPPORTED'
            },
            {
                name: 'truncated tail',
                gameData: makeGameData({ extraResult: { status: 'truncated', expected: 6, actual: 3 } }),
                settings: makeSettings(),
                status: 'failed',
                errorCode: 'SAVE_TRUNCATED'
            },
            {
                name: 'invalid tail',
                gameData: makeGameData({ extraResult: { status: 'invalid', reason: 'bad tail' } }),
                settings: makeSettings(),
                status: 'failed',
                errorCode: 'SAVE_PARSE_FAILED'
            }
        ];

        for (const testCase of cases) {
            it(`returns ${testCase.status} for ${testCase.name} without any save-facts I/O`, async () => {
                const harness = makeZeroIoHarness();
                const context = await harness.coordinator.prepare(
                    testCase.gameData,
                    makePrepareOptions({ settings: testCase.settings })
                );

                expectEmptyEarlyContext(context, testCase.status, testCase.errorCode);
                for (const spy of Object.values(harness.spies)) {
                    expect(spy).not.toHaveBeenCalled();
                }
            });
        }
    });

    describe('early exits (plan step 2)', () => {
        it('returns disabled when the parser feature is off, without waiting', async () => {
            const harness = makeHarness();
            const context = await harness.coordinator.prepare(
                makeGameData(),
                makePrepareOptions({ settings: makeSettings(false) })
            );
            expect(context.snapshotStatus).toBe('disabled');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns unavailable for a legacy mod snapshot tail, without waiting', async () => {
            const harness = makeHarness();
            const context = await harness.coordinator.prepare(
                makeGameData({ extraResult: { status: 'legacy' } }),
                makePrepareOptions()
            );
            expect(context.snapshotStatus).toBe('unavailable');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns unsupported for an unsupported snapshot protocol, without waiting', async () => {
            const harness = makeHarness();
            const context = await harness.coordinator.prepare(
                makeGameData({ extraResult: { status: 'unsupported', protocolVersion: 2 } }),
                makePrepareOptions()
            );
            expect(context.snapshotStatus).toBe('unsupported');
            expect(context.diagnostics.errorCode).toBe('SAVE_VERSION_UNSUPPORTED');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns unavailable when the numeric game date is missing, without waiting', async () => {
            const harness = makeHarness();
            const context = await harness.coordinator.prepare(
                makeGameData({ withGameDate: false }),
                makePrepareOptions()
            );
            expect(context.snapshotStatus).toBe('unavailable');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns mismatch for an invalid campaign identity and never falls back to a player-only cache', async () => {
            const harness = makeHarness({
                resolveCampaignIdentity: () => {
                    throw new CampaignIdentityUnavailableError('invalid', 'bad campaign tail');
                }
            });
            const context = await harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            expect(context.snapshotStatus).toBe('mismatch');
            expect(context.diagnostics.errorCode).toBe('SAVE_CAMPAIGN_MISMATCH');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns unavailable when the sidecar is missing, without waiting', async () => {
            const harness = makeHarness({
                resolveParserExecutable: () => ({ ok: false, kind: 'PARSER_NOT_FOUND', detail: 'not found' })
            });
            const context = await harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            expect(context.snapshotStatus).toBe('unavailable');
            expect(context.diagnostics.errorCode).toBe('PARSER_NOT_FOUND');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });

        it('returns unsupported when the platform cannot host the sidecar', async () => {
            const harness = makeHarness({
                resolveParserExecutable: () => ({ ok: false, kind: 'unsupported', detail: 'linux-arm64' })
            });
            const context = await harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            expect(context.snapshotStatus).toBe('unsupported');
            expect(harness.waiter.wait).not.toHaveBeenCalled();
        });
    });

    describe('happy path (plan steps 4-6)', () => {
        it('waits, extracts and returns an immutable available context (old-sequence repoll is internal to the waiter)', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);
            expect(harness.waiter.calls[0].options.expected.snapshotSequence).toBe(42);

            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const context = await promise;

            expect(context.snapshotStatus).toBe('available');
            expect(context.snapshot?.snapshotId).toBe('snap.1');
            expect(context.baselineFacts).toHaveLength(1);
            expect(context.baselineFacts[0].source).toBe('save_snapshot');
            expect(context.baselineFacts[0].provenance.checkpointEpoch).toBe(7);
            expect(Object.isFrozen(context)).toBe(true);
            expect(Object.isFrozen(context.baselineFacts)).toBe(true);
            expect(Object.isFrozen(context.baselineFacts[0])).toBe(true);
            expect(Object.isFrozen(context.snapshot)).toBe(true);
            expect(Object.isFrozen(context.diagnostics.warningCodes)).toBe(true);

            // The extract run answered the expected identity and the derived
            // cache was written.
            expect(harness.parser.runs[0].options.request.operation).toBe('extract');
            expect(harness.parser.runs[0].options.request.expected.playerCharacterId).toBe('12345');
            expect(harness.store.scheduleCurrent).toHaveBeenCalledTimes(1);
            expect(harness.coordinator.pendingTaskCount).toBe(0);
        });

        it('serves a verified cache hit without running extract', async () => {
            const harness = makeHarness();
            harness.store.cached = makeCachedRecord([makeFact('fact.cached')]);
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            harness.waiter.resolveLast({
                status: 'matched',
                filePath: '/fake/ck3-user/save games/votc_context.ck3',
                response: makeProbeResponse()
            });
            const context = await promise;

            expect(context.snapshotStatus).toBe('available');
            expect(context.baselineFacts).toHaveLength(1);
            expect(context.baselineFacts[0].id).toBe('fact.cached');
            expect(harness.parser.start).not.toHaveBeenCalled();
            expect(harness.store.scheduleCurrent).not.toHaveBeenCalled();
        });

        it('runs extract on a cache miss and persists the derived cache', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact(), makeFact('fact.2')]));
            const context = await promise;

            expect(context.snapshotStatus).toBe('available');
            expect(context.baselineFacts).toHaveLength(2);
            expect(harness.store.findCachedSnapshot).toHaveBeenCalledTimes(1);
            expect(harness.store.scheduleCurrent).toHaveBeenCalledTimes(1);
            expect(harness.store.saved[0].facts).toHaveLength(2);
            expect(harness.store.saved[0].verifiedIdentity.snapshotSequence).toBe(42);
            expect(harness.store.saved[0].extractionStatus).toBe('ok');
        });

        it('accepts a partial extract with a warning code', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()], 'partial'));
            const context = await promise;

            expect(context.snapshotStatus).toBe('available');
            expect(context.baselineFacts).toHaveLength(1);
            expect(context.diagnostics.warningCodes).toContain(SAVE_SNAPSHOT_WARNING_EXTRACT_PARTIAL);
            expect(harness.store.saved[0].extractionStatus).toBe('partial');
        });

        // P5b deferred (verify/session/delta/agency): the 1.x suite also ran
        // 'keeps a cached partial extract behind the delta taint barrier',
        // which required the trimmed delta store plumbing.
        it('reuses one persistence store/FIFO for successive snapshots in the same scope', async () => {
            const harness = makeHarness();
            const first = harness.coordinator.prepare(makeGameData({ sequence: 42 }), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()], 'ok', 42), 42);
            await first;

            const second = harness.coordinator.prepare(makeGameData({ sequence: 43 }), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact('fact.43')], 'ok', 43), 43);
            await second;

            expect(harness.createStore).toHaveBeenCalledTimes(1);
            expect(harness.coordinator.persistenceScopeCount).toBe(1);
            expect(harness.store.scheduleCurrent).toHaveBeenCalledTimes(2);
        });

        it('boundedly flushes scope queues on shutdown and rejects later preparation', async () => {
            const harness = makeHarness();
            const pending = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            await pending;

            await expect(harness.coordinator.shutdownPersistence(Date.now() + 1000))
                .resolves.toEqual({ flushed: true, discarded: 0 });
            expect(harness.store.flushOrDiscardPersistence).toHaveBeenCalledTimes(1);

            const afterShutdown = await harness.coordinator.prepare(makeGameData({ sequence: 43 }), makePrepareOptions());
            expect(afterShutdown.snapshotStatus).toBe('superseded');
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);
        });
    });

    describe('failure convergence (plan step 7)', () => {
        it('maps a waiter timeout to the timeout status', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            harness.waiter.resolveLast({ status: 'timeout', detail: 'never stabilized' });
            const context = await promise;
            expect(context.snapshotStatus).toBe('timeout');
            expect(harness.parser.start).not.toHaveBeenCalled();
        });

        it('maps a missing snapshot file to unavailable/SAVE_NOT_FOUND', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            harness.waiter.resolveLast({ status: 'not_found', detail: 'never appeared' });
            const context = await promise;
            expect(context.snapshotStatus).toBe('unavailable');
            expect(context.diagnostics.errorCode).toBe('SAVE_NOT_FOUND');
        });

        it('maps a parser crash to failed/PARSER_CRASHED without rejecting', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            harness.waiter.resolveLast({
                status: 'matched',
                filePath: '/fake/ck3-user/save games/votc_context.ck3',
                response: makeProbeResponse()
            });
            await flush();
            harness.parser.resolveLast({ ok: false, code: 'PARSER_CRASHED', detail: 'exit code 1' });
            const context = await promise;
            expect(context.snapshotStatus).toBe('failed');
            expect(context.diagnostics.errorCode).toBe('PARSER_CRASHED');
        });

        it('rejects an identity-equivalent replacement between probe and extract', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            harness.waiter.resolveLast({
                status: 'matched',
                filePath: '/fake/ck3-user/save games/votc_context.ck3',
                response: makeProbeResponse()
            });
            await flush();
            const replaced = makeExtractResponse([makeFact()]);
            replaced.manifest = { ...replaced.manifest, sourceFingerprint: 'fp.replaced' };
            harness.parser.resolveLast({ ok: true, result: replaced });

            const context = await promise;
            expect(context.snapshotStatus).toBe('mismatch');
            expect(context.diagnostics.errorCode).toBe('SAVE_IDENTITY_MISMATCH');
            expect(harness.parser.runs).toHaveLength(1);
            expect(harness.store.scheduleCurrent).not.toHaveBeenCalled();
        });

        it('rejects a same-identity replacement found by the final post-extract probe', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            const finalProbe = makeProbeResponse();
            finalProbe.manifest = { ...finalProbe.manifest, sourceFingerprint: 'fp.final-replacement' };
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]), 42, finalProbe);

            const context = await promise;
            expect(context.snapshotStatus).toBe('mismatch');
            expect(context.diagnostics.errorCode).toBe('SAVE_IDENTITY_MISMATCH');
            expect(harness.store.scheduleCurrent).not.toHaveBeenCalled();
        });

        it('fails open when an unexpected error escapes the pipeline', async () => {
            const harness = makeHarness();
            harness.waiter.wait.mockImplementationOnce(() => {
                throw new Error('programmer invariant');
            });
            const context = await harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            expect(context.snapshotStatus).toBe('failed');
            expect(context.diagnostics.errorCode).toBe('SAVE_PARSE_FAILED');
        });

        it('keeps verified facts in memory when the cache write fails, with a warning', async () => {
            const harness = makeHarness();
            harness.store.throwOnSave = new Error('disk full');
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const context = await promise;

            expect(context.snapshotStatus).toBe('available');
            expect(context.baselineFacts).toHaveLength(1);
            expect(context.diagnostics.warningCodes).toContain(SAVE_SNAPSHOT_WARNING_CACHE_WRITE_FAILED);
            expect(harness.logger.warnings.some(message => message.includes('cache write failed'))).toBe(true);
        });
    });

    describe('concurrency: dedup, preemption, serialization (plan step 3)', () => {
        it('coalesces two prepares with the same task key into one pipeline run', async () => {
            const harness = makeHarness();
            const p1 = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            const p2 = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const [c1, c2] = await Promise.all([p1, p2]);
            expect(c1).toBe(c2);
            expect(harness.parser.start).toHaveBeenCalledTimes(2);
        });

        it('starts a fresh same-key task when the first caller signal was aborted', async () => {
            const harness = makeHarness();
            const firstController = new AbortController();
            const first = harness.coordinator.prepare(
                makeGameData(),
                makePrepareOptions({ signal: firstController.signal })
            );
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            firstController.abort();
            const second = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            const firstContext = await first;
            expect(firstContext.snapshotStatus).toBe('superseded');

            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(2);
            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const secondContext = await second;
            expect(secondContext.snapshotStatus).toBe('available');
            expect(harness.coordinator.pendingTaskCount).toBe(0);
        });

        it('a higher sequence preempts the stale task, which settles as superseded', async () => {
            const harness = makeHarness();
            const stale = harness.coordinator.prepare(makeGameData({ sequence: 42 }), makePrepareOptions());
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            const newer = harness.coordinator.prepare(makeGameData({ sequence: 43 }), makePrepareOptions());
            const staleContext = await stale;
            expect(staleContext.snapshotStatus).toBe('superseded');
            expect(staleContext.diagnostics.errorCode).toBe('START_SUPERSEDED');

            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(2);
            expect(harness.waiter.calls[1].options.expected.snapshotSequence).toBe(43);

            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()], 'ok', 43), 43);
            const newerContext = await newer;
            expect(newerContext.snapshotStatus).toBe('available');
            expect(harness.coordinator.pendingTaskCount).toBe(0);
        });

        it('a lower sequence is answered with superseded without any file work', async () => {
            const harness = makeHarness();
            const inFlight = harness.coordinator.prepare(makeGameData({ sequence: 42 }), makePrepareOptions());
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            const staleContext = await harness.coordinator.prepare(
                makeGameData({ sequence: 41 }),
                makePrepareOptions()
            );
            expect(staleContext.snapshotStatus).toBe('superseded');
            expect(staleContext.diagnostics.errorCode).toBe('START_SUPERSEDED');
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const context = await inFlight;
            expect(context.snapshotStatus).toBe('available');
        });

        it('serializes preparations of different players through the single-process queue', async () => {
            const harness = makeHarness({
                resolveCampaignIdentity: (source) => (source.playerID === 999 ? IDENTITY_B : IDENTITY)
            });
            const first = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            const second = harness.coordinator.prepare(
                makeGameData({ playerID: 999 }),
                makePrepareOptions()
            );
            await flush();
            // The second player's task must not start its wait while the
            // first is still running.
            expect(harness.waiter.wait).toHaveBeenCalledTimes(1);

            await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
            const firstContext = await first;
            expect(firstContext.snapshotStatus).toBe('available');

            await flush();
            expect(harness.waiter.wait).toHaveBeenCalledTimes(2);
            expect(harness.waiter.calls[1].options.expected.playerCharacterId).toBe('999');

            const secondExtract = makeExtractResponse([makeFact()]);
            secondExtract.identity = makeIdentityBlock({ playerCharacterId: '999' });
            const secondFinalProbe = makeProbeResponse();
            secondFinalProbe.identity = makeIdentityBlock({ playerCharacterId: '999' });
            await completeSuccessfulFlow(harness, secondExtract, 42, secondFinalProbe);
            const secondContext = await second;
            expect(secondContext.snapshotStatus).toBe('available');
            expect(harness.coordinator.pendingTaskCount).toBe(0);
        });

        it('cleans the task map after a task settles (no leak)', async () => {
            const harness = makeHarness();
            const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
            await flush();
            expect(harness.coordinator.pendingTaskCount).toBe(1);
            await completeSuccessfulFlow(harness, makeExtractResponse([]));
            await promise;
            expect(harness.coordinator.pendingTaskCount).toBe(0);
        });
    });
});

// P5b deferred (verify/session/delta/agency): the 1.x suite also ran the
// 'resolveSaveFactDeltaTimelineRelation' describe block; the helper is
// trimmed from the coordinator together with the delta store plumbing.

describe('joinCandidates context threading (Plan C Task 3A)', () => {
    it('threads extract joinCandidates into the available context and the persisted input', async () => {
        const harness = makeHarness();
        const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
        await flush();
        const extractResponse = {
            ...makeExtractResponse([makeFact()]),
            joinCandidates: ['13206', '33435']
        };
        await completeSuccessfulFlow(harness, extractResponse);
        const context = await promise;

        expect(context.snapshotStatus).toBe('available');
        expect(context.joinCandidates).toEqual(['13206', '33435']);
        expect(Object.isFrozen(context.joinCandidates)).toBe(true);
        expect(harness.store.saved[0].joinCandidates).toEqual(['13206', '33435']);
    });

    it('leaves joinCandidates absent on a fresh extract without them', async () => {
        const harness = makeHarness();
        const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
        await flush();
        await completeSuccessfulFlow(harness, makeExtractResponse([makeFact()]));
        const context = await promise;

        expect(context.snapshotStatus).toBe('available');
        expect(context.joinCandidates).toBeUndefined();
    });

    it('threads cached joinCandidates into the available context on a cache hit', async () => {
        const harness = makeHarness();
        harness.store.cached = {
            ...makeCachedRecord([makeFact('fact.cached')]),
            joinCandidates: ['777', '888']
        };
        const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
        await flush();
        harness.waiter.resolveLast({
            status: 'matched',
            filePath: '/fake/ck3-user/save games/votc_context.ck3',
            response: makeProbeResponse()
        });
        const context = await promise;

        expect(context.snapshotStatus).toBe('available');
        expect(context.joinCandidates).toEqual(['777', '888']);
        expect(harness.parser.start).not.toHaveBeenCalled();
    });

    it('keeps joinCandidates absent on a legacy cache hit (fail-closed)', async () => {
        const harness = makeHarness();
        harness.store.cached = makeCachedRecord([makeFact('fact.cached')]);
        const promise = harness.coordinator.prepare(makeGameData(), makePrepareOptions());
        await flush();
        harness.waiter.resolveLast({
            status: 'matched',
            filePath: '/fake/ck3-user/save games/votc_context.ck3',
            response: makeProbeResponse()
        });
        const context = await promise;

        expect(context.snapshotStatus).toBe('available');
        expect(context.joinCandidates).toBeUndefined();
    });

    it('never puts joinCandidates on the empty/degraded context', async () => {
        const context = createEmptyConversationFactContext('unavailable', 'SAVE_NOT_FOUND');
        expect(context).not.toHaveProperty('joinCandidates');
    });
});
