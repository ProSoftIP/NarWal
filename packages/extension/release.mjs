// Builds the store-ready zip for the Chrome Web Store and Edge Add-ons
// (board #16955, docs/release/CHECKLIST.md).
//
//   npm run release  ->  release/narwal-<version>.zip        (load unpacked, package.mjs)
//                        release/narwal-<version>-store.zip  (upload to a store)
//                        release/narwal-<version>-store.zip.sha256
//
// It runs package.mjs first (a build with no test hooks), then zips app/ with
// manifest.json at the root and no manifest `key`. src/release/store-package.js
// refuses any file that is not part of the extension (sources, tests,
// fixtures, research, validation output, source maps). The zip's contents are
// then scanned for secrets with gitleaks; a release with no scan fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { openZip, writeZip } from '../library/src/zip.ts';
import { storeEntries } from './src/release/store-package.js';

execFileSync(process.execPath, ['package.mjs'], { stdio: 'inherit' });

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push({ path: relative('app', path).split('\\').join('/'), bytes: readFileSync(path) });
  }
})('app');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const { inputs } = storeEntries(files, { version, changelog: readFileSync('CHANGELOG.md', 'utf8') });
const zip = await writeZip(inputs);

// Read the zip back: every entry must open and match what was put in.
const archive = openZip(zip);
if (archive.entries.length !== inputs.length) throw new Error(`the zip holds ${archive.entries.length} entries, not ${inputs.length}`);
const manifest = JSON.parse(new TextDecoder().decode(await archive.read('manifest.json')));
if ('key' in manifest) throw new Error('the store zip manifest still has a key');

const scanDir = mkdtempSync(join(tmpdir(), 'narwal-release-scan-'));
try {
  for (const { path } of archive.entries) {
    mkdirSync(join(scanDir, dirname(path)), { recursive: true });
    writeFileSync(join(scanDir, path), await archive.read(path));
  }
  scanForSecrets(scanDir);
} finally {
  rmSync(scanDir, { recursive: true, force: true });
}

mkdirSync('release', { recursive: true });
const out = `release/narwal-${version}-store.zip`;
writeFileSync(out, zip);
const sha256 = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${out}.sha256`, `${sha256}  narwal-${version}-store.zip\n`);
console.log(`${out}: ${inputs.length} files, ${zip.length} bytes (${(zip.length / 1e6).toFixed(1)} MB)`);
console.log(`sha256 ${sha256}`);

/**
 * gitleaks on the files of the zip. Where gitleaks may only run
 * through gitleaks-bounded, which scans a git range, the files are
 * committed to a throwaway repository first; elsewhere plain gitleaks scans
 * the folder. A missing scanner fails the release.
 */
function scanForSecrets(dir) {
  // The default rules less the measured false positives, each an exact string.
  const CONFIG = resolve('release-gitleaks.toml');
  const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  let run;
  if (has('gitleaks-bounded')) {
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=NarWal release', '-c', 'user.email=release@narwal.invalid', ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'empty');
    const base = git('rev-parse', 'HEAD');
    git('add', '-A');
    git('commit', '-q', '-m', 'store zip contents');
    run = spawnSync('gitleaks-bounded', ['--range', `${base}..HEAD`, '--source', dir, '--', '--config', CONFIG], { encoding: 'utf8' });
  } else if (has('gitleaks')) {
    run = spawnSync('gitleaks', ['detect', '--no-git', '--redact', '--no-banner', '--config', CONFIG, '--source', dir], { encoding: 'utf8' });
  } else {
    throw new Error('gitleaks is not installed: the store zip needs a secret scan (https://github.com/gitleaks/gitleaks)');
  }
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  if (run.status !== 0) throw new Error(`the secret scan did not pass (exit ${run.status}):\n${output}`);
  console.log(`secret scan: no leaks found (${output.split('\n').pop()})`);
}
