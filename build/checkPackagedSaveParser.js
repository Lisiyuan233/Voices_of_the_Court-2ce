/**
 * Verify that an Electron Forge package contains the exact staged save parser
 * sidecar. Adapted from 1.x build/checkPackagedSaveParser.js (P5): 2CE does
 * not ship THIRD_PARTY_NOTICES.md, so only the binary hash + a probe smoke
 * run against the packaged executable are checked. Post-package on purpose —
 * a successful Rust build alone does not prove the file reached resources/.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = process.platform === 'win32' ? 'C:/tmp' : path.join(root, 'out');
const productName = 'Voices of the Court - Community Edition';
const packageRoot = path.join(outDir, `${productName}-win32-x64`);
const resourcesRoot = path.join(packageRoot, 'resources');
const stagedParser = path.join(root, 'build', 'save-parser', 'win32-x64', 'votc-save-facts.exe');
const packagedParser = path.join(resourcesRoot, 'save-parser', 'win32-x64', 'votc-save-facts.exe');
const fixtureRoot = path.join(root, 'tools', 'votc-save-facts', 'tests', 'fixtures');
const fixture = path.join(fixtureRoot, 'unified_text_minimal.ck3');

function fail(message) {
    console.error(`[checkPackagedSaveParser] ${message}`);
    process.exit(1);
}

function requireFile(filePath, label) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        fail(`${label} is missing: ${filePath}`);
    }
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

requireFile(stagedParser, 'staged parser');
requireFile(packagedParser, 'packaged parser');
requireFile(fixture, 'smoke-test fixture');

if (sha256(stagedParser) !== sha256(packagedParser)) {
    fail('packaged parser hash does not match the staged release binary');
}

// Probe smoke against the PACKAGED executable (not the staged one) so a
// broken resources layout cannot pass on a good build tree.
const smoke = spawnSync(packagedParser, ['capabilities', '--max-output-bytes', '65536'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
});
if (smoke.status !== 0) {
    fail(`packaged parser capabilities smoke failed with exit code ${smoke.status}`);
}
let parsed;
try {
    parsed = JSON.parse(smoke.stdout);
} catch (err) {
    fail(`packaged parser produced non-JSON output: ${err.message}`);
}
if (!parsed || parsed.operation !== 'capabilities') {
    fail(`packaged parser returned an unexpected capabilities document: ${smoke.stdout.slice(0, 120)}`);
}

console.log('[checkPackagedSaveParser] packaged save parser verified.');
console.log(`[checkPackagedSaveParser] package root: ${packageRoot}`);
