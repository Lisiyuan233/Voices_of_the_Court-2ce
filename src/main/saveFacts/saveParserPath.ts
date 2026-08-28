/**
 * Save parser (sidecar) executable path resolver (implementation plan Task 9
 * step 1).
 *
 * The `votc-save-facts` Rust sidecar ships at two well-known locations:
 * - packaged Windows x64: `<process.resourcesPath>/save-parser/win32-x64/votc-save-facts.exe`
 *   (staged into `build/save-parser/` by `build/stageSaveParser.js` and copied
 *   into packaged resources via the Forge `extraResource` config);
 * - development: `<appPath>/tools/votc-save-facts/target/release/votc-save-facts.exe`.
 *
 * Resolution rules:
 * - An explicit `executablePathOverride` constructor argument always wins;
 *   this is how tests inject a fake executable path. It bypasses the
 *   platform check so unit tests can run on any host.
 * - The `VOTC_SAVE_PARSER_PATH` environment variable is honored ONLY in
 *   development (`isPackaged === false`) and always logs a warning when used.
 *   Packaged builds never read arbitrary environment variables for the
 *   executable path.
 * - The only supported platform target is win32-x64. Any other
 *   platform/arch combination returns `unsupported` instead of fabricating
 *   a path that cannot exist.
 * - The only filesystem IO performed here is a single `existsSync` check
 *   (injectable for tests). A missing candidate yields `PARSER_NOT_FOUND`.
 * - This module never throws; every failure is a typed result so a missing
 *   or broken sidecar cannot crash conversation startup.
 */

import * as path from 'path';

export const SAVE_PARSER_BINARY_NAME = 'votc-save-facts.exe';
export const SAVE_PARSER_PACKAGED_RELATIVE_DIR = path.join('save-parser', 'win32-x64');
export const SAVE_PARSER_DEV_RELATIVE_PATH = path.join(
    'tools',
    'votc-save-facts',
    'target',
    'release',
    SAVE_PARSER_BINARY_NAME
);
export const SAVE_PARSER_PATH_ENV_VAR = 'VOTC_SAVE_PARSER_PATH';

export type SaveParserPathErrorKind = 'PARSER_NOT_FOUND' | 'unsupported';

export type SaveParserPathResult =
    | { ok: true; executablePath: string }
    | { ok: false; kind: SaveParserPathErrorKind; detail: string };

/** Minimal fs surface used by the resolver; injectable for unit tests. */
export interface SaveParserFsLike {
    existsSync(candidate: string): boolean;
}

/** Minimal logger surface; only warnings are emitted by this module. */
export interface SaveParserLoggerLike {
    warn(message: string): void;
}

export interface ResolveSaveParserExecutableOptions {
    /** `app.isPackaged`. Packaged builds resolve under `resourcesPath`. */
    isPackaged: boolean;
    /** `process.resourcesPath` (only meaningful when packaged). */
    resourcesPath: string;
    /** `app.getAppPath()`; dev builds resolve relative to the app root. */
    appPath: string;
    /** `process.platform`. */
    platform: string;
    /** `process.arch`. */
    arch: string;
    /**
     * Explicit executable path override, intended for tests. When set it
     * bypasses the platform check and the env override.
     */
    executablePathOverride?: string;
    /**
     * Environment bag consulted for the dev-only override. Defaults to
     * `process.env`; ignored entirely in packaged builds.
     */
    env?: NodeJS.ProcessEnv;
    /** Injectable fs; defaults to the real `fs` module. */
    fs?: SaveParserFsLike;
    /** Injectable logger; warnings are dropped when omitted. */
    logger?: SaveParserLoggerLike;
}

const realFs: SaveParserFsLike = {
    existsSync: (candidate: string): boolean => {
        // Lazy require keeps the module importable in test environments that
        // stub the fs surface without touching the real filesystem.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('fs').existsSync(candidate);
    }
};

function notFound(detail: string): SaveParserPathResult {
    return { ok: false, kind: 'PARSER_NOT_FOUND', detail };
}

function unsupported(detail: string): SaveParserPathResult {
    return { ok: false, kind: 'unsupported', detail };
}

function checkCandidate(candidate: string, fs: SaveParserFsLike): SaveParserPathResult {
    const absolute = path.resolve(candidate);
    if (!fs.existsSync(absolute)) {
        return notFound(`save parser executable not found at '${absolute}'`);
    }
    return { ok: true, executablePath: absolute };
}

export function resolveSaveParserExecutable(
    options: ResolveSaveParserExecutableOptions
): SaveParserPathResult {
    const fs = options.fs ?? realFs;
    const logger = options.logger;

    try {
        // 1. Explicit override (test injection). Bypasses the platform check
        //    so unit tests can inject a fake path on any host.
        if (options.executablePathOverride !== undefined && options.executablePathOverride !== '') {
            return checkCandidate(options.executablePathOverride, fs);
        }

        // 2. Dev-only environment override. Packaged builds must not read
        //    arbitrary environment variables for the executable path.
        if (!options.isPackaged) {
            const envValue = (options.env ?? process.env)[SAVE_PARSER_PATH_ENV_VAR];
            if (typeof envValue === 'string' && envValue !== '') {
                logger?.warn(
                    `[saveParserPath] using ${SAVE_PARSER_PATH_ENV_VAR} dev override: '${envValue}'`
                );
                return checkCandidate(envValue, fs);
            }
        }

        // 3. Platform gate: only win32-x64 is a supported sidecar target.
        if (options.platform !== 'win32' || options.arch !== 'x64') {
            return unsupported(
                `save parser sidecar is only available for win32-x64, got ${options.platform}-${options.arch}`
            );
        }

        // 4. Well-known locations.
        const candidate = options.isPackaged
            ? path.join(options.resourcesPath, SAVE_PARSER_PACKAGED_RELATIVE_DIR, SAVE_PARSER_BINARY_NAME)
            : path.join(options.appPath, SAVE_PARSER_DEV_RELATIVE_PATH);
        return checkCandidate(candidate, fs);
    } catch (error) {
        // Defensive: resolution must never throw into conversation startup.
        const message = error instanceof Error ? error.message : String(error);
        return notFound(`save parser path resolution failed: ${message}`);
    }
}
