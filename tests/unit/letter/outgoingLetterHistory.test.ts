import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

// conversationHistory resolves the user-data dir through electron at call
// time; os.tmpdir() keeps the campaign store the test writes isolated from
// any real user data.
jest.mock('electron', () => ({
    app: {
        getPath: jest.fn(() => os.tmpdir())
    }
}));

import { saveOutgoingLetterHistoryRecord } from '../../../src/main/conversationHistory';
import type { LetterHistoryRecordV1 } from '../../../src/main/history/historyRecordTypes';
import type { CampaignPlayerIdentity } from '../../../src/shared/gameData/CampaignIdentity';

const CAMPAIGN_ID = '111111111-222222222-333333333-444444444';
const identity: CampaignPlayerIdentity = {
    protocolSchema: 2,
    campaignSchema: 1,
    campaignId: CAMPAIGN_ID,
    campaignParts: { a: 111111111, b: 222222222, c: 333333333, d: 444444444 },
    playerId: '32769'
};

// Each case uses its own receiver id so the per-correspondent history files
// never share state across tests.
let receiverId: string;
let caseIndex = 0;

function buildRecord(nodeId: string, letterId = 'letter-uuid-1'): LetterHistoryRecordV1 {
    return {
        schemaVersion: 1,
        sourceRecordId: 'source-record-1',
        kind: 'outgoing_letter',
        createdAt: '2026-08-31T15:40:14.038Z',
        gameDate: { totalDays: 389357, year: 1066, month: 9, day: 25, display: '1066.09.25' },
        displayDate: '1066.09.25',
        anchor: {
            campaignId: identity.campaignId,
            playerId: identity.playerId,
            votcCheckpointEpoch: 5,
            votcTimelineNodeId: nodeId
        },
        characters: [],
        votcCheckpointEpoch: 5,
        votcTimelineNodeId: nodeId,
        letterId,
        deliveryId: 389340,
        senderId: '32769',
        senderName: 'Player',
        receiverId,
        receiverName: 'Correspondent',
        outgoingBody: 'My letter',
        replyBody: 'AI reply',
        sourceType: 'letter',
        playerName: 'Player',
        aiName: 'Correspondent',
        playerLetter: 'My letter',
        aiReply: 'AI reply'
    };
}

function historyFilePath(): string {
    return path.join(
        os.tmpdir(), 'votc_data', 'campaigns', CAMPAIGN_ID, 'players', identity.playerId,
        'letter_history', `character_${receiverId}.json`
    );
}

beforeEach(() => {
    receiverId = String(29171 + caseIndex);
    caseIndex += 1;
});

afterAll(() => {
    fs.rmSync(path.join(os.tmpdir(), 'votc_data', 'campaigns', CAMPAIGN_ID), { recursive: true, force: true });
});

describe('saveOutgoingLetterHistoryRecord (T5 letter history wiring)', () => {
    it('writes the record into the campaign-scoped letter history layout', async () => {
        await saveOutgoingLetterHistoryRecord(buildRecord('10-20'), identity);

        const raw = JSON.parse(fs.readFileSync(historyFilePath(), 'utf8'));
        expect(Array.isArray(raw)).toBe(true);
        expect(raw).toHaveLength(1);
        expect(raw[0].kind).toBe('outgoing_letter');
        expect(raw[0].votcTimelineNodeId).toBe('10-20');
    });

    it('is idempotent per letterId + deliveryId + timeline node', async () => {
        await saveOutgoingLetterHistoryRecord(buildRecord('30-40'), identity);
        await saveOutgoingLetterHistoryRecord(buildRecord('30-40'), identity);

        const raw = JSON.parse(fs.readFileSync(historyFilePath(), 'utf8'));
        expect(raw).toHaveLength(1);
    });

    it('keeps a redelivered letter whose timeline node differs', async () => {
        await saveOutgoingLetterHistoryRecord(buildRecord('50-60'), identity);
        await saveOutgoingLetterHistoryRecord(buildRecord('50-61'), identity);

        const raw = JSON.parse(fs.readFileSync(historyFilePath(), 'utf8'));
        expect(raw).toHaveLength(2);
        const nodes = raw.map((r: { votcTimelineNodeId: string }) => r.votcTimelineNodeId).sort();
        expect(nodes).toEqual(['50-60', '50-61']);
    });
});
