/**
 * Source-authority resolution for save facts (implementation plan Task 14
 * step 3). First release is per-predicate:
 *
 * - Person names, dates, locations and primary-title display: live GameData
 *   wins. Live `fullName` always overrides a save-resolved `displayName`, and
 *   a live `primaryTitle` overrides the display of a `character.primary_title`
 *   fact's object (rewrite, not drop).
 * - The save provides stable relation ids and objective structure GameData
 *   does not have (parents/children, title holders): those facts are kept.
 * - `character.spouse` / `character.liege`: when GameData already carries an
 *   explicit consort/liege text for the subject AND it conflicts with the
 *   save-resolved object name, the save fact is DROPPED and a
 *   `FACT_CONFLICT_LIVE` warning is recorded (code + category only, never
 *   the conflicting content).
 * - A complete live `militarySnapshot` wins for a canonically mapped war's
 *   primary attacker/defender and for a participant-relative score band.
 *   War ids, character ids and the participant side must all map exactly;
 *   missing/truncated/ambiguous live data never creates a negative claim.
 *   Save CB/title-side facts are retained because the live representation is
 *   not equivalent enough to compare safely.
 * - Chronicle/summary narrates history and never overrides the current save;
 *   model claims made in conversation are never written as hard facts. Both
 *   are enforced here defensively: only `save_snapshot` / `live_gamedata`
 *   sourced facts survive this resolver.
 *
 * Input facts are never mutated; accepted facts are shallow copies.
 */

import type { GameData, WarInfo, WarSide } from '../../shared/gameData/GameData';
import type { Character } from '../../shared/gameData/Character';
import { looksLikeRawLocKey } from './SaveFactStore';
import { sanitizeDisplayName } from './SaveFactNameResolver';
import type { EntityRef, GameFact, WarScoreBand } from './saveFactTypes';

/** Warning codes. Diagnostics record code + category only, never content. */
export const FACT_CONFLICT_LIVE = 'FACT_CONFLICT_LIVE';
export const FACT_SOURCE_REJECTED = 'FACT_SOURCE_REJECTED';

export interface SaveFactAuthorityWarning {
    code: string;
    category?: string;
}

export interface SaveFactAuthorityContext {
    gameData?: GameData;
    /**
     * Save-side name resolution for the object of a relation fact, typically
     * `resolveEntityDisplayName` from `SaveFactNameResolver.ts`. Used to
     * compare the save-resolved name against the live consort/liege text.
     */
    resolveName?: (ref: EntityRef) => string | undefined;
}

export interface SaveFactAuthorityResult {
    facts: GameFact[];
    warnings: SaveFactAuthorityWarning[];
}

/** Sources accepted as hard facts. Chronicle/conversation claims never qualify. */
const HARD_FACT_SOURCES: ReadonlySet<string> = new Set(['save_snapshot', 'live_gamedata']);

function findLiveCharacter(gameData: GameData | undefined, id: string): Character | undefined {
    if (gameData === undefined || !/^\d+$/.test(id)) return undefined;
    return gameData.characters.get(Number(id));
}

/** Live free-text fields count as "present" only when they sanitize to a real name. */
function liveText(value: string | undefined): string | undefined {
    if (value === undefined || value.trim().length === 0) return undefined;
    if (looksLikeRawLocKey(value)) return undefined;
    return sanitizeDisplayName(value);
}

function namesMatch(a: string, b: string): boolean {
    return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

function withDisplayName(ref: EntityRef, displayName: string): EntityRef {
    return { ...ref, displayName };
}

/**
 * Live military DTOs use numeric ids while save facts use strings. Only a
 * canonical, safe decimal string is considered the same identity; accepting
 * leading zeroes, rounded large integers or free text would turn a display
 * coincidence into an authority decision.
 */
function canonicalNumericId(id: string): number | undefined {
    if (!/^(0|[1-9]\d*)$/.test(id)) return undefined;
    const value = Number(id);
    if (!Number.isSafeInteger(value) || String(value) !== id) return undefined;
    return value;
}

function findCompleteLiveWar(gameData: GameData | undefined, ref: EntityRef | undefined): WarInfo | undefined {
    const snapshot = gameData?.militarySnapshot;
    if (snapshot?.complete !== true || ref?.type !== 'war') return undefined;
    const id = canonicalNumericId(ref.id);
    return id === undefined ? undefined : snapshot.wars.get(id);
}

function liveWarForFact(gameData: GameData | undefined, fact: GameFact): WarInfo | undefined {
    if (fact.subject.type === 'war') return findCompleteLiveWar(gameData, fact.subject);
    return findCompleteLiveWar(gameData, fact.object);
}

function mappedCharacterId(ref: EntityRef | undefined): number | undefined {
    return ref?.type === 'character' ? canonicalNumericId(ref.id) : undefined;
}

function scoreBand(score: number, participantSide: WarSide): WarScoreBand | undefined {
    if (!Number.isFinite(score) || !Number.isInteger(score) || score < -100 || score > 100) return undefined;
    const perspective = participantSide === 'attacker' ? score : -score;
    if (perspective <= -75) return 'decisive_loss';
    if (perspective <= -26) return 'losing';
    if (perspective <= 25) return 'balanced';
    if (perspective <= 74) return 'winning';
    return 'decisive_win';
}

/**
 * Return a side only when every available live signal agrees. The explicit
 * player-side field is safe because the military snapshot contains only the
 * player's wars. For other characters we require a primary-side or bounded
 * participant entry; absence is not treated as "not at war".
 */
function findLiveParticipantSide(gameData: GameData, war: WarInfo, characterId: number): WarSide | undefined {
    const sides = new Set<WarSide>();
    const addSide = (side: unknown): void => {
        if (side === 'attacker' || side === 'defender') sides.add(side);
    };
    if (war.primaryAttacker.id === characterId) sides.add('attacker');
    if (war.primaryDefender.id === characterId) sides.add('defender');
    for (const participant of war.participants) {
        if (participant.character.id === characterId) addSide(participant.side);
    }
    if (gameData.playerID === characterId) addSide(war.playerSide);
    return sides.size === 1 ? sides.values().next().value : undefined;
}

function withLiveWarDisplay(fact: GameFact, war: WarInfo): GameFact {
    const name = liveText(war.name);
    if (name === undefined) return fact;
    if (fact.subject.type === 'war') return { ...fact, subject: withDisplayName(fact.subject, name) };
    if (fact.object?.type === 'war') return { ...fact, object: withDisplayName(fact.object, name) };
    return fact;
}

function conflictsWithLiveWar(fact: GameFact, gameData: GameData | undefined, war: WarInfo): boolean {
    if (fact.predicate === 'war.attacker' || fact.predicate === 'war.defender') {
        // The live DTO exposes primary sides as characters. A save title-side
        // cannot be compared to that representation and therefore remains a
        // save-supplied public field.
        const saveCharacterId = mappedCharacterId(fact.object);
        if (saveCharacterId === undefined) return false;
        const liveSide = fact.predicate === 'war.attacker' ? war.primaryAttacker : war.primaryDefender;
        if (!Number.isSafeInteger(liveSide.id) || liveSide.id < 0) return false;
        return saveCharacterId !== liveSide.id;
    }

    if (fact.predicate === 'character.war_score_band') {
        const characterId = mappedCharacterId(fact.subject);
        if (characterId === undefined || gameData === undefined) return false;
        const side = findLiveParticipantSide(gameData, war, characterId);
        if (side === undefined) return false;
        const liveBand = scoreBand(war.score.total, side);
        return liveBand !== undefined && fact.value !== liveBand;
    }

    // `character.at_war` agrees positively when the mapped live war contains
    // the player/participant. Its absence from a participant list is not a
    // reliable contradiction (the list may be capped, or the save relevance
    // rule may have reached the character through a direct liege). CB values
    // likewise have no stable live enum mapping yet.
    return false;
}

/**
 * Apply the per-predicate authority rules. Returns the surviving facts (with
 * live display names applied where GameData is authoritative) plus bounded
 * warnings for every dropped fact.
 */
export function applySaveFactAuthority(
    facts: readonly GameFact[],
    context: SaveFactAuthorityContext
): SaveFactAuthorityResult {
    const accepted: GameFact[] = [];
    const warnings: SaveFactAuthorityWarning[] = [];

    for (const fact of facts) {
        // Chronicle/summary/model claims never become hard facts.
        if (!HARD_FACT_SOURCES.has(fact.source)) {
            warnings.push({ code: FACT_SOURCE_REJECTED, category: fact.category });
            continue;
        }

        const liveSubject = fact.subject.type === 'character'
            ? findLiveCharacter(context.gameData, fact.subject.id)
            : undefined;

        let next: GameFact = { ...fact };

        // Live fullName always wins for display, on both ends of the fact.
        if (liveSubject !== undefined) {
            const name = liveText(liveSubject.fullName);
            if (name !== undefined) next.subject = withDisplayName(next.subject, name);
        }
        if (next.object?.type === 'character') {
            const liveObject = findLiveCharacter(context.gameData, next.object.id);
            const name = liveObject !== undefined ? liveText(liveObject.fullName) : undefined;
            if (name !== undefined) next.object = withDisplayName(next.object, name);
        }

        if (fact.predicate === 'character.spouse' || fact.predicate === 'character.liege') {
            const liveRelation = liveSubject !== undefined
                ? liveText(fact.predicate === 'character.spouse' ? liveSubject.consort : liveSubject.liege)
                : undefined;
            if (liveRelation !== undefined && next.object !== undefined) {
                const saveName = context.resolveName?.(next.object) ?? liveText(next.object.displayName);
                if (saveName !== undefined && !namesMatch(liveRelation, saveName)) {
                    // Live GameData explicitly disagrees with the save: drop the save fact.
                    warnings.push({ code: FACT_CONFLICT_LIVE, category: fact.category });
                    continue;
                }
                // Agreement (or unresolved save name): live text is the display authority.
                next.object = withDisplayName(next.object, liveRelation);
            }
        } else if (fact.predicate === 'character.primary_title') {
            // Primary-title display: GameData wins outright (rewrite, never drop).
            const liveTitle = liveSubject !== undefined ? liveText(liveSubject.primaryTitle) : undefined;
            if (liveTitle !== undefined && next.object !== undefined) {
                next.object = withDisplayName(next.object, liveTitle);
            }
        }

        const liveWar = liveWarForFact(context.gameData, fact);
        if (liveWar !== undefined) {
            if (conflictsWithLiveWar(fact, context.gameData, liveWar)) {
                warnings.push({ code: FACT_CONFLICT_LIVE, category: fact.category });
                continue;
            }
            next = withLiveWarDisplay(next, liveWar);
        }

        accepted.push(next);
    }

    return { facts: accepted, warnings };
}
