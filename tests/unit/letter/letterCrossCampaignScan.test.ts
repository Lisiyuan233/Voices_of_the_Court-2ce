/**
 * R4 (cross-campaign scan keying) + R5 (delivered-confirmation routing):
 *
 * - getAllLettersAcrossCampaigns must read every campaign's thread file for
 *   one player/character pair — a character-id-keyed map let later campaign
 *   directories shadow earlier ones, dropping campaign A's pending reply
 *   from the startup rehydration scan.
 * - markAsDelivered must reach the record through the context captured with
 *   the reply (its own campaign namespace), not the mutable current
 *   conversation identity.
 * - buildLetterContextFromRecord rebuilds that routing context from the
 *   record's lineage stamps.
 */
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => os.tmpdir()) }
}));

import { LetterManager } from '../../../src/main/letter/LetterManager';
import { Letter as ILetter, LetterType } from '../../../src/main/letter/letterInterfaces';
import { Character } from '../../../src/shared/gameData/Character';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';
import { buildLetterContextFromRecord } from '../../../src/main/letter/letterTimelineContext';
import { letterThreadPath } from '../../../src/main/campaignDataPaths';

const PLAYER_ID = '32769';
const AI_ID = '29171';
const CAMPAIGN_A = '111111111-222222222-333333333-444444444';
const CAMPAIGN_B = '999999999-888888888-777777777-666666666';

function makeIdentity(campaignId: string, playerId = PLAYER_ID): CampaignPlayerIdentity {
    return {
        protocolSchema: 2,
        campaignSchema: 1,
        campaignId,
        campaignParts: campaignId === CAMPAIGN_A
            ? { a: 111111111, b: 222222222, c: 333333333, d: 444444444 }
            : { a: 999999999, b: 888888888, c: 777777777, d: 666666666 },
        playerId
    } as CampaignPlayerIdentity;
}

const identityA = makeIdentity(CAMPAIGN_A);
const identityB = makeIdentity(CAMPAIGN_B);

let userData: string;
let caseIndex = 0;

function makeLetter(overrides: Partial<ILetter> = {}): ILetter {
    caseIndex += 1;
    const player = { id: Number(PLAYER_ID), fullName: 'Player One' } as unknown as Character;
    const ai = { id: Number(AI_ID), fullName: 'AI Two' } as unknown as Character;
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

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-letter-r4r5-'));
    LetterManager.getInstance().configure({ userDataDir: userData });
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('getAllLettersAcrossCampaigns reads every campaign file (R4)', () => {
    it('returns letters from the legacy store and from all campaigns for one character', () => {
        const manager = LetterManager.getInstance();
        const legacyLetter = makeLetter({ content: 'legacy' });
        const replyA = makeLetter({ content: 'reply-A' });
        const replyB = makeLetter({ content: 'reply-B' });

        writeJson(path.join(userData, 'votc_data', 'letter_history', PLAYER_ID, `${AI_ID}.json`), [legacyLetter]);
        writeJson(letterThreadPath(userData, identityA, AI_ID), [replyA]);
        writeJson(letterThreadPath(userData, identityB, AI_ID), [replyB]);

        const all = manager.getAllLettersAcrossCampaigns(PLAYER_ID);
        expect(all.map(l => l.content).sort()).toEqual(['legacy', 'reply-A', 'reply-B']);
    });

    it('keeps campaign A\'s pending reply discoverable for rehydration', () => {
        const manager = LetterManager.getInstance();
        const replyA = makeLetter({ content: 'reply-A', replyToId: 'orig-1', status: 'pending', delivered: false });
        const replyB = makeLetter({ content: 'reply-B' });
        writeJson(letterThreadPath(userData, identityA, AI_ID), [replyA]);
        writeJson(letterThreadPath(userData, identityB, AI_ID), [replyB]);

        const pending = manager.getAllLettersAcrossCampaigns(PLAYER_ID)
            .filter(l => !l.isPlayerSender && l.status === 'pending' && l.delivered === false && l.replyToId);
        expect(pending.map(l => l.content)).toEqual(['reply-A']);
    });
});

describe('markAsDelivered follows the captured context (R5)', () => {
    it('updates the record in the reply\'s own campaign store', () => {
        const manager = LetterManager.getInstance();
        const reply = { ...makeLetter({ replyToId: 'orig-1', status: 'pending' }), votcCampaignId: CAMPAIGN_A, votcCheckpointEpoch: 5 };
        manager.saveLetterThread(PLAYER_ID, AI_ID, [reply], { identity: identityA, checkpointEpoch: 5 });

        const rebuilt = buildLetterContextFromRecord(reply, PLAYER_ID);
        expect(rebuilt.identity?.campaignId).toBe(CAMPAIGN_A);
        expect(rebuilt.checkpointEpoch).toBe(5);

        manager.markAsDelivered(PLAYER_ID, AI_ID, reply.id, new Date('1066-10-01T12:00:00Z'), rebuilt);
        const raw = readJson(letterThreadPath(userData, identityA, AI_ID));
        expect(raw.find((l: ILetter) => l.id === reply.id).delivered).toBe(true);
    });

    it('does not touch the record when addressed with another campaign\'s context', () => {
        const manager = LetterManager.getInstance();
        const reply = { ...makeLetter({ replyToId: 'orig-1', status: 'pending', delivered: false }), votcCampaignId: CAMPAIGN_A, votcCheckpointEpoch: 5 };
        manager.saveLetterThread(PLAYER_ID, AI_ID, [reply], { identity: identityA, checkpointEpoch: 5 });

        const wrong = buildLetterContextFromRecord({ ...reply, votcCampaignId: CAMPAIGN_B }, PLAYER_ID);
        manager.markAsDelivered(PLAYER_ID, AI_ID, reply.id, new Date(), wrong);

        const raw = readJson(letterThreadPath(userData, identityA, AI_ID));
        expect(raw.find((l: ILetter) => l.id === reply.id).delivered).toBe(false);
        expect(fs.existsSync(letterThreadPath(userData, identityB, AI_ID))).toBe(false);
    });

    it('reaches legacy records through the epoch-only context', () => {
        const manager = LetterManager.getInstance();
        const reply = makeLetter({ replyToId: 'orig-1', status: 'pending' });
        manager.saveLetterThread(PLAYER_ID, AI_ID, [reply]);

        const rebuilt = buildLetterContextFromRecord(reply, PLAYER_ID);
        expect(rebuilt.identity).toBeUndefined();

        manager.markAsDelivered(PLAYER_ID, AI_ID, reply.id, new Date('1066-10-01T12:00:00Z'), rebuilt);
        const raw = readJson(path.join(userData, 'votc_data', 'letter_history', PLAYER_ID, `${AI_ID}.json`));
        expect(raw.find((l: ILetter) => l.id === reply.id).delivered).toBe(true);
    });
});
