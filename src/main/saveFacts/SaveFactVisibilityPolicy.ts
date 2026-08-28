/**
 * Predicate-registry driven visibility policy (implementation plan Task 14
 * steps 4-5, registry table in plan 5.5).
 *
 * Every extractor fact starts as `omniscient_internal` regardless of the
 * visibility the sidecar claimed — the sidecar is untrusted input. The app
 * registry then decides, per predicate:
 *
 * - raw source-path allowlist (canonical enums, never raw save paths);
 * - confidence threshold;
 * - sensitivity;
 * - hidden-field guard (facts carrying secret/system-hidden semantics are
 *   blocked even when the predicate itself is registered);
 * - visibility upgrade target;
 * - render template id.
 *
 * Unknown predicates are ALWAYS blocked; there is no "default public".
 * First release only projects `public` facts into the prompt:
 * `speaker_known` / `player_known` / `knownByCharacterIds` stay structurally
 * available on `GameFact` but are never granted here until CK3 knower
 * fixtures exist.
 */

import { SAVE_FACT_PREDICATES } from './saveFactTypes';
import type {
    FactConfidence,
    FactSensitivity,
    FactVisibility,
    GameFact,
    SaveFactPredicate,
    SaveFactSourcePath
} from './saveFactTypes';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface SaveFactPredicatePolicy {
    /** Canonical source regions this predicate may be derived from. */
    allowedSourcePaths: readonly SaveFactSourcePath[];
    /** Minimum confidence required for the visibility upgrade. */
    minConfidence: FactConfidence;
    sensitivity: FactSensitivity;
    /** Reject facts the sidecar itself marked secret/system-hidden. */
    hiddenFieldGuard: boolean;
    /** Upgrade target; `omniscient_internal` means "internal index only". */
    upgradeTo: FactVisibility;
    renderTemplateId: string;
}

/**
 * First-release registry (plan 5.5). The original relationship predicates and
 * bounded public war predicates upgrade to `public`; `title.holder` stays
 * `omniscient_internal` as an internal reverse index and is never rendered
 * directly. Secrets, schemes, real fathers, hidden relations, AI strategy,
 * raw flags and future queues are deliberately NOT registered and can never
 * pass.
 */
export const SAVE_FACT_PREDICATE_REGISTRY: Readonly<Partial<Record<SaveFactPredicate, SaveFactPredicatePolicy>>> = {
    'character.spouse': {
        allowedSourcePaths: ['character_spouse'],
        minConfidence: 'exact',
        sensitivity: 'personal',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.spouse'
    },
    'character.parent': {
        allowedSourcePaths: ['character_father', 'character_mother', 'character_child'],
        minConfidence: 'mapped',
        sensitivity: 'personal',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.parent'
    },
    // Derived inversely from accepted parent facts; shares their provenance.
    'character.child': {
        allowedSourcePaths: ['character_father', 'character_mother', 'character_child'],
        minConfidence: 'mapped',
        sensitivity: 'personal',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.child'
    },
    'character.liege': {
        allowedSourcePaths: ['character_liege'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.liege'
    },
    'character.primary_title': {
        allowedSourcePaths: ['character_primary_title'],
        minConfidence: 'mapped',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.primary_title'
    },
    'character.direct_vassal_of': {
        allowedSourcePaths: ['character_direct_vassal_of'], minConfidence: 'exact', sensitivity: 'political', hiddenFieldGuard: true, upgradeTo: 'public', renderTemplateId: 'savefact.character.direct_vassal_of'
    },
    'character.realm_capital': {
        allowedSourcePaths: ['character_realm_capital'], minConfidence: 'mapped', sensitivity: 'political', hiddenFieldGuard: true, upgradeTo: 'public', renderTemplateId: 'savefact.character.realm_capital'
    },
    'title.holder': {
        allowedSourcePaths: ['title_holder'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'omniscient_internal',
        renderTemplateId: 'savefact.title.holder'
    },
    'character.at_war': {
        allowedSourcePaths: ['character_at_war'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.at_war'
    },
    'war.attacker': {
        allowedSourcePaths: ['war_attacker'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.war.attacker'
    },
    'war.defender': {
        allowedSourcePaths: ['war_defender'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.war.defender'
    },
    'war.casus_belli': {
        allowedSourcePaths: ['war_casus_belli'],
        minConfidence: 'mapped',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.war.casus_belli'
    },
    'character.war_score_band': {
        allowedSourcePaths: ['character_war_score_band'],
        minConfidence: 'mapped',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.war_score_band'
    },
    'character.public_location': {
        allowedSourcePaths: ['character_public_location'],
        minConfidence: 'mapped',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.public_location'
    },
    'character.court_owner': {
        allowedSourcePaths: ['character_court_owner'],
        minConfidence: 'exact',
        sensitivity: 'political',
        hiddenFieldGuard: true,
        upgradeTo: 'public',
        renderTemplateId: 'savefact.character.court_owner'
    }
};

const CONFIDENCE_RANK: Record<FactConfidence, number> = {
    heuristic: 0,
    mapped: 1,
    exact: 2
};

/** Sensitivities the hidden-field guard rejects for every registered predicate. */
const GUARDED_SENSITIVITIES: ReadonlySet<FactSensitivity> = new Set(['secret', 'system_hidden']);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Warning/decision codes. Diagnostics record code + category only, never content. */
export const FACT_PREDICATE_UNKNOWN = 'FACT_PREDICATE_UNKNOWN';
export const FACT_SOURCE_PATH_REJECTED = 'FACT_SOURCE_PATH_REJECTED';
export const FACT_HIDDEN_FIELD_GUARD = 'FACT_HIDDEN_FIELD_GUARD';
export const FACT_CONFIDENCE_BELOW_THRESHOLD = 'FACT_CONFIDENCE_BELOW_THRESHOLD';

export interface SaveFactVisibilityWarning {
    code: string;
    category?: string;
}

export interface SaveFactVisibilityEvaluation {
    /** Final visibility after registry evaluation (never the sidecar's claim). */
    visibility: FactVisibility;
    policy?: SaveFactPredicatePolicy;
    /** Set when the outcome diverges from a clean upgrade (blocked / held back). */
    reason?: string;
}

export function getPredicatePolicy(predicate: string): SaveFactPredicatePolicy | undefined {
    if (!(SAVE_FACT_PREDICATES as readonly string[]).includes(predicate)) return undefined;
    return SAVE_FACT_PREDICATE_REGISTRY[predicate as SaveFactPredicate];
}

/**
 * Evaluate one fact against the registry. The sidecar-claimed
 * `fact.visibility` is ignored entirely; every fact starts
 * `omniscient_internal` and only the registry may upgrade it.
 */
export function evaluateFactVisibility(fact: GameFact): SaveFactVisibilityEvaluation {
    const policy = getPredicatePolicy(fact.predicate);
    if (policy === undefined) {
        return { visibility: 'blocked', reason: FACT_PREDICATE_UNKNOWN };
    }
    if (
        fact.sourcePath === undefined
        || !(policy.allowedSourcePaths as readonly string[]).includes(fact.sourcePath)
    ) {
        return { visibility: 'blocked', policy, reason: FACT_SOURCE_PATH_REJECTED };
    }
    if (policy.hiddenFieldGuard && GUARDED_SENSITIVITIES.has(fact.sensitivity)) {
        return { visibility: 'blocked', policy, reason: FACT_HIDDEN_FIELD_GUARD };
    }
    if (CONFIDENCE_RANK[fact.confidence] < CONFIDENCE_RANK[policy.minConfidence]) {
        // Below the upgrade threshold: kept internally, never public.
        return { visibility: 'omniscient_internal', policy, reason: FACT_CONFIDENCE_BELOW_THRESHOLD };
    }
    return { visibility: policy.upgradeTo, policy };
}

export interface SaveFactVisibilityResult {
    /** Copies of the input facts with registry-decided visibility applied. */
    facts: GameFact[];
    warnings: SaveFactVisibilityWarning[];
}

/**
 * Apply the policy to a batch. Input facts are not mutated. Blocked facts are
 * retained in the output (visibility `blocked`) so diagnostics can count
 * them; only `projectPublicFacts` output may reach a prompt.
 */
export function applySaveFactVisibilityPolicy(facts: readonly GameFact[]): SaveFactVisibilityResult {
    const out: GameFact[] = [];
    const warnings: SaveFactVisibilityWarning[] = [];

    for (const fact of facts) {
        const evaluation = evaluateFactVisibility(fact);
        out.push({ ...fact, visibility: evaluation.visibility });
        if (evaluation.reason !== undefined && evaluation.reason !== FACT_CONFIDENCE_BELOW_THRESHOLD) {
            warnings.push({ code: evaluation.reason, category: fact.category });
        }
    }

    return { facts: out, warnings };
}

/**
 * First-release prompt projection gate (plan Task 14 step 5): only facts the
 * registry proved `public` are prompt candidates. `speaker_known`,
 * `player_known` and `knownByCharacterIds` are not enabled yet.
 */
export function projectPublicFacts(facts: readonly GameFact[]): GameFact[] {
    return facts.filter(fact => fact.visibility === 'public');
}
