import * as fs from 'fs';
import * as path from 'path';

// P3 static contract: pins the military council / war-siege-army snapshot
// protocol between "voices_of_the_court_mod2 ce" (emitter) and this app
// (parser). Template precedent: incomingGreatProjectProtocolStatic.test.ts.
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

function extractDebugLogTemplate(content: string, dataType: string): string[] {
    const templates: string[] = [];
    const regex = new RegExp(`debug_log\\s*=\\s*"VOTC:IN/;/(${dataType})/;/([^"]*)"`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        templates.push(match[2]);
    }
    return templates;
}

describe('P3 military council protocol (mod2 ce <-> 2CE app)', () => {
    const effects = readModFile('common/scripted_effects/votc_military_effects.txt');
    const decisions = readModFile('common/decisions/votc_decisions.txt');
    const mccEvents = readModFile('events/mcc_events_v2.txt');
    const trackingEvents = readModFile('events/votc_military_tracking_events.txt');
    const onActions = readModFile('common/on_action/votc_military_tracking_on_actions.txt');
    const talkEn = readModFile('localization/english/talk_l_english.yml');
    const talkZh = readModFile('localization/simp_chinese/talk_l_simp_chinese.yml');
    const parseLogSource = readAppFile('src/shared/gameData/parseLog.ts');
    const briefSource = readAppFile('src/main/conversation/militaryBrief.ts');
    const promptBuilderSource = readAppFile('src/main/conversation/promptBuilder.ts');
    const battleReportSource = readAppFile('src/main/battleReport/BattleReportGenerator.ts');

    it('ships all ported military effects with balanced braces', () => {
        for (const effectName of [
            'votc_record_military_event_effect',
            'votc_log_saved_player_army_effect',
            'votc_log_player_armies_effect',
            'votc_clear_military_army_slots',
            'votc_log_military_events_effect',
            'votc_log_military_snapshot_effect',
            'votc_build_military_council_roster_effect'
        ]) {
            expect(effects).toContain(`${effectName} = {`);
        }
        expectBalancedCk3Braces(effects);
        expectBalancedCk3Braces(trackingEvents);
        expectBalancedCk3Braces(onActions);
    });

    it('registers the council decision wired to the 2CE conversation entry event', () => {
        expect(decisions).toContain('votc_military_council_decision = {');
        expect(decisions).toContain('trigger_event = mcc_event_v2.9100');
        expect(decisions).toContain('is_at_war = yes');
        expect(mccEvents).toContain('mcc_event_v2.9100 = {');
        expectBalancedCk3Braces(decisions);
        expectBalancedCk3Braces(mccEvents);
    });

    it('orders the council stream init -> attendees -> snapshot for the last-block parser', () => {
        // The 2CE app parses only the block after the last init line, so the
        // council event must log the gamedata init first, then attendee lines,
        // then the snapshot. All checks run inside the 9100 event block only —
        // earlier conversation events also mention log_gamedata_v3s.
        const councilBlock = mccEvents.slice(mccEvents.indexOf('mcc_event_v2.9100 = {'));
        const initIdx = councilBlock.indexOf('log_gamedata_v3s');
        const attendeeIdx = councilBlock.indexOf('/military_attendee/');
        const snapshotIdx = councilBlock.indexOf('votc_log_military_snapshot_effect');
        const rosterIdx = councilBlock.indexOf('votc_build_military_council_roster_effect');
        expect(initIdx).toBeGreaterThan(-1);
        expect(attendeeIdx).toBeGreaterThan(initIdx);
        expect(snapshotIdx).toBeGreaterThan(attendeeIdx);
        // Roster build happens before the init emitter (it feeds the selection list).
        expect(rosterIdx).toBeGreaterThan(-1);
        expect(rosterIdx).toBeLessThan(initIdx);
    });

    it('registers war/siege/join tracking hooks on the shared vanilla on_actions', () => {
        expect(onActions).toContain('on_war_started');
        expect(onActions).toContain('votc_military_tracking.0001');
        expect(onActions).toContain('on_siege_completion');
        expect(onActions).toContain('votc_military_tracking.0002');
        expect(onActions).toContain('on_join_war_as_secondary');
        expect(onActions).toContain('votc_military_tracking.0003');
        expect(trackingEvents).toContain('namespace = votc_military_tracking');
    });

    it('localizes the council decision in English and Simplified Chinese', () => {
        for (const [file, name] of [
            [talkEn, 'Convene the Military Council'],
            [talkZh, '召开军议']
        ] as const) {
            expect(file).toContain('votc_military_council_decision:0');
            expect(file).toContain('votc_military_council_decision_desc:0');
            expect(file).toContain('votc_military_council_decision_tooltip:0');
            expect(file).toContain('votc_military_council_decision_confirm:0');
            expect(file).toContain('votc_military_council_decision_effect_desc:0');
            expect(file).toContain(name);
        }
    });

    it('keeps the two-filler army line contract on both sides', () => {
        // Mod side: army lines must carry root slot 0 plus one filler 0 before
        // the army id (1.x GameDataRecordAccumulator parity).
        const armyTemplates = extractDebugLogTemplate(effects, 'army');
        expect(armyTemplates.length).toBeGreaterThan(0);
        for (const template of armyTemplates) {
            expect(template.startsWith('0/;/0/;/[THIS.Army.GetArmyId]')).toBe(true);
        }
        // App side: army id comes from data[2] (root slot + filler), not data[1].
        const armyCase = parseLogSource.slice(
            parseLogSource.indexOf('case "army"'),
            parseLogSource.indexOf('case "army_regiment"')
        );
        expect(armyCase).toContain('const id = Number(data[2])');
        expect(armyCase).not.toContain('const id = Number(data[1])');
    });

    it('emits every war field the app parser consumes, in order', () => {
        const warTemplates = extractDebugLogTemplate(effects, 'war');
        expect(warTemplates.length).toBeGreaterThan(0);
        const war = warTemplates[0];
        const expectedAccessors = [
            '[THIS.War.GetID]',              // id (duplicated into the root slot by the emitter)
            '[THIS.War.GetName]',            // name
            '[THIS.War.GetStartDate.GetStringShort]', // startDate
            'votc_military_player_side',     // playerSide
            'votc_military_war_attacker',    // primary attacker id + name
            'votc_military_war_defender',    // primary defender id + name
            '[THIS.War.GetActiveCasusBelli.GetType.GetName]', // casus belli
            '[THIS.War.GetActiveCasusBelli.GetFirstTitleTarget.GetID]', // target title
            '[THIS.War.GetWarScore|+=0]',    // score total
            '[THIS.War.GetTickingWarScore|+=0]' // score ticking (last field)
        ];
        let cursor = 0;
        for (const accessor of expectedAccessors) {
            const found = war.indexOf(accessor, cursor);
            expect(found).toBeGreaterThan(-1);
            cursor = found;
        }

        // The parser reads the same sequence positionally.
        const warCase = parseLogSource.slice(
            parseLogSource.indexOf('case "war":'),
            parseLogSource.indexOf('case "war_participant"')
        );
        expect(warCase).toContain('Number(data[12]) || 0'); // score total
        expect(warCase).toContain("perspective: 'attacker'");
    });

    it('emits snapshot bookkeeping lines the app requires', () => {
        const snapshotTemplates = extractDebugLogTemplate(effects, 'military_snapshot');
        expect(snapshotTemplates.length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'military_snapshot_complete').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'war_truncation').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'army_regiment').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'war_event').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'war_participant').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'siege').length).toBeGreaterThan(0);
        expect(extractDebugLogTemplate(effects, 'military_attendee').length).toBe(0); // attendees come from the event, not the effects file
    });

    it('restricts attendee roles to the app-side MilitaryAttendeeRole union', () => {
        for (const role of ['marshal', 'field_commander', 'knight', 'commander_candidate', 'war_leader_adviser']) {
            expect(effects).toContain(`value = flag:${role}`);
        }
        // mod1's court_adviser/vassal_adviser must not leak into the 2CE stream
        // (flag-qualified to skip prose comments about the rename).
        expect(effects).not.toContain('flag:court_adviser');
        expect(effects).not.toContain('flag:vassal_adviser');
        expect(parseLogSource).toContain("'war_leader_adviser'");
    });

    it('wires the snapshot into conversation and battle-report prompts', () => {
        expect(promptBuilderSource).toContain('formatMilitaryBrief(conv.gameData.militarySnapshot');
        expect(battleReportSource).toContain('readLastMilitarySnapshotFromLog(debugLogPath)');
        expect(battleReportSource).toContain('formatMilitaryBrief(militarySnapshot');
        expect(briefSource).toContain('export function formatMilitaryBrief');
        expect(parseLogSource).toContain('export async function readLastMilitarySnapshotFromLog');
    });

    it('ships the in-game verification run scripts and cleanup coverage', () => {
        for (const script of [
            'run_test_scripts/votc_test_military_council.txt',
            'run_test_scripts/votc_test_military_roster.txt',
            'run_test_scripts/votc_test_army_debug.txt'
        ]) {
            expect(fs.existsSync(path.join(MOD_ROOT, script))).toBe(true);
        }
        const cleanup = readModFile('run_test_scripts/votc_test_cleanup.txt');
        expect(cleanup).toContain('remove_variable = votc_military_event_1_date');
        expect(cleanup).toContain('remove_variable = votc_military_event_5_payload');
        expect(cleanup).toContain('remove_variable = votc_military_council_role');
    });

    it('stores all new CK3 text files as UTF-8 with BOM', () => {
        for (const file of [
            'common/scripted_effects/votc_military_effects.txt',
            'events/votc_military_tracking_events.txt',
            'common/on_action/votc_military_tracking_on_actions.txt',
            'run_test_scripts/votc_test_military_council.txt',
            'run_test_scripts/votc_test_military_roster.txt',
            'run_test_scripts/votc_test_army_debug.txt'
        ]) {
            const bytes = readModFileBytes(file);
            expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
        }
    });
});
