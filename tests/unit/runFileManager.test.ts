/**
 * F11 (P6-4): RunFileManager.write() used to unconditionally append
 * `root = {trigger_event = mcc_event_v2.9003}` on the empty-file path, so
 * callers whose effect text already chains that trigger (e.g. the
 * conversation close block in Conversation.ts) fired mcc_event_v2.9003
 * twice. These tests pin the three write() paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunFileManager } from '../../src/main/RunFileManager';

const CLOSE_TRIGGER = 'trigger_event = mcc_event_v2.9003';

describe('RunFileManager 9003 dedup (F11)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votc-runfile-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runFile(): string {
        return path.join(tmpDir, 'run', 'votc.txt');
    }

    function triggerCount(content: string): number {
        return content.match(/trigger_event = mcc_event_v2\.9003/g)?.length ?? 0;
    }

    it('appends the close trigger once for an empty file whose text lacks it', () => {
        const manager = new RunFileManager(tmpDir);

        manager.write('my_effect = yes');

        const content = fs.readFileSync(runFile(), 'utf8');
        expect(content).toContain('my_effect = yes');
        expect(triggerCount(content)).toBe(1);
        expect(content).toContain('root = {trigger_event = mcc_event_v2.9003}');
        const raw = fs.readFileSync(runFile());
        expect([raw[0], raw[1], raw[2]]).toEqual([0xEF, 0xBB, 0xBF]);
    });

    it('does not duplicate the close trigger when the effect text already contains it', () => {
        const manager = new RunFileManager(tmpDir);

        manager.write(`my_close_effect = yes\n    ${CLOSE_TRIGGER}`);

        const content = fs.readFileSync(runFile(), 'utf8');
        expect(content).toContain('my_close_effect = yes');
        expect(triggerCount(content)).toBe(1);
        // No extra root block was appended by the empty-file path.
        expect(content).not.toContain('root = {');
    });

    it('prepends to a non-empty run file without touching the close trigger', () => {
        // The constructor creates the run folder, so build it before seeding.
        const manager = new RunFileManager(tmpDir);
        fs.writeFileSync(runFile(), 'existing_effect = yes', 'utf8');

        manager.write('new_effect = yes');

        const content = fs.readFileSync(runFile(), 'utf8');
        const newIdx = content.indexOf('new_effect = yes');
        const existingIdx = content.indexOf('existing_effect = yes');
        expect(newIdx).toBeGreaterThanOrEqual(0);
        expect(existingIdx).toBeGreaterThan(newIdx);
        expect(triggerCount(content)).toBe(0);
    });

    it('clear() leaves a BOM-only file so CK3 does not log an encoding warning', () => {
        const manager = new RunFileManager(tmpDir);
        manager.write('my_effect = yes');

        manager.clear();

        const raw = fs.readFileSync(runFile());
        expect([...raw]).toEqual([0xEF, 0xBB, 0xBF]);
    });
});
