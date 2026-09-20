import { app } from 'electron';
import * as fs from "fs";
import * as path from "path";
import { Character } from "../../shared/gameData/Character.js";
import { GameData } from '../../shared/gameData/GameData.js';
import { Letter as ILetter, LetterType, StoredLetter, LetterSummary } from "./letterInterfaces.js";
import { randomUUID } from 'crypto';
import { Config } from '../../shared/Config.js';
import { parseLettersFromLog } from './parseLogForLetters.js';
import { filterSummariesForCheckpoint } from '../summaryManager.js';
import { buildLetterDeliveryPayload, buildLegacyLetterDeliveryPayload } from './letterRunScript.js';
import {
    letterSummaryPath as campaignLetterSummaryPath,
    letterSummariesDir as campaignLetterSummariesDir,
    letterThreadPath as campaignLetterThreadPath,
    letterThreadsDir as campaignLetterThreadsDir,
    conversationSummariesDir as campaignConversationSummariesDir
} from '../campaignDataPaths.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';
import {
    migrateFlatLetterStore,
    type LetterStoreMigrationResult
} from './letterStoreMigration.js';
import {
    type LetterTimelineContext,
    type LetterTimelineContextResolver
} from './letterTimelineContext.js';
import { isLetterRecordVisible } from './letterVisibility.js';

/**
 * How widely player-scoped listings (getAllPlayerIdsWithLetters) scan:
 *   - 'active': legacy flat store + the campaign store of the current
 *     timeline context (default; keeps campaign isolation).
 *   - 'all': legacy flat store + every campaign store. Used by the startup
 *     rehydration of pending letter replies, which must survive app restarts
 *     regardless of which campaign is opened next.
 */
export type LetterPlayerScanScope = 'active' | 'all';

export interface LetterManagerOptions {
    /** <userData> directory (the parent of votc_data). */
    userDataDir: string;
    /**
     * Resolves the current timeline context (campaign identity + registry +
     * current node) for callers that do not carry game data themselves.
     * Injected by main.ts from the active conversation; LetterManager never
     * resolves identity through electron on its own.
     */
    resolveContext?: LetterTimelineContextResolver;
}

interface LetterStoreFile<T> {
    path: string;
    records: T[];
}

export class LetterManager {
    private static instance: LetterManager;
    private configuredUserDataDir?: string;
    private resolveContext?: LetterTimelineContextResolver;
    /** Memoized campaign migration kick-offs, keyed by campaignId|playerId. */
    private campaignStoresReady = new Set<string>();
    private campaignMigrationsInFlight = new Map<string, Promise<LetterStoreMigrationResult | undefined>>();

    private constructor() {
        // Paths and identity resolution are injected via configure().
    }

    /**
     * <userData> directory used for every letter-store path. Hosts should
     * configure() it explicitly; the electron fallback only preserves the
     * pre-F21 path behavior for hosts that use the singleton without a
     * configure() call (tests/tools). It is a PATH fallback only — campaign
     * identity is NEVER resolved here, it comes exclusively from the
     * injected resolver.
     */
    private get userDataDir(): string {
        if (!this.configuredUserDataDir) {
            this.configuredUserDataDir = app.getPath('userData');
        }
        return this.configuredUserDataDir;
    }

    /**
     * F21: injects the user-data dir and the current-identity resolver.
     * Must be called once at app startup before any letter IPC can fire.
     * Re-configuring resets memoized paths/migration state (used by tests).
     */
    public configure(options: LetterManagerOptions): void {
        if (!options || !options.userDataDir) {
            throw new Error('LetterManager.configure requires a userDataDir');
        }
        this.configuredUserDataDir = options.userDataDir;
        this.resolveContext = options.resolveContext;
        this.campaignStoresReady.clear();
        this.campaignMigrationsInFlight.clear();
    }

    public static getInstance(): LetterManager {
        if (!LetterManager.instance) {
            LetterManager.instance = new LetterManager();
        }
        return LetterManager.instance;
    }

    // ------------------------------------------------------------------
    // Context resolution & store routing
    // ------------------------------------------------------------------

    /** Explicit contexts win; otherwise the injected resolver is consulted. */
    private ctxFor(explicit?: LetterTimelineContext): LetterTimelineContext | undefined {
        if (explicit) {
            return explicit;
        }
        try {
            return this.resolveContext?.();
        } catch (error) {
            console.warn('[LetterManager] Context resolver failed; degrading to legacy store:', error);
            return undefined;
        }
    }

    /**
     * Kicks off the one-shot flat-store migration for the campaign (idempotent,
     * once per campaign|player per process) and returns once it settles. The
     * migration itself is fail-closed; a failure only means the flat store
     * stays in place and keeps serving reads through the legacy fallback.
     */
    public async ensureCampaignStoreMigrated(ctx: LetterTimelineContext): Promise<LetterStoreMigrationResult | undefined> {
        const identity = ctx.identity;
        if (!identity) {
            return undefined;
        }
        const key = `${identity.campaignId}|${identity.playerId}`;
        const inFlight = this.campaignMigrationsInFlight.get(key);
        if (inFlight) {
            return inFlight;
        }
        if (this.campaignStoresReady.has(key)) {
            return undefined;
        }
        const migration: Promise<LetterStoreMigrationResult | undefined> = migrateFlatLetterStore(this.userDataDir, identity)
            .then(result => {
                this.campaignStoresReady.add(key);
                return result;
            })
            .catch(error => {
                // Fail-closed: leave the flat store untouched and keep the
                // legacy fallback alive.
                console.error('[LetterManager] Flat letter store migration failed; keeping legacy fallback:', error);
                this.campaignStoresReady.add(key);
                return undefined;
            });
        this.campaignMigrationsInFlight.set(key, migration);
        return migration;
    }

    /** Fire-and-forget variant used by read/write paths. */
    private kickoffCampaignMigration(ctx: LetterTimelineContext | undefined): void {
        if (!ctx?.identity) {
            return;
        }
        void this.ensureCampaignStoreMigrated(ctx);
    }

    private legacyThreadsDirFor(playerId: string): string {
        return path.join(this.userDataDir, 'votc_data', 'letter_history', playerId);
    }

    private legacySummariesDirFor(playerId: string): string {
        return path.join(this.userDataDir, 'votc_data', 'letter_summaries', playerId);
    }

    /**
     * Legacy character map used for display names. Campaign sessions have
     * their own conversation_summaries map; the legacy one is the fallback.
     */
    private characterMapFor(playerId: string, identity?: CampaignPlayerIdentity): { [key: string]: string } {
        const candidates: string[] = [];
        if (identity) {
            try {
                candidates.push(path.join(campaignConversationSummariesDir(this.userDataDir, identity), '_character_map.json'));
            } catch (error) {
                // Invalid identity parts (e.g. scanned directory names) must
                // not break player listings; fall through to the legacy map.
                console.warn(`[LetterManager] Campaign character map path invalid:`, error);
            }
        }
        candidates.push(path.join(this.userDataDir, 'votc_data', 'conversation_summaries', playerId, '_character_map.json'));
        for (const mapPath of candidates) {
            if (fs.existsSync(mapPath)) {
                try {
                    return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                } catch (e) {
                    console.error(`Error reading character map ${mapPath}:`, e);
                }
            }
        }
        return {};
    }

    // ------------------------------------------------------------------
    // Letter threads
    // ------------------------------------------------------------------

    /**
     * Physical thread file for new writes: campaign namespace when a campaign
     * identity is available, legacy flat layout otherwise (degraded mode —
     * the letter feature must keep working before any campaign identity is
     * established; records written there are NOT force-migrated later, they
     * stay readable through the legacy fallback).
     */
    public getLetterFilePath(playerId: string, characterId: string, ctx?: LetterTimelineContext): string {
        const resolved = this.ctxFor(ctx);
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            return campaignLetterThreadPath(this.userDataDir, resolved.identity, characterId);
        }
        return this.legacyThreadPath(playerId, characterId);
    }

    private legacyThreadPath(playerId: string, characterId: string): string {
        const playerFolderPath = this.legacyThreadsDirFor(playerId);
        if (!fs.existsSync(playerFolderPath)) {
            fs.mkdirSync(playerFolderPath, { recursive: true });
        }
        return path.join(playerFolderPath, `${characterId}.json`);
    }

    private loadLetterFile(filePath: string): ILetter[] {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return Array.isArray(parsed) ? parsed as ILetter[] : [];
        } catch (error) {
            // Fail-closed per file: a corrupt file is skipped, never replaced.
            console.error(`Error reading letter file ${filePath}:`, error);
            return [];
        }
    }

    private threadStores(playerId: string, characterId: string, ctx?: LetterTimelineContext): LetterStoreFile<ILetter>[] {
        const resolved = this.ctxFor(ctx);
        const stores: LetterStoreFile<ILetter>[] = [];
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            stores.push({
                path: campaignLetterThreadPath(this.userDataDir, resolved.identity, characterId),
                records: this.loadLetterFile(campaignLetterThreadPath(this.userDataDir, resolved.identity, characterId))
            });
        }
        stores.push({
            path: path.join(this.legacyThreadsDirFor(playerId), `${characterId}.json`),
            records: this.loadLetterFile(path.join(this.legacyThreadsDirFor(playerId), `${characterId}.json`))
        });
        return stores;
    }

    private rehydrateLetters(letters: ILetter[], playerId: string): ILetter[] {
        const playerNumericId = Number(playerId);
        return letters.map(l => ({
            ...l,
            timestamp: new Date(l.timestamp),
            creationTimestamp: l.creationTimestamp ? new Date(l.creationTimestamp) : new Date(l.timestamp),
            isPlayerSender: l.sender.id === playerNumericId,
            totalDays: l.totalDays || 0 // Ensure totalDays has a default value
        }));
    }

    /** Campaign copy wins when a record exists in both stores. */
    private mergeThreadStores(stores: LetterStoreFile<ILetter>[]): { letters: ILetter[]; paths: Set<string> } {
        const seen = new Set<string>();
        const paths = new Set<string>();
        const letters: ILetter[] = [];
        for (const store of stores) {
            paths.add(store.path);
            for (const letter of store.records) {
                const key = this.threadRecordKey(letter);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                letters.push(letter);
            }
        }
        return { letters, paths };
    }

    private threadRecordKey(letter: ILetter): string {
        if (letter.id) {
            return `id:${letter.id}`;
        }
        return [
            'letter',
            letter.subject ?? '',
            letter.totalDays ?? '',
            letter.sender?.id ?? '',
            letter.recipient?.id ?? '',
            letter.timestamp ?? ''
        ].join('\u001f');
    }

    /**
     * Visibility context: the campaign/registry/node context when available,
     * else the plain epoch filter (pre-F21 semantics for records that only
     * carry votcCheckpointEpoch).
     */
    private visibilityFor(ctx: LetterTimelineContext | undefined, checkpointEpoch?: number) {
        if (!ctx) {
            return checkpointEpoch === undefined ? undefined : { checkpointEpoch };
        }
        return {
            identity: ctx.identity,
            checkpointEpoch: ctx.checkpointEpoch ?? checkpointEpoch,
            registry: ctx.registry,
            currentNodeId: ctx.currentNodeId
        };
    }

    public getLetters(playerId: string, characterId: string, checkpointEpoch?: number, ctx?: LetterTimelineContext): ILetter[] {
        const resolved = this.ctxFor(ctx);
        const stores = this.threadStores(playerId, characterId, resolved);
        const { letters } = this.mergeThreadStores(stores);
        let view = this.rehydrateLetters(letters, playerId);
        const visibility = this.visibilityFor(resolved, checkpointEpoch);
        if (visibility) {
            view = view.filter(l => isLetterRecordVisible(l, visibility));
        }
        return view;
    }

    public getAllLetters(playerId: string, checkpointEpoch?: number, ctx?: LetterTimelineContext): ILetter[] {
        const resolved = this.ctxFor(ctx);
        const charFiles = new Set<string>();

        const legacyDir = this.legacyThreadsDirFor(playerId);
        if (fs.existsSync(legacyDir)) {
            for (const file of fs.readdirSync(legacyDir)) {
                if (file.endsWith('.json')) {
                    charFiles.add(file.replace('.json', ''));
                }
            }
        }
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            const campaignDir = campaignLetterThreadsDir(this.userDataDir, resolved.identity);
            if (fs.existsSync(campaignDir)) {
                for (const file of fs.readdirSync(campaignDir)) {
                    if (file.endsWith('.json')) {
                        charFiles.add(file.replace('.json', ''));
                    }
                }
            }
        }

        let allLetters: ILetter[] = [];
        for (const characterId of charFiles) {
            allLetters.push(...this.getLetters(playerId, characterId, checkpointEpoch, resolved));
        }

        // Sort all letters by date, most recent first
        allLetters.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return allLetters;
    }

    /**
     * Unfiltered listing across the legacy store AND every campaign store for
     * one player. Used by startup rehydration of pending replies (delivery
     * bookkeeping, not a user-facing view), which must not depend on which
     * campaign happens to be active after a restart.
     */
    public getAllLettersAcrossCampaigns(playerId: string): ILetter[] {
        // R4: key candidate files by their full path, not by character id —
        // the same player/character pair can have a thread file in the legacy
        // store AND in several campaign stores, and a character-keyed map
        // let later directories shadow earlier ones so only the last file
        // was ever read.
        const threadFiles = new Set<string>();
        const legacyDir = this.legacyThreadsDirFor(playerId);
        if (fs.existsSync(legacyDir)) {
            for (const file of fs.readdirSync(legacyDir)) {
                if (file.endsWith('.json')) {
                    threadFiles.add(path.join(legacyDir, file));
                }
            }
        }
        const campaignsRoot = path.join(this.userDataDir, 'votc_data', 'campaigns');
        if (fs.existsSync(campaignsRoot)) {
            for (const campaignId of fs.readdirSync(campaignsRoot)) {
                const campaignDir = path.join(campaignsRoot, campaignId, 'players', playerId, 'letters', 'threads');
                if (!fs.existsSync(campaignDir)) {
                    continue;
                }
                for (const file of fs.readdirSync(campaignDir)) {
                    if (file.endsWith('.json')) {
                        threadFiles.add(path.join(campaignDir, file));
                    }
                }
            }
        }

        const seen = new Set<string>();
        const allLetters: ILetter[] = [];
        for (const filePath of threadFiles) {
            for (const letter of this.loadLetterFile(filePath)) {
                const key = this.threadRecordKey(letter);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                allLetters.push(letter);
            }
        }
        allLetters.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return allLetters;
    }

    public getAllPlayerIdsWithLetters(scope: LetterPlayerScanScope = 'active'): { id: string, name: string }[] {
        const playerDirs = new Map<string, CampaignPlayerIdentity | undefined>();

        // Legacy flat store: numeric player dirs only. The `player_<id>`
        // subdirectories belong to the timeline letter-history archive and
        // are NOT part of this store.
        const legacyRoot = path.join(this.userDataDir, 'votc_data', 'letter_history');
        if (fs.existsSync(legacyRoot)) {
            for (const dirent of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
                if (dirent.isDirectory() && /^\d+$/.test(dirent.name)) {
                    playerDirs.set(dirent.name, undefined);
                }
            }
        }

        const collectCampaign = (identity: CampaignPlayerIdentity) => {
            const threadsDir = campaignLetterThreadsDir(this.userDataDir, identity);
            if (fs.existsSync(threadsDir) && fs.readdirSync(threadsDir).some(f => f.endsWith('.json'))) {
                playerDirs.set(identity.playerId, identity);
            }
        };

        if (scope === 'active') {
            const resolved = this.ctxFor();
            if (resolved?.identity) {
                this.kickoffCampaignMigration(resolved);
                collectCampaign(resolved.identity);
            }
        } else {
            const campaignsRoot = path.join(this.userDataDir, 'votc_data', 'campaigns');
            if (fs.existsSync(campaignsRoot)) {
                for (const campaignId of fs.readdirSync(campaignsRoot)) {
                    const playersRoot = path.join(campaignsRoot, campaignId, 'players');
                    if (!fs.existsSync(playersRoot)) {
                        continue;
                    }
                    for (const playerId of fs.readdirSync(playersRoot)) {
                        const threadsDir = path.join(playersRoot, playerId, 'letters', 'threads');
                        if (fs.existsSync(threadsDir) && fs.readdirSync(threadsDir).some(f => f.endsWith('.json'))) {
                            playerDirs.set(playerId, {
                                campaignId,
                                playerId
                            } as CampaignPlayerIdentity);
                        }
                    }
                }
            }
        }

        return Array.from(playerDirs.entries())
            .map(([playerId, identity]) => {
                const map = this.characterMapFor(playerId, identity);
                const playerName = map[playerId] || `Player ${playerId}`;

                const allLetters = scope === 'all'
                    ? this.getAllLettersAcrossCampaigns(playerId)
                    : this.getAllLetters(playerId);
                let latestTimestamp = 0;
                if (allLetters.length > 0) {
                    const timestamps = allLetters.map(l => l.creationTimestamp ? new Date(l.creationTimestamp).getTime() : 0);
                    latestTimestamp = Math.max(0, ...timestamps.filter(t => !isNaN(t)));
                }

                return { id: playerId, name: playerName, latestTimestamp };
            })
            .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
            .map(({ id, name }) => ({ id, name }));
    }

    public getCorrespondedCharacters(playerId: string, ctx?: LetterTimelineContext): {id: string, name: string}[] {
        const allLetters = this.getAllLetters(playerId, undefined, ctx);
        const characterInfo = new Map<string, string>();

        const playerNumericId = Number(playerId);

        allLetters.forEach(letter => {
            if (letter.sender && letter.sender.id !== playerNumericId) {
                characterInfo.set(String(letter.sender.id), letter.sender.fullName);
            }
            if (letter.recipient && letter.recipient.id !== playerNumericId) {
                characterInfo.set(String(letter.recipient.id), letter.recipient.fullName);
            }
        });

        return Array.from(characterInfo.entries()).map(([id, name]) => ({ id, name }));
    }

    /**
     * Persists a single letter into its thread. The record goes to the
     * campaign store when a context with identity is available (stamped with
     * campaignId / nodeId / epoch for the timeline visibility filter) and to
     * the legacy flat store otherwise (degraded mode: no identity yet — the
     * write keeps working and is not force-migrated later).
     */
    public saveLetter(letter: ILetter, playerId: string, ctx?: LetterTimelineContext): void {
        // Letters are stored based on the conversation between player and another character.
        // The file is named after the other character.
        const otherCharacterId = letter.sender.id === Number(playerId) ? String(letter.recipient.id) : String(letter.sender.id);

        const resolved = this.ctxFor(ctx);
        let targetPath: string;
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            targetPath = campaignLetterThreadPath(this.userDataDir, resolved.identity, otherCharacterId);
            this.stampLetter(letter, resolved);
        } else {
            targetPath = this.legacyThreadPath(playerId, otherCharacterId);
        }

        // Duplicate check runs against the TARGET store only: a record that
        // already lives in the other store must not suppress the campaign
        // copy (union reads dedup by id anyway).
        const existing = this.loadLetterFile(targetPath).map(l => this.rehydrateLetters([l], playerId)[0]);

        // Avoid duplicates by checking for a letter with the same subject (e.g., letter_5),
        // sent on the same day, between the same two characters.
        const isDuplicate = existing.some(l =>
            l.subject === letter.subject &&
            l.totalDays === letter.totalDays &&
            l.sender.id === letter.sender.id &&
            l.recipient.id === letter.recipient.id
        );

        let history: ILetter[];
        if (!isDuplicate) {
            history = [...existing, letter];
            // Sort by date
            history.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            console.log(`Saved new unique letter: ${letter.subject} from day ${letter.totalDays}`);
        } else {
            history = existing;
        }

        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, JSON.stringify(history, null, 2), 'utf8');
        } catch (error) {
            console.error(`Error saving letter for player ${playerId}, character ${otherCharacterId}:`, error);
        }
    }

    /** Applies the lineage stamps for missing fields only (caller stamps win). */
    private stampLetter(letter: ILetter, ctx: LetterTimelineContext): void {
        if (ctx.identity && !letter.votcCampaignId) {
            letter.votcCampaignId = ctx.identity.campaignId;
        }
        if (ctx.currentNodeId && !letter.votcTimelineNodeId) {
            letter.votcTimelineNodeId = ctx.currentNodeId;
        }
        if (ctx.currentParentNodeId && !letter.votcTimelineParentId) {
            letter.votcTimelineParentId = ctx.currentParentNodeId;
        }
        if (letter.votcCheckpointEpoch === undefined && ctx.checkpointEpoch !== undefined) {
            letter.votcCheckpointEpoch = ctx.checkpointEpoch;
        }
    }

    /**
     * Whole-thread save (LetterReplyGenerator). The merged thread is written
     * to the store the current context routes to; records already living in
     * the other store are folded in by dedup key (campaign copy wins on
     * union reads).
     */
    public saveLetterThread(playerId: string, characterId: string, letters: ILetter[], ctx?: LetterTimelineContext): void {
        const resolved = this.ctxFor(ctx);
        let targetPath: string;
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            targetPath = campaignLetterThreadPath(this.userDataDir, resolved.identity, characterId);
        } else {
            targetPath = this.legacyThreadPath(playerId, characterId);
        }

        const existing = this.loadLetterFile(targetPath);
        const seen = new Set(existing.map(l => this.threadRecordKey(l)));
        const merged = [...existing];
        for (const letter of letters) {
            const key = this.threadRecordKey(letter);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            merged.push(letter);
        }
        merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (error) {
            console.error(`Error saving letter thread for player ${playerId}, character ${characterId}:`, error);
        }
    }

    /** Mutates the record inside whichever physical store holds it. */
    private updateLetterInStores(
        playerId: string,
        characterId: string,
        letterId: string,
        mutate: (letter: ILetter) => void,
        ctx?: LetterTimelineContext
    ): boolean {
        const resolved = this.ctxFor(ctx);
        const stores = this.threadStores(playerId, characterId, resolved);
        for (const store of stores) {
            const letters = this.rehydrateLetters(store.records, playerId);
            const letterIndex = letters.findIndex(l => l.id === letterId);
            if (letterIndex > -1) {
                mutate(letters[letterIndex]);
                try {
                    fs.mkdirSync(path.dirname(store.path), { recursive: true });
                    fs.writeFileSync(store.path, JSON.stringify(letters, null, 2), 'utf8');
                } catch (error) {
                    console.error(`Error updating letter ${letterId} in ${store.path}:`, error);
                }
                return true;
            }
        }
        return false;
    }

    public markAsRead(playerId: string, characterId: string, letterId: string, ctx?: LetterTimelineContext): void {
        const updated = this.updateLetterInStores(playerId, characterId, letterId, letter => {
            letter.isRead = true;
        }, ctx);
        if (!updated) {
            console.warn(`markAsRead: letter ${letterId} not found for player ${playerId}, character ${characterId}.`);
        }
    }

    public markAsDelivered(playerId: string, characterId: string, letterId: string, deliveryDate: Date, ctx?: LetterTimelineContext): void {
        const updated = this.updateLetterInStores(playerId, characterId, letterId, letter => {
            letter.delivered = true;
            // Safeguard: A letter cannot be delivered before it was written.
            if (deliveryDate < letter.timestamp) {
                console.warn(`Delivery date for letter ${letterId} is before its written date. Adjusting delivery date.`);
                letter.deliveryTimestamp = new Date(letter.timestamp);
            } else {
                letter.deliveryTimestamp = deliveryDate;
            }
        }, ctx);
        if (updated) {
            console.log(`Marked letter ${letterId} as delivered on ${deliveryDate}.`);
        } else {
            // R5: a silent miss here left the disk record at delivered:false
            // while the game had already accepted the letter.
            console.warn(`markAsDelivered: letter ${letterId} not found for player ${playerId}, character ${characterId} in the addressed stores.`);
        }
    }

    public updateLetterStatus(playerId: string, characterId: string, letterId: string, status: 'generating' | 'pending' | 'sent' | 'failed' | 'read', ctx?: LetterTimelineContext): void {
        const updated = this.updateLetterInStores(playerId, characterId, letterId, letter => {
            letter.status = status;
        }, ctx);
        if (updated) {
            console.log(`Updated status of letter ${letterId} to ${status}`);
        } else {
            console.warn(`Could not find letter ${letterId} for player ${playerId} / char ${characterId} to update status.`);
        }
    }

    public getLatestLetter(playerId: string, ctx?: LetterTimelineContext): ILetter | null {
        const allLetters = this.getAllLetters(playerId, undefined, ctx);
        if (allLetters.length === 0) {
            return null;
        }

        // Sort by real-world creation timestamp, most recent first
        allLetters.sort((a, b) => {
            const timeA = a.creationTimestamp ? new Date(a.creationTimestamp).getTime() : 0;
            const timeB = b.creationTimestamp ? new Date(b.creationTimestamp).getTime() : 0;
            return timeB - timeA;
        });

        return allLetters[0];
    }

    public deleteLetter(playerId: string, characterId: string, letterId: string, ctx?: LetterTimelineContext): { success: boolean, error?: string } {
        try {
            const resolved = this.ctxFor(ctx);
            const stores = this.threadStores(playerId, characterId, resolved);
            const { letters } = this.mergeThreadStores(stores);
            const view = this.rehydrateLetters(letters, playerId);

            const letterToDelete = view.find(l => l.id === letterId);
            if (!letterToDelete) {
                console.warn(`Letter with id ${letterId} not found for deletion.`);
                return { success: true }; // Idempotent
            }

            const idsToDelete: string[] = [];
            if (letterToDelete.replyToId) { // Deleting a reply
                idsToDelete.push(letterToDelete.replyToId);
                idsToDelete.push(letterToDelete.id);
            } else { // Deleting an original letter
                idsToDelete.push(letterToDelete.id);
                const reply = view.find(l => l.replyToId === letterToDelete.id);
                if (reply) {
                    idsToDelete.push(reply.id);
                }
            }
            const uniqueIdsToDelete = [...new Set(idsToDelete)];

            // Remove the records from whichever store holds them.
            let removedCount = 0;
            for (const store of stores) {
                const remaining = store.records.filter(l => !uniqueIdsToDelete.includes(l.id));
                if (remaining.length === store.records.length) {
                    continue;
                }
                removedCount += store.records.length - remaining.length;
                try {
                    if (remaining.length > 0) {
                        remaining.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                        fs.mkdirSync(path.dirname(store.path), { recursive: true });
                        fs.writeFileSync(store.path, JSON.stringify(remaining, null, 2), 'utf8');
                    } else if (fs.existsSync(store.path)) {
                        fs.unlinkSync(store.path);
                        console.log(`Deleted empty letter file: ${store.path}`);
                    }
                } catch (error) {
                    console.error(`Error deleting letter(s) from ${store.path}:`, error);
                    return { success: false, error: String(error) };
                }
            }

            if (removedCount === 0) {
                console.warn(`No letters were removed for letterId ${letterId}.`);
                return { success: true };
            }
            console.log(`Deleted letter(s) with IDs ${uniqueIdsToDelete.join(', ')} for player ${playerId}, character ${characterId}.`);

            // Now, handle summaries across the same store set.
            const summaryStores = this.summaryStores(playerId, characterId, resolved);
            for (const store of summaryStores) {
                const summaries = store.records;
                const summariesToKeep = summaries.filter(summary =>
                    !summary.letterIds.some(id => uniqueIdsToDelete.includes(id))
                );
                if (summariesToKeep.length === summaries.length) {
                    continue;
                }
                try {
                    if (summariesToKeep.length > 0) {
                        fs.mkdirSync(path.dirname(store.path), { recursive: true });
                        fs.writeFileSync(store.path, JSON.stringify(summariesToKeep, null, 2), 'utf8');
                        console.log(`Updated letter summaries in ${store.path}.`);
                    } else if (fs.existsSync(store.path)) {
                        fs.unlinkSync(store.path);
                        console.log(`Deleted empty letter summary file: ${store.path}`);
                    }
                } catch (error) {
                    console.error(`Error updating letter summaries in ${store.path}:`, error);
                }
            }

            return { success: true };
        } catch (error: any) {
            console.error(`Error deleting letter ${letterId} for player ${playerId}, character ${characterId}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ------------------------------------------------------------------
    // Letter summaries
    // ------------------------------------------------------------------

    private summaryStores(playerId: string, characterId: string, ctx?: LetterTimelineContext): LetterStoreFile<LetterSummary>[] {
        const resolved = this.ctxFor(ctx);
        const stores: LetterStoreFile<LetterSummary>[] = [];
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            const campaignPath = campaignLetterSummaryPath(this.userDataDir, resolved.identity, characterId);
            stores.push({ path: campaignPath, records: this.loadSummaryFile(campaignPath) });
        }
        const legacyPath = path.join(this.legacySummariesDirFor(playerId), `${characterId}.json`);
        stores.push({ path: legacyPath, records: this.loadSummaryFile(legacyPath) });
        return stores;
    }

    private loadSummaryFile(filePath: string): LetterSummary[] {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.map(s => ({
                id: s?.id || randomUUID(), // Add UUID if missing
                ...s
            }));
        } catch (error) {
            // Fail-closed per file: a corrupt file is skipped, never replaced.
            console.error(`Error reading letter summary file ${filePath}:`, error);
            return [];
        }
    }

    public getLetterSummaryFilePath(playerId: string, characterId: string, ctx?: LetterTimelineContext): string {
        const resolved = this.ctxFor(ctx);
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            return campaignLetterSummaryPath(this.userDataDir, resolved.identity, characterId);
        }
        const playerFolderPath = this.legacySummariesDirFor(playerId);
        if (!fs.existsSync(playerFolderPath)) {
            fs.mkdirSync(playerFolderPath, { recursive: true });
        }
        return path.join(playerFolderPath, `${characterId}.json`);
    }

    /**
     * Directories backing the letter summaries of one player in the current
     * context (campaign store first, legacy store second). Exposed for the
     * summary-manager save flow, which deletes character files that the user
     * removed and therefore must operate on the same store set it listed.
     */
    public getLetterSummaryDirsForPlayer(playerId: string): string[] {
        const resolved = this.ctxFor();
        const dirs: string[] = [];
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            dirs.push(campaignLetterSummariesDir(this.userDataDir, resolved.identity));
        }
        dirs.push(this.legacySummariesDirFor(playerId));
        return dirs;
    }

    public getLetterSummaries(playerId: string, characterId: string, checkpointEpoch?: number, ctx?: LetterTimelineContext): LetterSummary[] {
        const resolved = this.ctxFor(ctx);
        const stores = this.summaryStores(playerId, characterId, resolved);
        const seen = new Set<string>();
        let summaries: LetterSummary[] = [];
        for (const store of stores) {
            for (const summary of store.records) {
                const key = summary.id || `${summary.date}\u001f${summary.summary}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                summaries.push(summary);
            }
        }

        if (resolved) {
            const visibility = this.visibilityFor(resolved, checkpointEpoch);
            summaries = summaries.filter(s => isLetterRecordVisible(s, visibility));
        } else if (checkpointEpoch !== undefined) {
            // Legacy epoch filter (pre-F21 behavior for context-less callers).
            summaries = filterSummariesForCheckpoint(summaries, checkpointEpoch);
        }
        return summaries;
    }

    private summaryRecordKey(summary: LetterSummary): string {
        return summary.id || `${summary.date}\u001f${summary.summary}`;
    }

    public saveLetterSummaries(playerId: string, characterId: string, summaries: LetterSummary[], ctx?: LetterTimelineContext): void {
        const resolved = this.ctxFor(ctx);
        let targetPath: string;
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            targetPath = campaignLetterSummaryPath(this.userDataDir, resolved.identity, characterId);
        } else {
            targetPath = path.join(this.legacySummariesDirFor(playerId), `${characterId}.json`);
        }

        // R3: both write flows (reply-generation append and the user-managed
        // save-all) hand in only the records visible in the current context.
        // Merge against the records already on disk so the write replaces the
        // visible subset and KEEPS records hidden on sibling branches — the
        // caller cannot see them, so dropping them (the previous whole-file
        // overwrite) made a rollback onto their branch lose them forever.
        // Deletions of records the caller did see still take effect, because
        // a visible record absent from the incoming set is simply not kept.
        const diskRecords = this.loadSummaryFile(targetPath);
        const diskKeys = new Set(diskRecords.map(s => this.summaryRecordKey(s)));

        // Stamp only records that are genuinely new to this store. Records
        // already on disk keep their own lineage stamps — re-stamping an
        // existing record with the current node would silently move it onto
        // the saving branch and hide it on every other branch.
        if (resolved?.identity) {
            for (const summary of summaries) {
                if (diskKeys.has(this.summaryRecordKey(summary))) {
                    continue;
                }
                if (summary.votcCampaignId === undefined) {
                    summary.votcCampaignId = resolved.identity.campaignId;
                }
                if (summary.votcTimelineNodeId === undefined && resolved.currentNodeId) {
                    summary.votcTimelineNodeId = resolved.currentNodeId;
                }
                if (summary.votcCheckpointEpoch === undefined && resolved.checkpointEpoch !== undefined) {
                    summary.votcCheckpointEpoch = resolved.checkpointEpoch;
                }
            }
        }

        const visibility = resolved ? this.visibilityFor(resolved, undefined) : undefined;
        const incomingKeys = new Set(summaries.map(s => this.summaryRecordKey(s)));
        const hiddenOnDisk = visibility
            ? diskRecords.filter(s => !isLetterRecordVisible(s, visibility) && !incomingKeys.has(this.summaryRecordKey(s)))
            : [];
        const merged = [...summaries, ...hiddenOnDisk];

        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (error) {
            console.error(`Error saving letter summaries for player ${playerId}, character ${characterId}:`, error);
        }
    }

    public getAllLetterSummaries(playerId: string, ctx?: LetterTimelineContext): (LetterSummary & { characterId: string, characterName: string })[] {
        const resolved = this.ctxFor(ctx);
        const characterMap = this.characterMapFor(playerId, resolved?.identity);

        const charFiles = new Map<string, string>(); // characterId -> source label
        if (resolved?.identity) {
            this.kickoffCampaignMigration(resolved);
            const campaignDir = campaignLetterSummariesDir(this.userDataDir, resolved.identity);
            if (fs.existsSync(campaignDir)) {
                for (const file of fs.readdirSync(campaignDir)) {
                    if (file.endsWith('.json') && file !== '_character_map.json') {
                        charFiles.set(file.replace('.json', ''), 'campaign');
                    }
                }
            }
        }
        const legacyDir = this.legacySummariesDirFor(playerId);
        if (fs.existsSync(legacyDir)) {
            for (const file of fs.readdirSync(legacyDir)) {
                if (file.endsWith('.json') && file !== '_character_map.json') {
                    if (!charFiles.has(file.replace('.json', ''))) {
                        charFiles.set(file.replace('.json', ''), 'legacy');
                    }
                }
            }
        }

        let allSummaries: (LetterSummary & { characterId: string, characterName: string })[] = [];
        for (const [characterId] of charFiles) {
            const summaries = this.getLetterSummaries(playerId, characterId, undefined, resolved);
            const characterName = characterMap[characterId] || `Character ${characterId}`;
            const summariesWithCharId = summaries.map(s => ({...s, characterId, characterName}));
            allSummaries.push(...summariesWithCharId);
        }

        allSummaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        return allSummaries;
    }

    public async importLettersFromLog(config: Config, gameData: GameData, playerId: string, gameDate: string, recipientId?: string): Promise<void> {
        const ck3Folder = config.userFolderPath;
        if (!ck3Folder) {
            console.warn("LetterManager.importLettersFromLog: CK3 user folder is not configured.");
            return;
        }
        const debugLogPath = path.join(ck3Folder, 'logs', 'debug.log');

        // Pass gameData to parseLettersFromLog so it can save letters immediately.
        const newLetters = await parseLettersFromLog(debugLogPath, gameData, gameDate, playerId, recipientId);

        if (newLetters.length > 0) {
            console.log(`Imported and saved ${newLetters.length} new letters.`);
        }
    }

    public deliverLetter(storedLetter: StoredLetter, config: Config, gameDate: string) {
        const userFolderPath = config.userFolderPath;
        if (!userFolderPath) {
            console.error("Cannot deliver letter, user folder path is not set.");
            return;
        }

        const letter = storedLetter.originalLetter;
        const replyContent = storedLetter.letter.content;
        const letterId = letter.subject; // This is 'letter_5' etc.

        const runFolderPath = path.join(userFolderPath, "run");
        if (!fs.existsSync(runFolderPath)) {
            fs.mkdirSync(runFolderPath, { recursive: true });
        }

        const letterFilePath = path.join(runFolderPath, "letters.txt");

        const escapedReply = replyContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        // Thread-scheme letters ('letter_1'..'letter_9') get the guarded
        // payload: the timeline commit block persisted on the reply is spliced
        // in so the save receives the letter's node/epoch/token at delivery,
        // and the thread guard makes the letters_runner poll repeats inert.
        // The payload also embeds the reply's own campaign identity (R2), so
        // a stale letters.txt polled in another campaign fails the whole
        // delivery block instead of consuming that campaign's slot. Letters
        // outside the scheme keep the legacy unguarded payload.
        const slotMatch = letterId.match(/^letter_([1-9])$/);
        const gameCommand = slotMatch
            ? buildLetterDeliveryPayload({
                letterNumber: slotMatch[1],
                deliveryId: Number.isSafeInteger(letter.totalDays) && letter.totalDays >= 0 ? letter.totalDays : 0,
                escapedReply,
                timelineBlock: storedLetter.letter.timelineRunBlock,
                campaignIdParts: storedLetter.context?.identity?.campaignParts
            })
            : buildLegacyLetterDeliveryPayload(letterId, escapedReply);

        fs.writeFileSync(letterFilePath, '\uFEFF' + gameCommand, 'utf8');
        console.log(`Delivered letter ${letter.id} by writing to: ${letterFilePath}`);
    }

    public clearLettersFile(config: Config): void {
        const ck3Folder = config.userFolderPath;
        console.log(`LetterManager.clearLettersFile: CK3 user path: ${ck3Folder}`);

        if (!ck3Folder) {
          console.warn("LetterManager.clearLettersFile: CK3 user folder is not configured; cannot clear letters file.");
          return;
        }

        const runFolder = path.join(ck3Folder, "run");
        const letterFilePath = path.join(runFolder, "letters.txt");
        console.log(`LetterManager.clearLettersFile: Letter file path: ${letterFilePath}`);

        if (fs.existsSync(letterFilePath)) {
          fs.writeFileSync(letterFilePath, '\uFEFF' + "debug_log = \"[Localize('talk_event.9999.desc')]\"", "utf-8");
          console.log("Cleared letters.txt file");
        } else {
          console.log("letters.txt file does not exist, nothing to clear");
        }
    }
}
