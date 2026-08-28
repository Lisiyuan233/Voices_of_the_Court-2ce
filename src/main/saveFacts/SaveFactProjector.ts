/**
 * Save-fact prompt projector (implementation plan Task 15, entry point).
 *
 * `project(context, query)` is the single deterministic path from a
 * `ConversationFactContext` plus a `FactQuery` to an escaped, budgeted
 * `<game_facts>` prompt block:
 *
 * 1. Gate: a non-`available` context, a disabled prompt feature or a missing
 *    fact index yields a byte-level empty result.
 * 2. Candidates: only facts the predicate registry proves `public` (the
 *    registry is re-evaluated here; a fact merely CLAIMING public visibility
 *    with an unregistered predicate is rejected), in enabled categories.
 * 3. Baseline lane: one-hop public relations between participants plus each
 *    participant's displayable primary title / direct liege.
 * 4. Dynamic lane: facts require a direct relevant endpoint mention in the
 *    latest player text, a topic match, or an explicit purpose rule.
 *    Participant involvement affects ranking only. Baseline fact IDs are
 *    always excluded.
 * 5. Deterministic scoring and ordering (see `saveFactTopics.ts`).
 * 6. Safe fixed-template rendering with per-lane token budgets (see
 *    `saveFactRenderer.ts`).
 *
 * The internal trace records fact IDs, score components, lane, outcome and
 * estimated tokens only — never raw display values — and is never sent to
 * the renderer.
 */

import { saveFactEntityKey } from './SaveFactIndex';
import {
    resolveEntityDisplayName,
    sanitizeDisplayName
} from './SaveFactNameResolver';
import type {
    ResolvedFactNames,
    SaveFactNameResolverContext
} from './SaveFactNameResolver';
import { evaluateFactVisibility } from './SaveFactVisibilityPolicy';
import type { SaveFactSettings } from './saveFactSettings';
import { SAVE_FACT_LIMITS } from './saveFactSettings';
import {
    buildFactAliasMap,
    characterNameVariants,
    combineFactQueryText,
    compareScoredFacts,
    detectFactTopics,
    factSemanticKey,
    findLiveCharacter,
    findLatestPlayerMentionedEntityKeys,
    findMentionedEntityKeys,
    hasDirectRelevantEndpointMention,
    scoreFact
} from './saveFactTopics';
import type { FactAliasSource } from './saveFactTopics';
import { renderFactLine, renderGameFactsBlock, buildGameFactsBlockHeader } from './saveFactRenderer';
import type { SaveFactPromptLanguage } from './saveFactRenderer';
import { SAVE_FACT_CATEGORIES } from './saveFactTypes';
import type {
    ConversationFactContext,
    FactProjectionPurpose,
    FactProjectionResult,
    FactQuery,
    FactSelectionTraceEntry,
    FactTopic,
    GameFact
} from './saveFactTypes';

// P5b deferred (agency/verify/session/delta): 1.x imported countTokensCl100k
// from '../../shared/apiConnection'; 2CE does not export a shared estimator,
// so this local copy mirrors src/shared/apiConnection.ts's cl100k setup.
import { getEncoding, Tiktoken } from 'js-tiktoken';
let cl100kEncoder: Tiktoken | null = null;
export function countTokensCl100k(text: string): number {
    if (cl100kEncoder === null) {
        try {
            cl100kEncoder = getEncoding('cl100k_base');
        } catch {
            return Math.ceil((text || '').length / 4);
        }
    }
    return cl100kEncoder.encode(text).length;
}

/** Per-purpose budget caps (plan Task 15 step 5 defaults, Task 18 step 1). */
const PURPOSE_BUDGET_CAPS: Readonly<Record<FactProjectionPurpose, { baseline: number; dynamic: number }>> = {
    conversation: { baseline: 400, dynamic: 800 },
    self_talk: { baseline: 400, dynamic: 800 },
    ai_to_ai: { baseline: 400, dynamic: 800 },
    // Task 18: scene descriptions get a small public-facts block.
    scene_description: { baseline: 300, dynamic: 300 },
    // Task 18: suggestions stay within 400 tokens and never see private facts.
    suggestion: { baseline: 400, dynamic: 400 },
    battle_report: { baseline: 400, dynamic: 800 }
};

/** Drop reasons recorded in the trace/diagnostics (codes only, never content). */
export const FACT_DROP_NOT_PUBLIC = 'not_public';
export const FACT_DROP_CATEGORY_DISABLED = 'category_disabled';
export const FACT_DROP_NO_SIGNAL = 'no_selection_signal';
export const FACT_DROP_NAME_UNRESOLVED = 'name_unresolved';
export const FACT_DROP_BUDGET = 'budget_exceeded';

export type DynamicAdmissionReason =
    | 'direct_relevant_endpoint_mention'
    | 'topic_match'
    | 'purpose_rule'
    | 'rejected_no_signal';

export interface ShouldAdmitDynamicFactInput {
    purpose: FactProjectionPurpose;
    fact: GameFact;
    latestPlayerMentionedEntityKeys: ReadonlySet<string>;
    participantCharacterIds: ReadonlySet<string>;
    topics: readonly FactTopic[];
}

/**
 * Deterministic dynamic admission. Participant involvement is deliberately
 * absent from the rule: it remains a score component, but cannot open a
 * participant's wider fact neighbourhood by itself.
 */
export function shouldAdmitDynamicFact(
    input: ShouldAdmitDynamicFactInput
): { admitted: boolean; reason: DynamicAdmissionReason } {
    if (hasDirectRelevantEndpointMention(
        input.fact,
        input.latestPlayerMentionedEntityKeys,
        input.participantCharacterIds
    )) {
        return { admitted: true, reason: 'direct_relevant_endpoint_mention' };
    }
    if (input.topics.some(topic => factMatchesTopicForAdmission(input.fact, topic))) {
        return { admitted: true, reason: 'topic_match' };
    }
    if (matchesPurposeSpecificRule(input)) {
        return { admitted: true, reason: 'purpose_rule' };
    }
    return { admitted: false, reason: 'rejected_no_signal' };
}

/** Keep the admission topic mapping explicit and shared with scoring. */
function factMatchesTopicForAdmission(fact: GameFact, topic: FactTopic): boolean {
    switch (topic) {
        case 'family':
            return fact.category === 'family';
        case 'titles':
            return fact.predicate === 'character.primary_title' || fact.predicate === 'title.holder';
        case 'liege':
            return fact.predicate === 'character.liege';
        case 'war':
            return fact.category === 'war';
        case 'activity':
            return fact.category === 'activity' || fact.category === 'location';
        case 'court':
            return fact.category === 'court';
        default:
            return false;
    }
}

/** Purpose-specific admission stays explicit and category-scoped. */
function matchesPurposeSpecificRule(input: ShouldAdmitDynamicFactInput): boolean {
    // Battle reports are an explicit military context. This rule is narrow by
    // design: it admits only public war facts, never arbitrary participant
    // neighbours or unrelated categories.
    if (input.purpose === 'battle_report' && input.fact.category === 'war') return true;
    if (input.purpose === 'scene_description'
        && (input.fact.category === 'activity' || input.fact.category === 'location')) return true;

    return false;
}

export interface SaveFactProjectorOptions {
    /** Already-clamped settings from `buildSaveFactSettings`. */
    settings: SaveFactSettings;
    /** Current prompt language; picks the fixed header/notice/line templates. */
    promptLanguage: SaveFactPromptLanguage;
    /** Live/cache/sidecar name resolution context (may be empty). */
    nameResolverContext?: SaveFactNameResolverContext;
    /** Token estimator; defaults to the shared cl100k estimate. */
    countTokens?: (text: string) => number;
}

interface CandidateFact {
    fact: GameFact;
    names: ResolvedFactNames;
}

function emptyResult(considered: number, dropped: { factId: string; reason: string }[]): FactProjectionResult {
    return {
        renderedText: '',
        usedTokens: 0,
        selectedFacts: Object.freeze([]),
        diagnostics: {
            considered,
            selectedFactIds: Object.freeze([]),
            dropped: Object.freeze(dropped)
        },
        laneLines: Object.freeze({ baseline: Object.freeze([]), dynamic: Object.freeze([]) }),
        laneBudgets: Object.freeze({ baseline: 0, dynamic: 0 }),
        blockHeader: '',
        trace: Object.freeze([])
    };
}

export class SaveFactProjector {
    private readonly settings: SaveFactSettings;
    private readonly promptLanguage: SaveFactPromptLanguage;
    private readonly nameResolverContext: SaveFactNameResolverContext;
    private readonly countTokens: (text: string) => number;

    constructor(options: SaveFactProjectorOptions) {
        this.settings = options.settings;
        this.promptLanguage = options.promptLanguage;
        this.nameResolverContext = options.nameResolverContext ?? {};
        this.countTokens = options.countTokens ?? countTokensCl100k;
    }

    /**
     * Project the conversation fact context into a bounded prompt block.
     * Pure with respect to its inputs: the same context + query always yield
     * the same result.
     */
    project(context: ConversationFactContext, query: FactQuery): FactProjectionResult {
        if (context.snapshotStatus !== 'available' || !this.settings.promptEnabled) {
            return emptyResult(0, []);
        }

        const candidates = this.collectCandidates(context);
        const dropped: { factId: string; reason: string }[] = [];

        // Registry gate: re-evaluate every candidate; only registry-public
        // facts in enabled categories may be considered.
        const publicCandidates: CandidateFact[] = [];
        for (const candidate of candidates) {
            if (evaluateFactVisibility(candidate.fact).visibility !== 'public'
                || candidate.fact.visibility !== 'public') {
                dropped.push({ factId: candidate.fact.id, reason: FACT_DROP_NOT_PUBLIC });
                continue;
            }
            if (!this.settings.categories[candidate.fact.category]) {
                dropped.push({ factId: candidate.fact.id, reason: FACT_DROP_CATEGORY_DISABLED });
                continue;
            }
            if (!this.settings.directRealmEnabled
                && (candidate.fact.predicate === 'character.direct_vassal_of'
                    || candidate.fact.predicate === 'character.realm_capital')) {
                dropped.push({ factId: candidate.fact.id, reason: FACT_DROP_CATEGORY_DISABLED });
                continue;
            }
            publicCandidates.push(candidate);
        }

        // Resolve display names once per candidate.
        for (const candidate of publicCandidates) {
            candidate.names = this.resolveNames(candidate.fact);
        }

        const queryText = combineFactQueryText(query);
        const latestPlayerText = query.recentUserText;
        const aliasMap = buildFactAliasMap(this.buildAliasSources(publicCandidates));
        const mentioned = findMentionedEntityKeys(queryText, aliasMap);
        const latestPlayerMentioned = findLatestPlayerMentionedEntityKeys(latestPlayerText, aliasMap);
        const topics = this.collectTopics(query, queryText);
        const admissionTopics = this.collectTopics(query, latestPlayerText);

        const speakerId = query.speakerCharacterId;
        const targetIds = new Set(query.targetCharacterIds);
        const participantIds = new Set(query.participantCharacterIds);

        // Duplicate semantics: within one semantic key the first fact (in
        // deterministic tie-break order) is canonical, the rest are penalized.
        const seenSemantics = new Set<string>();
        const duplicateFlags = new Map<string, boolean>();
        const preSorted = publicCandidates.slice().sort((a, b) => compareScoredFacts(
            { fact: a.fact, score: 0 },
            { fact: b.fact, score: 0 }
        ));
        for (const candidate of preSorted) {
            const semanticKey = factSemanticKey(candidate.fact);
            duplicateFlags.set(candidate.fact.id, seenSemantics.has(semanticKey));
            seenSemantics.add(semanticKey);
        }

        const scored = publicCandidates.map(candidate => {
            const { score, components } = scoreFact({
                fact: candidate.fact,
                mentionedEntityKeys: mentioned,
                topics,
                speakerCharacterId: speakerId,
                targetCharacterIds: targetIds,
                participantCharacterIds: participantIds,
                hasUnresolvedName: !candidate.names.renderable,
                isDuplicate: duplicateFlags.get(candidate.fact.id) === true
            });
            return { candidate, score, components };
        });

        const budgets = this.effectiveBudgets(query);
        const participantKeys = new Set(
            query.participantCharacterIds.map(id => `character:${id}`)
        );

        const baselineScored = scored
            .filter(entry => this.isBaselineFact(entry.candidate.fact, participantKeys))
            .sort(compareScoredFactsLane);
        const dynamicScored = scored
            .filter(entry => !this.isBaselineFact(entry.candidate.fact, participantKeys))
            .sort(compareScoredFactsLane);

        const baselineIds = new Set(baselineScored.map(entry => entry.candidate.fact.id));
        const trace: FactSelectionTraceEntry[] = [];
        const selectedFacts: GameFact[] = [];
        const selectedFactIds: string[] = [];

        const lanes: { lane: 'baseline' | 'dynamic'; lines: string[]; maxTokens: number }[] = [
            { lane: 'baseline', lines: [], maxTokens: budgets.baseline },
            { lane: 'dynamic', lines: [], maxTokens: budgets.dynamic }
        ];
        // laneLines keeps the rendered line aligned with its scored entry.
        const laneEntries: {
            entry: (typeof scored)[number];
            line: string;
            admissionReason: DynamicAdmissionReason | 'baseline';
        }[][] = [[], []];

        const fillLane = (
            laneIndex: number,
            lane: 'baseline' | 'dynamic',
            entries: (typeof scored)[number][]
        ): void => {
            for (const entry of entries) {
                const fact = entry.candidate.fact;
                if (lane === 'dynamic' && baselineIds.has(fact.id)) continue;
                let admissionReason: DynamicAdmissionReason | 'baseline' = 'baseline';
                if (lane === 'dynamic') {
                    const admission = shouldAdmitDynamicFact({
                        purpose: query.purpose,
                        fact,
                        latestPlayerMentionedEntityKeys: latestPlayerMentioned,
                        participantCharacterIds: participantIds,
                        topics: admissionTopics
                    });
                    if (!admission.admitted) {
                        trace.push(this.traceEntry(entry, lane, 'dropped', admission.reason));
                        dropped.push({ factId: fact.id, reason: FACT_DROP_NO_SIGNAL });
                        continue;
                    }
                    admissionReason = admission.reason;
                }
                const line = renderFactLine(
                    fact,
                    {
                        subjectName: entry.candidate.names.subject.displayName,
                        objectName: entry.candidate.names.object?.displayName
                    },
                    this.promptLanguage
                );
                if (line === undefined) {
                    trace.push(this.traceEntry(entry, lane, 'dropped', FACT_DROP_NAME_UNRESOLVED));
                    dropped.push({ factId: fact.id, reason: FACT_DROP_NAME_UNRESOLVED });
                    continue;
                }
                lanes[laneIndex].lines.push(line);
                laneEntries[laneIndex].push({ entry, line, admissionReason });
            }
        };

        fillLane(0, 'baseline', baselineScored);
        fillLane(1, 'dynamic', dynamicScored);

        const asOfGameDate = this.snapshotDateDisplay(scored.map(entry => entry.candidate.fact));
        const block = renderGameFactsBlock({
            language: this.promptLanguage,
            asOfGameDate,
            lanes,
            countTokens: this.countTokens
        });

        // Map renderer lane outcomes back onto facts for the trace.
        for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
            const laneId = lanes[laneIndex].lane;
            const entries = laneEntries[laneIndex];
            const includedIndexes = new Set(block.includedLineIndexes[laneIndex]);
            for (let i = 0; i < entries.length; i++) {
                const { entry, line, admissionReason } = entries[i];
                if (includedIndexes.has(i)) {
                    selectedFacts.push(entry.candidate.fact);
                    selectedFactIds.push(entry.candidate.fact.id);
                    trace.push(this.traceEntry(
                        entry,
                        laneId,
                        'included',
                        admissionReason,
                        this.countTokens(`${line}\n`)
                    ));
                } else {
                    trace.push(this.traceEntry(entry, laneId, 'dropped', FACT_DROP_BUDGET));
                    dropped.push({ factId: entry.candidate.fact.id, reason: FACT_DROP_BUDGET });
                }
            }
        }

        // Deterministic trace order independent of lane iteration details.
        trace.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));

        return {
            renderedText: block.renderedText,
            usedTokens: block.usedTokens,
            selectedFacts: Object.freeze(selectedFacts),
            diagnostics: {
                considered: publicCandidates.length,
                selectedFactIds: Object.freeze(selectedFactIds),
                dropped: Object.freeze(dropped)
            },
            // Task 17: freeze the pre-budget lane pools, the effective
            // budgets and the fixed header so the prompt workbench builder
            // can re-select without the live fact index.
            laneLines: Object.freeze({
                baseline: Object.freeze(lanes[0].lines.slice()),
                dynamic: Object.freeze(lanes[1].lines.slice())
            }),
            laneBudgets: Object.freeze({ baseline: budgets.baseline, dynamic: budgets.dynamic }),
            blockHeader: buildGameFactsBlockHeader(this.promptLanguage, asOfGameDate),
            asOfGameDate,
            trace: Object.freeze(trace)
        };
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** All index facts plus the precomputed baseline facts, deduped by fact ID. */
    private collectCandidates(context: ConversationFactContext): CandidateFact[] {
        const byId = new Map<string, GameFact>();
        for (const fact of context.baselineFacts) byId.set(fact.id, fact);
        if (context.factIndex !== undefined) {
            for (const category of SAVE_FACT_CATEGORIES) {
                for (const fact of context.factIndex.queryByCategory(category)) {
                    if (!byId.has(fact.id)) byId.set(fact.id, fact);
                }
            }
        }
        return [...byId.values()].map(fact => ({ fact, names: EMPTY_NAMES }));
    }

    /**
     * Resolve both endpoint names. The name resolver's priority chain runs
     * first; a sanitized on-ref `displayName` (e.g. written by the authority
     * resolver from live GameData) is the fallback. Raw loc keys never pass.
     */
    private resolveNames(fact: GameFact): ResolvedFactNames {
        const subject = resolveEntityDisplayName(fact.subject, this.nameResolverContext, fact);
        const object = fact.object !== undefined
            ? resolveEntityDisplayName(fact.object, this.nameResolverContext, fact)
            : undefined;
        const subjectName = subject.resolved
            ? subject.displayName
            : sanitizeDisplayName(fact.subject.displayName ?? '');
        const objectName = object === undefined
            ? undefined
            : object.resolved
                ? object.displayName
                : sanitizeDisplayName(fact.object?.displayName ?? '');
        return {
            subject: subject.resolved
                ? subject
                : subjectName !== undefined
                    ? { resolved: true, displayName: subjectName, source: 'sidecar_literal' }
                    : subject,
            object: object === undefined
                ? undefined
                : object.resolved
                    ? object
                    : objectName !== undefined
                        ? { resolved: true, displayName: objectName, source: 'sidecar_literal' }
                        : object,
            renderable: subjectName !== undefined
                && (fact.object === undefined || objectName !== undefined)
        };
    }

    /**
     * Alias sources from validated names only: resolved display names plus
     * live GameData character variants (fullName/shortName/firstName and the
     * explicit title+name form). Never raw loc keys or arbitrary save scalars.
     */
    private buildAliasSources(candidates: readonly CandidateFact[]): FactAliasSource[] {
        const byKey = new Map<string, { ref: GameFact['subject']; names: string[] }>();
        const push = (ref: GameFact['subject'], name: string | undefined): void => {
            if (name === undefined) return;
            const key = saveFactEntityKey(ref);
            let bucket = byKey.get(key);
            if (bucket === undefined) {
                bucket = { ref, names: [] };
                byKey.set(key, bucket);
            }
            if (!bucket.names.includes(name)) bucket.names.push(name);
        };
        for (const candidate of candidates) {
            const { fact, names } = candidate;
            push(fact.subject, names.subject.displayName);
            if (fact.object !== undefined) push(fact.object, names.object?.displayName);
            const gameData = this.nameResolverContext.gameData;
            for (const ref of [fact.subject, fact.object]) {
                if (ref?.type !== 'character') continue;
                const live = findLiveCharacter(gameData, ref.id);
                if (live === undefined) continue;
                for (const variant of characterNameVariants(live)) push(ref, variant);
            }
        }
        return [...byKey.values()].map(bucket => ({ ref: bucket.ref, names: bucket.names }));
    }

    /** Query hints first (fixed input order), then detected keywords (fixed order). */
    private collectTopics(query: FactQuery, queryText: string): FactTopic[] {
        const topics: FactTopic[] = [];
        for (const hint of query.topicHints) {
            if (!topics.includes(hint)) topics.push(hint);
        }
        for (const detected of detectFactTopics(queryText)) {
            if (!topics.includes(detected)) topics.push(detected);
        }
        return topics;
    }

    /**
     * Baseline lane membership (plan Task 15 step 5): a one-hop public
     * relation between two participant characters, or a participant's
     * displayable primary title / direct liege.
     */
    private isBaselineFact(fact: GameFact, participantKeys: ReadonlySet<string>): boolean {
        const subjectKey = saveFactEntityKey(fact.subject);
        const subjectIsParticipant = participantKeys.has(subjectKey);
        if (fact.object !== undefined) {
            const objectIsParticipant = participantKeys.has(saveFactEntityKey(fact.object));
            if (subjectIsParticipant && objectIsParticipant) return true;
        }
        return subjectIsParticipant
            && (fact.predicate === 'character.primary_title' || fact.predicate === 'character.liege');
    }

    /**
     * Per-purpose budgets: the clamped settings values, further capped by the
     * purpose table, with `query.maxTokens` as the total hard cap. Under
     * pressure the dynamic lane shrinks first (plan: dynamic facts are
     * trimmed before baseline content).
     */
    private effectiveBudgets(query: FactQuery): { baseline: number; dynamic: number } {
        const caps = PURPOSE_BUDGET_CAPS[query.purpose];
        const hardCap = SAVE_FACT_LIMITS.tokenBudget.max;
        const baseline = Math.min(this.settings.baselineTokenBudget, caps.baseline, hardCap);
        const dynamic = Math.min(this.settings.dynamicTokenBudget, caps.dynamic, hardCap);
        const totalCap = Math.max(0, Math.min(query.maxTokens, hardCap));
        return {
            baseline: Math.min(baseline, totalCap),
            dynamic: Math.min(dynamic, Math.max(0, totalCap - baseline))
        };
    }

    /** Shared snapshot date display: the first candidate carrying one. */
    private snapshotDateDisplay(facts: readonly GameFact[]): string | undefined {
        for (const fact of facts) {
            const display = fact.asOfGameDate.display;
            if (display !== undefined && sanitizeDisplayName(display) !== undefined) return display;
        }
        return undefined;
    }

    private traceEntry(
        entry: { candidate: CandidateFact; score: number; components: FactSelectionTraceEntry['scoreComponents'] },
        lane: FactSelectionTraceEntry['lane'],
        outcome: FactSelectionTraceEntry['outcome'],
        reason?: string,
        estimatedTokens?: number
    ): FactSelectionTraceEntry {
        return {
            factId: entry.candidate.fact.id,
            lane,
            score: entry.score,
            scoreComponents: entry.components,
            outcome,
            reason,
            estimatedTokens
        };
    }
}

const EMPTY_NAMES: ResolvedFactNames = Object.freeze({
    subject: Object.freeze({ resolved: false }),
    renderable: false
});

function compareScoredFactsLane(
    a: { candidate: CandidateFact; score: number },
    b: { candidate: CandidateFact; score: number }
): number {
    return compareScoredFacts(
        { fact: a.candidate.fact, score: a.score },
        { fact: b.candidate.fact, score: b.score }
    );
}
