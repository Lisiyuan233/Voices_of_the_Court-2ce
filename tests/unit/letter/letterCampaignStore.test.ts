/**
 * F21 (letter-domain campaign isolation): the LetterManager chat-letter store
 * (writing-letter threads + letter summaries) must live under
 * votc_data/campaigns/<cid>/players/<pid>/letters/ when a campaign identity is
 * available, carry campaignId/nodeId/epoch lineage stamps, filter reads by the
 * timeline graph visibility (legacy records fall back to epoch semantics),
 * migrate the legacy flat store once, and keep both campaigns isolated.
 *
 * Covers: write layout + stamps, degraded legacy writes, visibility,
 * dual-campaign isolation, migration (idempotent / playerId mismatch / corrupt
 * JSON fail-closed / ambiguous ownership).
 */
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => os.tmpdir()) }
}));

import { LetterManager } from '../../../src/main/letter/LetterManager';
import { Letter as ILetter, LetterType, LetterSummary } from '../../../src/main/letter/letterInterfaces';
import { Character } from '../../../src/shared/gameData/Character';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';
import type { TimelineRegistry } from '../../../src/main/timelineManager';
import { migrateFlatLetterStore } from '../../../src/main/letter/letterStoreMigration';
import { letterStoreMigrationMarkerPath, letterSummaryPath, letterThreadPath } from '../../../src/main/campaignDataPaths';
import type { LetterTimelineContext } from '../../../src/main/letter/letterTimelineContext';

const PLAYER_ID = '32769';
const AI_ID = '29171';

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
let caseIndex = 0;

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

function makeLetter(overrides: Partial<ILetter> = {}, letterCharacterId = AI_ID): ILetter {
    caseIndex += 1;
    const player = { id: Number(PLAYER_ID), fullName: 'Player One' } as unknown as Character;
    const ai = { id: Number(letterCharacterId), fullName: 'AI Two' } as unknown as Character;
    return {
        id: `letter-${caseIndex}-${Math.random().toString(36).slice(2)}`,
        sender: ai,
        recipient: player,
        subject: `letter_${caseIndex}`,
        content: `body ${caseIndex}`,
        timestamp: new Date('1066-09-25T12:00:00Z'),
        creationTimestamp: new Date('2026-09-01T10:00:00Z'),
        isRead: false,
        letterType: LetterType.PERSONAL,
        delay: 5,
        totalDays: 389340 + caseIndex,
        ...overrides
    };
}

function legacyThreadFile(letterCharacterId = AI_ID): string {
    return path.join(userData, 'votc_data', 'letter_history', PLAYER_ID, `${letterCharacterId}.json`);
}

function campaignThreadFile(identity: CampaignPlayerIdentity, letterCharacterId = AI_ID): string {
    return letterThreadPath(userData, identity, letterCharacterId);
}

function campaignSummaryFile(identity: CampaignPlayerIdentity, letterCharacterId = AI_ID): string {
    return letterSummaryPath(userData, identity, letterCharacterId);
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-letter-f21-'));
    LetterManager.getInstance().configure({ userDataDir: userData });
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('F21 letter thread store (campaign layout, stamps, degradation)', () => {
    it('saves letters into the campaign letters/threads layout with full lineage stamps', () => {
        const manager = LetterManager.getInstance();
        const ctx: LetterTimelineContext = {
            identity: identityA,
            checkpointEpoch: 5,
            currentNodeId: '10-20',
            currentParentNodeId: '1-2'
        };

        manager.saveLetter(makeLetter(), PLAYER_ID, ctx);

        const raw = JSON.parse(fs.readFileSync(campaignThreadFile(identityA), 'utf8'));
        expect(raw).toHaveLength(1);
        expect(raw[0].votcCampaignId).toBe(CAMPAIGN_A);
        expect(raw[0].votcTimelineNodeId).toBe('10-20');
        expect(raw[0].votcTimelineParentId).toBe('1-2');
        expect(raw[0].votcCheckpointEpoch).toBe(5);
        // No legacy file is created for campaign-scoped writes.
        expect(fs.existsSync(legacyThreadFile())).toBe(false);
    });

    it('keeps the campaign copy authoritative for caller-provided stamps', () => {
        const manager = LetterManager.getInstance();
        const ctx: LetterTimelineContext = {
            identity: identityA,
            checkpointEpoch: 7,
            currentNodeId: '30-40'
        };
        const letter = makeLetter({ votcCheckpointEpoch: 3, votcTimelineNodeId: '99-98' });
        manager.saveLetter(letter, PLAYER_ID, ctx);

        const raw = JSON.parse(fs.readFileSync(campaignThreadFile(identityA), 'utf8'));
        // Caller stamps win; only missing fields are filled in.
        expect(raw[0].votcCheckpointEpoch).toBe(3);
        expect(raw[0].votcTimelineNodeId).toBe('99-98');
        expect(raw[0].votcCampaignId).toBe(CAMPAIGN_A);
    });

    it('degrades to the legacy flat store (and stays readable) without an identity', () => {
        const manager = LetterManager.getInstance();
        const letter = makeLetter({ votcCheckpointEpoch: 4 });

        manager.saveLetter(letter, PLAYER_ID);

        const legacyRaw = JSON.parse(fs.readFileSync(legacyThreadFile(), 'utf8'));
        expect(legacyRaw).toHaveLength(1);
        expect(legacyRaw[0].votcCampaignId).toBeUndefined();
        expect(legacyRaw[0].votcTimelineNodeId).toBeUndefined();
        expect(fs.existsSync(path.join(userData, 'votc_data', 'campaigns'))).toBe(false);

        // Readable through the legacy view AND through a campaign context
        // (legacy fallback union) — a later identity must not hide old data.
        expect(manager.getLetters(PLAYER_ID, AI_ID)).toHaveLength(1);
        const withCtx = manager.getLetters(PLAYER_ID, AI_ID, undefined, { identity: identityA, checkpointEpoch: 5 });
        expect(withCtx).toHaveLength(1);
    });

    it('filters anchored records by graph visibility and legacy records by epoch', () => {
        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('50-60', '100-200');
        const manager = LetterManager.getInstance();
        const ctx: LetterTimelineContext = {
            identity: identityA,
            checkpointEpoch: 5,
            registry,
            currentNodeId: '100-200'
        };

        manager.saveLetter(makeLetter({ subject: 'ancestor_letter' }, AI_ID), PLAYER_ID, {
            ...ctx, currentNodeId: '50-60'
        });
        manager.saveLetter(makeLetter({ subject: 'sibling_letter' }, AI_ID), PLAYER_ID, {
            ...ctx, currentNodeId: '77-88'
        });
        manager.saveLetter(makeLetter({ subject: 'current_letter' }, AI_ID), PLAYER_ID, ctx);

        // Legacy epoch-only records: one future, one past.
        writeJson(legacyThreadFile(), [
            makeLetter({ id: 'legacy-past', subject: 'legacy-past', votcCheckpointEpoch: 2 }),
            makeLetter({ id: 'legacy-future', subject: 'legacy-future', votcCheckpointEpoch: 9 })
        ]);

        const visible = manager.getLetters(PLAYER_ID, AI_ID, 5, ctx);
        const subjects = visible.map(l => l.subject).sort();
        // ancestor node: visible; sibling branch node: hidden;
        // legacy past epoch: visible; legacy future epoch: hidden.
        expect(subjects).toEqual(['ancestor_letter', 'current_letter', 'legacy-past']);

        // Context-less reads keep the pre-F21 unfiltered behavior for the
        // legacy store, and NEVER leak campaign-scoped records (isolation).
        const contextLess = manager.getLetters(PLAYER_ID, AI_ID);
        expect(contextLess.map(l => l.subject).sort()).toEqual(['legacy-future', 'legacy-past']);
    });

    it('keeps two campaigns isolated from each other', () => {
        const manager = LetterManager.getInstance();
        manager.saveLetter(makeLetter({ subject: 'a_letter' }), PLAYER_ID, { identity: identityA, checkpointEpoch: 5 });
        manager.saveLetter(makeLetter({ subject: 'b_letter' }), PLAYER_ID, { identity: identityB, checkpointEpoch: 5 });

        const seenByA = manager.getAllLetters(PLAYER_ID, undefined, { identity: identityA, checkpointEpoch: 5 });
        const seenByB = manager.getAllLetters(PLAYER_ID, undefined, { identity: identityB, checkpointEpoch: 5 });
        expect(seenByA.map(l => l.subject)).toEqual(['a_letter']);
        expect(seenByB.map(l => l.subject)).toEqual(['b_letter']);
    });
});

describe('F21 letter summary store (campaign layout + stamps)', () => {
    it('saves summaries into the campaign letters/summaries layout with stamps', () => {
        const manager = LetterManager.getInstance();
        const { registry, registerParentChild } = makeRegistryMock();
        registerParentChild('1-2', '10-20');
        const ctx: LetterTimelineContext = {
            identity: identityA,
            checkpointEpoch: 5,
            registry,
            currentNodeId: '10-20'
        };
        const summary: LetterSummary = {
            id: 'sum-1',
            date: '1066.9.25',
            summary: 'exchanged letters',
            letterIds: ['letter-1']
        };

        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [summary], ctx);

        const raw = JSON.parse(fs.readFileSync(campaignSummaryFile(identityA), 'utf8'));
        expect(raw).toHaveLength(1);
        expect(raw[0].votcCampaignId).toBe(CAMPAIGN_A);
        expect(raw[0].votcTimelineNodeId).toBe('10-20');
        expect(raw[0].votcCheckpointEpoch).toBe(5);

        const readBack = manager.getLetterSummaries(PLAYER_ID, AI_ID, undefined, ctx);
        expect(readBack).toHaveLength(1);
        expect(readBack[0].summary).toBe('exchanged letters');

        // Fail-closed: a node-tagged summary is hidden when no registry is
        // available in the read context (conversationHistory semantics).
        const registryLess = manager.getLetterSummaries(PLAYER_ID, AI_ID, undefined, {
            identity: identityA,
            checkpointEpoch: 5,
            currentNodeId: '10-20'
        });
        expect(registryLess).toHaveLength(0);
    });

    it('keeps legacy summary writes working without an identity', () => {
        const manager = LetterManager.getInstance();
        const summary: LetterSummary = { id: 'sum-2', date: '1066.9.25', summary: 'old', letterIds: [] };
        manager.saveLetterSummaries(PLAYER_ID, AI_ID, [summary]);

        const legacyPath = path.join(userData, 'votc_data', 'letter_summaries', PLAYER_ID, `${AI_ID}.json`);
        expect(fs.existsSync(legacyPath)).toBe(true);
        expect(manager.getLetterSummaries(PLAYER_ID, AI_ID)).toHaveLength(1);
    });
});

describe('F21 flat letter-store migration', () => {
    it('migrates flat threads and summaries once, with backup and marker (idempotent)', async () => {
        writeJson(legacyThreadFile(), [makeLetter({ id: 'legacy-1' })]);
        writeJson(path.join(userData, 'votc_data', 'letter_summaries', PLAYER_ID, `${AI_ID}.json`), [
            { id: 'legacy-sum-1', date: '1066.9.1', summary: 'old summary', letterIds: ['legacy-1'] }
        ]);

        const result = await migrateFlatLetterStore(userData, identityA);
        expect(result.status).toBe('migrated');
        expect(result.migratedThreadFiles).toBe(1);
        expect(result.migratedSummaryFiles).toBe(1);

        // Campaign copies exist; flat copies are gone; backup + marker exist.
        expect(JSON.parse(fs.readFileSync(campaignThreadFile(identityA), 'utf8'))[0].id).toBe('legacy-1');
        expect(JSON.parse(fs.readFileSync(campaignSummaryFile(identityA), 'utf8'))[0].id).toBe('legacy-sum-1');
        expect(fs.existsSync(legacyThreadFile())).toBe(false);
        expect(fs.existsSync(letterStoreMigrationMarkerPath(userData, identityA))).toBe(true);
        const backupsRoot = path.join(userData, 'votc_data', 'legacy_backups');
        expect(fs.existsSync(backupsRoot)).toBe(true);
        const stampDirs = fs.readdirSync(backupsRoot);
        expect(stampDirs).toHaveLength(1);
        const backupFiles = fs.readdirSync(path.join(backupsRoot, stampDirs[0], 'letter_history', PLAYER_ID));
        expect(backupFiles).toEqual([`${AI_ID}.json`]);

        // Second run: marker short-circuits.
        const second = await migrateFlatLetterStore(userData, identityA);
        expect(second.status).toBe('already-migrated');

        // A later degraded legacy write is NOT re-migrated (no churn).
        writeJson(legacyThreadFile(), [makeLetter({ id: 'degraded-1' })]);
        const third = await migrateFlatLetterStore(userData, identityA);
        expect(third.status).toBe('already-migrated');
        expect(fs.existsSync(legacyThreadFile())).toBe(true);
        // ... but it stays readable through the legacy fallback of the campaign view.
        const manager = LetterManager.getInstance();
        const visible = manager.getLetters(PLAYER_ID, AI_ID, undefined, { identity: identityA, checkpointEpoch: 5 });
        expect(visible.map(l => l.id).sort()).toEqual(['degraded-1', 'legacy-1']);
    });

    it('leaves flat stores of other players untouched', async () => {
        const otherPlayerThread = path.join(userData, 'votc_data', 'letter_history', '9999', `${AI_ID}.json`);
        writeJson(otherPlayerThread, [makeLetter({ id: 'other-1' })]);

        const result = await migrateFlatLetterStore(userData, identityA);
        expect(result.status).toBe('no-flat-data');
        expect(JSON.parse(fs.readFileSync(otherPlayerThread, 'utf8'))[0].id).toBe('other-1');
    });

    it('fails closed on corrupt JSON: file stays, marker is not written, valid files migrate', async () => {
        const corruptFile = path.join(userData, 'votc_data', 'letter_history', PLAYER_ID, 'broken.json');
        writeJson(legacyThreadFile(), [makeLetter({ id: 'legacy-ok' })]);
        fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
        fs.writeFileSync(corruptFile, '{not json', 'utf8');

        const result = await migrateFlatLetterStore(userData, identityA);
        expect(result.status).toBe('partial');
        expect(result.migratedThreadFiles).toBe(1);
        expect(result.skippedCorruptFiles).toBe(1);
        expect(fs.existsSync(corruptFile)).toBe(true);
        expect(fs.existsSync(letterStoreMigrationMarkerPath(userData, identityA))).toBe(false);

        // Retry (no marker) keeps failing closed on the corrupt file only.
        const retry = await migrateFlatLetterStore(userData, identityA);
        expect(retry.status).toBe('partial');
        expect(fs.existsSync(corruptFile)).toBe(true);
    });

    it('refuses to claim a flat store that another campaign may own (ambiguous)', async () => {
        writeJson(legacyThreadFile(), [makeLetter({ id: 'ambiguous-1' })]);
        // Another campaign already owns letter data for this player.
        writeJson(campaignThreadFile(identityB, '12345'), [makeLetter({ id: 'b-1' })]);

        const result = await migrateFlatLetterStore(userData, identityA);
        expect(result.status).toBe('ambiguous');
        expect(fs.existsSync(legacyThreadFile())).toBe(true);
        expect(fs.existsSync(campaignThreadFile(identityA))).toBe(false);
        // The flat data remains readable as the legacy fallback.
        const manager = LetterManager.getInstance();
        expect(manager.getLetters(PLAYER_ID, AI_ID, undefined, { identity: identityA })).toHaveLength(1);
    });
});

describe('F21 player listing across stores', () => {
    it('lists campaign players for the all-campaigns scan and the active scope', async () => {
        const manager = LetterManager.getInstance();
        manager.saveLetter(makeLetter(), PLAYER_ID, { identity: identityA, checkpointEpoch: 5 });

        const allIds = manager.getAllPlayerIdsWithLetters('all').map(p => p.id);
        expect(allIds).toContain(PLAYER_ID);

        LetterManager.getInstance().configure({
            userDataDir: userData,
            resolveContext: () => ({ identity: identityA, checkpointEpoch: 5 })
        });
        const activeIds = manager.getAllPlayerIdsWithLetters('active').map(p => p.id);
        expect(activeIds).toContain(PLAYER_ID);
    });
});
