import * as fs from 'fs';
import * as path from 'path';
import {
    buildLetterTimelineBlock,
    buildLetterDeliveryPayload,
    buildLetterFallbackPayload,
    buildLegacyLetterDeliveryPayload
} from '../../src/main/letter/letterRunScript';

/**
 * Static contract tests for the letters.txt run payload. letters.txt is
 * polled every ~2s by the mod's letters_runner widget — the ONLY letters
 * execution point in voices_of_the_court_mod2 ce (the 1.x per-slot
 * event_window_widget_message_N runners that executed letterN.txt were never
 * ported). These tests pin the payload structure, the fail-closed guards and
 * the mod-side contract the payload relies on.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOD_ROOT = path.resolve(PROJECT_ROOT, '../voices_of_the_court_mod2 ce');

function readModFile(relativePath: string): string {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath), 'utf-8');
}

// Mirrors buildCheckpointSetEffect output for node 101-202, parent 11-22,
// target epoch 7, token 4242, scope global_var:message_first_scope.
const SAMPLE_TIMELINE_SCRIPT = [
    'global_var:message_first_scope = {',
    '    set_variable = { name = votc_checkpoint_epoch value = 7 }',
    '    set_variable = { name = votc_checkpoint_token value = 4242 }',
    '    remove_variable ?= votc_checkpoint_pending_token',
    '    set_variable = { name = votc_timeline_node_a value = 101 }',
    '    set_variable = { name = votc_timeline_node_b value = 202 }',
    '    set_variable = { name = votc_timeline_parent_a value = 11 }',
    '    set_variable = { name = votc_timeline_parent_b value = 22 }',
    '    set_variable = { name = votc_timeline_schema value = 1 }',
    '    debug_log = "VOTC:CHECKPOINT/;/set/;/[GetPlayer.GetID]/;/7/;/101/;/202/;/11/;/22"',
    '}'
].join('\n');

const SAMPLE_BLOCK_INPUT = {
    letterNumber: '5',
    deliveryId: 12345,
    targetEpoch: 7,
    checkpointToken: 4242,
    script: SAMPLE_TIMELINE_SCRIPT
};

describe('buildLetterTimelineBlock', () => {
    it('guards the write on the exact target epoch and checkpoint token', () => {
        const block = buildLetterTimelineBlock(SAMPLE_BLOCK_INPUT);
        expect(block).toContain('\t\tvar:votc_checkpoint_epoch = 7');
        expect(block).toContain('\t\tvar:votc_checkpoint_token = 4242');
    });

    it('omits the token guard when the token is missing or invalid', () => {
        for (const checkpointToken of [undefined, 0, -3, 1.5] as (number | undefined)[]) {
            const block = buildLetterTimelineBlock({ ...SAMPLE_BLOCK_INPUT, checkpointToken });
            expect(block).toContain('\t\tvar:votc_checkpoint_epoch = 7');
            expect(block).not.toContain('var:votc_checkpoint_token');
        }
    });

    it('embeds the transition script inside the guarded branch, indented', () => {
        const block = buildLetterTimelineBlock(SAMPLE_BLOCK_INPUT);
        expect(block).toContain('\tglobal_var:message_first_scope = {');
        expect(block).toContain('\t    set_variable = { name = votc_timeline_node_a value = 101 }');
        // Absolute sets only: no bump-style arithmetic that could double-apply.
        expect(block).not.toContain('change_variable');
    });

    it('logs applied / skipped_advanced / skipped_mismatch on the three branches', () => {
        const block = buildLetterTimelineBlock(SAMPLE_BLOCK_INPUT);
        expect(block).toContain('VOTC:LETTER/;/timeline_applied/;/letter_5/;/12345');
        expect(block).toContain('VOTC:LETTER/;/timeline_skipped_advanced/;/letter_5/;/12345');
        expect(block).toContain('VOTC:LETTER/;/timeline_skipped_mismatch/;/letter_5/;/12345');
        // skipped_advanced must trigger only when the save moved PAST target.
        expect(block).toContain('\t\tvar:votc_checkpoint_epoch > 7');
    });

    it('keeps the skip branches free of timeline writes', () => {
        const block = buildLetterTimelineBlock(SAMPLE_BLOCK_INPUT);
        const skippedAdvanced = block.slice(block.indexOf('timeline_skipped_advanced'));
        expect(skippedAdvanced).not.toContain('set_variable');
    });
});

describe('buildLetterDeliveryPayload', () => {
    const payload = buildLetterDeliveryPayload({
        letterNumber: '5',
        deliveryId: 12345,
        escapedReply: 'hello \\"world\\"',
        timelineBlock: buildLetterTimelineBlock(SAMPLE_BLOCK_INPUT)
    });

    it('keeps the heartbeat debug line first', () => {
        expect(payload.startsWith('debug_log = "[Localize(\'talk_event.9999.desc\')]"\n')).toBe(true);
    });

    it('wraps everything in the thread guard with a run_skipped else branch', () => {
        expect(payload).toContain('limit = { exists = global_var:votc_letter_5 }');
        expect(payload).toContain('VOTC:LETTER/;/run_skipped/;/letter_5/;/12345');
    });

    it('delivers exactly once per thread: single artifact/event/cleanup inside the guard', () => {
        expect(payload.match(/create_artifact = \{/g)).toHaveLength(1);
        expect(payload.match(/trigger_event = message_event\.362/g)).toHaveLength(1);
        expect(payload.match(/remove_global_variable \?= votc_letter_5/g)).toHaveLength(1);

        const runSkipped = payload.indexOf('run_skipped');
        expect(payload.indexOf('create_artifact = {')).toBeLessThan(runSkipped);
        expect(payload.indexOf('trigger_event = message_event.362')).toBeLessThan(runSkipped);
        // The thread marker is removed BEFORE the payload ends, so the
        // letters_runner poll repeat lands in the inert else branch.
        expect(payload.indexOf('remove_global_variable ?= votc_letter_5')).toBeLessThan(runSkipped);
    });

    it('applies the timeline before clearing the thread and never blocks delivery on timeline mismatch', () => {
        const applied = payload.indexOf('timeline_applied');
        const mismatch = payload.indexOf('timeline_skipped_mismatch');
        const cleanup = payload.indexOf('remove_global_variable ?= votc_letter_5');
        const artifact = payload.indexOf('create_artifact = {');
        expect(applied).toBeGreaterThan(-1);
        expect(mismatch).toBeGreaterThan(applied);
        // Timeline block (all branches) precedes cleanup and delivery.
        expect(cleanup).toBeGreaterThan(mismatch);
        expect(artifact).toBeGreaterThan(mismatch);
        expect(payload).toContain('var:votc_checkpoint_epoch = 7');
        expect(payload).toContain('var:votc_checkpoint_token = 4242');
    });

    it('carries the escaped reply in the artifact description', () => {
        expect(payload).toContain('description = "hello \\"world\\""');
        expect(payload).toContain('name = votc_huixin_title5');
        expect(payload).toContain('creator = global_var:message_second_scope_letter_5');
    });

    it('omits the timeline guard entirely when the reply carries no block', () => {
        const bare = buildLetterDeliveryPayload({
            letterNumber: '5',
            deliveryId: 12345,
            escapedReply: 'hi'
        });
        expect(bare).not.toContain('var:votc_checkpoint_epoch');
        expect(bare).not.toContain('timeline_applied');
        expect(bare).toContain('limit = { exists = global_var:votc_letter_5 }');
        expect(bare).toContain('trigger_event = message_event.362');
    });
});

describe('buildLetterFallbackPayload', () => {
    const payload = buildLetterFallbackPayload({
        letterNumber: '3',
        deliveryId: 777,
        timelineBlock: buildLetterTimelineBlock({ ...SAMPLE_BLOCK_INPUT, letterNumber: '3', deliveryId: 777 })
    });

    it('is thread-guarded and shows the fallback popup before clearing the thread', () => {
        expect(payload).toContain('limit = { exists = global_var:votc_letter_3 }');
        expect(payload).toContain('send_interface_message = {');
        expect(payload).toContain('desc = votc_letter_reply_fallback_desc');
        expect(payload).toContain('left_icon = global_var:message_second_scope_letter_3');
        expect(payload).toContain('remove_global_variable ?= votc_letter_3');
        expect(payload.indexOf('send_interface_message = {')).toBeLessThan(
            payload.indexOf('remove_global_variable ?= votc_letter_3')
        );
        expect(payload).toContain('VOTC:LETTER/;/run_skipped/;/letter_3/;/777');
    });

    it('applies the guarded timeline block before the popup', () => {
        expect(payload).toContain('VOTC:LETTER/;/timeline_applied/;/letter_3/;/777');
        expect(payload.indexOf('timeline_applied')).toBeLessThan(payload.indexOf('send_interface_message = {'));
    });

    it('never triggers the delivery event or creates an artifact', () => {
        expect(payload).not.toContain('message_event.362');
        expect(payload).not.toContain('create_artifact');
    });
});

describe('buildLegacyLetterDeliveryPayload', () => {
    it('preserves the pre-guard unguarded shape for non-thread letters', () => {
        const legacy = buildLegacyLetterDeliveryPayload('letter_5', 'hi');
        expect(legacy.startsWith('debug_log = "[Localize(\'talk_event.9999.desc\')]"\nremove_global_variable ?= votc_letter_5\n')).toBe(true);
        expect(legacy).toContain('trigger_event = message_event.362');
        expect(legacy).not.toContain('run_skipped');
    });
});

describe('mod2ce letters.txt channel contract', () => {
    it('keeps the letters_runner widget polling run letters.txt', () => {
        const runner = readModFile('gui/custom_gui/letters_runner.gui');
        expect(runner).toContain("ExecuteConsoleCommand('run letters.txt')");
    });

    it('has no per-slot letterN.txt execution point anywhere in the mod', () => {
        // The whole point of the merged payload: letterN.txt would be dead
        // code in mod2 ce. Pin this so nobody reintroduces an app-side
        // letterN.txt writer assuming the mod executes it.
        const guiRoot = path.join(MOD_ROOT, 'gui');
        const files = fs.readdirSync(guiRoot, { recursive: true, encoding: 'utf-8' }) as string[];
        const offenders: string[] = [];
        for (const relative of files) {
            if (!relative.endsWith('.gui')) continue;
            const text = fs.readFileSync(path.join(guiRoot, relative), 'utf-8');
            if (/run letter[0-9]/.test(text)) offenders.push(relative);
        }
        expect(offenders).toEqual([]);
    });

    it('keeps the fallback description and reply title keys in english and simplified chinese', () => {
        for (const file of ['localization/english/talk_l_english.yml', 'localization/simp_chinese/talk_l_simp_chinese.yml']) {
            const content = readModFile(file);
            expect(content).toContain('votc_letter_reply_fallback_desc:');
            for (let n = 1; n <= 9; n++) {
                expect(content).toContain(`votc_huixin_title${n}:`);
            }
        }
    });

    it('keeps message_event.362 wired to the VOTC:LETTER_ACCEPTED clipboard code', () => {
        expect(readModFile('events/message_events.txt')).toContain('message_event.362 = {');
        expect(readModFile('localization/english/clipboard_codes_l_english.yml'))
            .toContain('message_event.362.desc:0 "VOTC:LETTER_ACCEPTED"');
    });
});

describe('app-side wiring of the letters.txt channel', () => {
    it('persists the timeline block on the reply letter and the interface', () => {
        const interfaces = fs.readFileSync(path.join(PROJECT_ROOT, 'src/main/letter/letterInterfaces.ts'), 'utf-8');
        expect(interfaces).toContain('timelineRunBlock?: string');
        const letterClass = fs.readFileSync(path.join(PROJECT_ROOT, 'src/main/letter/Letter.ts'), 'utf-8');
        expect(letterClass).toContain('timelineRunBlock?: string');
    });

    it('no longer writes the unexecuted letterN.txt fallback path', () => {
        const generator = fs.readFileSync(path.join(PROJECT_ROOT, 'src/main/letter/LetterReplyGenerator.ts'), 'utf-8');
        expect(generator).not.toContain('letter${letterNumber}.txt');
        expect(generator).toContain("path.join(runFolderPath, 'letters.txt')");
    });
});
