import fs from 'fs';
import path from 'path';
import {
    buildIdentityFromParts,
    type CampaignPlayerIdentity
} from '../shared/gameData/CampaignIdentity.js';
import {
    TIMELINE_CAMPAIGN_SCHEMA,
    TIMELINE_PROTOCOL_SCHEMA
} from '../shared/gameData/timelineProtocol.js';

export interface BookmarkPlayer {
    id: string;
    name: string;
}

export interface BookmarkData {
    date: string;
    player: BookmarkPlayer;
    characters_in_bookmark: Map<string, string>; // id -> name
}

export async function parseLogForBookmarks(debugLogPath: string): Promise<BookmarkData | undefined> {
    console.log(`Starting to parse log file for bookmarks at: ${debugLogPath}`);
    
    if (!fs.existsSync(debugLogPath)) {
        console.error(`Error: Log file not found at ${debugLogPath}`);
        return undefined;
    }

    const fileContent = await fs.promises.readFile(debugLogPath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    
    // Find the last VOTC:BOOKMARK block
    let lastBookmarkBlockStart = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('VOTC:BOOKMARK') && lines[i].includes('hmd_start')) {
            lastBookmarkBlockStart = i;
            break;
        }
    }
    
    if (lastBookmarkBlockStart === -1) {
        console.log("No VOTC:BOOKMARK block found in the log file.");
        return undefined;
    }
    
    // Extract the bookmark block
    let bookmarkBlock: string[] = [];
    let inBookmarkBlock = false;
    
    for (let i = lastBookmarkBlockStart; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.includes('VOTC:BOOKMARK') && line.includes('hmd_start')) {
            inBookmarkBlock = true;
        }
        
        if (inBookmarkBlock) {
            bookmarkBlock.push(line);
            
            if (line.includes('VOTC:BOOKMARK') && line.includes('hmd_end')) {
                break; // End of bookmark block
            }
        }
    }
    
    if (bookmarkBlock.length === 0) {
        console.log("Empty bookmark block found.");
        return undefined;
    }
    
    // Parse the bookmark block
    const bookmarkData: BookmarkData = {
        date: "",
        player: { id: "", name: "" },
        characters_in_bookmark: new Map<string, string>()
    };
    
    let inCharInfo = false;
    
    for (const line of bookmarkBlock) {
        if (!line.includes('VOTC:BOOKMARK')) continue;
        
        const data = line.split('/;/');
        
        // Extract date
        if (data.includes('time')) {
            const timeIndex = data.indexOf('time');
            if (timeIndex + 2 < data.length) {
                bookmarkData.date = data[timeIndex + 2];
            }
        }
        
        // Extract player info
        if (data.includes('playerdate')) {
            const playerIndex = data.indexOf('playerdate');
            if (playerIndex + 2 < data.length) {
                bookmarkData.player.id = data[playerIndex + 1];
                bookmarkData.player.name = data[playerIndex + 2];
            }
        }
        
        // Handle character info section
        if (data.includes('hmd_charinfo_start')) {
            inCharInfo = true;
            continue;
        }
        
        if (data.includes('hmd_charinfo_end')) {
            inCharInfo = false;
            continue;
        }
        
        // Extract character info
        if (inCharInfo && data.includes('character')) {
            const charIndex = data.indexOf('character');
            if (charIndex + 2 < data.length) {
                const charId = data[charIndex + 1];
                const charName = data[charIndex + 2];
                bookmarkData.characters_in_bookmark.set(charId, charName);
            }
        }
    }
    
    console.log(`Parsed bookmark data: date=${bookmarkData.date}, player=${bookmarkData.player.name}, characters=${bookmarkData.characters_in_bookmark.size}`);

    return bookmarkData;
}

/**
 * Parse the V2 campaign identity carried by the bookmark clipboard command.
 * (Ported from 1.x parseLogforbookmarks.ts:138-180, F10.)
 *
 * The game log only contains the character snapshot. The campaign identity is
 * deliberately sent on the clipboard command, so a bookmark can never be
 * written into the legacy, cross-campaign summary directory by mistake.
 */
export function parseBookmarkCampaignIdentityPayload(
    payloads: readonly string[] | undefined,
    expectedPlayerId: string
): CampaignPlayerIdentity {
    if (!payloads || payloads.length < 11 || payloads[0] !== 'campaign') {
        throw new Error('Bookmark command is missing its V2 campaign identity payload.');
    }

    const playerId = payloads[1];
    if (playerId !== expectedPlayerId) {
        throw new Error(
            `Bookmark player mismatch: log contains ${expectedPlayerId}, command contains ${playerId}.`
        );
    }

    const checkpointEpoch = Number(payloads[2]);
    const protocolSchema = Number(payloads[3]);
    const campaignSchema = Number(payloads[4]);
    const playerTimelineSchema = Number(payloads[10]);

    if (!Number.isSafeInteger(checkpointEpoch) || checkpointEpoch < 0) {
        throw new Error(`Bookmark checkpoint epoch is invalid: ${payloads[2]}.`);
    }
    if (protocolSchema !== TIMELINE_PROTOCOL_SCHEMA) {
        throw new Error(`Unsupported bookmark protocol schema: ${payloads[3]}.`);
    }
    if (campaignSchema !== TIMELINE_CAMPAIGN_SCHEMA) {
        throw new Error(`Unsupported bookmark campaign schema: ${payloads[4]}.`);
    }
    if (playerTimelineSchema !== TIMELINE_CAMPAIGN_SCHEMA) {
        throw new Error(`Unsupported bookmark player timeline schema: ${payloads[10]}.`);
    }

    return buildIdentityFromParts(
        {
            a: Number(payloads[5]),
            b: Number(payloads[6]),
            c: Number(payloads[7]),
            d: Number(payloads[8])
        },
        playerId
    );
}