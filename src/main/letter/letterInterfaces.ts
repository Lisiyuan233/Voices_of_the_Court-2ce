import { Character } from "../../shared/gameData/Character.js";
import type { LetterTimelineContext } from './letterTimelineContext.js';

export enum LetterType {
    DIPLOMATIC = 'diplomatic',
    PERSONAL = 'personal',
    EVENT = 'event',
    UNKNOWN = 'unknown'
}

export interface Letter {
  id: string;
  sender: Character;
  recipient: Character;
  subject: string;
  content: string;
  timestamp: Date; // Game Date
  creationTimestamp: Date; // Real-world Date
  isRead: boolean;
  letterType: LetterType;
  delay: number;
  totalDays: number;
  replyToId?: string;
  status?: 'generating' | 'pending' | 'sent' | 'failed' | 'read';
  delivered?: boolean;
  deliveryTimestamp?: Date;
  expectedDeliveryDate?: Date;
  isPlayerSender?: boolean;
  votcCheckpointEpoch?: number;
  /**
   * Timeline lineage stamps (F21). Written by LetterManager when a campaign
   * identity is available; legacy records (degraded writes / pre-campaign
   * data) only carry votcCheckpointEpoch and fall back to epoch-based
   * visibility filtering.
   */
  votcCampaignId?: string;
  votcTimelineNodeId?: string;
  votcTimelineParentId?: string;
  /**
   * Guarded CK3 timeline commit block (buildLetterTimelineBlock output) for
   * this reply, built at generation time and persisted with the letter
   * history so a delivery after an app restart still carries it. Spliced
   * into the letters.txt payload by LetterManager.deliverLetter.
   */
  timelineRunBlock?: string;
  characterContext?: {
    playerId: string;
    playerName: string;
    recipientId: string;
    recipientName: string;
    gameDate: string;
    scene: string;
    location: string;
    locationController: string;
    totalDays: number;
  };
}

export interface StoredLetter {
    letter: Letter; // The reply letter
    originalLetter: Letter;
    expectedDeliveryDay: number;
    /**
     * R2/R5: the reply's own timeline context (campaign identity + epoch),
     * captured from the game data the reply was generated from, or rebuilt
     * from the record stamps on rehydration. Delivery gating and the
     * VOTC:LETTER_ACCEPTED confirmation (markAsDelivered store routing) use
     * this instead of the mutable current-conversation identity.
     */
    context?: LetterTimelineContext;
}

export interface LetterSummary {
  id: string;
  date: string;
  summary: string;
  letterIds: string[]; // To track which letters this summary covers
  votcCheckpointEpoch?: number;
  /** Timeline lineage stamps (F21), see Letter. */
  votcCampaignId?: string;
  votcTimelineNodeId?: string;
  votcTimelineParentId?: string;
}
