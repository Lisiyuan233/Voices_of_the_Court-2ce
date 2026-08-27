import * as fs from 'fs';
import * as path from 'path';

// P1 port of Voices_of_the_Court1/tests/unit/incomingGreatProjectProtocolStatic.test.ts.
// Retargeted to the 2CE mod tree (precedent: timelineProtocolStatic retarget
// in commit 121d095b); the CK3 files were copied verbatim, so every structural
// assertion holds unchanged against ../voices_of_the_court_mod2 ce.
const APP_ROOT = path.resolve(__dirname, '../..');
const MOD_ROOT = path.resolve(APP_ROOT, '../voices_of_the_court_mod2 ce');

function readAppFile(relativePath: string): string {
    return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf-8');
}

function readModFile(relativePath: string): string {
    return fs.readFileSync(path.join(MOD_ROOT, relativePath), 'utf-8');
}

function findGreatProjectContextLines(content: string): string[] {
    const lines: string[] = [];
    const regex = /debug_log\s*=\s*"(VOTC:INCOMING_LETTER\/;\/context\/;\/incoming_letter_[1-6]\/;\/great_project_report[^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        lines.push(match[1]);
    }
    return lines;
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

describe('native Great Project incoming-letter protocol', () => {
    const generator = readAppFile('src/main/letter/IncomingLetterGenerator.ts');
    const effects = readModFile('common/scripted_effects/votc_incoming_letter_effects.txt');
    const events = readModFile('events/votc_incoming_letter_events.txt');
    const triggers = readModFile('common/scripted_triggers/votc_incoming_letter_triggers.txt');
    const onActions = readModFile('common/on_action/votc_incoming_letter_on_actions.txt');

    it('registers the new type in the desktop app while preserving special-building notices', () => {
        expect(generator).toContain("| 'great_work_notice' | 'great_project_report'");
        expect(generator).toContain("great_work_notice: '特殊建筑通告'");
        expect(generator).toContain("great_project_report: '国家重大工程'");
        expect(generator).toContain("context.type === 'great_project_report'");
    });

    it('translates project milestones and project roles for the prompt', () => {
        for (const text of [
            "planned: '规划立项'",
            "started: '正式开工'",
            "halfway: '建设过半'",
            "completed: '竣工'",
            "minister_of_works: '工部尚书'",
            "contributor: '工程出资者'"
        ]) {
            expect(generator).toContain(text);
        }
        for (const factKey of [
            'project_name',
            'project_type',
            'project_stage',
            'project_location',
            'project_progress',
            'project_days_left',
            'project_required_funded',
            'project_required_total',
            'project_founder',
            'project_owner',
            'reporter_role',
            'player_project_role'
        ]) {
            expect(generator).toContain(`${factKey}:`);
        }
    });

    it('emits the same complete project fact set for ordinary slots 1 through 6', () => {
        const lines = findGreatProjectContextLines(effects);
        expect(lines).toHaveLength(6);
        const expectedFields = [
            'sender_location',
            'project_name',
            'project_type',
            'project_stage',
            'project_location',
            'project_progress',
            'project_days_left',
            'project_required_funded',
            'project_required_total',
            'project_founder',
            'project_owner',
            'reporter_role',
            'player_project_role'
        ];
        for (let slot = 1; slot <= 6; slot += 1) {
            const line = lines.find(candidate => candidate.includes(`/incoming_letter_${slot}/;/`));
            expect(line).toBeDefined();
            for (const field of expectedFields) {
                expect(line).toContain(`/;/${field}=`);
            }
        }
        expect(effects).not.toContain('incoming_letter_7/;/great_project_report');
        expect(effects).not.toContain('incoming_letter_8/;/great_project_report');
    });

    it('scans quarterly and prioritizes all four milestones with per-player dedupe lists', () => {
        expect(onActions).toMatch(/quarterly_playable_pulse[\s\S]*votc_incoming_letter_event\.0019/);
        expect(events).toContain('votc_incoming_letter_event.0019 = {');
        const declaredEventIds = [...events.matchAll(/^votc_incoming_letter_event\.(\d+)\s*=\s*\{/gm)]
            .map(match => match[1]);
        expect(new Set(declaredEventIds).size).toBe(declaredEventIds.length);
        for (const stage of ['completed', 'halfway', 'started', 'planned']) {
            expect(events).toContain(`value = flag:${stage}`);
        }
        for (const stage of ['planned', 'started', 'halfway', 'completed']) {
            const variable = `votc_great_project_${stage}_reported_players`;
            expect(triggers).toContain(`variable = ${variable}`);
            expect(events).toContain(`name = ${variable}`);
        }
    });

    it('requires project context and applies a 90-day category cooldown', () => {
        expect(effects).toContain('$TYPE$ = flag:great_project_report');
        expect(effects).toContain('exists = global_var:votc_incoming_letter_fact_great_project');
        expect(effects).toMatch(
            /limit = \{ \$TYPE\$ = flag:great_project_report \}[\s\S]*?name = votc_incoming_letter_great_project_cooldown[\s\S]*?days = 90/
        );
        expect(effects).toContain('remove_global_variable ?= votc_incoming_letter_fact_great_project');
    });

    it('ships a repeatable game-console test and cleanup path', () => {
        const testScript = readModFile('run_test_scripts/votc_test_incoming_great_project.txt');
        const cleanupScript = readModFile('run_test_scripts/votc_test_cleanup.txt');
        expect(testScript).toContain('trigger_event = { id = votc_incoming_letter_event.0019 days = 0 }');
        expect(testScript).toContain('no_related_great_project');
        expect(cleanupScript).toContain('votc_incoming_letter_great_project_cooldown');
        expect(cleanupScript).toContain('votc_great_project_completed_reported_players');
    });

    it('keeps all modified CK3 script files structurally balanced', () => {
        for (const content of [effects, events, triggers, onActions]) {
            expectBalancedCk3Braces(content);
        }
    });
});
