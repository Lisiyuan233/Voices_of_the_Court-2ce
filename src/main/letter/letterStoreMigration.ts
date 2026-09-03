import fs from 'fs';
import path from 'path';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';
import {
    letterStoreMigrationMarkerPath,
    letterSummaryPath,
    letterThreadPath
} from '../campaignDataPaths.js';
import { updateJsonArrayAtomic, writeJsonAtomic } from '../history/historyAtomicJson.js';

/**
 * F21 one-shot migration of the legacy flat letter chat-store into the
 * campaign namespace. Sources:
 *   <userData>/votc_data/letter_history/<playerId>/<characterId>.json
 *   <userData>/votc_data/letter_summaries/<playerId>/<characterId>.json
 * Targets:
 *   <userData>/votc_data/campaigns/<cid>/players/<pid>/letters/threads/<characterId>.json
 *   <userData>/votc_data/campaigns/<cid>/players/<pid>/letters/summaries/<characterId>.json
 *
 * Properties (mirrors campaignMigration.ts / pre_migration_backup style):
 *   - Atomic: campaign writes go through updateJsonArrayAtomic /
 *     writeJsonAtomic (tmp + rename + swap manifest).
 *   - Idempotent: a marker file (letters/migration.json) short-circuits
 *     re-runs; per-file dedup on stable record keys makes a re-run a no-op
 *     even without the marker.
 *   - Fail-closed: a flat file that cannot be parsed is left untouched and
 *     aborts marker completion so a later run can retry it. Campaign-side
 *     failures keep the flat file in place (data is never deleted before the
 *     campaign copy is committed).
 *   - Ownership check: the flat store is only claimed when no OTHER campaign
 *     already holds a letters store for the same player; otherwise ownership
 *     is ambiguous and the flat data stays where it is, still readable as the
 *     legacy fallback of every campaign read.
 *   - A timestamped backup copy is written under
 *     votc_data/legacy_backups/<stamp>/ before the flat file is removed.
 *
 * Deliberately NOT a moving window: once the marker exists, later flat writes
 * from degraded (identity-less) sessions stay in the legacy location and are
 * read through the legacy fallback instead of being re-migrated, so records
 * never bounce between the two stores.
 */

export type LetterStoreMigrationStatus =
    | 'migrated'
    | 'already-migrated'
    | 'no-flat-data'
    | 'ambiguous'
    | 'partial';

export interface LetterStoreMigrationResult {
    status: LetterStoreMigrationStatus;
    migratedThreadFiles: number;
    migratedSummaryFiles: number;
    /** Corrupt flat files left in place (fail-closed). */
    skippedCorruptFiles: number;
}

interface LetterStoreMigrationMarker {
    version: 1;
    campaignId: string;
    playerId: string;
    completedAt: string;
    migratedThreadFiles: number;
    migratedSummaryFiles: number;
}

function legacyLetterHistoryPlayerDir(userDataDir: string, playerId: string): string {
    return path.join(userDataDir, 'votc_data', 'letter_history', playerId);
}

function legacyLetterSummariesPlayerDir(userDataDir: string, playerId: string): string {
    return path.join(userDataDir, 'votc_data', 'letter_summaries', playerId);
}

function campaignLettersRoot(userDataDir: string): string {
    return path.join(userDataDir, 'votc_data', 'campaigns');
}

/**
 * True when a campaign OTHER than `identity.campaignId` already owns a
 * letters store for this player. In that case the flat store cannot be
 * attributed to a single campaign and is left in place.
 */
function hasOtherCampaignLetterStore(userDataDir: string, identity: CampaignPlayerIdentity): boolean {
    const campaignsRoot = campaignLettersRoot(userDataDir);
    if (!fs.existsSync(campaignsRoot)) {
        return false;
    }
    for (const campaignId of fs.readdirSync(campaignsRoot)) {
        if (campaignId === identity.campaignId) {
            continue;
        }
        const otherLettersDir = path.join(campaignsRoot, campaignId, 'players', identity.playerId, 'letters');
        if (!fs.existsSync(otherLettersDir)) {
            continue;
        }
        const hasContent = fs.readdirSync(otherLettersDir, { withFileTypes: true }).some(dirent => {
            if (!dirent.isDirectory()) return false;
            const sub = path.join(otherLettersDir, dirent.name);
            return fs.readdirSync(sub).some(file => file.endsWith('.json'));
        });
        if (hasContent) {
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

function listJsonFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }
    return fs.readdirSync(dirPath).filter(file =>
        file.endsWith('.json') && file !== '_character_map.json'
    );
}

/** Dedup key that tolerates legacy records missing an id. */
export function letterRecordDedupKey(record: unknown): string {
    const entry = record as { id?: unknown; subject?: unknown; totalDays?: unknown; sender?: { id?: unknown }; recipient?: { id?: unknown }; date?: unknown; summary?: unknown };
    if (typeof entry?.id === 'string' && entry.id !== '') {
        return `id:${entry.id}`;
    }
    if (entry?.subject !== undefined) {
        return [
            'letter',
            String(entry.subject ?? ''),
            String(entry.totalDays ?? ''),
            String(entry.sender?.id ?? ''),
            String(entry.recipient?.id ?? '')
        ].join('\u001f');
    }
    return ['summary', String(entry?.date ?? ''), String(entry?.summary ?? '')].join('\u001f');
}

async function migrateStoreFiles(
    sourceDir: string,
    targetPathFor: (fileName: string) => string,
    backupStoreName: string,
    backupRoot: string,
    playerId: string
): Promise<{ migrated: number; corrupt: number }> {
    let migrated = 0;
    let corrupt = 0;

    for (const fileName of listJsonFiles(sourceDir)) {
        const sourcePath = path.join(sourceDir, fileName);
        let records: unknown[];
        try {
            const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            if (!Array.isArray(parsed)) {
                console.warn(`[letterStoreMigration] ${sourcePath} is not an array; leaving it in place.`);
                corrupt += 1;
                continue;
            }
            records = parsed;
        } catch (error) {
            // Fail-closed: a corrupt flat file is never deleted and blocks the
            // completion marker so a later run can retry it.
            console.warn(`[letterStoreMigration] Failed to parse ${sourcePath}; leaving it in place:`, error);
            corrupt += 1;
            continue;
        }

        const targetPath = targetPathFor(fileName);
        try {
            await updateJsonArrayAtomic<unknown>(
                targetPath,
                (value) => {
                    if (!Array.isArray(value)) {
                        throw new Error('existing campaign letter store file is not an array');
                    }
                    return value;
                },
                (existing) => {
                    const seen = new Set(existing.map(letterRecordDedupKey));
                    const appended = records.filter(record => !seen.has(letterRecordDedupKey(record)));
                    return [...existing, ...appended];
                }
            );
        } catch (error) {
            console.error(`[letterStoreMigration] Failed to commit ${targetPath}; keeping ${sourcePath} in place:`, error);
            corrupt += 1;
            continue;
        }

        // Campaign copy is committed: back up, then remove the flat file.
        try {
            backupFlatFile(sourcePath, backupRoot, backupStoreName, playerId);
            fs.unlinkSync(sourcePath);
            migrated += 1;
            console.log(`[letterStoreMigration] Migrated ${sourcePath} -> ${targetPath}`);
        } catch (error) {
            // The data is safe in both places; report but keep going.
            console.error(`[letterStoreMigration] Backup/unlink failed for ${sourcePath}:`, error);
            corrupt += 1;
        }
    }

    return { migrated, corrupt };
}

/**
 * Runs the one-shot flat letter-store migration for `identity`. Safe to call
 * on every campaign-scoped access: the marker makes it a cheap no-op after
 * the first successful run.
 */
export async function migrateFlatLetterStore(
    userDataDir: string,
    identity: CampaignPlayerIdentity
): Promise<LetterStoreMigrationResult> {
    const markerPath = letterStoreMigrationMarkerPath(userDataDir, identity);
    if (fs.existsSync(markerPath)) {
        return {
            status: 'already-migrated',
            migratedThreadFiles: 0,
            migratedSummaryFiles: 0,
            skippedCorruptFiles: 0
        };
    }

    const legacyThreadsDir = legacyLetterHistoryPlayerDir(userDataDir, identity.playerId);
    const legacySummariesDir = legacyLetterSummariesPlayerDir(userDataDir, identity.playerId);
    const hasFlatData = listJsonFiles(legacyThreadsDir).length > 0 || listJsonFiles(legacySummariesDir).length > 0;
    if (!hasFlatData) {
        // Nothing to claim; write the marker so later runs skip the scan.
        await writeMarker(markerPath, identity, 0, 0);
        return { status: 'no-flat-data', migratedThreadFiles: 0, migratedSummaryFiles: 0, skippedCorruptFiles: 0 };
    }

    if (hasOtherCampaignLetterStore(userDataDir, identity)) {
        console.info(
            `[letterStoreMigration] Player ${identity.playerId} has letter data in more than one campaign; ` +
            'the flat letter_history/letter_summaries store cannot be attributed to a single campaign ' +
            'and stays in its legacy location (still readable as the legacy fallback).'
        );
        return { status: 'ambiguous', migratedThreadFiles: 0, migratedSummaryFiles: 0, skippedCorruptFiles: 0 };
    }

    const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(userDataDir, 'votc_data', 'legacy_backups', backupStamp);

    const threads = await migrateStoreFiles(
        legacyThreadsDir,
        (fileName) => letterThreadPath(userDataDir, identity, path.basename(fileName, '.json')),
        'letter_history',
        backupRoot,
        identity.playerId
    );
    const summaries = await migrateStoreFiles(
        legacySummariesDir,
        (fileName) => letterSummaryPath(userDataDir, identity, path.basename(fileName, '.json')),
        'letter_summaries',
        backupRoot,
        identity.playerId
    );

    const skippedCorruptFiles = threads.corrupt + summaries.corrupt;
    if (skippedCorruptFiles > 0) {
        // Fail-closed: do not mark completion while flat files could not be
        // claimed; a repaired file can be migrated on the next access.
        return {
            status: 'partial',
            migratedThreadFiles: threads.migrated,
            migratedSummaryFiles: summaries.migrated,
            skippedCorruptFiles
        };
    }

    await writeMarker(markerPath, identity, threads.migrated, summaries.migrated);
    return {
        status: 'migrated',
        migratedThreadFiles: threads.migrated,
        migratedSummaryFiles: summaries.migrated,
        skippedCorruptFiles: 0
    };
}

async function writeMarker(
    markerPath: string,
    identity: CampaignPlayerIdentity,
    migratedThreadFiles: number,
    migratedSummaryFiles: number
): Promise<void> {
    const marker: LetterStoreMigrationMarker = {
        version: 1,
        campaignId: identity.campaignId,
        playerId: identity.playerId,
        completedAt: new Date().toISOString(),
        migratedThreadFiles,
        migratedSummaryFiles
    };
    await writeJsonAtomic(markerPath, marker);
}

/** Test/inspection helper: whether the migration marker exists. */
export function hasLetterStoreMigrationMarker(userDataDir: string, identity: CampaignPlayerIdentity): boolean {
    return fs.existsSync(letterStoreMigrationMarkerPath(userDataDir, identity));
}
