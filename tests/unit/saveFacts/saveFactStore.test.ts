jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => '') }
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildIdentityFromParts } from '../../../src/shared/gameData/CampaignIdentity';
import { CampaignPathError } from '../../../src/main/campaignDataPaths';
import {
    saveFactsCurrentPath,
    saveFactsDir,
    saveFactsEntityNamesPath,
    saveFactsSnapshotsDir
} from '../../../src/main/campaignDataPaths';
import { TimelineRegistry } from '../../../src/main/timelineManager';
import {
    assertSaveFactsContainment,
    computeExtractionRequestHash,
    looksLikeRawLocKey,
    SaveFactStore,
    SaveFactStoreError,
    validatePersistedSaveFactSnapshot
} from '../../../src/main/saveFacts/SaveFactStore';
import type {
    SaveFactCacheRequestKey,
    SaveFactSnapshotInput
} from '../../../src/main/saveFacts/SaveFactStore';
import type { ExtractedGameFactV1 } from '../../../src/main/saveFacts/saveFactTypes';

const NOW = '2026-08-05T00:00:00Z';

const IDENTITY = buildIdentityFromParts({ a: 1, b: 2, c: 3, d: 4 }, 'player-1001');
const SAME_CAMPAIGN_OTHER_PLAYER = buildIdentityFromParts({ a: 1, b: 2, c: 3, d: 4 }, 'player-2002');
const OTHER_CAMPAIGN = buildIdentityFromParts({ a: 9, b: 8, c: 7, d: 6 }, 'player-1001');

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-savefacts-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLimits(): SaveFactCacheRequestKey['limits'] {
    return {
        maxFacts: 100,
        maxEntities: 50,
        maxRelatedCharacters: 20,
        maxOutputBytes: 65536,
        maxDecompressedBytes: 1048576,
        maxNestingDepth: 8,
        maxScalarBytes: 1024
    };
}

function makeKey(overrides: Partial<SaveFactCacheRequestKey> = {}): SaveFactCacheRequestKey {
    return {
        sourceFingerprint: 'fp-abc123',
        parserVersion: '1.0.0',
        factSchemaVersion: 1,
        participantCharacterIds: ['char-1', 'char-2'],
        categories: ['identity', 'family'],
        limits: makeLimits(),
        campaignId: IDENTITY.campaignId,
        playerCharacterId: 'char-player',
        gameDateNumeric: 402123,
        snapshotSequence: 3,
        snapshotSlot: 0,
        ...overrides
    };
}

function makeFact(id: string, snapshotId: string): ExtractedGameFactV1 {
    return {
        id,
        category: 'family',
        subject: { type: 'character', id: 'char-1' },
        predicate: 'character.spouse',
        object: { type: 'character', id: 'char-2' },
        asOfGameDate: { numeric: 402123, display: '1100.1.1' },
        source: 'save_snapshot',
        sourcePath: 'character_spouse',
        confidence: 'exact',
        visibility: 'public',
        priority: 10,
        sensitivity: 'normal',
        provenance: { snapshotId, campaignId: IDENTITY.campaignId }
    };
}

function makeInput(
    key: SaveFactCacheRequestKey,
    overrides: Partial<SaveFactSnapshotInput> = {},
    snapshotId = 'snap-1'
): SaveFactSnapshotInput {
    const base: SaveFactSnapshotInput = {
        requestKey: key,
        manifest: {
            snapshotId,
            sourceFingerprint: key.sourceFingerprint,
            sourceFormat: 'zip_text',
            ck3Version: '1.12.1',
            parserVersion: key.parserVersion,
            factSchemaVersion: 1
        },
        verifiedIdentity: {
            playerCharacterId: key.playerCharacterId,
            gameDateNumeric: key.gameDateNumeric,
            gameDateDisplay: '1100.1.1',
            campaignIdParts: [1, 2, 3, 4],
            snapshotSequence: key.snapshotSequence,
            snapshotSlot: key.snapshotSlot
        },
        entities: [
            { type: 'character', id: 'char-1', displayNameCandidate: { kind: 'literal', value: 'Alice' } },
            { type: 'character', id: 'char-2' }
        ],
        facts: [makeFact('fact-1', snapshotId)],
        extractionStatus: 'ok',
        checkpoint: {}
    };
    return { ...base, ...overrides };
}

function makeRegistry(): { registry: TimelineRegistry; root: string; left: string; right: string; leftChild: string } {
    const registry = new TimelineRegistry('player-1001');
    const root = registry.getOrCreateChild(null, 'conversation', 'root', 1, NOW);
    const left = registry.getOrCreateChild(root, 'conversation', 'left', 2, NOW);
    const right = registry.getOrCreateChild(root, 'conversation', 'right', 2, NOW);
    const leftChild = registry.getOrCreateChild(left, 'conversation', 'left-child', 3, NOW);
    return { registry, root, left, right, leftChild };
}

describe('campaign/player isolation', () => {
    it('a record saved under one identity is missing for other players and campaigns', () => {
        const key = makeKey();
        const storeA = new SaveFactStore(tmpDir, IDENTITY);
        storeA.saveCurrent(makeInput(key));

        expect(storeA.loadCurrent().status).toBe('ok');
        expect(new SaveFactStore(tmpDir, SAME_CAMPAIGN_OTHER_PLAYER).loadCurrent().status).toBe('missing');
        expect(new SaveFactStore(tmpDir, OTHER_CAMPAIGN).loadCurrent().status).toBe('missing');
        expect(new SaveFactStore(tmpDir, SAME_CAMPAIGN_OTHER_PLAYER).findCachedSnapshot(key)).toBeUndefined();
    });

    it('records carry the campaign/player of their namespace, never raw save paths or prompts', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const record = store.saveCurrent(makeInput(makeKey()));
        expect(record.campaignId).toBe(IDENTITY.campaignId);
        expect(record.playerId).toBe(IDENTITY.playerId);
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain('save games');
        expect(serialized).not.toContain('.ck3');
    });
});

describe('shared asynchronous persistence FIFO', () => {
    it('makes a scheduled current snapshot available in memory before disk and flushes it atomically', async () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const key = makeKey();

        expect(store.scheduleCurrent(makeInput(key), { diagnosticsEnabled: false }, Date.now() + 1000)).toBe(true);
        expect(fs.existsSync(saveFactsCurrentPath(tmpDir, IDENTITY))).toBe(false);
        expect(store.findCachedSnapshot(key)?.manifest.snapshotId).toBe('snap-1');

        await expect(store.flushOrDiscardPersistence(1000)).resolves.toEqual({ flushed: true, discarded: 0 });
        expect(store.loadCurrent().status).toBe('ok');
    });

    it('serializes current and entity-name writes on the same scope queue', async () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const key = makeKey();

        expect(store.scheduleCurrent(makeInput(key), undefined, Date.now() + 1000)).toBe(true);
        expect(store.scheduleEntityNameUpdate([
            { entityType: 'character', id: 'char-1', displayName: 'Alice', source: 'verified_literal' }
        ], undefined, Date.now() + 1000)).toBe(true);

        await store.flushOrDiscardPersistence(1000);
        expect(store.loadCurrent().status).toBe('ok');
        expect(store.resolveEntityName('character', 'char-1')).toBe('Alice');
    });
});

describe('timeline visibility (step 5)', () => {
    it('a snapshot recorded on one branch is visible from itself and descendants but not from siblings', () => {
        const { registry, left, right, leftChild } = makeRegistry();
        const key = makeKey();
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(key, { checkpoint: { timelineNodeId: left, checkpointEpoch: 2 } }));

        expect(store.findCachedSnapshot(key, { registry, currentNodeId: left, checkpointEpoch: 2 })).toBeDefined();
        expect(store.findCachedSnapshot(key, { registry, currentNodeId: leftChild, checkpointEpoch: 3 })).toBeDefined();
        // Sibling branch must never see this snapshot.
        expect(store.findCachedSnapshot(key, { registry, currentNodeId: right, checkpointEpoch: 2 })).toBeUndefined();
        // Without a resolvable context a node-stamped record is not visible.
        expect(store.findCachedSnapshot(key)).toBeUndefined();
        expect(store.findCachedSnapshot(key, { checkpointEpoch: 9 })).toBeUndefined();
    });

    it('a snapshot recorded on the current branch is not visible from a descendant-orphaned context and epoch-only records respect the epoch ceiling', () => {
        const key = makeKey();
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(key, { checkpoint: { checkpointEpoch: 5 } }));

        expect(store.findCachedSnapshot(key, { checkpointEpoch: 7 })).toBeDefined();
        expect(store.findCachedSnapshot(key, { checkpointEpoch: 5 })).toBeDefined();
        expect(store.findCachedSnapshot(key, { checkpointEpoch: 3 })).toBeUndefined();
    });
});

describe('atomic write (step 3)', () => {
    it('a failed write keeps the previous current.json intact', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey(), {}, 'snap-old'));

        // Force writeJsonAtomic to fail: the tmp path is an existing directory.
        const tmpPath = `${saveFactsCurrentPath(tmpDir, IDENTITY)}.tmp`;
        fs.mkdirSync(tmpPath);

        expect(() => store.saveCurrent(makeInput(makeKey(), {}, 'snap-new'))).toThrow();

        fs.rmSync(tmpPath, { recursive: true, force: true });

        const loaded = store.loadCurrent();
        expect(loaded.status).toBe('ok');
        if (loaded.status === 'ok') {
            expect(loaded.record.manifest.snapshotId).toBe('snap-old');
        }
    });

    it('rejects path-unsafe identities instead of writing outside the namespace', () => {
        const unsafe = buildIdentityFromParts({ a: 1, b: 2, c: 3, d: 4 }, '..');
        const store = new SaveFactStore(tmpDir, unsafe);
        expect(() => store.saveCurrent(makeInput(makeKey()))).toThrow(CampaignPathError);
    });
});

describe('path containment (step 3)', () => {
    it('accepts files inside the save_facts dir and rejects escapes', () => {
        const base = saveFactsDir(tmpDir, IDENTITY);
        expect(() => assertSaveFactsContainment(base, path.join(base, 'current.json'))).not.toThrow();
        expect(() => assertSaveFactsContainment(base, path.join(base, 'snapshots', 'x.json'))).not.toThrow();
        expect(() => assertSaveFactsContainment(base, path.join(base, '..', 'evil.json')))
            .toThrow(SaveFactStoreError);
        expect(() => assertSaveFactsContainment(base, path.join(tmpDir, 'evil.json')))
            .toThrow(SaveFactStoreError);
        expect(() => assertSaveFactsContainment(base, base)).toThrow(SaveFactStoreError);
        try {
            assertSaveFactsContainment(base, path.join(base, '..', '..', 'evil.json'));
            throw new Error('expected PATH_ESCAPE');
        } catch (error) {
            expect(error).toBeInstanceOf(SaveFactStoreError);
            expect((error as SaveFactStoreError).code).toBe('PATH_ESCAPE');
        }
    });
});

describe('corrupt cache quarantine (step 6)', () => {
    it('quarantines unparseable JSON to .corrupt.<timestamp> and never reports it as an empty success', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey()));

        const currentPath = saveFactsCurrentPath(tmpDir, IDENTITY);
        fs.writeFileSync(currentPath, 'not json {', 'utf8');

        const loaded = store.loadCurrent();
        expect(loaded.status).toBe('corrupt');
        if (loaded.status === 'corrupt') {
            expect(loaded.quarantinePath).toBeDefined();
            const quarantinePath = loaded.quarantinePath as string;
            expect(path.basename(quarantinePath)).toMatch(/^current\.json\.corrupt\./);
            expect(fs.readFileSync(quarantinePath, 'utf8')).toBe('not json {');
        }
        // The original is removed so a later write can recreate it; the next
        // load is a plain miss, not a success.
        expect(fs.existsSync(currentPath)).toBe(false);
        expect(store.loadCurrent().status).toBe('missing');
        expect(store.findCachedSnapshot(makeKey())).toBeUndefined();
    });

    it('quarantines schema-invalid JSON (whitelist violation) as corrupt', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey()));

        const currentPath = saveFactsCurrentPath(tmpDir, IDENTITY);
        fs.writeFileSync(currentPath, JSON.stringify({ schemaVersion: 1, unexpected: true }), 'utf8');

        const loaded = store.loadCurrent();
        expect(loaded.status).toBe('corrupt');
        expect(fs.existsSync(currentPath)).toBe(false);
    });

    it('quarantines a record whose identity does not match its directory', () => {
        const storeA = new SaveFactStore(tmpDir, IDENTITY);
        storeA.saveCurrent(makeInput(makeKey()));

        // Hand-move the record into another player's namespace.
        const storeB = new SaveFactStore(tmpDir, SAME_CAMPAIGN_OTHER_PLAYER);
        const sourcePath = saveFactsCurrentPath(tmpDir, IDENTITY);
        const targetPath = saveFactsCurrentPath(tmpDir, SAME_CAMPAIGN_OTHER_PLAYER);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);

        const loaded = storeB.loadCurrent();
        expect(loaded.status).toBe('corrupt');
        if (loaded.status === 'corrupt') {
            expect(loaded.reason).toContain('identity');
        }
    });
});

describe('cache key (step 4)', () => {
    it('hits only when every component matches', () => {
        const key = makeKey();
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(key));

        expect(store.findCachedSnapshot(key)).toBeDefined();

        // Order-insensitive components still hit.
        expect(store.findCachedSnapshot(makeKey({
            participantCharacterIds: ['char-2', 'char-1'],
            categories: ['family', 'identity']
        }))).toBeDefined();

        const misses: Array<[string, Partial<SaveFactCacheRequestKey>]> = [
            ['participant subset', { participantCharacterIds: ['char-1'] }],
            ['different participant', { participantCharacterIds: ['char-1', 'char-3'] }],
            ['extra participant', { participantCharacterIds: ['char-1', 'char-2', 'char-3'] }],
            ['categories', { categories: ['identity'] }],
            ['limits', { limits: { ...makeLimits(), maxFacts: 99 } }],
            ['source fingerprint', { sourceFingerprint: 'fp-other' }],
            ['parser version', { parserVersion: '1.0.1' }],
            ['game date', { gameDateNumeric: 402124 }],
            ['snapshot sequence', { snapshotSequence: 4 }],
            ['snapshot slot', { snapshotSlot: 1 }],
            ['player character', { playerCharacterId: 'char-other' }],
            ['campaign', { campaignId: OTHER_CAMPAIGN.campaignId }]
        ];
        for (const [label, override] of misses) {
            expect(store.findCachedSnapshot(makeKey(override))).toBeUndefined();
        }
    });

    it('produces a stable hash regardless of array order and key insertion order', () => {
        const a = computeExtractionRequestHash(makeKey());
        const b = computeExtractionRequestHash(makeKey({
            participantCharacterIds: ['char-2', 'char-1'],
            categories: ['family', 'identity']
        }));
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('retention (step 6)', () => {
    it('default mode maintains current.json only, no snapshots', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey(), {}, 'snap-1'));
        store.saveCurrent(makeInput(makeKey(), {}, 'snap-2'));

        expect(fs.existsSync(saveFactsCurrentPath(tmpDir, IDENTITY))).toBe(true);
        expect(fs.existsSync(saveFactsSnapshotsDir(tmpDir, IDENTITY))).toBe(false);
    });

    it('diagnostics mode keeps the newest 3 derived snapshots and never touches foreign or invalid files', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const key = makeKey();
        for (let i = 1; i <= 5; i++) {
            store.saveCurrent(makeInput(key, {}, `snap-${i}`), { diagnosticsEnabled: true });
        }

        const snapshotsDir = saveFactsSnapshotsDir(tmpDir, IDENTITY);
        // Foreign file and a file that matches the VOTC naming but not the schema.
        fs.writeFileSync(path.join(snapshotsDir, 'notes.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(snapshotsDir, 'snapshot-99999999999999999-notvotc.json'), 'garbage', 'utf8');
        // A file outside the save_facts namespace entirely.
        const saveGamesDir = path.join(tmpDir, 'save games');
        fs.mkdirSync(saveGamesDir, { recursive: true });
        fs.writeFileSync(path.join(saveGamesDir, 'keep.ck3'), 'real save', 'utf8');

        store.pruneSnapshots(3);

        const remaining = fs.readdirSync(snapshotsDir).sort();
        expect(remaining).toHaveLength(5);
        expect(remaining.some(name => name.includes('snap-5'))).toBe(true);
        expect(remaining.some(name => name.includes('snap-4'))).toBe(true);
        expect(remaining.some(name => name.includes('snap-3'))).toBe(true);
        expect(remaining.some(name => name.includes('snap-1'))).toBe(false);
        expect(remaining.some(name => name.includes('snap-2'))).toBe(false);
        // Foreign and schema-invalid files survive retention.
        expect(remaining).toContain('notes.json');
        expect(remaining).toContain('snapshot-99999999999999999-notvotc.json');
        // Nothing outside save_facts/snapshots is touched.
        expect(fs.readFileSync(path.join(saveGamesDir, 'keep.ck3'), 'utf8')).toBe('real save');
    });

    it('listVisibleSnapshots filters sibling-branch records out of the current context', () => {
        const { registry, left, right } = makeRegistry();
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const key = makeKey();
        store.saveCurrent(makeInput(key, { checkpoint: { timelineNodeId: left, checkpointEpoch: 2 } }, 'snap-left'),
            { diagnosticsEnabled: true });
        store.saveCurrent(makeInput(key, { checkpoint: { timelineNodeId: right, checkpointEpoch: 2 } }, 'snap-right'),
            { diagnosticsEnabled: true });

        const fromLeft = store.listVisibleSnapshots({ registry, currentNodeId: left, checkpointEpoch: 2 });
        expect(fromLeft.map(record => record.manifest.snapshotId)).toEqual(['snap-left']);

        const fromRight = store.listVisibleSnapshots({ registry, currentNodeId: right, checkpointEpoch: 2 });
        expect(fromRight.map(record => record.manifest.snapshotId)).toEqual(['snap-right']);
    });
});

describe('entity-name cache (step 7)', () => {
    it('stores live/verified-literal names and resolves them back', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const result = store.updateEntityNames([
            { entityType: 'character', id: 'char-1', displayName: 'Alice of York', source: 'live_gamedata' },
            { entityType: 'title', id: 'title-1', displayName: 'Kingdom of France', source: 'verified_literal' }
        ]);
        expect(result.accepted).toBe(2);
        expect(result.rejected).toHaveLength(0);
        expect(store.resolveEntityName('character', 'char-1')).toBe('Alice of York');
        expect(store.resolveEntityName('title', 'title-1')).toBe('Kingdom of France');
        expect(store.resolveEntityName('character', 'char-unknown')).toBeUndefined();
    });

    it('never lets a raw localization key become or overwrite a display name', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.updateEntityNames([
            { entityType: 'title', id: 'title-1', displayName: 'Kingdom of France', source: 'live_gamedata' }
        ]);

        const result = store.updateEntityNames([
            { entityType: 'title', id: 'title-1', displayName: 'k_france', source: 'verified_literal' },
            { entityType: 'character', id: 'char-2', displayName: 'dynn_normandie', source: 'live_gamedata' },
            { entityType: 'character', id: 'char-3', displayName: 'ERROR: missing loc', source: 'live_gamedata' }
        ]);
        expect(result.accepted).toBe(0);
        expect(result.rejected).toHaveLength(3);

        expect(store.resolveEntityName('title', 'title-1')).toBe('Kingdom of France');
        expect(store.resolveEntityName('character', 'char-2')).toBeUndefined();
        expect(store.resolveEntityName('character', 'char-3')).toBeUndefined();
    });

    it('live GameData names outrank verified literals, never the reverse', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.updateEntityNames([
            { entityType: 'character', id: 'char-1', displayName: 'Alice', source: 'verified_literal' }
        ]);
        store.updateEntityNames([
            { entityType: 'character', id: 'char-1', displayName: 'Alice of York', source: 'live_gamedata' }
        ]);
        expect(store.resolveEntityName('character', 'char-1')).toBe('Alice of York');

        const downgrade = store.updateEntityNames([
            { entityType: 'character', id: 'char-1', displayName: 'Alicia', source: 'verified_literal' }
        ]);
        expect(downgrade.accepted).toBe(0);
        expect(store.resolveEntityName('character', 'char-1')).toBe('Alice of York');
    });

    it('applies timeline provenance: sibling-branch names are not resolvable', () => {
        const { registry, left, right } = makeRegistry();
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.updateEntityNames(
            [{ entityType: 'character', id: 'char-1', displayName: 'Alice', source: 'live_gamedata' }],
            { timelineNodeId: right, checkpointEpoch: 2 }
        );

        expect(store.resolveEntityName('character', 'char-1', { registry, currentNodeId: right, checkpointEpoch: 2 }))
            .toBe('Alice');
        expect(store.resolveEntityName('character', 'char-1', { registry, currentNodeId: left, checkpointEpoch: 2 }))
            .toBeUndefined();
    });

    it('quarantines a corrupt entity-name cache instead of trusting it', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.updateEntityNames([
            { entityType: 'character', id: 'char-1', displayName: 'Alice', source: 'live_gamedata' }
        ]);

        const namesPath = saveFactsEntityNamesPath(tmpDir, IDENTITY);
        fs.writeFileSync(namesPath, '{broken', 'utf8');

        expect(store.resolveEntityName('character', 'char-1')).toBeUndefined();
        expect(fs.existsSync(namesPath)).toBe(false);
        const siblings = fs.readdirSync(path.dirname(namesPath));
        expect(siblings.some(name => name.startsWith('entity_names.json.corrupt.'))).toBe(true);
    });

    it('detects raw loc keys', () => {
        expect(looksLikeRawLocKey('k_france')).toBe(true);
        expect(looksLikeRawLocKey('dynn_capet')).toBe(true);
        expect(looksLikeRawLocKey('ERROR: something')).toBe(true);
        expect(looksLikeRawLocKey('Kingdom of France')).toBe(false);
        expect(looksLikeRawLocKey('Karl')).toBe(false);
    });
});

describe('persisted schema validator (step 2)', () => {
    it('round-trips a record written by saveCurrent', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey()));
        const raw = fs.readFileSync(saveFactsCurrentPath(tmpDir, IDENTITY), 'utf8');
        const validation = validatePersistedSaveFactSnapshot(JSON.parse(raw));
        expect(validation.ok).toBe(true);
    });

    it('rejects unknown fields, non-registry predicates and manifest inconsistency', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const record = store.saveCurrent(makeInput(makeKey()));
        const asJson = (): Record<string, unknown> => JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

        const withUnknown = asJson();
        withUnknown['rawSavePath'] = 'C:/saves/x.ck3';
        expect(validatePersistedSaveFactSnapshot(withUnknown).ok).toBe(false);

        const withBadPredicate = asJson();
        (withBadPredicate['facts'] as Array<Record<string, unknown>>)[0]['predicate'] = 'character.secret_lover';
        expect(validatePersistedSaveFactSnapshot(withBadPredicate).ok).toBe(false);

        const withManifestMismatch = asJson();
        (withManifestMismatch['manifest'] as Record<string, unknown>)['parserVersion'] = '9.9.9';
        expect(validatePersistedSaveFactSnapshot(withManifestMismatch).ok).toBe(false);

        const withBadFingerprint = asJson();
        withBadFingerprint['sourceFingerprint'] = 'tampered';
        expect(validatePersistedSaveFactSnapshot(withBadFingerprint).ok).toBe(false);
    });
});

describe('joinCandidates persisted transport (Plan C Task 3A)', () => {
    it('persists and reloads an optional joinCandidates list', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey(), { joinCandidates: ['13206', '33435'] }));

        const loaded = store.loadCurrent();
        expect(loaded.status).toBe('ok');
        if (loaded.status === 'ok') {
            expect(loaded.record.joinCandidates).toEqual(['13206', '33435']);
        }
    });

    it('keeps legacy cache entries without joinCandidates valid and absent', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey()));
        const loaded = store.loadCurrent();
        expect(loaded.status).toBe('ok');
        if (loaded.status === 'ok') {
            expect(loaded.record.joinCandidates).toBeUndefined();
        }
    });

    it('serves scheduled (cache-hit) records with joinCandidates in memory', async () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        const key = makeKey();
        expect(store.scheduleCurrent(makeInput(key, { joinCandidates: ['777'] }), undefined, Date.now() + 1000)).toBe(true);
        expect(store.findCachedSnapshot(key)?.joinCandidates).toEqual(['777']);
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    });

    it('rejects joinCandidates entries that are not bounded decimal ids', () => {
        const store = new SaveFactStore(tmpDir, IDENTITY);
        store.saveCurrent(makeInput(makeKey(), { joinCandidates: ['13206'] }));
        const record = store.saveCurrent(makeInput(makeKey()));
        const tampered = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
        tampered['joinCandidates'] = ['char_33435'];
        expect(validatePersistedSaveFactSnapshot(tampered).ok).toBe(false);
    });
});
