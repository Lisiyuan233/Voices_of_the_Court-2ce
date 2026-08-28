/**
 * Save fact settings normalizer (implementation plan Task 6 step 4).
 *
 * The save-fact config fields live on `Config` as flat keys in 1.x (Task 19);
 * in 2CE they are not (yet) on `Config`, so this module accepts a loose partial
 * shape and always returns a fully-populated, defensively-clamped
 * `SaveFactSettings`. Inputs without any of the known keys produce
 * the safe defaults (feature disabled) without requiring the user to delete
 * or recreate their config.
 *
 * Normalization rules:
 * - Booleans are strict: only the literal `true` enables a flag; every other
 *   value (including truthy ones like `1` or `"yes"`) means false.
 * - Numeric timeouts, poll intervals and token budgets are clamped to a sane
 *   range; non-finite or non-number input falls back to the default.
 * - `promptEnabled` depends on the parser: if the parser is disabled the
 *   effective prompt flag is forced to false.
 * - Category allowlist is limited to identity/family/realm/war/activity/location; unknown category
 *   keys are ignored.
 * - The snapshot file name is ALWAYS the protocol constant from
 *   `src/shared/gameData/saveSnapshotProtocol.ts`; it is never read from
 *   user-editable text.
 */

import { SAVE_SNAPSHOT_FIXED_FILE_NAME } from '../../shared/gameData/saveSnapshotProtocol';
import type { Config } from '../../shared/Config';
import type { SaveFactCategory } from './saveFactTypes';

export interface SaveFactSettings {
    /** Master switch: wait for, parse and inject save facts. Default off. */
    enabled: boolean;
    /** Whether the sidecar parser may be launched. Requires `enabled`. */
    parserEnabled: boolean;
    /** Whether facts may be injected into prompts. Requires the parser. */
    promptEnabled: boolean;
    /** Fixed snapshot file name (protocol constant, not user text). */
    snapshotFileName: string;
    /** Total preparation deadline for one snapshot wait+parse cycle. */
    prepareDeadlineMs: number;
    /** Sidecar process timeout; always <= prepareDeadlineMs. */
    parserTimeoutMs: number;
    /** File-stability poll interval while waiting for the snapshot file. */
    pollIntervalMs: number;
    /** Token budget for the stable baseline fact block. */
    baselineTokenBudget: number;
    /** Token budget for the per-turn dynamic fact block. */
    dynamicTokenBudget: number;
    /** Category allowlist. Unknown categories never appear here. */
    categories: Record<SaveFactCategory, boolean>;
    /** Direct-realm predicates default ON since the 2026-08-11 P1-D review; still gated by the parser master switch. */
    directRealmEnabled: boolean;
    // P5b deferred (agency/verify/session/delta): 1.x also carried
    // agencyVerifyEnabled / characterQueryEnabled / deltaEnabled here.
    /** Whether the diagnostics IPC/UI may expose SaveFactDiagnosticsDto. */
    diagnosticsEnabled: boolean;
}

export const SAVE_FACT_DEFAULTS = {
    enabled: false,
    parserEnabled: false,
    promptEnabled: false,
    prepareDeadlineMs: 15000,
    parserTimeoutMs: 10000,
    pollIntervalMs: 250,
    baselineTokenBudget: 400,
    dynamicTokenBudget: 800,
    diagnosticsEnabled: false
} as const;

export const SAVE_FACT_LIMITS = {
    prepareDeadlineMs: { min: 1000, max: 60000 },
    parserTimeoutMs: { min: 500, max: 30000 },
    pollIntervalMs: { min: 50, max: 2000 },
    tokenBudget: { min: 0, max: 2000 }
} as const;

/**
 * Loose input shape. 1.x mapped flat `Config` keys onto this shape; in 2CE the
 * save-fact fields are not (yet) on `Config`, so callers pass the legacy
 * `saveFacts` bag (used by tests and the future wiring). Every value is
 * treated as untrusted `unknown` and normalized.
 */
export interface SaveFactSettingsInput {
    enabled?: unknown;
    parserEnabled?: unknown;
    promptEnabled?: unknown;
    prepareDeadlineMs?: unknown;
    parserTimeoutMs?: unknown;
    pollIntervalMs?: unknown;
    baselineTokenBudget?: unknown;
    dynamicTokenBudget?: unknown;
    categories?: unknown;
    diagnosticsEnabled?: unknown;
    directRealmEnabled?: unknown;
}

export type SaveFactSettingsSource =
    | (Partial<Config> & { saveFacts?: SaveFactSettingsInput })
    | undefined;

// P5b deferred (agency/verify/session/delta): 1.x also mapped flat `Config`
// keys (`saveGameSnapshotParsingEnabled`, `saveGameFacts*`) onto the input via
// `flatInputFromConfig`; 2CE's `Config` class has no such flat keys yet, so
// settings come only through the `saveFacts` bag.

/** Overlay the defined entries of the legacy `saveFacts` bag, if present. */
function mergeBag(base: SaveFactSettingsInput, bag: SaveFactSettingsInput | undefined): SaveFactSettingsInput {
    if (bag === undefined) return base;
    const merged: SaveFactSettingsInput = { ...base };
    for (const key of Object.keys(bag) as (keyof SaveFactSettingsInput)[]) {
        if (bag[key] !== undefined) {
            (merged as Record<string, unknown>)[key] = bag[key];
        }
    }
    return merged;
}

function strictBoolean(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    return value === true;
}

function clampNumber(value: unknown, defaultValue: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
}

function normalizeCategories(value: unknown): Record<SaveFactCategory, boolean> {
    const raw = (typeof value === 'object' && value !== null && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    // Existing categories default to ON for compatibility. War is explicitly
    // opt-in so enabling the parser never widens prompt data by itself; all
    // other category keys are dropped. activity/location/court default ON
    // per the 2026-08-11 P1-D review.
    return {
        identity: raw['identity'] === undefined ? true : raw['identity'] === true,
        family: raw['family'] === undefined ? true : raw['family'] === true,
        realm: raw['realm'] === undefined ? true : raw['realm'] === true,
        // War is opt-in independently, even when the save-facts feature is
        // enabled, so existing configurations never widen their prompt data.
        war: raw['war'] === true,
        activity: raw['activity'] === undefined ? true : raw['activity'] === true,
        location: raw['location'] === undefined ? true : raw['location'] === true,
        court: raw['court'] === undefined ? true : raw['court'] === true
    };
}

export function buildSaveFactSettings(config?: SaveFactSettingsSource): SaveFactSettings {
    const raw: SaveFactSettingsInput = mergeBag({}, config?.saveFacts);

    const enabled = strictBoolean(raw.enabled, SAVE_FACT_DEFAULTS.enabled);
    // The parser can only run when the feature itself is enabled.
    const parserEnabled = enabled && strictBoolean(raw.parserEnabled, SAVE_FACT_DEFAULTS.parserEnabled);
    // Prompt injection depends on the parser: prompt=true with parser=false
    // normalizes to effective prompt=false.
    const promptEnabled = parserEnabled && strictBoolean(raw.promptEnabled, SAVE_FACT_DEFAULTS.promptEnabled);

    const prepareDeadlineMs = clampNumber(
        raw.prepareDeadlineMs,
        SAVE_FACT_DEFAULTS.prepareDeadlineMs,
        SAVE_FACT_LIMITS.prepareDeadlineMs.min,
        SAVE_FACT_LIMITS.prepareDeadlineMs.max
    );
    // The parser timeout is additionally capped by the total deadline so the
    // sidecar can never outlive its preparation window.
    const parserTimeoutMs = Math.min(
        clampNumber(
            raw.parserTimeoutMs,
            SAVE_FACT_DEFAULTS.parserTimeoutMs,
            SAVE_FACT_LIMITS.parserTimeoutMs.min,
            SAVE_FACT_LIMITS.parserTimeoutMs.max
        ),
        prepareDeadlineMs
    );

    return {
        enabled,
        parserEnabled,
        promptEnabled,
        snapshotFileName: SAVE_SNAPSHOT_FIXED_FILE_NAME,
        prepareDeadlineMs,
        parserTimeoutMs,
        pollIntervalMs: clampNumber(
            raw.pollIntervalMs,
            SAVE_FACT_DEFAULTS.pollIntervalMs,
            SAVE_FACT_LIMITS.pollIntervalMs.min,
            SAVE_FACT_LIMITS.pollIntervalMs.max
        ),
        baselineTokenBudget: clampNumber(
            raw.baselineTokenBudget,
            SAVE_FACT_DEFAULTS.baselineTokenBudget,
            SAVE_FACT_LIMITS.tokenBudget.min,
            SAVE_FACT_LIMITS.tokenBudget.max
        ),
        dynamicTokenBudget: clampNumber(
            raw.dynamicTokenBudget,
            SAVE_FACT_DEFAULTS.dynamicTokenBudget,
            SAVE_FACT_LIMITS.tokenBudget.min,
            SAVE_FACT_LIMITS.tokenBudget.max
        ),
        categories: normalizeCategories(raw.categories),
        directRealmEnabled: strictBoolean(raw.directRealmEnabled, true),
        // P5b deferred (agency/verify/session/delta): 1.x also normalized
        // agencyVerifyEnabled / characterQueryEnabled / deltaEnabled here.
        diagnosticsEnabled: strictBoolean(raw.diagnosticsEnabled, SAVE_FACT_DEFAULTS.diagnosticsEnabled)
    };
}
