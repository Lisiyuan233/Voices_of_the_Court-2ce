/**
 * R1 (letter-body vs diagnostic parsing): the letters log parser must import
 * only genuine letter-body lines. The app's own delivery diagnostics
 * (timeline_applied / timeline_skipped_* / run_skipped) carry just three
 * payload fields and used to crash the import with
 * `Cannot read properties of undefined (reading 'trim')` when they lingered
 * in the last 1 MB of debug.log.
 *
 * Covers: the exact diagnostic shapes from letterRunScript.ts (with engine
 * prefix + CRLF), a truncated three-field line, and a valid body line still
 * importing normally next to them.
 */
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => os.tmpdir()) }
}));

import { parseLettersFromLog } from '../../../src/main/letter/parseLogForLetters';
import { LetterManager } from '../../../src/main/letter/LetterManager';
import { Letter as ILetter, LetterType } from '../../../src/main/letter/letterInterfaces';
import { Character } from '../../../src/shared/gameData/Character';
import { GameData } from '../../../src/shared/gameData/GameData';

const PLAYER_ID = '32769';
const AI_ID = '29171';

function makeCharacter(id: number, name: string): Character {
    return { id, fullName: name } as unknown as Character;
}

function makeGameData(): GameData {
    return {
        playerID: Number(PLAYER_ID),
        totalDays: 389340,
        votcCheckpointEpoch: 3,
        gameDate: { totalDays: 389340 },
        characters: new Map([
            [Number(PLAYER_ID), makeCharacter(Number(PLAYER_ID), 'Player One')],
            [Number(AI_ID), makeCharacter(Number(AI_ID), 'AI Two')]
        ])
    } as unknown as GameData;
}

function writeLog(content: string): string {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'votc-letter-log-')), 'debug.log');
    fs.writeFileSync(logPath, content, 'utf8');
    return logPath;
}

let userData: string;

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-letter-log-store-'));
    LetterManager.getInstance().configure({ userDataDir: userData });
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('parseLettersFromLog body/diagnostic separation (R1)', () => {
    it('ignores every app-generated diagnostic shape without throwing', async () => {
        const logPath = writeLog([
            '[12:00:00][D][effect]: VOTC:LETTER/;/run_skipped/;/letter_1/;/389340',
            '[12:00:00][D][effect]: VOTC:LETTER/;/timeline_applied/;/letter_1/;/389340',
            '[12:00:00][D][effect]: VOTC:LETTER/;/timeline_skipped_advanced/;/letter_1/;/389340',
            '[12:00:00][D][effect]: VOTC:LETTER/;/timeline_skipped_mismatch/;/letter_1/;/389340',
            ''
        ].join('\r\n'));

        const letters = await parseLettersFromLog(logPath, makeGameData(), '1066.9.25', PLAYER_ID, AI_ID);
        expect(letters).toHaveLength(0);
    });

    it('imports a valid body line next to diagnostic and truncated lines', async () => {
        const logPath = writeLog([
            '[12:00:00][D][effect]: VOTC:LETTER/;/run_skipped/;/letter_1/;/389340',
            '[12:00:00][D][effect]: VOTC:LETTER/;/half-written/;/letter_3/;/389340',
            '[12:00:01][D][effect]: VOTC:LETTER/;/expected-body/;/letter_2/;/389340/;/5/;/',
            ''
        ].join('\r\n'));

        const letters = await parseLettersFromLog(logPath, makeGameData(), '1066.9.25', PLAYER_ID, AI_ID);
        expect(letters).toHaveLength(1);
        expect(letters[0].content).toBe('expected-body');
        expect(letters[0].subject).toBe('letter_2');
        expect(letters[0].delay).toBe(5);
        expect(letters[0].sender.id).toBe(Number(PLAYER_ID));
        expect(letters[0].recipient.id).toBe(Number(AI_ID));
        expect(letters[0].votcCheckpointEpoch).toBe(3);
    });

    it('keeps the imported letter in the letter store', async () => {
        const logPath = writeLog('[12:00:01][D][effect]: VOTC:LETTER/;/expected-body/;/letter_2/;/389340/;/5/;/\r\n');

        const letters: ILetter[] = await parseLettersFromLog(logPath, makeGameData(), '1066.9.25', PLAYER_ID, AI_ID);
        expect(letters).toHaveLength(1);

        const stored = LetterManager.getInstance().getLetters(PLAYER_ID, AI_ID);
        expect(stored.some(l => l.subject === 'letter_2' && l.content === 'expected-body')).toBe(true);
    });
});
