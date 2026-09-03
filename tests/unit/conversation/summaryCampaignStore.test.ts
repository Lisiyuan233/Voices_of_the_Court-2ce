/**
 * F24 (conversation-summary campaign isolation): the session summary store
 * ("会话摘要自身 campaign 化") must route reads/writes through the
 * summaryCampaignStore exit — campaign namespace when an identity is
 * available, legacy flat layout otherwise — with union reads (campaign copy
 * authoritative), graph/epoch visibility, full lineage stamps on campaign
 * writes, a one-shot flat->campaign migration, and identity-scoped clearing.
 *
 * Covers: read routing + union dedupe, F24 closed loop (a campaign-landed
 * incoming-letter summary appears in the session summaries assembly), write
 * routing + stamps, degraded legacy behavior, watcher target, migration
 * (idempotent / corrupt fail-closed / ambiguous / per-process gate), clear
 * scope.
 */
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => os.tmpdir()) }
}));

import {
    conversationSummariesDir,
    conversationSummariesMigrationMarkerPath
} from '../../../src/main/campaignDataPaths';
import {
    clearSummariesForScope,
    effectiveSummaryTarget,
    ensureFlatConversationSummariesMigrated,
    legacySummaryFilePath,
    migrateFlatConversationSummaries,
    readCharacterSummariesUnion,
    readSummaryCharacterMapObject,
    resetConversationSummariesMigrationCacheForTests,
    writeCharacterSummaries,
    writeSummaryCharacterMap,
    type SummaryStoreContext,
    type SummaryStoreRouting
} from '../../../src/main/conversation/summaryCampaignStore';
import { SummaryFileWatcher } from '../../../src/main/conversation/SummaryFileWatcher';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';
import type { TimelineRegistry } from '../../../src/main/timelineManager';
import type { Summary } from '../../../src/main/ts/conversation_interfaces';

const PLAYER_ID = '32769';
const AI_ID = '29171';
const OTHER_PLAYER_ID = '4242';

function makeIdentity(campaignId: string, playerId = PLAYER_ID): CampaignPlayerIdentity {
    return {
        protocolSchema: 2,
        campaignSchema: 1,
        campaignId,
        campaignParts: { a: 111111111, b: 222222222, c: 333333333, d: 444444444 },
        playerId
    } as CampaignPlayerIdentity;
}

const CAMPAIGN_A = '111111111-222222222-333333333-444444444';
const CAMPAIGN_B = '999999999-888888888-777777777-666666666';
const identityA = makeIdentity(CAMPAIGN_A);
const identityB = makeIdentity(CAMPAIGN_B);

let userData: string;
let votcRoot: string;

function routing(characterId = AI_ID): SummaryStoreRouting {
    return { votcDataRoot: votcRoot, userDataDir: userData, playerId: PLAYER_ID, characterId };
}

function ctx(overrides: Partial<SummaryStoreContext> = {}): SummaryStoreContext {
    return { identity: identityA, checkpointEpoch: 5, ...overrides };
}

function legacyFile(characterId = AI_ID, playerId = PLAYER_ID): string {
    return legacySummaryFilePath(votcRoot, playerId, characterId);
}

function campaignFile(identity: CampaignPlayerIdentity, characterId = AI_ID): string {
    return path.join(conversationSummariesDir(userData, identity), `${characterId}.json`);
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        date: '1066.9.25',
        content: 'talked about the succession',
        votcCheckpointEpoch: 3,
        ...overrides
    };
}

/**
 * Minimal TimelineRegistry mock satisfying isRecordVisibleForContext: a
 * record at node X is visible from node Y only when X is on Y's ancestor
 * chain (sibling branches do not see each other's records).
 */
function makeRegistryMock(): { registry: TimelineRegistry; registerParentChild(parentId: string, childId: string): void } {
    const parents = new Map<string, string>(); // childId -> parentId
    const registry = {
        isRecordVisible(recordNodeId: string | undefined, current: string | undefined): boolean {
            if (!recordNodeId || !current) return true;
            if (recordNodeId === current) return true;
            let node: string | undefined = current;
            const visited = new Set<string>();
            while (node && !visited.has(node)) {
                visited.add(node);
                const parent = parents.get(node);
                if (parent === recordNodeId) return true;
                node = parent;
            }
            return false;
        },
        isV2RecordVisibleFromObservedContext(): boolean {
            return false;
        }
    } as unknown as TimelineRegistry;
    return { registry, registerParentChild: (parentId, childId) => parents.set(childId, parentId) };
}

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-summary-f24-'));
    votcRoot = path.join(userData, 'votc_data');
    fs.mkdirSync(votcRoot, { recursive: true });
    resetConversationSummariesMigrationCacheForTests();
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('F24 read assembly (union, dedupe, visibility)', () => {
    it('F24 closed loop: a campaign-landed incoming-letter summary appears in the session summaries assembly', () => {
        // Exactly the record shape IncomingLetterGenerator.saveSummary writes
        // into the campaign store: post-bump epoch + node anchor + campaign id.
        const letterSummary: Summary = {
            characterId: AI_ID,
            date: '1066.9.25',
            content: '[主动来信·情书·1066.9.25] I miss you at court.',
            votcCheckpointEpoch: 6, // post-bump: greater than the open-time epoch 5
            votcTimelineNodeId: '10-20',
            votcTimelineParentId: '1-2',
            votcCampaignId: CAMPAIGN_A,
            id: `summary_10-20_${new Date().getTime()}`,
            sourceType: 'incoming_letter'
        };
        writeJson(campaignFile(identityA), [letterSummary]);

        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('1-2', '10-20');

        const assembled = readCharacterSummariesUnion(routing(), {
            identity: identityA,
            checkpointEpoch: 5,
            registry,
            currentNodeId: '10-20'
        });

        expect(assembled).toHaveLength(1);
        expect(assembled[0].sourceType).toBe('incoming_letter');
        expect(assembled[0].votcCampaignId).toBe(CAMPAIGN_A);
        expect(assembled[0].votcTimelineNodeId).toBe('10-20');
    });

    it('unions campaign and legacy stores with the campaign copy authoritative on id dedupe', () => {
        const campaignRecord = makeSummary({
            id: 'sum-1',
            content: 'CAMPAIGN COPY',
            votcCampaignId: CAMPAIGN_A,
            votcCheckpointEpoch: 3
        });
        writeJson(campaignFile(identityA), [campaignRecord]);
        writeJson(legacyFile(), [
            makeSummary({ id: 'sum-1', content: 'LEGACY COPY', votcCheckpointEpoch: 3 }),
            makeSummary({ id: 'sum-legacy-only', content: 'legacy only', votcCheckpointEpoch: 3 })
        ]);

        const assembled = readCharacterSummariesUnion(routing(), ctx());
        expect(assembled).toHaveLength(2);
        expect(assembled.map(s => s.content).sort()).toEqual(['CAMPAIGN COPY', 'legacy only']);
    });

    it('dedupes by fallback key when records carry no id', () => {
        writeJson(campaignFile(identityA), [
            makeSummary({ date: '1066.9.25', content: 'same talk', votcCheckpointEpoch: 3, votcCampaignId: CAMPAIGN_A })
        ]);
        writeJson(legacyFile(), [
            makeSummary({ date: '1066.9.25', content: 'same talk', votcCheckpointEpoch: 3 }),
            makeSummary({ date: '1066.9.26', content: 'different talk', votcCheckpointEpoch: 3 })
        ]);

        const assembled = readCharacterSummariesUnion(routing(), ctx());
        expect(assembled).toHaveLength(2);
        // The surviving duplicate is the campaign copy (stamped).
        expect(assembled.find(s => s.content === 'same talk')?.votcCampaignId).toBe(CAMPAIGN_A);
    });

    it('degrades to the flat-only read without an identity (campaign store ignored)', () => {
        writeJson(campaignFile(identityA), [makeSummary({ id: 'campaign-1' })]);
        writeJson(legacyFile(), [makeSummary({ id: 'legacy-1' })]);

        const assembled = readCharacterSummariesUnion(routing(), {
            checkpointEpoch: 5
        });
        expect(assembled.map(s => s.id)).toEqual(['legacy-1']);
    });

    it('filters anchored records by graph visibility and legacy records by epoch', () => {
        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('50-60', '100-200');

        writeJson(campaignFile(identityA), [
            makeSummary({ id: 'ancestor', votcTimelineNodeId: '50-60', votcCheckpointEpoch: 9, votcCampaignId: CAMPAIGN_A }),
            makeSummary({ id: 'sibling', votcTimelineNodeId: '77-88', votcCheckpointEpoch: 9, votcCampaignId: CAMPAIGN_A }),
            makeSummary({ id: 'current', votcTimelineNodeId: '100-200', votcCheckpointEpoch: 9, votcCampaignId: CAMPAIGN_A })
        ]);
        writeJson(legacyFile(), [
            makeSummary({ id: 'legacy-past', votcCheckpointEpoch: 2 }),
            makeSummary({ id: 'legacy-future', votcCheckpointEpoch: 9 })
        ]);

        const assembled = readCharacterSummariesUnion(routing(), {
            identity: identityA,
            checkpointEpoch: 5,
            registry,
            currentNodeId: '100-200'
        });
        // ancestor node: visible; sibling branch: hidden; legacy past epoch:
        // visible; legacy future epoch: hidden.
        expect(assembled.map(s => s.id).sort()).toEqual(['ancestor', 'current', 'legacy-past']);
    });

    it('hides anchored records when no registry is available (fail-closed)', () => {
        writeJson(campaignFile(identityA), [
            makeSummary({ id: 'anchored', votcTimelineNodeId: '10-20', votcCampaignId: CAMPAIGN_A })
        ]);
        const assembled = readCharacterSummariesUnion(routing(), {
            identity: identityA,
            checkpointEpoch: 5,
            currentNodeId: '10-20'
        });
        expect(assembled).toHaveLength(0);
    });
});

describe('F24 write routing + stamps', () => {
    it('writes stamped records into the campaign store only and preserves sibling-branch records', async () => {
        // Pre-existing record from a hidden sibling branch on disk.
        writeJson(campaignFile(identityA), [
            makeSummary({ id: 'sibling-branch', votcTimelineNodeId: '77-88', votcCheckpointEpoch: 5, votcCampaignId: CAMPAIGN_A })
        ]);

        const newSummary = makeSummary({ content: 'fresh close summary', votcCheckpointEpoch: 6 });
        const target = await writeCharacterSummaries(routing(), identityA, {
            legacyReplacement: [makeSummary({ id: 'legacy-junk' })],
            campaignMerge: [newSummary],
            stamp: {
                checkpointEpoch: 6,
                timelineNodeId: '100-200',
                timelineParentId: '50-60',
                campaignId: CAMPAIGN_A
            }
        });

        expect(target.scope).toBe('campaign');
        const raw = JSON.parse(fs.readFileSync(campaignFile(identityA), 'utf8'));
        expect(raw).toHaveLength(2);
        expect(raw[0].content).toBe('fresh close summary');
        expect(raw[0].votcCampaignId).toBe(CAMPAIGN_A);
        expect(raw[0].votcTimelineNodeId).toBe('100-200');
        expect(raw[0].votcTimelineParentId).toBe('50-60');
        expect(raw[0].votcCheckpointEpoch).toBe(6);
        // Hidden sibling-branch record survived the merge write.
        expect(raw[1].id).toBe('sibling-branch');
        // The flat layout is never touched by a campaign write (the leak F24
        // closes) and the legacyReplacement payload is ignored there.
        expect(fs.existsSync(legacyFile())).toBe(false);
    });

    it('degrades to the pre-F24 whole-overwrite of the legacy file without an identity', async () => {
        writeJson(legacyFile(), [makeSummary({ id: 'old-1' })]);

        const kept = makeSummary({ id: 'old-1' });
        const fresh = makeSummary({ id: 'fresh-1', votcCheckpointEpoch: 6 });
        const target = await writeCharacterSummaries(routing(), undefined, {
            legacyReplacement: [fresh, kept],
            campaignMerge: [fresh]
        });

        expect(target.scope).toBe('legacy');
        const raw = JSON.parse(fs.readFileSync(legacyFile(), 'utf8'));
        expect(raw.map((s: Summary) => s.id)).toEqual(['fresh-1', 'old-1']);
        // No campaign store is created for degraded writes.
        expect(fs.existsSync(conversationSummariesDir(userData, identityA))).toBe(false);
    });

    it('fills only missing stamps and never overrides caller stamps', async () => {
        const callerStamped = makeSummary({
            votcCheckpointEpoch: 4,
            votcTimelineNodeId: '99-98'
        });
        await writeCharacterSummaries(routing(), identityA, {
            legacyReplacement: [],
            campaignMerge: [callerStamped],
            stamp: {
                checkpointEpoch: 6,
                timelineNodeId: '100-200',
                timelineParentId: '50-60',
                campaignId: CAMPAIGN_A
            }
        });
        const raw = JSON.parse(fs.readFileSync(campaignFile(identityA), 'utf8'));
        expect(raw[0].votcCheckpointEpoch).toBe(4);
        expect(raw[0].votcTimelineNodeId).toBe('99-98');
        // Missing fields are filled from the stamp.
        expect(raw[0].votcTimelineParentId).toBe('50-60');
        expect(raw[0].votcCampaignId).toBe(CAMPAIGN_A);
    });
});

describe('F24 watcher target', () => {
    it('routes the effective file to the campaign store with identity and to the flat store without', () => {
        expect(effectiveSummaryTarget(routing(), identityA)).toEqual({
            filePath: campaignFile(identityA),
            scope: 'campaign'
        });
        expect(effectiveSummaryTarget(routing(), undefined)).toEqual({
            filePath: legacyFile(),
            scope: 'legacy'
        });
    });

    it('attaches the file watcher to the effective campaign file', () => {
        writeJson(campaignFile(identityA), []);
        const watcher = new SummaryFileWatcher();
        try {
            watcher.watchFile(campaignFile(identityA), () => undefined);
            expect(watcher.getWatchedFiles()).toEqual([campaignFile(identityA)]);
        } finally {
            watcher.unwatchAll();
        }
    });
});

describe('F24 flat store migration', () => {
    it('migrates once with backup + marker (idempotent); degraded later writes stay legacy but stay readable', async () => {
        writeJson(legacyFile(), [makeSummary({ id: 'flat-1', content: 'pre-campaign talk' })]);

        const result = await migrateFlatConversationSummaries(userData, identityA);
        expect(result.status).toBe('migrated');
        expect(result.migratedFiles).toBe(1);

        // Campaign copy exists; flat copy is gone; backup + marker exist.
        expect(JSON.parse(fs.readFileSync(campaignFile(identityA), 'utf8'))[0].id).toBe('flat-1');
        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(fs.existsSync(conversationSummariesMigrationMarkerPath(userData, identityA))).toBe(true);
        const backupsRoot = path.join(userData, 'votc_data', 'legacy_backups');
        const stampDirs = fs.readdirSync(backupsRoot);
        expect(stampDirs).toHaveLength(1);
        // The summary migration uses its own store name so it cannot clobber
        // the letter migration's backups in the shared legacy_backups area.
        expect(fs.readdirSync(path.join(backupsRoot, stampDirs[0]))).toEqual(['conversation_summaries']);

        // Second run: marker short-circuits.
        const second = await migrateFlatConversationSummaries(userData, identityA);
        expect(second.status).toBe('already-migrated');

        // A later degraded legacy write is NOT re-migrated (no churn), but it
        // stays readable through the union read of the campaign session.
        writeJson(legacyFile(), [makeSummary({ id: 'degraded-1' })]);
        const third = await migrateFlatConversationSummaries(userData, identityA);
        expect(third.status).toBe('already-migrated');
        expect(fs.existsSync(legacyFile())).toBe(true);

        const assembled = readCharacterSummariesUnion(routing(), ctx());
        expect(assembled.map(s => s.id).sort()).toEqual(['degraded-1', 'flat-1']);
    });

    it('fails closed on corrupt JSON: file stays, marker is not written, valid files migrate', async () => {
        writeJson(legacyFile(AI_ID), [makeSummary({ id: 'ok-1' })]);
        const brokenFile = path.join(path.dirname(legacyFile()), 'broken.json');
        fs.writeFileSync(brokenFile, '{not json', 'utf8');

        const result = await migrateFlatConversationSummaries(userData, identityA);
        expect(result.status).toBe('partial');
        expect(result.migratedFiles).toBe(1);
        expect(result.skippedCorruptFiles).toBe(1);
        expect(fs.existsSync(brokenFile)).toBe(true);
        expect(fs.existsSync(conversationSummariesMigrationMarkerPath(userData, identityA))).toBe(false);

        // Retry keeps failing closed on the corrupt file only.
        const retry = await migrateFlatConversationSummaries(userData, identityA);
        expect(retry.status).toBe('partial');
        expect(fs.existsSync(brokenFile)).toBe(true);
    });

    it('refuses to claim a flat store that another campaign may own (ambiguous)', async () => {
        writeJson(legacyFile(), [makeSummary({ id: 'ambiguous-1' })]);
        // Another campaign already owns summary data for this player.
        writeJson(campaignFile(identityB, '12345'), [makeSummary({ id: 'b-1' })]);

        const result = await migrateFlatConversationSummaries(userData, identityA);
        expect(result.status).toBe('ambiguous');
        expect(fs.existsSync(legacyFile())).toBe(true);
        expect(fs.existsSync(campaignFile(identityA))).toBe(false);
        // The flat data remains readable as the legacy fallback.
        const assembled = readCharacterSummariesUnion(routing(), ctx());
        expect(assembled.map(s => s.id)).toEqual(['ambiguous-1']);
    });

    it('writes the marker even when there is no flat data (no-flat-data)', async () => {
        const result = await migrateFlatConversationSummaries(userData, identityA);
        expect(result.status).toBe('no-flat-data');
        expect(fs.existsSync(conversationSummariesMigrationMarkerPath(userData, identityA))).toBe(true);
    });

    it('keeps the marker outside the store dir so readers never parse it as summaries', async () => {
        const markerPath = conversationSummariesMigrationMarkerPath(userData, identityA);
        const storeDir = conversationSummariesDir(userData, identityA);
        // Not inside the store directory tree (a marker inside would be listed
        // and parsed as a summary array by every reader).
        expect(path.relative(storeDir, markerPath).startsWith('..')).toBe(true);

        writeJson(legacyFile(), [makeSummary({ id: 'flat-1' })]);
        await migrateFlatConversationSummaries(userData, identityA);
        const assembled = readCharacterSummariesUnion(routing(), ctx());
        expect(assembled.map(s => s.id)).toEqual(['flat-1']);
    });

    it('runs the migration scan at most once per campaign|player per process', async () => {
        writeJson(legacyFile(), [makeSummary({ id: 'flat-1' })]);

        const [first, concurrent] = await Promise.all([
            ensureFlatConversationSummariesMigrated(userData, identityA),
            ensureFlatConversationSummariesMigrated(userData, identityA)
        ]);
        expect(first?.status).toBe('migrated');
        expect(concurrent?.status).toBe('migrated');
        expect(fs.existsSync(legacyFile())).toBe(false);

        // Cached: no further scan for the same campaign|player in this process.
        const cached = await ensureFlatConversationSummariesMigrated(userData, identityA);
        expect(cached).toBeUndefined();

        // A different campaign is a separate gate key — and correctly refuses
        // to claim the flat store because campaign A already owns data for
        // this player (ambiguous ownership).
        writeJson(legacyFile(), [makeSummary({ id: 'flat-b' })]);
        const other = await ensureFlatConversationSummariesMigrated(userData, identityB);
        expect(other?.status).toBe('ambiguous');
        expect(fs.existsSync(legacyFile())).toBe(true);
    });
});

describe('F24 clear scope', () => {
    it('clears the campaign store and the same player legacy dir, leaving other players', () => {
        writeJson(campaignFile(identityA), [makeSummary({ id: 'campaign-1' })]);
        writeJson(legacyFile(), [makeSummary({ id: 'own-legacy' })]);
        const otherLegacy = legacySummaryFilePath(votcRoot, OTHER_PLAYER_ID, AI_ID);
        writeJson(otherLegacy, [makeSummary({ id: 'other-legacy' })]);

        clearSummariesForScope(votcRoot, userData, PLAYER_ID, identityA);

        expect(fs.existsSync(campaignFile(identityA))).toBe(false);
        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(fs.existsSync(otherLegacy)).toBe(true);
    });

    it('wipes the whole flat store without an identity (pre-F24 behavior)', () => {
        writeJson(legacyFile(), [makeSummary({ id: 'a' })]);
        writeJson(legacySummaryFilePath(votcRoot, OTHER_PLAYER_ID, AI_ID), [makeSummary({ id: 'b' })]);

        clearSummariesForScope(votcRoot, userData, undefined, undefined);

        expect(fs.existsSync(path.join(votcRoot, 'conversation_summaries'))).toBe(false);
    });
});

describe('F24 character map routing', () => {
    it('prefers the campaign map per key and merges the legacy map as fallback', () => {
        // writeSummaryCharacterMap writes campaign (authoritative) + legacy mirror.
        writeSummaryCharacterMap(routing(), identityA, { [AI_ID]: 'Campaign Name' });
        // Seed an extra legacy-only entry directly.
        writeJson(path.join(path.dirname(legacyFile()), '_character_map.json'), {
            [AI_ID]: 'Legacy Name',
            '111': 'Extra Character'
        });

        const map = readSummaryCharacterMapObject(routing(), identityA);
        expect(map[AI_ID]).toBe('Campaign Name');
        expect(map['111']).toBe('Extra Character');

        // Without an identity only the legacy map is consulted.
        const legacyMap = readSummaryCharacterMapObject(routing(), undefined);
        expect(legacyMap[AI_ID]).toBe('Legacy Name');
    });
});
