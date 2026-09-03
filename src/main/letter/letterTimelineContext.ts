import { app } from 'electron';
import {
    buildContextFromGameData,
    FsTimelinePersistence,
    resolveTimelineContext,
    type GameDataLike,
    type TimelineContext,
    type TimelineRegistry
} from '../timelineManager.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';

/**
 * Timeline v2 read/write context for the LetterManager letter store (F21).
 * `identity` routes storage into the campaign namespace; `registry` +
 * `currentNodeId` drive graph visibility; `checkpointEpoch` keeps the legacy
 * epoch filter for records without timeline anchors.
 */
export interface LetterTimelineContext {
    identity?: CampaignPlayerIdentity;
    checkpointEpoch?: number;
    registry?: TimelineRegistry;
    currentNodeId?: string;
    currentParentNodeId?: string;
}

/** Returns the context callers should use when they have no better source. */
export type LetterTimelineContextResolver = () => LetterTimelineContext | undefined;

/**
 * F21 single derivation channel for letter-store timeline context, mirroring
 * the IncomingLetterGenerator.getSummaryTimeline pattern: campaign-scoped
 * registry when the snapshot carries a v2 identity, player-only legacy
 * fallback otherwise. Never throws — an unsupported schema or unreadable
 * registry degrades to an epoch-only context so the letter store keeps its
 * pre-F21 behavior instead of losing the Letters page.
 */
export function resolveLetterTimelineContextFromGameData(gameData: GameDataLike): LetterTimelineContext {
    let base: TimelineContext;
    try {
        base = buildContextFromGameData(gameData);
    } catch (error) {
        // UnsupportedTimelineSchemaError (or a malformed snapshot): keep the
        // letter store on its legacy player-only path.
        console.warn(`[letterTimelineContext] Falling back to epoch-only context: ${error}`);
        base = {
            playerId: String(gameData.playerID),
            checkpointEpoch: gameData.votcCheckpointEpoch
        };
    }

    const identity = base.identity;
    let registry: TimelineRegistry | undefined;
    try {
        const persistence = new FsTimelinePersistence(app.getPath('userData'));
        if (identity) {
            const result = persistence.loadStoreWithIdentity(identity);
            registry = result.status === 'found' ? result.store : undefined;
        } else {
            registry = persistence.loadRegistry(String(gameData.playerID)) ?? undefined;
        }
    } catch (error) {
        console.warn(`[letterTimelineContext] Registry load failed; visibility degrades to epoch filtering: ${error}`);
        registry = undefined;
    }

    let resolvedNodeId: string | undefined;
    let resolvedParentId: string | undefined;
    if (registry) {
        try {
            const resolved = resolveTimelineContext(registry, base);
            resolvedNodeId = resolved.timelineNodeId;
            resolvedParentId = resolved.timelineParentId;
        } catch (error) {
            console.warn(`[letterTimelineContext] Timeline context resolution failed: ${error}`);
        }
    }

    return {
        identity,
        checkpointEpoch: base.checkpointEpoch,
        registry,
        currentNodeId: resolvedNodeId ?? base.timelineNodeId,
        currentParentNodeId: resolvedParentId ?? base.timelineParentId
    };
}
