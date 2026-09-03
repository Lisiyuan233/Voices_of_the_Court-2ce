import { buildBattleReportRunScript, type BattleCommitTarget } from '../../src/main/battleReport/battleReportRunScript';
import {
    TimelineRegistry,
    buildTimelineContextFromParts,
    resolveTimelineContext,
    createChildNodeAndScript
} from '../../src/main/timelineManager';

type Cond =
    | { kind: 'exists_scope'; name: string }
    | { kind: 'exists_global_var'; name: string }
    | { kind: 'global_var_eq'; name: string; value: number }
    | { kind: 'has_variable'; name: string }
    | { kind: 'var_eq'; name: string; value: number }
    | { kind: 'var_gt'; name: string; value: number }
    | { kind: 'scope'; name: string; conds: Cond[] };

type Stmt =
    | { kind: 'if'; branches: { conds: Cond[] | null; body: Stmt[] }[] }
    | { kind: 'scope'; name: string; body: Stmt[] }
    | { kind: 'set_var'; name: string; value: number }
    | { kind: 'remove_var'; name: string }
    | { kind: 'remove_global_var'; name: string }
    | { kind: 'debug_log'; text: string }
    | { kind: 'send_message'; desc: string }
    | { kind: 'create_artifact' };

interface MockCk3 {
    reportPlayerExists: boolean;
    playerVars: Map<string, number>;
    globalVars: Map<string, number | true>;
    logs: string[];
    messages: string[];
    artifacts: number;
}

function parseConds(lines: string[], start: number): { conds: Cond[]; next: number } {
    const conds: Cond[] = [];
    let i = start;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line === '}') {
            return { conds, next: i + 1 };
        }
        let m = line.match(/^exists = scope:(\S+)$/);
        if (m) { conds.push({ kind: 'exists_scope', name: m[1] }); continue; }
        m = line.match(/^exists = global_var:(\S+)$/);
        if (m) { conds.push({ kind: 'exists_global_var', name: m[1] }); continue; }
        m = line.match(/^global_var:(\S+) = (-?\d+)$/);
        if (m) { conds.push({ kind: 'global_var_eq', name: m[1], value: Number(m[2]) }); continue; }
        m = line.match(/^scope:(\S+) = \{$/);
        if (m) {
            const parsed = parseConds(lines, i + 1);
            conds.push({ kind: 'scope', name: m[1], conds: parsed.conds });
            i = parsed.next - 1;
            continue;
        }
        m = line.match(/^has_variable = (\S+)$/);
        if (m) { conds.push({ kind: 'has_variable', name: m[1] }); continue; }
        m = line.match(/^var:(\S+) = (-?\d+)$/);
        if (m) { conds.push({ kind: 'var_eq', name: m[1], value: Number(m[2]) }); continue; }
        m = line.match(/^var:(\S+) > (-?\d+)$/);
        if (m) { conds.push({ kind: 'var_gt', name: m[1], value: Number(m[2]) }); continue; }
        throw new Error(`unsupported condition: ${line}`);
    }
    throw new Error('unterminated limit block');
}

function parseBlock(lines: string[], start: number): { stmts: Stmt[]; next: number } {
    const stmts: Stmt[] = [];
    let i = start;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line === '}') {
            return { stmts, next: i + 1 };
        }
        if (line === 'if = {' || line === 'else_if = {' || line === 'else = {') {
            const branches: { conds: Cond[] | null; body: Stmt[] }[] = [];
            let current = line;
            let cursor = i + 1;
            while (true) {
                let conds: Cond[] | null = null;
                if (current !== 'else = {') {
                    if (lines[cursor] !== 'limit = {') throw new Error(`expected limit after ${current}`);
                    const parsed = parseConds(lines, cursor + 1);
                    conds = parsed.conds;
                    cursor = parsed.next;
                }
                const body = parseBlock(lines, cursor);
                branches.push({ conds, body: body.stmts });
                cursor = body.next;
                const follow = lines[cursor];
                if (follow === 'else_if = {' || follow === 'else = {') {
                    current = follow;
                    cursor++;
                    continue;
                }
                i = cursor - 1;
                break;
            }
            stmts.push({ kind: 'if', branches });
            continue;
        }
        let m = line.match(/^scope:(\S+) = \{$/);
        if (m) {
            const body = parseBlock(lines, i + 1);
            stmts.push({ kind: 'scope', name: m[1], body: body.stmts });
            i = body.next - 1;
            continue;
        }
        m = line.match(/^set_variable = \{ name = (\S+) value = (-?\d+) \}$/);
        if (m) { stmts.push({ kind: 'set_var', name: m[1], value: Number(m[2]) }); continue; }
        m = line.match(/^remove_variable \??= (\S+)$/);
        if (m) { stmts.push({ kind: 'remove_var', name: m[1] }); continue; }
        m = line.match(/^remove_global_variable \??= (\S+)$/);
        if (m) { stmts.push({ kind: 'remove_global_var', name: m[1] }); continue; }
        m = line.match(/^debug_log = "(.*)"$/);
        if (m) { stmts.push({ kind: 'debug_log', text: m[1] }); continue; }
        if (line === 'send_interface_message = {') {
            let desc = '';
            let depth = 1;
            i++;
            for (; i < lines.length; i++) {
                const inner = lines[i];
                if (inner === '}') {
                    depth--;
                    if (depth === 0) break;
                }
                if (inner.endsWith('{')) depth++;
                const dm = inner.match(/^desc = "(.*)"$/);
                if (dm) desc = dm[1];
            }
            stmts.push({ kind: 'send_message', desc });
            continue;
        }
        if (line === 'create_artifact = {') {
            let depth = 1;
            i++;
            for (; i < lines.length; i++) {
                const inner = lines[i];
                if (inner === '}') {
                    depth--;
                    if (depth === 0) break;
                }
                if (inner.endsWith('{')) depth++;
            }
            stmts.push({ kind: 'create_artifact' });
            continue;
        }
        throw new Error(`unsupported statement: ${line}`);
    }
    return { stmts, next: i };
}

function parseScript(script: string): Stmt[] {
    const lines = script.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsed = parseBlock(lines, 0);
    if (parsed.next !== lines.length) {
        throw new Error(`trailing unparsed lines starting at ${parsed.next}: ${lines[parsed.next]}`);
    }
    return parsed.stmts;
}

function evalCond(cond: Cond, state: MockCk3): boolean {
    switch (cond.kind) {
        case 'exists_scope':
            return cond.name === 'votc_battle_report_player' ? state.reportPlayerExists : false;
        case 'exists_global_var':
            return state.globalVars.has(cond.name);
        case 'global_var_eq':
            return state.globalVars.get(cond.name) === cond.value;
        case 'has_variable':
            return state.playerVars.has(cond.name);
        case 'var_eq':
            return state.playerVars.get(cond.name) === cond.value;
        case 'var_gt': {
            const actual = state.playerVars.get(cond.name);
            return actual !== undefined && actual > cond.value;
        }
        case 'scope':
            return cond.name === 'votc_battle_report_player'
                && state.reportPlayerExists
                && cond.conds.every(child => evalCond(child, state));
    }
}

function execStmts(stmts: Stmt[], state: MockCk3): void {
    for (const stmt of stmts) {
        switch (stmt.kind) {
            case 'if': {
                for (const branch of stmt.branches) {
                    if (branch.conds === null || branch.conds.every(c => evalCond(c, state))) {
                        execStmts(branch.body, state);
                        break;
                    }
                }
                break;
            }
            case 'scope':
                if (stmt.name === 'votc_battle_report_player' && !state.reportPlayerExists) {
                    break;
                }
                execStmts(stmt.body, state);
                break;
            case 'set_var':
                state.playerVars.set(stmt.name, stmt.value);
                break;
            case 'remove_var':
                state.playerVars.delete(stmt.name);
                break;
            case 'remove_global_var':
                state.globalVars.delete(stmt.name);
                break;
            case 'debug_log':
                state.logs.push(stmt.text);
                break;
            case 'send_message':
                state.messages.push(stmt.desc);
                break;
            case 'create_artifact':
                state.artifacts++;
                break;
        }
    }
}

function runScript(script: string, state: MockCk3): void {
    execStmts(parseScript(script), state);
}

function makeState(overrides: {
    reportPlayerExists?: boolean;
    playerVars?: Record<string, number>;
    globalVars?: string[];
    globalValues?: Record<string, number>;
} = {}): MockCk3 {
    return {
        reportPlayerExists: overrides.reportPlayerExists ?? true,
        playerVars: new Map(Object.entries(overrides.playerVars ?? {})),
        globalVars: new Map<string, number | true>([
            ...(overrides.globalVars ?? []).map(name => [name, true] as const),
            ...Object.entries(overrides.globalValues ?? {}).map(([name, value]) => [name, value] as const)
        ]),
        logs: [],
        messages: [],
        artifacts: 0
    };
}

const COMMIT: BattleCommitTarget = {
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
};

function buildScript(commit: BattleCommitTarget | undefined, attemptId = 'attempt-1', slotNumber = '1'): string {
    return buildBattleReportRunScript({
        slotNumber,
        attemptId,
        playerId: 'player-1',
        escapedReport: 'report text',
        commit
    });
}

function matchingState(): MockCk3 {
    return makeState({
        playerVars: {
            votc_checkpoint_epoch: 6,
            votc_checkpoint_token: 222,
            votc_timeline_node_a: 11,
            votc_timeline_node_b: 22
        },
        globalVars: ['votc_battle_report_1']
    });
}

function resultCodes(state: MockCk3): string[] {
    return state.logs
        .filter(l => l.startsWith('VOTC:TIMELINE/;/commit_result/;/'))
        .map(l => l.split('/;/')[3]);
}

describe('buildBattleReportRunScript structure', () => {
    it('never writes epoch/token absolutely and never removes the pending token', () => {
        const script = buildScript(COMMIT);
        expect(script).not.toContain('set_variable = { name = votc_checkpoint_epoch');
        expect(script).not.toContain('set_variable = { name = votc_checkpoint_token');
        expect(script).not.toContain('votc_checkpoint_pending_token');
        expect(script).not.toContain('set_variable = { name = votc_checkpoint_day');
    });

    it('emits every result code with the attempt id', () => {
        const script = buildScript(COMMIT);
        for (const code of ['applied', 'already_applied', 'skipped_advanced', 'skip_delivery_mismatch', 'ambiguous_node', 'ambiguous_state']) {
            expect(script).toContain(`VOTC:TIMELINE/;/commit_result/;/attempt-1/;/${code}`);
        }
    });

    it('emits a commit attempt line with identity and target state when delivery matches', () => {
        const script = buildScript(COMMIT);
        expect(script).toContain(
            'debug_log = "VOTC:TIMELINE/;/commit/;/attempt-1/;/2/;/1/;/player-1/;/battle/;/1/;/0/;/6/;/101/;/202/;/11/;/22"'
        );
    });

    it('emits full commit_result lines with observed, graph parent, target and live ck3 state', () => {
        const script = buildScript(COMMIT);
        const expectedPrefix = 'VOTC:TIMELINE/;/commit_result/;/attempt-1/;/applied/;/2/;/1/;/player-1/;/battle/;/1/;/0/;/5/;/11/;/22/;/1/;/2/;/111/;/11/;/22/;/6/;/101/;/202';
        const ck3Suffix = [
            "[THIS.Var('votc_checkpoint_epoch').GetValue|0]",
            "[THIS.Var('votc_timeline_node_a').GetValue|0]",
            "[THIS.Var('votc_timeline_node_b').GetValue|0]",
            "[THIS.Var('votc_timeline_parent_a').GetValue|0]",
            "[THIS.Var('votc_timeline_parent_b').GetValue|0]",
            "[THIS.Var('votc_checkpoint_token').GetValue|0]"
        ].join('/;/');
        expect(script).toContain(`debug_log = "${expectedPrefix}/;/${ck3Suffix}"`);
    });

    it('reads live ck3 state through GetPlayer outside the player scope', () => {
        const script = buildScript(COMMIT);
        expect(script).toContain(
            "VOTC:TIMELINE/;/commit_result/;/attempt-1/;/skip_delivery_mismatch/;/2/;/1/;/player-1/;/battle/;/1/;/0/;/5/;/11/;/22/;/1/;/2/;/111/;/11/;/22/;/6/;/101/;/202/;/[GetPlayer.MakeScope.Var('votc_checkpoint_epoch').GetValue|0]"
        );
    });

    it('embeds the observed and target node pairs plus the graph parent', () => {
        const script = buildScript(COMMIT);
        expect(script).toContain('var:votc_timeline_node_a = 11');
        expect(script).toContain('var:votc_timeline_node_b = 22');
        expect(script).toContain('set_variable = { name = votc_timeline_node_a value = 101 }');
        expect(script).toContain('set_variable = { name = votc_timeline_node_b value = 202 }');
        expect(script).toContain('set_variable = { name = votc_timeline_parent_a value = 11 }');
        expect(script).toContain('set_variable = { name = votc_timeline_parent_b value = 22 }');
        expect(script).toContain('set_variable = { name = votc_timeline_schema value = 1 }');
    });

    it('omits the token check when no transition token is known', () => {
        const script = buildScript({ ...COMMIT, transitionToken: undefined });
        expect(script).not.toContain('var:votc_checkpoint_token');
        expect(script).toContain('var:votc_checkpoint_epoch = 6');
    });

    it('sanitizes a malicious deliveryId so it cannot break the debug_log or script structure', () => {
        const script = buildBattleReportRunScript({
            slotNumber: '1',
            attemptId: 'attempt-1',
            playerId: 'player-1',
            escapedReport: 'report text',
            commit: { ...COMMIT, deliveryId: '1/;/injected' }
        });
        expect(script).not.toContain('injected');
        const appliedLine = script.split('\n').find(line => line.includes('commit_result') && line.includes('applied'));
        expect(appliedLine).toBeDefined();
        // A full commit_result line has at least 25 fields (24 separators after the marker/type).
        expect(appliedLine!.split('/;/').length).toBeGreaterThanOrEqual(25);
        expect(appliedLine).toContain('/;/1/;/');
    });

    it('parses cleanly with the test interpreter', () => {
        expect(() => parseScript(buildScript(COMMIT))).not.toThrow();
        expect(() => parseScript(buildScript(undefined))).not.toThrow();
    });

    it('does not depend on the transient battle-event saved player scope', () => {
        expect(buildScript(COMMIT)).not.toContain('scope:votc_battle_report_player');
    });
});

describe('guarded battle commit execution', () => {
    it('applies the target node when epoch/token match and CK3 is still at the observed node', () => {
        const state = matchingState();
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['applied']);
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(101);
        expect(state.playerVars.get('votc_timeline_node_b')).toBe(202);
        expect(state.playerVars.get('votc_timeline_parent_a')).toBe(11);
        expect(state.playerVars.get('votc_timeline_parent_b')).toBe(22);
        expect(state.playerVars.get('votc_timeline_schema')).toBe(1);
        expect(state.playerVars.get('votc_checkpoint_epoch')).toBe(6);
        expect(state.messages).toEqual(['report text']);
        expect(state.artifacts).toBe(1);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });

    it('reports already_applied without rewriting when CK3 already holds the target node', () => {
        const state = matchingState();
        state.playerVars.set('votc_timeline_node_a', 101);
        state.playerVars.set('votc_timeline_node_b', 202);
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['already_applied']);
        expect(state.playerVars.get('votc_timeline_parent_a')).toBeUndefined();
        expect(state.messages).toEqual(['report text']);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });

    it('reports ambiguous_node without touching the checkpoint when the node is unexpected', () => {
        const state = matchingState();
        state.playerVars.set('votc_timeline_node_a', 555);
        state.playerVars.set('votc_timeline_node_b', 666);
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['ambiguous_node']);
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(555);
        expect(state.playerVars.get('votc_timeline_parent_a')).toBeUndefined();
        expect(state.messages).toEqual(['report text']);
    });

    it('reports skipped_advanced without touching the checkpoint when the epoch moved on', () => {
        const state = matchingState();
        state.playerVars.set('votc_checkpoint_epoch', 7);
        state.playerVars.set('votc_checkpoint_token', 333);
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['skipped_advanced']);
        expect(state.playerVars.get('votc_checkpoint_epoch')).toBe(7);
        expect(state.playerVars.get('votc_checkpoint_token')).toBe(333);
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(11);
        expect(state.messages).toEqual(['report text']);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });

    it('reports ambiguous_state without display or cleanup when the epoch regressed', () => {
        const state = matchingState();
        state.playerVars.set('votc_checkpoint_epoch', 5);
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['ambiguous_state']);
        expect(state.messages).toEqual([]);
        expect(state.artifacts).toBe(0);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(true);
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(11);
    });

    it('reports ambiguous_state when the epoch matches but the token belongs to another branch', () => {
        const state = matchingState();
        state.playerVars.set('votc_checkpoint_token', 999);
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['ambiguous_state']);
        expect(state.messages).toEqual([]);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(true);
    });

    it('reports skipped_delivery_mismatch without display or cleanup when the slot flag is gone', () => {
        const state = matchingState();
        state.globalVars.delete('votc_battle_report_1');
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['skip_delivery_mismatch']);
        expect(state.messages).toEqual([]);
        expect(state.artifacts).toBe(0);
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(11);
    });

    it('runs against the console player even after the transient battle scope is gone', () => {
        const state = matchingState();
        state.reportPlayerExists = false;
        runScript(buildScript(COMMIT), state);
        expect(resultCodes(state)).toEqual(['applied']);
        expect(state.messages).toEqual(['report text']);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });
});

describe('two battle reports committed out of order', () => {
    const OBSERVED_NODE = { a: 11, b: 22 };
    const OBSERVED_PARENT = { a: 1, b: 2 };

    function buildBattleChain() {
        const registry = new TimelineRegistry('1001', {
            version: 1,
            playerId: '1001',
            nodes: {
                '1-2': { parentId: null, epoch: 4, source: 'battle', eventKey: 'battle:origin', createdAt: '2026-07-01T00:00:00Z' },
                '11-22': { parentId: '1-2', epoch: 5, source: 'battle', eventKey: 'battle:observed', createdAt: '2026-07-01T01:00:00Z' }
            }
        });
        const contextB = resolveTimelineContext(
            registry,
            buildTimelineContextFromParts('1001', OBSERVED_NODE.a, OBSERVED_NODE.b, OBSERVED_PARENT.a, OBSERVED_PARENT.b, 5, 111, 222)
        );
        const nodeB = createChildNodeAndScript(registry, contextB, 'battle', 'battle:B', 6, 'votc_battle_report_player');
        const contextC = resolveTimelineContext(
            registry,
            buildTimelineContextFromParts('1001', OBSERVED_NODE.a, OBSERVED_NODE.b, OBSERVED_PARENT.a, OBSERVED_PARENT.b, 6, 222, 333)
        );
        const nodeC = createChildNodeAndScript(registry, contextC, 'battle', 'battle:C', 7, 'votc_battle_report_player');
        return { registry, nodeB, nodeC };
    }

    function commitOf(nodeId: string, parentId: string | null, targetEpoch: number, transitionToken: number): BattleCommitTarget {
        const [na, nb] = nodeId.split('-').map(Number);
        const [pa, pb] = (parentId ?? '0-0').split('-').map(Number);
        return {
            targetEpoch,
            transitionToken,
            observedNodeA: OBSERVED_NODE.a,
            observedNodeB: OBSERVED_NODE.b,
            targetNodeA: na,
            targetNodeB: nb,
            graphParentA: pa,
            graphParentB: pb
        };
    }

    function ck3AfterBothBumps(): MockCk3 {
        return makeState({
            playerVars: {
                votc_checkpoint_epoch: 7,
                votc_checkpoint_token: 333,
                votc_timeline_node_a: OBSERVED_NODE.a,
                votc_timeline_node_b: OBSERVED_NODE.b
            },
            globalVars: ['votc_battle_report_1', 'votc_battle_report_2']
        });
    }

    it('resolver chains C onto B through the checkpoint token', () => {
        const { nodeB, nodeC } = buildBattleChain();
        expect(nodeB.parentId).toBe('11-22');
        expect(nodeC.parentId).toBe(nodeB.nodeId);
        expect(nodeC.context.checkpointEpoch).toBe(7);
        expect(nodeC.context.checkpointToken).toBe(333);
    });

    it.each([
        ['C then B', ['C', 'B']],
        ['B then C', ['B', 'C']]
    ])('%s: epoch never regresses and the current node never rolls back', (_label, order) => {
        const { nodeB, nodeC } = buildBattleChain();
        const scripts: Record<string, string> = {
            B: buildBattleReportRunScript({
                slotNumber: '1',
                attemptId: 'attempt-B',
                playerId: 'player-1',
                escapedReport: 'report B',
                commit: commitOf(nodeB.nodeId, nodeB.parentId, 6, 222)
            }),
            C: buildBattleReportRunScript({
                slotNumber: '2',
                attemptId: 'attempt-C',
                playerId: 'player-1',
                escapedReport: 'report C',
                commit: commitOf(nodeC.nodeId, nodeC.parentId, 7, 333)
            })
        };
        const state = ck3AfterBothBumps();
        for (const key of order) {
            runScript(scripts[key], state);
            expect(state.playerVars.get('votc_checkpoint_epoch')).toBe(7);
        }
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(Number(nodeC.nodeId.split('-')[0]));
        expect(state.playerVars.get('votc_timeline_node_b')).toBe(Number(nodeC.nodeId.split('-')[1]));
        expect(state.playerVars.get('votc_timeline_parent_a')).toBe(Number(nodeB.nodeId.split('-')[0]));
        expect(state.playerVars.get('votc_timeline_parent_b')).toBe(Number(nodeB.nodeId.split('-')[1]));
        expect(state.playerVars.get('votc_timeline_schema')).toBe(1);
        expect(state.messages).toEqual(order.map(key => `report ${key}`));
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
        expect(state.globalVars.has('votc_battle_report_2')).toBe(false);
        expect(resultCodes(state)).toEqual(order.map(key => (key === 'C' ? 'applied' : 'skipped_advanced')));
    });

    it('C commits from the observed CK3 node even while B was never written back', () => {
        const { nodeB, nodeC } = buildBattleChain();
        const state = ck3AfterBothBumps();
        runScript(buildBattleReportRunScript({
            slotNumber: '2',
            attemptId: 'attempt-C',
            playerId: 'player-1',
            escapedReport: 'report C',
            commit: commitOf(nodeC.nodeId, nodeC.parentId, 7, 333)
        }), state);
        expect(resultCodes(state)).toEqual(['applied']);
        expect(state.playerVars.get('votc_timeline_parent_a')).toBe(Number(nodeB.nodeId.split('-')[0]));
    });
});

describe('legacy run script without commit data', () => {
    it('keeps the unguarded display and cleanup without a commit result', () => {
        const state = makeState({ globalVars: ['votc_battle_report_1'] });
        const script = buildScript(undefined);
        expect(script).not.toContain('commit_result');
        runScript(script, state);
        expect(state.messages).toEqual(['report text']);
        expect(state.artifacts).toBe(1);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });

    it('guards delivery-only fallback reports when the mod supplied a delivery id', () => {
        const script = buildBattleReportRunScript({
            slotNumber: '1',
            attemptId: 'fallback-attempt',
            playerId: 'player-1',
            escapedReport: 'report text',
            battleDeliveryId: 12345
        });
        const matching = makeState({
            globalVars: ['votc_battle_report_1'],
            globalValues: { votc_battle_report_1_delivery_id: 12345 }
        });
        runScript(script, matching);
        expect(matching.messages).toEqual(['report text']);
        expect(matching.globalVars.has('votc_battle_report_1')).toBe(false);

        const mismatched = makeState({
            globalVars: ['votc_battle_report_1'],
            globalValues: { votc_battle_report_1_delivery_id: 99999 }
        });
        runScript(script, mismatched);
        expect(mismatched.messages).toEqual([]);
        expect(mismatched.globalVars.has('votc_battle_report_1')).toBe(true);
        expect(mismatched.logs).toContain(
            'VOTC:BATTLE_REPORT/;/skip_delivery_mismatch/;/fallback-attempt/;/1/;/12345'
        );
    });
});

describe('§10.1 battle delivery id arrival guard', () => {
    function buildScriptWithDeliveryId(battleDeliveryId: number | undefined, slotNumber = '1'): string {
        return buildBattleReportRunScript({
            slotNumber,
            attemptId: 'attempt-1',
            playerId: 'player-1',
            escapedReport: 'report text',
            commit: COMMIT,
            battleDeliveryId
        });
    }

    function matchingStateWithDeliveryId(deliveryId: number): MockCk3 {
        return makeState({
            playerVars: {
                votc_checkpoint_epoch: 6,
                votc_checkpoint_token: 222,
                votc_timeline_node_a: 11,
                votc_timeline_node_b: 22
            },
            globalVars: ['votc_battle_report_1'],
            globalValues: { votc_battle_report_1_delivery_id: deliveryId }
        });
    }

    it('script embeds the delivery id guard when battleDeliveryId is provided', () => {
        const script = buildScriptWithDeliveryId(12345);
        expect(script).toContain('exists = global_var:votc_battle_report_1_delivery_id');
        expect(script).toContain('global_var:votc_battle_report_1_delivery_id = 12345');
    });

    it('script omits the delivery id guard when battleDeliveryId is undefined (legacy mod)', () => {
        const script = buildScriptWithDeliveryId(undefined);
        // The global delivery guard is omitted for legacy mods.
        expect(script).not.toContain('exists = global_var:votc_battle_report_1_delivery_id');
        expect(script).not.toContain('global_var:votc_battle_report_1_delivery_id = ');
    });

    it('applies when delivery id matches the in-save variable', () => {
        const state = matchingStateWithDeliveryId(12345);
        runScript(buildScriptWithDeliveryId(12345), state);
        expect(resultCodes(state)).toEqual(['applied']);
        expect(state.messages).toEqual(['report text']);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });

    it('reports skipped_delivery_mismatch and does NOT clean up when delivery id differs', () => {
        // The in-save slot now holds a newer battle's delivery id (99999),
        // while this stale arrival is for the prior battle (12345). The guard
        // must refuse display, refuse node writes, and refuse slot cleanup
        // so the newer slot's state is preserved.
        const state = matchingStateWithDeliveryId(99999);
        runScript(buildScriptWithDeliveryId(12345), state);
        expect(resultCodes(state)).toEqual(['skip_delivery_mismatch']);
        expect(state.messages).toEqual([]);
        expect(state.artifacts).toBe(0);
        // Slot flag and delivery id global are NOT cleaned up
        expect(state.globalVars.has('votc_battle_report_1')).toBe(true);
        expect(state.globalVars.get('votc_battle_report_1_delivery_id')).toBe(99999);
        // CK3 checkpoint/node untouched
        expect(state.playerVars.get('votc_timeline_node_a')).toBe(11);
    });

    it('reports skipped_delivery_mismatch when the delivery id variable is missing', () => {
        const state = matchingState();
        runScript(buildScriptWithDeliveryId(12345), state);
        expect(resultCodes(state)).toEqual(['skip_delivery_mismatch']);
        expect(state.messages).toEqual([]);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(true);
    });

    it('reports already_applied when delivery id matches but CK3 already holds the target node', () => {
        // §10.1: the delivery-id guard must not block legitimate already-applied
        // arrivals. When the delivery id matches the in-save variable but the
        // node is already at the target (e.g. the run script was replayed after
        // a successful apply), the inner if-chain should still reach the
        // already_applied branch - the guard only rejects stale arrivals whose
        // delivery id no longer matches.
        const state = matchingStateWithDeliveryId(12345);
        state.playerVars.set('votc_timeline_node_a', 101);
        state.playerVars.set('votc_timeline_node_b', 202);
        runScript(buildScriptWithDeliveryId(12345), state);
        expect(resultCodes(state)).toEqual(['already_applied']);
        expect(state.playerVars.get('votc_timeline_parent_a')).toBeUndefined();
        expect(state.messages).toEqual(['report text']);
        expect(state.globalVars.has('votc_battle_report_1')).toBe(false);
    });
});
