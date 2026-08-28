/**
 * Builders for the CK3 console run payload written to `run/letters.txt`.
 *
 * `letters.txt` is polled every ~2 seconds by the mod-side letters_runner
 * widget (`gui/custom_gui/letters_runner.gui` in voices_of_the_court_mod2 ce),
 * which is the ONLY letters execution point in mod2 ce: the 1.x per-slot
 * `event_window_widget_message_N.gui` runners (which executed `letterN.txt`
 * on the reply event window) were never ported, so `letterN.txt` files would
 * never run here. Both the reply delivery and the generation-failure
 * fallback therefore share the `letters.txt` channel.
 *
 * Guard semantics (fail-closed, console-run context where root IS the
 * player):
 *
 *   - Outer thread guard `exists = global_var:votc_letter_N`: the slot marker
 *     is set by message_event.360 when the player sends the letter and removed
 *     on delivery/fallback. A payload whose thread is gone (already consumed,
 *     cleared by the clear-threads decision, or a rolled-back save) lands in
 *     the `run_skipped` else branch and touches nothing. This also makes the
 *     2s poll repeat inert after the first execution (no duplicate artifacts
 *     or repeated message_event.362 triggers).
 *   - Timeline guard `var:votc_checkpoint_epoch = <target>` (+ token when the
 *     mod preallocated one): the mod bumps the checkpoint at send time, so
 *     the save must still sit at the target epoch/token when the reply is
 *     delivered. The writes themselves are absolute value sets produced by
 *     buildCheckpointSetEffect, so a replay applies the same values again
 *     instead of double-bumping. If the save has advanced past the target
 *     (another transition ran during the travel days), the timeline write is
 *     skipped (`timeline_skipped_advanced`) instead of regressing the save
 *     onto a stale sibling branch; delivery still proceeds.
 */

export interface LetterTimelineBlockInput {
    /** Slot number '1'..'9' (subject 'letter_N'). */
    letterNumber: string;
    /**
     * Synthetic delivery id (the sending game day, letter.totalDays). mod2 ce
     * emits no per-delivery ids; this value is diagnostic-only and never
     * matched against in-save state.
     */
    deliveryId: number;
    /** The post-bump epoch the save must still be at for the write to apply. */
    targetEpoch: number;
    /**
     * The checkpoint token the mod promoted at bump time. The token guard is
     * only emitted for a positive integer token (mirrors
     * isValidCheckpointToken in timelineManager.ts); legacy snapshots without
     * a pending token fall back to the epoch-only guard.
     */
    checkpointToken?: number;
    /** buildCheckpointSetEffect output: absolute set_variable writes. */
    script: string;
}

function indentCk3Block(block: string, indent: string): string {
    return block
        .split(/\r?\n/)
        .map(line => line ? `${indent}${line}` : line)
        .join('\n');
}

function isUsableCheckpointToken(token: number | undefined): token is number {
    return typeof token === 'number' && Number.isInteger(token) && token > 0;
}

/**
 * The guarded timeline commit block shared by the delivery and fallback
 * payloads. Never blocks delivery: every branch only logs and (on match)
 * applies the absolute node/epoch/token sets.
 */
export function buildLetterTimelineBlock(input: LetterTimelineBlockInput): string {
    const limitLines = [`\t\tvar:votc_checkpoint_epoch = ${input.targetEpoch}`];
    if (isUsableCheckpointToken(input.checkpointToken)) {
        limitLines.push(`\t\tvar:votc_checkpoint_token = ${input.checkpointToken}`);
    }
    return [
        'if = {',
        '\tlimit = {',
        ...limitLines,
        '\t}',
        indentCk3Block(input.script, '\t'),
        `\tdebug_log = "VOTC:LETTER/;/timeline_applied/;/letter_${input.letterNumber}/;/${input.deliveryId}"`,
        '}',
        'else_if = {',
        '\tlimit = {',
        `\t\tvar:votc_checkpoint_epoch > ${input.targetEpoch}`,
        '\t}',
        `\tdebug_log = "VOTC:LETTER/;/timeline_skipped_advanced/;/letter_${input.letterNumber}/;/${input.deliveryId}"`,
        '}',
        'else = {',
        `\tdebug_log = "VOTC:LETTER/;/timeline_skipped_mismatch/;/letter_${input.letterNumber}/;/${input.deliveryId}"`,
        '}'
    ].join('\n');
}

export interface LetterDeliveryPayloadInput {
    letterNumber: string;
    deliveryId: number;
    /** Reply text with `\` and `"` already escaped for CK3 script. */
    escapedReply: string;
    /** Guarded timeline block from buildLetterTimelineBlock, when the reply carries one. */
    timelineBlock?: string;
}

/**
 * Full letters.txt payload for a successful reply delivery on a timeline slot
 * ('letter_1'..'letter_9'). Same effects as the pre-guard payload (clear the
 * thread, create the journal artifact, trigger message_event.362 so the mod
 * copies VOTC:LETTER_ACCEPTED to the clipboard), but everything now sits
 * behind the thread guard so poll repeats and stale payloads are inert.
 */
export function buildLetterDeliveryPayload(input: LetterDeliveryPayloadInput): string {
    const n = input.letterNumber;
    const timeline = input.timelineBlock ? `${indentCk3Block(input.timelineBlock, '\t')}\n` : '';
    return `debug_log = "[Localize('talk_event.9999.desc')]"
if = {
\tlimit = { exists = global_var:votc_letter_${n} }
${timeline}\tremove_global_variable ?= votc_letter_${n}
\tcreate_artifact = {
\t\tname = votc_huixin_title${n}
\t\tdescription = "${input.escapedReply}"
\t\ttype = journal
\t\tvisuals = scroll
\t\tcreator = global_var:message_second_scope_letter_${n}
\t\tmodifier = artifact_monthly_minor_prestige_1_modifier
\t\twealth = scope:wealth
\t\tsave_scope_as = votc_latest_letter
\t}
\tif = {
\t\tlimit = { exists = scope:votc_latest_letter }
\t\tscope:votc_latest_letter = {
\t\t\tset_variable = { name = votc_letter_artifact value = yes}
\t\t}
\t\tset_global_variable = {
\t\t\tname = votc_latest_letter
\t\t\tvalue = scope:votc_latest_letter
\t\t}
\t}
\ttrigger_event = message_event.362
}
else = {
\tdebug_log = "VOTC:LETTER/;/run_skipped/;/letter_${n}/;/${input.deliveryId}"
}
`;
}

/**
 * Legacy delivery payload for letters outside the 'letter_1'..'letter_9'
 * thread scheme. Byte-identical to the pre-guard deliverLetter output.
 */
export function buildLegacyLetterDeliveryPayload(letterId: string, escapedReply: string): string {
    return `debug_log = "[Localize('talk_event.9999.desc')]"
remove_global_variable ?= votc_${letterId}
create_artifact = {
\tname = votc_huixin_title${letterId.replace(/letter_/, "")}
\tdescription = "${escapedReply}"
\ttype = journal
\tvisuals = scroll
\tcreator = global_var:message_second_scope_${letterId}
\tmodifier = artifact_monthly_minor_prestige_1_modifier
\twealth = scope:wealth
\tsave_scope_as = votc_latest_letter
}
if = {
\tlimit = { exists = scope:votc_latest_letter }
\tscope:votc_latest_letter = {
\t\tset_variable = { name = votc_letter_artifact value = yes}
\t}
\tset_global_variable = {
\t\tname = votc_latest_letter
\t\tvalue = scope:votc_latest_letter
\t}
}
trigger_event = message_event.362`;
}

export interface LetterFallbackPayloadInput {
    letterNumber: string;
    deliveryId: number;
    /** Guarded timeline block from buildLetterTimelineBlock, when the transition produced one. */
    timelineBlock?: string;
}

/**
 * Full letters.txt payload drained when the app cannot produce a reply:
 * applies the journal-created timeline node (guarded), shows the fallback
 * popup and clears the stuck thread. Poll repeats after the first execution
 * hit the run_skipped else branch because the thread marker is gone.
 */
export function buildLetterFallbackPayload(input: LetterFallbackPayloadInput): string {
    const n = input.letterNumber;
    const timeline = input.timelineBlock ? `${indentCk3Block(input.timelineBlock, '\t')}\n` : '';
    return `debug_log = "[Localize('talk_event.9999.desc')]"
if = {
\tlimit = { exists = global_var:votc_letter_${n} }
${timeline}\tsend_interface_message = {
\t\ttype = votc_message_popup
\t\ttitle = votc_huixin_title${n}
\t\tdesc = votc_letter_reply_fallback_desc
\t\tleft_icon = global_var:message_second_scope_letter_${n}
\t}
\tremove_global_variable ?= votc_letter_${n}
}
else = {
\tdebug_log = "VOTC:LETTER/;/run_skipped/;/letter_${n}/;/${input.deliveryId}"
}
`;
}
