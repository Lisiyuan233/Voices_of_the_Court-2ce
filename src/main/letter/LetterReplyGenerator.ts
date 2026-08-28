import { BrowserWindow, app } from "electron";
import { ApiConnection } from "../../shared/apiConnection";
import { Character } from "../../shared/gameData/Character.js";
import { GameData, Trait } from "../../shared/gameData/GameData.js";
import { Config } from "../../shared/Config";
import { Message, Summary } from "../ts/conversation_interfaces";
import * as fs from "fs";
import * as path from "path";
import { readSummaryFile, saveSummaryFile, archiveFutureSummaryFilesForPlayer } from '../summaryManager.js';
import { createMemoryString } from '../conversation/promptBuilder.js';
import { LetterManager } from "./LetterManager.js";
import { Letter } from "./Letter.js";
import { Letter as ILetter, LetterType, LetterSummary } from "./letterInterfaces.js";
import { randomUUID, createHash } from 'crypto';
import { getEffectivePrompts } from "../conversation/promptBuilder.js";
import {
    TimelineRegistryCorruptError,
    TimelineParentNotFoundError,
    FsTimelinePersistence,
    resolveTimelineContext,
    buildContextFromGameData,
    type CreateChildNodeResult,
    type GameDataLike,
    type TimelineRegistry
} from '../timelineManager.js';
import { UnsupportedTimelineSchemaError } from '../../shared/gameData/timelineProtocol.js';
import { requireCampaignIdentity, CampaignIdentityUnavailableError } from '../campaignIdentityResolver.js';
import { observeParsedGameDataForChronicle } from '../chronicle/chronicleObservation.js';
import { ChronicleStoreError } from '../chronicle/chronicleAtomicJson.js';
import { markChronicleUnhealthy } from '../chronicle/chronicleHealth.js';
import { chronicleMemoryStorePath } from '../campaignDataPaths.js';
import { reportCampaignIdentityUnavailable, reportCorruptTimelineRegistry, reportTimelineParentNotFound, reportUnsupportedTimelineSchema } from '../timelineRegistryRecovery.js';
import { runLetterReplyTimelineTransition } from '../timelineBusinessWire.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';

import { buildLetterFallbackPayload, buildLetterTimelineBlock } from './letterRunScript.js';

function writeRunFileAtomically(filePath: string, content: string): void {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, content, 'utf8');
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

/**
 * Drain one exact CK3 letter thread when the desktop app cannot produce a
 * reply (ported from 1.x). mod2 ce has no per-slot letterN.txt execution
 * point (the 1.x event_window_widget_message_N runners were never ported),
 * so the fallback payload is written to letters.txt, which the mod's
 * letters_runner widget already polls every ~2 seconds. The payload is
 * thread-guarded and carries the guarded timeline commit block built from
 * the transition journal's node; poll repeats after the first execution are
 * inert because the thread marker is removed.
 */
export function writeLetterReplyFallbackRunFile(
    userFolderPath: string,
    slotId: string,
    deliveryId: number,
    timelineBlock?: string
): boolean {
    const letterNumber = slotId.match(/^letter_([1-9])$/)?.[1];
    if (!letterNumber || !Number.isSafeInteger(deliveryId) || deliveryId < 0) return false;

    const runFolderPath = path.join(userFolderPath, 'run');
    fs.mkdirSync(runFolderPath, { recursive: true });
    const filePath = path.join(runFolderPath, 'letters.txt');
    writeRunFileAtomically(
        filePath,
        '\uFEFF' + buildLetterFallbackPayload({ letterNumber, deliveryId, timelineBlock })
    );
    console.warn(`[LetterReply] Fallback payload written to letters.txt for ${slotId}/${deliveryId}${timelineBlock ? ' with timeline transition.' : ' without timeline transition.'}`);
    return true;
}

export class LetterReplyGenerator {
    private apiConnection: ApiConnection;
    private config: Config;
    private userDataPath: string;

    constructor(config: Config, userDataPath: string) {
        this.config = config;
        this.userDataPath = userDataPath;
        
        // Create API connection
        console.log('[LetterReplyGenerator] Creating ApiConnection...');
        this.apiConnection = new ApiConnection(
            config.textGenerationApiConnectionConfig.connection,
            config.textGenerationApiConnectionConfig.parameters
        );
        console.log('[LetterReplyGenerator] ApiConnection created.');
    }

    // IncomingLetterGenerator.getSummaryTimeline parity: load the timeline
    // registry (campaign-scoped when the snapshot carries a v2 identity,
    // player-only legacy fallback otherwise) so summary reads filter
    // node-tagged records by branch instead of fail-closed hiding them.
    private getSummaryTimeline(gameData: GameData): { registry: TimelineRegistry | undefined; currentNodeId: string | undefined } {
        const persistence = new FsTimelinePersistence(app.getPath('userData'));
        let registry: TimelineRegistry | undefined;
        try {
            const identity = requireCampaignIdentity({
                playerID: gameData.playerID,
                timelineSnapshotResult: gameData.timelineSnapshotResult
            });
            const result = persistence.loadStoreWithIdentity(identity);
            registry = result.status === 'found' ? result.store : undefined;
        } catch {
            // Legacy snapshot: fall back to player-only display load.
            registry = persistence.loadRegistry(String(gameData.playerID)) ?? undefined;
        }
        const context = registry
            ? resolveTimelineContext(registry, buildContextFromGameData(gameData))
            : buildContextFromGameData(gameData);
        return {
            registry,
            currentNodeId: context.timelineNodeId
        };
    }


    /**
     * Builds the prompt for the letter reply
     * @param gameData Game data
     * @param letterContent Letter content
     * @returns The constructed prompt
     */
    private async buildLetterPrompt(gameData: GameData, letter: ILetter): Promise<string> {
        // Ensure sender and recipient from the letter are in the gameData context
        if (!gameData.characters.has(letter.sender.id)) {
            gameData.addCharacter(letter.sender.id, letter.sender);
        }
        if (!gameData.characters.has(letter.recipient.id)) {
            gameData.addCharacter(letter.recipient.id, letter.recipient);
        }

        const player = gameData.characters.get(letter.sender.id);
        const ai = gameData.characters.get(letter.recipient.id);

        if (!player || !ai) {
            // This should now be much less likely to happen
            throw new Error('Player or AI character data not found in gameData');
        }

        // Use pListLetter.js to build character description
        const pListLetter = require("../../../default_userdata/scripts/prompts/description/standard/pListLetter.js");
        const characterDescription = pListLetter(gameData);

        // Read conversation summary
        let conversationSummary = '';
        try {
            // @ts-ignore
            const depth = this.config.summaries_insert_depth || 3;
            // Archive future summaries before reading for letter prompt
            archiveFutureSummaryFilesForPlayer(this.userDataPath, String(player.id), gameData.votcCheckpointEpoch, 'letter_prompt_checkpoint_filter');
            // Pass the timeline registry so node-tagged summaries from the
            // current branch stay visible (without it they fail-closed hide).
            const summaryTimeline = this.getSummaryTimeline(gameData);
            const summaries: Summary[] = await readSummaryFile(this.userDataPath, String(player.id), gameData.votcCheckpointEpoch, summaryTimeline.registry, summaryTimeline.currentNodeId);
            const aiSummaries = summaries.filter(summary => summary.characterId === String(ai.id)).slice(0, depth);
            
            if (aiSummaries.length > 0) {
                // Read all summaries for this character, sorted by date (most recent first)
                const allSummaries = aiSummaries.map((summary, index) => 
                    `${index + 1}. ${summary.date}: ${summary.content}`
                ).join('\n');
                
                conversationSummary = `Summaries of previous conversations with ${player.fullName}:\n${allSummaries}\n\n`;
                console.log(`Loaded ${aiSummaries.length} conversation summaries for AI ID ${ai.id}`);
            } else {
                console.log(`No conversation summary found for AI ID ${ai.id}`);
            }
        } catch (error) {
            console.warn(`Failed to load conversation summary: ${error}`);
        }

        // Load letter summaries
        const letterManager = LetterManager.getInstance();
        // @ts-ignore
        const depth = this.config.summaries_insert_depth || 3;
        const letterSummaries = letterManager.getLetterSummaries(String(player.id), String(ai.id), gameData.votcCheckpointEpoch).slice(0, depth);
        let letterSummaryContent = '';
        if (letterSummaries.length > 0) {
            const allSummaries = letterSummaries.map((summary, index) => 
                `${index + 1}. ${summary.date}: ${summary.summary}`
            ).join('\n');
            letterSummaryContent = `Summaries of previous letters with ${player.fullName}:\n${allSummaries}\n\n`;
            console.log(`Loaded ${letterSummaries.length} letter summaries for AI ID ${ai.id}`);
        } else {
            console.log(`No letter summaries found for AI ID ${ai.id}`);
        }

        // Read memory content
        let memoryContent = '';
        try {
            // Create a temporary conversation object to get memory content
            const tempConversation = {
                gameData: gameData,
                config: {
                    maxMemoryTokens: 1000
                },
                textGenApiConnection: this.apiConnection
            } as any;
            
            const prompts = { memoriesPrompt: getEffectivePrompts(this.config, this.userDataPath, gameData).memoriesPrompt };
            const memoryString = createMemoryString(tempConversation, prompts);
            if (memoryString && memoryString.trim() !== '') {
                memoryContent = `${memoryString}\n\n`;
                console.log(`Loaded memory content for letter prompt: ${memoryString.substring(0, 100)}...`);
            } else {
                console.log(`No memory content found for letter prompt`);
            }
        } catch (error) {
            console.warn(`Failed to load memory content: ${error}`);
        }

        const effectivePrompts = getEffectivePrompts(this.config, this.userDataPath, gameData);
        let prompt = effectivePrompts.letterPrompt;

        prompt = prompt.replace('{{aiName}}', ai?.fullName || '')
                       .replace('{{characterDescription}}', characterDescription || '')
                       .replace('{{conversationSummary}}', conversationSummary || '')
                       .replace('{{letterSummaryContent}}', letterSummaryContent || '')
                       .replace('{{memoryContent}}', memoryContent || '')
                       .replace('{{playerName}}', player?.fullName || '')
                       .replace('{{letterContent}}', letter?.content || '')
                       .replace(/{{language}}/g, this.config.language || 'en');

        return prompt;
    }

    /**
     * Escapes quotes in the model's reply, replacing standard quotes with Chinese quotes for 'zh' language.
     * @param text The original text
     * @param language The language of the reply
     * @returns The escaped text
     */
    private escapeQuotes(text: string, language: string): string {
        if (language === 'zh') {
            return text.replace(/"/g, '“').replace(/'/g, '’');
        }
        return text;
    }

    /**
     * Generates a letter reply and writes it to a file.
     * @param gameData Game data
     * @param debugLogPath Path to debug.log file
     * @param userFolderPath User folder path
     * @returns The generated reply content, or null on failure
     */
    public async generateLetterReply(gameData: GameData, letter: ILetter): Promise<ILetter | null> {
        // Hoisted so the catch-all failure exit can still route the fallback
        // payload for the timeline thread that was being generated.
        let fallbackSnapshot: { slotId: string; deliveryId: number } | undefined;
        let fallbackTimelineRunBlock: string | undefined;
        try {
            console.log('[LetterReplyGenerator] Starting letter reply generation.');

            // ── Timeline transition chain (ported from 1.x) ─────────────────
            // mod2 ce letters are identified by their thread subject
            // ('letter_1'..'letter_9'); letters outside that scheme follow the
            // legacy path without a timeline branch.
            const slotId = /^letter_[1-9]$/.test(letter.subject) ? letter.subject : null;
            let timeline: CreateChildNodeResult | undefined;
            let timelineRunBlock: string | undefined;
            let snapshot: { slotId: string; deliveryId: number } | undefined;

            if (slotId) {
                // mod2 ce emits no per-delivery id; the sending game day is the
                // only stable occurrence discriminator available app-side. It
                // threads through the request key/journal identity only.
                const deliveryId = Number.isSafeInteger(letter.totalDays) && letter.totalDays >= 0 ? letter.totalDays : 0;
                snapshot = { slotId, deliveryId };
                fallbackSnapshot = snapshot;

                let identity: CampaignPlayerIdentity;
                try {
                    identity = requireCampaignIdentity({
                        playerID: gameData.playerID,
                        timelineSnapshotResult: gameData.timelineSnapshotResult
                    });
                } catch (error) {
                    if (error instanceof CampaignIdentityUnavailableError) {
                        reportCampaignIdentityUnavailable(error);
                        return null;
                    }
                    throw error;
                }

                // P2 chronicle observation of the outgoing-letter snapshot
                // (1.x LetterReplyGenerator.ts:492). Failure only marks the
                // store unhealthy; the reply flow continues.
                try {
                    await observeParsedGameDataForChronicle(app.getPath('userData'), gameData, 'letter', this.config.language);
                } catch (chronicleErr) {
                    const code = chronicleErr instanceof ChronicleStoreError ? chronicleErr.code : undefined;
                    console.error(`[Chronicle] observe failed (letter): code=${code ?? 'unknown'} path=${chronicleMemoryStorePath(app.getPath('userData'), identity)}`);
                    markChronicleUnhealthy(identity, code);
                }

                // The mod bumps the checkpoint after the init line, so the child
                // node becomes the new save node at epoch+1 (same as 1.x and the
                // 2CE conversation close flow).
                const nextCheckpointEpoch = gameData.votcCheckpointEpoch + 1;

                // Include the immutable letter occurrence in the signature so a
                // different letter after a save rollback cannot reuse the old
                // branch's journal attempt. Content is hashed, never persisted.
                const contentFingerprint = createHash('sha256')
                    .update(letter.content, 'utf8')
                    .digest('hex')
                    .slice(0, 16);
                const eventSignature = [
                    'letter',
                    snapshot.slotId,
                    snapshot.deliveryId,
                    gameData.playerID,
                    gameData.aiID,
                    gameData.date,
                    contentFingerprint
                ].join(':');

                try {
                    const transition = await runLetterReplyTimelineTransition({
                        // Registry root must match every other timeline source
                        // (conversation/incoming_letter/battle all use
                        // app.getPath('userData')). this.userDataPath is the
                        // votc_data subfolder used for summaries/letters only.
                        userDataDir: app.getPath('userData'),
                        gameData: gameData as any as GameDataLike,
                        identity,
                        slotId: snapshot.slotId,
                        letterDeliveryId: snapshot.deliveryId,
                        eventSignature,
                        targetEpoch: nextCheckpointEpoch,
                        // message_first_scope is the persisted player scope for
                        // this letter thread (set by mod2 ce message_events);
                        // talk_first_scope belongs to conversations.
                        scopeVar: 'global_var:message_first_scope'
                    });
                    timeline = {
                        nodeId: transition.targetNodeId,
                        parentId: transition.context.timelineParentId ?? null,
                        script: transition.script,
                        context: transition.context,
                        createdNewRoot: false
                    };
                    console.log(`Timeline node created for letter reply: ${timeline.nodeId} (parent: ${timeline.parentId ?? 'null'}, attempt: ${transition.attemptId}, reused: ${transition.reused})`);

                    // Guarded CK3 commit block for the letters.txt channel.
                    // Built once here and shared by the fallback payload
                    // (written below) and the final delivery (persisted on the
                    // reply letter so LetterManager.deliverLetter can splice
                    // it into letters.txt after the travel delay, even across
                    // an app restart). The block fail-closes on epoch/token
                    // mismatch, so a delivery after an interleaved transition
                    // logs timeline_skipped_* instead of regressing the save.
                    timelineRunBlock = buildLetterTimelineBlock({
                        letterNumber: slotId.replace('letter_', ''),
                        deliveryId: snapshot.deliveryId,
                        targetEpoch: nextCheckpointEpoch,
                        checkpointToken: transition.context.checkpointToken,
                        script: transition.script
                    });
                    fallbackTimelineRunBlock = timelineRunBlock;
                } catch (error) {
                    if (error instanceof CampaignIdentityUnavailableError) {
                        reportCampaignIdentityUnavailable(error);
                        return null;
                    }
                    if (error instanceof TimelineRegistryCorruptError) {
                        reportCorruptTimelineRegistry(error);
                        return null;
                    }
                    if (error instanceof TimelineParentNotFoundError) {
                        reportTimelineParentNotFound(error);
                        return null;
                    }
                    if (error instanceof UnsupportedTimelineSchemaError) {
                        reportUnsupportedTimelineSchema(error.schema);
                        return null;
                    }
                    throw error;
                }

            }

            // Build prompt
            const promptText = await this.buildLetterPrompt(gameData, letter);
            console.log(`[LetterReplyGenerator] Generated letter prompt: ${promptText.substring(0, 200)}...`);

            // Convert prompt to Message array format
            const messages: Message[] = [
                {
                    role: "user",
                    content: promptText
                }
            ];

            // Call LLM to generate reply
            console.log('[LetterReplyGenerator] Calling LLM to generate reply...');
            const response = await this.apiConnection.complete(messages, false, {
                max_tokens: this.config.maxTokens,
                temperature: this.config.textGenerationApiConnectionConfig.parameters.temperature
            });
            console.log('[LetterReplyGenerator] LLM call complete.');

            if (!response || response.trim() === '') {
                console.warn('[LetterReplyGenerator] Empty response from LLM for letter reply');
                this.writeLetterReplyFallbackPayload(snapshot, timelineRunBlock);
                return null;
            }

            // Escape quotes in the reply
            const escapedResponse = this.escapeQuotes(response.trim(), this.config.language);
            
            console.log(`[LetterReplyGenerator] Generated letter reply: ${escapedResponse.substring(0, 100)}...`);
            
            // Create a UUID for the reply letter *before* saving history and summary
            const replyLetterId = randomUUID();

            // Generate and save a summary of the letter
            console.log('[LetterReplyGenerator] Generating and saving letter summary...');
            await this.generateAndSaveLetterSummary(gameData, letter, escapedResponse, replyLetterId);
            console.log('[LetterReplyGenerator] Letter summary saved.');

            // Save letter history immediately
            console.log('[LetterReplyGenerator] Saving letter history...');
            const replyLetter = await this.saveLetterHistory(String(letter.sender.id), String(letter.recipient.id), letter, escapedResponse, gameData, replyLetterId, timelineRunBlock);
            console.log('[LetterReplyGenerator] Letter history saved.');
            
            // Update original letter status back to 'sent' since reply is now pending
            const letterManager = LetterManager.getInstance();
            letterManager.updateLetterStatus(String(letter.sender.id), String(letter.recipient.id), letter.id, 'sent');

            // Return the generated reply so it can be queued for delayed delivery
            if (replyLetter) {
                BrowserWindow.getAllWindows().forEach(win => {
                    win.webContents.send('letter-status-changed');
                });
            } else {
                // The reply text exists but could not be persisted; the in-game
                // thread would wait forever without the fallback handoff.
                this.writeLetterReplyFallbackPayload(snapshot, timelineRunBlock);
            }
            return replyLetter;
        } catch (error: unknown) {
            if (error instanceof Error) {
                console.error(`[LetterReplyGenerator] Error generating letter reply: ${error.message}`);
                console.error(error.stack);
            } else {
                console.error('[LetterReplyGenerator] An unknown error occurred during letter reply generation:', error);
            }
            this.writeLetterReplyFallbackPayload(fallbackSnapshot, fallbackTimelineRunBlock);
            return null;
        }
    }

    /**
     * Failure handoff for the letters.txt channel. Must only run after the
     * LLM path has actually FAILED: unlike 1.x (whose letterN.txt executed
     * once when the reply event window opened), letters.txt is polled every
     * ~2 seconds by the mod's letters_runner widget, so a fallback written
     * up-front would execute during the normal travel wait and consume the
     * thread before the real reply could be delivered. Transition/identity
     * failures reach this helper with no timelineRunBlock and intentionally
     * write nothing (the journal committed no node; the thread can be
     * cleared with the mod's clear-threads decision).
     */
    private writeLetterReplyFallbackPayload(
        snapshot: { slotId: string; deliveryId: number } | undefined,
        timelineRunBlock: string | undefined
    ): void {
        if (!snapshot || !timelineRunBlock) return;
        // The fallback payload shares the letters.txt channel (the only
        // letters execution point in mod2 ce), so it must go to the CK3 user
        // folder, not the app data dir.
        if (!this.config.userFolderPath) {
            console.warn('[LetterReplyGenerator] userFolderPath is not configured; fallback run payload was not written.');
            return;
        }
        writeLetterReplyFallbackRunFile(this.config.userFolderPath, snapshot.slotId, snapshot.deliveryId, timelineRunBlock);
    }

    /**
     * Saves the letter exchange to a local file.
     * @param playerId Player ID
     * @param aiId Character ID
     * @param letterContent Player's letter content
     * @param replyContent AI's reply content
     * @param userFolderPath User folder path
     * @param gameData Game data (for character names)
     */
    private async saveLetterHistory(playerId: string, aiId: string, originalLetter: ILetter, replyContent: string, gameData: GameData, replyLetterId: string, timelineRunBlock?: string): Promise<ILetter | null> {
        try {
            const letterManager = LetterManager.getInstance();
    
            const player = gameData.characters.get(Number(playerId));
            const ai = gameData.characters.get(Number(aiId));
    
            if (!player || !ai) {
                console.error("Could not find player or AI character to save letter history.");
                return null;
            }
    
            // AI writes the reply after stage 2 of the journey.
            const stage2EndDays = Math.floor(originalLetter.delay * 5 / 9);
            const replyWrittenDay = originalLetter.totalDays + stage2EndDays;
            
            const replyTimestamp = new Date(originalLetter.timestamp);
            replyTimestamp.setUTCDate(replyTimestamp.getUTCDate() + stage2EndDays);

            // The player is expected to receive the reply after the full delay.
            const expectedPlayerDeliveryDate = new Date(originalLetter.timestamp);
            expectedPlayerDeliveryDate.setUTCDate(expectedPlayerDeliveryDate.getUTCDate() + originalLetter.delay);

            const replyLetter = new Letter(
                replyLetterId,
                ai, // sender is the AI
                player, // recipient is the player
                `Re: ${originalLetter.subject}`,
                replyContent,
                LetterType.PERSONAL,
                replyTimestamp, // Use the calculated reply date
                false, // It's a new letter, so not read by the player yet
                originalLetter.delay,
                replyWrittenDay, // The "day number" when the reply was written
                originalLetter.id,
                'pending',
                false,
                undefined, // creationTimestamp
                undefined, // deliveryTimestamp (set on VOTC:LETTER_ACCEPTED)
                expectedPlayerDeliveryDate // When the player should receive it
            );
            replyLetter.votcCheckpointEpoch = gameData.votcCheckpointEpoch;
            // Persist the guarded timeline commit block with the reply so the
            // delayed delivery (and rehydrated deliveries after an app
            // restart) can still write the letter's node back to the save.
            replyLetter.timelineRunBlock = timelineRunBlock;
    
            // Atomically update the history file
            const otherCharacterId = aiId; // The file is named after the non-player character
            const filePath = letterManager.getLetterFilePath(playerId, otherCharacterId);
    
            let history: ILetter[] = [];
            if (fs.existsSync(filePath)) {
                history = letterManager.getLetters(playerId, otherCharacterId);
            }
    
            // Add original letter if not present (using a more robust duplicate check)
            const isOriginalDuplicate = history.some(l =>
                l.subject === originalLetter.subject &&
                l.totalDays === originalLetter.totalDays &&
                l.sender.id === originalLetter.sender.id &&
                l.recipient.id === originalLetter.recipient.id
            );
            if (!isOriginalDuplicate) {
                history.push(originalLetter);
            }

            // Add reply letter if not present (UUID check is fine here as it's brand new)
            if (!history.some(l => l.id === replyLetter.id)) {
                history.push(replyLetter);
            }
            
            history.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
            fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
            
            console.log(`Saved original letter and AI reply to letter history for player ${playerId} and character ${aiId}`);
    
            return replyLetter;
        } catch (error) {
            console.error(`Error saving letter history: ${error}`);
            return null;
        }
    }

    /**
     * Generates a summary of the letter exchange and saves it to the summary file.
     * @param gameData Game data
     * @param letterContent Player's letter content
     * @param replyContent AI's reply content
     */
    private async generateAndSaveLetterSummary(gameData: GameData, originalLetter: ILetter, replyContent: string, replyLetterId: string): Promise<void> {
        try {
            const player = gameData.characters.get(originalLetter.sender.id);
            const ai = gameData.characters.get(originalLetter.recipient.id);
            
            if (!player || !ai) {
                console.error('Player or AI character data not found for summary generation');
                return;
            }

            // Build summary generation prompt
            const effectivePrompts = getEffectivePrompts(this.config, this.userDataPath, gameData);
            let summaryPrompt = effectivePrompts.letterSummaryPrompt;

            summaryPrompt = summaryPrompt.replace('{{playerName}}', player.fullName)
                                         .replace('{{playerLetterContent}}', originalLetter.content)
                                         .replace('{{aiName}}', ai.fullName)
                                         .replace('{{aiReplyContent}}', replyContent);

            // Use LLM to generate summary
            const summaryMessages: Message[] = [
                {
                    role: "user",
                    content: summaryPrompt
                }
            ];

            const summaryContent = await this.apiConnection.complete(summaryMessages, false, {
                max_tokens: 150,
                temperature: 0.3 // Use a lower temperature for more stable summaries
            });

            if (!summaryContent || summaryContent.trim() === '') {
                console.warn('Empty summary content generated');
                return;
            }

            console.log(`Generated letter summary: ${summaryContent.trim()}`);

            const letterDate = gameData.date;
            const playerId = String(originalLetter.sender.id);
            const aiId = String(originalLetter.recipient.id);

            const newSummary: LetterSummary = {
                id: randomUUID(),
                date: letterDate,
                summary: summaryContent.trim(),
                letterIds: [originalLetter.id, replyLetterId],
                votcCheckpointEpoch: gameData.votcCheckpointEpoch
            };
    
            const letterManager = LetterManager.getInstance();
            const existingSummaries = letterManager.getLetterSummaries(playerId, aiId);
            
            // Add new summary to the beginning of the list
            existingSummaries.unshift(newSummary);
    
            letterManager.saveLetterSummaries(playerId, aiId, existingSummaries);
            console.log(`Letter summary saved for AI ID ${aiId}`);

        } catch (error) {
            console.error(`Error generating and saving letter summary: ${error}`);
        }
    }

    // This function is now handled by the delivery mechanism in main.ts to support delays.
}
