/**
 * Main-only save game fact types (implementation plan Task 6, design spec
 * "事实数据模型" / plan sections 5.3-5.6).
 *
 * These types must NOT be moved into `src/shared` or attached to the
 * renderer-visible `GameData`: `GameFact` may carry omniscient visibility,
 * and exposing it to the renderer would leak facts the current speaker must
 * not know.
 *
 * Where the design spec and the implementation plan disagree, the plan wins:
 * - `SaveSnapshotManifest` follows plan 5.4 (`factSchemaVersion: 1`, no
 *   real-time capture timestamps on the DTO).
 * - `ConversationFactContext.snapshotStatus` uses the plan 5.6 eight-state
 *   list (adds `unavailable` and `superseded` over the spec's six).
 * - Sidecar request/response DTOs follow plan 5.3/5.4 field names exactly.
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

/** Fact categories. First release is restricted to this allowlist. */
export const SAVE_FACT_CATEGORIES = ['identity', 'family', 'realm', 'war', 'activity', 'location', 'court'] as const;
export type SaveFactCategory = (typeof SAVE_FACT_CATEGORIES)[number];

export type FactVisibility =
    | 'public'
    | 'speaker_known'
    | 'player_known'
    | 'omniscient_internal'
    | 'blocked';

export type FactSource =
    | 'live_gamedata'
    | 'save_snapshot'
    | 'character_memory'
    | 'conversation_history'
    | 'chronicle';

export type FactSensitivity =
    | 'normal'
    | 'personal'
    | 'political'
    | 'secret'
    | 'system_hidden';

export type FactConfidence = 'exact' | 'mapped' | 'heuristic';

export const ENTITY_REF_TYPES = [
    'character',
    'title',
    'war',
    'realm',
    'activity',
    'artifact',
    'culture',
    'faith',
    'dynasty',
    'location'
] as const;
export type EntityRefType = (typeof ENTITY_REF_TYPES)[number];

export interface EntityRef {
    type: EntityRefType;
    id: string;
    displayName?: string;
}

/**
 * First-release predicate registry (plan 5.5). Anything outside this list is
 * never accepted from the sidecar; secrets, schemes, hidden relations, real
 * fathers, AI strategy and raw flags are explicitly forbidden.
 */
export const SAVE_FACT_PREDICATES = [
    'character.spouse',
    'character.parent',
    'character.child',
    'character.liege',
    'character.primary_title',
    'character.direct_vassal_of',
    'character.realm_capital',
    'title.holder',
    'character.at_war',
    'war.attacker',
    'war.defender',
    'war.casus_belli',
    'character.war_score_band',
    'character.current_activity',
    'character.traveling',
    'character.public_location',
    'activity.location',
    'character.council_position',
    'character.court_position',
    'character.court_owner'
] as const;
export type SaveFactPredicate = (typeof SAVE_FACT_PREDICATES)[number];

/**
 * Canonical raw save regions a fact may be derived from. The sidecar reports
 * one of these enum values instead of a free-form raw path, so no raw save
 * path ever reaches the app or the prompt.
 */
export const SAVE_FACT_SOURCE_PATHS = [
    'character_spouse',
    'character_father',
    'character_mother',
    'character_child',
    'character_liege',
    'character_primary_title',
    'character_direct_vassal_of',
    'character_realm_capital',
    'title_holder',
    'character_at_war',
    'war_attacker',
    'war_defender',
    'war_casus_belli',
    'character_war_score_band',
    'character_current_activity',
    'character_traveling',
    'character_public_location',
    'activity_location',
    'character_council_position',
    'character_court_position',
    'character_court_owner'
] as const;
export type SaveFactSourcePath = (typeof SAVE_FACT_SOURCE_PATHS)[number];

export const SAVE_SOURCE_FORMATS = [
    'unified_text',
    'zip_text',
    'zip_binary',
    'unified_binary',
    'unknown'
] as const;
export type SaveSourceFormat = (typeof SAVE_SOURCE_FORMATS)[number];

/** Topic hints for the deterministic dynamic fact retrieval (spec: FactQuery). */
export type FactTopic =
    | 'family'
    | 'titles'
    | 'liege'
    | 'war'
    | 'activity'
    | 'court'
    | 'artifact';

export const WAR_CASUS_BELLI_VALUES = [
    'conquest',
    'claim',
    'holy_war',
    'revolt',
    'succession',
    'other'
] as const;
export type WarCasusBelli = (typeof WAR_CASUS_BELLI_VALUES)[number];

export const WAR_SCORE_BANDS = [
    'decisive_loss',
    'losing',
    'balanced',
    'winning',
    'decisive_win'
] as const;
export type WarScoreBand = (typeof WAR_SCORE_BANDS)[number];

/** Closed allowlist for the versioned activity fixture. Unknown activity
 * identifiers are retained internally only when they have a safe literal
 * name; they are never projected as a typed public value. */
export const ACTIVITY_TYPE_VALUES = [
    'feast', 'hunt', 'pilgrimage', 'tournament', 'travel', 'other'
] as const;
export type ActivityType = (typeof ACTIVITY_TYPE_VALUES)[number];

/**
 * Projection purposes (plan Task 15 step 9 / Task 18 step 1). Each purpose has
 * its own budget caps in the projector; scene/suggestion callers must pass
 * their own context text instead of fabricating a user message.
 */
export const FACT_PROJECTION_PURPOSES = [
    'conversation',
    'self_talk',
    'ai_to_ai',
    'scene_description',
    'suggestion',
    'battle_report'
] as const;
export type FactProjectionPurpose = (typeof FACT_PROJECTION_PURPOSES)[number];

// ---------------------------------------------------------------------------
// P0-C telemetry (main-process only)
// ---------------------------------------------------------------------------

/** Sanitized preparation timings. No paths, IDs, names or error text. */
export interface SaveFactPreparationTelemetry {
    totalDurationMs: number;
    waitDurationMs: number;
    probeDurationMs: number;
    extractDurationMs: number;
    cacheLookupDurationMs: number;
    cacheHit: boolean;
    currentCacheWriteScheduled: boolean;
    nameCacheWriteScheduled: boolean;
    deltaStatus?: 'disabled' | 'baseline' | 'compared' | 'skipped' | 'write-failed' | 'corrupt';
    deltaAddedCount?: number;
    deltaRemovedCount?: number;
    deltaChangedCount?: number;
    deltaWarningCount?: number;
}

/** The only save-fact data allowed to cross the prompt dispatch boundary. */
export interface SaveFactInjectionTrace {
    requestId: string;
    purpose: FactProjectionPurpose;
    includedFactCount: number;
    injectedTokenCount: number;
}

export type SaveFactPromptDispatchPhase = 'submitted' | 'succeeded' | 'failed';

export interface SaveFactPromptDispatchObservation {
    requestId: string;
    purpose: FactProjectionPurpose;
    phase: SaveFactPromptDispatchPhase;
    includedFactCount: number;
    injectedTokenCount: number;
}

export interface SaveFactUsageBucket {
    generationCount: number;
    generationsWithFacts: number;
    lastInjectedFactCount: number;
    lastInjectedTokenCount: number;
    totalInjectedFactCount: number;
    totalInjectedTokenCount: number;
    maxInjectedFactCount: number;
    maxInjectedTokenCount: number;
    succeededCount: number;
    failedCount: number;
}

export interface SaveFactUsageTelemetry extends SaveFactUsageBucket {
    byPurpose: Record<FactProjectionPurpose, SaveFactUsageBucket>;
}

export function createEmptySaveFactUsageBucket(): SaveFactUsageBucket {
    return {
        generationCount: 0,
        generationsWithFacts: 0,
        lastInjectedFactCount: 0,
        lastInjectedTokenCount: 0,
        totalInjectedFactCount: 0,
        totalInjectedTokenCount: 0,
        maxInjectedFactCount: 0,
        maxInjectedTokenCount: 0,
        succeededCount: 0,
        failedCount: 0
    };
}

export function createEmptySaveFactUsageTelemetry(): SaveFactUsageTelemetry {
    return {
        ...createEmptySaveFactUsageBucket(),
        byPurpose: Object.fromEntries(
            FACT_PROJECTION_PURPOSES.map(purpose => [purpose, createEmptySaveFactUsageBucket()])
        ) as Record<FactProjectionPurpose, SaveFactUsageBucket>
    };
}

// ---------------------------------------------------------------------------
// Snapshot status and error codes (plan 5.6)
// ---------------------------------------------------------------------------

export const SAVE_SNAPSHOT_STATUSES = [
    'available',
    'disabled',
    'unavailable',
    'timeout',
    'unsupported',
    'mismatch',
    'failed',
    'superseded'
] as const;
export type SaveSnapshotStatus = (typeof SAVE_SNAPSHOT_STATUSES)[number];

export const SAVE_FACT_ERROR_CODES = [
    'SAVE_NOT_FOUND',
    'SAVE_NOT_STABLE',
    'SAVE_READ_DENIED',
    'SAVE_TRUNCATED',
    'SAVE_ENVELOPE_UNKNOWN',
    'SAVE_ENTRY_MISSING',
    'SAVE_BINARY_UNSUPPORTED',
    'SAVE_TOKEN_RESOLVER_MISSING',
    'SAVE_VERSION_UNSUPPORTED',
    'SAVE_PARSE_FAILED',
    'SAVE_LIMIT_EXCEEDED',
    'SAVE_IDENTITY_MISMATCH',
    'SAVE_PLAYER_MISMATCH',
    'SAVE_CAMPAIGN_MISMATCH',
    'SAVE_SEQUENCE_MISMATCH',
    'SAVE_SLOT_MISMATCH',
    'SAVE_DATE_MISMATCH',
    'PARSER_NOT_FOUND',
    'PARSER_TIMEOUT',
    'PARSER_CRASHED',
    'PARSER_OUTPUT_LIMIT',
    'PARSER_OUTPUT_INVALID',
    'PARSER_PROTOCOL_UNSUPPORTED',
    'START_SUPERSEDED'
] as const;
export type SaveFactErrorCode = (typeof SAVE_FACT_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface GameFact {
    id: string;
    category: SaveFactCategory;
    subject: EntityRef;
    predicate: string;
    object?: EntityRef;
    value?: string | number | boolean;
    asOfGameDate: {
        numeric?: number;
        display?: string;
    };
    source: FactSource;
    /** Canonical source region enum, never a raw save path. */
    sourcePath?: string;
    confidence: FactConfidence;
    visibility: FactVisibility;
    knownByCharacterIds?: string[];
    priority: number;
    sensitivity: FactSensitivity;
    provenance: {
        snapshotId?: string;
        campaignId?: string;
        timelineNodeId?: string;
        checkpointEpoch?: number;
    };
}

export interface SaveSnapshotManifest {
    snapshotId: string;
    sourceFingerprint: string;
    sourceFormat: SaveSourceFormat;
    ck3Version?: string;
    saveGameVersion?: number;
    parserVersion: string;
    factSchemaVersion: 1;
}

/**
 * Bounded fact index (plan Task 14 step 1). Only query methods are exposed;
 * the internal `bySubject`/`byObject`/`byCategory`/`byPredicate`/
 * `participantDistance` Maps never leak as mutable references. Entity keys
 * use the `type:id` form (see `saveFactEntityKey` in `SaveFactIndex.ts`).
 */
export interface SaveFactIndex {
    readonly snapshot: SaveSnapshotManifest;
    readonly factCount: number;
    readonly entityCount: number;
    queryBySubject(key: string): readonly GameFact[];
    queryByObject(key: string): readonly GameFact[];
    queryByCategory(category: SaveFactCategory): readonly GameFact[];
    queryByPredicate(predicate: string): readonly GameFact[];
    /** BFS hop distance from the nearest participant character; undefined when unreachable. */
    participantDistance(key: string): number | undefined;
}

/**
 * Per-conversation fact context, held by the main process only. Every failure
 * path must go through `createEmptyConversationFactContext` so downstream
 * consumers can rely on `baselineFacts` being a (frozen) empty array and on
 * the absence of a fact index instead of probing for undefined fields.
 */
export interface ConversationFactContext {
    snapshotStatus: SaveSnapshotStatus;
    snapshot?: SaveSnapshotManifest;
    /**
     * Main-process-only reference to the exact save accepted by the probe.
     * Agency may use it for typed verification; it is never renderer-facing
     * and is absent on every degraded context.
     */
    verificationSnapshot?: SaveFactVerificationSnapshotRef;
    /**
     * Ordered decimal CK3 runtime IDs of the same-location join candidates
     * from the accepted save snapshot's `votc_join_candidates` list. Main-only
     * transport for the join coordinator — never a fact, never projected,
     * never renderer-facing. Absent on legacy cache rows / fresh extracts
     * without them, which degrades to `candidates_missing` downstream.
     */
    joinCandidates?: readonly string[];
    baselineFacts: readonly GameFact[];
    factIndex?: SaveFactIndex;
    diagnostics: {
        errorCode?: SaveFactErrorCode;
        warningCodes: readonly string[];
        preparationTelemetry?: SaveFactPreparationTelemetry;
    };
}

/**
 * Build the shared degraded context used by every failure path (disabled,
 * timeout, mismatch, parser failure, superseded start, ...). The returned
 * object has no fact index and its arrays are bounded and frozen so a caller
 * can never mutate shared state.
 */
export function createEmptyConversationFactContext(
    status: SaveSnapshotStatus,
    code?: SaveFactErrorCode
): ConversationFactContext {
    const warningCodes: readonly string[] = Object.freeze([]);
    const baselineFacts: readonly GameFact[] = Object.freeze([]);
    return Object.freeze({
        snapshotStatus: status,
        baselineFacts,
        diagnostics: Object.freeze({
            errorCode: code,
            warningCodes
        })
    });
}

// ---------------------------------------------------------------------------
// Prompt projection
// ---------------------------------------------------------------------------

export interface FactQuery {
    speakerCharacterId: string;
    targetCharacterIds: string[];
    participantCharacterIds: string[];
    playerCharacterId: string;
    /** Which generator is asking; drives per-purpose budget caps. */
    purpose: FactProjectionPurpose;
    recentUserText: string;
    recentConversationText: string;
    topicHints: FactTopic[];
    maxTokens: number;
}

/**
 * Internal selection trace (plan Task 15 step 8). Records fact IDs, score
 * components, lane, outcome and estimated tokens only — never raw display
 * values — and is never sent to the renderer.
 */
export interface FactScoreBreakdown {
    directMention: number;
    speaker: number;
    replyTarget: number;
    topic: number;
    participant: number;
    confidence: number;
    priority: number;
    unresolvedName: number;
    duplicate: number;
}

export interface FactSelectionTraceEntry {
    factId: string;
    lane: 'baseline' | 'dynamic' | 'none';
    score: number;
    scoreComponents: FactScoreBreakdown;
    outcome: 'included' | 'dropped';
    /** Machine-readable reason when dropped (budget, unresolved name, no signal, ...). */
    reason?: string;
    estimatedTokens?: number;
}

export interface FactProjectionResult {
    /** Escaped, fixed-template text ready for the prompt block. */
    renderedText: string;
    usedTokens: number;
    selectedFacts: readonly GameFact[];
    diagnostics: {
        considered: number;
        selectedFactIds: readonly string[];
        dropped: readonly { factId: string; reason: string }[];
    };
    /**
     * Task 17: pre-budget rendered candidate lines per lane in deterministic
     * selection order. Every line already passed the visibility/category/
     * name gates and the renderer sanitizer; only the per-lane token budget
     * has NOT been applied yet, so the prompt workbench can freeze these
     * pools and let the artifact builder re-run budget selection without
     * touching the live fact index. Empty for every gated/empty result.
     */
    laneLines: {
        readonly baseline: readonly string[];
        readonly dynamic: readonly string[];
    };
    /** Task 17: per-lane token budgets that were in effect for this projection. */
    laneBudgets: {
        readonly baseline: number;
        readonly dynamic: number;
    };
    /**
     * Task 17: fixed localized block header (opening tag with as_of plus the
     * safety notice lines). Empty string for gated/empty results.
     */
    blockHeader: string;
    /** Task 17: sanitized snapshot date display used for the as_of attribute. */
    asOfGameDate?: string;
    /** Internal-only trace; never forwarded to the renderer. */
    trace: readonly FactSelectionTraceEntry[];
}

// ---------------------------------------------------------------------------
// Diagnostics DTO (plan Task 19 step 6). Contains no raw facts, no raw
// response, no file paths and no prompt content — safe to hand to the
// renderer diagnostics UI.
// ---------------------------------------------------------------------------

export interface SaveFactDiagnosticsDto {
    status: SaveSnapshotStatus;
    code?: SaveFactErrorCode;
    sourceFormat?: SaveSourceFormat;
    ck3Version?: string;
    parserVersion?: string;
    asOfGameDateDisplay?: string;
    waitDurationMs?: number;
    parseDurationMs?: number;
    factCount: number;
    entityCount: number;
    categoryCounts: Partial<Record<SaveFactCategory, number>>;
    injectedFactCount: number;
    injectedTokenCount: number;
    preparationTelemetry?: SaveFactPreparationTelemetry;
    usageTelemetry?: SaveFactUsageTelemetry;
    warningCodes: string[];
}

/**
 * Build the renderer-safe diagnostics DTO from the most recent preparation
 * context (plan Task 19 step 6). Only aggregates are computed here; snapshot
 * IDs, fingerprints, raw facts, raw responses, file paths and prompt content
 * are never copied into the DTO.
 *
 * `waitDurationMs`/`parseDurationMs` are left undefined: the context does not
 * carry timing telemetry. `injectedFactCount`/`injectedTokenCount` stay 0
 * until prompt-projection telemetry is wired to the conversation.
 */
export function buildSaveFactDiagnosticsDto(
    context: ConversationFactContext,
    usageTelemetry?: SaveFactUsageTelemetry
): SaveFactDiagnosticsDto {
    const categoryCounts: Partial<Record<SaveFactCategory, number>> = {};
    const entityKeys = new Set<string>();
    let asOfGameDateDisplay: string | undefined;
    let maxAsOfNumeric = -1;
    for (const fact of context.baselineFacts) {
        // Defensive: a malformed fact must never break conversation startup —
        // diagnostics aggregation skips fields it cannot read instead of
        // throwing through the VOTC:IN handler.
        if (fact.category !== undefined) {
            categoryCounts[fact.category] = (categoryCounts[fact.category] ?? 0) + 1;
        }
        if (fact.subject !== undefined) {
            entityKeys.add(`${fact.subject.type}:${fact.subject.id}`);
        }
        if (fact.object !== undefined) {
            entityKeys.add(`${fact.object.type}:${fact.object.id}`);
        }
        const numeric = fact.asOfGameDate?.numeric;
        if (typeof numeric === 'number' && numeric > maxAsOfNumeric) {
            maxAsOfNumeric = numeric;
            asOfGameDateDisplay = fact.asOfGameDate.display;
        }
    }
    return {
        status: context.snapshotStatus,
        code: context.diagnostics.errorCode,
        sourceFormat: context.snapshot?.sourceFormat,
        ck3Version: context.snapshot?.ck3Version,
        parserVersion: context.snapshot?.parserVersion,
        asOfGameDateDisplay,
        factCount: context.baselineFacts.length,
        entityCount: entityKeys.size,
        categoryCounts,
        injectedFactCount: usageTelemetry?.lastInjectedFactCount ?? 0,
        injectedTokenCount: usageTelemetry?.lastInjectedTokenCount ?? 0,
        ...(context.diagnostics.preparationTelemetry !== undefined
            ? { preparationTelemetry: { ...context.diagnostics.preparationTelemetry } }
            : {}),
        ...(usageTelemetry !== undefined
            ? { usageTelemetry: structuredClone(usageTelemetry) }
            : {}),
        warningCodes: [...context.diagnostics.warningCodes]
    };
}

// ---------------------------------------------------------------------------
// Sidecar wire DTOs (plan 5.3 request, 5.4 response)
// ---------------------------------------------------------------------------

export interface SaveFactExtractionRequestV1 {
    protocolVersion: 2;
    operation: 'probe' | 'extract';
    expected: {
        playerCharacterId: string;
        participantCharacterIds: string[];
        gameDateNumeric: number;
        campaignId: string;
        campaignIdParts: [number, number, number, number];
        snapshotSequence: number;
        snapshotSlot: 0 | 1;
    };
    categories: SaveFactCategory[];
    limits: {
        maxFacts: number;
        maxEntities: number;
        maxRelatedCharacters: number;
        maxOutputBytes: number;
        maxDecompressedBytes: number;
        maxNestingDepth: number;
        maxScalarBytes: number;
    };
}

// ---------------------------------------------------------------------------
// Typed verification protocol (P1-A, protocol v2)
// ---------------------------------------------------------------------------

export interface SaveFactCapabilitiesRequestV1 {
    protocolVersion: 1;
    operation: 'capabilities';
}

export interface SaveFactCapabilityV1 {
    operation: 'probe' | 'extract' | 'verify' | 'session';
    protocolVersion: 1 | 2 | 3;
}

export interface SaveFactCapabilitiesResultV1 {
    protocolVersion: 1;
    operation: 'capabilities';
    status: 'ok' | 'unsupported';
    capabilities: readonly SaveFactCapabilityV1[];
    parserVersion?: string;
}

export interface SaveVerificationExpectedIdentityV2 {
    playerCharacterId: string;
    participantCharacterIds: readonly string[];
    gameDateNumeric: number;
    campaignId: string;
    campaignIdParts: readonly [number, number, number, number];
    snapshotSequence: number;
    snapshotSlot: 0 | 1;
    sourceFingerprint: string;
}

/**
 * Immutable main-process seam shared by SaveSnapshotCoordinator and Agency.
 * The path is scoped by the coordinator and the identity block is copied from
 * the probe manifest; no caller may substitute a latest-save lookup.
 */
export interface SaveFactVerificationSnapshotRef {
    inputPath: string;
    allowedRootPath: string;
    expected: SaveVerificationExpectedIdentityV2;
    sourceFingerprint: string;
    sequence: number;
    slot: 0 | 1;
}

export type SaveVerificationSkill = 'diplomacy' | 'martial' | 'stewardship' | 'intrigue' | 'learning' | 'prowess';
export type SaveVerificationCouncilPosition = 'chancellor' | 'marshal' | 'steward' | 'spymaster' | 'court_chaplain';
export type SaveVerificationCourtPosition = 'physician' | 'bodyguard' | 'seneschal' | 'food_taster' | 'court_tutor';

export interface SaveVerificationCheckBaseV2 {
    checkId: string;
    characterId: string;
}

export type SaveVerificationCheckV2 =
    | (SaveVerificationCheckBaseV2 & { kind: 'character_life_state' })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_has_trait'; traitId: number })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_skill_at_least'; skill: SaveVerificationSkill; value: number })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_has_council_position'; position: SaveVerificationCouncilPosition })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_has_court_position'; position: SaveVerificationCourtPosition })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_is_commander' })
    | (SaveVerificationCheckBaseV2 & { kind: 'character_gold_at_least'; value: number });

export interface SaveVerificationRequestV2 {
    protocolVersion: 2;
    operation: 'verify';
    expected: SaveVerificationExpectedIdentityV2;
    checks: readonly SaveVerificationCheckV2[];
    limits: {
        maxChecks: number;
        maxCharacters: number;
        maxOutputBytes: number;
        maxDecompressedBytes: number;
        maxNestingDepth: number;
        maxScalarBytes: number;
    };
}

export type SaveVerificationUnknownReason =
    | 'CHARACTER_NOT_FOUND'
    | 'FIELD_NOT_AVAILABLE'
    | 'SAVE_VERSION_UNSUPPORTED'
    | 'PARTIAL_PARSE'
    | 'LIMIT_EXCEEDED';

export type SaveVerificationResultV2 =
    | { checkId: string; kind: 'character_life_state'; status: 'known'; lifeState: 'living' | 'dead' }
    | { checkId: string; kind: Exclude<SaveVerificationCheckV2['kind'], 'character_life_state'>; status: 'known'; value: boolean }
    | { checkId: string; kind: SaveVerificationCheckV2['kind']; status: 'unknown'; reasonCode: SaveVerificationUnknownReason };

export interface SaveVerificationResponseV2 {
    protocolVersion: 2;
    operation: 'verify';
    status: 'ok' | 'partial' | 'unsupported' | 'invalid';
    manifest: Pick<SaveSnapshotManifest, 'sourceFingerprint' | 'sourceFormat' | 'parserVersion' | 'factSchemaVersion'>;
    identity: {
        playerCharacterId?: string;
        gameDateNumeric?: number;
        campaignIdParts?: readonly [number, number, number, number];
        snapshotSequence?: number;
        snapshotSlot?: 0 | 1;
    };
    results: readonly SaveVerificationResultV2[];
    warnings: readonly { code: string }[];
    error?: { code: SaveFactErrorCode };
    metrics: { durationMs: number; checkedCount: number };
}

export interface CanonicalEntityV1 {
    type: 'character' | 'title' | 'war' | 'activity' | 'location';
    id: string;
    displayNameCandidate?: {
        kind: 'literal' | 'localization_key';
        value: string;
    };
}

export interface WarEntityRef extends EntityRef {
    type: 'war';
}

export type WarFactShape =
    | { predicate: 'character.at_war'; subject: EntityRef & { type: 'character' }; object: WarEntityRef; value?: never }
    | { predicate: 'war.attacker' | 'war.defender'; subject: WarEntityRef; object: EntityRef & { type: 'character' | 'title' }; value?: never }
    | { predicate: 'war.casus_belli'; subject: WarEntityRef; object?: never; value: WarCasusBelli }
    | { predicate: 'character.war_score_band'; subject: EntityRef & { type: 'character' }; object: WarEntityRef; value: WarScoreBand };

export type ActivityFactShape =
    | { predicate: 'character.current_activity'; subject: EntityRef & { type: 'character' }; object: EntityRef & { type: 'activity' }; value: ActivityType }
    | { predicate: 'character.traveling'; subject: EntityRef & { type: 'character' }; object?: never; value: boolean }
    | { predicate: 'character.public_location'; subject: EntityRef & { type: 'character' }; object: EntityRef & { type: 'location' }; value?: never }
    | { predicate: 'activity.location'; subject: EntityRef & { type: 'activity' }; object: EntityRef & { type: 'location' }; value?: never };

export const COUNCIL_POSITION_VALUES = ['chancellor', 'marshal', 'steward', 'spymaster', 'court_chaplain'] as const;
export type CouncilPosition = (typeof COUNCIL_POSITION_VALUES)[number];
export const COURT_POSITION_VALUES = ['physician', 'bodyguard', 'seneschal', 'food_taster', 'court_tutor'] as const;
export type CourtPosition = (typeof COURT_POSITION_VALUES)[number];

export type CourtFactShape =
    | { predicate: 'character.council_position'; subject: EntityRef & { type: 'character' }; value: CouncilPosition; object?: never }
    | { predicate: 'character.court_position'; subject: EntityRef & { type: 'character' }; value: CourtPosition; object?: never }
    | { predicate: 'character.court_owner'; subject: EntityRef & { type: 'character' }; object: EntityRef & { type: 'character' }; value?: never };

export type RealmFactShape =
    | { predicate: 'character.direct_vassal_of'; subject: EntityRef & { type: 'character' }; object: EntityRef & { type: 'character' }; value?: never }
    | { predicate: 'character.realm_capital'; subject: EntityRef & { type: 'character' }; object: EntityRef & { type: 'title' }; value?: never };

/**
 * A fact as emitted by the sidecar: always `source: 'save_snapshot'`, a
 * registry predicate, a canonical source path enum, and only the provenance
 * the sidecar can know (snapshot/campaign; timeline fields are filled by the
 * app).
 */
export interface ExtractedGameFactV1 {
    id: string;
    category: SaveFactCategory;
    subject: EntityRef;
    predicate: SaveFactPredicate;
    object?: EntityRef;
    value?: string | number | boolean;
    asOfGameDate: {
        numeric?: number;
        display?: string;
    };
    source: 'save_snapshot';
    sourcePath: SaveFactSourcePath;
    confidence: FactConfidence;
    visibility: FactVisibility;
    knownByCharacterIds?: string[];
    /** Wire-optional; the validator fills 0 when the sidecar omits it. */
    priority: number;
    sensitivity: FactSensitivity;
    provenance: {
        snapshotId?: string;
        campaignId?: string;
        /** Optional sidecar echo of the snapshot sequence (informational). */
        snapshotSequence?: number;
    };
}

export type SaveFactOperation = 'probe' | 'extract';
export type SaveFactResultStatus = 'ok' | 'partial' | 'unsupported' | 'invalid';

export interface SaveFactExtractionResultV1 {
    protocolVersion: 2;
    operation: SaveFactOperation;
    status: SaveFactResultStatus;
    manifest: SaveSnapshotManifest;
    identity?: {
        playerCharacterId?: string;
        gameDateNumeric?: number;
        gameDateDisplay?: string;
        campaignIdParts?: [number, number, number, number];
        snapshotSequence?: number;
        snapshotSlot?: number;
        scriptVariableScale?: number;
    };
    /**
     * Ordered decimal CK3 runtime IDs of the same-location join candidates
     * from the snapshot's root `variables.list` `votc_join_candidates` global
     * list (Plan C Task 2b). Transport data for the App join coordinator —
     * never an LLM fact, never projected, never renderer-facing. Absent on
     * old saves / dropped on malformed input.
     */
    joinCandidates?: string[];
    entities: CanonicalEntityV1[];
    facts: ExtractedGameFactV1[];
    warnings: Array<{ code: string; category?: string }>;
    error?: { code: SaveFactErrorCode };
    metrics: {
        inputBytes: number;
        decompressedBytes?: number;
        durationMs: number;
        emittedFacts: number;
        emittedEntities: number;
        /** Optional: gamestate bytes the probe actually scanned (early stop). */
        scannedBytes?: number;
    };
}
