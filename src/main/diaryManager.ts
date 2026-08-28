

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { DiaryEntry, DiarySummary, DiaryTimelineStamp } from './ts/diary_interfaces';
import { randomUUID } from 'crypto';
import { TimelineRegistry, isRecordVisibleForContext } from './timelineManager.js';
import { archiveFutureRecords } from './conversationHistory.js';

const userDataPath = path.join(app.getPath('userData'), 'votc_data');
const diariesDir = path.join(userDataPath, 'diary_history');
const diarySummariesDir = path.join(userDataPath, 'diary_summaries');
const diariesArchivedDir = path.join(userDataPath, 'diary_history_archived');
const diarySummariesArchivedDir = path.join(userDataPath, 'diary_summaries_archived');

/**
 * Timeline v2 read context for diary data. Diary storage stays player-scoped
 * (P6), so the context is resolved per read by the caller: live conversation
 * game data when a session is active, otherwise the manager-window
 * registry-only resolution (the diary window has no clipboard payload yet).
 */
export interface DiaryVisibilityContext {
    checkpointEpoch?: number;
    registry?: TimelineRegistry;
    currentNodeId?: string;
    campaignId?: string;
}

/**
 * Visibility for a diary record, following isRecordVisibleForContext
 * semantics: records anchored to a timeline node go through graph visibility
 * when a registry + current node are available; node-less (legacy) records
 * follow epoch semantics. When no graph context can be resolved at all (the
 * diary manager window carries no checkpoint payload yet), node-tagged
 * records degrade to epoch semantics instead of fail-closing so the diary
 * manager does not hide the current branch's entries. Archive triggers
 * (archiveFutureDiaryRecordsForPlayer) provide the hard cleanup.
 */
export function isDiaryRecordVisible(record: any, visibility?: DiaryVisibilityContext): boolean {
    if (!visibility) {
        return true;
    }
    // A record written under another campaign of the same player is never
    // visible in this campaign (diary files are shared per player).
    if (record?.votcCampaignId && visibility.campaignId && record.votcCampaignId !== visibility.campaignId) {
        return false;
    }
    const nodeId = record?.votcTimelineNodeId;
    if (nodeId && visibility.registry && visibility.currentNodeId) {
        return isRecordVisibleForContext(visibility.registry, visibility.currentNodeId, record, visibility.checkpointEpoch);
    }
    if (visibility.checkpointEpoch === undefined) {
        return true;
    }
    const recordEpoch = Number(record?.votcCheckpointEpoch);
    return !Number.isFinite(recordEpoch) || recordEpoch <= visibility.checkpointEpoch;
}

function getPlayerDiaryDir(playerId: string): string {
    return path.join(diariesDir, playerId);
}

function getDiaryFilePath(playerId: string, characterId: string): string {
    return path.join(getPlayerDiaryDir(playerId), `${characterId}.json`);
}

function getDiarySummaryFilePath(playerId: string, characterId: string): string {
    const playerSummaryDir = path.join(diarySummariesDir, playerId);
    if (!fs.existsSync(playerSummaryDir)) {
        fs.mkdirSync(playerSummaryDir, { recursive: true });
    }
    return path.join(playerSummaryDir, `${characterId}.json`);
}

/** Copies only the defined stamp fields so legacy records stay field-less. */
function pickStampFields(source: any): DiaryTimelineStamp {
    const stamp: DiaryTimelineStamp = {};
    if (source?.votcCheckpointEpoch !== undefined) stamp.votcCheckpointEpoch = source.votcCheckpointEpoch;
    if (typeof source?.votcTimelineNodeId === 'string' && source.votcTimelineNodeId !== '') stamp.votcTimelineNodeId = source.votcTimelineNodeId;
    if (typeof source?.votcTimelineParentId === 'string' && source.votcTimelineParentId !== '') stamp.votcTimelineParentId = source.votcTimelineParentId;
    if (typeof source?.votcCampaignId === 'string' && source.votcCampaignId !== '') stamp.votcCampaignId = source.votcCampaignId;
    return stamp;
}

/** Reads a diary summary file without any visibility filtering. */
function readDiarySummaryFileRaw(playerId: string, characterId: string): any[] {
    const summaryPath = getDiarySummaryFilePath(playerId, characterId);
    if (!fs.existsSync(summaryPath)) {
        return [];
    }
    try {
        const data = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
        if (Array.isArray(data)) {
            return data;
        }
        if (typeof data === 'object' && data !== null && data.summary) {
            return [data];
        }
    } catch (error) {
        console.error(`Error parsing diary summary file ${summaryPath}:`, error);
    }
    return [];
}

export async function readDiarySummaries(playerId: string, characterId: string, visibility?: DiaryVisibilityContext): Promise<DiarySummary[]> {
    const summaryPath = getDiarySummaryFilePath(playerId, characterId);
    if (!fs.existsSync(summaryPath)) {
        return [];
    }
    const fileContent = await fs.promises.readFile(summaryPath, 'utf-8');
    let result: DiarySummary[] = [];
    try {
        const data = JSON.parse(fileContent);

        if (Array.isArray(data)) {
            // New format (array of summaries).
            result = data.reduce((acc: DiarySummary[], s: any) => {
                if (typeof s === 'object' && s !== null && s.summary && typeof s.date !== 'undefined') {
                    acc.push({
                        id: s.id || randomUUID(),
                        diaryEntryId: s.diaryEntryId || '',
                        date: s.date,
                        summary: s.summary,
                        characterId: characterId,
                        ...pickStampFields(s)
                    });
                }
                return acc;
            }, []);
        } else if (typeof data === 'object' && data !== null && data.summary) {
            // Old format (single summary object), possibly without a date.
            result = [{
                id: randomUUID(),
                diaryEntryId: '',
                date: data.date || '', // Provide empty string if date is missing
                summary: data.summary,
                characterId: characterId,
                ...pickStampFields(data)
            }];
        }
    } catch (error) {
        console.error(`Error parsing diary summary file ${summaryPath}:`, error);
    }

    if (visibility) {
        result = result.filter(s => isDiaryRecordVisible(s, visibility));
    }
    return result;
}

export async function saveDiarySummaries(playerId: string, characterId: string, summaries: DiarySummary[]): Promise<void> {
    const summaryPath = getDiarySummaryFilePath(playerId, characterId);
    await fs.promises.writeFile(summaryPath, JSON.stringify(summaries, null, '\t'));
}

/**
 * Manager-UI bulk save (`save-all-diary-summaries`). Merge semantics instead
 * of whole-file overwrite: the UI only ever sees the records visible in the
 * current timeline context, so any existing record that is NOT visible
 * (future checkpoint or another branch) is preserved rather than silently
 * dropped. A character file is deleted only when the character was removed
 * from the UI payload AND all of its existing summaries were visible (i.e.
 * the user actually saw and removed them); files whose summaries are all
 * hidden in the current context are left untouched. When no visibility
 * context is provided this degrades to the legacy overwrite behavior.
 */
export async function saveAllDiarySummariesMerged(playerId: string, summariesData: any[], visibility?: DiaryVisibilityContext): Promise<void> {
    const summaryDir = path.join(diarySummariesDir, playerId);
    const existingSummaryFiles = fs.existsSync(summaryDir)
        ? fs.readdirSync(summaryDir).filter(f => f.endsWith('.json') && f !== '_character_map.json')
        : [];
    const incomingCharIds = new Set(summariesData.map(s => s?.characterId).filter(id => id !== undefined && id !== null));

    const summariesByCharacter: { [key: string]: any[] } = {};
    summariesData.forEach(summary => {
        const characterId = summary.characterId;
        if (!summariesByCharacter[characterId]) {
            summariesByCharacter[characterId] = [];
        }
        summariesByCharacter[characterId].push(summary);
    });

    for (const [characterId, summaries] of Object.entries(summariesByCharacter)) {
        summaries.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const cleanSummaries = summaries.map(({ characterName, ...rest }) => rest);

        let summariesToSave = cleanSummaries;
        if (visibility) {
            const existing = readDiarySummaryFileRaw(playerId, characterId);
            const incomingIds = new Set(cleanSummaries.map(s => s?.id));
            const preserved = existing.filter(s => s && !incomingIds.has(s.id) && !isDiaryRecordVisible(s, visibility));
            if (preserved.length > 0) {
                summariesToSave = [...cleanSummaries, ...preserved];
                summariesToSave.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
            }
        }
        await saveDiarySummaries(playerId, characterId, summariesToSave);
    }

    // Delete summaries for characters that were removed
    for (const file of existingSummaryFiles) {
        const characterId = path.basename(file, '.json');
        if (incomingCharIds.has(characterId)) {
            continue;
        }
        const summaryPath = path.join(summaryDir, file);
        if (!visibility) {
            if (fs.existsSync(summaryPath)) {
                fs.unlinkSync(summaryPath);
                console.log(`Deleted diary summary for character ${characterId}`);
            }
            continue;
        }
        const existing = readDiarySummaryFileRaw(playerId, characterId);
        const remaining = existing.filter(s => s && !isDiaryRecordVisible(s, visibility));
        if (existing.length > 0 && remaining.length === existing.length) {
            // Every existing summary is hidden in the current context: the UI
            // never showed them, so the user cannot have deleted them. Keep.
            continue;
        }
        if (remaining.length > 0) {
            await saveDiarySummaries(playerId, characterId, remaining);
            console.log(`Kept ${remaining.length} hidden diary summaries for character ${characterId} (removed from view).`);
        } else if (fs.existsSync(summaryPath)) {
            fs.unlinkSync(summaryPath);
            console.log(`Deleted diary summary for character ${characterId}`);
        }
    }
}

export async function parseDiaryIdsFromLog(logFilePath: string): Promise<{ playerId: string | null }> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(logFilePath)) {
            return reject(new Error(`Log file not found at: ${logFilePath}`));
        }

        const stream = fs.createReadStream(logFilePath, { encoding: 'utf8' });
        let lastPlayerId: string | null = null;

        stream.on('data', (chunk: string | Buffer) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.includes("VOTC:PLAYER_ID")) {
                    const parts = line.split('/');
                    if (parts.length > 2) {
                        lastPlayerId = parts[2].trim();
                    }
                }
            }
        });

        stream.on('end', () => {
            resolve({ playerId: lastPlayerId });
        });

        stream.on('error', (err) => {
            reject(err);
        });
    });
}

export async function getAllDiaryPlayerIds(userDataPath: string): Promise<{ id: string, name: string }[]> {
    const diariesRootPath = path.join(userDataPath, 'diary_summaries');
    if (!fs.existsSync(diariesRootPath)) {
        return [];
    }
    const playerDirs = fs.readdirSync(diariesRootPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => {
            const playerId = dirent.name;
            const mapPath = path.join(userDataPath, 'conversation_summaries', playerId, '_character_map.json');
            let playerName = `Player ${playerId}`;
            if (fs.existsSync(mapPath)) {
                try {
                    const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                    if (mapData[playerId]) {
                        playerName = mapData[playerId];
                    }
                } catch (e) {
                    console.error(`Error reading character map for player ${playerId}:`, e);
                }
            }
            return { id: playerId, name: playerName };
        });
    return playerDirs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDiaryFiles(playerId: string): Promise<string[]> {
    const playerDir = getPlayerDiaryDir(playerId);
    if (!fs.existsSync(playerDir)) {
        return [];
    }
    return fs.readdirSync(playerDir).filter(file => file.endsWith('.json') && file !== '_character_map.json');
}

/** Reads the raw diary_entries array without any visibility filtering. */
function readDiaryEntriesRaw(playerId: string, characterId: string): DiaryEntry[] {
    const filePath = getDiaryFilePath(playerId, characterId);
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data)) {
            return data;
        }
        return data.diary_entries || [];
    } catch (error) {
        console.error(`Error reading diary file for player ${playerId}, character ${characterId}:`, error);
        return [];
    }
}

function sortDiaryEntriesDesc(entries: DiaryEntry[]): DiaryEntry[] {
    return entries.sort((a: { date: string; }, b: { date: string; }) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function readDiaryFile(playerId: string, characterId: string, visibility?: DiaryVisibilityContext): Promise<{ diary_entries: DiaryEntry[] }> {
    const filePath = getDiaryFilePath(playerId, characterId);
    if (!fs.existsSync(filePath)) {
        return { diary_entries: [] };
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        // Handle both array and object formats
        let entries: DiaryEntry[] = Array.isArray(data) ? data : data.diary_entries || [];
        if (visibility) {
            entries = entries.filter(e => isDiaryRecordVisible(e, visibility));
        }
        return { diary_entries: sortDiaryEntriesDesc(entries) };
    } catch (error) {
        console.error(`Error reading diary file for player ${playerId}, character ${characterId}:`, error);
        return { diary_entries: [] };
    }
}

export async function saveDiaryFile(playerId: string, characterId: string, diaryData: any, visibility?: DiaryVisibilityContext): Promise<void> {
    const diaryPath = path.join(app.getPath('userData'), 'votc_data', 'diary_history', playerId);
    if (!fs.existsSync(diaryPath)) {
        fs.mkdirSync(diaryPath, { recursive: true });
    }
    const filePath = path.join(diaryPath, `${characterId}.json`);

    // Case 1: diaryData is a complete file structure from the manager UI.
    // Merge semantics: the UI only saw the entries visible in the current
    // timeline context, so preserve any existing entry that is hidden
    // (future checkpoint / other branch) instead of silently dropping it.
    if (diaryData && diaryData.diary_entries && Array.isArray(diaryData.diary_entries)) {
        let entriesToWrite = diaryData.diary_entries;
        if (visibility) {
            const existingEntries = readDiaryEntriesRaw(playerId, characterId);
            const incomingIds = new Set(diaryData.diary_entries.map((e: any) => e?.id));
            const preserved = existingEntries.filter(e => e && !incomingIds.has(e.id) && !isDiaryRecordVisible(e, visibility));
            if (preserved.length > 0) {
                entriesToWrite = sortDiaryEntriesDesc([...diaryData.diary_entries, ...preserved]);
                console.log(`Preserved ${preserved.length} hidden diary entries for character ${characterId} on save.`);
            }
        }
        await fs.promises.writeFile(filePath, JSON.stringify({ ...diaryData, diary_entries: entriesToWrite }, null, '\t'));
        return;
    }

    // Case 2: diaryData is a single new entry from the conversation flow. Read, prepend, and write.
    let diaryFileContent: { diary_entries: any[] } = { diary_entries: [] };
    if (fs.existsSync(filePath)) {
        try {
            const fileContent = await fs.promises.readFile(filePath, 'utf-8');
            if (fileContent) {
                const parsedContent = JSON.parse(fileContent);
                if (parsedContent && Array.isArray(parsedContent.diary_entries)) {
                    diaryFileContent = parsedContent;
                } else if (parsedContent && typeof parsedContent === 'object' && !Array.isArray(parsedContent)) {
                    // Handle migration of old single-object format
                    diaryFileContent.diary_entries.push(parsedContent);
                }
            }
        } catch (e) {
            console.error(`Error reading or parsing diary file ${filePath}, it will be overwritten.`, e);
        }
    }

    // Add the new single entry to the beginning of the array
    diaryFileContent.diary_entries.unshift(diaryData);
    diaryFileContent.diary_entries.sort((a: { date: string; }, b: { date: string; }) => new Date(b.date).getTime() - new Date(a.date).getTime());

    await fs.promises.writeFile(filePath, JSON.stringify(diaryFileContent, null, '\t'));
}

function getDiaryArchiveRecordKey(record: any): string {
    if (record?.id) {
        return String(record.id);
    }
    return [
        record?.date ?? '',
        record?.diaryEntryId ?? '',
        String(record?.content ?? record?.summary ?? '').slice(0, 128)
    ].join('\u001f');
}

/**
 * Diary variant of conversationHistory.archiveFutureRecordsInFile. Moves
 * diary entries/summaries that are ahead of `checkpointEpoch` into
 * player-scoped archive dirs (diary storage stays player-scoped per P6;
 * nothing is deleted). Records anchored to a timeline node always stay in
 * the live files — branch visibility is decided by the graph, not by epoch.
 * The archive write happens before the source rewrite so a crash between the
 * two can never lose a record (the leftover copy is re-archived idempotently;
 * dedup is keyed on the stable record id).
 *
 * Synchronous to match the archiveFutureSummaryFilesForPlayer call style in
 * the conversation open/close chain.
 */
export function archiveFutureDiaryRecordsForPlayer(playerId: string, checkpointEpoch: number, reason: string = 'older_save_checkpoint'): number {
    let archivedCount = 0;
    const archivedAt = new Date().toISOString();

    // Diary entries: object envelope { diary_entries: [...] } (or legacy array).
    const playerDiaryDir = getPlayerDiaryDir(playerId);
    if (fs.existsSync(playerDiaryDir)) {
        for (const fileName of fs.readdirSync(playerDiaryDir).filter(f => f.endsWith('.json') && f !== '_character_map.json')) {
            const sourcePath = path.join(playerDiaryDir, fileName);
            try {
                const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
                const entries: any[] = Array.isArray(data) ? data : (Array.isArray(data?.diary_entries) ? data.diary_entries : []);
                const { visible, future } = archiveFutureRecords(entries, checkpointEpoch);
                if (future.length === 0) {
                    continue;
                }

                const archivePath = path.join(diariesArchivedDir, playerId, fileName);
                fs.mkdirSync(path.dirname(archivePath), { recursive: true });
                let archivedEntries: any[] = [];
                if (fs.existsSync(archivePath)) {
                    try {
                        const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
                        archivedEntries = Array.isArray(archiveData) ? archiveData : (Array.isArray(archiveData?.diary_entries) ? archiveData.diary_entries : []);
                    } catch (e) {
                        console.error(`Failed to read diary archive ${archivePath}, it will be rebuilt:`, e);
                    }
                }
                const seenKeys = new Set(archivedEntries.map(getDiaryArchiveRecordKey));
                const newArchived = future
                    .map(record => ({
                        ...record,
                        archivedAt,
                        archiveReason: reason,
                        archivedFromCheckpointEpoch: checkpointEpoch,
                        archivedSourceFile: fileName
                    }))
                    .filter(record => {
                        const key = getDiaryArchiveRecordKey(record);
                        if (seenKeys.has(key)) {
                            return false;
                        }
                        seenKeys.add(key);
                        return true;
                    });
                fs.writeFileSync(archivePath, JSON.stringify({ diary_entries: [...newArchived, ...archivedEntries] }, null, '\t'));

                fs.writeFileSync(sourcePath, JSON.stringify({ diary_entries: visible }, null, '\t'));
                archivedCount += future.length;
                console.log(`Archived ${future.length} future diary entries from ${sourcePath} for checkpoint ${checkpointEpoch}.`);
            } catch (error) {
                console.error(`Failed to archive future diary entries ${sourcePath}:`, error);
            }
        }
    }

    // Diary summaries: array files (or legacy single object).
    const playerSummaryDir = path.join(diarySummariesDir, playerId);
    if (fs.existsSync(playerSummaryDir)) {
        for (const fileName of fs.readdirSync(playerSummaryDir).filter(f => f.endsWith('.json') && f !== '_character_map.json')) {
            const sourcePath = path.join(playerSummaryDir, fileName);
            try {
                const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
                const summaries: any[] = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
                const { visible, future } = archiveFutureRecords(summaries, checkpointEpoch);
                if (future.length === 0) {
                    continue;
                }

                const archivePath = path.join(diarySummariesArchivedDir, playerId, fileName);
                fs.mkdirSync(path.dirname(archivePath), { recursive: true });
                let archivedSummaries: any[] = [];
                if (fs.existsSync(archivePath)) {
                    try {
                        const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
                        archivedSummaries = Array.isArray(archiveData) ? archiveData : [];
                    } catch (e) {
                        console.error(`Failed to read diary summary archive ${archivePath}, it will be rebuilt:`, e);
                    }
                }
                const seenKeys = new Set(archivedSummaries.map(getDiaryArchiveRecordKey));
                const newArchived = future
                    .map(record => ({
                        ...record,
                        archivedAt,
                        archiveReason: reason,
                        archivedFromCheckpointEpoch: checkpointEpoch,
                        archivedSourceFile: fileName
                    }))
                    .filter(record => {
                        const key = getDiaryArchiveRecordKey(record);
                        if (seenKeys.has(key)) {
                            return false;
                        }
                        seenKeys.add(key);
                        return true;
                    });
                fs.writeFileSync(archivePath, JSON.stringify([...newArchived, ...archivedSummaries], null, '\t'));

                fs.writeFileSync(sourcePath, JSON.stringify(visible, null, '\t'));
                archivedCount += future.length;
                console.log(`Archived ${future.length} future diary summaries from ${sourcePath} for checkpoint ${checkpointEpoch}.`);
            } catch (error) {
                console.error(`Failed to archive future diary summaries ${sourcePath}:`, error);
            }
        }
    }

    return archivedCount;
}

export async function getCharacterMap(playerId: string): Promise<{ [key: string]: string }> {
    const userDataPath = app.getPath('userData');
    const mapPath = path.join(userDataPath, 'votc_data', 'diary_history', playerId, '_character_map.json');
    if (fs.existsSync(mapPath)) {
        try {
            return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        } catch (e) {
            console.error(`Error reading character map for player ${playerId}:`, e);
        }
    }
    return {};
}

export async function getAllDiarySummaries(playerId: string, visibility?: DiaryVisibilityContext): Promise<(DiarySummary & { characterName: string })[]> {
    const summaryDir = path.join(diarySummariesDir, playerId);
    if (!fs.existsSync(summaryDir)) {
        return [];
    }

    const characterMap = await getCharacterMap(playerId);
    const summaryFiles = fs.readdirSync(summaryDir).filter(file => file.endsWith('.json') && file !== '_character_map.json');
    const allSummaries: (DiarySummary & { characterName: string })[] = [];

    for (const file of summaryFiles) {
        const characterId = path.basename(file, '.json');
        try {
            const summaries = await readDiarySummaries(playerId, characterId, visibility);
            const characterName = characterMap[characterId] || `Character ${characterId}`;
            summaries.forEach(summary => {
                allSummaries.push({
                    ...summary,
                    characterName: characterName
                });
            });
        } catch (error) {
            console.error(`Error reading diary summary file for character ${characterId}:`, error);
        }
    }
    allSummaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return allSummaries;
}
