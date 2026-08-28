import fs from 'fs';
import os from 'os';
import path from 'path';

const mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-diary-timeline-'));

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => mockUserDataDir) }
}));

import { TimelineRegistry } from '../../src/main/timelineManager';

let diaryManager: typeof import('../../src/main/diaryManager');

const PLAYER = '1001';
const CHAR = '2002';

function votcDataDir(): string {
    return path.join(mockUserDataDir, 'votc_data');
}

function diaryFilePath(playerId: string, characterId: string): string {
    return path.join(votcDataDir(), 'diary_history', playerId, `${characterId}.json`);
}

function diaryArchiveFilePath(playerId: string, characterId: string): string {
    return path.join(votcDataDir(), 'diary_history_archived', playerId, `${characterId}.json`);
}

function summaryFilePath(playerId: string, characterId: string): string {
    return path.join(votcDataDir(), 'diary_summaries', playerId, `${characterId}.json`);
}

function summaryArchiveFilePath(playerId: string, characterId: string): string {
    return path.join(votcDataDir(), 'diary_summaries_archived', playerId, `${characterId}.json`);
}

function writeDiaryEntries(playerId: string, characterId: string, entries: any[]): void {
    const filePath = diaryFilePath(playerId, characterId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ diary_entries: entries }, null, '\t'));
}

function writeDiarySummaries(playerId: string, characterId: string, summaries: any[]): void {
    const filePath = summaryFilePath(playerId, characterId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(summaries, null, '\t'));
}

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeEntry(id: string, extra: any = {}): any {
    return {
        id,
        date: '867.1.1',
        location: 'Testburg',
        scene: 'Test scene',
        participants: [PLAYER, CHAR],
        content: `content of ${id}`,
        character_traits: {},
        ...extra
    };
}

function makeSummary(id: string, extra: any = {}): any {
    return {
        id,
        diaryEntryId: `entry-${id}`,
        date: '867.1.1',
        summary: `summary of ${id}`,
        ...extra
    };
}

/**
 * Registry with a sibling split at epoch 2:
 *   1-1 (epoch 1) -> 2-1 (epoch 2, current branch)
 *                 -> 3-1 (epoch 2, sibling branch)
 */
function makeRegistry(): TimelineRegistry {
    return new TimelineRegistry(PLAYER, {
        version: 1,
        playerId: PLAYER,
        nodes: {
            '1-1': { parentId: null, epoch: 1, source: 'conversation', eventKey: 'k1', createdAt: '2026-01-01T00:00:00Z' },
            '2-1': { parentId: '1-1', epoch: 2, source: 'conversation', eventKey: 'k2', createdAt: '2026-01-02T00:00:00Z' },
            '3-1': { parentId: '1-1', epoch: 2, source: 'conversation', eventKey: 'k3', createdAt: '2026-01-03T00:00:00Z' }
        }
    });
}

beforeAll(() => {
    // Require after the electron mock + temp dir exist: diaryManager resolves
    // its storage roots from app.getPath('userData') at module load time.
    diaryManager = require('../../src/main/diaryManager');
});

afterAll(() => {
    fs.rmSync(mockUserDataDir, { recursive: true, force: true });
});

beforeEach(() => {
    fs.rmSync(votcDataDir(), { recursive: true, force: true });
});

describe('readDiaryFile visibility', () => {
    it('filters legacy entries by checkpoint epoch and keeps epoch-less records visible', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-past', { votcCheckpointEpoch: 1 }),
            makeEntry('e-future', { votcCheckpointEpoch: 5 }),
            makeEntry('e-legacy-noepoch')
        ]);

        const result = await diaryManager.readDiaryFile(PLAYER, CHAR, { checkpointEpoch: 3 });
        const ids = result.diary_entries.map(e => e.id).sort();
        expect(ids).toEqual(['e-legacy-noepoch', 'e-past']);
    });

    it('uses graph visibility for node-tagged entries when registry and current node are known', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-ancestor', { votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' }),
            makeEntry('e-current', { votcCheckpointEpoch: 2, votcTimelineNodeId: '2-1' }),
            // Same epoch as e-current but on the sibling branch: epoch alone
            // cannot distinguish these; the graph must hide it.
            makeEntry('e-sibling', { votcCheckpointEpoch: 2, votcTimelineNodeId: '3-1' })
        ]);

        const result = await diaryManager.readDiaryFile(PLAYER, CHAR, {
            checkpointEpoch: 2,
            registry: makeRegistry(),
            currentNodeId: '2-1'
        });
        const ids = result.diary_entries.map(e => e.id).sort();
        expect(ids).toEqual(['e-ancestor', 'e-current']);
    });

    it('falls back to epoch semantics for node-tagged entries when no graph context is available', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-past', { votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' }),
            makeEntry('e-future', { votcCheckpointEpoch: 9, votcTimelineNodeId: '3-1' })
        ]);

        const result = await diaryManager.readDiaryFile(PLAYER, CHAR, { checkpointEpoch: 3 });
        expect(result.diary_entries.map(e => e.id)).toEqual(['e-past']);
    });

    it('shows everything when no visibility context is provided (legacy behavior)', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-future', { votcCheckpointEpoch: 99 }),
            makeEntry('e-node', { votcTimelineNodeId: '3-1' })
        ]);

        const result = await diaryManager.readDiaryFile(PLAYER, CHAR);
        expect(result.diary_entries).toHaveLength(2);
    });

    it('hides records stamped with a different campaign id', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-this-campaign', { votcCheckpointEpoch: 1, votcCampaignId: 'camp-a' }),
            makeEntry('e-other-campaign', { votcCheckpointEpoch: 1, votcCampaignId: 'camp-b' }),
            makeEntry('e-no-campaign', { votcCheckpointEpoch: 1 })
        ]);

        const result = await diaryManager.readDiaryFile(PLAYER, CHAR, { checkpointEpoch: 3, campaignId: 'camp-a' });
        const ids = result.diary_entries.map(e => e.id).sort();
        expect(ids).toEqual(['e-no-campaign', 'e-this-campaign']);
    });
});

describe('readDiarySummaries visibility', () => {
    it('preserves timeline stamp fields and filters by epoch', async () => {
        writeDiarySummaries(PLAYER, CHAR, [
            makeSummary('s-past', { votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1', votcTimelineParentId: '2-2', votcCampaignId: 'camp-a' }),
            makeSummary('s-future', { votcCheckpointEpoch: 5 })
        ]);

        const visible = await diaryManager.readDiarySummaries(PLAYER, CHAR, { checkpointEpoch: 3 });
        expect(visible).toHaveLength(1);
        expect(visible[0].id).toBe('s-past');
        expect(visible[0].votcTimelineNodeId).toBe('1-1');
        expect(visible[0].votcTimelineParentId).toBe('2-2');
        expect(visible[0].votcCampaignId).toBe('camp-a');

        const all = await diaryManager.readDiarySummaries(PLAYER, CHAR);
        expect(all).toHaveLength(2);
    });
});

describe('archiveFutureDiaryRecordsForPlayer', () => {
    it('archives future legacy entries and summaries, keeps node-tagged records in place', () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-past', { votcCheckpointEpoch: 1 }),
            makeEntry('e-future', { votcCheckpointEpoch: 5 }),
            // Node-tagged records stay in the live file regardless of epoch;
            // branch visibility is the graph's job.
            makeEntry('e-node-future-epoch', { votcCheckpointEpoch: 9, votcTimelineNodeId: '2-1' })
        ]);
        writeDiarySummaries(PLAYER, CHAR, [
            makeSummary('s-past', { votcCheckpointEpoch: 1 }),
            makeSummary('s-future', { votcCheckpointEpoch: 5 })
        ]);

        const archived = diaryManager.archiveFutureDiaryRecordsForPlayer(PLAYER, 3, 'test_reason');
        expect(archived).toBe(2);

        const liveEntries = readJson(diaryFilePath(PLAYER, CHAR)).diary_entries;
        expect(liveEntries.map((e: any) => e.id).sort()).toEqual(['e-node-future-epoch', 'e-past']);

        const archivedEntries = readJson(diaryArchiveFilePath(PLAYER, CHAR)).diary_entries;
        expect(archivedEntries).toHaveLength(1);
        expect(archivedEntries[0].id).toBe('e-future');
        expect(archivedEntries[0].archiveReason).toBe('test_reason');
        expect(archivedEntries[0].archivedFromCheckpointEpoch).toBe(3);

        const liveSummaries = readJson(summaryFilePath(PLAYER, CHAR));
        expect(liveSummaries.map((s: any) => s.id)).toEqual(['s-past']);

        const archivedSummaries = readJson(summaryArchiveFilePath(PLAYER, CHAR));
        expect(archivedSummaries).toHaveLength(1);
        expect(archivedSummaries[0].id).toBe('s-future');
        expect(archivedSummaries[0].archiveReason).toBe('test_reason');
    });

    it('is idempotent across repeated runs', () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-future', { votcCheckpointEpoch: 5 })
        ]);

        expect(diaryManager.archiveFutureDiaryRecordsForPlayer(PLAYER, 3)).toBe(1);
        expect(diaryManager.archiveFutureDiaryRecordsForPlayer(PLAYER, 3)).toBe(0);

        const archivedEntries = readJson(diaryArchiveFilePath(PLAYER, CHAR)).diary_entries;
        expect(archivedEntries).toHaveLength(1);
        expect(readJson(diaryFilePath(PLAYER, CHAR)).diary_entries).toHaveLength(0);
    });
});

describe('saveDiaryFile merge semantics', () => {
    it('preserves entries hidden in the current context on whole-file saves', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-visible', { votcCheckpointEpoch: 1, content: 'old content' }),
            makeEntry('e-hidden-future', { votcCheckpointEpoch: 9 })
        ]);

        // The UI loaded with the same context only saw e-visible; it saves an
        // edited copy. The hidden future entry must survive.
        await diaryManager.saveDiaryFile(PLAYER, CHAR, {
            diary_entries: [makeEntry('e-visible', { votcCheckpointEpoch: 1, content: 'edited content' })]
        }, { checkpointEpoch: 3 });

        const saved = readJson(diaryFilePath(PLAYER, CHAR)).diary_entries;
        const byId = new Map<string, any>(saved.map((e: any) => [e.id, e]));
        expect(byId.get('e-visible').content).toBe('edited content');
        expect(byId.has('e-hidden-future')).toBe(true);
    });

    it('keeps whole-file overwrite behavior when no visibility context is given', async () => {
        writeDiaryEntries(PLAYER, CHAR, [
            makeEntry('e-visible', { votcCheckpointEpoch: 1 }),
            makeEntry('e-hidden-future', { votcCheckpointEpoch: 9 })
        ]);

        await diaryManager.saveDiaryFile(PLAYER, CHAR, {
            diary_entries: [makeEntry('e-visible', { votcCheckpointEpoch: 1 })]
        });

        const saved = readJson(diaryFilePath(PLAYER, CHAR)).diary_entries;
        expect(saved.map((e: any) => e.id)).toEqual(['e-visible']);
    });

    it('still prepends single new entries (conversation flow path)', async () => {
        writeDiaryEntries(PLAYER, CHAR, [makeEntry('e-old', { votcCheckpointEpoch: 1 })]);

        await diaryManager.saveDiaryFile(PLAYER, CHAR, makeEntry('e-new', { votcCheckpointEpoch: 2 }));

        const saved = readJson(diaryFilePath(PLAYER, CHAR)).diary_entries;
        expect(saved.map((e: any) => e.id).sort()).toEqual(['e-new', 'e-old']);
    });
});

describe('saveAllDiarySummariesMerged', () => {
    it('preserves hidden summaries and leaves fully-hidden character files untouched', async () => {
        writeDiarySummaries(PLAYER, 'charA', [
            makeSummary('s-visible', { votcCheckpointEpoch: 1, summary: 'old', characterId: 'charA' }),
            makeSummary('s-hidden', { votcCheckpointEpoch: 9, characterId: 'charA' })
        ]);
        writeDiarySummaries(PLAYER, 'charB', [
            makeSummary('s-hidden-b', { votcCheckpointEpoch: 9, characterId: 'charB' })
        ]);

        // UI payload: charA has only the (edited) visible summary; charB is
        // absent entirely because all of its summaries were filtered out.
        await diaryManager.saveAllDiarySummariesMerged(PLAYER, [
            { ...makeSummary('s-visible', { votcCheckpointEpoch: 1, summary: 'edited' }), characterId: 'charA', characterName: 'A' }
        ], { checkpointEpoch: 3 });

        const charA = readJson(summaryFilePath(PLAYER, 'charA'));
        const charAById = new Map<string, any>(charA.map((s: any) => [s.id, s]));
        expect(charAById.get('s-visible').summary).toBe('edited');
        expect(charAById.has('s-hidden')).toBe(true);
        // characterName is a UI-only field and must not be persisted
        expect((charAById.get('s-visible') as any).characterName).toBeUndefined();

        // charB's file must survive untouched
        const charB = readJson(summaryFilePath(PLAYER, 'charB'));
        expect(charB.map((s: any) => s.id)).toEqual(['s-hidden-b']);
    });

    it('deletes summaries the user actually saw and removed', async () => {
        writeDiarySummaries(PLAYER, 'charC', [
            makeSummary('s-visible-c', { votcCheckpointEpoch: 1, characterId: 'charC' })
        ]);

        await diaryManager.saveAllDiarySummariesMerged(PLAYER, [], { checkpointEpoch: 3 });

        expect(fs.existsSync(summaryFilePath(PLAYER, 'charC'))).toBe(false);
    });
});

describe('getAllDiarySummaries visibility', () => {
    it('filters summaries across all characters of a player', async () => {
        writeDiarySummaries(PLAYER, 'charA', [makeSummary('s-past', { votcCheckpointEpoch: 1 })]);
        writeDiarySummaries(PLAYER, 'charB', [makeSummary('s-future', { votcCheckpointEpoch: 5 })]);

        const visible = await diaryManager.getAllDiarySummaries(PLAYER, { checkpointEpoch: 3 });
        expect(visible.map(s => s.id)).toEqual(['s-past']);
        expect(visible[0].characterName).toBeDefined();

        const all = await diaryManager.getAllDiarySummaries(PLAYER);
        expect(all).toHaveLength(2);
    });
});
