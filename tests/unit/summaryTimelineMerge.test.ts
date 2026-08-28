import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

// summaryManager imports electron for the campaign-scoped path helpers; the
// tests below only exercise the legacy namespace, so a tmpdir stub suffices.
jest.mock('electron', () => ({
    app: {
        getPath: jest.fn(() => os.tmpdir())
    }
}));

import {
    readSummaryFile,
    saveSummaryFile,
    mergeSummariesForTimelineSave
} from '../../src/main/summaryManager';
import { TimelineRegistry } from '../../src/main/timelineManager';
import type { Summary } from '../../src/main/ts/conversation_interfaces';

// Timeline graph used by the visibility tests:
//   1-1 (root)
//    ├── 2-1   <- current branch
//    └── 2-2   <- hidden sibling branch
function makeRegistry(): TimelineRegistry {
    return new TimelineRegistry('p1', {
        version: 1,
        playerId: 'p1',
        nodes: {
            '1-1': { parentId: null, epoch: 1, source: 'checkpoint', eventKey: 'k-root', createdAt: '2026-01-01T00:00:00.000Z' },
            '2-1': { parentId: '1-1', epoch: 2, source: 'checkpoint', eventKey: 'k-a', createdAt: '2026-01-02T00:00:00.000Z' },
            '2-2': { parentId: '1-1', epoch: 2, source: 'checkpoint', eventKey: 'k-b', createdAt: '2026-01-03T00:00:00.000Z' }
        }
    });
}

describe('summaryManager timeline merge save (incoming-letter data-loss fix)', () => {
    let tmpRoot: string;
    let userDataPath: string;
    let summaryDir: string;

    const readRaw = (characterId: string): any[] =>
        JSON.parse(fs.readFileSync(path.join(summaryDir, `${characterId}.json`), 'utf8'));

    const writeRaw = (characterId: string, summaries: any[]): void => {
        fs.writeFileSync(path.join(summaryDir, `${characterId}.json`), JSON.stringify(summaries, null, '\t'), 'utf8');
    };

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-summary-merge-'));
        userDataPath = path.join(tmpRoot, 'votc_data');
        summaryDir = path.join(userDataPath, 'conversation_summaries', 'p1');
        fs.mkdirSync(summaryDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('reproduces the bug shape: without a registry, node-tagged summaries are fail-closed invisible', async () => {
        writeRaw('senderA', [
            { id: 'a1', date: '1100年1月1日', content: 'root-branch summary', votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' }
        ]);

        const noContext = await readSummaryFile(userDataPath, 'p1', 2);
        expect(noContext).toHaveLength(0);

        const withContext = await readSummaryFile(userDataPath, 'p1', 2, makeRegistry(), '2-1');
        expect(withContext.map(s => s.id)).toEqual(['a1']);
    });

    it('keeps node-tagged history and other senders\u2019 files after an incoming-letter summary save', async () => {
        const registry = makeRegistry();
        writeRaw('senderA', [
            { id: 'a1', date: '1100年1月1日', content: 'current-branch summary', votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' },
            { id: 'a2', date: '1100年2月1日', content: 'hidden sibling-branch summary', votcCheckpointEpoch: 2, votcTimelineNodeId: '2-2' }
        ]);
        writeRaw('senderB', [
            { id: 'b1', date: '1100年1月5日', content: 'other sender summary', votcCheckpointEpoch: 2, votcTimelineNodeId: '2-2' }
        ]);

        // Mirrors IncomingLetterGenerator.saveSummary: read the visible set for
        // the current branch, prepend the freshly generated letter summary.
        const visible = await readSummaryFile(userDataPath, 'p1', 2, registry, '2-1');
        expect(visible.map(s => s.id)).toEqual(['a1']);

        const newSummary: Summary = {
            characterId: 'senderA',
            date: '1100年3月1日',
            content: '[主动来信·下属奏折·1100年3月1日] new letter',
            votcCheckpointEpoch: 3,
            votcTimelineNodeId: '2-1',
            id: 'summary_2-1_1'
        };
        await saveSummaryFile(userDataPath, 'p1', [newSummary, ...visible], 3, {
            registry,
            currentNodeId: '2-1'
        });

        // The hidden sibling-branch record survives the save.
        const senderAIds = readRaw('senderA').map((s: any) => s.id).sort();
        expect(senderAIds).toEqual(['a1', 'a2', 'summary_2-1_1']);

        // The other sender's file is neither deleted nor rewritten.
        expect(fs.existsSync(path.join(summaryDir, 'senderB.json'))).toBe(true);
        expect(readRaw('senderB').map((s: any) => s.id)).toEqual(['b1']);

        // Reading the sibling branch still shows its own records.
        const siblingView = await readSummaryFile(userDataPath, 'p1', 2, registry, '2-2');
        expect(siblingView.map(s => s.id).sort()).toEqual(['a1', 'a2', 'b1']);
    });

    it('still preserves hidden records when the registry is unavailable (merge path opt-in)', async () => {
        writeRaw('senderA', [
            { id: 'a1', date: '1100年1月1日', content: 'node summary', votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' }
        ]);

        // Registry load failed: the read is fail-closed and returns nothing,
        // but the merge save must not wipe the on-disk record.
        const visible = await readSummaryFile(userDataPath, 'p1', 1);
        expect(visible).toHaveLength(0);

        const newSummary: Summary = {
            characterId: 'senderA',
            date: '1100年2月1日',
            content: 'replacement-visible-set summary',
            votcCheckpointEpoch: 2,
            votcTimelineNodeId: '1-1',
            id: 'a-new'
        };
        await saveSummaryFile(userDataPath, 'p1', [newSummary, ...visible], 2, {
            registry: undefined,
            currentNodeId: undefined
        });

        expect(readRaw('senderA').map((s: any) => s.id).sort()).toEqual(['a-new', 'a1']);
    });

    it('replaceVisibleContext deletes only records visible in the current context', () => {
        const registry = makeRegistry();
        const existing = [
            { id: 'vis', date: '1100年1月1日', content: 'visible', votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' },
            { id: 'hid', date: '1100年2月1日', content: 'hidden', votcCheckpointEpoch: 2, votcTimelineNodeId: '2-2' }
        ];

        const merged = mergeSummariesForTimelineSave([], existing, 2, {
            registry,
            currentNodeId: '2-1',
            replaceVisibleContext: true
        });
        expect(merged.map((s: any) => s.id)).toEqual(['hid']);

        // Without replaceVisibleContext both records are preserved.
        const kept = mergeSummariesForTimelineSave([], existing, 2, { registry, currentNodeId: '2-1' });
        expect(kept.map((s: any) => s.id).sort()).toEqual(['hid', 'vis']);
    });

    it('keeps legacy whole-overwrite behavior for callers that pass no options', async () => {
        writeRaw('senderA', [
            { id: 'a1', date: '1100年1月1日', content: 'old A', votcCheckpointEpoch: 1, votcTimelineNodeId: '1-1' }
        ]);
        writeRaw('senderB', [
            { id: 'b1', date: '1100年1月5日', content: 'old B', votcCheckpointEpoch: 1, votcTimelineNodeId: '2-2' }
        ]);
        fs.writeFileSync(path.join(summaryDir, '_character_map.json'), JSON.stringify({ p1: 'Player' }), 'utf8');

        const incoming: Summary[] = [{
            characterId: 'senderA',
            date: '1100年3月1日',
            content: 'overwritten A',
            id: 'a-new'
        }];
        await saveSummaryFile(userDataPath, 'p1', incoming);

        // Whole overwrite for senderA, deletion for senderB, map untouched.
        expect(readRaw('senderA')).toEqual([{ date: '1100年3月1日', content: 'overwritten A', id: 'a-new' }]);
        expect(fs.existsSync(path.join(summaryDir, 'senderB.json'))).toBe(false);
        expect(fs.existsSync(path.join(summaryDir, '_character_map.json'))).toBe(true);
    });
});
