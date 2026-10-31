// Publishes the load-unpacked zip as a GitHub release (board #16864), so "send
// the latest build" is a link:
//   https://github.com/ProSoftIP/NarWal/releases/latest
//
//   node github-release.mjs             npm run github-release
//   node github-release.mjs --dry-run   builds the zip and prints the release, creates nothing
//
// One release per version, tagged v<version>, on a commit that is on
// origin/main with no uncommitted changes. A version that already has a
// release is left alone. The maintainers' release job (board #17005)
// runs this after each merge to main. It needs `gh` signed in. The store zip is release.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const git = (...args) => run('git', args);
const ok = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const fail = (message) => {
  console.error(`github-release: ${message}`);
  process.exit(1);
};

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;
const zip = `release/narwal-${version}.zip`;

if (git('status', '--porcelain', '--untracked-files=no')) fail('the checkout has uncommitted changes; release a commit on main');
git('fetch', '--quiet', '--tags', 'origin', 'main');
const sha = git('rev-parse', 'HEAD');
if (!ok('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])) {
  if (!dryRun) fail(`${sha.slice(0, 7)} is not on origin/main; release from main after the merge`);
  console.warn(`github-release: ${sha.slice(0, 7)} is not on origin/main (a real run stops here)`);
}
if (ok('gh', ['release', 'view', tag])) {
  console.log(`github-release: ${tag} already exists; nothing to do (a new release needs a new version: npm run bump)`);
  process.exit(0);
}

execFileSync(process.execPath, ['package.mjs'], { stdio: 'inherit' });
if (!existsSync(zip)) fail(`${zip} was not written`);
const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(`${zip}.sha256`, `${sha256}  narwal-${version}.zip\n`);

// The notes: this version's CHANGELOG.md section, or the commit subjects under packages/.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const section = new RegExp(`^## ${version.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
let changes = section ? section[1].trim() : '';
if (!changes) {
  let previous = '';
  try {
    previous = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${sha}^`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // No earlier release.
  }
  changes = git('log', '--no-merges', '--format=- %s (%h)', ...(previous ? [`${previous}..${sha}`] : ['-1', sha]), '--', '..') || '- (no commit subjects under packages/)';
}
const notes = [
  `NarWal ${version}, built from ${sha.slice(0, 7)}. sha256 of the zip: ${sha256}`,
  '',
  `Install or update: download ${zip.slice('release/'.length)} below and follow docs/install-unpacked.md (Updating to a new version).`,
  'edge://extensions and the last line of the popup show the version.',
  '',
  changes,
].join('\n');

const args = ['release', 'create', tag, zip, `${zip}.sha256`, '--target', sha, '--title', `NarWal ${version}`, '--notes', notes];
if (dryRun) {
  console.log(`github-release: --dry-run, would run: gh release create ${tag} ${zip} ${zip}.sha256 --target ${sha} --title "NarWal ${version}"`);
  console.log(notes);
  process.exit(0);
}
console.log(run('gh', args));
