// The extension version (board #16864, board #17005): one number in
// package.json, the lock and the manifest, raised once per merge to main that
// alters the zip; the popup shows it with the build's commit and date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addChangelogSection, affectsExtension, bumpVersion, compareVersions, parseVersion, planAction, versionProblems } from '../../version.mjs';
import { buildLine } from '../../src/shared/build-info.js';
import { storeEntries } from '../../src/release/store-package.js';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('package.json, package-lock.json and the manifest carry the same version, and CHANGELOG.md has it', () => {
  const { version } = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  parseVersion(version);
  assert.deepEqual(versionProblems({
    version,
    lockVersions: [lock.version, lock.packages[''].version],
    manifestVersion: JSON.parse(read('app/manifest.json')).version,
    changelog: read('CHANGELOG.md'),
  }), []);
});

test('a bump is patch by default and minor on request', () => {
  assert.equal(bumpVersion('1.0.0'), '1.0.1');
  assert.equal(bumpVersion('0.1.9', 'patch'), '0.1.10');
  assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0');
  assert.throws(() => bumpVersion('0.1.0', 'major'), /patch or minor/);
  assert.throws(() => bumpVersion('0.1'), /x\.y\.z/);
});

test('versions compare by number, not as text', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.99') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
});

test('source, the build and the bundled packages affect the zip; tests, e2e and Markdown do not', () => {
  for (const path of [
    'packages/extension/src/ui/popup.js',
    'packages/extension/app/popup.html',
    'packages/extension/build.mjs',
    'packages/extension/package-lock.json',
    'packages/library/src/zip.ts',
    'packages/offline-transcription/vendor/sherpa-onnx/sherpa-onnx-asr.js',
  ]) {
    assert.equal(affectsExtension(path), true, path);
  }
  for (const path of [
    'packages/extension/test/unit/version.test.mjs',
    'packages/extension/test/e2e/run.mjs',
    'packages/offline-transcription/e2e/run.mjs',
    'packages/extension/README.md',
    'docs/install-unpacked.md',
    'design/saved-recordings/index.html',
  ]) {
    assert.equal(affectsExtension(path), false, path);
  }
});

test('main is released as it is until its version has a release, then bumped only for a change to the zip', () => {
  assert.equal(planAction({ tagExists: false, changed: [] }), 'release');
  assert.equal(planAction({ tagExists: true, changed: ['packages/extension/src/ui/popup.js', 'docs/replay.md'] }), 'bump');
  assert.equal(planAction({ tagExists: true, changed: ['docs/replay.md', 'packages/extension/test/unit/x.test.mjs'] }), 'none');
  assert.equal(planAction({ tagExists: true, changed: [] }), 'none');
});

test('a manifest, lock or changelog that disagrees with package.json fails', () => {
  const problems = versionProblems({ version: '1.0.2', lockVersions: ['1.0.1', '1.0.2'], manifestVersion: '1.0.1', changelog: '## 1.0.1\n' });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /app\/manifest\.json says 1\.0\.1, package\.json says 1\.0\.2/);
  assert.match(problems[1], /package-lock\.json says 1\.0\.1/);
  assert.match(problems[2], /no "## 1\.0\.2" section/);
  assert.deepEqual(versionProblems({ version: '1.0.2', lockVersions: ['1.0.2'], manifestVersion: '1.0.2', changelog: '## 1.0.2\n' }), []);
});

test('a bump puts its CHANGELOG section above the newest one, once', () => {
  const before = '# Changelog\n\nIntro.\n\n## 1.0.0 (unreleased)\n\n- first\n';
  const after = addChangelogSection(before, '1.0.1', ['Delete a recording', 'Pick a transcript line']);
  assert.equal(after, '# Changelog\n\nIntro.\n\n## 1.0.1\n\n- Delete a recording\n- Pick a transcript line\n\n## 1.0.0 (unreleased)\n\n- first\n');
  assert.equal(addChangelogSection(after, '1.0.1', ['again']), after, 'an existing section is left alone');
  assert.match(addChangelogSection(before, '1.0.1', []), /## 1\.0\.1\n\n- No change a person can see; a rebuild\./);
  assert.equal(addChangelogSection('# Changelog\n', '1.0.1', ['x']), '# Changelog\n\n## 1.0.1\n\n- x\n\n');
});

test('the popup build line names the version, the commit and the date', () => {
  assert.equal(buildLine('1.0.1', { commit: '71d3c62', date: '2026-10-18' }), 'NarWal 1.0.1 · build 71d3c62 · 2026-10-18');
  assert.equal(buildLine('1.0.1', { commit: '71d3c62-dirty', date: '2026-10-18' }), 'NarWal 1.0.1 · build 71d3c62-dirty · 2026-10-18');
  assert.equal(buildLine('1.0.1', null), 'NarWal 1.0.1');
});

test('the popup has the build line under its links', () => {
  const html = read('app/popup.html');
  assert.match(html, /id="website">ProSoft IP<\/a><\/p>\n<p class="library build" id="build"><\/p>/);
  assert.match(read('src/ui/popup.js'), /getElementById\('build'\)\.textContent = buildLine\(/);
});

test('the store zip may carry dist/build.json, and still refuses other files', () => {
  const bytes = (text) => new TextEncoder().encode(text);
  const files = [
    { path: 'manifest.json', bytes: bytes(JSON.stringify({ version: '1.0.1', key: 'k' })) },
    { path: 'dist/LICENSE.md', bytes: bytes('l') },
    { path: 'dist/THIRD-PARTY-NOTICES.txt', bytes: bytes('n') },
    { path: 'dist/runtime/THIRD-PARTY-NOTICES.txt', bytes: bytes('n') },
    { path: 'icons/icon-128.png', bytes: bytes('p') },
    { path: 'dist/build.json', bytes: bytes('{"version":"1.0.1"}') },
  ];
  const release = { version: '1.0.1', changelog: '## 1.0.1\n' };
  assert.ok(storeEntries(files, release).inputs.some((f) => f.path === 'dist/build.json'));
  assert.throws(() => storeEntries([...files, { path: 'dist/build.json.bak', bytes: bytes('x') }], release), /dist\/build\.json\.bak is not an extension file/);
});
