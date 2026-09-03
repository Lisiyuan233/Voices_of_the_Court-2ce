import type { Character } from '../../shared/gameData/Character.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';
import type { Ck3GameDate } from '../../shared/gameData/gameDate.js';
import type { CreateChildNodeResult } from '../timelineManager.js';
import type {
    BattleCommander,
    BattleOutcome,
    BattleSide,
    BattleSideResult,
    NotableBattleCharacter
} from './BattleReportGenerator.js';
import { captureHistoryCharacterSnapshots } from '../history/historyCharacterSnapshots.js';
import type { HistoryCharacterCandidate } from '../history/historyCharacterSnapshots.js';
import type { BattleReportHistoryRecordV1, HistoryCharacterRole } from '../history/historyRecordTypes.js';

/**
 * Pure builder for schema v1 battle report history records (plan task T7).
 * Emits the typed facts the Chronicle collector already reads (winnerId,
 * loserId, commanders, notableCharacters) and captures character snapshots
 * through the shared capture entry point: full when the current GameData has
 * the character object, reference_only for log-only references.
 */
export interface BuildBattleReportHistoryRecordInput {
    id: string;
    dedupKey: string;
    location: string;
    terrain?: string;
    winter?: string;
    result?: BattleOutcome;
    winningSide?: BattleSide;
    winnerId: string;
    winnerName: string;
    loserId: string;
    loserName: string;
    sideResults: BattleSideResult[];
    commanders: BattleCommander[];
    notableCharacters: NotableBattleCharacter[];
    tags: readonly string[];
    content: string;
    generationStatus: 'fallback' | 'generated';
    displayDate: string;
    gameDate: Ck3GameDate;
    checkpointEpoch: number;
    timeline: CreateChildNodeResult;
    identity: CampaignPlayerIdentity;
    sourceRecordId: string;
    /** Resolves full character objects loaded in the current GameData. */
    characterResolver: (characterId: number) => Character | undefined;
}

const NOTABLE_ROLE_BY_TYPE: Record<NotableBattleCharacter['type'], HistoryCharacterRole> = {
    slain_winner_side: 'battle_notable_slain_winner_side',
    slain_loser_side: 'battle_notable_slain_loser_side',
    captured_loser_side: 'battle_notable_captured_loser_side'
};

export function buildBattleReportHistoryRecord(
    input: BuildBattleReportHistoryRecordInput
): BattleReportHistoryRecordV1 {
    const capturedAt = new Date().toISOString();

    const candidates: HistoryCharacterCandidate[] = [];
    const pushCandidate = (
        characterId: string | null,
        displayName: string,
        role: HistoryCharacterRole
    ): void => {
        if (!characterId) return;
        candidates.push({
            characterId,
            displayName,
            roles: [role],
            character: input.characterResolver(Number(characterId)) ?? null,
            capturedAt,
            capturedGameDate: input.gameDate,
            completeness: 'reference_allowed'
        });
    };

    pushCandidate(input.winnerId, input.winnerName, 'battle_winner');
    pushCandidate(input.loserId, input.loserName, 'battle_loser');
    for (const commander of input.commanders) {
        pushCandidate(
            commander.id,
            commander.name,
            commander.side === 'winner' ? 'battle_commander_winner' : 'battle_commander_loser'
        );
    }
    for (const notable of input.notableCharacters) {
        pushCandidate(notable.id, notable.name, NOTABLE_ROLE_BY_TYPE[notable.type]);
    }

    const characters = captureHistoryCharacterSnapshots(candidates);

    const anchor = {
        campaignId: input.identity.campaignId,
        playerId: input.identity.playerId,
        votcCheckpointEpoch: input.checkpointEpoch,
        votcTimelineNodeId: input.timeline.nodeId,
        ...(input.timeline.parentId ? { votcTimelineParentId: input.timeline.parentId } : {})
    };

    return {
        schemaVersion: 1,
        sourceRecordId: input.sourceRecordId,
        kind: 'battle_report',
        createdAt: capturedAt,
        gameDate: input.gameDate,
        displayDate: input.displayDate,
        anchor,
        characters,
        votcCheckpointEpoch: anchor.votcCheckpointEpoch,
        votcTimelineNodeId: anchor.votcTimelineNodeId,
        ...(anchor.votcTimelineParentId ? { votcTimelineParentId: anchor.votcTimelineParentId } : {}),
        id: input.id,
        dedupKey: input.dedupKey,
        location: input.location,
        ...(input.terrain !== undefined ? { terrain: input.terrain } : {}),
        ...(input.winter !== undefined ? { winter: input.winter } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.winningSide !== undefined ? { winningSide: input.winningSide } : {}),
        winnerId: input.winnerId,
        winnerName: input.winnerName,
        loserId: input.loserId,
        loserName: input.loserName,
        sideResults: input.sideResults.map(sideResult => ({ ...sideResult })),
        commanders: input.commanders.map(commander => ({ ...commander })),
        notableCharacters: input.notableCharacters.map(notable => ({ ...notable })),
        tags: [...new Set(input.tags)].sort(),
        content: input.content,
        generationStatus: input.generationStatus
    };
}

/**
 * Matches an existing history array entry against a dedup key using the same
 * rule the legacy writer used (dedupKey preferred, id as fallback).
 */
export function matchesBattleDedupKey(existing: unknown, dedupKey: string): boolean {
    const record = existing as { dedupKey?: unknown; id?: unknown } | null;
    if (!record || typeof record !== 'object') return false;
    const key = record.dedupKey ?? record.id;
    return typeof key === 'string' && key === dedupKey;
}

/**
 * Whether an entry is already a schema v1 battle report record.
 */
export function isBattleReportHistoryRecordV1(value: unknown): value is BattleReportHistoryRecordV1 {
    const record = value as { schemaVersion?: unknown; kind?: unknown } | null;
    return Boolean(
        record &&
        typeof record === 'object' &&
        record.schemaVersion === 1 &&
        record.kind === 'battle_report'
    );
}

/**
 * Final-LLM update semantics (plan section 6.7): only `content` and
 * `generationStatus` may change on an existing v1 record; anchor, facts,
 * snapshots and createdAt stay frozen.
 */
export function applyBattleReportContentUpdate(
    existing: BattleReportHistoryRecordV1,
    content: string,
    generationStatus: 'fallback' | 'generated'
): BattleReportHistoryRecordV1 {
    return {
        ...existing,
        content,
        generationStatus
    };
}
