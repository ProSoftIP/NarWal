import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { MANIFEST_PATH, bundleFileName, checkBundleFiles, packBundle, unpackBundle } from '../src/bundle.ts';
import type { BundleValidator } from '../src/bundle.ts';
import { NarwalError } from '../src/errors.ts';
import type { NarwalErrorCode } from '../src/errors.ts';
import { RecordingLibrary } from '../src/library.ts';
import type { LibraryOptions } from '../src/library.ts';
import { IdbLibraryStorage } from '../src/storage-idb.ts';
import { MemoryLibraryStorage } from '../src/storage-memory.ts';
import type { LibraryStorage } from '../src/storage.ts';
import { openZip } from '../src/zip.ts';
import { decode, fixtureBundle, fixtureContent, json, jsonl, noise, text, withManifest, zipUnchecked } from './helpers.ts';

function refuses(code: NarwalErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof NarwalError, `expected NarwalError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

/** A clock that moves one second per reading (opening a new store takes the first) and IDs that count up. */
function open(storage: LibraryStorage = new MemoryLibraryStorage(), extra: Partial<LibraryOptions> = {}) {
  let tick = 0;
  let id = 0;
  return RecordingLibrary.open({
    storage,
    productVersion: '0.1.0-test',
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++)),
    newId: () => `lib-${++id}`,
    ...extra,
  });
}

async function changed(path: string, bytes: Uint8Array, manifest: Record<string, unknown> = {}) {
  const content = fixtureContent();
  content.set(path, bytes);
  return withManifest(content, manifest);
}

test('round trip: export then import keeps every file byte for byte', async () => {
  const original = await fixtureBundle();
  const sender = await open();
  const saved = await sender.save(original);
  const exported = await sender.exportBundle(saved.id);

  const recipient = await open();
  const { recording, warnings } = await recipient.importBundle(exported.bytes, { fileName: exported.fileName });
  assert.deepEqual(warnings, []);

  const stored = await recipient.readFiles(recording.id);
  assert.deepEqual([...stored.keys()].sort(), [...original.keys()].sort());
  for (const [path, bytes] of original) assert.deepEqual(stored.get(path), bytes, path);

  // Audio, events, notes and timing, named one by one.
  assert.deepEqual(stored.get('audio/narration.webm'), original.get('audio/narration.webm'));
  assert.deepEqual(stored.get('audio/clock.jsonl'), original.get('audio/clock.jsonl'));
  assert.deepEqual(stored.get('rrweb/d1.jsonl'), original.get('rrweb/d1.jsonl'));
  assert.deepEqual(stored.get('observations.jsonl'), original.get('observations.jsonl'));
  assert.match(decode(stored.get('edits.jsonl') as Uint8Array), /"Same on mobile"/);
  const manifest = JSON.parse(decode(stored.get(MANIFEST_PATH) as Uint8Array));
  assert.equal(manifest.clock.originEpochMs, 1760385600000.25);
  assert.equal(manifest.durationMs, 312400.5);
  assert.equal(manifest.audio.startMs, 102.3);

  // A second generation is the same archive: nothing drifts per hop.
  const again = await recipient.exportBundle(recording.id);
  assert.deepEqual(again.bytes, exported.bytes);
  assert.equal(again.sha256, exported.sha256);
});

test('import keeps the producer, schema version and unknown manifest fields, and records where it came from', async () => {
  const files = await fixtureBundle({ schemaVersion: '1.7', futureField: { kept: true } });
  const archive = await packBundle(files);
  const library = await open();
  const { recording } = await library.importBundle(archive, { fileName: 'C:\\Users\\sam\\Downloads\\review.narwal.zip' });

  assert.equal(recording.schemaVersion, '1.7');
  assert.equal(recording.recordingId, 'rec_2026-10-13_a1b2c3');
  assert.equal(recording.createdAt, '2026-10-13T20:00:00.000Z');
  assert.deepEqual(recording.origin, {
    kind: 'imported',
    importedAt: '2026-10-14T12:00:01.000Z',
    archiveSha256: recording.origin.kind === 'imported' ? recording.origin.archiveSha256 : '',
    archiveBytes: archive.length,
    fileName: 'review.narwal.zip',
  });
  assert.match(recording.origin.kind === 'imported' ? recording.origin.archiveSha256 : '', /^[0-9a-f]{64}$/);
  assert.deepEqual(recording.history, [{ event: 'imported', at: '2026-10-14T12:00:01.000Z' }]);

  const manifest = JSON.parse(decode(await library.readFile(recording.id, MANIFEST_PATH)));
  assert.deepEqual(manifest.producer, { name: 'narwal-extension', version: '0.1.0' });
  assert.deepEqual(manifest.futureField, { kept: true });
  assert.equal(manifest.schemaVersion, '1.7');
});

test('a different schema major version is refused with a plain message', async () => {
  const archive = zipUnchecked(await fixtureBundle({ schemaVersion: '2.0' }));
  const library = await open();
  await assert.rejects(library.importBundle(archive), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.equal(error.code, 'schema-unsupported');
    assert.match(error.message, /schema 2\.0; this NarWal reads schema 1\.x/);
    return true;
  });
  assert.deepEqual(await library.list(), []);
});

test('import is inert: no script runs and nothing is fetched', async () => {
  const globals = globalThis as Record<string, unknown>;
  const original = { fetch: globals.fetch, WebSocket: globals.WebSocket };
  const calls: string[] = [];
  globals.fetch = () => {
    calls.push('fetch');
    throw new Error('network used');
  };
  globals.WebSocket = function () {
    calls.push('WebSocket');
    throw new Error('network used');
  };
  try {
    const library = await open();
    const { recording } = await library.importBundle(await packBundle(await fixtureBundle()));
    const stream = decode(await library.readFile(recording.id, 'rrweb/d1.jsonl'));
    assert.match(stream, /__narwalPwned = true/, 'the page script is stored as text');
    assert.match(stream, /javascript:alert\(1\)/);
    assert.equal(globals.__narwalPwned, undefined);
    assert.deepEqual(calls, []);
    await library.exportBundle(recording.id);
    assert.deepEqual(calls, []);
  } finally {
    globals.fetch = original.fetch;
    globals.WebSocket = original.WebSocket;
  }
});

test('the package source has no network, script-evaluation, markup or browser-authority calls', async () => {
  const dir = new URL('../src/', import.meta.url);
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\beval\s*\(|new Function|innerHTML|document\.|importScripts|\bchrome\.|localStorage|\bcookie\b(?!\|)/;
  for (const name of await readdir(dir)) {
    const lines = (await readFile(new URL(name, dir), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      // Comments may name what the code avoids, and the credential rule names "cookie" as a key to refuse.
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.includes('CREDENTIAL_KEY =')) return;
      assert.doesNotMatch(line, banned, `${name}:${index + 1}`);
    });
  }
});

test('archives with files outside the manifest, missing files or changed bytes are refused', async () => {
  const library = await open();

  const extra = await fixtureBundle();
  extra.set('agent/extra.md', text('surprise'));
  await assert.rejects(library.importBundle(zipUnchecked(extra)), refuses('file-unlisted'));

  const missing = await fixtureBundle();
  missing.delete('audio/narration.webm');
  await assert.rejects(library.importBundle(zipUnchecked(missing)), refuses('file-missing'));

  const tampered = await fixtureBundle();
  const audio = (tampered.get('audio/narration.webm') as Uint8Array).slice();
  audio[100] = (audio[100] as number) ^ 0xff;
  tampered.set('audio/narration.webm', audio);
  await assert.rejects(library.importBundle(zipUnchecked(tampered)), refuses('file-mismatch'));

  const resized = await fixtureBundle();
  resized.set('gaps.jsonl', jsonl([{ id: 'g1' }, { id: 'g2' }]));
  await assert.rejects(library.importBundle(zipUnchecked(resized)), refuses('file-mismatch'));

  const noManifest = await fixtureBundle();
  noManifest.delete(MANIFEST_PATH);
  await assert.rejects(library.importBundle(zipUnchecked(noManifest)), refuses('manifest-missing'));

  assert.deepEqual(await library.list(), [], 'a failed import stores nothing');
});

test('markup, script and other unknown file types are refused even when the manifest lists them', async () => {
  const library = await open();
  for (const path of ['replay/index.html', 'agent/run.js', 'audio/cover.svg', 'notes', 'a.JSON.exe']) {
    const content = fixtureContent();
    content.set(path, text('<script>alert(1)</script>'));
    const archive = zipUnchecked(await withManifest(content));
    await assert.rejects(library.importBundle(archive), refuses('file-type-refused'), path);
  }
});

test('a manifest that is not what the schema says is refused', async () => {
  const library = await open();
  const cases: Array<[Record<string, unknown>, NarwalErrorCode]> = [
    [{ format: 'zip' }, 'manifest-invalid'],
    [{ schemaVersion: '1' }, 'manifest-invalid'],
    [{ schemaVersion: 1.0 }, 'manifest-invalid'],
    [{ recordingId: '../../x' }, 'manifest-invalid'],
    [{ title: '' }, 'manifest-invalid'],
    [{ title: 'x'.repeat(201) }, 'manifest-invalid'],
    [{ createdAt: 'yesterday' }, 'manifest-invalid'],
    [{ durationMs: -1 }, 'manifest-invalid'],
    [{ state: 'recording' }, 'manifest-invalid'],
    [{ files: 'none' }, 'manifest-invalid'],
    [{ files: [{ path: 'manifest.json', bytes: 1, sha256: 'a'.repeat(64), mediaType: 'application/json' }] }, 'manifest-invalid'],
    [{ files: [{ path: '../x.json', bytes: 1, sha256: 'a'.repeat(64), mediaType: 'application/json' }] }, 'entry-path-unsafe'],
    [{ files: [{ path: 'x.json', bytes: 1.5, sha256: 'a'.repeat(64), mediaType: 'application/json' }] }, 'manifest-invalid'],
    [{ files: [{ path: 'x.json', bytes: 1, sha256: 'A'.repeat(64), mediaType: 'application/json' }] }, 'manifest-invalid'],
  ];
  for (const [manifest, code] of cases) {
    const files = await fixtureBundle(manifest);
    await assert.rejects(library.importBundle(zipUnchecked(files)), refuses(code), JSON.stringify(manifest).slice(0, 80));
  }
  const notJson = await fixtureBundle();
  notJson.set(MANIFEST_PATH, text('{"format": '));
  await assert.rejects(library.importBundle(zipUnchecked(notJson)), refuses('file-invalid-json'));
  const array = await fixtureBundle();
  array.set(MANIFEST_PATH, text('[]'));
  await assert.rejects(library.importBundle(zipUnchecked(array)), refuses('manifest-invalid'));
  assert.deepEqual(await library.list(), []);
});

test('a manifest over 1 MiB is refused before the other files are read', async () => {
  // Padding that does not compress, so the size rule answers and not the expansion rule.
  const files = await fixtureBundle({ padding: Buffer.from(noise(600 * 1024, 7)).toString('hex') });
  await assert.rejects(unpackBundle(zipUnchecked(files)), refuses('manifest-invalid'));
  await assert.rejects(unpackBundle(zipUnchecked(await fixtureBundle({ padding: 'x'.repeat(2 * 1024 * 1024) }))), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.ok(['manifest-invalid', 'entry-ratio'].includes(error.code), error.code);
    return true;
  });
});

test('JSON files must parse, line by line for .jsonl, and deep nesting does not crash the check', async () => {
  const library = await open();
  await assert.rejects(library.save(await changed('documents.json', text('{"documents": [}'))), refuses('file-invalid-json'));
  await assert.rejects(library.save(await changed('gaps.jsonl', text('{"id":"g1"}\n\n{"id":"g2"}\n'))), refuses('file-invalid-json'));
  await assert.rejects(library.save(await changed('gaps.jsonl', text('{"id":"g1"}\nnot json\n'))), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.deepEqual(error.detail, { path: 'gaps.jsonl', line: 2 });
    return true;
  });
  await assert.rejects(library.save(await changed('documents.json', new Uint8Array([0x7b, 0xff, 0x7d]))), refuses('file-invalid-json'));
  const deep = '['.repeat(200_000) + ']'.repeat(200_000);
  // Refused or stored as data, by the runtime's parser; never a stack overflow in the credential walk.
  const outcome = await library.save(await changed('documents.json', text(deep))).then(
    () => 'stored',
    (error: unknown) => (error instanceof NarwalError ? error.code : `crash: ${String(error)}`),
  );
  assert.ok(['stored', 'file-invalid-json'].includes(outcome), outcome);
  const hidden = '['.repeat(50_000) + '{"apiKey":"x"}' + ']'.repeat(50_000);
  await assert.rejects(library.save(await changed('documents.json', text(hidden))), refuses('credential-refused'));
});

test('no API keys: credential-shaped fields and values are refused on save, export and import', async () => {
  const library = await open();
  // Built at run time: these are fixtures, and a secret scanner must not read them as keys.
  const fakeKey = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-');
  const fakeShortKey = ['sk', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');
  const fakeBearer = ['Bearer', 'not-a-real-token'].join(' ');
  const withKeyField = await changed('transcript/r1.json', json({ revisionId: 'r1', provider: 'openai', settings: { apiKey: 'abc' } }));
  const withKeyValue = await changed('edits.jsonl', jsonl([{ id: 'n1', type: 'note', atMs: 1, text: `key is ${fakeKey}` }]));
  const withBearer = await changed('documents.json', json({ documents: [], debug: [fakeBearer] }));
  const withMarkdownKey = await changed('agent/walkthrough.md', text(`said="use ${fakeShortKey}"`));
  const inManifest = await fixtureBundle({ producer: { name: 'narwal-extension', version: '0.1.0', deepgramToken: 'x' } });
  const nested = await changed('agent/walkthrough.json', json({ entries: [{ evidence: [{ meta: { Set_Cookie: 'sid=1' } }] }] }));

  for (const [name, files] of Object.entries({ withKeyField, withKeyValue, withBearer, withMarkdownKey, inManifest, nested })) {
    await assert.rejects(library.save(files), refuses('credential-refused'), `save ${name}`);
    await assert.rejects(packBundle(files), refuses('credential-refused'), `pack ${name}`);
    await assert.rejects(library.importBundle(zipUnchecked(files)), refuses('credential-refused'), `import ${name}`);
  }
  assert.deepEqual(await library.list(), []);

  // The error says where, and never repeats the value.
  await assert.rejects(library.save(withKeyValue), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.deepEqual(error.detail, { path: 'edits.jsonl', line: 1 });
    assert.doesNotMatch(error.message + JSON.stringify(error.detail), /sk-proj/);
    return true;
  });
});

test('ordinary words with "sk-" inside them are not keys', async () => {
  const library = await open();
  // Each has "sk-" followed by 20 or more key characters, but not at the start of a word.
  const words = ['risk-management-in-financial-services', '/desk-reservations-calendar-view', 'task-list-overview-dashboard'];
  const content = fixtureContent();
  content.set('documents.json', json({ documents: [], titles: words }));
  content.set('observations.jsonl', jsonl(words.map((name, index) => ({ id: `o${index + 1}`, kind: 'click', basis: 'observed', atMs: index, name }))));
  content.set('agent/walkthrough.md', text(`# Review\n\n${words.join('\n')}\n`));
  const saved = await library.save(await withManifest(content));
  await library.exportBundle(saved.id);

  // A key at the start of a word, or after punctuation, is still refused.
  const fakeKey = ['sk', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');
  for (const value of [fakeKey, `(${fakeKey})`, `key=${fakeKey}`, `/${fakeKey}`]) {
    await assert.rejects(library.save(await changed('agent/walkthrough.md', text(value))), refuses('credential-refused'), value);
    await assert.rejects(library.save(await changed('documents.json', json({ documents: [], debug: value }))), refuses('credential-refused'), value);
  }
});

test('export refuses stored data that would leak a key, even if it reached the store unchecked', async () => {
  const storage = new MemoryLibraryStorage();
  const library = await open(storage);
  const saved = await library.save(await fixtureBundle());
  // Write past the library, as a bug in another writer could.
  const bad = await changed('transcript/r1.json', json({ revisionId: 'r1', authorization: 'Token abc' }));
  const record = (await storage.getRecord(saved.id))!;
  await storage.replaceRecording(record, bad, record.revision);
  await assert.rejects(library.exportBundle(saved.id), refuses('credential-refused'));
});

test('an exported bundle is an ordinary zip with the manifest first and readable Markdown and JSON', async () => {
  const library = await open();
  const saved = await library.save(await fixtureBundle());
  const exported = await library.exportBundle(saved.id);
  assert.equal(exported.fileName, 'dashboard-review-rec_2026-10-13_a1b2c3.narwal.zip');
  const zip = openZip(exported.bytes);
  assert.equal(zip.entries[0]?.path, MANIFEST_PATH);
  assert.match(decode(await zip.read('agent/walkthrough.md')), /said="This should collapse"/);
  assert.equal(JSON.parse(decode(await zip.read('agent/walkthrough.json'))).format, 'narwal.agent-view');
  const audio = zip.entries.find((entry) => entry.path === 'audio/narration.webm');
  assert.equal(audio?.compressedSize, audio?.size, 'audio is stored, not deflated');
});

test('export file names are plain ASCII and never a path', () => {
  assert.equal(bundleFileName({ title: '../../etc/passwd', recordingId: 'r1' }), 'etc-passwd-r1.narwal.zip');
  assert.equal(bundleFileName({ title: 'Año nuevo: revisión #2', recordingId: 'r1' }), 'ano-nuevo-revision-2-r1.narwal.zip');
  assert.equal(bundleFileName({ title: '日本語', recordingId: 'r1' }), 'recording-r1.narwal.zip');
});

test('lists saved and interrupted recordings, newest first, with pending ones from the recorder', async () => {
  const pending = [{ id: 'raw-9', status: 'interrupted' as const, startedAt: '2026-10-14T09:00:00.000Z', title: null }];
  const library = await open(new MemoryLibraryStorage(), { pending: async () => pending });
  await library.save(await fixtureBundle({ recordingId: 'rec_a', createdAt: '2026-10-11T10:00:00.000Z' }));
  await library.save(await fixtureBundle({ recordingId: 'rec_b', createdAt: '2026-10-13T10:00:00.000Z', state: 'recovered' }));
  await library.save(await fixtureBundle({ recordingId: 'rec_c', createdAt: '2026-10-12T10:00:00.000Z' }));

  const listed = await library.list();
  assert.deepEqual(listed.map((item) => [item.recordingId, item.status]), [
    ['rec_b', 'interrupted'],
    ['rec_c', 'saved'],
    ['rec_a', 'saved'],
  ]);
  assert.equal(listed[0]?.origin.kind, 'recorded');
  assert.equal(listed[0]?.durationMs, 312400.5);
  assert.ok((listed[0]?.bytes ?? 0) > 40_000);
  assert.deepEqual(await library.listPending(), pending);
  assert.deepEqual(await (await open()).listPending(), []);

  // An interrupted recording exports like any other and stays marked.
  const exported = await library.exportBundle(listed[0]!.id);
  const { recording } = await (await open()).importBundle(exported.bytes);
  assert.equal(recording.status, 'interrupted');
});

test('importing the same bundle twice is refused unless the user asks for a copy', async () => {
  const library = await open();
  const archive = await packBundle(await fixtureBundle());
  const first = await library.importBundle(archive);
  await assert.rejects(library.importBundle(archive), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.equal(error.code, 'duplicate-import');
    assert.deepEqual(error.detail, { id: first.recording.id, inTrash: false });
    return true;
  });
  await library.delete(first.recording.id);
  await assert.rejects(library.importBundle(archive), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.match(error.message, /in your trash/);
    return true;
  });
  const copy = await library.importBundle(archive, { allowDuplicate: true });
  assert.notEqual(copy.recording.id, first.recording.id);
});

test('delete moves to the trash, restore brings it back, purge needs the trash and a confirmation', async () => {
  const library = await open();
  const original = await fixtureBundle();
  const saved = await library.save(original);

  await assert.rejects(library.purge(saved.id, { confirm: true }), refuses('recording-state'));

  const deleted = await library.delete(saved.id);
  assert.equal(deleted.deletedAt, '2026-10-14T12:00:02.000Z');
  assert.equal(deleted.updatedAt, deleted.deletedAt);
  assert.deepEqual(await library.list(), []);
  assert.deepEqual((await library.listTrash()).map((item) => item.id), [saved.id]);
  await assert.rejects(library.exportBundle(saved.id), refuses('recording-state'));
  await assert.rejects(library.delete(saved.id), refuses('recording-state'));
  // Still on the device, whole.
  assert.deepEqual(await library.readFile(saved.id, 'audio/narration.webm'), original.get('audio/narration.webm'));

  const restored = await library.restore(saved.id);
  assert.equal(restored.deletedAt, null);
  assert.deepEqual(restored.history.map((item) => item.event), ['saved', 'deleted', 'restored']);
  assert.deepEqual((await library.list()).map((item) => item.id), [saved.id]);
  for (const [path, bytes] of original) assert.deepEqual(await library.readFile(saved.id, path), bytes, path);

  await library.delete(saved.id);
  const unconfirmed = library.purge as unknown as (id: string, options?: unknown) => Promise<void>;
  await assert.rejects(unconfirmed.call(library, saved.id), refuses('confirmation-required'));
  await assert.rejects(unconfirmed.call(library, saved.id, { confirm: 'yes' }), refuses('confirmation-required'));
  assert.equal((await library.listTrash()).length, 1);

  await library.purge(saved.id, { confirm: true });
  assert.deepEqual(await library.listTrash(), []);
  await assert.rejects(library.get(saved.id), refuses('recording-not-found'));
  await assert.rejects(library.readFile(saved.id, MANIFEST_PATH), refuses('recording-not-found'));
});

test('emptyTrash removes only trashed recordings', async () => {
  const library = await open();
  const keep = await library.save(await fixtureBundle({ recordingId: 'rec_keep' }));
  const a = await library.save(await fixtureBundle({ recordingId: 'rec_a' }));
  const b = await library.save(await fixtureBundle({ recordingId: 'rec_b' }));
  await library.delete(a.id);
  await library.delete(b.id);
  const unconfirmed = library.emptyTrash as unknown as (options?: unknown) => Promise<number>;
  await assert.rejects(unconfirmed.call(library), refuses('confirmation-required'));
  assert.equal(await library.emptyTrash({ confirm: true }), 2);
  assert.deepEqual((await library.list()).map((item) => item.id), [keep.id]);
});

test('update replaces the files of one recording and keeps its origin and history', async () => {
  const library = await open();
  const { recording } = await library.importBundle(await packBundle(await fixtureBundle()));
  const edits = jsonl([
    { id: 'n1', type: 'note', atMs: 70300, endMs: null, text: 'Same on mobile', createdAt: '2026-10-13T20:10:00.000Z' },
    { id: 'n2', type: 'note', atMs: 90000, endMs: null, text: 'Added by the recipient', createdAt: '2026-10-14T08:00:00.000Z' },
  ]);
  const updated = await library.update(recording.id, await changed('edits.jsonl', edits));
  assert.equal(updated.id, recording.id);
  assert.equal(updated.origin.kind, 'imported');
  assert.notEqual(updated.contentSha256, recording.contentSha256);
  assert.deepEqual(updated.history.map((item) => item.event), ['imported', 'updated']);
  assert.deepEqual(await library.readFile(recording.id, 'edits.jsonl'), edits);

  await assert.rejects(library.update(recording.id, await fixtureBundle({ recordingId: 'rec_other' })), refuses('recording-state'));
  const broken = await fixtureBundle();
  broken.set('gaps.jsonl', text('changed without the manifest\n'));
  await assert.rejects(library.update(recording.id, broken), refuses('file-mismatch'));
  assert.deepEqual(await library.readFile(recording.id, 'edits.jsonl'), edits, 'a refused update changes nothing');
});

test('update adds layers only: captured files, existing revisions and earlier edits stay as they were', async () => {
  const library = await open();
  const original = await fixtureBundle();
  const saved = await library.save(original);
  const r1 = JSON.parse(decode(fixtureContent().get('transcript/r1.json') as Uint8Array));
  const oldEdits = fixtureContent().get('edits.jsonl') as Uint8Array;
  const without = (path: string, manifest: Record<string, unknown> = {}) => {
    const content = fixtureContent();
    content.delete(path);
    return withManifest(content, manifest);
  };
  const refused = async (files: Promise<Map<string, Uint8Array>>, path: string, reason: string) =>
    assert.rejects(library.update(saved.id, await files), (error: unknown) => {
      assert.ok(error instanceof NarwalError, String(error));
      assert.equal(error.code, 'update-refused', error.message);
      assert.deepEqual(error.detail, { path, reason });
      assert.match(error.message, /cannot change what was captured/);
      return true;
    });

  await refused(changed('observations.jsonl', jsonl([{ id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' }])), 'observations.jsonl', 'changes captured file');
  await refused(changed('audio/narration.webm', noise(40_000, 2)), 'audio/narration.webm', 'changes captured file');
  await refused(without('gaps.jsonl'), 'gaps.jsonl', 'removes captured file');
  await refused(changed('rrweb/d2.jsonl', jsonl([{ seq: 0, sentMs: 1, receivedMs: 1, event: { type: 4 } }])), 'rrweb/d2.jsonl', 'adds captured file');
  await refused(changed('transcript/r1.json', json({ ...r1, segments: [{ ...r1.segments[0], text: 'This should expand' }] })), 'transcript/r1.json', 'changes transcript revision');
  await refused(without('transcript/r1.json', { transcript: { activeRevision: null } }), 'transcript/r1.json', 'removes transcript revision');
  await refused(changed('edits.jsonl', jsonl([{ id: 'n1', type: 'note', atMs: 70300, endMs: null, text: 'Rewritten', createdAt: '2026-10-13T20:10:00.000Z' }])), 'edits.jsonl', 'rewrites earlier lines of');
  await refused(without('edits.jsonl'), 'edits.jsonl', 'removes');
  await refused(fixtureBundle({ durationMs: 1000 }), MANIFEST_PATH, 'changes captured fields of');
  await refused(fixtureBundle({ clock: { originEpochMs: 1 } }), MANIFEST_PATH, 'changes captured fields of');
  await refused(fixtureBundle({ state: 'recovered' }), MANIFEST_PATH, 'changes captured fields of');
  assert.deepEqual(await library.readFiles(saved.id), original, 'a refused update changes nothing');

  // Allowed together: a new active revision, an appended correction, regenerated agent files, a new title and purpose.
  const content = fixtureContent();
  const r2 = json({ ...r1, revisionId: 'r2', source: 'after-recording', provider: 'openai', model: 'whisper-1' });
  content.set('transcript/r2.json', r2);
  const correction = { id: 'c1', type: 'correction', revisionId: 'r2', segmentId: 's1', text: 'This should expand', createdAt: '2026-10-14T08:00:00.000Z' };
  const edits = new Uint8Array([...oldEdits, ...jsonl([correction])]);
  content.set('edits.jsonl', edits);
  content.set('agent/walkthrough.md', text('# Renamed\n\nregenerated\n'));
  content.delete('agent/walkthrough.json');
  content.set('README.md', text('# NarWal recording bundle: "Renamed"\n'));
  content.set('AGENTS.md', text('# NarWal recording bundle: "Renamed"\n'));
  const updated = await library.update(saved.id, await withManifest(content, { transcript: { activeRevision: 'r2' }, title: 'Renamed', purpose: 'Each mark is a change request' }));
  assert.equal(updated.title, 'Renamed');
  assert.equal(JSON.parse(decode(await library.readFile(saved.id, MANIFEST_PATH))).purpose, 'Each mark is a change request');
  assert.deepEqual(await library.readFile(saved.id, 'README.md'), content.get('README.md'));
  assert.deepEqual(await library.readFile(saved.id, 'transcript/r1.json'), original.get('transcript/r1.json'));
  assert.deepEqual(await library.readFile(saved.id, 'transcript/r2.json'), r2);
  assert.deepEqual(await library.readFile(saved.id, 'edits.jsonl'), edits);
  assert.deepEqual(await library.readFile(saved.id, 'audio/narration.webm'), original.get('audio/narration.webm'));
});

test('the schema validator plugs in: errors refuse, warnings come back', async () => {
  const validate: BundleValidator = (files) => [
    { severity: 'warning', code: 'unknown-kind', message: 'unknown observation kind', file: 'observations.jsonl', line: 2 },
    ...(decode(files.get(MANIFEST_PATH) as Uint8Array).includes('"Bad"')
      ? [{ severity: 'error' as const, code: 'ref-unresolved', message: 'doc d9 does not exist', file: 'observations.jsonl', line: 1 }]
      : []),
  ];
  const library = await open(new MemoryLibraryStorage(), { validate });
  const good = await library.importBundle(await packBundle(await fixtureBundle()));
  assert.deepEqual(good.warnings.map((issue) => issue.code), ['unknown-kind']);

  await assert.rejects(library.importBundle(zipUnchecked(await fixtureBundle({ title: 'Bad' }))), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.equal(error.code, 'validation-failed');
    assert.match(error.message, /doc d9 does not exist/);
    return true;
  });
  assert.equal((await library.list()).length, 1);
});

test('checkBundleFiles reports the content hash and total size', async () => {
  const files = await fixtureBundle();
  const checked = await checkBundleFiles(files);
  assert.match(checked.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(checked.bytes, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
});

test('storage versions: a newer store is refused untouched, an older one is migrated step by step', async () => {
  const storage = new MemoryLibraryStorage();
  const v1 = await open(storage);
  const saved = await v1.save(await fixtureBundle());
  assert.equal((await storage.readMeta())?.storageVersion, 1);

  // An "update" to a build with storage version 3 and both migrations.
  const steps: number[] = [];
  const v3 = await open(storage, {
    storageVersion: 3,
    migrations: {
      1: async () => void steps.push(1),
      2: async (store) => {
        steps.push(2);
        for (const record of await store.listRecords()) {
          await store.updateRecord(record.id, (current) => (current ? { ...current, title: `${current.title} (migrated)` } : null));
        }
      },
    },
  });
  assert.deepEqual(steps, [1, 2]);
  assert.equal((await storage.readMeta())?.storageVersion, 3);
  assert.equal((await v3.get(saved.id)).title, 'Dashboard review (migrated)');
  assert.deepEqual(await v3.readFile(saved.id, 'audio/narration.webm'), (await fixtureBundle()).get('audio/narration.webm'));

  // Opening again runs nothing.
  await open(storage, { storageVersion: 3, migrations: { 1: async () => void steps.push(1), 2: async () => void steps.push(2) } });
  assert.deepEqual(steps, [1, 2]);

  // A "downgrade" to the version 1 build.
  const before = await storage.readMeta();
  await assert.rejects(open(storage), (error: unknown) => {
    assert.ok(error instanceof NarwalError);
    assert.equal(error.code, 'storage-newer');
    assert.match(error.message, /nothing was changed/);
    return true;
  });
  assert.deepEqual(await storage.readMeta(), before);
  assert.equal((await storage.listRecords()).length, 1);

  await assert.rejects(open(storage, { storageVersion: 5, migrations: {} }), refuses('storage-migration-missing'));
  assert.equal((await storage.readMeta())?.storageVersion, 3);
});

/**
 * Wraps a store so that the next `readRecording` pauses after it has read,
 * until `release()`. Another page writes to the unwrapped store meanwhile.
 */
function pauseNextRead(storage: LibraryStorage) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const paused = new Promise<void>((resolve) => (reached = resolve));
  let armed = true;
  const wrapped = new Proxy(storage, {
    get(target, key) {
      if (key === 'readRecording') {
        return async (id: string) => {
          const result = await target.readRecording(id);
          if (armed) {
            armed = false;
            reached();
            await released;
          }
          return result;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, paused, release };
}

async function appended(note: string) {
  const content = fixtureContent();
  const line = { id: `n-${note}`, type: 'note', atMs: 1000, endMs: null, text: note, createdAt: '2026-10-14T08:00:00.000Z' };
  content.set('edits.jsonl', new Uint8Array([...(content.get('edits.jsonl') as Uint8Array), ...jsonl([line])]));
  return withManifest(content);
}

// The same behaviour is required of both stores.
const stores: Array<[string, () => Promise<{ storage: LibraryStorage; reopen: () => Promise<LibraryStorage> }>]> = [
  [
    'memory',
    async () => {
      const storage = new MemoryLibraryStorage();
      return { storage, reopen: async () => storage };
    },
  ],
  [
    'IndexedDB',
    async () => {
      const factory = new IDBFactory();
      const storage = await IdbLibraryStorage.open(factory, IDBKeyRange);
      return {
        storage,
        reopen: async () => {
          storage.close();
          return IdbLibraryStorage.open(factory, IDBKeyRange);
        },
      };
    },
  ],
];

for (const [name, make] of stores) {
  test(`${name} store: recordings survive closing and reopening, as after a manual update`, async () => {
    const { storage, reopen } = await make();
    const original = await fixtureBundle();
    const first = await open(storage);
    const saved = await first.save(original);
    const other = await first.save(await fixtureBundle({ recordingId: 'rec_other', title: 'Other' }));
    await first.delete(other.id);

    const second = await open(await reopen());
    assert.deepEqual((await second.list()).map((item) => item.id), [saved.id]);
    assert.deepEqual((await second.listTrash()).map((item) => item.id), [other.id]);
    for (const [path, bytes] of original) {
      assert.deepEqual(new Uint8Array(await second.readFile(saved.id, path)), bytes, path);
    }
    const exported = await second.exportBundle(saved.id);
    assert.deepEqual(exported.bytes, await packBundle(original));
  });

  test(`${name} store: a delete while an export is packing stays deleted`, async () => {
    const { storage } = await make();
    const gate = pauseNextRead(storage);
    const page = await open(gate.storage);
    const otherPage = await open(storage);
    const original = await fixtureBundle();
    const saved = await page.save(original);

    const exporting = page.exportBundle(saved.id);
    await gate.paused;
    await otherPage.delete(saved.id);
    gate.release();
    assert.deepEqual((await exporting).bytes, await packBundle(original));

    const after = await otherPage.get(saved.id);
    assert.notEqual(after.deletedAt, null);
    assert.deepEqual(after.history.map((item) => item.event), ['saved', 'deleted', 'exported']);
    assert.deepEqual(await otherPage.list(), []);
  });

  test(`${name} store: an update while an export is packing keeps the new files`, async () => {
    const { storage } = await make();
    const gate = pauseNextRead(storage);
    const page = await open(gate.storage);
    const otherPage = await open(storage);
    const original = await fixtureBundle();
    const saved = await page.save(original);
    const next = await appended('Added during export');

    const exporting = page.exportBundle(saved.id);
    await gate.paused;
    await otherPage.update(saved.id, next);
    gate.release();
    // The export is the tree as it was read: whole, not half old and half new.
    assert.deepEqual((await exporting).bytes, await packBundle(original));

    const after = await otherPage.get(saved.id);
    assert.deepEqual(after.history.map((item) => item.event), ['saved', 'updated', 'exported']);
    assert.deepEqual(after.files, JSON.parse(decode(next.get(MANIFEST_PATH) as Uint8Array)).files);
    // A later export finds every file the record lists.
    assert.deepEqual((await page.exportBundle(saved.id)).bytes, await packBundle(next));
  });

  test(`${name} store: of two overlapping updates, the later one is refused, not lost`, async () => {
    const { storage } = await make();
    const gate = pauseNextRead(storage);
    const page = await open(gate.storage);
    const otherPage = await open(storage);
    const saved = await page.save(await fixtureBundle());
    const first = await appended('First page');
    const second = await appended('Second page');

    const updating = page.update(saved.id, first);
    await gate.paused;
    await otherPage.update(saved.id, second);
    gate.release();
    await assert.rejects(updating, refuses('recording-conflict'));
    assert.deepEqual(await otherPage.readFile(saved.id, 'edits.jsonl'), second.get('edits.jsonl'));
    assert.deepEqual((await otherPage.get(saved.id)).history.map((item) => item.event), ['saved', 'updated']);
  });

  test(`${name} store: an update built from an earlier read is refused, so a manifest-only change stays`, async () => {
    const { storage } = await make();
    const page = await open(storage);
    const otherPage = await open(storage);
    const saved = await page.save(await fixtureBundle());

    // Page A reads; page B then changes only the manifest (as switching the active transcript does).
    const read = await page.read(saved.id);
    assert.equal(read.recording.revision, saved.revision);
    await otherPage.update(saved.id, await withManifest(fixtureContent(), { title: 'Renamed' }));
    // A's tree adds a layer on top of what it read, so the layer check alone would pass it.
    await assert.rejects(page.update(saved.id, await appended('Stale'), { expectedRevision: read.recording.revision }), refuses('recording-conflict'));
    const after = await page.read(saved.id);
    assert.equal(after.recording.title, 'Renamed');
    assert.equal(after.recording.revision, saved.revision + 1);
    assert.deepEqual(after.files.get('edits.jsonl'), fixtureContent().get('edits.jsonl'));
    // Built again from the current read, it is written and keeps the rename.
    const content = fixtureContent();
    content.set('edits.jsonl', (await appended('Fresh')).get('edits.jsonl') as Uint8Array);
    const written = await page.update(saved.id, await withManifest(content, { title: 'Renamed' }), { expectedRevision: after.recording.revision });
    assert.deepEqual([written.title, written.revision], ['Renamed', saved.revision + 2]);
  });

  test(`${name} store: an update that started before a delete does not restore the recording`, async () => {
    const { storage } = await make();
    const gate = pauseNextRead(storage);
    const page = await open(gate.storage);
    const otherPage = await open(storage);
    const original = await fixtureBundle();
    const saved = await page.save(original);

    const updating = page.update(saved.id, await appended('Late'));
    await gate.paused;
    await otherPage.delete(saved.id);
    gate.release();
    await assert.rejects(updating, refuses('recording-conflict'));
    assert.deepEqual((await otherPage.listTrash()).map((item) => item.id), [saved.id]);
    assert.deepEqual(await otherPage.readFile(saved.id, 'edits.jsonl'), original.get('edits.jsonl'));
  });

  test(`${name} store: writes are whole and removal takes only one recording's files`, async () => {
    const { storage } = await make();
    const library = await open(storage);
    // IDs chosen so one is a prefix of the other.
    let n = 0;
    const ids = ['rec', 'rec-2'];
    const prefixed = await open(storage, { newId: () => ids[n++] as string });
    const a = await prefixed.save(await fixtureBundle({ recordingId: 'rec_a' }));
    const b = await prefixed.save(await fixtureBundle({ recordingId: 'rec_b' }));
    assert.deepEqual([a.id, b.id], ['rec', 'rec-2']);

    await library.delete(a.id);
    await library.purge(a.id, { confirm: true });
    assert.equal(await storage.readFile(a.id, MANIFEST_PATH), undefined);
    assert.equal(await storage.readFile(a.id, 'audio/narration.webm'), undefined);
    assert.equal((await library.readFiles(b.id)).size, 11);

    // Replacing a recording drops files the new tree no longer has.
    const content = fixtureContent();
    content.delete('agent/walkthrough.md');
    content.delete('agent/walkthrough.json');
    await library.update(b.id, await withManifest(content, { recordingId: 'rec_b' }));
    assert.equal(await storage.readFile(b.id, 'agent/walkthrough.md'), undefined);
    assert.equal((await library.readFiles(b.id)).size, 9);

    const record0 = (await storage.getRecord(b.id))!;
    await assert.rejects(storage.updateRecord('missing', () => ({ ...record0 })), /No recording missing/);
    assert.equal(await storage.updateRecord('missing', () => null), undefined);
    assert.equal(await storage.getRecord('missing'), undefined);
    await storage.removeRecording('missing', 1);

    // Writes that depend on a read refuse a stale revision and write nothing.
    await assert.rejects(storage.replaceRecording({ ...record0, title: 'stale' }, new Map(), record0.revision - 1), refuses('recording-conflict'));
    await assert.rejects(storage.removeRecording(b.id, record0.revision - 1), refuses('recording-conflict'));
    assert.equal((await storage.getRecord(b.id))!.title, 'Dashboard review');
    assert.equal((await library.readFiles(b.id)).size, 9);
    await assert.rejects(storage.addRecording({ ...record0 }, new Map()));
    assert.equal((await storage.getRecord(b.id))!.revision, record0.revision);

    // Stored values are copies: changing a returned record or file changes nothing.
    const record = (await storage.getRecord(b.id))!;
    record.title = 'changed';
    const bytes = (await storage.readFile(b.id, 'gaps.jsonl'))!;
    bytes.fill(0);
    assert.equal((await storage.getRecord(b.id))!.title, 'Dashboard review');
    assert.notEqual((await storage.readFile(b.id, 'gaps.jsonl'))![0], 0);
  });
}
