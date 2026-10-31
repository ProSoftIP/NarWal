import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NarwalError } from '../src/errors.ts';
import type { NarwalErrorCode } from '../src/errors.ts';
import { unsafePathReason } from '../src/paths.ts';
import { DEFAULT_ARCHIVE_LIMITS, openZip, writeZip } from '../src/zip.ts';
import { craftZip, noise, text } from './helpers.ts';

function refuses(code: NarwalErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof NarwalError, `expected NarwalError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const small = { ...DEFAULT_ARCHIVE_LIMITS, maxArchiveBytes: 1 << 20, maxEntries: 4, maxEntryBytes: 1 << 16, maxTotalBytes: 1 << 17 };

test('writes and reads back stored and deflated entries', async () => {
  const inputs = [
    { path: 'manifest.json', bytes: text('{"a":"' + 'x'.repeat(5000) + '"}'), compress: true },
    { path: 'audio/narration.webm', bytes: noise(20_000), compress: false },
    { path: 'gaps.jsonl', bytes: new Uint8Array(0), compress: true },
  ];
  const archive = await writeZip(inputs);
  assert.ok(archive.length < 5000 + 20_000 + 400, 'the text entry is deflated');
  const zip = openZip(archive);
  assert.deepEqual(zip.entries.map((entry) => entry.path), inputs.map((input) => input.path));
  for (const input of inputs) assert.deepEqual(await zip.read(input.path), input.bytes);
});

test('the same inputs give the same archive bytes', async () => {
  const inputs = [{ path: 'a.json', bytes: text('{"k":[1,2,3]}'), compress: true }];
  assert.deepEqual(await writeZip(inputs), await writeZip(inputs));
});

test('the writer refuses unsafe and colliding names', async () => {
  await assert.rejects(writeZip([{ path: '../a.json', bytes: text('1'), compress: false }]), refuses('entry-path-unsafe'));
  await assert.rejects(
    writeZip([
      { path: 'a.json', bytes: text('1'), compress: false },
      { path: 'A.json', bytes: text('2'), compress: false },
    ]),
    refuses('entry-duplicate'),
  );
});

test('path rule: relative names from the allowlist only', () => {
  for (const good of ['manifest.json', 'audio/narration.webm', 'rrweb/d1.jsonl', 'transcript/r_2-a.json']) {
    assert.equal(unsafePathReason(good), null, good);
  }
  const bad = [
    '', '/etc/passwd', '../x.json', 'a/../../x.json', 'a/./x.json', 'a//x.json', 'a/', 'C:/x.json', 'a\\x.json',
    'a b.json', 'é.json', 'x.json\u0000.md', 'x.json\n', '..', 'a/..', 'x.', 'nul.json', 'COM1', 'a/LPT9.md',
    `${'a'.repeat(197)}.json`,
  ];
  for (const path of bad) assert.notEqual(unsafePathReason(path), null, JSON.stringify(path));
});

test('refuses traversal, absolute, backslash and non-UTF-8 entry names', () => {
  const data = text('{}');
  for (const name of ['../../home/user/.ssh/authorized_keys', '/etc/cron.d/x', '..\\..\\x.json', 'a/../../x.json', 'C:/Windows/x.json', 'x\u0000.json']) {
    assert.throws(() => openZip(craftZip([{ name, data }])), refuses('entry-path-unsafe'), name);
  }
  assert.throws(() => openZip(craftZip([{ name: new Uint8Array([0xff, 0xfe, 0x2e, 0x6a]), data }])), refuses('entry-path-unsafe'));
});

test('refuses a symbolic link entry', () => {
  const link = craftZip([{ name: 'audio/narration.webm', data: text('/etc/passwd'), madeBy: (3 << 8) | 20, externalAttributes: (0o120777 << 16) >>> 0 }]);
  assert.throws(() => openZip(link), refuses('entry-path-unsafe'));
  // A regular Unix file is fine.
  const regular = craftZip([{ name: 'a.json', data: text('{}'), madeBy: (3 << 8) | 20, externalAttributes: (0o100644 << 16) >>> 0 }]);
  assert.equal(openZip(regular).entries.length, 1);
});

test('refuses duplicate names, including names that differ only by case', () => {
  const data = text('{}');
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data }, { name: 'a.json', data }])), refuses('entry-duplicate'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data }, { name: 'A.JSON', data }])), refuses('entry-duplicate'));
});

test('refuses entries that share archive data', () => {
  const data = noise(1000);
  const archive = craftZip([{ name: 'a.webm', data }, { name: 'b.webm', data, shareDataOf: 0, localName: 'a.webm' }]);
  // The shared header names a.webm, so the reader stops at the name check or the overlap check.
  assert.throws(() => openZip(archive), (error: unknown) => error instanceof NarwalError && ['archive-malformed', 'entry-overlap'].includes(error.code));
});

test('refuses overlapping entries with matching names', () => {
  // Two records, same name bytes would be a duplicate; build an overlap by declaring
  // the first entry's data to run into the second entry.
  const a = noise(100, 1);
  const b = noise(100, 2);
  const archive = craftZip([{ name: 'a.webm', data: a, declaredCompressedSize: 160, declaredSize: 160 }, { name: 'b.webm', data: b }]);
  assert.throws(() => openZip(archive), refuses('entry-overlap'));
});

test('refuses a file larger than the limit before inflating it', () => {
  const archive = craftZip([{ name: 'a.webm', data: noise(70_000) }]);
  assert.throws(() => openZip(archive, small), refuses('entry-too-large'));
});

test('refuses a total larger than the limit', () => {
  const entries = ['a', 'b', 'c'].map((name, i) => ({ name: `${name}.webm`, data: noise(60_000, i + 1) }));
  assert.throws(() => openZip(craftZip(entries), small), refuses('total-too-large'));
});

test('refuses more entries than the limit, and an archive over the size limit', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.json`, data: text('{}') }));
  assert.throws(() => openZip(craftZip(entries), small), refuses('archive-too-many-entries'));
  assert.throws(() => openZip(new Uint8Array((1 << 20) + 1), small), refuses('archive-too-large'));
});

test('refuses a declared size far beyond what the compressed data can hold', () => {
  const archive = craftZip([{ name: 'a.json', data: new Uint8Array(1000), deflate: true, declaredSize: 400 * 1024 * 1024 }]);
  assert.throws(() => openZip(archive), refuses('entry-ratio'));
});

test('stops inflating when the data is larger than declared', async () => {
  // 4 MiB of zeros deflates to about 4 KiB. The header claims 1000 bytes.
  const archive = craftZip([{ name: 'a.json', data: new Uint8Array(4 * 1024 * 1024), deflate: true, declaredSize: 1000 }]);
  const zip = openZip(archive);
  await assert.rejects(zip.read('a.json'), refuses('entry-corrupt'));
});

test('refuses data smaller than declared, a bad checksum and invalid deflate data', async () => {
  const short = openZip(craftZip([{ name: 'a.json', data: text('{"a":1}'), deflate: true, declaredSize: 50 }]));
  await assert.rejects(short.read('a.json'), refuses('entry-corrupt'));
  const badCrc = openZip(craftZip([{ name: 'a.json', data: text('{"a":1}'), crc: 12345 }]));
  await assert.rejects(badCrc.read('a.json'), refuses('entry-corrupt'));
  const garbage = openZip(craftZip([{ name: 'a.json', data: noise(300), method: 8, declaredSize: 300 }]));
  await assert.rejects(garbage.read('a.json'), refuses('entry-corrupt'));
});

test('refuses encryption, ZIP64, unknown methods and a stored entry with two sizes', () => {
  const data = text('{}');
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data, flags: 0x0801 }])), refuses('archive-unsupported'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data }], { zip64Marker: true })), refuses('archive-unsupported'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data, method: 12 }])), refuses('archive-unsupported'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data, declaredSize: 9 }])), refuses('archive-malformed'));
});

test('refuses a local header that names a different file than the directory', () => {
  const archive = craftZip([{ name: 'notes.json', data: text('{}'), localName: 'evil1.html' }]);
  assert.throws(() => openZip(archive), refuses('archive-malformed'));
});

test('refuses truncated files, trailing data and files that are not archives', async () => {
  const good = await writeZip([{ path: 'a.json', bytes: text('{"a":1}'), compress: true }]);
  assert.throws(() => openZip(good.subarray(0, good.length - 5)), refuses('archive-malformed'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data: text('{}') }], { trailing: noise(10) })), refuses('archive-malformed'));
  assert.throws(() => openZip(text('this is not a zip file at all, just text')), refuses('archive-malformed'));
  assert.throws(() => openZip(new Uint8Array(4)), refuses('archive-malformed'));
  assert.throws(() => openZip(craftZip([{ name: 'a.json', data: text('{}') }], { entryCountOverride: 3 })), refuses('archive-malformed'));
});

test('skips empty directory records and reads from a subarray view', async () => {
  const archive = craftZip([{ name: 'audio/', data: new Uint8Array(0) }, { name: 'audio/clock.jsonl', data: text('{}\n'), deflate: true }]);
  const padded = new Uint8Array(archive.length + 64);
  padded.set(archive, 32);
  const zip = openZip(padded.subarray(32, 32 + archive.length));
  assert.deepEqual(zip.entries.map((entry) => entry.path), ['audio/clock.jsonl']);
  assert.deepEqual(await zip.read('audio/clock.jsonl'), text('{}\n'));
});
