/**
 * Deterministic topic retrieval primitives (implementation plan Task 15
 * steps 1-4).
 *
 * Everything in this module is pure and deterministic: the same input always
 * produces the same alias map, topic set, scores and ordering. No LLM call,
 * no randomness, no wall-clock input.
 *
 * - Alias map: built ONLY from already-validated display names (resolved
 *   entity names and live GameData character fields). Raw localization keys
 *   and arbitrary save scalars never become aliases.
 * - Query text: only the most recent user/player message plus at most the
 *   last 6 live history messages, capped at 4,000 chars total; the oldest
 *   text is trimmed first.
 * - Topic lexicon: fixed English + Simplified Chinese keyword lists. Keywords
 *   are topic HINTS only; they never generate facts by themselves.
 * - Scoring: the plan's fixed formula with a deterministic tie-break chain.
 */

import type { GameData } from '../../shared/gameData/GameData';
import type { Character } from '../../shared/gameData/Character';
import { saveFactEntityKey } from './SaveFactIndex';
import { sanitizeDisplayName } from './SaveFactNameResolver';
import type {
    EntityRef,
    FactQuery,
    FactScoreBreakdown,
    FactTopic,
    GameFact
} from './saveFactTypes';

// ---------------------------------------------------------------------------
// Query text bounding (plan Task 15 step 2)
// ---------------------------------------------------------------------------

/** Total character cap across the user message and live history. */
export const FACT_QUERY_MAX_TOTAL_CHARS = 4000;
/** Maximum number of live history messages considered. */
export const FACT_QUERY_MAX_HISTORY_MESSAGES = 6;

export interface FactQueryTextMessage {
    /** `user`/`player` messages feed `recentUserText`; `system` is ignored. */
    role: string;
    text: string;
}

export interface FactQueryText {
    recentUserText: string;
    recentConversationText: string;
}

function isUserRole(role: string): boolean {
    return role === 'user' || role === 'player';
}

/**
 * Enforce the 4,000-char total cap on an already-split user/history pair.
 * Older history is trimmed first; the user message is only trimmed (from the
 * front, keeping the newest text) when it alone exceeds the cap.
 */
export function boundFactQueryText(recentUserText: string, recentConversationText: string): FactQueryText {
    let userText = recentUserText;
    let historyText = recentConversationText;
    const overBy = userText.length + historyText.length - FACT_QUERY_MAX_TOTAL_CHARS;
    if (overBy > 0) {
        // Trim the oldest history first (history is oldest -> newest).
        historyText = historyText.slice(Math.min(historyText.length, overBy));
        const stillOverBy = userText.length + historyText.length - FACT_QUERY_MAX_TOTAL_CHARS;
        if (stillOverBy > 0) {
            userText = userText.slice(stillOverBy);
        }
    }
    return { recentUserText: userText, recentConversationText: historyText };
}

/**
 * Build the bounded query text from a conversation message list: the most
 * recent user/player message plus at most the last 6 live (non-system)
 * history messages. Scene/suggestion callers pass their own purpose-specific
 * context as history instead of fabricating a user message.
 */
export function buildFactQueryText(messages: readonly FactQueryTextMessage[]): FactQueryText {
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isUserRole(messages[i].role)) {
            userIndex = i;
            break;
        }
    }
    const recentUserText = userIndex >= 0 ? messages[userIndex].text : '';

    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0 && history.length < FACT_QUERY_MAX_HISTORY_MESSAGES; i--) {
        if (i === userIndex || messages[i].role === 'system') continue;
        history.unshift(messages[i].text);
    }
    // Trim the oldest history messages first (whole messages, then chars).
    while (
        history.length > 0
        && recentUserText.length + history.join('\n').length > FACT_QUERY_MAX_TOTAL_CHARS
    ) {
        history.shift();
    }
    return boundFactQueryText(recentUserText, history.join('\n'));
}

/**
 * The single bounded text the projector matches aliases and topic keywords
 * against. `FactQuery` fields are treated as untrusted and re-bounded here.
 */
export function combineFactQueryText(query: Pick<FactQuery, 'recentUserText' | 'recentConversationText'>): string {
    const bounded = boundFactQueryText(query.recentUserText, query.recentConversationText);
    return bounded.recentConversationText.length > 0
        ? `${bounded.recentUserText}\n${bounded.recentConversationText}`
        : bounded.recentUserText;
}

/**
 * The strong-admission mention set. The query resolver supplies the latest
 * player message here; unlike `combineFactQueryText`, this deliberately does
 * not include bounded history or AI-authored text.
 */
export function findLatestPlayerMentionedEntityKeys(
    latestPlayerText: string,
    aliasMap: ReadonlyMap<string, readonly EntityRef[]>
): ReadonlySet<string> {
    return findMentionedEntityKeys(boundFactQueryText(latestPlayerText, '').recentUserText, aliasMap);
}

// ---------------------------------------------------------------------------
// Topic lexicon (plan Task 15 step 3). Keywords are hints only.
// ---------------------------------------------------------------------------

/**
 * Fixed bilingual (English + Simplified Chinese) topic word lists. English
 * keywords match on word boundaries case-insensitively; Chinese keywords match
 * as plain substrings. First release maps only family/titles/liege onto
 * actual fact predicates; war/activity/artifact keywords select only their
 * own bounded category facts.
 */
export const SAVE_FACT_TOPIC_LEXICON: Readonly<Record<FactTopic, readonly string[]>> = {
    family: [
        'family', 'marriage', 'married', 'marry', 'wife', 'wives', 'husband', 'spouse', 'consort',
        'child', 'children', 'son', 'daughter', 'parent', 'parents', 'father', 'mother', 'heir',
        '家庭', '家族', '婚姻', '婚配', '妻子', '丈夫', '配偶', '夫人', '成亲', '结婚',
        '孩子', '儿女', '儿子', '女儿', '父母', '父亲', '母亲', '继承人'
    ],
    titles: [
        'title', 'titles', 'realm', 'kingdom', 'duchy', 'county', 'claim', 'claims',
        'inheritance', 'succession', 'domain', 'landed',
        '头衔', '领地', '领土', '王国', '公国', '伯爵领', '宣称', '继承', '继承权', '封地'
    ],
    liege: [
        'liege', 'vassal', 'vassals', 'court', 'council', 'lord', 'overlord', 'ruler', 'suzerain',
        '领主', '封臣', '廷臣', '宫廷', '朝廷', '议会', '君主', '宗主', '统治者'
    ],
    war: [
        'war', 'wars', 'enemy', 'enemies', 'ally', 'allies', 'army', 'armies', 'battle', 'siege',
        'military', 'troops', 'soldier', 'soldiers',
        '战争', '开战', '敌人', '盟友', '军队', '军事', '军务', '兵力', '士兵', '战事',
        '战役', '会战', '围攻', '围城'
    ],
    activity: [
        'travel', 'feast', 'activity', 'hunt', 'hunting', 'pilgrimage', 'tournament', 'location',
        '旅行', '宴会', '活动', '狩猎', '打猎', '朝圣', '比武', '地点'
    ],
    court: [
        'council', 'court position', 'court office', 'office', 'councillor',
        '议会', '内阁', '宫廷职位', '职位', '官职'
    ],
    artifact: [
        'artifact', 'artifacts', 'treasure', 'relic', 'crown', 'sword',
        '宝物', '珍宝', '圣物', '王冠', '宝剑'
    ]
};

/** Fixed detection order so repeated calls return identically ordered topics. */
const TOPIC_DETECTION_ORDER: readonly FactTopic[] = ['family', 'titles', 'liege', 'war', 'activity', 'court', 'artifact'];

const ASCII_WORD_PATTERN = /^[\x20-\x7E]+$/;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the keyword occurs in the (already NFC-normalized) text. */
function keywordMatches(text: string, keyword: string): boolean {
    if (ASCII_WORD_PATTERN.test(keyword)) {
        return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(text);
    }
    return text.includes(keyword);
}

/** Detect topic hints in bounded query text. Fixed order, no duplicates. */
export function detectFactTopics(queryText: string): FactTopic[] {
    const text = queryText.normalize('NFC');
    const detected: FactTopic[] = [];
    for (const topic of TOPIC_DETECTION_ORDER) {
        if (SAVE_FACT_TOPIC_LEXICON[topic].some(keyword => keywordMatches(text, keyword))) {
            detected.push(topic);
        }
    }
    return detected;
}

/**
 * Whether a fact is relevant to a topic. War is a bounded category gate: the
 * topic only admits already-validated public war facts into the dynamic lane.
 */
export function factMatchesTopic(fact: GameFact, topic: FactTopic): boolean {
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

// ---------------------------------------------------------------------------
// Alias map (plan Task 15 step 1)
// ---------------------------------------------------------------------------

/**
 * Language-appropriate alias normalization: Unicode NFC, whitespace folded,
 * and case folding applied to ASCII letters only (Chinese characters are
 * unaffected by case folding either way, but folding is deliberately limited
 * to A-Z so no locale-sensitive lowercasing ever runs).
 */
export function normalizeFactAliasKey(name: string): string {
    return name
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/**
 * Validated display-name variants for one live character: `fullName`,
 * `shortName` (the CK3 title+name form, e.g. "Count Janos"), `firstName`,
 * and the explicit title+name variant. Every variant passes the display-name
 * sanitizer; raw loc keys and control-laden strings are dropped.
 */
export function characterNameVariants(character: Character): string[] {
    const variants: string[] = [];
    const push = (value: string | undefined): void => {
        if (value === undefined) return;
        const sanitized = sanitizeDisplayName(value);
        if (sanitized !== undefined && !variants.includes(sanitized)) variants.push(sanitized);
    };
    push(character.fullName);
    push(character.shortName);
    push(character.firstName);
    // Explicit title + first-name variant (e.g. shortName was customized).
    if (character.primaryTitle !== undefined && character.firstName !== undefined) {
        push(`${character.primaryTitle} ${character.firstName}`);
    }
    return variants;
}

export interface FactAliasSource {
    ref: EntityRef;
    /** Already-sanitized display names for this entity. */
    names: readonly string[];
}

/**
 * Build the alias map: normalized alias -> entity refs. Only the validated
 * names handed in by the caller become aliases; the map never sees raw save
 * scalars or localization keys.
 */
export function buildFactAliasMap(sources: readonly FactAliasSource[]): ReadonlyMap<string, readonly EntityRef[]> {
    const buckets = new Map<string, EntityRef[]>();
    for (const source of sources) {
        for (const name of source.names) {
            const key = normalizeFactAliasKey(name);
            if (key.length === 0) continue;
            let bucket = buckets.get(key);
            if (bucket === undefined) {
                bucket = [];
                buckets.set(key, bucket);
            }
            if (!bucket.some(ref => ref.type === source.ref.type && ref.id === source.ref.id)) {
                bucket.push(source.ref);
            }
        }
    }
    const frozen = new Map<string, readonly EntityRef[]>();
    for (const [key, bucket] of buckets) frozen.set(key, Object.freeze(bucket.slice()));
    return frozen;
}

/**
 * Find every entity explicitly mentioned in the query text. Pure-ASCII
 * aliases match on word boundaries (so "An" never matches "Anna"); aliases
 * containing non-ASCII (e.g. Chinese names) match as substrings.
 */
export function findMentionedEntityKeys(
    queryText: string,
    aliasMap: ReadonlyMap<string, readonly EntityRef[]>
): ReadonlySet<string> {
    const text = normalizeFactAliasKey(queryText);
    const mentioned = new Set<string>();
    if (text.length === 0) return mentioned;
    for (const [alias, refs] of aliasMap) {
        const hit = ASCII_WORD_PATTERN.test(alias)
            ? new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(text)
            : text.includes(alias);
        if (hit) {
            for (const ref of refs) mentioned.add(saveFactEntityKey(ref));
        }
    }
    return mentioned;
}

/**
 * A direct mention is an admission signal only when it names an endpoint
 * outside the participant set. Mentioning a participant alone must not open
 * that character's entire fact neighbourhood; scalar participant facts are
 * therefore excluded here as well.
 */
export function hasDirectRelevantEndpointMention(
    fact: GameFact,
    mentionedEntityKeys: ReadonlySet<string>,
    participantCharacterIds: ReadonlySet<string>
): boolean {
    const endpoints = [fact.subject, fact.object].filter(
        (endpoint): endpoint is EntityRef => endpoint !== undefined
    );
    return endpoints.some(endpoint => {
        const isParticipant = endpoint.type === 'character'
            && participantCharacterIds.has(endpoint.id);
        return !isParticipant && mentionedEntityKeys.has(saveFactEntityKey(endpoint));
    });
}

// ---------------------------------------------------------------------------
// Deterministic scoring (plan Task 15 step 4)
// ---------------------------------------------------------------------------

export interface FactScoreInput {
    fact: GameFact;
    /** Entity keys (`type:id`) explicitly mentioned in the query text. */
    mentionedEntityKeys: ReadonlySet<string>;
    /** Active topics (query hints + detected keywords). */
    topics: readonly FactTopic[];
    speakerCharacterId: string;
    targetCharacterIds: ReadonlySet<string>;
    participantCharacterIds: ReadonlySet<string>;
    /** True when any display name the fact needs could not be resolved. */
    hasUnresolvedName: boolean;
    /** True when an earlier fact already carries the same semantics. */
    isDuplicate: boolean;
}

function involvesCharacter(fact: GameFact, characterId: string): boolean {
    const key = `character:${characterId}`;
    return saveFactEntityKey(fact.subject) === key
        || (fact.object !== undefined && saveFactEntityKey(fact.object) === key);
}

function involvesAnyCharacter(fact: GameFact, characterIds: ReadonlySet<string>): boolean {
    for (const id of characterIds) {
        if (involvesCharacter(fact, id)) return true;
    }
    return false;
}

/** The plan's fixed scoring formula. Every component is 0 or its weight. */
export function scoreFact(input: FactScoreInput): { score: number; components: FactScoreBreakdown } {
    const subjectKey = saveFactEntityKey(input.fact.subject);
    const objectKey = input.fact.object !== undefined ? saveFactEntityKey(input.fact.object) : undefined;

    const components: FactScoreBreakdown = {
        directMention: (input.mentionedEntityKeys.has(subjectKey)
            || (objectKey !== undefined && input.mentionedEntityKeys.has(objectKey))) ? 100 : 0,
        speaker: involvesCharacter(input.fact, input.speakerCharacterId) ? 60 : 0,
        replyTarget: involvesAnyCharacter(input.fact, input.targetCharacterIds) ? 50 : 0,
        topic: input.topics.some(topic => factMatchesTopic(input.fact, topic)) ? 40 : 0,
        participant: involvesAnyCharacter(input.fact, input.participantCharacterIds) ? 25 : 0,
        confidence: input.fact.confidence === 'exact' ? 20 : 0,
        priority: input.fact.priority,
        unresolvedName: input.hasUnresolvedName ? -30 : 0,
        duplicate: input.isDuplicate ? -20 : 0
    };
    const score = components.directMention
        + components.speaker
        + components.replyTarget
        + components.topic
        + components.participant
        + components.confidence
        + components.priority
        + components.unresolvedName
        + components.duplicate;
    return { score, components };
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Deterministic ordering: score descending, then category, subject type/id,
 * predicate, object type/id and finally fact ID, all ascending. Two runs over
 * the same candidates always produce the same order.
 */
export function compareScoredFacts(
    a: { fact: GameFact; score: number },
    b: { fact: GameFact; score: number }
): number {
    if (a.score !== b.score) return b.score - a.score;
    let diff = compareStrings(a.fact.category, b.fact.category);
    if (diff !== 0) return diff;
    diff = compareStrings(a.fact.subject.type, b.fact.subject.type);
    if (diff !== 0) return diff;
    diff = compareStrings(a.fact.subject.id, b.fact.subject.id);
    if (diff !== 0) return diff;
    diff = compareStrings(a.fact.predicate, b.fact.predicate);
    if (diff !== 0) return diff;
    diff = compareStrings(a.fact.object?.type ?? '', b.fact.object?.type ?? '');
    if (diff !== 0) return diff;
    diff = compareStrings(a.fact.object?.id ?? '', b.fact.object?.id ?? '');
    if (diff !== 0) return diff;
    return compareStrings(a.fact.id, b.fact.id);
}

/** Semantic identity used for duplicate detection: same relation, same ends. */
export function factSemanticKey(fact: GameFact): string {
    const objectKey = fact.object !== undefined ? saveFactEntityKey(fact.object) : '';
    return `${fact.predicate}|${saveFactEntityKey(fact.subject)}|${objectKey}`;
}

// ---------------------------------------------------------------------------
// Live GameData lookup helper shared by the projector's alias building.
// ---------------------------------------------------------------------------

/** Live character lookup: save entity ids are strings, GameData keys are numbers. */
export function findLiveCharacter(gameData: GameData | undefined, id: string): Character | undefined {
    if (gameData === undefined || !/^\d+$/.test(id)) return undefined;
    return gameData.characters.get(Number(id));
}
