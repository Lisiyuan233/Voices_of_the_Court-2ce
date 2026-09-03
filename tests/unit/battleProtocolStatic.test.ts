import * as fs from 'fs';
import * as path from 'path';

// F22 static contract: pins the battle report -> timeline protocol between
// "voices_of_the_court_mod2 ce" (emitter) and this app (parser). Template
// precedent: militaryProtocolStatic.test.ts. Every field-position assertion
// here mirrors an indexed read in the app parser, so a mod-side reorder or an
// app-side index change must update both sides in the same commit.
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

function findDebugLogLines(content: string, marker: string): string[] {
    const lines: string[] = [];
    const regex = new RegExp(`debug_log\\s*=\\s*"(${marker}[^"]*)"`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        lines.push(match[1]);
    }
    return lines;
}

function splitFields(line: string): string[] {
    return line.split('/;/').map(s => s.trim());
}

describe('F22 battle report protocol (mod2 ce <-> 2CE app)', () => {
    const effects = readModFile('common/scripted_effects/votc_battle_report_effects.txt');
    const battleEvents = readModFile('events/battle_report_events.txt');
    const checkpointEffects = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
    const generatorSource = readAppFile('src/main/battleReport/BattleReportGenerator.ts');
    const campaignIdentitySource = readAppFile('src/main/battleReport/battleReportCampaignIdentity.ts');
    const mainSource = readAppFile('src/main/main.ts');

    it('ships BOM-prefixed, brace-balanced battle script files', () => {
        for (const relative of [
            'common/scripted_effects/votc_battle_report_effects.txt',
            'events/battle_report_events.txt'
        ]) {
            const bytes = readModFileBytes(relative);
            expect(bytes[0]).toBe(0xef);
            expect(bytes[1]).toBe(0xbb);
            expect(bytes[2]).toBe(0xbf);
        }
        expectBalancedCk3Braces(effects);
        expectBalancedCk3Braces(battleEvents);
    });

    it('emits every VOTC:BATTLE_REPORT data type the app parser consumes', () => {
        // The app switch in extractBattleReportData must know every framework
        // data type the mod emits; unknown types are silently dropped there.
        const consumedTypes = [
            'init',
            'delivery_id',
            'campaign',
            'checkpoint',
            'init_location',
            'init_winner',
            'init_loser',
            'stats',
            'side_result',
            'troops',
            'result',
            'winning_side',
            'commander',
            'notable',
            'tag'
        ];
        for (const dataType of consumedTypes) {
            expect(generatorSource).toContain(`case "${dataType}"`);
        }
        // The framework lines restored by F22 must exist on the mod side.
        for (const dataType of ['checkpoint', 'snapshot_begin', 'campaign', 'delivery_id', 'snapshot_end', 'side_result']) {
            expect(findDebugLogLines(effects, `VOTC:BATTLE_REPORT/;/${dataType}/;/`).length).toBeGreaterThan(0);
        }
        // The 2CE-specific troops enrichment line stays part of the protocol.
        expect(findDebugLogLines(effects, 'VOTC:BATTLE_REPORT/;/troops/;/').length).toBe(1);
    });

    it('emits the campaign line in the exact field order parseBattleReportCampaignIdentityPayload reads', () => {
        // Mod side: VOTC:BATTLE_REPORT/;/campaign/;/player/;/2/;/1/;/a/;/b/;/c/;/d/;/deliveryId
        const lines = findDebugLogLines(effects, 'VOTC:BATTLE_REPORT/;/campaign/;/');
        expect(lines.length).toBe(1);
        const fields = splitFields(lines[0]);
        expect(fields).toHaveLength(10);
        expect(fields[2]).toBe('[THIS.Char.GetID]');
        expect(fields[3]).toBe('2');
        expect(fields[4]).toBe('1');
        expect(fields.slice(5, 9)).toEqual([
            "[GetGlobalVariable('votc_campaign_id_a').GetValue|0]",
            "[GetGlobalVariable('votc_campaign_id_b').GetValue|0]",
            "[GetGlobalVariable('votc_campaign_id_c').GetValue|0]",
            "[GetGlobalVariable('votc_campaign_id_d').GetValue|0]"
        ]);
        expect(fields[9]).toBe("[THIS.Var('votc_battle_report_active_delivery_id').GetValue|0]");

        // App side: parseBattleReportCampaignIdentityPayload reads payloads
        // (parts.slice(1), i.e. WITHOUT the leading "VOTC:BATTLE_REPORT").
        // Index map: 0='campaign', 1=playerId, 2=protocol, 3=campaign,
        // 4..7=a..d, 8=deliveryId -> minimum payload length 9.
        expect(campaignIdentitySource).toContain("payloads[1]");
        expect(campaignIdentitySource).toContain("Number(payloads[2])");
        expect(campaignIdentitySource).toContain("Number(payloads[3])");
        expect(campaignIdentitySource).toContain("Number(payloads[8])");
        expect(campaignIdentitySource).toContain('payloads.length < 9');
        // The generator feeds parts.slice(1) so indexes line up.
        expect(generatorSource).toContain('parseBattleReportCampaignIdentityPayload(\n                            parts.slice(1),');
    });

    it('emits the checkpoint line in the exact field order parseTimelineSnapshot(...,"battle") reads', () => {
        // App side reads parts.slice(2): epoch, nodeA, nodeB, parentA,
        // parentB, checkpointToken, pendingCheckpointToken (7 fields).
        const lines = findDebugLogLines(effects, 'VOTC:BATTLE_REPORT/;/checkpoint/;/');
        expect(lines.length).toBe(1);
        const fields = splitFields(lines[0]);
        expect(fields).toHaveLength(9);
        expect(fields[2]).toBe("[THIS.Var('votc_checkpoint_epoch').GetValue|0]");
        expect(fields[3]).toBe("[THIS.Var('votc_timeline_node_a').GetValue|0]");
        expect(fields[4]).toBe("[THIS.Var('votc_timeline_node_b').GetValue|0]");
        expect(fields[5]).toBe("[THIS.Var('votc_timeline_parent_a').GetValue|0]");
        expect(fields[6]).toBe("[THIS.Var('votc_timeline_parent_b').GetValue|0]");
        expect(fields[7]).toBe("[THIS.Var('votc_checkpoint_token').GetValue|0]");
        expect(fields[8]).toBe("[THIS.Var('votc_checkpoint_pending_token').GetValue|0]");
        // The VOTC:TIMELINE snapshot line logged next to it must carry the
        // same state in the diagnostic layout: schema literals, then player,
        // source tag, then the identical seven state fields.
        const snapshotLines = findDebugLogLines(effects, 'VOTC:TIMELINE/;/snapshot/;/');
        expect(snapshotLines.length).toBe(1);
        const snapshotFields = splitFields(snapshotLines[0]);
        expect(snapshotFields).toHaveLength(13);
        expect(snapshotFields.slice(2, 4)).toEqual(['2', '1']);
        expect(snapshotFields[4]).toBe('[THIS.Char.GetID]');
        expect(snapshotFields[5]).toBe('battle');
        expect(snapshotFields.slice(6, 12)).toEqual(fields.slice(2, 8));
        expect(snapshotFields[12]).toBe(fields[8]);
    });

    it('emits delivery_id/snapshot frame lines that agree with the campaign line delivery variable', () => {
        for (const dataType of ['snapshot_begin', 'delivery_id', 'snapshot_end']) {
            const lines = findDebugLogLines(effects, `VOTC:BATTLE_REPORT/;/${dataType}/;/`);
            expect(lines.length).toBe(1);
            const fields = splitFields(lines[0]);
            // slot flag then the same active delivery id variable the campaign
            // line carries, so the app cross-check (campaign.deliveryId ===
            // battleDeliveryId) compares the same value at runtime.
            expect(fields[2]).toBe("[GetGlobalVariable('votc_battle_report_num').GetFlagName]");
            expect(fields[3]).toBe("[THIS.Var('votc_battle_report_active_delivery_id').GetValue|0]");
        }
    });

    it('allocates per-slot delivery id globals the guarded run script requires', () => {
        // The app arrival script (battleReportRunScript) hard-guards on
        // global_var:votc_battle_report_<slot>_delivery_id; without the mod
        // allocation every report would log skip_delivery_mismatch.
        for (const slot of ['1', '7', '15']) {
            expect(battleEvents).toContain(`name = votc_battle_report_${slot}_delivery_id`);
            expect(battleEvents).toContain(`remove_global_variable ?= votc_battle_report_${slot}_delivery_id`);
        }
        // The delivery id generator is defined with 28 random bits.
        expect(checkpointEffects).toContain('votc_generate_battle_delivery_id_effect = {');
    });

    it('consumes timeline commit results at battle generation and app startup (1.x parity)', () => {
        // Generation-time consumption in the generator ...
        expect(generatorSource).toContain('consumeTimelineCommitResultsFromLog(');
        // ... and startup-time consumption in main.ts (1.x main.ts:600 mirror).
        expect(mainSource).toContain('consumeTimelineCommitResultsFromLog(path.join(config.userFolderPath, \'logs\', \'debug.log\'), app.getPath(\'userData\'))');
        // The batch transition must be invoked from the generator.
        expect(generatorSource).toContain('runBattleTimelineBatchTransition({');
        expect(generatorSource).toContain('coordinateBattlesBySnapshot(');
    });
});
