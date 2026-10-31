import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatcher } from '../../src/offscreen/batcher.js';

test('flush writes one bounded chunk in sequence order and empties the buffer', async () => {
  const written = [];
  const b = createBatcher({ write: async (c) => written.push(c), startSeq: 7 });
  b.add({ k: 'rr', t: 10 });
  b.add({ k: 'rr', t: 20 });
  await b.flush();
  await b.flush(); // nothing buffered: no empty chunk
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].seq, written[0].startAt, written[0].endAt, written[0].count], [7, 10, 20, 2]);
  assert.equal(b.nextSeq(), 8);
});

test('add flushes early when a chunk reaches maxBytes', async () => {
  const written = [];
  const b = createBatcher({ write: async (c) => written.push(c), maxBytes: 200 });
  for (let i = 0; i < 10; i += 1) b.add({ k: 'rr', t: i, pad: 'x'.repeat(50) });
  await b.flush();
  assert.ok(written.length >= 3, `expected several chunks, got ${written.length}`);
  assert.deepEqual(written.map((c) => c.seq), written.map((_, i) => i));
  assert.equal(written.reduce((n, c) => n + c.count, 0), 10);
});

test('a failed write is reported with its chunk; earlier and later chunks still save', async () => {
  const saved = [];
  const failures = [];
  let fail = false;
  const b = createBatcher({
    write: async (c) => {
      if (fail) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      saved.push(c.seq);
    },
    onError: (err, chunk) => failures.push([err.name, chunk.seq]),
  });
  b.add({ t: 1 });
  await b.flush();
  fail = true;
  b.add({ t: 2 });
  await b.flush();
  fail = false;
  b.add({ t: 3 });
  await b.flush();
  assert.deepEqual(saved, [0, 2]);
  assert.deepEqual(failures, [['QuotaExceededError', 1]]);
  assert.equal(b.totals().failed, 1);
});

test('writes run one at a time even when flushes overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const b = createBatcher({
    write: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    },
  });
  for (let i = 0; i < 5; i += 1) {
    b.add({ t: i });
    b.flush();
  }
  await b.flush();
  assert.equal(maxActive, 1);
  assert.equal(b.totals().chunks, 5);
});
