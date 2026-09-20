/**
 * R3 (letter-summary branch preservation): saving the summaries visible in
 * the current context must never delete sibling-branch records that are
 * hidden right now but live in the same store file. Both write flows (the
 * reply-generation append and the user-managed save-all) hand in only the
 * visible subset, so LetterManager.saveLetterSummaries merges against the
 * disk records: the incoming set replaces the visible subset, hidden records
 * survive, and deleting a record the caller could see still takes effect.
 *
 * Acceptance shape from the review: A → 回档 → B → 回到 A keeps both branch
 * summaries in the file.
 */
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => os.tmpdir()) }
}));

import { LetterManager } from '../../../src/main/letter/LetterManager';
import { LetterSummary } from '../../../src/main/letter/letterInterfaces';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';
import type { TimelineRegistry } from '../../../src/main/timelineManager';
import type { LetterTimelineContext } from '../../../src/main/letter/letterTimelineContext';
import { letterSummaryPath } from '../../../src/main/campaignDataPaths';

const PLAYER_ID = '32769';
const AI_ID = '29171';
const CAMPAIGN_A = '111111111-222222222-333333333-444444444';

function makeIdentity(campaignId: string, playerId = PLAYER_ID): CampaignPlayerIdentity {
    return {
        protocolSchema: 2,
        campaignSchema: 1,
        campaignId,
        campaignParts: { a: 111111111, b: 222222222, c: 333333333, d: 444444444 },
        playerId
    } as CampaignPlayerIdentity;
}

const identityA = makeIdentity(CAMPAIGN_A);

let userData: string;

/**
 * Same registry mock shape as letterCampaignStore.test.ts: a record tagged
 * with node X is visible from node Y only when X sits on Y's ancestor chain.
 */
function makeRegistryMock(): { registry: TimelineRegistry; registerParentChild(parentId: string, childId: string): void } {
    const parents = new Map<string, string>();
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

function summaryFile(): string {
    return letterSummaryPath(userData, identityA, AI_ID);
}

function readDisk(): Array<{ id: string }> {
    return JSON.parse(fs.readFileSync(summaryFile(), 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-letter-summ-r3-'));
    LetterManager.getInstance().configure({ userDataDir: userData });
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('saveLetterSummaries keeps hidden sibling-branch records (R3)', () => {
    it('preserves the hidden branch summary when saving on a sibling branch', () => {
        const manager = LetterManager.getInstance();
        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('1-2', '10-20'); // branch A node
        registerParentChild('1-2', '30-40'); // branch B node

        const ctxA: LetterTimelineContext = { identity: identityA, checkpointEpoch: 5, registry, currentNodeId: '10-20' };
        const ctxB: LetterTimelineContext = { identity: identityA, checkpointEpoch: 5, registry, currentNodeId: '30-40' };

        const parentSummary: LetterSummary = { id: 'sum-parent', date: '1066.9.20', summary: 'common ancestor', letterIds: ['l0'] };
        const branchASummary: LetterSummary = {
            id: 'sum-A', date: '1066.9.25', summary: 'branch-a exchange', letterIds: ['l1'],
            votcCampaignId: CAMPAIGN_A, votcTimelineNodeId: '10-20', votcCheckpointEpoch: 5
        };
        writeJson(summaryFile(), [branchASummary, parentSummary]);

        // On branch B only the common ancestor is visible.
        const visibleOnB = manager.getLetterSummaries(PLAYER_ID, AI_ID, undefined, ctxB);
        expect(visibleOnB.map(s => s.id)).toEqual(['sum-parent']);

        // Reply generation on branch B appends its own summary to the
        // visible set and saves it.
        const branchBSummary: LetterSummary = { id: 'sum-B', date: '1066.9.26', summary: 'branch-b exchange', letterIds: ['l2'] };
        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [branchBSummary, ...visibleOnB], ctxB);

        // The hidden branch-A record survived the write.
        expect(readDisk().map(s => s.id).sort()).toEqual(['sum-A', 'sum-B', 'sum-parent']);

        // Branch B still sees its own subset; back on branch A its record is
        // visible again.
        expect(manager.getLetterSummaries(PLAYER_ID, AI_ID, undefined, ctxB).map(s => s.id).sort())
            .toEqual(['sum-B', 'sum-parent']);
        expect(manager.getLetterSummaries(PLAYER_ID, AI_ID, undefined, ctxA).map(s => s.id).sort())
            .toEqual(['sum-A', 'sum-parent']);
    });

    it('still applies user deletions of visible records', () => {
        const manager = LetterManager.getInstance();
        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('1-2', '30-40');
        const ctxB: LetterTimelineContext = { identity: identityA, checkpointEpoch: 5, registry, currentNodeId: '30-40' };

        const parentSummary: LetterSummary = { id: 'sum-parent', date: '1066.9.20', summary: 'common ancestor', letterIds: ['l0'] };
        const branchBSummary: LetterSummary = {
            id: 'sum-B', date: '1066.9.26', summary: 'branch-b exchange', letterIds: ['l2'],
            votcCampaignId: CAMPAIGN_A, votcTimelineNodeId: '30-40', votcCheckpointEpoch: 5
        };
        writeJson(summaryFile(), [branchBSummary, parentSummary]);

        // The user deletes the visible branch-B record; the save-all flow
        // hands in the remaining visible set.
        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [parentSummary], ctxB);

        expect(readDisk().map(s => s.id).sort()).toEqual(['sum-parent']);
    });

    it('keeps plain overwrite semantics when no visibility context exists', () => {
        const manager = LetterManager.getInstance();
        const legacySummaryFile = path.join(userData, 'votc_data', 'letter_summaries', PLAYER_ID, `${AI_ID}.json`);
        const first: LetterSummary = { id: 'sum-1', date: '1066.9.20', summary: 'one', letterIds: [] };
        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [first]);
        expect(JSON.parse(fs.readFileSync(legacySummaryFile, 'utf8')).map((s: { id: string }) => s.id)).toEqual(['sum-1']);

        const second: LetterSummary = { id: 'sum-2', date: '1066.9.21', summary: 'two', letterIds: [] };
        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [second]);
        expect(JSON.parse(fs.readFileSync(legacySummaryFile, 'utf8')).map((s: { id: string }) => s.id)).toEqual(['sum-2']);
    });
});
