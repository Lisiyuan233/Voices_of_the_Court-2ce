import { isRecordVisibleForContext, type TimelineRegistry } from '../timelineManager.js';
import type { CampaignPlayerIdentity } from '../../shared/gameData/CampaignIdentity.js';

/**
 * Visibility context for LetterManager letter-thread / letter-summary reads
 * (F21). Mirrors the diary manager's DiaryVisibilityContext shape so both
 * player-scoped stores follow the same timeline semantics.
 */
export interface LetterVisibilityContext {
    identity?: CampaignPlayerIdentity;
    checkpointEpoch?: number;
    registry?: TimelineRegistry;
    currentNodeId?: string;
}

/**
 * Single visibility judgement for every letter-store record (threads and
 * summaries). Reuses the shared `isRecordVisibleForContext` graph/epoch
 * semantics from timelineManager (the same function conversationHistory and
 * summaryManager read paths go through) and adds the cross-campaign guard:
 * a record stamped with another campaign's id is never visible in this
 * campaign, even when it is physically reachable (legacy flat leftovers or
 * a migration edge case).
 *
 * Semantics (isRecordVisibleForContext):
 *   - record carries a timeline node  -> graph visibility; fail-closed when
 *     no registry/current node is available;
 *   - record is epoch-only (legacy)   -> `epoch <= checkpointEpoch`, always
 *     visible when no checkpoint is supplied.
 */
export function isLetterRecordVisible(
    record: { votcCampaignId?: string; votcTimelineNodeId?: string; votcCheckpointEpoch?: number } | null | undefined,
    context: LetterVisibilityContext | undefined
): boolean {
    if (!context) {
        return true;
    }
    if (record?.votcCampaignId && context.identity && record.votcCampaignId !== context.identity.campaignId) {
        return false;
    }
    return isRecordVisibleForContext(
        context.registry,
        context.currentNodeId,
        record ?? {},
        context.checkpointEpoch
    );
}
