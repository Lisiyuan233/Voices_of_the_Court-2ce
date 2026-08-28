/**
 * Timeline v2 lineage stamp shared by diary entries and diary summaries.
 * All fields are optional so records written before timeline v2 stay valid:
 * a record without `votcTimelineNodeId` follows legacy epoch-only visibility
 * semantics (visible while its `votcCheckpointEpoch` is not ahead of the
 * current checkpoint).
 *
 * Stamp semantics: a record is anchored to the timeline position at which it
 * was created. Conversation-close diaries are stamped with the post-bump
 * checkpoint (nextCheckpointEpoch + the newly created node); letter-flow
 * diaries are stamped with the current checkpoint/node because the letter
 * flow does not advance the checkpoint.
 */
export interface DiaryTimelineStamp {
    votcCheckpointEpoch?: number;
    votcTimelineNodeId?: string;
    votcTimelineParentId?: string;
    votcCampaignId?: string;
}

export interface DiaryEntry extends DiaryTimelineStamp {
    id: string;
    date: string;
    location: string;
    scene: string;
    participants: string[];
    content: string;
    character_traits: { [key: string]: string };
    creationTimestamp?: Date;
}

export interface DiarySummary extends DiaryTimelineStamp {
    id: string;
    diaryEntryId: string;
    date: string;
    summary: string;
    characterId?: string;
}
