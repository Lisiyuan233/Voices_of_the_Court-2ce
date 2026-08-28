/**
 * Bounded save-fact index (implementation plan Task 14 step 1).
 *
 * Built from ALREADY VALIDATED entities + facts (see `saveFactSchemas.ts` /
 * `SaveFactStore.validatePersistedSaveFactSnapshot`). The index re-enforces
 * the fact/entity caps itself and truncates with a warning instead of
 * trusting the sidecar's self-reported limits.
 *
 * Five internal Maps are maintained: `bySubject`, `byObject`, `byCategory`,
 * `byPredicate` and `participantDistance`, all keyed by the `type:id` entity
 * key form. Only the query-method surface (`SaveFactIndex` in
 * `saveFactTypes.ts`) is exposed; callers can never reach a mutable internal
 * Map, and every returned fact array is a frozen copy.
 *
 * `participantDistance` is the BFS hop distance of an entity from the nearest
 * participant character over the undirected subject<->object fact graph:
 * participants are distance 0, entities directly related to a participant by
 * an accepted fact are distance 1, and so on. Unreachable entities have no
 * entry.
 */

import type {
    EntityRef,
    GameFact,
    SaveFactCategory,
    SaveFactIndex,
    SaveSnapshotManifest
} from './saveFactTypes';

/** Hard caps, re-checked at build time even though the wire schema enforces them. */
export const SAVE_FACT_INDEX_MAX_FACTS = 500;
export const SAVE_FACT_INDEX_MAX_ENTITIES = 250;

/** Warning codes emitted by the index build. Diagnostics carry code (+category) only, never content. */
export const SAVE_FACT_INDEX_WARNING_FACTS_TRUNCATED = 'SAVE_FACT_INDEX_FACTS_TRUNCATED';
export const SAVE_FACT_INDEX_WARNING_ENTITIES_TRUNCATED = 'SAVE_FACT_INDEX_ENTITIES_TRUNCATED';

export interface SaveFactIndexBuildWarning {
    code: string;
    category?: string;
}

export interface SaveFactIndexBuildInput {
    facts: readonly GameFact[];
    entities: readonly { type: string; id: string }[];
    manifest: SaveSnapshotManifest;
    participantCharacterIds: readonly string[];
}

export interface SaveFactIndexBuildResult {
    index: SaveFactIndex;
    warnings: SaveFactIndexBuildWarning[];
}

/** Canonical entity key used by every index Map: `type:id`. */
export function saveFactEntityKey(ref: EntityRef | { type: string; id: string }): string {
    return `${ref.type}:${ref.id}`;
}

class BoundedSaveFactIndex implements SaveFactIndex {
    readonly snapshot: SaveSnapshotManifest;
    readonly entityCount: number;

    // ECMAScript private fields: the internal Maps are unreachable at
    // runtime, so callers can only ever use the query-method surface.
    readonly #bySubject = new Map<string, readonly GameFact[]>();
    readonly #byObject = new Map<string, readonly GameFact[]>();
    readonly #byCategory = new Map<SaveFactCategory, readonly GameFact[]>();
    readonly #byPredicate = new Map<string, readonly GameFact[]>();
    readonly #distances = new Map<string, number>();

    constructor(
        facts: readonly GameFact[],
        entityKeys: ReadonlySet<string>,
        manifest: SaveSnapshotManifest,
        participantCharacterIds: readonly string[]
    ) {
        this.snapshot = manifest;
        this.entityCount = entityKeys.size;

        const subjectBuckets = new Map<string, GameFact[]>();
        const objectBuckets = new Map<string, GameFact[]>();
        const categoryBuckets = new Map<SaveFactCategory, GameFact[]>();
        const predicateBuckets = new Map<string, GameFact[]>();
        const adjacency = new Map<string, Set<string>>();

        const push = <K>(buckets: Map<K, GameFact[]>, key: K, fact: GameFact): void => {
            const bucket = buckets.get(key);
            if (bucket === undefined) {
                buckets.set(key, [fact]);
            } else {
                bucket.push(fact);
            }
        };
        const link = (a: string, b: string): void => {
            let neighbours = adjacency.get(a);
            if (neighbours === undefined) {
                neighbours = new Set<string>();
                adjacency.set(a, neighbours);
            }
            neighbours.add(b);
        };

        for (const fact of facts) {
            const subjectKey = saveFactEntityKey(fact.subject);
            push(subjectBuckets, subjectKey, fact);
            push(categoryBuckets, fact.category, fact);
            push(predicateBuckets, fact.predicate, fact);
            if (fact.object !== undefined) {
                const objectKey = saveFactEntityKey(fact.object);
                push(objectBuckets, objectKey, fact);
                link(subjectKey, objectKey);
                link(objectKey, subjectKey);
            }
        }

        for (const [key, bucket] of subjectBuckets) this.#bySubject.set(key, Object.freeze(bucket.slice()));
        for (const [key, bucket] of objectBuckets) this.#byObject.set(key, Object.freeze(bucket.slice()));
        for (const [key, bucket] of categoryBuckets) this.#byCategory.set(key, Object.freeze(bucket.slice()));
        for (const [key, bucket] of predicateBuckets) this.#byPredicate.set(key, Object.freeze(bucket.slice()));

        this.computeDistances(adjacency, participantCharacterIds);
    }

    get factCount(): number {
        let total = 0;
        for (const bucket of this.#byPredicate.values()) total += bucket.length;
        return total;
    }

    queryBySubject(key: string): readonly GameFact[] {
        return this.#bySubject.get(key) ?? EMPTY_FACTS;
    }

    queryByObject(key: string): readonly GameFact[] {
        return this.#byObject.get(key) ?? EMPTY_FACTS;
    }

    queryByCategory(category: SaveFactCategory): readonly GameFact[] {
        return this.#byCategory.get(category) ?? EMPTY_FACTS;
    }

    queryByPredicate(predicate: string): readonly GameFact[] {
        return this.#byPredicate.get(predicate) ?? EMPTY_FACTS;
    }

    participantDistance(key: string): number | undefined {
        return this.#distances.get(key);
    }

    /** BFS from every participant character over the fact relation graph. */
    private computeDistances(
        adjacency: ReadonlyMap<string, ReadonlySet<string>>,
        participantCharacterIds: readonly string[]
    ): void {
        const queue: string[] = [];
        for (const id of participantCharacterIds) {
            const key = `character:${id}`;
            if (!this.#distances.has(key)) {
                this.#distances.set(key, 0);
                queue.push(key);
            }
        }
        for (let head = 0; head < queue.length; head++) {
            const current = queue[head];
            const distance = this.#distances.get(current)!;
            const neighbours = adjacency.get(current);
            if (neighbours === undefined) continue;
            for (const next of neighbours) {
                if (this.#distances.has(next)) continue;
                this.#distances.set(next, distance + 1);
                queue.push(next);
            }
        }
    }
}

const EMPTY_FACTS: readonly GameFact[] = Object.freeze([]);

/**
 * Build the bounded index. Facts beyond `SAVE_FACT_INDEX_MAX_FACTS` and
 * entities beyond `SAVE_FACT_INDEX_MAX_ENTITIES` are truncated in input order
 * (sidecar responses are stably sorted per protocol 5.4) with a warning each;
 * the caps are enforced here even when the caller claims the input was
 * already validated.
 */
export function buildSaveFactIndex(input: SaveFactIndexBuildInput): SaveFactIndexBuildResult {
    const warnings: SaveFactIndexBuildWarning[] = [];

    let facts = input.facts;
    if (facts.length > SAVE_FACT_INDEX_MAX_FACTS) {
        facts = facts.slice(0, SAVE_FACT_INDEX_MAX_FACTS);
        warnings.push({ code: SAVE_FACT_INDEX_WARNING_FACTS_TRUNCATED });
    }

    let entities = input.entities;
    if (entities.length > SAVE_FACT_INDEX_MAX_ENTITIES) {
        entities = entities.slice(0, SAVE_FACT_INDEX_MAX_ENTITIES);
        warnings.push({ code: SAVE_FACT_INDEX_WARNING_ENTITIES_TRUNCATED });
    }

    const entityKeys = new Set<string>();
    for (const entity of entities) {
        entityKeys.add(saveFactEntityKey(entity));
    }

    return {
        index: new BoundedSaveFactIndex(facts, entityKeys, input.manifest, input.participantCharacterIds),
        warnings
    };
}
