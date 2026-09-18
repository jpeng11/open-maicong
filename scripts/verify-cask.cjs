'use strict';

// Release gate: the Homebrew cask must describe the artifact this build just
// produced. A stale sha256 makes `brew install` fail with a checksum mismatch
// that reads exactly like a compromised download. Runs at the end of `npm run
// dist`; `--write` rewrites version/sha256/url in the cask from the fresh DMG
// instead of failing (then sync the tap copy).
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const caskArg = args.find((a) => !a.startsWith('--'));
const caskPath = caskArg
  ? path.resolve(caskArg)
  : path.join(root, 'Casks', 'maicong-studio.rb');

function fail(message) {
  console.error(`[verify-cask] ${message}`);
  process.exit(1);
}

const pkg = require(path.join(root, 'package.json'));
const cask = fs.readFileSync(caskPath, 'utf8');

const versionMatch = cask.match(/^(\s*)version\s+"([^"]+)"\s*$/m);
const shaMatch = cask.match(/^(\s*)sha256\s+"([0-9a-f]{64})"\s*$/m);
const urlMatch = cask.match(/^(\s*)url\s+"([^"]+)"\s*$/m);
if (!versionMatch) fail(`no version stanza found in ${caskPath}`);
if (!shaMatch) fail(`no sha256 stanza found in ${caskPath}`);
if (!urlMatch) fail(`no url stanza found in ${caskPath}`);

const artifactName = pkg.build.artifactName
  .replace(/\$\{version\}/g, pkg.version)
  .replace(/\$\{arch\}/g, 'arm64')
  .replace(/\$\{ext\}/g, 'dmg');

const dmgPath = path.join(root, 'dist', artifactName);
if (!fs.existsSync(dmgPath)) {
  fail(`expected artifact missing: dist/${artifactName} — run npm run dist first`);
}
const actualSha = createHash('sha256').update(fs.readFileSync(dmgPath)).digest('hex');

const caskUrlFile = urlMatch[2].split('/').pop().replace(/#\{version\}/g, versionMatch[2]);
const problems = [];
if (versionMatch[2] !== pkg.version) {
  problems.push(`version: cask ${versionMatch[2]} != package.json ${pkg.version}`);
}
if (caskUrlFile !== artifactName) {
  problems.push(`url filename: cask ${caskUrlFile} != artifactName ${artifactName}`);
}
if (shaMatch[2] !== actualSha) {
  problems.push(`sha256: cask ${shaMatch[2]} != dist/${artifactName} ${actualSha}`);
}

if (problems.length === 0) {
  console.log(`[verify-cask] OK: ${artifactName} matches cask (sha256 ${actualSha.slice(0, 12)}…)`);
  process.exit(0);
}

if (!write) {
  fail(`${problems.join('\n')}\nUpdate Casks/maicong-studio.rb and the tap copy, or rerun with --write to rewrite the cask from this build.`);
}

const nextUrl = urlMatch[2].replace(/[^/]+$/, artifactName.replace(pkg.version, '#{version}'));
const updated = cask
  .replace(versionMatch[0], `${versionMatch[1]}version "${pkg.version}"`)
  .replace(shaMatch[0], `${shaMatch[1]}sha256 "${actualSha}"`)
  .replace(urlMatch[0], `${urlMatch[1]}url "${nextUrl}"`);
if (updated === cask) {
  fail('--write could not apply the updates; cask stanza shape changed?');
}
fs.writeFileSync(caskPath, updated, 'utf8');
console.log(`[verify-cask] rewrote ${path.relative(root, caskPath)} for ${artifactName} (sha256 ${actualSha.slice(0, 12)}…). Sync the tap copy before publishing.`);
