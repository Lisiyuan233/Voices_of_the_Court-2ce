jest.mock('electron', () => ({
    app: { getPath: jest.fn() }
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import {
    applyBattleReportContentUpdate,
    buildBattleReportHistoryRecord,
    isBattleReportHistoryRecordV1,
    matchesBattleDedupKey
} from '../../src/main/battleReport/battleReportHistoryRecord';
import { parseBattleReportHistoryRecord } from '../../src/main/history/historyRecordSchemas';
import { collectChronicleSources } from '../../src/main/chronicle/ChronicleSourceCollector';
import { battleReportHistoryPath } from '../../src/main/campaignDataPaths';
import { buildIdentityFromParts } from '../../src/shared/gameData/CampaignIdentity';
import type { CampaignPlayerIdentity } from '../../src/shared/gameData/CampaignIdentity';
import type { Ck3GameDate } from '../../src/shared/gameData/gameDate';
import type { TimelineRegistry } from '../../src/main/timelineManager';

const IDENTITY: CampaignPlayerIdentity = buildIdentityFromParts({ a: 1, b: 2, c: 3, d: 4 }, '1001');
const GAME_DATE: Ck3GameDate = { totalDays: 500000, year: 1066, month: 10, day: 14, display: '1066.10.14' };
const TIMELINE = { nodeId: 'node-battle', parentId: 'node-parent', script: '', context: {}, createdNewRoot: false } as any;
const PERIOD_START: Ck3GameDate = { totalDays: 499000, year: 1066, month: 1, day: 1, display: '1066.1.1' };
const PERIOD_END: Ck3GameDate = { totalDays: 501000, year: 1067, month: 1, day: 1, display: '1067.1.1' };

function makeCharacterMap() {
    const characters = new Map<number, import('../../src/shared/gameData/Character').Character>();
    characters.set(1001, makeFullCharacter(1001, 'Player') as unknown as import('../../src/shared/gameData/Character').Character);
    characters.set(2002, makeFullCharacter(2002, 'Alice') as unknown as import('../../src/shared/gameData/Character').Character);
    return characters;
}

function makeFullCharacter(id: number, shortName: string) {
    return {
        id,
        shortName,
        fullName: shortName,
        firstName: shortName,
        primaryTitle: 'Count',
        titleRankConcept: 'county',
        sheHe: 'he',
        age: 30,
        gold: 10,
        opinionOfPlayer: 0,
        sexuality: '',
        personality: '',
        greed: 0,
        isIndependentRuler: false,
        isRuler: true,
        isLandedRuler: true,
        isKnight: false,
        prowess: 5,
        liege: '',
        topLiege: '',
        consort: '',
        culture: '',
        faith: '',
        house: '',
        capitalLocation: '',
        liegeRealmLaw: '',
        heldCourtAndCouncilPositions: '',
        secrets: [],
        ownedSecrets: [],
        knownSecrets: [],
        ownedSchemes: [],
        exposedTargetingSchemes: [],
        memories: [],
        traits: [],
        relationsToPlayer: [],
        relationsToCharacters: [],
        opinionBreakdownToPlayer: [],
        opinions: []
    };
}

function builderInput(overrides: Record<string, unknown> = {}) {
    const characters = makeCharacterMap();
    return {
        id: 'battle_sig_1',
        dedupKey: 'battle_sig_1@node-battle',
        location: 'Hastings',
        terrain: 'hills',
        winter: 'none',
        result: 'victory' as const,
        winningSide: 'attacker' as const,
        winnerId: '1001',
        winnerName: 'Player',
        loserId: '3003',
        loserName: 'Unknown Warlord',
        sideResults: [
            { participantId: '1001', initialTroops: 200, lostTroops: 20, survivingTroops: 180 },
            { participantId: '3003', initialTroops: 150, lostTroops: 150, survivingTroops: 0 }
        ],
        commanders: [
            { side: 'winner' as const, id: '1001', name: 'Player' }
        ],
        notableCharacters: [
            { type: 'slain_loser_side' as const, id: '4004', name: 'Fallen Knight' }
        ],
        tags: ['wipe', 'outnumbered_victory'],
        content: 'A decisive battle.',
        generationStatus: 'fallback' as const,
        displayDate: '1066.10.14',
        gameDate: GAME_DATE,
        checkpointEpoch: 4,
        timeline: TIMELINE,
        identity: IDENTITY,
        sourceRecordId: randomUUID(),
        characterResolver: (characterId: number) => characters.get(characterId),
        ...overrides
    };
}

describe('buildBattleReportHistoryRecord (T7)', () => {
    it('persists winner and loser ids plus full battle facts', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        expect(record.winnerId).toBe('1001');
        expect(record.loserId).toBe('3003');
        expect(record.location).toBe('Hastings');
        expect(record.result).toBe('victory');
        expect(record.winningSide).toBe('attacker');
        expect(record.sideResults).toHaveLength(2);
        expect(record.tags).toEqual(['outnumbered_victory', 'wipe']);
        expect(record.generationStatus).toBe('fallback');
    });

    it('captures a full snapshot for loaded characters and reference_only for log-only ones', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        const winner = record.characters.find(c => c.characterId === '1001');
        const unknownWarlord = record.characters.find(c => c.characterId === '3003');
        expect(winner?.status).toBe('full');
        expect(winner?.snapshot?.id).toBe(1001);
        // The loser only appears as an id/name pair in the log.
        expect(unknownWarlord?.status).toBe('reference_only');
        expect(unknownWarlord?.displayName).toBe('Unknown Warlord');
        expect(unknownWarlord?.snapshotHash).toBeNull();
        expect(record.characters.every(c => /^[0-9a-f]{64}$|null/.test(String(c.snapshotHash)))).toBe(true);
    });

    it('accepts log-parsed memories lacking participantIds/identityComplete (incoming-letter capture path)', () => {
        // 2CE memory log lines carry no participant list, so parseLog produces
        // memories with both fields undefined; the snapshot validator must
        // match the Memory type (both optional) instead of requiring them.
        const characters = makeCharacterMap();
        (characters.get(1001) as { memories: unknown[] }).memories.push({
            type: 'some_memory',
            creationDate: '1067.5.14',
            desc: 'Log-parsed memory without participant data',
            relevanceWeight: 50
        });
        const record = buildBattleReportHistoryRecord(builderInput({
            characterResolver: (characterId: number) => characters.get(characterId)
        }));
        const winner = record.characters.find(c => c.characterId === '1001');
        expect(winner?.status).toBe('full');
        expect(() => parseBattleReportHistoryRecord(record)).not.toThrow();
    });

    it('merges roles when the winner is also the winning commander', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        const winner = record.characters.find(c => c.characterId === '1001');
        expect(winner?.roles).toContain('battle_winner');
        expect(winner?.roles).toContain('battle_commander_winner');
        const fallen = record.characters.find(c => c.characterId === '4004');
        expect(fallen?.roles).toEqual(['battle_notable_slain_loser_side']);
    });

    it('produces JSON-serializable arrays without cycles that pass the schema v1 parser', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        expect(JSON.parse(JSON.stringify(record))).toEqual(record);
        expect(() => parseBattleReportHistoryRecord(record)).not.toThrow();
    });

    it('does not fabricate current identities for unknown participants', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        const unknownWarlord = record.characters.find(c => c.characterId === '3003');
        expect(unknownWarlord?.snapshot).toBeNull();
        expect(unknownWarlord?.unavailableReason).toBeDefined();
    });
});

describe('battle record update semantics (plan section 6.7)', () => {
    it('content updates preserve anchor, facts, snapshots and createdAt', () => {
        const fallbackRecord = buildBattleReportHistoryRecord(builderInput());
        const updated = applyBattleReportContentUpdate(
            fallbackRecord,
            'Final LLM prose.',
            'generated'
        );
        expect(updated.content).toBe('Final LLM prose.');
        expect(updated.generationStatus).toBe('generated');
        expect(updated.createdAt).toBe(fallbackRecord.createdAt);
        expect(updated.anchor).toEqual(fallbackRecord.anchor);
        expect(updated.characters).toEqual(fallbackRecord.characters);
        expect(updated.sideResults).toEqual(fallbackRecord.sideResults);
        expect(updated.sourceRecordId).toBe(fallbackRecord.sourceRecordId);
    });

    it('dedup matching handles v1 records, legacy ids and non-objects', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        expect(matchesBattleDedupKey(record, record.dedupKey)).toBe(true);
        expect(matchesBattleDedupKey({ id: 'battle_sig_1@other-node' }, 'battle_sig_1@node-battle')).toBe(false);
        expect(matchesBattleDedupKey(null, 'x')).toBe(false);
        expect(isBattleReportHistoryRecordV1(record)).toBe(true);
        expect(isBattleReportHistoryRecordV1({ id: 'legacy' })).toBe(false);
    });
});

describe('chronicle collector reads writer fields consistently (T7 step 7 regression)', () => {
    let userDataDir: string;

    beforeEach(() => {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-battle-writer-'));
        (app.getPath as jest.Mock).mockReturnValue(userDataDir);
    });

    afterEach(() => {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    });

    function makeRegistryMock(currentNodeId?: string): TimelineRegistry {
        const parents = new Map<string, string>();
        return {
            isRecordVisible(recordNodeId: string | undefined, cur: string | undefined): boolean {
                if (!recordNodeId || !cur) return true;
                if (recordNodeId === cur) return true;
                let node: string | undefined = cur;
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
    }

    it('a record written by the builder feeds collector participants and character ids', () => {
        const record = buildBattleReportHistoryRecord(builderInput());
        const file = battleReportHistoryPath(userDataDir, IDENTITY);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify([record]), 'utf8');

        const sources = collectChronicleSources({
            userDataDir: userDataDir,
            identity: IDENTITY,
            playerId: '1001',
            registry: makeRegistryMock('node-battle'),
            currentNodeId: 'node-battle',
            checkpointEpoch: 4,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            firstBackfill: false
        });

        const battleSource = sources.find(s => s.kind === 'battle_report');
        expect(battleSource).toBeDefined();
        expect(battleSource!.title).toBe('Hastings');
        expect(battleSource!.rawText).toBe('A decisive battle.');
        expect(battleSource!.participants.map(p => p.id)).toEqual(expect.arrayContaining(['1001']));
        expect(battleSource!.participants.map(p => p.name)).toEqual(expect.arrayContaining(['Player']));
        expect(battleSource!.battleReportCharacterIds).toEqual(
            expect.arrayContaining(['1001', '3003', '4004'])
        );
    });
});
