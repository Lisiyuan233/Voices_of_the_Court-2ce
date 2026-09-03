import * as fs from 'fs';
import * as path from 'path';

// P2 static parity: pins the frozen cross-process chronicle protocol between
// the 2CE app parsers and the mod2 ce emitters (precedent:
// incomingGreatProjectProtocolStatic.test.ts). Deep behavioural coverage
// lives in the ported unit suites (chronicleMemoryBlockParser /
// chronicleClipboardPayload); this file pins that BOTH SIDES still exist and
// still speak the same field layout.
const APP_ROOT = path.resolve(__dirname, '../..');
const MOD_ROOT = path.resolve(APP_ROOT, '../voices_of_the_court_mod2 ce');

function readAppFile(relativePath: string): string {
    return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf-8');
}

function readModFile(relativePath: string): string {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath), 'utf-8');
}

function expectBalancedCk3Braces(content: string): void {
    const withoutQuotedStrings = content.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const withoutComments = withoutQuotedStrings
        .split(/\r?\n/)
        .map(line => line.replace(/#.*$/, ''))
        .join('\n');
    let depth = 0;
    for (const char of withoutComments) {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
}

describe('chronicle protocol parity (app parsers ↔ mod2 ce emitters)', () => {
    const blockParser = readAppFile('src/main/chronicle/ChronicleMemoryBlockParser.ts');
    const clipboardPayload = readAppFile('src/main/chronicle/chronicleClipboardPayload.ts');
    const effects = readModFile('common/scripted_effects/votc_chronicle_effects.txt');
    const events = readModFile('events/votc_chronicle_events.txt');
    const onActions = readModFile('common/on_action/votc_chronicle_on_actions.txt');
    const locEn = readModFile('localization/english/votc_chronicle_l_english.yml');
    const locSc = readModFile('localization/simp_chinese/votc_chronicle_l_simp_chinese.yml');

    it('mod memory-block emitter keeps the frozen line vocabulary the app parser scans for', () => {
        for (const token of ['start', 'memory', 'participant', 'end']) {
            expect(effects).toContain(`VOTC:CHRONICLE_MEMORY/;/${token}/`);
        }
        for (const token of ["'start'", "'memory'", "'participant'", "'end'"]) {
            expect(blockParser).toContain(token);
        }
        expect(blockParser).toContain('VOTC:CHRONICLE_MEMORY');
    });

    it('memory lines carry the 13 frozen fields in the documented order', () => {
        // effects :78 — the single source of truth for the memory line.
        const memoryLine = /debug_log = "VOTC:CHRONICLE_MEMORY\/;\/memory\/;\/([^"]+)"/.exec(effects);
        expect(memoryLine).toBeDefined();
        // Group 1 excludes the leading VOTC:CHRONICLE_MEMORY/;/memory/;/ tokens.
        const fields = memoryLine![1].split('/;/');
        expect(fields).toHaveLength(11);
        expect(fields[0]).toContain("GetGlobalVariable('votc_chronicle_memory_request_id')");
        expect(fields[2]).toContain('CharacterMemory.GetOwner.GetID');
        expect(fields[6]).toContain('GetCreationDate.GetDateAsTotalDays');
        expect(fields[8]).toContain('GetThirdPerspectiveDescription');
        expect(fields[9]).toBe('50');
        expect(fields[10]).toContain('votc_memory_pcount');
    });

    it('clipboard payload templates stay 25 fields with the frozen prefixes, in both languages', () => {
        for (const loc of [locEn, locSc]) {
            const tick = /votc_chronicle_event\.9003\.desc:0 "([^"]+)"/.exec(loc);
            const manager = /votc_chronicle_event\.9004\.desc:0 "([^"]+)"/.exec(loc);
            expect(tick).toBeDefined();
            expect(manager).toBeDefined();
            expect(tick![1].startsWith('VOTC:CHRONICLE_TICK/;/')).toBe(true);
            expect(manager![1].startsWith('VOTC:CHRONICLE_MANAGER/;/')).toBe(true);
            // Command token + 25 payload fields → 26 split segments.
            expect(tick![1].split('/;/')).toHaveLength(26);
            expect(manager![1].split('/;/')).toHaveLength(26);
            for (const template of [tick![1], manager![1]]) {
                expect(template).toContain("Var('votc_checkpoint_epoch')");
                expect(template).toContain("Var('votc_timeline_node_a')");
                expect(template).toContain("GetGlobalVariable('votc_campaign_id_a')");
                expect(template).toContain("GetGlobalVariable('votc_chronicle_signal_kind').GetFlagName");
                expect(template).toContain("GetGlobalVariable('votc_chronicle_memory_request_id')");
            }
        }
        // The app payload parser validates the in-band signal kind (the
        // command word is dispatched in ClipboardListener, not here).
        expect(clipboardPayload).toContain("['quarterly', 'yearly', 'manual']");
        expect(clipboardPayload).toContain('CHRONICLE_FIELD_START');
    });

    it('wires the pulses append-style and keeps the manager entry effect', () => {
        expect(onActions).toMatch(/quarterly_playable_pulse[\s\S]*votc_chronicle_event\.9001/);
        expect(onActions).toMatch(/yearly_playable_pulse[\s\S]*votc_chronicle_event\.9002/);
        expect(effects).toContain('votc_open_chronicle_manager_manual_effect = {');
        expect(effects).toContain('trigger_event = votc_chronicle_event.9004');
        // The decision entry (hud.gui replacement) fires the manual tick
        // wrapper, which stamps votc_chronicle_signal_kind = manual before the
        // manager effect; calling the inner effect directly would leave the
        // clipboard payload's signal kind empty and the app rejects it.
        expect(effects).toContain('votc_chronicle_manual_tick_effect = {');
        expect(readModFile('common/decisions/votc_decisions.txt')).toContain('votc_chronicle_manual_tick_effect = yes');
        expect(readModFile('common/decisions/votc_decisions.txt')).not.toContain('votc_open_chronicle_manager_manual_effect = yes');
    });

    it('keeps all chronicle mod files structurally balanced', () => {
        for (const content of [effects, events, onActions]) {
            expectBalancedCk3Braces(content);
        }
    });
});
