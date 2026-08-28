/**
 * Stage the votc-save-facts sidecar release binary into build/save-parser/
 * (implementation plan Task 9 step 3).
 *
 * Copies the single release exe built by `cargo build --release` into
 * `build/save-parser/win32-x64/`, which forge.config.js then includes in the
 * packaged resources via `extraResource`. Source and target are hardcoded
 * relative to the repo root and verified to stay inside it; the script does
 * not accept arbitrary command-line paths. A missing source is a hard error
 * (non-zero exit) so a release can never silently ship without the parser.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.resolve(
    root,
    'tools',
    'votc-save-facts',
    'target',
    'release',
    'votc-save-facts.exe'
);
const targetDir = path.resolve(root, 'build', 'save-parser', 'win32-x64');
const target = path.join(targetDir, 'votc-save-facts.exe');

function assertInsideRoot(resolved, label) {
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        console.error(`[stageSaveParser] ${label} escapes the repository root: ${resolved}`);
        process.exit(1);
    }
}

assertInsideRoot(source, 'source');
assertInsideRoot(target, 'target');

if (!fs.existsSync(source)) {
    console.error(`[stageSaveParser] source executable not found: ${source}`);
    console.error('[stageSaveParser] build it first with: cargo build --release in tools/votc-save-facts/');
    process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);

const bytes = fs.statSync(target).size;
console.log(`[stageSaveParser] staged ${path.relative(root, source)} -> ${path.relative(root, target)} (${bytes} bytes)`);
