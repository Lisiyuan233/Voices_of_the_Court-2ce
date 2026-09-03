import fs from 'fs';
import os from 'os';
import path from 'path';
import { processBookmarkToSummary } from '../../src/main/bookmarktosummary';
import { buildIdentityFromParts } from '../../src/shared/gameData/CampaignIdentity';

describe('processBookmarkToSummary', () => {
    let userDataDir: string;

    beforeEach(() => {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-bookmark-'));
        const scriptDir = path.join(userDataDir, 'votc_data', 'scripts', 'bookmarks');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(path.join(scriptDir, 'bookmark.json'), JSON.stringify([
            { characters: ['Target'], date: '1066.9.15', content: 'Imported bookmark.' }
        ]));
    });

    afterEach(() => {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    });

    it('writes matched summaries under the validated campaign and player directory', async () => {
        const identity = buildIdentityFromParts({ a: 101, b: 102, c: 103, d: 104 }, '123');

        await processBookmarkToSummary(
            {
                date: '1066.9.15',
                player: { id: '123', name: 'Player' },
                characters_in_bookmark: new Map([['456', 'Target']])
            },
            userDataDir,
            'bookmark.json',
            identity
        );

        const scopedPath = path.join(
            userDataDir,
            'votc_data',
            'campaigns',
            '101-102-103-104',
            'players',
            '123',
            'conversation_summaries',
            '456.json'
        );
        expect(JSON.parse(fs.readFileSync(scopedPath, 'utf8'))).toEqual([
            { date: '1066.9.15', content: 'Imported bookmark.' }
        ]);
        expect(fs.existsSync(path.join(
            userDataDir, 'votc_data', 'conversation_summaries', '123', '456.json'
        ))).toBe(false);
    });

    it('fails closed when the identity playerId does not match the bookmark data', async () => {
        const identity = buildIdentityFromParts({ a: 101, b: 102, c: 103, d: 104 }, '999');

        await expect(processBookmarkToSummary(
            {
                date: '1066.9.15',
                player: { id: '123', name: 'Player' },
                characters_in_bookmark: new Map([['456', 'Target']])
            },
            userDataDir,
            'bookmark.json',
            identity
        )).rejects.toThrow('Bookmark player mismatch');
    });
});
