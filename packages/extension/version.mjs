// The extension's version (board #16864, board #17005). package.json holds
// it; a bump writes the same number into package-lock.json and
// app/manifest.json (what edge://extensions shows) and adds a CHANGELOG.md
// section, which the store zip needs.
//
// PRs do not bump. Two open PRs that both took the next number conflicted on
// every version line, so the maintainers' release job
// bumps once per merge to main: `plan` says whether main needs a new version,
// `bump --since <tag>` writes it with the changes since that release.
//
//   node version.mjs plan                 one JSON line: version, tag, action (release|bump|none)
//   node version.mjs bump [patch|minor] [--since <ref>]   npm run bump [-- minor]
//   node version.mjs check                npm run check-version: the three files agree,
//                                         CHANGELOG.md has a section for the version
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of an x.y.z version; throws on anything else. */
export function parseVersion(version) {
  const m = VERSION.exec(String(version));
  if (!m) throw new Error(`${JSON.stringify(version)} is not a version of the form x.y.z`);
  return m.slice(1).map(Number);
}

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bumpVersion(version, kind = 'patch') {
  const [major, minor, patch] = parseVersion(version);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  throw new Error(`bump ${JSON.stringify(kind)}: use patch or minor`);
}

/**
 * True when a repository path can change the shipped zip: anything under
 * packages/ (the extension bundles the other packages' src, and the offline
 * engines' runtime) except tests, e2e runs and Markdown.
 */
export function affectsExtension(path) {
  if (!path.startsWith('packages/')) return false;
  if (/\/(test|e2e)\//.test(path)) return false;
  return !path.endsWith('.md');
}

/**
 * What main needs. `release`: no release is tagged for this version yet, so
 * publish it as it is. `bump`: the version has a release and files that go
 * into the zip changed since, so raise it first. `none`: nothing new to ship.
 */
export function planAction({ tagExists, changed }) {
  if (!tagExists) return 'release';
  return changed.some(affectsExtension) ? 'bump' : 'none';
}

/** Problems with the version, as sentences; empty when it is fine. */
export function versionProblems({ version, lockVersions, manifestVersion, changelog }) {
  try {
    parseVersion(version);
  } catch (error) {
    return [`package.json: ${error.message}`];
  }
  const problems = [];
  if (manifestVersion !== version) problems.push(`app/manifest.json says ${manifestVersion}, package.json says ${version}: run npm run build or npm run bump`);
  for (const lock of lockVersions) {
    if (lock !== version) problems.push(`package-lock.json says ${lock}, package.json says ${version}: run npm run bump`);
  }
  if (changelog !== undefined && !hasSection(changelog, version)) problems.push(`CHANGELOG.md has no "## ${version}" section: run npm run bump, or add it`);
  return problems;
}

const hasSection = (changelog, version) => new RegExp(`^## ${version.replace(/\./g, '\\.')}( |$)`, 'm').test(changelog);

/** CHANGELOG.md with a `## <version>` section above the newest one. */
export function addChangelogSection(changelog, version, notes) {
  if (hasSection(changelog, version)) return changelog;
  const lines = notes.length ? notes.map((note) => `- ${note}`) : ['- No change a person can see; a rebuild.'];
  const section = `## ${version}\n\n${lines.join('\n')}\n\n`;
  const at = changelog.search(/^## /m);
  return at < 0 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, at) + section + changelog.slice(at);
}

const path = (name) => fileURLToPath(new URL(name, HERE));
const readJson = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
// The files keep their own layout: only the version value is replaced.
const setVersion = (name, pattern, version) => {
  const text = readFileSync(path(name), 'utf8');
  const next = text.replace(pattern, (_, lead) => `${lead}"${version}"`);
  if (next === text && !text.includes(`"${version}"`)) throw new Error(`${name}: no version field to replace`);
  writeFileSync(path(name), next);
};

/** Writes `version` into app/manifest.json; true when the file changed. */
export function writeManifestVersion(version) {
  const before = readJson('app/manifest.json').version;
  if (before === version) return false;
  setVersion('app/manifest.json', /^(\s*"version":\s*)"[^"]*"/m, version);
  return true;
}

function git(...args) {
  return execFileSync('git', args, { cwd: path('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const tagExists = (tag) => {
  try {
    git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`);
    return true;
  } catch {
    return false;
  }
};

/** The commit subjects since `since` that touched a file going into the zip; merge commits left out. */
function changesSince(since) {
  const subjects = [];
  for (const block of git('log', '--no-merges', '--format=%x00%s', '--name-only', `${since}..HEAD`, '--', '..').split('\0').filter(Boolean)) {
    const [subject, ...files] = block.split('\n').filter(Boolean);
    if (files.some((file) => affectsExtension(file))) subjects.push(subject.replace(/\s*\(#\d+\)$/, ''));
  }
  return subjects;
}

function bump(kind, since) {
  const from = readJson('package.json').version;
  const to = bumpVersion(from, kind);
  setVersion('package.json', /^(\s*"version":\s*)"[^"]*"/m, to);
  // The lock has the version twice: at the top and under packages[""].
  const lock = readFileSync(path('package-lock.json'), 'utf8');
  const top = lock.indexOf('"packages"');
  const [head, rest] = [lock.slice(0, top), lock.slice(top)];
  const re = /^(\s*"version":\s*)"[^"]*"/m;
  writeFileSync(path('package-lock.json'), head.replace(re, (_, lead) => `${lead}"${to}"`) + rest.replace(re, (_, lead) => `${lead}"${to}"`));
  writeManifestVersion(to);
  const notes = since ? changesSince(since) : [];
  writeFileSync(path('CHANGELOG.md'), addChangelogSection(readFileSync(path('CHANGELOG.md'), 'utf8'), to, notes));
  console.log(`NarWal ${from} -> ${to} (package.json, package-lock.json, app/manifest.json, CHANGELOG.md: ${notes.length} change(s))`);
}

function plan() {
  const { version } = readJson('package.json');
  const tag = `v${version}`;
  const exists = tagExists(tag);
  const changed = exists ? git('diff', '--name-only', tag, 'HEAD').split('\n').filter(Boolean) : [];
  const action = planAction({ tagExists: exists, changed });
  console.log(JSON.stringify({ version, tag, tagExists: exists, changed: changed.filter(affectsExtension).length, action }));
}

function check() {
  const lock = readJson('package-lock.json');
  const { version } = readJson('package.json');
  const problems = versionProblems({
    version,
    lockVersions: [lock.version, lock.packages[''].version],
    manifestVersion: readJson('app/manifest.json').version,
    changelog: readFileSync(path('CHANGELOG.md'), 'utf8'),
  });
  for (const problem of problems) console.error(`version: ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`version: ${version} is the same in package.json, package-lock.json and app/manifest.json, and CHANGELOG.md has it`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  if (command === 'bump') {
    const since = flag('--since');
    bump(args[0] || 'patch', since);
  } else if (command === 'plan') plan();
  else if (command === 'check') check();
  else {
    console.error('usage: node version.mjs plan | bump [patch|minor] [--since <ref>] | check');
    process.exit(2);
  }
}
