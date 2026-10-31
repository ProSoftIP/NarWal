// Board #17002: a recording with no purpose is asked for one in a modal before
// its bundle downloads; Cancel or Escape downloads nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NOT_EXPORTED, PURPOSE_QUESTION, askPurpose, exportWithPurpose, hasPurpose, purposeAnswer, readLibraryPurpose, saveLibraryPurpose } from '../../src/ui/purpose-ask.js';
import { writeBundle } from '../../src/export/bundle.js';
import { RecordingLibrary, packBundle, unpackBundle } from '../../../library/src/index.ts';
import { MemoryLibraryStorage } from '../../../library/src/storage-memory.ts';
import { bundleValidator, deriveAgentFiles } from '../../../bundle/src/index.ts';

const dec = new TextDecoder();
const app = (file) => readFile(new URL(`../../app/${file}`, import.meta.url), 'utf8');
const src = (file) => readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const PURPOSE = 'Each thing I point at is a bug to fix on the dashboard';

// Just enough of the DOM for askPurpose: elements with listeners, a modal dialog.
class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.focused = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
  }
  focus() {
    this.focused = true;
  }
  click() {
    if (!this.disabled) this.dispatch('click');
  }
}

class FakeDialog extends FakeElement {
  constructor() {
    super();
    this.open = false;
    this.modal = false;
    this.returnValue = '';
  }
  showModal() {
    this.open = true;
    this.modal = true;
  }
  close(value = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = value;
    this.dispatch('close');
  }
  /** What the browser does on Escape: `cancel`, then the dialog closes. */
  escape() {
    this.dispatch('cancel');
    this.close();
  }
}

function modal() {
  const parts = { dialog: new FakeDialog(), field: new FakeElement(), confirm: new FakeElement(), cancel: new FakeElement(), message: new FakeElement(), count: new FakeElement() };
  const type = (text) => {
    parts.field.value = text;
    parts.field.dispatch('input');
  };
  return { parts, type };
}

// A short stopped recording with one mark, no audio, no purpose (bundle.js input).
function recording(purpose) {
  const T0 = 1_760_385_600_000;
  const attach = { k: 'attach', t: T0 + 10, doc: 'p1', documentId: 'TOP1', frameId: 0, url: 'https://app.example.test/dash', reason: 'boot', boot: { inst: 'i-p1', isTop: true, navType: 'navigate' } };
  const rr = (t, type) => ({ k: 'rr', t, doc: 'p1', seq: 1, sent: t - 0.5, e: { type, timestamp: t, data: {} } });
  const box = { x: 10, y: 20, w: 100, h: 30 };
  const mark = { k: 'obs', t: T0 + 1200, doc: 'p1', seq: 9, sent: T0 + 1199, o: { doc: 'i-p1', kind: 'marker-element', basis: 'user-marked', atMs: 1200, target: { node: 12, tag: 'h2', role: null, name: 'Revenue', nameSource: 'text', box }, via: 'right-click', point: { x: 15, y: 25 }, scroll: { x: 0, y: 0 } } };
  const entries = [{ k: 'session', type: 'start', t: T0 }, attach, rr(T0 + 20, 4), rr(T0 + 21, 2), mark, { k: 'session', type: 'stop', t: T0 + 3000 }];
  return {
    meta: { id: '0c1d2e3f-1111-4222-8333-444455556666', status: 'stopped', startedAt: T0, stoppedAt: T0 + 3000, title: 'Dashboard review', url: 'https://app.example.test/dash', ...(purpose ? { purpose } : {}) },
    eventChunks: [{ seq: 0, startAt: T0, endAt: T0 + 3000, entries }],
    audioChunks: [],
    producer: { name: 'narwal-extension', version: '1.0.0' },
    environment: { browser: 'Chrome', browserVersion: '155.0.0.0', platform: 'linux' },
  };
}

const openLibrary = () => RecordingLibrary.open({ storage: new MemoryLibraryStorage(), productVersion: 'test', validate: bundleValidator, derive: deriveAgentFiles });

test('the recordings page has the modal: a labelled <dialog> asking the exact question, its field described', async () => {
  assert.equal(PURPOSE_QUESTION, 'What is this recording for, and what should happen with each thing you pointed at?');
  const html = await app('recordings.html');
  const dialog = /<dialog id="purpose-ask"[^>]*>([\s\S]*?)<\/dialog>/.exec(html);
  assert.ok(dialog, 'recordings.html has <dialog id="purpose-ask">');
  assert.match(dialog[0], /aria-labelledby="purpose-ask-title"/);
  assert.match(dialog[1], new RegExp(`<h2 id="purpose-ask-title">${PURPOSE_QUESTION.replace(/[?,]/g, '\\$&')}</h2>`));
  assert.match(dialog[1], /<textarea id="purpose-ask-text"[^>]*maxlength="1000"[^>]*autofocus[^>]*aria-labelledby="purpose-ask-title"/);
  assert.match(dialog[1], /<p id="purpose-ask-error" class="error" role="alert"><\/p>/);
  assert.match(dialog[1], /<button id="purpose-ask-ok" class="btn primary" type="button" disabled>Save and export<\/button>/);
  assert.match(dialog[1], /<button id="purpose-ask-cancel" class="btn" type="button">Cancel<\/button>/);
});

test('every Export bundle on the recordings page goes through the purpose question', async () => {
  const code = await src('ui/recordings.js');
  const calls = code.match(/download\([^\n]*/g).filter((line) => !line.startsWith('download(pack, b'));
  assert.equal(calls.length, 4, calls.join('\n'));
  // Rows and status bar of recordings made here, rows saved from a file, and the strip/popup export page.
  assert.equal(calls.filter((c) => /recordedPurpose\((r\.id|meta\.id)\)\)/.test(c)).length, 2, calls.join('\n'));
  assert.equal(calls.filter((c) => /importedPurpose\(r\.id\)\)/.test(c)).length, 1, calls.join('\n'));
  assert.equal(calls.filter((c) => /meta \? recordedPurpose\(id\) : null\)/.test(c)).length, 1, calls.join('\n'));
  // The strip and the popup export by opening this page.
  assert.match(await src('sw/main.js'), /recordings\.html\?id=\$\{encodeURIComponent\(String\(id\)\)\}&export=1/);
});

test('a blank or whitespace answer cannot be confirmed; a key-shaped or too-long one says why', () => {
  for (const blank of ['', '   ', '\n\t ']) assert.deepEqual(purposeAnswer(blank), { ok: false, purpose: null, message: '' }, JSON.stringify(blank));
  assert.equal(hasPurpose(null), false);
  assert.equal(hasPurpose('  '), false);
  const key = purposeAnswer(`use sk-${'a1B2'.repeat(6)}`);
  assert.equal(key.ok, false);
  assert.match(key.message, /looks like a key or token/);
  const long = purposeAnswer('x'.repeat(1001));
  assert.equal(long.ok, false);
  assert.match(long.message, /at most 1000 characters/);
  assert.deepEqual(purposeAnswer(`  ${PURPOSE}  `), { ok: true, purpose: PURPOSE, message: '' });
  assert.equal(hasPurpose(PURPOSE), true);
});

test('the modal opens with focus in the field and Save disabled; blank stays disabled; text enables it and resolves the trimmed purpose', async () => {
  const { parts, type } = modal();
  const answered = askPurpose(parts);
  assert.equal(parts.dialog.open && parts.dialog.modal, true, 'shown with showModal()');
  assert.equal(parts.field.focused, true);
  assert.equal(parts.confirm.disabled, true);
  assert.equal(parts.count.textContent, '0 / 1000');
  type('    ');
  assert.equal(parts.confirm.disabled, true, 'whitespace keeps Save disabled');
  parts.confirm.dispatch('click'); // even a click that gets through
  assert.equal(parts.dialog.open, true, 'a blank answer does not close the modal');
  type(`use sk-${'a1B2'.repeat(6)}`);
  assert.equal(parts.confirm.disabled, true);
  assert.match(parts.message.textContent, /looks like a key or token/);
  type(`  ${PURPOSE} `);
  assert.equal(parts.confirm.disabled, false);
  assert.equal(parts.message.textContent, '');
  parts.confirm.click();
  assert.equal(await answered, PURPOSE);
  assert.equal(parts.dialog.open, false);
  assert.equal(parts.dialog.returnValue, 'confirm');
});

test('must say NO: Cancel and Escape resolve null, even with text typed', async () => {
  const a = modal();
  const cancelled = askPurpose(a.parts);
  a.type(PURPOSE);
  a.parts.cancel.click();
  assert.equal(await cancelled, null);
  const b = modal();
  const escaped = askPurpose(b.parts);
  b.type(PURPOSE);
  b.parts.dialog.escape();
  assert.equal(await escaped, null);
  // Asked again later: the field starts empty and listeners from the last time are gone.
  const again = askPurpose(b.parts);
  assert.equal(b.parts.field.value, '');
  assert.equal(b.parts.confirm.disabled, true);
  b.type(PURPOSE);
  b.parts.confirm.click();
  assert.equal(await again, PURPOSE);
});

test('no purpose: the modal is shown and the download has not started; confirm saves first, then packs', async () => {
  const order = [];
  let reply;
  const purpose = {
    read: async () => null,
    ask: () => {
      order.push('ask');
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
    save: async (text) => order.push(`save:${text}`),
  };
  const done = exportWithPurpose({ purpose, pack: async () => order.push('pack') && { fileName: 'r.narwal.zip' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['ask'], 'waiting on the modal: nothing saved, no bundle written');
  reply(PURPOSE);
  assert.deepEqual(await done, { fileName: 'r.narwal.zip' });
  assert.deepEqual(order, ['ask', `save:${PURPOSE}`, 'pack']);
});

test('must say NO: Cancel exports nothing and saves nothing', async () => {
  const order = [];
  const result = await exportWithPurpose({
    purpose: { read: async () => '   ', ask: async () => order.push('ask') && null, save: async () => order.push('save') },
    pack: async () => order.push('pack'),
  });
  assert.equal(result, null);
  assert.deepEqual(order, ['ask']);
  assert.match(NOT_EXPORTED, /^Not exported\./);
});

test('a recording that already has a purpose exports with no modal; a key-shaped saved one is asked again', async () => {
  const order = [];
  const purpose = (saved) => ({ read: async () => saved, ask: async () => order.push('ask') && PURPOSE, save: async () => order.push('save') });
  assert.equal(await exportWithPurpose({ purpose: purpose(PURPOSE), pack: async () => 'bundle' }), 'bundle');
  assert.deepEqual(order, []);
  await exportWithPurpose({ purpose: purpose(`use sk-${'a1B2'.repeat(6)}`), pack: async () => 'bundle' });
  assert.deepEqual(order, ['ask', 'save'], 'bundle.js would leave it out, so the bundle would have none');
});

test('a recording made here: the confirmed purpose is in manifest.purpose and README "Why it was recorded"', async () => {
  const input = recording();
  const saved = { purpose: null };
  const { files, manifest } = await exportWithPurpose({
    purpose: { read: async () => saved.purpose, ask: async () => `  ${PURPOSE}  `, save: async (text) => (saved.purpose = text.trim()) },
    // As exportRecording: the bundle is written with the purpose as last saved.
    pack: () => writeBundle({ ...input, meta: { ...input.meta, purpose: saved.purpose } }),
  });
  assert.equal(manifest.purpose, PURPOSE);
  const readme = dec.decode(files.get('README.md'));
  assert.match(readme, /## Why it was recorded\n\nThe person who recorded it wrote what it is for:/);
  assert.match(readme, new RegExp(`^purpose="${PURPOSE}"$`, 'm'));
  assert.doesNotMatch(readme, /No purpose was given/);
  // Twin: the same recording exported without the answer says no purpose was given.
  assert.match(dec.decode((await writeBundle(input)).files.get('README.md')), /No purpose was given/);
});

test('a recording saved from a file: the purpose is set on its library copy, and the exported bundle carries it', async () => {
  const library = await openLibrary();
  const { files } = await writeBundle(recording());
  const { recording: imported } = await library.importBundle(await packBundle(files, { validate: bundleValidator }), { fileName: 'r.narwal.zip' });
  assert.equal(await readLibraryPurpose(library, imported.id), null);
  const exported = await exportWithPurpose({
    purpose: { read: () => readLibraryPurpose(library, imported.id), ask: async () => PURPOSE, save: (text) => saveLibraryPurpose(library, imported.id, text) },
    pack: () => library.exportBundle(imported.id),
  });
  assert.equal(await readLibraryPurpose(library, imported.id), PURPOSE);
  const back = await unpackBundle(exported.bytes, { validate: bundleValidator });
  assert.equal(JSON.parse(dec.decode(back.files.get('manifest.json'))).purpose, PURPOSE);
  const readme = dec.decode(back.files.get('README.md'));
  assert.match(readme, new RegExp(`^purpose="${PURPOSE}"$`, 'm'));
  assert.doesNotMatch(readme, /No purpose was given/);
  await assert.rejects(saveLibraryPurpose(library, imported.id, `use sk-${'a1B2'.repeat(6)}`), /looks like a key or token/);
});
