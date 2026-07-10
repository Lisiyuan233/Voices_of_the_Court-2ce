import fs from 'fs';
import path from 'path';
import { app } from 'electron';

function getHistoryFileCheckpointEpoch(fileName: string): number | undefined {
    const match = fileName.match(/_ckpt(\d+)_/);
    if (!match) return undefined;
    const epoch = Number(match[1]);
    return Number.isFinite(epoch) ? epoch : undefined;
}

export async function parseConversationHistoryIdsFromLog(logFilePath: string): Promise<{playerId: string, checkpointEpoch?: number}> {
    try {
        if (!fs.existsSync(logFilePath)) {
            throw new Error(`Log file not found: ${logFilePath}`);
        }
        const logContent = fs.readFileSync(logFilePath, 'utf8');
        const lines = logContent.split('\n').filter(line => line.trim());
        
        let conversationHistoryLine = '';
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes('VOTC:conversation_history')) {
                conversationHistoryLine = lines[i];
                break;
            }
        }
        
        if (!conversationHistoryLine) {
            throw new Error('VOTC:conversation_history line not found in log');
        }
        
        const parts = conversationHistoryLine.split('/;/');
        if (parts.length < 2) {
            throw new Error('Invalid VOTC:conversation_history line format');
        }
        
        const playerId = parts[1].trim();
        const checkpointEpoch = parts[2] !== undefined ? Number(parts[2].trim()) : undefined;
        
        if (!playerId) {
            throw new Error('Failed to parse playerId from VOTC:conversation_history line');
        }
        
        return {
            playerId,
            checkpointEpoch: Number.isFinite(checkpointEpoch) ? checkpointEpoch : undefined
        };
    } catch (error) {
        console.error('Error parsing conversation history IDs:', error);
        throw error;
    }
}

// Read list of historical conversation files
export async function getConversationHistoryFiles(playerId: string, currentCharacterIds: number[], limit: number, checkpointEpoch?: number): Promise<Array<{fileName: string, modifiedTime: number}>> {
    try {
        // Build path to conversation history directory - using userdata's conversation_history directory
        const userDataPath = app.getPath('userData');
        const conversationHistoryDir = path.join(userDataPath, 'votc_data', 'conversation_history', playerId);
        
        // Ensure directory exists
        if (!fs.existsSync(conversationHistoryDir)) {
            console.log(`Conversation history directory does not exist: ${conversationHistoryDir}`);
            return [];
        }
        
        const currentIdSet = new Set(currentCharacterIds.map(String));

        // Read all txt files in the directory
        const files = fs.readdirSync(conversationHistoryDir).filter(file => {
            if (!file.endsWith('.txt')) return false;

            const nameParts = file.replace('.txt', '').split('_');
            if (nameParts.length < 2) return false; // Must have at least one character id and a timestamp

            const timestamp = nameParts.pop(); // Remove and check timestamp
            if (isNaN(Number(timestamp))) return false;

            // Handle _ckptN_ segment
            let fileEpoch: number | undefined;
            const lastPart = nameParts[nameParts.length - 1];
            if (lastPart && lastPart.startsWith('ckpt')) {
                nameParts.pop();
                fileEpoch = Number(lastPart.replace('ckpt', ''));
                if (!Number.isFinite(fileEpoch)) fileEpoch = undefined;
            }

            // Epoch filtering: hide files from the "future"
            if (checkpointEpoch !== undefined && fileEpoch !== undefined && fileEpoch > checkpointEpoch) {
                return false;
            }

            // Character ID matching - skip when currentCharacterIds is empty
            if (currentCharacterIds.length > 0) {
                const fileCharacterIds = new Set(nameParts);
                if (fileCharacterIds.size !== currentIdSet.size) return false;
                for (const id of currentIdSet) {
                    if (!fileCharacterIds.has(id)) return false;
                }
            }
            return true;
        });
        
        // Get modification time for each file
        const filesWithStats = files.map(fileName => {
            const filePath = path.join(conversationHistoryDir, fileName);
            const stats = fs.statSync(filePath);
            return {
                fileName,
                modifiedTime: stats.mtime.getTime()
            };
        });
        
        // Sort by modification time, descending (newest first)
        filesWithStats.sort((a, b) => b.modifiedTime - a.modifiedTime);
        
        // If a limit is provided and is greater than 0, apply it
        if (limit > 0) {
            console.log(`Limiting historical conversations to the latest ${limit} files.`);
            return filesWithStats.slice(0, limit);
        }

        return filesWithStats;
    } catch (error) {
        console.error('Error reading conversation history file list:', error);
        throw error;
    }
}

// Read content of a specific historical conversation file
export async function readConversationHistoryFile(playerId: string, fileName: string): Promise<string> {
    try {
        // Build path to conversation history file - using userdata's conversation_history directory
        const userDataPath = app.getPath('userData');
        const filePath = path.join(userDataPath, 'votc_data', 'conversation_history', playerId, fileName);
        
        // Ensure file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`Conversation history file does not exist: ${filePath}`);
        }
        
        // Read file content
        const content = fs.readFileSync(filePath, 'utf8');
        
        return content;
    } catch (error) {
        console.error('Error reading conversation history file:', error);
        throw error;
    }
}
