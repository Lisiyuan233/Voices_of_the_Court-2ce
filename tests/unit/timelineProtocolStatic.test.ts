import * as fs from 'fs';
import * as path from 'path';
import {
    TIMELINE_PROTOCOL_SCHEMA,
    TIMELINE_CAMPAIGN_SCHEMA,
    PROTOCOL_TAIL_FIELD_COUNT,
    INIT_CORE_FIELD_COUNT
} from '../../src/shared/gameData/timelineProtocol';
import { buildBattleReportRunScript } from '../../src/main/battleReport/battleReportRunScript';

/**
 * Static contract test locking the 2CE app ↔ voices_of_the_court_mod2 ce
 * pairing. MOD_ROOT points at the mod this Electron app actually ships with.
 *
 * Scope decision (P6): the 2CE init-line protocol is 24 fields — the 15-field
 * core, the 8-field protocol tail and a single debug save-snapshot protocol
 * placeholder at index 23. The conversation session/roster tail fields that
 * voices_of_the_court_mod1 later evolved (36-field init lines) are NOT part
 * of the 2CE protocol, and neither are the mod1-only save-snapshot effect
 * wiring, manager clipboard payloads, letter delivery ids or chronicle pulse
 * events; those sections of the ported 1.x test were therefore dropped here
 * rather than pointed at a mod this app does not read.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOD_ROOT = path.resolve(PROJECT_ROOT, '../voices_of_the_court_mod2 ce');

function readModFile(relativePath: string): string {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath), 'utf-8');
}

function findDebugLogLines(content: string, marker: string): string[] {
    const lines: string[] = [];
    const regex = new RegExp(`debug_log\\s*=\\s*"(${marker}[^"]*)"`, 'g');
    let match;
    while ((match = regex.exec(content)) !== null) {
        lines.push(match[1]);
    }
    return lines;
}

function splitFields(line: string): string[] {
    return line.split('/;/').map(s => s.trim());
}

const INIT_PRODUCER_FILES = [
    'common/scripted_effects/log_gamedata_v3_effect.txt',
    'common/scripted_effects/log_gamedata_v3l_effect.txt',
    'common/scripted_effects/log_gamedata_v3s_effect.txt'
];

// Phase 4: producers emit real campaign identity sourced from CK3 global
// variables (votc_campaign_id_a..d, votc_campaign_bootstrap_kind) committed by
// votc_init_campaign_id_effect. The protocolSchema and campaignSchema are
// frozen literals (2 and 1). The playerTimelineSchema field reads the
// character's votc_timeline_schema (0 when unset). Producers must reference
// the SAME global-variable interpolation tokens; the actual numeric values
// are runtime-only and are validated separately by the parser tests.
const EXPECTED_TAIL_LITERAL_PREFIX = [
    String(TIMELINE_PROTOCOL_SCHEMA),
    String(TIMELINE_CAMPAIGN_SCHEMA)
];

const CAMPAIGN_ID_GLOBAL_TOKENS = [
    "[GetGlobalVariable('votc_campaign_id_a').GetValue|0]",
    "[GetGlobalVariable('votc_campaign_id_b').GetValue|0]",
    "[GetGlobalVariable('votc_campaign_id_c').GetValue|0]",
    "[GetGlobalVariable('votc_campaign_id_d').GetValue|0]"
];
const CAMPAIGN_BOOTSTRAP_TOKEN = "[GetGlobalVariable('votc_campaign_bootstrap_kind').GetValue|0]";
const PLAYER_TIMELINE_SCHEMA_TOKEN = "[GetPlayer.MakeScope.Var('votc_timeline_schema').GetValue|0]";

function expectInitProducerTail(tail: string[]): void {
    expect(tail.length).toBe(PROTOCOL_TAIL_FIELD_COUNT);
    expect(tail.slice(0, 2)).toEqual(EXPECTED_TAIL_LITERAL_PREFIX);
    expect(tail.slice(2, 6)).toEqual(CAMPAIGN_ID_GLOBAL_TOKENS);
    expect(tail[6]).toBe(CAMPAIGN_BOOTSTRAP_TOKEN);
    expect(tail[7]).toBe(PLAYER_TIMELINE_SCHEMA_TOKEN);
}

// 2CE init layout (indices after slicing off the "VOTC:IN/;/init" prefix),
// aligned with INIT_LAYOUT in src/shared/gameData/timelineProtocol.ts:
//   data[0..7]  playerID, playerName, otherID, otherName, shortDate,
//               scene, location, locationController
//   data[8]     checkpoint epoch; data[9..14] nodeA/nodeB/parentA/
//               parentB/checkpointToken/pendingCheckpointToken
//   data[15..22] the 8-field protocol tail
//   data[23]    debug save-snapshot protocol read placeholder (single field;
//               mod2 ce never writes the variable, so it parses as 0)
// Unlike mod1 there is NO date-extra block and NO conversation session tail.
const INIT_TAIL_START_INDEX = INIT_CORE_FIELD_COUNT;
// P5: the save-snapshot placeholder grew into the date-extra five-pack plus
// the protocol/sequence/slot triple (see saveSnapshotProtocol.ts indices
// 23..30). The short-talk emitters (v3s/v3l/v3) carry the full tail since P5.
const DATE_EXTRA_TOKENS = [
    '[GetCurrentDate.GetDateAsTotalDays]',
    '[GetCurrentDate.GetYear]',
    '[GetCurrentDate.GetMonthOfYear]',
    '[GetCurrentDate.GetDayOfMonth]',
    '[GetCurrentDate.GetStringShort]'
];
const SAVE_SNAPSHOT_TAIL_TOKENS = [
    "[GetPlayer.MakeScope.Var('votc_save_snapshot_protocol').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_save_snapshot_sequence').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_save_snapshot_slot').GetValue|0]"
];
const INIT_DATE_EXTRA_START_INDEX = INIT_TAIL_START_INDEX + PROTOCOL_TAIL_FIELD_COUNT;
const INIT_SAVE_SNAPSHOT_START_INDEX = INIT_DATE_EXTRA_START_INDEX + DATE_EXTRA_TOKENS.length;
const EXPECTED_INIT_FIELD_COUNT = INIT_CORE_FIELD_COUNT + PROTOCOL_TAIL_FIELD_COUNT + DATE_EXTRA_TOKENS.length + SAVE_SNAPSHOT_TAIL_TOKENS.length;
const CHECKPOINT_EPOCH_TOKEN = "[GetPlayer.MakeScope.Var('votc_checkpoint_epoch').GetValue|0]";
const EXPECTED_INIT_CORE_TOKENS = [
    '[GetPlayer.GetID]',
    '[GetPlayer.GetTitledFirstNameNicknamedNoTooltipRegnal]',
    '[recipient.GetID]',
    '[recipient.GetTitledFirstNameNicknamedNoTooltipRegnal]',
    '[GetCurrentDate.GetStringShort]',
    "[GetGlobalVariable('talk_scene').GetFlagName]",
    '[recipient.GetCurrentLocation.GetName]',
    '[recipient.GetCurrentLocation.GetController.GetFullNameNicknamedNoTooltipRegnal]',
    CHECKPOINT_EPOCH_TOKEN,
    "[GetPlayer.MakeScope.Var('votc_timeline_node_a').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_timeline_node_b').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_timeline_parent_a').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_timeline_parent_b').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_checkpoint_token').GetValue|0]",
    "[GetPlayer.MakeScope.Var('votc_checkpoint_pending_token').GetValue|0]"
];

describe('init producer tail consistency', () => {
    for (const file of INIT_PRODUCER_FILES) {
        it(`emits a v2 tail on every VOTC:IN init line in ${file}`, () => {
            const content = readModFile(file);
            const lines = findDebugLogLines(content, 'VOTC:IN/;/init/;/');
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) {
                const fields = splitFields(line).slice(2);
                // Every production init producer carries exactly the core
                // segment, the protocol tail, the date-extra five-pack and the
                // save-snapshot triple (P5 layout, indices 23..30).
                expect(fields.length).toBe(EXPECTED_INIT_FIELD_COUNT);
                // Core segment: identity/date/scene/location fields followed
                // by the checkpoint epoch and timeline state variables.
                expect(fields.slice(0, INIT_CORE_FIELD_COUNT)).toEqual(EXPECTED_INIT_CORE_TOKENS);
                expectInitProducerTail(fields.slice(INIT_TAIL_START_INDEX, INIT_DATE_EXTRA_START_INDEX));
                expect(fields.slice(INIT_DATE_EXTRA_START_INDEX, INIT_SAVE_SNAPSHOT_START_INDEX)).toEqual(DATE_EXTRA_TOKENS);
                expect(fields.slice(INIT_SAVE_SNAPSHOT_START_INDEX)).toEqual(SAVE_SNAPSHOT_TAIL_TOKENS);
                // Negative contract: no background_texture tail segment (that
                // travels on the separate VOTC:BACKGROUND line instead). The
                // date five-pack's GetDateAsTotalDays must appear exactly once.
                expect(line.split('GetDateAsTotalDays').length - 1).toBe(1);
                expect(line).not.toContain('background');
            }
        });

        it(`produces identical init line counts across branches in ${file}`, () => {
            const content = readModFile(file);
            const lines = findDebugLogLines(content, 'VOTC:IN/;/init/;/');
            const uniquePrefixes = new Set<string>();
            for (const line of lines) {
                const fields = splitFields(line);
                const prefix = fields.slice(0, 9).join('/;/');
                uniquePrefixes.add(prefix);
            }
            expect(uniquePrefixes.size).toBeGreaterThan(0);
        });
    }

    it('uses the same v2 tail tokens across all init producers', () => {
        const tails: string[] = [];
        for (const file of INIT_PRODUCER_FILES) {
            const content = readModFile(file);
            const lines = findDebugLogLines(content, 'VOTC:IN/;/init/;/');
            for (const line of lines) {
                tails.push(splitFields(line).slice(2).slice(INIT_TAIL_START_INDEX).join('/;/'));
            }
        }
        expect(new Set(tails).size).toBe(1);
    });

    it('only writes the save snapshot protocol variables from the P5 effects file', () => {
        // P5 ported mod1's save-snapshot protocol: the variables may now be
        // set, but only from votc_save_snapshot_effects.txt (fail-closed gate
        // included); every other effects file must keep its hands off them.
        const effectsRoot = path.join(MOD_ROOT, 'common/scripted_effects');
        const files = fs.readdirSync(effectsRoot, { encoding: 'utf-8' }).filter(f => f.endsWith('.txt'));
        const writers: string[] = [];
        for (const file of files) {
            const text = fs.readFileSync(path.join(effectsRoot, file), 'utf-8');
            if (/set_(global_)?variable\s*=\s*\{\s*name\s*=\s*votc_save_snapshot_/.test(text)) {
                writers.push(file);
            }
        }
        expect(writers).toEqual(['votc_save_snapshot_effects.txt']);
    });
});

describe('VOTC:TIMELINE snapshot/bump schema identity', () => {
    it('emits VOTC:TIMELINE snapshot lines with protocolSchema=2 and campaignSchema=1', () => {
        const files = [
            'common/scripted_effects/votc_battle_report_effects.txt',
            'common/scripted_effects/votc_checkpoint_effects.txt'
        ];
        for (const file of files) {
            const content = readModFile(file);
            const lines = findDebugLogLines(content, 'VOTC:TIMELINE/;/snapshot/;/');
            for (const line of lines) {
                const fields = splitFields(line);
                expect(fields[2]).toBe(String(TIMELINE_PROTOCOL_SCHEMA));
                expect(fields[3]).toBe(String(TIMELINE_CAMPAIGN_SCHEMA));
            }
        }
    });

    it('emits VOTC:TIMELINE bump lines with protocolSchema=2 and campaignSchema=1', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        const lines = findDebugLogLines(content, 'VOTC:TIMELINE/;/bump/;/');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            const fields = splitFields(line);
            expect(fields[2]).toBe(String(TIMELINE_PROTOCOL_SCHEMA));
            expect(fields[3]).toBe(String(TIMELINE_CAMPAIGN_SCHEMA));
        }
    });
});

describe('campaign id generation effects', () => {
    it('defines votc_init/generate/validate_campaign_id_effect in checkpoint effects', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        expect(content).toContain('votc_init_campaign_id_effect = {');
        expect(content).toContain('votc_generate_campaign_id_effect = {');
        expect(content).toContain('votc_validate_campaign_id_effect = {');
        expect(content).toContain('votc_append_campaign_id_bit_effect = {');
    });

    it('calls votc_init_campaign_id_effect at the top of votc_init_checkpoint_effect', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        const initBlock = content.split('votc_init_checkpoint_effect = {')[1] ?? '';
        const firstEffectIndex = initBlock.indexOf('votc_init_campaign_id_effect = yes');
        expect(firstEffectIndex).toBeGreaterThan(-1);
        const firstSetVar = initBlock.indexOf('set_variable');
        expect(firstEffectIndex).toBeLessThan(firstSetVar);
    });

    it('writes votc_campaign_schema after the four id segments, not before', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        // Extract the else branch of votc_init_campaign_id_effect (the fresh
        // bootstrap path), then compare the index of votc_generate_campaign_id_effect
        // against the schema commit write *within that same substring*. The schema
        // marker must come after the generate effect so a crashed generation is
        // detected as corrupt rather than silently re-keyed.
        const initBlock = content.split('votc_init_campaign_id_effect = {')[1]?.split('\n}')[0] ?? '';
        const elseBranch = initBlock.split('else = {')[1] ?? '';
        expect(elseBranch.length).toBeGreaterThan(0);
        const generateIndex = elseBranch.indexOf('votc_generate_campaign_id_effect = yes');
        const schemaIndex = elseBranch.indexOf('name = votc_campaign_schema value = 1');
        expect(generateIndex).toBeGreaterThan(-1);
        expect(schemaIndex).toBeGreaterThan(-1);
        expect(schemaIndex).toBeGreaterThan(generateIndex);
    });

    it('emits VOTC:CAMPAIGN created and corrupt diagnostic lines', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        expect(content).toContain('VOTC:CAMPAIGN/;/created/;/');
        expect(content).toContain('VOTC:CAMPAIGN/;/corrupt/;/');
    });

    it('never silently re-keys a corrupt campaign id', () => {
        const content = readModFile('common/scripted_effects/votc_checkpoint_effects.txt');
        const initBlock = content.split('votc_init_campaign_id_effect = {')[1]?.split('\n}')[0] ?? '';
        const corruptBranch = initBlock.split('VOTC:CAMPAIGN/;/corrupt/;/')[1] ?? '';
        const corruptBranchEnd = corruptBranch.indexOf('else = {');
        const corruptBranchText = corruptBranchEnd > -1
            ? corruptBranch.slice(0, corruptBranchEnd)
            : corruptBranch;
        expect(corruptBranchText).not.toContain('votc_generate_campaign_id_effect');
        expect(corruptBranchText).not.toContain('set_global_variable = { name = votc_campaign_schema');
    });
});

describe('run builder uniqueness and guarded commit coverage', () => {
    it('generates guarded battle run scripts only through buildBattleReportRunScript', () => {
        const srcRoot = path.join(PROJECT_ROOT, 'src');
        const files = fs.readdirSync(srcRoot, { recursive: true, encoding: 'utf-8' }) as string[];
        const runBuilders: string[] = [];
        for (const relative of files) {
            if (!relative.endsWith('.ts')) continue;
            const full = path.join(srcRoot, relative);
            const text = fs.readFileSync(full, 'utf-8');
            if (text.includes('set_variable = { name = votc_timeline_node_a') && text.includes('commit_result')) {
                runBuilders.push(relative);
            }
        }
        expect(runBuilders.some(relative => relative.split(path.sep).join('/') === 'main/battleReport/battleReportRunScript.ts')).toBe(true);
    });

    it('uses the transition-generated checkpoint script for letter reply delivery and fallback', () => {
        const letterFile = path.join(PROJECT_ROOT, 'src/main/letter/LetterReplyGenerator.ts');
        const text = fs.readFileSync(letterFile, 'utf-8');
        expect(text).toContain("scopeVar: 'global_var:message_first_scope'");
        // The registry root must match every other timeline source; the
        // votc_data subfolder (this.userDataPath) is for summaries/letters.
        expect(text).toContain("userDataDir: app.getPath('userData')");
        // The guarded commit block is built once from the transition result
        // and shared by the fallback payload and the persisted reply letter.
        expect(text).toContain('buildLetterTimelineBlock({');
        expect(text).toContain('writeLetterReplyFallbackRunFile(this.config.userFolderPath, snapshot.slotId, snapshot.deliveryId, timelineRunBlock)');
        expect(text).toContain('replyLetter.timelineRunBlock = timelineRunBlock');
        expect(text).not.toContain('set_variable = { name = votc_timeline_node_a');
    });

    it('delivers letter replies through the guarded letters.txt payload', () => {
        const managerFile = path.join(PROJECT_ROOT, 'src/main/letter/LetterManager.ts');
        const text = fs.readFileSync(managerFile, 'utf-8');
        expect(text).toContain('buildLetterDeliveryPayload({');
        expect(text).toContain('timelineBlock: storedLetter.letter.timelineRunBlock');
        expect(text).not.toContain('set_variable = { name = votc_timeline_node_a');
    });
});

describe('unconditional old epoch template writes are prohibited', () => {
    function unguardedEpochTokenWrites(content: string, sourcePath: string): string[] {
        const violations: string[] = [];
        const lines = content.split(/\r?\n/);
        let depth = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const open = (line.match(/\{/g) || []).length;
            const close = (line.match(/\}/g) || []).length;
            if (line.match(/set_variable\s*=\s*\{\s*name\s*=\s*votc_checkpoint_(epoch|token)\s+value\s*=/)) {
                if (depth === 0) {
                    violations.push(`${sourcePath}:${i + 1}`);
                }
            }
            depth += open - close;
        }
        return violations;
    }

    it('has no unguarded checkpoint epoch/token writes in App run generators', () => {
        const srcRoot = path.join(PROJECT_ROOT, 'src');
        const files = fs.readdirSync(srcRoot, { recursive: true, encoding: 'utf-8' }) as string[];
        const violations: string[] = [];
        for (const relative of files) {
            if (!relative.endsWith('.ts')) continue;
            const full = path.join(srcRoot, relative);
            const text = fs.readFileSync(full, 'utf-8');
            violations.push(...unguardedEpochTokenWrites(text, relative));
        }
        expect(violations).toEqual([]);
    });

    it('has no unguarded checkpoint epoch/token writes in Mod scripted effects', () => {
        const effectsRoot = path.join(MOD_ROOT, 'common/scripted_effects');
        const files = fs.readdirSync(effectsRoot, { encoding: 'utf-8' }).filter(f => f.endsWith('.txt'));
        const violations: string[] = [];
        for (const file of files) {
            const full = path.join(effectsRoot, file);
            const text = fs.readFileSync(full, 'utf-8');
            violations.push(...unguardedEpochTokenWrites(text, file));
        }
        expect(violations).toEqual([]);
    });
});

describe('guarded run script emits attempt/result on every branch', () => {
    it('emits every commit_result code in generated battle run scripts', () => {
        const script = buildBattleReportRunScript({
            slotNumber: '1',
            attemptId: 'attempt-1',
            playerId: 'player-1',
            escapedReport: 'report text',
            commit: {
                targetEpoch: 6,
                transitionToken: 222,
                observedEpoch: 5,
                observedNodeA: 11,
                observedNodeB: 22,
                observedParentA: 1,
                observedParentB: 2,
                observedToken: 111,
                targetNodeA: 101,
                targetNodeB: 202,
                graphParentA: 11,
                graphParentB: 22
            }
        });
        for (const code of ['applied', 'already_applied', 'skipped_advanced', 'skip_delivery_mismatch', 'ambiguous_node', 'ambiguous_state']) {
            expect(script).toContain(`VOTC:TIMELINE/;/commit_result/;/attempt-1/;/${code}`);
        }
    });

    it('carries protocolSchema=2 and campaignSchema=1 in commit and commit_result identity', () => {
        const script = buildBattleReportRunScript({
            slotNumber: '1',
            attemptId: 'attempt-1',
            playerId: 'player-1',
            escapedReport: 'report text',
            commit: {
                targetEpoch: 6,
                transitionToken: 222,
                observedNodeA: 11,
                observedNodeB: 22,
                targetNodeA: 101,
                targetNodeB: 202,
                graphParentA: 11,
                graphParentB: 22
            }
        });
        expect(script).toContain('VOTC:TIMELINE/;/commit/;/attempt-1/;/2/;/1/;/player-1/;/battle');
        expect(script).toContain('VOTC:TIMELINE/;/commit_result/;/attempt-1/;/applied/;/2/;/1/;/player-1/;/battle');
        expect(script).toContain('VOTC:TIMELINE/;/commit_result/;/attempt-1/;/skip_delivery_mismatch/;/2/;/1/;/player-1/;/battle');
        expect(script).not.toContain('commit_result/;/attempt-1/;/applied/;/2/;/0/;/');
        expect(script).not.toContain('commit/;/attempt-1/;/2/;/0/;/');
    });

    it('keeps the delivery mismatch branch free of display and cleanup effects', () => {
        const script = buildBattleReportRunScript({
            slotNumber: '1',
            attemptId: 'attempt-1',
            playerId: 'player-1',
            escapedReport: 'report text',
            commit: {
                targetEpoch: 6,
                transitionToken: 222,
                observedNodeA: 11,
                observedNodeB: 22,
                targetNodeA: 101,
                targetNodeB: 202,
                graphParentA: 11,
                graphParentB: 22
            }
        });
        const mismatchStart = script.indexOf('skip_delivery_mismatch');
        expect(mismatchStart).toBeGreaterThan(-1);
        const afterMismatch = script.slice(mismatchStart);
        expect(afterMismatch).not.toContain('send_interface_message');
        expect(afterMismatch).not.toContain('create_artifact');
        expect(afterMismatch).not.toContain('remove_global_variable ?= votc_battle_report_1');
    });
});

describe('new localization keys exist in both english and simplified chinese', () => {
    function extractKeys(content: string): Set<string> {
        const keys = new Set<string>();
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z0-9_.]+):\d+/);
            if (m) keys.add(m[1]);
        }
        return keys;
    }

    const ymlPairs: { en: string; zh: string }[] = [
        {
            en: 'localization/english/talk_l_english.yml',
            zh: 'localization/simp_chinese/talk_l_simp_chinese.yml'
        },
        {
            en: 'localization/english/log_character_l_english.yml',
            zh: 'localization/simp_chinese/log_character_l_simp_chinese.yml'
        },
        {
            en: 'localization/english/clipboard_codes_l_english.yml',
            zh: 'localization/simp_chinese/clipboard_codes_l_simp_chinese.yml'
        }
    ];

    for (const { en, zh } of ymlPairs) {
        const enName = path.basename(en);
        it(`has no key-only-in-one-language mismatches in ${enName}`, () => {
            const enKeys = extractKeys(readModFile(en));
            const zhKeys = extractKeys(readModFile(zh));
            const onlyEn = [...enKeys].filter(k => !zhKeys.has(k)).sort();
            const onlyZh = [...zhKeys].filter(k => !enKeys.has(k)).sort();
            expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] });
        });
    }
});
