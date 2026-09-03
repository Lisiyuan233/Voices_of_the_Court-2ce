import fs from 'fs';
import path from 'path';

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

// F11: the close-effect trigger the empty-file path appends. Some callers
// (e.g. the conversation close block in Conversation.ts) already chain this
// trigger inside their effect text, so blindly appending it fires
// mcc_event_v2.9003 twice.
const CLOSE_EFFECT_TRIGGER = 'trigger_event = mcc_event_v2.9003';

export class RunFileManager {
    private path: string;

    constructor(userFolderPath: string) {
        if (!userFolderPath) {
            console.error("RunFileManager error: userFolderPath is not provided. Run file operations will be disabled.");
            this.path = ''; 
            return;
        }
        this.path = path.join(userFolderPath, "run", "votc.txt");
        console.log(`RunFileManager initialized. File path: ${this.path}`);
        this.createRunFolder(userFolderPath);
    }

    write(text: string): void {
        if (!this.path) {
            console.warn('RunFileManager: Cannot write - path is not configured.');
            return;
        }
        try {
            let currentText = '';
            if (fs.existsSync(this.path)) {
                currentText = fs.readFileSync(this.path, 'utf-8').replace(/^﻿/, '');
            }

            if (currentText.trim() === '') {
                if (text.includes(CLOSE_EFFECT_TRIGGER)) {
                    console.log(`RunFileManager: Run file is empty - effect already triggers mcc_event_v2.9003, writing without duplicate.`);
                    this.writeWithBom(`${text}\n`);
                } else {
                    console.log(`RunFileManager: Run file is empty - writing new effect.`);
                    this.writeWithBom(`${text}\n
            root = {${CLOSE_EFFECT_TRIGGER}}`);
                }
            } else {
                console.log(`RunFileManager: Run file is not empty - prepending new effect.`);
                this.writeWithBom(`${text}\n${currentText}`);
            }
            console.log(`RunFileManager: Wrote to run file: ${text}`);
        } catch (error) {
            console.error(`RunFileManager: Failed to write to file ${this.path}:`, error);
        }
    }

    append(text: string): void {
        if (!this.path) {
            console.warn('RunFileManager: Cannot append - path is not configured.');
            return;
        }
        try {
            const currentText = fs.existsSync(this.path)
                ? fs.readFileSync(this.path, 'utf-8').replace(/^﻿/, '')
                : '';
            this.writeWithBom(`${currentText}\n${text}`);
            console.log(`RunFileManager: Appended to run file: ${text}`);
        } catch (error) {
            console.error(`RunFileManager: Failed to append to file ${this.path}:`, error);
        }
    }

    clear(): void {
        if (!this.path) {
            console.warn('RunFileManager: Cannot clear - path is not configured.');
            return;
        }
        try {
            fs.writeFileSync(this.path, "", 'utf-8');
            console.log("RunFileManager: Run file cleared.");
        } catch (error) {
            console.error(`RunFileManager: Failed to clear file ${this.path}:`, error);
        }
    }

    private writeWithBom(text: string): void {
        const content = Buffer.from(text, 'utf-8');
        fs.writeFileSync(this.path, Buffer.concat([UTF8_BOM, content]));
    }

    private createRunFolder(userFolderPath: string): void {
        const runFolderPath = path.join(userFolderPath, "run");
        if (!fs.existsSync(runFolderPath)) {
            try {
                fs.mkdirSync(runFolderPath, { recursive: true });
                console.log(`Created run folder at: ${runFolderPath}`);
            } catch (err) {
                console.error("RunFileManager error creating run folder: " + err);
            }
        }
    }
}
