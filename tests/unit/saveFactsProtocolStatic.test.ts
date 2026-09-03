import * as fs from 'fs';
import * as path from 'path';

// P5 static contract: pins the save-snapshot protocol between
// "voices_of_the_court_mod2 ce" (emitter) and this app (parser + sidecar).
// Template precedent: militaryProtocolStatic.test.ts.
const APP_ROOT = path.resolve(__dirname, '../..');
const MOD_ROOT = path.resolve(APP_ROOT, '../voices_of_the_court_mod2 ce');

function readAppFile(relativePath: string): string {
    return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf-8');
}

function readModFile(relativePath: string): string {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath), 'utf-8');
}

function readModFileBytes(relativePath: string): Buffer {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath));
}

describe('P5 save snapshot protocol (mod2 ce <-> 2CE app)', () => {
    const effects = readModFile('common/scripted_effects/votc_save_snapshot_effects.txt');
    const probeEvents = readModFile('events/votc_save_snapshot_probe_events.txt');
    const scriptedGui = readModFile('common/scripted_guis/votc_save_snapshot.txt');
    const mccEvents = readModFile('events/mcc_events_v2.txt');
    const talkV2Widget = readModFile('gui/event_window_widgets/event_window_widget_talk_v2.gui');
    const locEn = readModFile('localization/english/votc_save_snapshot_probe_l_english.yml');
    const locZh = readModFile('localization/simp_chinese/votc_save_snapshot_probe_l_simp_chinese.yml');
    const v3s = readModFile('common/scripted_effects/log_gamedata_v3s_effect.txt');
    const v3l = readModFile('common/scripted_effects/log_gamedata_v3l_effect.txt');
    const v3 = readModFile('common/scripted_effects/log_gamedata_v3_effect.txt');
    const incomingLetterEffect = readModFile('common/scripted_effects/log_incoming_letter_gamedata_effect.txt');
    const cleanup = readModFile('run_test_scripts/votc_test_cleanup.txt');

    it('ships the save snapshot effects, probe events and scripted GUI gate', () => {
        for (const effectName of [
            'votc_prepare_save_snapshot_effect',
            'votc_log_save_snapshot_probe_state_effect',
            'votc_set_save_snapshot_probe_sequence_effect',
            'votc_clear_save_snapshot_effect'
        ]) {
            expect(effects).toContain(`${effectName} = {`);
        }
        expect(probeEvents).toContain('namespace = votc_save_snapshot_probe');
        expect(probeEvents).toContain('votc_save_snapshot_probe.0001');
        expect(scriptedGui).toContain('votc_save_snapshot_gui = {');
        expect(scriptedGui).toContain('votc_save_snapshot_active');
    });

    it('advertises protocol 1 in both debug and non-debug modes (melt path)', () => {
        // F17 (mod1 726bb95): non-debug saves are binary and parsed via the
        // sidecar melt path, so prepare no longer gates on debug_only and no
        // longer zeroes the tail in an else branch.
        expect(effects).not.toContain('debug_only = yes');
        const prepareBlock = effects.slice(
            effects.indexOf('votc_prepare_save_snapshot_effect = {'),
            effects.indexOf('votc_clear_save_snapshot_effect = {')
        );
        expect(prepareBlock).toContain('change_variable = { name = votc_save_snapshot_sequence add = 1 }');
        expect(prepareBlock).toContain('set_variable = { name = votc_save_snapshot_protocol value = 1 }');
        // Only the explicit clear effect resets the protocol tail to 0.
        expect(prepareBlock).not.toContain("set_variable = { name = votc_save_snapshot_protocol value = 0 }");
        // The probe marker deliberately uses a prefix the VOTC:IN parser ignores.
        expect(effects).toContain('VOTC:SAVE_SNAPSHOT_PROBE/;/STATE/');
    });

    it('emits the init tail in the exact parser order: date five-pack then snapshot triple', () => {
        const expectedTail = [
            '[GetCurrentDate.GetDateAsTotalDays]',
            '[GetCurrentDate.GetYear]',
            '[GetCurrentDate.GetMonthOfYear]',
            '[GetCurrentDate.GetDayOfMonth]',
            '[GetCurrentDate.GetStringShort]',
            "[GetPlayer.MakeScope.Var('votc_save_snapshot_protocol').GetValue|0]",
            "[GetPlayer.MakeScope.Var('votc_save_snapshot_sequence').GetValue|0]",
            "[GetPlayer.MakeScope.Var('votc_save_snapshot_slot').GetValue|0]"
        ];
        for (const [name, content] of [['v3s', v3s], ['v3l', v3l], ['v3', v3]] as const) {
            const initLine = content.split(/\r?\n/).find(l => l.includes('debug_log = "VOTC:IN/;/init'));
            expect(initLine).toBeDefined();
            let cursor = 0;
            for (const accessor of expectedTail) {
                const found = initLine!.indexOf(accessor, cursor);
                expect(found).toBeGreaterThan(-1);
                cursor = found;
            }
            // Payload field count: core 15 + timeline 8 + date 5 + snapshot 3 = 31
            const fields = initLine!.trim().replace(/^debug_log = "/, '').replace(/"$/, '').split('/;/');
            expect(fields.length).toBe(31 + 2); // + VOTC:IN + init
        }
        // The incoming-letter emitter shipped the full tail already and must stay intact.
        const letterInit = incomingLetterEffect.split(/\r?\n/).find(l => l.includes('debug_log = "VOTC:IN/;/init'));
        const letterFields = letterInit!.trim().replace(/^debug_log = "/, '').replace(/"$/, '').split('/;/');
        expect(letterFields.length).toBe(36 + 2); // + join extra five-pack
    });

    it('prepares the snapshot on the player scope before every init emitter call', () => {
        for (const effectName of ['log_gamedata_v3s', 'log_gamedata_v3l', 'log_gamedata_v3 ']) {
            const pattern = new RegExp(
                `votc_init_checkpoint_effect = yes\\n\\t+votc_prepare_save_snapshot_effect = yes[\\s\\S]{0,120}${effectName.trim().replace(' ', ' = yes')}`
            );
            expect(pattern.test(mccEvents)).toBe(true);
        }
        // Military council (9100) prepares inside the root block.
        expect(mccEvents).toContain('votc_init_checkpoint_effect = yes\n\t\t\tvotc_prepare_save_snapshot_effect = yes');
    });

    it('retains the fixed-name save via the conversation widget in one forced batch', () => {
        expect(talkV2Widget).toContain("ExecuteConsoleCommandsForced('save votc_context; gui.createwidget gui/custom_gui/talk_window_v2.gui talk_window_v2')");
        // The overlay widget call must stay in the same batch (same-frame race).
        expect(talkV2Widget).not.toContain("ExecuteConsoleCommand('save");
    });

    it('localizes the probe events in English and Simplified Chinese', () => {
        expect(locEn).toContain('votc_save_snapshot_probe.title:0');
        expect(locEn).toContain('votc_save_snapshot_probe.0001.desc:0');
        expect(locZh).toContain('votc_save_snapshot_probe.title:0');
        expect(locZh).toContain('VOTC 存档快照探针');
    });

    it('clears the snapshot variables in the shared cleanup run script', () => {
        for (const name of [
            'votc_save_snapshot_protocol',
            'votc_save_snapshot_sequence',
            'votc_save_snapshot_slot',
            'votc_save_snapshot_active'
        ]) {
            expect(cleanup).toContain(`remove_variable = ${name}`);
        }
        for (const script of [
            'run_test_scripts/votc_test_save_snapshot_prepare.txt',
            'run_test_scripts/votc_test_save_snapshot_read.txt',
            'run_test_scripts/votc_test_save_snapshot_cleanup.txt',
            // F19: Task 0 regression probes ported from mod1 run_test_scripts.
            'run_test_scripts/votc_test_save_snapshot_save_text.txt',
            'run_test_scripts/votc_test_save_snapshot_schedule_non_debug.txt',
            'run_test_scripts/votc_test_save_snapshot_schedule_save_text_non_debug.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_1.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_2.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_17.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_1001.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_fraction.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_missing.txt',
            'run_test_scripts/votc_test_save_snapshot_sequence_negative.txt'
        ]) {
            expect(fs.existsSync(path.join(MOD_ROOT, script))).toBe(true);
        }
    });

    it('parses the same tail layout on the app side', () => {
        const parser = readAppFile('src/shared/gameData/saveSnapshotProtocol.ts');
        expect(parser).toContain('INIT_SAVE_SNAPSHOT_EXTRA_START_INDEX');
        expect(parser).toContain("SAVE_SNAPSHOT_FIXED_FILE_NAME = 'votc_context.ck3'");
        // GameData must feed the init fields into the parser.
        const gameData = readAppFile('src/shared/gameData/GameData.ts');
        expect(gameData).toContain('parseSaveSnapshotExtra(data)');
    });

    it('resolves the sidecar from the packaged resources path', () => {
        const pathSource = readAppFile('src/main/saveFacts/saveParserPath.ts');
        expect(pathSource).toContain('save-parser');
        expect(pathSource).toContain('votc-save-facts.exe');
        // The forge config must ship the staged binary directory and the
        // sidecar third-party notices (F18).
        const forge = readAppFile('forge.config.js');
        expect(forge).toContain("extraResource: ['./build/save-parser', './THIRD_PARTY_NOTICES.md']");
        // And the staging script must exist next to it.
        expect(fs.existsSync(path.join(APP_ROOT, 'build', 'stageSaveParser.js'))).toBe(true);
        expect(fs.existsSync(path.join(APP_ROOT, 'tools', 'votc-save-facts', 'Cargo.toml'))).toBe(true);
    });

    it('keeps the feature fail-closed in the default config and wiring', () => {
        const defaultConfig = JSON.parse(readAppFile('default_userdata/configs/default_config.json'));
        expect(defaultConfig.saveFacts).toBeDefined();
        expect(defaultConfig.saveFacts.enabled).toBe(false);
        expect(defaultConfig.saveFacts.parserEnabled).toBe(false);
        expect(defaultConfig.saveFacts.promptEnabled).toBe(false);
        expect(defaultConfig.saveFacts.diagnosticsEnabled).toBe(false);
        expect(defaultConfig.saveFacts.categories.war).toBe(false);

        const mainTs = readAppFile('src/main/main.ts');
        // G0-style pre-wait gate: loading is shown only for an available tail.
        expect(mainTs).toContain('willWaitForSaveSnapshot(gameData, saveFactSettings)');
        expect(mainTs).toContain("createEmptyConversationFactContext('disabled')");
        // Diagnostics IPC stays null unless explicitly enabled.
        expect(mainTs).toContain('save-facts:get-diagnostics');
        expect(mainTs).toContain('!settings.diagnosticsEnabled');
    });

    it('stores all new CK3 text files as UTF-8 with BOM', () => {
        for (const file of [
            'common/scripted_effects/votc_save_snapshot_effects.txt',
            'events/votc_save_snapshot_probe_events.txt',
            'common/scripted_guis/votc_save_snapshot.txt',
            'gui/event_window_widgets/votc_save_snapshot_probe_widget.gui',
            'gui/event_window_widgets/votc_save_snapshot_probe_inactive_widget.gui',
            'gui/event_window_widgets/votc_save_snapshot_probe_text_widget.gui',
            'localization/english/votc_save_snapshot_probe_l_english.yml',
            'localization/simp_chinese/votc_save_snapshot_probe_l_simp_chinese.yml'
        ]) {
            const bytes = readModFileBytes(file);
            expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
        }
    });
});
