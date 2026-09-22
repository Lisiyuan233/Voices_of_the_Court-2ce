## Proposed 2CE contribution roadmap

This is the proposed sequence for bringing the remaining work from my 2CE fork into this repository. **#15 is the first step; the later items are planned follow-up PRs, not features already enabled by this PR.** The P0/P1/etc. labels identify the original work packages, not their review priority.

### Updated merge requirements (20 September 2026)

Following the maintainer's feedback, **backward compatibility is a prerequisite for merging #15**. It is no longer deferred wholesale to a later history PR. This is an outstanding requirement, not a claim that compatibility is already complete.

Before merge, the plan is to:

- Fix the Prompts-tab initialization error and verify that existing prompt presets can still be loaded, edited, saved, and reopened.
- Validate existing conversations, summaries/memories, diaries, and letter history with representative pre-update user data, including restarting the app and loading older saves.
- Preserve original data and customizations. Where a legacy record cannot be assigned safely to a campaign or branch, retain it and provide an explicit recovery or import path rather than silently dropping it or assigning it to another campaign.
- Implement the necessary compatibility fixes in #15, add regression coverage, and complete in-game upgrade checks before requesting merge. Further history features can remain follow-ups once existing data remains usable.

### Scope of #15 — extended game data (P0) and timeline v2 (P6)

- Parse additional character and realm facts, including stress, legitimacy, finances, military resources, laws, modifiers, and known secrets, and expose them to character-description prompts.
- Establish campaign identity, checkpoint and timeline-node tracking, conversation-close transitions, and timeline-based record visibility.
- Integrate the existing letter-reply path with timeline transitions, including safeguards against delayed replies rewinding the timeline and fallback handling when generation or persistence fails.
- Keep the existing conversation-close game events and upstream behaviour.

There are two scope boundaries worth calling out:

- The battle-report modules are present, but the battle-report flow is **not wired into the app entry point**. Completing that integration belongs to a separate PR.
- Further campaign-scoped storage and history/diary features remain follow-ups, but any part required to preserve existing data must be brought forward into #15. The broader incoming-letter generation port is also a follow-up.

### Planned follow-up PRs

| Work package | Intended scope | Order / dependency |
| --- | --- | --- |
| **Incoming letters (P1)** | Port the incoming-letter generation flow and its prompt/configuration support, adapting it to the letter implementation already in upstream. Include the corresponding UI text and prompt translations. | After #15 is merged; depends on the timeline foundation. |
| **Letter delivery safeguards** | Bring over the additional delivery-gate work around campaign identity, save/load branches, and pending deliveries. This is still local work in progress. | After the P1 port, as a separate increment or clearly separated commits. |
| **Letter run-file channel hardening** | Fix the stale `run/letters.txt` re-trigger. The mod-side letters_runner executes the file unconditionally whenever it is created (every write-letter interaction) and pauses while a conversation holds `talk_scene`; the app clears the file only on `VOTC:LETTER_ACCEPTED`. Any missed confirmation (delivery during a conversation, timeout, app restart) leaves the old reply in the folder, and the next letter written in game fires it again. The file's first line is also the app's date heartbeat (the runner re-executes it every ~2s and the app reads `VOTC:DATE/<totalDays>` from it), so "clearing" must restore the placeholder — emptying the file freezes date tracking and pending replies never reach their delivery day. Fix: reset to the placeholder at app startup and on delivery timeout, keep the heartbeat as line 1 of every payload, and defer scheduled deliveries while a conversation is active. Root cause is upstream 2CE behaviour; the campaign re-delivery of old unstamped replies in #15 makes it much easier to hit. The mod runner itself needs no change; the first fixes also apply to upstream. | With the letter delivery safeguards, or as a clearly separated commit after them. |
| **Court Chronicle (P2)** | Add the chronicle source collection, generation and storage pipeline, its window and settings, and integration with conversation and letter observations. | After P1; depends on shared identity/timeline metadata. |
| **Military snapshots (P3)** | Parse structured war, army, regiment, siege, and participant data; build a bounded military briefing for prompts. Carry over any shared battle-report type/formatter changes needed here. | After the chronicle work in the proposed main sequence; before battle-report integration. |
| **Save-derived facts (P5)** | Add the Rust save-parser sidecar and app-side snapshot acquisition, identity validation, fact selection, and prompt integration. Preserve the experimental, disabled-by-default behaviour. | After P3 in the proposed main sequence. The standalone Rust component can be reviewed separately ahead of app integration. |
| **Battle reports** | Wire the existing modules into the app: war-event handling, snapshot attachment, the real token encoder, report UI/settings navigation, and localized prompts. | A separate PR after P3; its exact position relative to P5 can be adjusted during review. |
| **History, checkpoints, and diary entries** | Complete the remaining history/diary features after the compatibility work required for #15. Any routing or filtering fix needed to keep existing records usable belongs in #15. The small BOM fix for generated run scripts can be submitted separately. | Additional features follow the main sequence; backward compatibility blocks #15 itself. |

The main dependency sequence is **P0 → P6 → P1 → P2 → P3 → P5 → history**, with delivery safeguards following P1 and battle reports following P3. Review fixes will accompany the feature they belong to.

### Matching CK3 mod PRs

The mod-side changes will be split into feature PRs against [szmania/voices_of_the_court_mod](https://github.com/szmania/voices_of_the_court_mod), alongside the app PRs:

1. Extended game-data output and the campaign/timeline/checkpoint protocol needed by #15, including the upgrade behaviour required for compatibility.
2. Incoming-letter events and the corresponding delivery/fallback protocol.
3. Court Chronicle triggers, data output, and UI.
4. Military snapshots and council data output.
5. Save-snapshot protocol support for save-derived facts.
6. Battle-report triggers and delivery, after the military work.
7. Any remaining history/diary integration required by the corresponding app follow-ups.

These are planned boundaries, subject to dependency review; the mod PRs have not been opened yet. Each cross-repository feature will link its matching app/mod PRs, state the required revisions, and provide a focused test package/checklist. The broad development archive already posted is not the proposed scope of a single mod PR.

### How I plan to keep the PRs reviewable

- Base each follow-up on the updated upstream `main` after its prerequisites merge, and port the relevant functionality while preserving original authorship.
- Preserve upstream refactors, API changes, and existing behaviour when adapting the fork's changes.
- Keep repository-wide line-ending normalization, internal planning files, and replacement test infrastructure out of the feature PRs. Preserve surrounding file formatting.
- Keep app and CK3 mod changes explicitly paired. Cross-repository contract checks need to run with both repositories available; the app repository's standalone test suite must not depend on a local checkout of the mod.
- Update localized UI strings and prompts with the relevant feature, and document any remaining language fallbacks.
- Include a build check, focused regression tests, and a comparison against the current upstream test baseline. Any existing failures should be reported separately from regressions introduced by the PR.
- Provide a matching mod revision/package and concrete in-game checks for each feature that crosses the app/mod boundary.

For #15, the build and regression results are recorded in the PR description and the [existing test instructions](https://github.com/szmania/Voices_of_the_Court/pull/15#issuecomment-5741869712). In-game review is still ongoing; those automated results do not establish that the whole app/mod flow is bug-free.

The mod test archive contains work from the broader 2CE development line, including battle-related scripts. Its contents therefore extend beyond the app functionality enabled by #15. The later PRs above describe the intended integration boundaries.

This is a proposed review sequence rather than a request to accept the entire fork at once. Scope and ordering can be adjusted around upstream priorities.

