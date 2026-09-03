import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { Summary } from './ts/conversation_interfaces';
import { TimelineRegistry, isRecordVisibleForContext } from './timelineManager.js';
import { conversationSummariesDir as campaignConversationSummariesDir } from './campaignDataPaths.js';
import type { CampaignPlayerIdentity } from '../shared/gameData/CampaignIdentity.js';

function getSummaryCheckpointEpoch(summary: any): number | undefined {
    const rawEpoch = summary?.votcCheckpointEpoch;
    if (rawEpoch === undefined || rawEpoch === null || rawEpoch === '') {
        return undefined;
    }
    const epoch = Number(rawEpoch);
    return Number.isFinite(epoch) ? epoch : undefined;
}

export function splitSummariesForCheckpoint<T extends { votcCheckpointEpoch?: number }>(summaries: T[], checkpointEpoch: number): { visibleSummaries: T[], futureSummaries: T[] } {
    const visibleSummaries: T[] = [];
    const futureSummaries: T[] = [];
    summaries.forEach((summary) => {
        // Records anchored to a timeline node are graph-visible regardless of
        // their epoch stamp (1.x summaryManager isTimelineSummary semantics).
        // The incoming-letter writer stamps votcCheckpointEpoch = post-bump,
        // which is always > the pre-bump epoch of the read that follows it.
        if (getSummaryTimelineNodeId(summary)) {
            visibleSummaries.push(summary);
            return;
        }
        const summaryEpoch = getSummaryCheckpointEpoch(summary);
        if (summaryEpoch !== undefined && summaryEpoch > checkpointEpoch) {
            futureSummaries.push(summary);
        } else {
            visibleSummaries.push(summary);
        }
    });
    return { visibleSummaries, futureSummaries };
}

function getSummaryTimelineNodeId(summary: any): string | undefined {
    const nodeId = summary?.votcTimelineNodeId;
    return typeof nodeId === 'string' && nodeId !== '' ? nodeId : undefined;
}

export function filterSummariesForCheckpoint<T extends { votcCheckpointEpoch?: number }>(summaries: T[], checkpointEpoch: number): T[] {
    return splitSummariesForCheckpoint(summaries, checkpointEpoch).visibleSummaries;
}

export function archiveFutureSummariesForCheckpoint(
    userDataPath: string,
    playerId: string,
    characterId: string,
    summaries: any[],
    checkpointEpoch: number,
    options: { sourceFilePath?: string, reason?: string } = {}
): { visibleSummaries: any[], archivedSummaries: any[], archiveFilePath?: string } {
    const { visibleSummaries, futureSummaries } = splitSummariesForCheckpoint(summaries, checkpointEpoch);
    if (futureSummaries.length === 0) {
        return { visibleSummaries, archivedSummaries: [] };
    }

    const archiveDir = path.join(userDataPath, 'conversation_summaries_archived', playerId);
    fs.mkdirSync(archiveDir, { recursive: true });

    const archiveFilePath = path.join(archiveDir, `${characterId}.json`);
    let existingArchivedSummaries: any[] = [];
    if (fs.existsSync(archiveFilePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(archiveFilePath, 'utf8'));
            if (Array.isArray(parsed)) {
                existingArchivedSummaries = parsed;
            }
        } catch (error) {
            console.error(`Failed to read archive file ${archiveFilePath}:`, error);
        }
    }

    const archivedAt = new Date().toISOString();
    const archivedSummaries = futureSummaries.map((summary) => ({
        ...summary,
        archivedAt,
        archiveReason: options.reason ?? 'older_save_checkpoint',
        archivedFromCheckpointEpoch: checkpointEpoch,
        archivedSourcePlayerId: playerId,
        archivedSourceCharacterId: characterId,
        archivedSourceFilePath: options.sourceFilePath
    }));

    const mergedArchivedSummaries: any[] = [];
    const seenKeys = new Set<string>();
    [...archivedSummaries, ...existingArchivedSummaries].forEach((summary) => {
        const key = [
            summary?.archivedSourcePlayerId ?? '',
            summary?.archivedSourceCharacterId ?? summary?.characterId ?? '',
            getSummaryCheckpointEpoch(summary) ?? '',
            summary?.date ?? '',
            summary?.content ?? ''
        ].join('\u001f');
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            mergedArchivedSummaries.push(summary);
        }
    });

    fs.writeFileSync(archiveFilePath, JSON.stringify(mergedArchivedSummaries, null, '\t'), 'utf8');
    return { visibleSummaries, archivedSummaries, archiveFilePath };
}

export function archiveFutureSummaryFilesForPlayer(userDataPath: string, playerId: string, checkpointEpoch: number, reason: string = 'older_save_checkpoint'): number {
    const summaryDir = path.join(userDataPath, 'conversation_summaries', playerId);
    if (!fs.existsSync(summaryDir)) {
        return 0;
    }

    let archivedCount = 0;
    const files = fs.readdirSync(summaryDir).filter(file => file.endsWith('.json') && file !== '_character_map.json');

    files.forEach((file) => {
        const summaryFilePath = path.join(summaryDir, file);
        try {
            const summaries = JSON.parse(fs.readFileSync(summaryFilePath, 'utf8'));
            if (!Array.isArray(summaries)) return;

            const characterId = path.basename(file, '.json');
            const result = archiveFutureSummariesForCheckpoint(userDataPath, playerId, characterId, summaries, checkpointEpoch, {
                sourceFilePath: summaryFilePath,
                reason
            });

            if (result.archivedSummaries.length > 0) {
                fs.writeFileSync(summaryFilePath, JSON.stringify(result.visibleSummaries, null, '\t'), 'utf8');
                archivedCount += result.archivedSummaries.length;
                console.log(`Archived ${result.archivedSummaries.length} future summaries from ${summaryFilePath} for checkpoint ${checkpointEpoch}.`);
            }
        } catch (error) {
            console.error(`Failed to archive future summaries ${summaryFilePath}:`, error);
        }
    });

    return archivedCount;
}

/**
 * Gets all player IDs by scanning summary directories.
 * @param userDataPath The path to the user data directory (e.g., .../votc_data).
 * @returns A promise that resolves to an array of player ID strings.
 */
export async function getAllPlayerIds(userDataPath: string): Promise<{ id: string, name: string }[]> {
    try {
        const summaryDir = path.join(userDataPath, 'conversation_summaries');
        const playerDirsData: { id: string, name: string }[] = [];
        if (fs.existsSync(summaryDir)) {
            playerDirsData.push(...fs.readdirSync(summaryDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => {
                    const playerId = dirent.name;
                    const mapPath = path.join(summaryDir, playerId, '_character_map.json');
                    let playerName = `Player ${playerId}`; // Fallback name
                    if (fs.existsSync(mapPath)) {
                        try {
                            const mapContent = fs.readFileSync(mapPath, 'utf8');
                            const mapData = JSON.parse(mapContent);
                            if (mapData[playerId]) {
                                playerName = mapData[playerId];
                            }
                        } catch (e) {
                            console.error(`Error reading character map for player ${playerId}:`, e);
                        }
                    }
                    return { id: playerId, name: playerName };
                }));
        }

        // F24: campaign-scoped conversation_summaries stores are part of the
        // same listing surface. Scan every campaign's player store so
        // campaign-only players show up in the summary manager; ids already
        // present from the flat scan keep their flat entry (first wins).
        const campaignsRoot = path.join(userDataPath, 'campaigns');
        if (fs.existsSync(campaignsRoot)) {
            for (const campaignId of fs.readdirSync(campaignsRoot)) {
                const campaignPlayersDir = path.join(campaignsRoot, campaignId, 'players');
                if (!fs.existsSync(campaignPlayersDir)) {
                    continue;
                }
                for (const dirent of fs.readdirSync(campaignPlayersDir, { withFileTypes: true })) {
                    if (!dirent.isDirectory()) continue;
                    const playerId = dirent.name;
                    if (playerDirsData.some(player => player.id === playerId)) {
                        continue;
                    }
                    const campaignSummaryDir = path.join(campaignPlayersDir, playerId, 'conversation_summaries');
                    if (!fs.existsSync(campaignSummaryDir)) {
                        continue;
                    }
                    let playerName = `Player ${playerId}`;
                    const mapPath = path.join(campaignSummaryDir, '_character_map.json');
                    if (fs.existsSync(mapPath)) {
                        try {
                            const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                            if (mapData[playerId]) {
                                playerName = mapData[playerId];
                            }
                        } catch (e) {
                            console.error(`Error reading campaign character map for player ${playerId}:`, e);
                        }
                    }
                    playerDirsData.push({ id: playerId, name: playerName });
                }
            }
        }

        const playerTimestamps = await Promise.all(playerDirsData.map(async (player) => {
            let latestTimestamp = 0;
            try {
                const summaries = await readSummaryFile(userDataPath, player.id);
                for (const summary of summaries) {
                    if ((summary as any).creationTimestamp) {
                        const timestamp = new Date((summary as any).creationTimestamp).getTime();
                        if (timestamp > latestTimestamp) {
                            latestTimestamp = timestamp;
                        }
                    }
                }
            } catch (e) {
                console.error(`Error processing summaries for player ${player.id}:`, e);
            }
            return { ...player, latestTimestamp };
        }));

        playerTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

        return playerTimestamps.map(({ id, name }) => ({ id, name }));

    } catch (error) {
        console.error('Error getting all player IDs from summaries:', error);
        throw error;
    }
}

/**
 * Gets the most recent player ID by scanning summary directories.
 * This is determined by finding the most recently modified player directory.
 * @param userDataPath The path to the user data directory (e.g., .../votc_data).
 * @returns A promise that resolves to an object containing the player ID.
 */
export async function getPlayerId(userDataPath: string): Promise<{playerId: string}> {
    try {
        const summaryDir = path.join(userDataPath, 'conversation_summaries');
        if (!fs.existsSync(summaryDir)) {
            throw new Error(`Conversation summaries directory not found at: ${summaryDir}`);
        }

        const playerDirs = fs.readdirSync(summaryDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => {
                return {
                    name: dirent.name,
                    time: fs.statSync(path.join(summaryDir, dirent.name)).mtimeMs,
                };
            });

        if (playerDirs.length === 0) {
            throw new Error('No player summary directories found.');
        }

        // Sort by most recent modification time
        playerDirs.sort((a, b) => b.time - a.time);
        
        const recentPlayerId = playerDirs[0].name;
        if (!recentPlayerId) {
            throw new Error('Could not determine the most recent player ID.');
        }
        
        return { playerId: recentPlayerId };
    } catch (error) {
        console.error('Error getting player ID from summaries:', error);
        throw error;
    }
}

/**
 * Reads all summary files for a given player.
 * @param userDataPath The path to the user data directory.
 * @param playerId The ID of the player whose summaries to read.
 * @param checkpointEpoch Optional checkpoint filter (legacy epoch-based).
 * @param registry Optional timeline registry for branch visibility of
 *                 node-tagged records (1.x readSummaryFile parity).
 * @param currentNodeId Current timeline node id used with `registry`.
 * @param identity When present, reads the campaign-scoped summary directory
 *                 instead of the legacy player-only one.
 * @returns A promise that resolves to an array of all summaries.
 */
export async function readSummaryFile(
    userDataPath: string,
    playerId: string,
    checkpointEpoch?: number,
    registry?: TimelineRegistry,
    currentNodeId?: string,
    identity?: CampaignPlayerIdentity
): Promise<Summary[]> {
    try {
        // Campaign-scoped layout is rooted at the userData dir; the legacy
        // layout hangs off the votc_data dir passed in by callers.
        const summaryDir = identity
            ? campaignConversationSummariesDir(app.getPath('userData'), identity)
            : path.join(userDataPath, 'conversation_summaries', playerId);
        
        // Ensure directory exists
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
            return [];
        }
        
        // Read all JSON files in the directory
        const files = fs.readdirSync(summaryDir).filter(file => file.endsWith('.json') && file !== '_character_map.json');
        const allSummaries: Summary[] = [];
        
        for (const file of files) {
            const filePath = path.join(summaryDir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const summaries: Summary[] = JSON.parse(content);
                // Add character ID info to each summary
                const characterId = path.basename(file, '.json');
                const summariesWithCharacterId = summaries.map((summary) => ({
                    ...summary,
                    characterId
                }));
                allSummaries.push(...summariesWithCharacterId);
            } catch (error) {
                console.error(`Failed to read file ${filePath}:`, error);
            }
        }
        
        // First apply the legacy epoch filter (preserves all timeline-tagged
        // records regardless of epoch), then apply graph-based visibility for
        // timeline records so other-branch summaries are hidden.
        // NOTE: the incoming-letter generator (P1) now stamps both
        // votcTimelineNodeId and a post-bump votcCheckpointEpoch; the split
        // helpers keep node-tagged records visible (1.x isTimelineSummary
        // semantics), so the branch below is active for those records.
        const epochFiltered = checkpointEpoch === undefined
            ? allSummaries
            : filterSummariesForCheckpoint(allSummaries, checkpointEpoch);
        const visibleSummaries = epochFiltered.filter((summary) =>
            isRecordVisibleForContext(registry, currentNodeId, summary, checkpointEpoch)
        );

        // Sort by date
        visibleSummaries.sort((a, b) => {
            const extractDate = (dateStr: string) => {
                if (!dateStr) return { year: 0, month: 1, day: 1 };
                const match = dateStr.match(/(\d+)年(\d+)月(\d+)日/);
                if (match) {
                    return { year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3]) };
                }
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
                }
                return { year: 0, month: 1, day: 1 };
            };
            const dateA = extractDate(a.date);
            const dateB = extractDate(b.date);
            if (dateB.year !== dateA.year) return dateB.year - dateA.year;
            if (dateB.month !== dateA.month) return dateB.month - dateA.month;
            return dateB.day - dateA.day;
        });
        
        return visibleSummaries;
    } catch (error) {
        console.error('Error reading summary file:', error);
        throw error;
    }
}

export interface SaveSummaryOptions {
    registry?: TimelineRegistry;
    currentNodeId?: string;
    /** Route generated source records to the campaign/player namespace. */
    identity?: CampaignPlayerIdentity;
    /** Replace records visible in this context while retaining hidden branches. */
    replaceVisibleContext?: boolean;
}

function summaryMergeKey(summary: any): string {
    if (summary?.id) return `id:${summary.id}`;
    return [
        summary?.votcTimelineNodeId ?? '',
        getSummaryCheckpointEpoch(summary) ?? '',
        summary?.date ?? '',
        summary?.content ?? ''
    ].join('\u001f');
}

/**
 * Three-way merge for timeline-aware saves (1.x summaryManager parity):
 * incoming records replace same-key records, and on-disk records that are not
 * represented in the incoming set are preserved. With `replaceVisibleContext`,
 * a missing record that was visible in the caller's context counts as a
 * deletion, while hidden sibling-branch records still survive.
 */
export function mergeSummariesForTimelineSave(
    incomingSummaries: any[],
    existingOnDisk: any[],
    checkpointEpoch: number | undefined,
    options: SaveSummaryOptions = {}
): any[] {
    const incomingKeys = new Set(incomingSummaries.map(summaryMergeKey));
    const preservedFromOtherBranches = existingOnDisk.filter((summary: any) => {
        if (incomingKeys.has(summaryMergeKey(summary))) return false;
        if (!options.replaceVisibleContext) return true;

        // A missing record that was visible in the manager is a deletion. Hidden
        // sibling-branch records were never sent to the renderer and must survive.
        return !isRecordVisibleForContext(
            options.registry,
            options.currentNodeId,
            summary,
            checkpointEpoch
        );
    });
    return [...incomingSummaries, ...preservedFromOtherBranches];
}

/**
 * Timeline-aware save path: merges incoming (current-context) summaries with
 * the on-disk set instead of overwriting whole files, and never deletes
 * summary files for characters absent from the incoming set.
 */
async function saveSummaryFileWithTimelineMerge(
    userDataPath: string,
    playerId: string,
    summaries: Summary[],
    checkpointEpoch: number | undefined,
    options: SaveSummaryOptions
): Promise<void> {
    try {
        const summaryDir = options.identity
            ? campaignConversationSummariesDir(app.getPath('userData'), options.identity)
            : path.join(userDataPath, 'conversation_summaries', playerId);

        // Ensure directory exists
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
        }

        // Group summaries by character ID
        const summariesByCharacter: { [key: string]: Summary[] } = {};
        summaries.forEach(summary => {
            const characterId = summary.characterId || 'default';
            if (!summariesByCharacter[characterId]) {
                summariesByCharacter[characterId] = [];
            }
            summariesByCharacter[characterId].push(summary);
        });

        // The manager may delete the last visible summary for a character. Include
        // existing files so an empty incoming group can still replace that context.
        const characterIds = new Set(Object.keys(summariesByCharacter));
        if (options.replaceVisibleContext) {
            fs.readdirSync(summaryDir)
                .filter(file => file.endsWith('.json') && file !== '_character_map.json')
                .forEach(file => characterIds.add(path.basename(file, '.json')));
        }

        for (const characterId of characterIds) {
            const characterSummaries = summariesByCharacter[characterId] ?? [];
            const summaryFilePath = path.join(summaryDir, `${characterId}.json`);

            // Remove characterId field as it is already in the filename
            const cleanSummaries = characterSummaries.map((summary) => {
                const { characterId: _drop, ...cleanSummary } = summary;
                return cleanSummary;
            });
            const incomingFiltered = checkpointEpoch === undefined
                ? cleanSummaries
                : filterSummariesForCheckpoint(cleanSummaries, checkpointEpoch);

            let existingOnDisk: any[] = [];
            if (fs.existsSync(summaryFilePath)) {
                try {
                    const readExisting = JSON.parse(fs.readFileSync(summaryFilePath, 'utf8'));
                    if (Array.isArray(readExisting)) {
                        if (checkpointEpoch !== undefined) {
                            // Archive legacy (no-node) future summaries before merging.
                            const archiveResult = archiveFutureSummariesForCheckpoint(userDataPath, playerId, characterId, readExisting, checkpointEpoch, {
                                sourceFilePath: summaryFilePath,
                                reason: 'save_summary_file_checkpoint_filter'
                            });
                            existingOnDisk = archiveResult.visibleSummaries;
                        } else {
                            existingOnDisk = readExisting;
                        }
                    }
                } catch (error) {
                    console.error(`Failed to read existing summaries before merge ${summaryFilePath}:`, error);
                }
            }

            const mergedSummaries = mergeSummariesForTimelineSave(
                incomingFiltered,
                existingOnDisk,
                checkpointEpoch,
                options
            );

            fs.writeFileSync(summaryFilePath, JSON.stringify(mergedSummaries, null, '\t'), 'utf8');
        }
    } catch (error) {
        console.error('Error saving summary file:', error);
        throw error;
    }
}

/**
 * Saves summaries to their respective character files for a given player.
 *
 * Legacy behavior (no options argument): whole-overwrite semantics; summary
 * files for characters absent from `summaries` are deleted. When an options
 * object is provided, the timeline-aware merge path is used instead: hidden
 * sibling-branch records on disk are preserved and no character files are
 * deleted. Callers opt into the merge path by passing `options`, even when
 * every field is undefined (e.g. registry unavailable): the merge still
 * preserves on-disk records that are missing from the incoming set.
 *
 * @param userDataPath The path to the user data directory.
 * @param playerId The ID of the player.
 * @param summaries An array of all summaries to save.
 */
export async function saveSummaryFile(
    userDataPath: string,
    playerId: string,
    summaries: Summary[],
    checkpointEpoch?: number,
    options?: SaveSummaryOptions
): Promise<void> {
    if (options !== undefined) {
        return saveSummaryFileWithTimelineMerge(userDataPath, playerId, summaries, checkpointEpoch, options);
    }
    try {
        const summaryDir = path.join(userDataPath, 'conversation_summaries', playerId);
        
        // Ensure directory exists
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
        }

        const existingSummaryFiles = fs.readdirSync(summaryDir).filter(f => f.endsWith('.json') && f !== '_character_map.json');
        const existingCharIds = new Set(existingSummaryFiles.map(f => f.replace('.json', '')));
        
        // Group summaries by character ID
        const summariesByCharacter: { [key: string]: Summary[] } = {};
        summaries.forEach(summary => {
            const characterId = summary.characterId || 'default';
            if (!summariesByCharacter[characterId]) {
                summariesByCharacter[characterId] = [];
            }
            summariesByCharacter[characterId].push(summary);
            existingCharIds.delete(characterId);
        });
        
        // Create a separate file for each character
        for (const [characterId, characterSummaries] of Object.entries(summariesByCharacter)) {
            const summaryFilePath = path.join(summaryDir, `${characterId}.json`);
            
            // Remove characterId field as it is already in the filename
            const cleanSummaries = characterSummaries.map((summary) => {
                const { characterId, ...cleanSummary } = summary;
                return cleanSummary;
            });
            
            // Archive future summaries before saving if checkpoint epoch is provided
            if (checkpointEpoch !== undefined && fs.existsSync(summaryFilePath)) {
                try {
                    const existingSummaries = JSON.parse(fs.readFileSync(summaryFilePath, 'utf8'));
                    if (Array.isArray(existingSummaries)) {
                        archiveFutureSummariesForCheckpoint(userDataPath, playerId, characterId, existingSummaries, checkpointEpoch, {
                            sourceFilePath: summaryFilePath,
                            reason: 'save_summary_file_checkpoint_filter'
                        });
                    }
                } catch (error) {
                    console.error(`Failed to archive before save ${summaryFilePath}:`, error);
                }
            }

            // Apply checkpoint filter to summaries being saved
            const summariesToSave = checkpointEpoch === undefined
                ? cleanSummaries
                : filterSummariesForCheckpoint(cleanSummaries, checkpointEpoch);
            
            // Write to file
            fs.writeFileSync(summaryFilePath, JSON.stringify(summariesToSave, null, '\t'), 'utf8');
        }

        // Delete summaries for characters that were removed
        for (const charIdToDelete of existingCharIds) {
            const summaryPath = path.join(summaryDir, `${charIdToDelete}.json`);
            if (fs.existsSync(summaryPath)) {
                fs.unlinkSync(summaryPath);
                console.log(`Deleted conversation summary for character ${charIdToDelete}`);
            }
        }
    } catch (error) {
        console.error('Error saving summary file:', error);
        throw error;
    }
}

/**
 * Reads the character map for a given player.
 * @param userDataPath The path to the user data directory.
 * @param playerId The ID of the player whose character map to read.
 * @returns A promise that resolves to a map of character IDs to names.
 */
export async function readCharacterMap(userDataPath: string, playerId: string): Promise<Map<string, string>> {
    try {
        const mapFilePath = path.join(userDataPath, 'conversation_summaries', playerId, '_character_map.json');
        const characterMap = new Map<string, string>();

        if (fs.existsSync(mapFilePath)) {
            const content = fs.readFileSync(mapFilePath, 'utf8');
            const mapData = JSON.parse(content);
            for (const id in mapData) {
                characterMap.set(id, mapData[id]);
            }
        }
        
        return characterMap;
    } catch (error) {
        console.error('Error reading character map file:', error);
        throw error;
    }
}

/**
 * Saves the character map for a given player.
 * @param userDataPath The path to the user data directory.
 * @param playerId The ID of the player whose character map to save.
 * @param characterMap An object mapping character IDs to names.
 */
export async function saveCharacterMap(userDataPath: string, playerId: string, characterMap: object): Promise<void> {
    try {
        const mapFilePath = path.join(userDataPath, 'conversation_summaries', playerId, '_character_map.json');
        const summaryDir = path.dirname(mapFilePath);

        // Ensure directory exists
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
        }

        fs.writeFileSync(mapFilePath, JSON.stringify(characterMap, null, '\t'), 'utf8');
    } catch (error) {
        console.error('Error saving character map file:', error);
        throw error;
    }
}
