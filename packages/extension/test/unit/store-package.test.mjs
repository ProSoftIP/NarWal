import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeEntries } from '../../src/release/store-package.js';

const enc = (text) => new TextEncoder().encode(text);
const manifest = (fields = {}) => ({ path: 'manifest.json', bytes: enc(JSON.stringify({ manifest_version: 3, name: 'NarWal', version: '1.0.0', key: 'MIIB-pinned', ...fields })) });
const extension = (extra = []) => [
  manifest(),
  { path: 'popup.html', bytes: enc('<!doctype html>') },
  { path: 'ui.css', bytes: enc('body{}') },
  { path: 'icons/icon-128.png', bytes: new Uint8Array([137, 80]) },
  { path: 'logo/narwal.svg', bytes: enc('<svg/>') },
  { path: 'dist/popup.js', bytes: enc('console.log(1);') },
  { path: 'dist/LICENSE.md', bytes: enc('# EULA') },
  { path: 'dist/THIRD-PARTY-NOTICES.txt', bytes: enc('notices') },
  { path: 'dist/runtime/THIRD-PARTY-NOTICES.txt', bytes: enc('notices') },
  { path: 'dist/runtime/sherpa-onnx.wasm', bytes: new Uint8Array([0, 97, 115, 109]) },
  ...extra,
];
const release = { version: '1.0.0', changelog: '# Changelog\n\n## 1.0.0 (unreleased)\n\n- first\n' };

test('the store zip has the manifest at the root, with no key', () => {
  const { inputs, manifest: m } = storeEntries(extension(), release);
  assert.equal(m.key, undefined);
  assert.equal(m.version, '1.0.0');
  const root = inputs.find((i) => i.path === 'manifest.json');
  assert.ok(root);
  assert.equal(JSON.parse(new TextDecoder().decode(root.bytes)).key, undefined);
  assert.ok(inputs.every((i) => !i.path.startsWith('narwal/')));
});

test('already-compressed files are stored, text is deflated', () => {
  const { inputs } = storeEntries(extension(), release);
  const by = Object.fromEntries(inputs.map((i) => [i.path, i.compress]));
  assert.equal(by['icons/icon-128.png'], false);
  assert.equal(by['dist/runtime/sherpa-onnx.wasm'], true);
  assert.equal(by['dist/popup.js'], true);
});

for (const path of ['dist/popup.js.map', 'test/unit/x.test.mjs', 'fixtures/page.html', 'research/notes.md', 'validation/soak.json', '.DS_Store', 'src/ui/popup.js']) {
  test(`${path} is refused`, () => {
    assert.throws(() => storeEntries(extension([{ path, bytes: enc('x') }]), release), new RegExp(`${path.replace(/\./g, '\\.')} is not an extension file`));
  });
}

test('a script that links a source map is refused', () => {
  const files = extension().map((f) => (f.path === 'dist/popup.js' ? { ...f, bytes: enc('x();\n//# sourceMappingURL=popup.js.map\n') } : f));
  assert.throws(() => storeEntries(files, release), /dist\/popup\.js links a source map/);
});

test('a script that only mentions sourceMappingURL in code is kept', () => {
  const files = extension().map((f) => (f.path === 'dist/popup.js' ? { ...f, bytes: enc('s.replace(/^\\/\\*\\s*# sourceMappingURL=/, "")') } : f));
  assert.doesNotThrow(() => storeEntries(files, release));
});

test('a build with test hooks is refused', () => {
  const files = extension().map((f) => (f.path === 'dist/popup.js' ? { ...f, bytes: enc("case 'test:model-install':") } : f));
  assert.throws(() => storeEntries(files, release), /built with test hooks/);
});

test('the licence and the notices must be in the zip', () => {
  const files = extension().filter((f) => f.path !== 'dist/LICENSE.md' && f.path !== 'dist/THIRD-PARTY-NOTICES.txt');
  assert.throws(() => storeEntries(files, release), /dist\/LICENSE\.md is missing[\s\S]*dist\/THIRD-PARTY-NOTICES\.txt is missing/);
});

test('the manifest version must match package.json', () => {
  const files = extension().map((f) => (f.path === 'manifest.json' ? manifest({ version: '0.1.0' }) : f));
  assert.throws(() => storeEntries(files, release), /manifest\.json version 0\.1\.0 is not package\.json version 1\.0\.0/);
});

test('the version needs a CHANGELOG section', () => {
  assert.throws(() => storeEntries(extension(), { ...release, changelog: '# Changelog\n\n## 1.0.01\n\n## 0.1.0\n' }), /CHANGELOG\.md has no "## 1\.0\.0" section/);
});
