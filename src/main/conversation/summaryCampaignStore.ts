import fs from 'fs';
import path from 'path';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';
import {
    conversationSummariesDir as campaignConversationSummariesDir,
    conversationSummariesMigrationMarkerPath
} from '../campaignDataPaths.js';
import { isLetterRecordVisible, type LetterVisibilityContext } from '../letter/letterVisibility.js';
import { updateJsonArrayAtomic, writeJsonAtomic } from '../history/historyAtomicJson.js';
import type { TimelineRegistry } from '../timelineManager.js';
import type { Summary } from '../ts/conversation_interfaces.js';

/**
 * F24 single routing exit for the conversation-summary store ("会话摘要自身
 * campaign 化"). Every read/write/watch/migrate of
 * `conversation_summaries` goes through this module:
 *
 *   identity present  ->  <userData>/votc_data/campaigns/<cid>/players/<pid>/conversation_summaries/<charId>.json
 *   identity absent   ->  <votcDataRoot>/conversation_summaries/<pid>/<charId>.json   (degraded, pre-F24 layout)
 *
 * Reads UNION the campaign store with the legacy flat player store (campaign
 * copy authoritative on dedupe) and filter by timeline visibility: records
 * anchored to a node go through graph visibility, epoch-only legacy records
 * fall back to `epoch <= checkpointEpoch`. Writes are symmetric: campaign
 * writes are stamped with the full lineage (campaignId/nodeId/parentId/epoch)
 * and NEVER touch the flat layout (the cross-campaign leak F24 closes);
 * degraded writes keep the exact pre-F24 flat behavior.
 */

export interface SummaryStoreRouting {
    /** Legacy flat root: `<userData>/votc_data` (Conversation's userDataPath). */
    votcDataRoot: string;
    /** Campaign namespace root: `app.getPath('userData')`. */
    userDataDir: string;
    playerId: string;
    characterId: string;
}

/** Timeline visibility context for summary reads (letterVisibility semantics). */
export interface SummaryStoreContext {
    identity?: CampaignPlayerIdentity;
    checkpointEpoch?: number;
    registry?: TimelineRegistry;
    currentNodeId?: string;
}

export interface EffectiveSummaryTarget {
    filePath: string;
    scope: 'campaign' | 'legacy';
}

// ---------------------------------------------------------------------------
// Path exit
// ---------------------------------------------------------------------------

export function legacySummaryDirFor(votcDataRoot: string, playerId: string): string {
    return path.join(votcDataRoot, 'conversation_summaries', playerId);
}

export function legacySummaryFilePath(votcDataRoot: string, playerId: string, characterId: string): string {
    return path.join(legacySummaryDirFor(votcDataRoot, playerId), `${characterId}.json`);
}

export function campaignSummaryFilePath(userDataDir: string, identity: CampaignPlayerIdentity, characterId: string): string {
    return path.join(campaignConversationSummariesDir(userDataDir, identity), `${characterId}.json`);
}

/**
 * The file new writes land in and the file watcher attaches to: campaign
 * store when an identity is available, legacy flat store otherwise.
 */
export function effectiveSummaryTarget(routing: SummaryStoreRouting, identity?: CampaignPlayerIdentity): EffectiveSummaryTarget {
    if (identity) {
        return { filePath: campaignSummaryFilePath(routing.userDataDir, identity, routing.characterId), scope: 'campaign' };
    }
    return { filePath: legacySummaryFilePath(routing.votcDataRoot, routing.playerId, routing.characterId), scope: 'legacy' };
}

/**
 * Ensures the store directories a session needs. The legacy flat dirs are
 * always ensured (archive helpers and degraded sessions rely on them); the
 * campaign store dir is ensured only when an identity is captured.
 */
export function ensureSummaryStoreDirs(routing: Pick<SummaryStoreRouting, 'votcDataRoot' | 'userDataDir' | 'playerId'>, identity?: CampaignPlayerIdentity): void {
    const legacyBase = path.join(routing.votcDataRoot, 'conversation_summaries');
    if (!fs.existsSync(legacyBase)) {
        fs.mkdirSync(legacyBase, { recursive: true });
        console.log('Created conversation_summaries directory.');
    }
    const legacyPlayerDir = legacySummaryDirFor(routing.votcDataRoot, routing.playerId);
    if (!fs.existsSync(legacyPlayerDir)) {
        fs.mkdirSync(legacyPlayerDir, { recursive: true });
        console.log(`Created player-specific summary directory for player ID: ${routing.playerId}`);
    }
    if (identity) {
        const campaignDir = campaignConversationSummariesDir(routing.userDataDir, identity);
        if (!fs.existsSync(campaignDir)) {
            fs.mkdirSync(campaignDir, { recursive: true });
            console.log(`Created campaign summary directory for campaign ${identity.campaignId}.`);
        }
    }
}

// ---------------------------------------------------------------------------
// Dedup + visibility
// ---------------------------------------------------------------------------

/**
 * Stable record identity for union dedupe: records with an `id` (letter
 * summaries carry one) dedupe by id; legacy close summaries fall back to
 * (node, epoch, date, content) so identical records in both stores collapse
 * and the campaign copy wins.
 */
export function summaryRecordDedupKey(summary: any): string {
    if (typeof summary?.id === 'string' && summary.id !== '') {
        return `id:${summary.id}`;
    }
    return [
        summary?.votcTimelineNodeId ?? '',
        summary?.votcCheckpointEpoch ?? '',
        summary?.date ?? '',
        summary?.content ?? ''
    ].join('\u001f');
}

function readSummaryArrayFile(filePath: string): Summary[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(parsed)) {
            console.warn(`[summaryCampaignStore] ${filePath} is not an array; ignoring.`);
            return [];
        }
        return parsed as Summary[];
    } catch (error) {
        // Fail-closed per file: a corrupt store is skipped, never replaced.
        console.error(`[summaryCampaignStore] Failed to parse ${filePath}; skipping:`, error);
        return [];
    }
}

export function sortSummariesByDateDesc(summaries: Summary[]): void {
    summaries.sort((a, b) => {
        const timeA = a?.date ? new Date(a.date).getTime() : 0;
        const timeB = b?.date ? new Date(b.date).getTime() : 0;
        return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
    });
}

/**
 * F24 read assembly for one character:
 *   1. union of campaign store (when identity) + legacy flat store,
 *      deduped with the campaign copy authoritative;
 *   2. visibility filter — anchored records via graph visibility
 *      (fail-closed without a registry), legacy epoch-only records via
 *      `epoch <= checkpointEpoch`;
 *   3. sorted by date, newest first (Conversation display order).
 *
 * Without an identity this is exactly the pre-F24 flat read plus the epoch
 * filter (degradation keeps the flat feature intact).
 */
export function readCharacterSummariesUnion(routing: SummaryStoreRouting, context: SummaryStoreContext): Summary[] {
    const legacyRecords = readSummaryArrayFile(legacySummaryFilePath(routing.votcDataRoot, routing.playerId, routing.characterId));
    const campaignRecords = context.identity
        ? readSummaryArrayFile(campaignSummaryFilePath(routing.userDataDir, context.identity, routing.characterId))
        : [];

    const merged: Summary[] = [];
    const seen = new Set<string>();
    for (const record of [...campaignRecords, ...legacyRecords]) {
        const key = summaryRecordDedupKey(record);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        merged.push(record);
    }

    const visibilityContext: LetterVisibilityContext = {
        identity: context.identity,
        checkpointEpoch: context.checkpointEpoch,
        registry: context.registry,
        currentNodeId: context.currentNodeId
    };
    const visible = merged.filter(record => isLetterRecordVisible(record, visibilityContext));
    sortSummariesByDateDesc(visible);
    return visible;
}

// ---------------------------------------------------------------------------
// Character map (id -> display name)
// ---------------------------------------------------------------------------

/**
 * Reads the character map from both scopes: campaign map first (authoritative
 * when an identity is active), legacy flat map as fallback/merge source.
 */
export function readSummaryCharacterMapObject(
    routing: Pick<SummaryStoreRouting, 'votcDataRoot' | 'userDataDir' | 'playerId'>,
    identity?: CampaignPlayerIdentity
): { [key: string]: string } {
    const merged: { [key: string]: string } = {};
    // Legacy first, then campaign, so the campaign map wins per key.
    const candidates: string[] = [
        path.join(legacySummaryDirFor(routing.votcDataRoot, routing.playerId), '_character_map.json')
    ];
    if (identity) {
        candidates.push(path.join(campaignConversationSummariesDir(routing.userDataDir, identity), '_character_map.json'));
    }
    for (const mapPath of candidates) {
        if (!fs.existsSync(mapPath)) {
            continue;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                Object.assign(merged, parsed);
            }
        } catch (error) {
            console.error(`[summaryCampaignStore] Error reading character map ${mapPath}:`, error);
        }
    }
    return merged;
}

/**
 * Writes the character map routed by identity: the campaign map is the
 * authoritative copy; the legacy flat map is ALSO kept in sync because
 * legacy readers that are outside F24 scope (diary player listing) still
 * resolve player display names from the flat store. This is a pure
 * id->name mapping, not summary content, so mirroring it does not
 * reintroduce the cross-campaign summary leak F24 closes.
 */
export function writeSummaryCharacterMap(
    routing: Pick<SummaryStoreRouting, 'votcDataRoot' | 'userDataDir' | 'playerId'>,
    identity: CampaignPlayerIdentity | undefined,
    characterMap: object
): void {
    const targets: string[] = [path.join(legacySummaryDirFor(routing.votcDataRoot, routing.playerId), '_character_map.json')];
    if (identity) {
        targets.unshift(path.join(campaignConversationSummariesDir(routing.userDataDir, identity), '_character_map.json'));
    }
    for (const mapPath of targets) {
        fs.mkdirSync(path.dirname(mapPath), { recursive: true });
        fs.writeFileSync(mapPath, JSON.stringify(characterMap, null, '\t'));
    }
}

// ---------------------------------------------------------------------------
// Write exit
// ---------------------------------------------------------------------------

/** Lineage stamps applied to campaign-scope records that lack them. */
export interface SummaryWriteStamp {
    checkpointEpoch?: number;
    timelineNodeId?: string;
    timelineParentId?: string;
    campaignId?: string;
}

function applyStamp(summary: Summary, stamp: SummaryWriteStamp | undefined): Summary {
    if (!stamp) {
        return summary;
    }
    return {
        ...summary,
        ...(summary.votcCheckpointEpoch === undefined && stamp.checkpointEpoch !== undefined
            ? { votcCheckpointEpoch: stamp.checkpointEpoch }
            : {}),
        ...(!summary.votcTimelineNodeId && stamp.timelineNodeId ? { votcTimelineNodeId: stamp.timelineNodeId } : {}),
        ...(!summary.votcTimelineParentId && stamp.timelineParentId ? { votcTimelineParentId: stamp.timelineParentId } : {}),
        ...(!summary.votcCampaignId && stamp.campaignId ? { votcCampaignId: stamp.campaignId } : {})
    };
}

export interface WriteCharacterSummariesOptions {
    /**
     * Legacy-scope content: whole-replace payload for the flat file
     * (exact pre-F24 semantics — the caller passes its full visible list).
     * IGNORED when an identity is present.
     */
    legacyReplacement: Summary[];
    /**
     * Campaign-scope content: NEW records merged over the on-disk campaign
     * array; on-disk records not present in this list (hidden sibling
     * branches, other epochs) are preserved. IGNORED without an identity.
     */
    campaignMerge?: Summary[];
    stamp?: SummaryWriteStamp;
}

/**
 * F24 write exit, symmetric to `readCharacterSummariesUnion`:
 *   - identity present: stamped merge-write into the CAMPAIGN store only.
 *     The flat layout is never touched (this is the cross-campaign leak
 *     F24 closes); hidden sibling-branch records on disk survive the merge.
 *   - identity absent: whole-overwrite of the legacy flat file, byte-for-byte
 *     the pre-F24 behavior (tab-indented JSON, caller-provided list).
 */
export async function writeCharacterSummaries(
    routing: SummaryStoreRouting,
    identity: CampaignPlayerIdentity | undefined,
    options: WriteCharacterSummariesOptions
): Promise<EffectiveSummaryTarget> {
    const target = effectiveSummaryTarget(routing, identity);
    fs.mkdirSync(path.dirname(target.filePath), { recursive: true });

    if (target.scope === 'campaign') {
        const stamped = (options.campaignMerge ?? []).map(record => applyStamp(record, options.stamp));
        try {
            await updateJsonArrayAtomic<Summary>(
                target.filePath,
                (value) => {
                    if (!Array.isArray(value)) {
                        throw new Error('existing campaign summary file is not an array');
                    }
                    return value as Summary[];
                },
                (existing) => {
                    // Incoming records win on key collision; everything else
                    // on disk (other branches/epochs) is preserved.
                    const incomingKeys = new Set(stamped.map(summaryRecordDedupKey));
                    return [...stamped, ...existing.filter(record => !incomingKeys.has(summaryRecordDedupKey(record)))];
                }
            );
        } catch (error) {
            console.error(`[summaryCampaignStore] Failed to write campaign summaries ${target.filePath}:`, error);
            throw error;
        }
    } else {
        fs.writeFileSync(target.filePath, JSON.stringify(options.legacyReplacement, null, '\t'));
    }
    return target;
}

// ---------------------------------------------------------------------------
// Flat -> campaign one-shot migration (letterStoreMigration pattern)
// ---------------------------------------------------------------------------

export type ConversationSummariesMigrationStatus =
    | 'migrated'
    | 'already-migrated'
    | 'no-flat-data'
    | 'ambiguous'
    | 'partial';

export interface ConversationSummariesMigrationResult {
    status: ConversationSummariesMigrationStatus;
    migratedFiles: number;
    /** Corrupt flat files left in place (fail-closed). */
    skippedCorruptFiles: number;
}

interface ConversationSummariesMigrationMarker {
    version: 1;
    campaignId: string;
    playerId: string;
    completedAt: string;
    migratedFiles: number;
}

/**
 * Per-process gate so the migration scan runs at most once per
 * campaign|player per process (the on-disk marker covers later processes).
 * Mirrors LetterManager.ensureCampaignStoreMigrated.
 */
const migrationCompletedKeys = new Set<string>();
const migrationsInFlight = new Map<string, Promise<ConversationSummariesMigrationResult | undefined>>();

/** Test helper: clears the per-process migration gate. */
export function resetConversationSummariesMigrationCacheForTests(): void {
    migrationCompletedKeys.clear();
    migrationsInFlight.clear();
}

function listStoreJsonFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }
    return fs.readdirSync(dirPath).filter(file => file.endsWith('.json') && file !== '_character_map.json');
}

function campaignsRootOf(userDataDir: string): string {
    return path.join(userDataDir, 'votc_data', 'campaigns');
}

/**
 * True when a campaign OTHER than `identity.campaignId` already owns a
 * conversation_summaries store with content for this player. The flat store
 * then cannot be attributed to a single campaign and stays where it is,
 * still readable as the legacy fallback of every campaign read.
 */
function hasOtherCampaignSummaryStore(userDataDir: string, identity: CampaignPlayerIdentity): boolean {
    const campaignsRoot = campaignsRootOf(userDataDir);
    if (!fs.existsSync(campaignsRoot)) {
        return false;
    }
    for (const campaignId of fs.readdirSync(campaignsRoot)) {
        if (campaignId === identity.campaignId) {
            continue;
        }
        const otherStoreDir = path.join(campaignsRoot, campaignId, 'players', identity.playerId, 'conversation_summaries');
        if (listStoreJsonFiles(otherStoreDir).length > 0) {
            return true;
        }
    }
    return false;
}

/** Backup copy in the shared legacy_backups area (campaignMigration style). */
function backupFlatFile(sourcePath: string, backupRoot: string, storeName: string, playerId: string): string {
    const backupPath = path.join(backupRoot, storeName, playerId, path.basename(sourcePath));
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(sourcePath, backupPath);
    return backupPath;
}

async function writeMigrationMarker(
    markerPath: string,
    identity: CampaignPlayerIdentity,
    migratedFiles: number
): Promise<void> {
    const marker: ConversationSummariesMigrationMarker = {
        version: 1,
        campaignId: identity.campaignId,
        playerId: identity.playerId,
        completedAt: new Date().toISOString(),
        migratedFiles
    };
    await writeJsonAtomic(markerPath, marker);
}

/**
 * Runs the one-shot flat conversation_summaries migration for `identity`.
 * Properties (mirroring letterStoreMigration):
 *   - idempotent via a marker OUTSIDE the store dir (a marker inside would
 *     be listed and parsed as a summary array by every reader);
 *   - per-file dedupe on `summaryRecordDedupKey` makes re-runs no-ops;
 *   - fail-closed: corrupt/non-array flat files are never deleted and block
 *     the completion marker so a repaired file migrates on a later run;
 *   - ambiguous ownership (another campaign already holds a store for this
 *     player) leaves the flat data in place as the legacy fallback;
 *   - backups go to `votc_data/legacy_backups/<stamp>/conversation_summaries/`
 *     — the store name distinguishes them from the letter migration's
 *     `letter_history` / `letter_summaries` subdirectories, so the two
 *     migrations never overwrite each other.
 */
export async function migrateFlatConversationSummaries(
    userDataDir: string,
    identity: CampaignPlayerIdentity
): Promise<ConversationSummariesMigrationResult> {
    const markerPath = conversationSummariesMigrationMarkerPath(userDataDir, identity);
    if (fs.existsSync(markerPath)) {
        return { status: 'already-migrated', migratedFiles: 0, skippedCorruptFiles: 0 };
    }

    const legacyDir = legacySummaryDirFor(path.join(userDataDir, 'votc_data'), identity.playerId);
    const files = listStoreJsonFiles(legacyDir);
    if (files.length === 0) {
        await writeMigrationMarker(markerPath, identity, 0);
        return { status: 'no-flat-data', migratedFiles: 0, skippedCorruptFiles: 0 };
    }

    if (hasOtherCampaignSummaryStore(userDataDir, identity)) {
        console.info(
            `[summaryCampaignStore] Player ${identity.playerId} has conversation summaries in more than one campaign; ` +
            'the flat conversation_summaries store cannot be attributed to a single campaign ' +
            'and stays in its legacy location (still readable as the legacy fallback).'
        );
        return { status: 'ambiguous', migratedFiles: 0, skippedCorruptFiles: 0 };
    }

    const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(userDataDir, 'votc_data', 'legacy_backups', backupStamp);

    let migrated = 0;
    let corrupt = 0;

    for (const fileName of files) {
        const sourcePath = path.join(legacyDir, fileName);
        let records: unknown[];
        try {
            const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            if (!Array.isArray(parsed)) {
                console.warn(`[summaryCampaignStore] ${sourcePath} is not an array; leaving it in place.`);
                corrupt += 1;
                continue;
            }
            records = parsed;
        } catch (error) {
            // Fail-closed: a corrupt flat file is never deleted and blocks the
            // completion marker so a later run can retry it.
            console.warn(`[summaryCampaignStore] Failed to parse ${sourcePath}; leaving it in place:`, error);
            corrupt += 1;
            continue;
        }

        const targetPath = campaignSummaryFilePath(userDataDir, identity, path.basename(fileName, '.json'));
        try {
            await updateJsonArrayAtomic<unknown>(
                targetPath,
                (value) => {
                    if (!Array.isArray(value)) {
                        throw new Error('existing campaign summary file is not an array');
                    }
                    return value;
                },
                (existing) => {
                    const seen = new Set(existing.map(summaryRecordDedupKey));
                    return [...existing, ...records.filter(record => !seen.has(summaryRecordDedupKey(record)))];
                }
            );
        } catch (error) {
            console.error(`[summaryCampaignStore] Failed to commit ${targetPath}; keeping ${sourcePath} in place:`, error);
            corrupt += 1;
            continue;
        }

        // Campaign copy is committed: back up, then remove the flat file.
        try {
            backupFlatFile(sourcePath, backupRoot, 'conversation_summaries', identity.playerId);
            fs.unlinkSync(sourcePath);
            migrated += 1;
            console.log(`[summaryCampaignStore] Migrated ${sourcePath} -> ${targetPath}`);
        } catch (error) {
            // The data is safe in both places; report but keep going.
            console.error(`[summaryCampaignStore] Backup/unlink failed for ${sourcePath}:`, error);
            corrupt += 1;
        }
    }

    if (corrupt > 0) {
        return { status: 'partial', migratedFiles: migrated, skippedCorruptFiles: corrupt };
    }

    await writeMigrationMarker(markerPath, identity, migrated);
    return { status: 'migrated', migratedFiles: migrated, skippedCorruptFiles: 0 };
}

/**
 * Fire-and-forget entry point used by session open: at most one migration
 * scan per campaign|player per process; a failure only means the flat store
 * stays in place and keeps serving reads through the legacy fallback.
 */
export function ensureFlatConversationSummariesMigrated(
    userDataDir: string,
    identity: CampaignPlayerIdentity
): Promise<ConversationSummariesMigrationResult | undefined> {
    const key = `${identity.campaignId}|${identity.playerId}`;
    if (migrationCompletedKeys.has(key)) {
        return Promise.resolve(undefined);
    }
    const inFlight = migrationsInFlight.get(key);
    if (inFlight) {
        return inFlight;
    }
    const migration = migrateFlatConversationSummaries(userDataDir, identity)
        .then(result => {
            migrationCompletedKeys.add(key);
            return result;
        })
        .catch(error => {
            // Fail-closed: leave the flat store untouched and keep the legacy
            // fallback alive; mark the key so later opens do not re-churn.
            console.error('[summaryCampaignStore] Flat conversation_summaries migration failed; keeping legacy fallback:', error);
            migrationCompletedKeys.add(key);
            return undefined;
        });
    migrationsInFlight.set(key, migration);
    return migration;
}

// ---------------------------------------------------------------------------
// Clear-scope exit
// ---------------------------------------------------------------------------

/**
 * "Clear summaries" scoped by identity:
 *   - identity present: clear the campaign store of the ACTIVE identity AND
 *     the legacy flat dir of the SAME player. Semantics: the campaign store
 *     is the primary scope, but leftover flat records (pre-migration data or
 *     degraded-session writes) must not resurrect old summaries on the next
 *     union read. Other players' flat dirs are left untouched.
 *   - identity absent: pre-F24 behavior — wipe the whole legacy flat store
 *     (all players).
 */
export function clearSummariesForScope(
    votcDataRoot: string,
    userDataDir: string,
    playerId: string | undefined,
    identity: CampaignPlayerIdentity | undefined
): void {
    if (identity && playerId) {
        const targets = [
            campaignConversationSummariesDir(userDataDir, identity),
            legacySummaryDirFor(votcDataRoot, playerId)
        ];
        for (const target of targets) {
            if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
                console.log(`[summaryCampaignStore] Cleared summary store: ${target}`);
            }
        }
        return;
    }
    const legacyBase = path.join(votcDataRoot, 'conversation_summaries');
    if (fs.existsSync(legacyBase)) {
        fs.rmSync(legacyBase, { recursive: true, force: true });
        console.log(`[summaryCampaignStore] Cleared legacy summary store: ${legacyBase}`);
    }
}
