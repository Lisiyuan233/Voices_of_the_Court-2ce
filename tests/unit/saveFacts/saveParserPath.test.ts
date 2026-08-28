import * as path from 'path';
import {
    resolveSaveParserExecutable,
    SAVE_PARSER_PATH_ENV_VAR,
    type SaveParserFsLike,
    type SaveParserLoggerLike,
    type SaveParserPathResult
} from '../../../src/main/saveFacts/saveParserPath';

function fsWith(existing: string[]): SaveParserFsLike {
    const normalized = new Set(existing.map((p) => path.resolve(p)));
    return { existsSync: (candidate: string) => normalized.has(path.resolve(candidate)) };
}

function recordingLogger(): { logger: SaveParserLoggerLike; warnings: string[] } {
    const warnings: string[] = [];
    return { logger: { warn: (message: string) => warnings.push(message) }, warnings };
}

const PACKAGED_EXE = path.join('C:', 'res', 'save-parser', 'win32-x64', 'votc-save-facts.exe');
const DEV_EXE = path.join('C:', 'app', 'tools', 'votc-save-facts', 'target', 'release', 'votc-save-facts.exe');

describe('resolveSaveParserExecutable', () => {
    it('resolves the packaged win32-x64 resource path', () => {
        const result = resolveSaveParserExecutable({
            isPackaged: true,
            resourcesPath: path.join('C:', 'res'),
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'x64',
            env: {},
            fs: fsWith([PACKAGED_EXE])
        });
        expect(result).toEqual({ ok: true, executablePath: path.resolve(PACKAGED_EXE) });
    });

    it('resolves the dev cargo target path under appPath', () => {
        const result = resolveSaveParserExecutable({
            isPackaged: false,
            resourcesPath: '',
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'x64',
            env: {},
            fs: fsWith([DEV_EXE])
        });
        expect(result).toEqual({ ok: true, executablePath: path.resolve(DEV_EXE) });
    });

    it('returns PARSER_NOT_FOUND when the packaged exe is missing', () => {
        const result = resolveSaveParserExecutable({
            isPackaged: true,
            resourcesPath: path.join('C:', 'res'),
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'x64',
            env: {},
            fs: fsWith([])
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe('PARSER_NOT_FOUND');
            expect(result.detail).toContain('votc-save-facts.exe');
        }
    });

    it('returns unsupported for non-win32 platforms', () => {
        const result = resolveSaveParserExecutable({
            isPackaged: false,
            resourcesPath: '',
            appPath: path.join('C:', 'app'),
            platform: 'linux',
            arch: 'x64',
            env: {},
            fs: fsWith([DEV_EXE])
        });
        expect(result).toEqual({ ok: false, kind: 'unsupported', detail: expect.stringContaining('linux-x64') });
    });

    it('returns unsupported for non-x64 architectures', () => {
        const result = resolveSaveParserExecutable({
            isPackaged: true,
            resourcesPath: path.join('C:', 'res'),
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'arm64',
            env: {},
            fs: fsWith([PACKAGED_EXE])
        });
        expect(result).toEqual({ ok: false, kind: 'unsupported', detail: expect.stringContaining('win32-arm64') });
    });

    it('honors an explicit executable path override and bypasses the platform check', () => {
        const fake = path.join('tmp', 'fake-parser.exe');
        const result = resolveSaveParserExecutable({
            isPackaged: true,
            resourcesPath: '',
            appPath: '',
            platform: 'linux',
            arch: 'arm64',
            executablePathOverride: fake,
            env: {},
            fs: fsWith([fake])
        });
        expect(result).toEqual({ ok: true, executablePath: path.resolve(fake) });
    });

    it('ignores the env override in packaged builds', () => {
        const envExe = path.join('tmp', 'env-parser.exe');
        const result = resolveSaveParserExecutable({
            isPackaged: true,
            resourcesPath: path.join('C:', 'res'),
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'x64',
            env: { [SAVE_PARSER_PATH_ENV_VAR]: envExe },
            fs: fsWith([envExe, PACKAGED_EXE])
        });
        // The env path is not consulted; the well-known packaged path wins.
        expect(result).toEqual({ ok: true, executablePath: path.resolve(PACKAGED_EXE) });
    });

    it('uses the env override in dev builds and logs a warning', () => {
        const envExe = path.join('tmp', 'env-parser.exe');
        const { logger, warnings } = recordingLogger();
        const result = resolveSaveParserExecutable({
            isPackaged: false,
            resourcesPath: '',
            appPath: path.join('C:', 'app'),
            platform: 'win32',
            arch: 'x64',
            env: { [SAVE_PARSER_PATH_ENV_VAR]: envExe },
            fs: fsWith([envExe]),
            logger
        });
        expect(result).toEqual({ ok: true, executablePath: path.resolve(envExe) });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(SAVE_PARSER_PATH_ENV_VAR);
    });

    it('never throws, even when the fs check itself throws', () => {
        const throwingFs: SaveParserFsLike = {
            existsSync: () => {
                throw new Error('boom');
            }
        };
        let result: SaveParserPathResult | undefined;
        expect(() => {
            result = resolveSaveParserExecutable({
                isPackaged: false,
                resourcesPath: '',
                appPath: path.join('C:', 'app'),
                platform: 'win32',
                arch: 'x64',
                env: {},
                fs: throwingFs
            });
        }).not.toThrow();
        expect(result!.ok).toBe(false);
        if (result && !result.ok) {
            expect(result.kind).toBe('PARSER_NOT_FOUND');
        }
    });
});
