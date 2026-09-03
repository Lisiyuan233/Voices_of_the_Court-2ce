import { ApiConnection } from "../../shared/apiConnection";
import { Character } from "../../shared/gameData/Character";
import { Config } from "../../shared/Config";
import { GameData } from "../../shared/gameData/GameData";
import { MilitarySnapshot } from "../../shared/gameData/GameData";
import { readLastMilitarySnapshotFromLog, removeTooltip } from "../../shared/gameData/parseLog";
import { formatMilitaryBrief } from "../conversation/militaryBrief";
import { Message } from "../ts/conversation_interfaces";
import { getEffectivePrompts } from "../conversation/promptBuilder";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { randomUUID } from "crypto";
import { archiveFutureBattleReportHistoryForPlayer } from "../conversationHistory";
import { buildBattleReportRunScript, type BattleCommitTarget } from "./battleReportRunScript.js";
import {
    TimelineRegistryCorruptError,
    buildContextFromBattleCheckpoint,
    parseNodeId,
    type CreateChildNodeResult,
    type TimelineContext,
    type GameDataLike
} from '../timelineManager.js';
import {
    runBattleTimelineBatchTransition,
    type BattleBatchTransitionEntry
} from '../timelineBusinessWire.js';
import {
    coordinateBattlesBySnapshot,
    type BattleCoordinatorEntry
} from '../timelineCoordinator.js';
import {
    UnsupportedTimelineSchemaError,
    parseTimelineSnapshot,
    type ObservedTimelineState,
    type TimelineParseResult
} from '../../shared/gameData/timelineProtocol.js';
import { reportCorruptTimelineRegistry, reportUnsupportedTimelineSchema } from '../timelineRegistryRecovery.js';
import { consumeTimelineCommitResultsFromLog } from '../timelineCommitResult.js';
import { battleReportHistoryPath as campaignBattleReportHistoryPath } from '../campaignDataPaths.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';
import { parseBattleReportCampaignIdentityPayload } from './battleReportCampaignIdentity.js';
import { resolveBattleReportGameDate } from './battleReportGameDate.js';
import {
    applyBattleReportContentUpdate,
    buildBattleReportHistoryRecord,
    isBattleReportHistoryRecordV1,
    matchesBattleDedupKey
} from './battleReportHistoryRecord.js';
import { updateJsonArrayAtomic } from '../history/historyAtomicJson.js';

export type BattleOutcome = "victory" | "defeat";
export type BattleSide = "attacker" | "defender";
type CommanderSide = "winner" | "loser";
type NotableBattleCharacterType = "slain_loser_side" | "slain_winner_side" | "captured_loser_side";

export interface BattleCommander {
    side: CommanderSide;
    id: string;
    name: string;
}

export interface NotableBattleCharacter {
    type: NotableBattleCharacterType;
    id: string;
    name: string;
}

export interface BattleSideResult {
    participantId: string;
    initialTroops: number;
    lostTroops: number;
    survivingTroops: number;
}

interface BattleReportData {
    slotId: string;
    legacySingleSlot?: boolean;
    playerId: string;
    timelineCheckpoint?: TimelineParseResult;
    date: string;
    location: string;
    terrain?: string;
    winter?: string;
    winnerId: string;
    winnerName: string;
    loserId: string;
    loserName: string;
    delayDays: number;
    percentEnemiesKilled?: number;
    totalTroops?: number;
    troopsRatio?: number;
    enemiesKilled?: number;
    result?: BattleOutcome;
    winningSide?: BattleSide;
    sideResults: BattleSideResult[];
    commanders: BattleCommander[];
    notableCharacters: NotableBattleCharacter[];
    tags: Set<string>;
    /**
     * §10.1: Mod-emitted per-battle occurrence evidence. The mod generates a
     * fresh 28-bit id per slot allocation and logs it as
     * `VOTC:BATTLE_REPORT/;/delivery_id/;/slot/;/id`. Two distinct battles
     * with identical facts cannot collide on the requestKey.
     */
    battleDeliveryId?: number;
    /** V2 campaign identity emitted in this battle's own log block. */
    campaignIdentity?: CampaignPlayerIdentity;
    /** Delivery id carried on the campaign line; must match delivery_id. */
    campaignDeliveryId?: number;
}

const TAG_LABELS: Record<string, { zh: string; en: string }> = {
    wipe: {
        zh: "敌军被歼灭",
        en: "the defeated side was wiped out"
    },
    outnumbered_victory: {
        zh: "寡众取胜",
        en: "the winner prevailed while outnumbered"
    },
    devastating_losses: {
        zh: "败方损失惨重",
        en: "the defeated side suffered devastating losses"
    },
    heavy_enemy_losses: {
        zh: "胜方造成大量杀伤",
        en: "the winner inflicted heavy losses"
    },
    massive_battle: {
        zh: "大规模会战",
        en: "a massive battle"
    },
    major_battle: {
        zh: "重要战斗",
        en: "a major battle"
    },
    decisive_warscore: {
        zh: "对战争分数影响显著",
        en: "the battle strongly shifted the war score"
    },
    important_death: {
        zh: "重要人物阵亡",
        en: "an important character died"
    },
    important_capture: {
        zh: "重要人物被俘",
        en: "an important character was captured"
    }
};

const NOTABLE_CHARACTER_LABELS: Record<NotableBattleCharacterType, { zh: string; en: string }> = {
    slain_loser_side: {
        zh: "败方重要人物阵亡",
        en: "important figure slain on the losing side"
    },
    slain_winner_side: {
        zh: "胜方重要人物阵亡",
        en: "important figure slain on the winning side"
    },
    captured_loser_side: {
        zh: "败方重要人物被俘",
        en: "important figure captured from the losing side"
    }
};

export type BattleReportStatusType = 'pending' | 'fallback_written' | 'llm_completed' | 'error';

export interface BattleReportStatus {
    slotId: string;
    date: string;
    location: string;
    winnerName: string;
    loserName: string;
    result?: string;
    status: BattleReportStatusType;
    error?: string;
    timestamp: number;
}

const battleReportStatuses = new Map<string, BattleReportStatus>();

const battleReportInFlightSignatures = new Set<string>();
const battleReportCompletedSignatures = new Set<string>();
const latestBattleReportSignatureBySlot = new Map<string, string>();

export class BattleReportGenerator {
    private apiConnection: ApiConnection;
    private config: Config;
    private userDataPath: string;

    constructor(config: Config, userDataPath: string) {
        this.config = config;
        this.userDataPath = userDataPath;
        this.apiConnection = new ApiConnection(
            config.textGenerationApiConnectionConfig.connection,
            config.textGenerationApiConnectionConfig.parameters
        );
    }

    public getStatuses(): BattleReportStatus[] {
        return Array.from(battleReportStatuses.values());
    }

    public async generateBattleReport(gameData: GameData | undefined, debugLogPath: string, userFolderPath: string): Promise<string | null> {
        try {
            // F22: commit_result consumption at generation time (1.x
            // BattleReportGenerator parity). Battle run scripts log
            // VOTC:TIMELINE commit_result lines; they must be folded into the
            // battle report history records before the next batch writes new
            // attempt records, so outcome stamping never lags a batch.
            consumeTimelineCommitResultsFromLog(debugLogPath, app.getPath('userData'));
            const latestBattlesBySlot = this.extractBattleReportData(debugLogPath);
            if (!latestBattlesBySlot.length) {
                console.error("Failed to extract battle report data");
                return null;
            }

            // P3: enrich reports with the most recent military council snapshot
            // (war/siege/army situation). Absent or incomplete snapshots simply
            // skip the section — never blocks the report.
            const militarySnapshot = await readLastMilitarySnapshotFromLog(debugLogPath);

            const pending = latestBattlesBySlot.filter(battleData => {
                const signature = this.getBattleSignature(battleData);
                return !battleReportCompletedSignatures.has(signature)
                    && !battleReportInFlightSignatures.has(signature);
            });

            if (!pending.length) {
                console.log("No new battle report data to process");
                return null;
            }

            const signatureByBattle = new Map<BattleReportData, string>();
            const sourceRecordIdBySignature = new Map<string, string>();
            for (const battleData of pending) {
                const signature = this.getBattleSignature(battleData);
                signatureByBattle.set(battleData, signature);
                sourceRecordIdBySignature.set(signature, randomUUID());
                battleReportInFlightSignatures.add(signature);
                latestBattleReportSignatureBySlot.set(battleData.slotId, signature);
                battleReportStatuses.set(battleData.slotId, {
                    slotId: battleData.slotId, date: battleData.date, location: battleData.location,
                    winnerName: battleData.winnerName, loserName: battleData.loserName, result: battleData.result,
                    status: 'pending', timestamp: Date.now()
                });
            }

            // A checkpoint archive must be campaign-scoped. Character ids can
            // recur in a fresh game, while the battle block's campaign token
            // uniquely identifies this CK3 session.
            const archivedCampaignEpochs = new Map<string, {
                playerId: string;
                checkpointEpoch: number;
                identity: CampaignPlayerIdentity;
            }>();
            pending.forEach((battleData) => {
                const currentCheckpointEpoch = this.getCurrentCheckpointEpoch(battleData, gameData);
                const identity = battleData.campaignIdentity;
                if (currentCheckpointEpoch !== undefined && identity) {
                    archivedCampaignEpochs.set(`${identity.campaignId}:${identity.playerId}`, {
                        playerId: identity.playerId,
                        checkpointEpoch: currentCheckpointEpoch,
                        identity
                    });
                }
            });
            for (const { playerId, checkpointEpoch, identity } of archivedCampaignEpochs.values()) {
                const archivedCount = await archiveFutureBattleReportHistoryForPlayer(
                    playerId,
                    checkpointEpoch,
                    'battle_report_checkpoint_filter',
                    identity
                );
                if (archivedCount > 0) {
                    console.log(`Archived ${archivedCount} future battle report history records for campaign ${identity.campaignId}, player ${playerId}.`);
                }
            }

            // Create timeline child nodes for each battle. The battle signature
            // is stored as eventSignature (audit only); the requestKey is
            // slot+battleDeliveryId so the journal API dedups attempts by
            // delivery id (the fallback and final LLM report for the same
            // battle share the same delivery id -> same node via rule 1 reuse).
            const timelineBySignature = new Map<string, CreateChildNodeResult>();
            const attemptIdBySignature = new Map<string, string>();
            const identityBySignature = new Map<string, CampaignPlayerIdentity>();

            // Group by the battle block's campaign identity, not only player.
            // A single debug.log can contain reports from several games whose
            // historical character ids happen to match.
            const battlesByCampaign = new Map<string, BattleReportData[]>();
            for (const battleData of pending) {
                const playerId = battleData.playerId || (gameData ? String(gameData.playerID) : '');
                if (!playerId) continue;
                const identity = battleData.campaignIdentity;
                const groupKey = identity
                    ? `${identity.campaignId}:${identity.playerId}`
                    : `missing:${playerId}`;
                const arr = battlesByCampaign.get(groupKey) ?? [];
                arr.push(battleData);
                battlesByCampaign.set(groupKey, arr);
            }

            for (const battlesForThisPlayer of battlesByCampaign.values()) {
                try {
                    // The V2 identity is emitted in each battle's own log
                    // block. It must not be resolved from gameData, whose last
                    // VOTC:IN snapshot can be unrelated or absent.
                    const batchIdentity = battlesForThisPlayer[0]?.campaignIdentity;
                    if (!batchIdentity) {
                        console.warn(`[BattleReport] Missing V2 campaign identity for player ${battlesForThisPlayer[0]?.playerId || 'unknown'}; delivering without a timeline transition.`);
                        continue;
                    }
                    const batchIdentityFinal = batchIdentity;
                    for (const battleData of battlesForThisPlayer) {
                        const sig = signatureByBattle.get(battleData)!;
                        identityBySignature.set(sig, batchIdentityFinal);
                    }
                    // Build batch entries: each battle contributes one child node.
                    // buildBattleTimelineContext can throw UnsupportedTimelineSchemaError
                    // if the battle's checkpoint reports an unsupported schema; such
                    // battles are skipped (reported) and the remaining battles in the
                    // batch still proceed.
                    const coordinatorEntries: BattleCoordinatorEntry[] = [];
                    const signatureByEntryIndex: string[] = [];
                    for (const battleData of battlesForThisPlayer) {
                        const signature = signatureByBattle.get(battleData)!;
                        let snapshotContext: TimelineContext;
                        try {
                            snapshotContext = this.buildBattleTimelineContext(battleData, gameData);
                        } catch (error) {
                            if (error instanceof UnsupportedTimelineSchemaError) {
                                reportUnsupportedTimelineSchema(error.schema);
                                continue;
                            }
                            throw error;
                        }
                        // §9.3 P5.4 / §10.1: battle requestKey = slot + battleDeliveryId.
                        // The mod emits a real, unique 28-bit battleDeliveryId per
                        // slot allocation (VOTC:BATTLE_REPORT/;/delivery_id). The full
                        // facts signature stays as eventSignature (audit only).
                        // Legacy mods that do not emit the delivery_id line fall back
                        // to the facts signature so the requestKey is still stable.
                        const battleDeliveryId = battleData.battleDeliveryId !== undefined
                            ? String(battleData.battleDeliveryId)
                            : signature;
                        coordinatorEntries.push({
                            eventSignature: `battle:${signature}`,
                            slotId: battleData.slotId,
                            battleDeliveryId,
                            context: snapshotContext,
                            nextEpoch: this.getNextCheckpointEpoch(battleData, gameData)
                        });
                        signatureByEntryIndex.push(signature);
                    }
                    // §10.1: order multi-battle batches by snapshot evidence via
                    // TimelineCoordinator, then run one batch transition under the
                    // per-player timeline lock (§7.5 P3.4).
                    const coordination = coordinateBattlesBySnapshot(coordinatorEntries);
                    for (const dropped of coordination.dropped) {
                        console.warn(`[BattleReport] Dropped battle entry (slot=${dropped.entry.slotId}, delivery=${dropped.entry.battleDeliveryId}): ${dropped.reason}`);
                    }
                    const entries: BattleBatchTransitionEntry[] = coordination.planned.map(planned => ({
                        eventSignature: planned.eventSignature,
                        slotId: planned.slotId,
                        battleDeliveryId: planned.battleDeliveryId,
                        context: planned.context,
                        nextEpoch: planned.resolvedNextEpoch
                    }));
                    const batchResult = await runBattleTimelineBatchTransition({
                        userDataDir: app.getPath('userData'),
                        gameData: gameData as any as GameDataLike,
                        identity: batchIdentityFinal,
                        entries
                    });
                    for (let i = 0; i < signatureByEntryIndex.length; i++) {
                        const signature = signatureByEntryIndex[i];
                        const transition = batchResult.timelines.get(`battle:${signature}`);
                        if (transition) {
                            // Adapt SourceTransitionResult -> CreateChildNodeResult
                            // so the existing writeBattleReport/history code works.
                            const timeline: CreateChildNodeResult = {
                                nodeId: transition.targetNodeId,
                                parentId: transition.context.timelineParentId ?? null,
                                script: transition.script,
                                context: transition.context,
                                createdNewRoot: false
                            };
                            timelineBySignature.set(signature, timeline);
                            attemptIdBySignature.set(signature, transition.attemptId);
                            console.log(`Timeline node created for battle ${signature}: ${timeline.nodeId} (parent: ${timeline.parentId ?? 'null'}, attempt: ${transition.attemptId}, reused: ${transition.reused})`);
                        }
                    }
                } catch (error) {
                    if (error instanceof TimelineRegistryCorruptError) {
                        reportCorruptTimelineRegistry(error);
                    } else if (error instanceof UnsupportedTimelineSchemaError) {
                        reportUnsupportedTimelineSchema(error.schema);
                    } else {
                        throw error;
                    }
                }
            }

            let lastReport: string | null = null;

            const resolveAttemptId = (signature: string): string => {
                const existing = attemptIdBySignature.get(signature);
                if (existing) {
                    return existing;
                }
                // A coordinator can deliberately drop a battle when its
                // snapshot is insufficient to order a timeline transition.
                // Delivery must still proceed; writeBattleReport emits a
                // delivery-id-guarded, non-committing script for this case.
                const fallbackAttemptId = randomUUID();
                attemptIdBySignature.set(signature, fallbackAttemptId);
                console.warn(
                    `[BattleReport] No timeline attempt for ${signature}; delivering without a checkpoint transition (attempt: ${fallbackAttemptId}).`
                );
                return fallbackAttemptId;
            };

            try {
                for (const battleData of pending) {
                    const signature = signatureByBattle.get(battleData)!;
                    const fallbackReport = this.buildFallbackReport(battleData, gameData);
                    const timeline = timelineBySignature.get(signature) ?? null;
                    const attemptId = resolveAttemptId(signature);
                    const identity = identityBySignature.get(signature);
                    const sourceRecordId = sourceRecordIdBySignature.get(signature);
                    const battleGameDate = resolveBattleReportGameDate(
                        battleData.date,
                        gameData?.gameDate
                    );
                    await this.writeBattleReport(fallbackReport, userFolderPath, battleData, timeline?.context.checkpointEpoch ?? this.getNextCheckpointEpoch(battleData, gameData), timeline, attemptId, identity, sourceRecordId, battleGameDate, 'fallback', gameData);
                    battleReportStatuses.set(battleData.slotId, {
                        slotId: battleData.slotId, date: battleData.date, location: battleData.location,
                        winnerName: battleData.winnerName, loserName: battleData.loserName, result: battleData.result,
                        status: 'fallback_written', timestamp: Date.now()
                    });
                    battleReportCompletedSignatures.add(signature);
                    lastReport = fallbackReport;
                }
            } catch (error) {
                for (const battleData of pending) {
                    const signature = this.getBattleSignature(battleData);
                    if (!battleReportCompletedSignatures.has(signature)) {
                        battleReportInFlightSignatures.delete(signature);
                        if (latestBattleReportSignatureBySlot.get(battleData.slotId) === signature) {
                            latestBattleReportSignatureBySlot.delete(battleData.slotId);
                        }
                    }
                }
                throw error;
            } finally {
                for (const battleData of pending) {
                    battleReportInFlightSignatures.delete(this.getBattleSignature(battleData));
                }
            }

            for (const battleData of pending) {
                const signature = signatureByBattle.get(battleData)!;
                try {
                    const promptText = this.buildBattleReportPrompt(battleData, gameData, militarySnapshot);
                    console.log(`Generated battle report prompt for ${battleData.slotId}: ${promptText.substring(0, 200)}...`);

                    const messages: Message[] = [
                        {
                            role: "user",
                            content: promptText
                        }
                    ];

                    const response = await this.apiConnection.complete(messages, false, {
                        max_tokens: Math.min(this.config.maxTokens || 800, 900),
                        temperature: this.config.textGenerationApiConnectionConfig.parameters.temperature
                    });

                    if (!response || response.trim() === "") {
                        console.warn(`Empty response from LLM for ${battleData.slotId}; keeping fallback report`);
                        continue;
                    }

                    if (latestBattleReportSignatureBySlot.get(battleData.slotId) !== signature) {
                        console.warn(`Skipping stale battle report overwrite for ${battleData.slotId}`);
                        continue;
                    }

                    const report = this.normalizeReport(response);
                    const timeline = timelineBySignature.get(signature) ?? null;
                    const attemptId = resolveAttemptId(signature);
                    const identity = identityBySignature.get(signature);
                    const sourceRecordId = sourceRecordIdBySignature.get(signature);
                    const battleGameDate = resolveBattleReportGameDate(
                        battleData.date,
                        gameData?.gameDate
                    );
                    await this.writeBattleReport(report, userFolderPath, battleData, timeline?.context.checkpointEpoch ?? this.getNextCheckpointEpoch(battleData, gameData), timeline, attemptId, identity, sourceRecordId, battleGameDate, 'generated', gameData);
                    const existing = battleReportStatuses.get(battleData.slotId);
                    battleReportStatuses.set(battleData.slotId, {
                        ...existing, slotId: battleData.slotId, date: battleData.date, location: battleData.location,
                        winnerName: battleData.winnerName, loserName: battleData.loserName, result: battleData.result,
                        status: 'llm_completed', timestamp: Date.now()
                    });
                    console.log(`Generated battle report for ${battleData.slotId}: ${report.substring(0, 100)}...`);
                    lastReport = report;
                } catch (error) {
                    console.error(`Error improving battle report for ${battleData.slotId}: ${error}`);
                    const existingErr = battleReportStatuses.get(battleData.slotId);
                    battleReportStatuses.set(battleData.slotId, {
                        ...existingErr, slotId: battleData.slotId, date: battleData.date, location: battleData.location,
                        winnerName: battleData.winnerName, loserName: battleData.loserName, result: battleData.result,
                        status: 'error', error: String(error), timestamp: Date.now()
                    });
                }
            }

            return lastReport;
        } catch (error) {
            if (error instanceof TimelineRegistryCorruptError) {
                reportCorruptTimelineRegistry(error);
            }
            console.error(`Error generating battle report: ${error}`);
            return null;
        }
    }

    private extractBattleReportData(debugLogPath: string): BattleReportData[] {
        if (!fs.existsSync(debugLogPath)) {
            console.error(`Debug log file not found at: ${debugLogPath}`);
            return [];
        }

        const fileContent = fs.readFileSync(debugLogPath, "utf8");
        const lines = fileContent.split(/\r?\n/);
        const battles: BattleReportData[] = [];
        let currentBattleData: BattleReportData | null = null;

        for (const line of lines) {
            const commandIndex = line.indexOf("VOTC:BATTLE_REPORT/;/");
            if (commandIndex === -1) continue;

            const parts = line.substring(commandIndex).split("/;/").map(part => part.trim());
            const dataType = parts[1];

            switch (dataType) {
                case "init": {
                    if (currentBattleData) {
                        battles.push(currentBattleData);
                    }

                    const delayDays = this.parseNumber(parts[4]) ?? 30;
                    const slotId = parts[5] || "battle_report_1";
                    currentBattleData = {
                        slotId,
                        legacySingleSlot: !parts[5],
                        playerId: parts[2] || "",
                        date: parts[3] || "",
                        location: "",
                        winnerId: "",
                        winnerName: "",
                        loserId: "",
                        loserName: "",
                        delayDays,
                        sideResults: [],
                        commanders: [],
                        notableCharacters: [],
                        tags: new Set<string>()
                    };
                    break;
                }
                case "delivery_id":
                    if (!currentBattleData) break;
                    // §10.1: Mod-emitted per-battle occurrence evidence.
                    // `VOTC:BATTLE_REPORT/;/delivery_id/;/slot/;/id`
                    if (parts[2] === currentBattleData.slotId) {
                        const parsed = this.parseNumber(parts[3]);
                        if (parsed !== undefined && parsed > 0) {
                            currentBattleData.battleDeliveryId = parsed;
                            if (currentBattleData.campaignDeliveryId !== undefined
                                && currentBattleData.campaignDeliveryId !== parsed) {
                                console.warn(`[BattleReport] campaign/delivery_id mismatch for ${currentBattleData.slotId}: campaign=${currentBattleData.campaignDeliveryId}, delivery_id=${parsed}; refusing the campaign identity.`);
                                currentBattleData.campaignIdentity = undefined;
                            }
                        }
                    } else {
                        console.warn(`[BattleReport] delivery_id line slot mismatch: line slot "${parts[2]}" != current slot "${currentBattleData.slotId}", falling back to facts signature for this battle`);
                    }
                    break;
                case "campaign":
                    if (!currentBattleData) break;
                    try {
                        const campaign = parseBattleReportCampaignIdentityPayload(
                            parts.slice(1),
                            currentBattleData.playerId
                        );
                        if (currentBattleData.battleDeliveryId !== undefined
                            && currentBattleData.battleDeliveryId !== campaign.deliveryId) {
                            console.warn(`[BattleReport] campaign/delivery_id mismatch for ${currentBattleData.slotId}: campaign=${campaign.deliveryId}, delivery_id=${currentBattleData.battleDeliveryId}; refusing the campaign identity.`);
                            break;
                        }
                        currentBattleData.campaignIdentity = campaign.identity;
                        currentBattleData.campaignDeliveryId = campaign.deliveryId;
                    } catch (error) {
                        console.warn(`[BattleReport] Invalid campaign identity for ${currentBattleData.slotId}: ${error}`);
                    }
                    break;
                case "checkpoint":
                    if (!currentBattleData) break;
                    currentBattleData.timelineCheckpoint = parseTimelineSnapshot(parts.slice(2), 'battle');
                    if (currentBattleData.timelineCheckpoint.status === 'invalid') {
                        console.warn(`Unusable battle checkpoint line for ${currentBattleData.slotId}: ${currentBattleData.timelineCheckpoint.reason}`);
                    } else if (currentBattleData.timelineCheckpoint.status === 'truncated') {
                        console.warn(`Unusable battle checkpoint line for ${currentBattleData.slotId}: truncated, expected ${currentBattleData.timelineCheckpoint.expected} fields, got ${currentBattleData.timelineCheckpoint.actual}`);
                    }
                    break;
                case "init_location":
                    if (!currentBattleData) break;
                    currentBattleData.location = this.cleanBattleLogText(parts[2]);
                    currentBattleData.terrain = this.cleanBattleLogText(parts[3]);
                    currentBattleData.winter = this.cleanBattleLogText(parts[4]);
                    break;
                case "init_winner":
                    if (!currentBattleData) break;
                    currentBattleData.winnerId = parts[2] || "";
                    currentBattleData.winnerName = this.cleanBattleLogText(parts[3]);
                    break;
                case "init_loser":
                    if (!currentBattleData) break;
                    currentBattleData.loserId = parts[2] || "";
                    currentBattleData.loserName = this.cleanBattleLogText(parts[3]);
                    break;
                case "stats":
                    if (!currentBattleData) break;
                    currentBattleData.percentEnemiesKilled = this.parseNumber(parts[2]);
                    currentBattleData.delayDays = this.parseNumber(parts[3]) ?? currentBattleData.delayDays;
                    break;
                case "side_result": {
                    if (!currentBattleData || !parts[2]) break;
                    const initialTroops = this.parseNumber(parts[3]);
                    const lostTroops = this.parseNumber(parts[4]);
                    const survivingTroops = this.parseNumber(parts[5]);
                    if (initialTroops === undefined || lostTroops === undefined || survivingTroops === undefined) break;
                    currentBattleData.sideResults.push({
                        participantId: parts[2],
                        initialTroops,
                        lostTroops,
                        survivingTroops
                    });
                    break;
                }
                case "troops":
                    if (!currentBattleData) break;
                    currentBattleData.totalTroops = this.parseNumber(parts[2]);
                    currentBattleData.troopsRatio = this.parseNumber(parts[3]);
                    currentBattleData.enemiesKilled = this.parseNumber(parts[4]);
                    break;
                case "result":
                    if (!currentBattleData) break;
                    if (parts[2] === "victory" || parts[2] === "defeat") {
                        currentBattleData.result = parts[2];
                    }
                    break;
                case "winning_side":
                    if (!currentBattleData) break;
                    if (parts[2] === "attacker" || parts[2] === "defender") {
                        currentBattleData.winningSide = parts[2];
                    }
                    break;
                case "commander":
                    if (!currentBattleData) break;
                    if ((parts[2] === "winner" || parts[2] === "loser") && parts[4]) {
                        currentBattleData.commanders.push({
                            side: parts[2],
                            id: parts[3] || "",
                            name: this.cleanBattleLogText(parts[4])
                        });
                    }
                    break;
                case "notable":
                    if (!currentBattleData) break;
                    if (this.isNotableBattleCharacterType(parts[2]) && parts[4]) {
                        currentBattleData.notableCharacters.push({
                            type: parts[2],
                            id: parts[3] || "",
                            name: this.cleanBattleLogText(parts[4])
                        });
                    }
                    break;
                case "tag":
                    if (!currentBattleData || !parts[2]) break;
                    currentBattleData.tags.add(parts[2]);
                    break;
            }
        }

        if (currentBattleData) {
            battles.push(currentBattleData);
        }

        if (!battles.length) {
            console.log("No VOTC:BATTLE_REPORT init entries found in debug.log");
            return [];
        }

        const latestBySlot = new Map<string, BattleReportData>();
        for (const battleData of battles) {
            latestBySlot.set(battleData.slotId, battleData);
        }

        const latestBattles = Array.from(latestBySlot.values());
        console.log(`Extracted ${latestBattles.length} latest battle report block(s) from ${battles.length} init block(s)`);
        return latestBattles;
    }

    private buildBattleReportPrompt(battleData: BattleReportData, gameData: GameData | undefined, militarySnapshot?: MilitarySnapshot): string {
        const language = this.getOutputLanguage();
        const player = gameData?.characters.get(Number(battleData.playerId)) || gameData?.getPlayer();
        const playerName = this.getPlayerName(battleData, gameData, player);
        const winner = gameData?.characters.get(Number(battleData.winnerId));
        const loser = gameData?.characters.get(Number(battleData.loserId));
        const battlefield = this.getBattlefieldName(battleData);
        const winnerName = this.cleanBattleLogText(battleData.winnerName) || "unknown";
        const loserName = this.cleanBattleLogText(battleData.loserName) || "unknown";
        const tags = this.describeTags(battleData);
        const commanders = this.describeCommanders(battleData, this.config.language, gameData);
        const notableCharacters = this.describeNotableCharacters(battleData, this.config.language, gameData);
        const worldContext = this.describeWorldContext(gameData);
        const worldContextFact = worldContext ? `- Current broader game context: ${worldContext}\n` : "";
        // P3: compact war/siege/army context from the latest military council
        // snapshot. formatMilitaryBrief returns '' for absent/incomplete
        // snapshots, so this section self-gates.
        const militaryContext = formatMilitaryBrief(militarySnapshot, {
            maxChars: 4000,
            lang: (this.config.language || "en").startsWith("zh") ? "zh" : "en"
        });
        const militaryContextSection = militaryContext
            ? `\nRecent war situation (from the last military council snapshot):\n${militaryContext}\n`
            : "";
        const result = battleData.result === "victory"
            ? "This was a victory for the player."
            : battleData.result === "defeat"
                ? "This was a defeat for the player."
                : "The player's side is unknown.";
        const winningSide = battleData.winningSide ? `The winning side was the ${battleData.winningSide}.` : "The attacker/defender side is unknown.";
        const percentKilled = battleData.percentEnemiesKilled !== undefined
            ? `Game statistic: percent_enemies_killed from the winning side's perspective is about ${battleData.percentEnemiesKilled}%.`
            : "No exact casualty percentage was provided.";
        const troopsStat = this.describeTroops(battleData);
        const terrain = this.cleanBattleLogText(battleData.terrain) || "";
        const winter = this.cleanBattleLogText(battleData.winter) || "";
        const environmentFact = terrain || winter
            ? `- Terrain: ${terrain || "unknown"}${winter ? `; Winter: ${winter}` : ""}\n`
            : "";

        return `You are writing an in-game battle report for Crusader Kings III.

Output language: ${language}.

Facts:
- Player ruler: ${playerName}
- Battle date: ${battleData.date || gameData?.date || "unknown"}
- Battlefield: ${battlefield}
${environmentFact}- Winner: ${winnerName} (${battleData.winnerId || "unknown"})
- Loser: ${loserName} (${battleData.loserId || "unknown"})
- ${result}
- ${winningSide}
- ${percentKilled}
- ${troopsStat}
- Commanders: ${commanders}
- Important deaths or captures: ${notableCharacters}
- Notable tags: ${tags}
${worldContextFact}${militaryContextSection}
Known character context:
- Player ruler: ${this.describeCharacterForPrompt(player, playerName)}
- Winner profile: ${this.describeCharacterForPrompt(winner, winnerName)}
- Loser profile: ${this.describeCharacterForPrompt(loser, loserName)}

${getEffectivePrompts(this.config, this.userDataPath, gameData!)?.battleReportPrompt || ""}`;
    }

    private buildFallbackReport(battleData: BattleReportData, gameData: GameData | undefined): string {
        const player = gameData?.characters.get(Number(battleData.playerId)) || gameData?.getPlayer();
        const playerName = this.getPlayerName(battleData, gameData, player);
        const battlefield = this.getBattlefieldName(battleData);
        const winnerName = this.cleanBattleLogText(battleData.winnerName) || (this.config.language === "en" ? "the winning host" : "胜方军队");
        const loserName = this.cleanBattleLogText(battleData.loserName) || (this.config.language === "en" ? "the opposing host" : "敌方军队");
        const playerClauseZh = playerName ? `${playerName}的宫廷收到军情：` : "宫廷收到军情：";
        const playerClauseEn = playerName ? `${playerName}'s court has received a military dispatch: ` : "A military dispatch has reached the court: ";
        const commanderTextZh = this.describeCommanders(battleData, "zh");
        const commanderTextEn = this.describeCommanders(battleData, "en");
        const tagsZh = this.describeTags(battleData, "zh");
        const tagsEn = this.describeTags(battleData, "en");

        if (this.config.language === "en") {
            const outcome = battleData.result === "victory" ? "This is counted as a victory for the player" : battleData.result === "defeat" ? "This is counted as a defeat for the player" : "The player's result is unclear";
            return `${playerClauseEn}at ${battlefield}, ${winnerName} defeated ${loserName}. ${outcome}. Commanders: ${commanderTextEn}. Notable circumstances: ${tagsEn}.`;
        }

        const outcome = battleData.result === "victory" ? "此战计为玩家一方的胜利" : battleData.result === "defeat" ? "此战计为玩家一方的失败" : "玩家一方的战果尚不明朗";
        return `${playerClauseZh}在${battlefield}，${winnerName}击败了${loserName}。${outcome}。统帅：${commanderTextZh}。战况要点：${tagsZh}。`;
    }

    private describeCommanders(battleData: BattleReportData, language = this.config.language, gameData?: GameData): string {
        if (battleData.commanders.length === 0) {
            return language === "en" ? "unknown" : "不明";
        }

        return battleData.commanders
            .map(commander => {
                const commanderProfile = this.describeCharacterForPrompt(
                    gameData?.characters.get(Number(commander.id)),
                    commander.name
                );
                if (language === "en") {
                    return commander.side === "winner"
                        ? `winner commander ${commanderProfile}`
                        : `loser commander ${commanderProfile}`;
                }
                return commander.side === "winner"
                    ? `胜方统帅${commanderProfile}`
                    : `败方统帅${commanderProfile}`;
            })
            .join(language === "en" ? "; " : "；");
    }

    private describeNotableCharacters(battleData: BattleReportData, language = this.config.language, gameData?: GameData): string {
        if (battleData.notableCharacters.length === 0) {
            return language === "en" ? "none reported" : "未报告";
        }

        return battleData.notableCharacters
            .map(character => {
                const label = NOTABLE_CHARACTER_LABELS[character.type]?.[language === "en" ? "en" : (language === "zh" ? "zh" : "en")] || character.type;
                const profile = this.describeCharacterForPrompt(
                    gameData?.characters.get(Number(character.id)),
                    character.name
                );

                return language === "en"
                    ? `${label}: ${profile}`
                    : `${label}：${profile}`;
            })
            .join(language === "en" ? "; " : "；");
    }

    private describeCharacterForPrompt(character: Character | undefined, fallbackName: string): string {
        const name = character?.fullName || fallbackName || "unknown";
        if (!character) {
            return name;
        }

        const details: string[] = [];
        if (character.primaryTitle) details.push(`title: ${character.primaryTitle}`);
        if (Number.isFinite(character.age) && character.age > 0) details.push(`age: ${character.age}`);
        if (character.culture) details.push(`culture: ${character.culture}`);
        if (character.faith) details.push(`faith: ${character.faith}`);
        if (character.house) details.push(`house: ${character.house}`);
        if (character.capitalLocation) details.push(`capital: ${character.capitalLocation}`);
        if (character.titleRankConcept) details.push(`rank: ${character.titleRankConcept}`);
        if (character.personality) details.push(`personality: ${character.personality}`);
        if (Number.isFinite(character.prowess) && character.prowess > 0) details.push(`prowess: ${character.prowess}`);
        if (character.isIndependentRuler) details.push("independent ruler");
        else if (character.liege) details.push(`liege: ${character.liege}`);
        if (character.topLiege && character.topLiege !== character.liege) details.push(`top liege: ${character.topLiege}`);

        const traits = character.traits
            .map(trait => trait.name)
            .filter(Boolean)
            .slice(0, 8);
        if (traits.length) details.push(`traits: ${traits.join(", ")}`);

        return details.length ? `${name} (${details.join("; ")})` : name;
    }

    private describeWorldContext(gameData: GameData | undefined): string | undefined {
        if (!gameData) {
            return undefined;
        }

        const details: string[] = [];
        if (this.cleanBattleLogText(gameData.date)) details.push(`current date: ${gameData.date}`);
        if (this.cleanBattleLogText(gameData.location)) details.push(`current player/scene location: ${gameData.location}`);
        if (this.cleanBattleLogText(gameData.locationController)) details.push(`location controller: ${gameData.locationController}`);
        if (this.cleanBattleLogText(gameData.scene)) details.push(`current scene: ${gameData.scene}`);

        return details.length ? details.join("; ") : undefined;
    }

    private describeTags(battleData: BattleReportData, language = this.config.language): string {
        if (battleData.tags.size === 0) {
            return language === "en" ? "none" : "无";
        }

        return Array.from(battleData.tags)
            .map(tag => TAG_LABELS[tag]?.[language === "en" ? "en" : (language === "zh" ? "zh" : "en")] || tag)
            .join(language === "en" ? "; " : "；");
    }

    private async writeBattleReport(reportContent: string, userFolderPath: string, battleData: BattleReportData, checkpointEpoch?: number, timeline: CreateChildNodeResult | null = null, attemptId: string = randomUUID(), identity?: CampaignPlayerIdentity, sourceRecordId?: string, gameDate?: import("../../shared/gameData/gameDate").Ck3GameDate, generationStatus: 'fallback' | 'generated' = 'generated', gameData?: GameData): Promise<void> {
        const runFolderPath = path.join(userFolderPath, "run");
        if (!fs.existsSync(runFolderPath)) {
            fs.mkdirSync(runFolderPath, { recursive: true });
            console.log(`Created run folder at: ${runFolderPath}`);
        }

        const slotNumber = this.getSlotNumber(battleData.slotId);
        const battleReportFilePath = path.join(runFolderPath, `battle_report${slotNumber}.txt`);
        const escapedReport = this.escapeForCk3Script(reportContent);
        let commit: BattleCommitTarget | undefined;
        if (timeline && checkpointEpoch !== undefined) {
            const observed = this.observedBattleState(battleData);
            const targetNode = parseNodeId(timeline.nodeId);
            const graphParent = timeline.parentId ? parseNodeId(timeline.parentId) : undefined;
            commit = {
                targetEpoch: checkpointEpoch,
                transitionToken: timeline.context.checkpointToken,
                observedEpoch: observed?.epoch,
                observedNodeA: observed?.nodeA ?? 0,
                observedNodeB: observed?.nodeB ?? 0,
                observedParentA: observed?.parentA,
                observedParentB: observed?.parentB,
                observedToken: observed?.checkpointToken,
                targetNodeA: targetNode?.a ?? 0,
                targetNodeB: targetNode?.b ?? 0,
                graphParentA: graphParent?.a ?? 0,
                graphParentB: graphParent?.b ?? 0,
                deliveryId: battleData.battleDeliveryId !== undefined
                    ? String(battleData.battleDeliveryId)
                    : undefined
            };
        }
        const gameCommand = buildBattleReportRunScript({
            slotNumber,
            attemptId,
            playerId: battleData.playerId || '0',
            escapedReport,
            commit,
            battleDeliveryId: battleData.battleDeliveryId
        });

        fs.writeFileSync(battleReportFilePath, gameCommand, "utf8");
        console.log(`Battle report written to: ${battleReportFilePath}`);

        await this.saveBattleReportHistory(reportContent, battleData, checkpointEpoch, timeline, attemptId, identity, sourceRecordId, gameDate, generationStatus, gameData);

        if (battleData.legacySingleSlot) {
            const legacyBattleReportFilePath = path.join(runFolderPath, "battle_report.txt");
            fs.writeFileSync(legacyBattleReportFilePath, gameCommand, "utf8");
            console.log(`Legacy battle report written to: ${legacyBattleReportFilePath}`);
        }
    }

    private async saveBattleReportHistory(reportContent: string, battleData: BattleReportData, checkpointEpoch?: number, timeline: CreateChildNodeResult | null = null, attemptId?: string, identity?: CampaignPlayerIdentity, sourceRecordId?: string, gameDate?: import("../../shared/gameData/gameDate").Ck3GameDate, generationStatus: 'fallback' | 'generated' = 'generated', gameData?: GameData): Promise<boolean> {
        try {
            // Identity is threaded in from the batch capture at
            // generateBattleReport start. Do NOT re-resolve here. Schema v1
            // records fail closed: without identity, timeline node, epoch,
            // sourceRecordId or structured date no history is written at all
            // (never a player-only or empty-anchor record).
            if (!identity) {
                console.warn(`Skipping battle report history for ${battleData.slotId}: no campaign identity captured for this batch.`);
                return false;
            }
            if (!timeline || checkpointEpoch === undefined || !sourceRecordId || !gameDate) {
                console.warn(
                    `[BattleReport] Skipping schema v1 history for ${battleData.slotId}: ` +
                    `missing required context (timeline=${Boolean(timeline)}, epoch=${checkpointEpoch}, ` +
                    `sourceRecordId=${Boolean(sourceRecordId)}, gameDate=${Boolean(gameDate)}).`
                );
                return false;
            }
            const historyFilePath = campaignBattleReportHistoryPath(app.getPath('userData'), identity);

            const signature = this.getBattleSignature(battleData);
            const dedupKey = `${signature}@${timeline.nodeId}`;
            const record = buildBattleReportHistoryRecord({
                id: signature,
                dedupKey,
                location: battleData.location,
                ...(battleData.terrain !== undefined ? { terrain: battleData.terrain } : {}),
                ...(battleData.winter !== undefined ? { winter: battleData.winter } : {}),
                ...(battleData.result !== undefined ? { result: battleData.result } : {}),
                ...(battleData.winningSide !== undefined ? { winningSide: battleData.winningSide } : {}),
                winnerId: battleData.winnerId,
                winnerName: this.cleanBattleLogText(battleData.winnerName),
                loserId: battleData.loserId,
                loserName: this.cleanBattleLogText(battleData.loserName),
                sideResults: battleData.sideResults,
                commanders: battleData.commanders,
                notableCharacters: battleData.notableCharacters,
                tags: [...battleData.tags],
                content: reportContent,
                generationStatus,
                displayDate: battleData.date,
                gameDate,
                checkpointEpoch,
                timeline,
                identity,
                sourceRecordId,
                characterResolver: (characterId: number) => gameData?.characters.get(characterId)
            });

            await updateJsonArrayAtomic<unknown>(
                historyFilePath,
                (value) => {
                    if (!Array.isArray(value)) {
                        throw new Error('existing battle report history file is not an array');
                    }
                    return value;
                },
                (records) => {
                    const existingIndex = records.findIndex(entry => matchesBattleDedupKey(entry, dedupKey));
                    if (existingIndex >= 0 && isBattleReportHistoryRecordV1(records[existingIndex])) {
                        // Fallback -> final update: only content and status may
                        // change; anchor/facts/snapshots/createdAt stay frozen.
                        records[existingIndex] = applyBattleReportContentUpdate(
                            records[existingIndex],
                            reportContent,
                            generationStatus
                        );
                        return records;
                    }
                    if (existingIndex >= 0) {
                        // Legacy entry upgrade: replace with the v1 record but
                        // preserve the original createdAt.
                        records[existingIndex] = {
                            ...record,
                            createdAt: (records[existingIndex] as { createdAt?: string }).createdAt ?? record.createdAt
                        };
                        return records;
                    }
                    return [...records, record];
                }
            );
            console.log(`Battle report history saved to: ${historyFilePath}`);
            return true;
        } catch (error) {
            console.error(`Failed to save battle report history: ${error}`);
            return false;
        }
    }

    private normalizeReport(text: string): string {
        return text.trim()
            .replace(/^["“”]+/, "")
            .replace(/["“”]+$/, "")
            .replace(/\\n|\/n|\r?\n/g, " ")
            .replace(/\s{2,}/g, " ");
    }

    private escapeForCk3Script(text: string): string {
        return text
            .replace(/\\(?!n)/g, "/")
            .replace(/"/g, "“")
            .replace(/'/g, "’")
            .replace(/#/g, "＃")
            .replace(/\r?\n/g, "\\n");
    }

    private getOutputLanguage(): string {
        const map: Record<string, string> = {
            en: "English", zh: "Simplified Chinese", ru: "Russian",
            fr: "French", es: "Spanish", de: "German",
            ja: "Japanese", ko: "Korean", pl: "Polish",
            pt: "Portuguese", tr: "Turkish"
        };
        return map[this.config.language] || "English";
    }

    private getBattleSignature(battleData: BattleReportData): string {
        return [
            battleData.slotId,
            battleData.playerId,
            battleData.date,
            battleData.location,
            battleData.winnerId,
            battleData.loserId,
            battleData.sideResults
                .map(result => `${result.participantId}:${result.initialTroops}:${result.lostTroops}:${result.survivingTroops}`)
                .sort()
                .join(","),
            Array.from(battleData.tags).sort().join(","),
            battleData.notableCharacters
                .map(character => `${character.type}:${character.id}:${character.name}`)
                .sort()
                .join(",")
        ].join("|");
    }

    private getSlotNumber(slotId: string): string {
        const slotNumber = slotId.replace("battle_report_", "");
        return /^\d+$/.test(slotNumber) ? slotNumber : "1";
    }

    private describeTroops(battleData: BattleReportData): string {
        const { totalTroops, troopsRatio, enemiesKilled } = battleData;
        const parts: string[] = [];
        if (totalTroops !== undefined) {
            parts.push(`Total troops engaged: ~${totalTroops}`);
        }
        if (totalTroops !== undefined && troopsRatio !== undefined && troopsRatio > 0) {
            const winnerTroops = Math.round(totalTroops * troopsRatio / (1 + troopsRatio));
            const loserTroops = Math.round(totalTroops / (1 + troopsRatio));
            parts.push(`Winner troops (estimated): ~${winnerTroops}`);
            parts.push(`Loser troops (estimated): ~${loserTroops}`);
            parts.push(`Troops ratio (winner/loser): ${troopsRatio}`);
        }
        if (enemiesKilled !== undefined) {
            parts.push(`Enemy troops killed: ~${enemiesKilled}`);
        }
        return parts.length ? parts.join("; ") : "No exact troop figures were provided.";
    }

    private parseNumber(value: string | undefined): number | undefined {
        if (value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private getPlayerName(battleData: BattleReportData, gameData: GameData | undefined, player: Character | undefined): string {
        const gameName = this.cleanBattleLogText(player?.fullName)
            || this.cleanBattleLogText(player?.shortName)
            || this.cleanBattleLogText(gameData?.playerName);
        if (gameName) {
            return gameName;
        }

        const winnerName = this.cleanBattleLogText(battleData.winnerName);
        const loserName = this.cleanBattleLogText(battleData.loserName);
        if (battleData.playerId && battleData.playerId === battleData.winnerId && winnerName) {
            return winnerName;
        }
        if (battleData.playerId && battleData.playerId === battleData.loserId && loserName) {
            return loserName;
        }
        if (battleData.result === "victory" && winnerName) {
            return winnerName;
        }
        if (battleData.result === "defeat" && loserName) {
            return loserName;
        }

        return battleData.playerId ? `character ${battleData.playerId}` : "unknown";
    }

    private getBattlefieldName(battleData: BattleReportData): string {
        return this.cleanBattleLogText(battleData.location)
            || (this.config.language === "en" ? "an unknown battlefield" : "未知战场");
    }

    private cleanBattleLogText(value: string | undefined): string {
        if (!value) return "";

        const cleaned = removeTooltip(value).trim();
        if (!cleaned || /^(none|null|undefined)$/i.test(cleaned)) {
            return "";
        }

        return cleaned;
    }

    private getNextCheckpointEpoch(battleData: BattleReportData, gameData: GameData | undefined): number | undefined {
        const currentEpoch = this.getCurrentCheckpointEpoch(battleData, gameData);
        return currentEpoch === undefined ? undefined : currentEpoch + 1;
    }

    private observedBattleState(battleData: BattleReportData): ObservedTimelineState | undefined {
        const result = battleData.timelineCheckpoint;
        if (!result) return undefined;
        if (result.status === 'valid' || result.status === 'legacy') return result.snapshot;
        return undefined;
    }

    private buildBattleTimelineContext(battleData: BattleReportData, gameData: GameData | undefined): TimelineContext {
        const playerId = battleData.playerId || (gameData ? String(gameData.playerID) : 'unknown');
        return buildContextFromBattleCheckpoint(playerId, battleData.timelineCheckpoint, gameData);
    }

    private getCurrentCheckpointEpoch(battleData: BattleReportData, gameData: GameData | undefined): number | undefined {
        return this.observedBattleState(battleData)?.epoch ?? gameData?.votcCheckpointEpoch;
    }

    private isNotableBattleCharacterType(value: string | undefined): value is NotableBattleCharacterType {
        return value === "slain_loser_side"
            || value === "slain_winner_side"
            || value === "captured_loser_side";
    }
}
