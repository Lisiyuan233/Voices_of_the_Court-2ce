import { GameData } from "../../shared/gameData/GameData";

export interface Message {
    id?: string;
    role: 'system' | 'user' | 'assistant';
    name?: string,
    content: string ;
    narrative?: string; // Narrative property
    characterId?: number;
    actions?: ActionResponse[];
}


export interface ErrorMessage {
    text: string,
}

export interface MessageChunk {
    role?: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null | undefined;
}

export interface Preset {
    systemPrompt: string;
    inputSequence: string;
    outputSequence: string;
}

export interface Setting {
    mainPrompt: string,
    inputSequence: string,
    outputSequence: string,
    parameters: Object;
}

// 1.x conversation_interfaces.ts:56-69 shape (characterId retained from the
// 2CE conversation/letter flows). The chronicle source collector and the
// incoming-letter generator persist these optional metadata fields.
export interface Summary{
    date: string,
    content: string,
    characterId?: string;
    votcCheckpointEpoch?: number;
    votcTimelineNodeId?: string;
    votcTimelineParentId?: string;
    /** F21: campaign lineage stamp for campaign-scoped summary stores. */
    votcCampaignId?: string;
    id?: string;
    characterName?: string;
    sourceType?: 'conversation' | 'letter' | 'incoming_letter' | 'battle_report';
    sourceRecordId?: string;
    gameDate?: import("../../shared/gameData/gameDate").Ck3GameDate
}

export interface ActionArgument{
    name: string;
    type: string;
    desc: string
}

export interface Action{
    signature: string,
    args: ActionArgument[],
    description: string,
    creator?: string,
    check: (gameData: GameData, sourceId: number, targetId: number) => boolean,
    preCheck?: (gameData: GameData, args: string[], sourceId: number, targetId: number) => { success: boolean, message?: string },
    run: (gameData: GameData, runGameEffect: (effect: string) => void, args: string[], sourceId: number, targetId: number) => void,
    chatMessage: (args: string[]) => any,
    chatMessageClass: string
}

export interface ActionResponse{
    actionName: string,
    chatMessage: string,
    chatMessageClass: string
}

export interface PendingAction {
    action: Action;
    args: string[];
    sourceId: number;
    targetId: number;
}

