import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, rrwebEventsOf } from '../../src/shared/analyze.js';

const T0 = 1_700_000_000_000;
const chunk = (seq, entries) => ({ seq, startAt: entries[0].t, endAt: entries[entries.length - 1].t, entries });
const attach = (t, doc, documentId, reason = 'boot', frameId = 0) => ({ k: 'attach', t, doc, documentId, frameId, url: `https://a.test/${documentId}`, reason, boot: { isTop: frameId === 0, inst: doc } });
const rr = (t, doc, type = 3) => ({ k: 'rr', t, doc, e: { type, timestamp: t } });
const commit = (t, documentId, url) => ({ k: 'nav', type: 'committed', t, frameId: 0, documentId, url });

test('documents are grouped by browser documentId across re-attachments', () => {
  const entries = [
    commit(T0, 'D1', 'https://a.test/1'),
    attach(T0 + 5, 'p1', 'D1'),
    rr(T0 + 6, 'p1', 2),
    rr(T0 + 7, 'p1'),
    commit(T0 + 100, 'D2', 'https://a.test/2'),
    attach(T0 + 105, 'p2', 'D2'),
    rr(T0 + 106, 'p2', 2),
    // back/forward restore of D1 attaches a new port to the same document
    attach(T0 + 200, 'p3', 'D1', 'bfcache-restore'),
    rr(T0 + 201, 'p3', 2),
  ];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 300 }, eventChunks: [chunk(0, entries)], audioChunks: [] });
  assert.equal(r.documents.length, 2);
  const d1 = r.documents.find((d) => d.documentId === 'D1');
  assert.deepEqual(d1.attachments.map((a) => a.reason), ['boot', 'bfcache-restore']);
  assert.equal(d1.rrEvents, 3);
  assert.equal(rrwebEventsOf(r.entries, 'D1').length, 3);
  assert.deepEqual(r.gaps, []);
});

test('a top-frame commit with no attached document is labelled restricted-page', () => {
  const entries = [commit(T0, 'D1', 'https://a.test/'), attach(T0 + 5, 'p1', 'D1'), commit(T0 + 1000, 'R', 'chrome://version/'), commit(T0 + 3000, 'D3', 'https://a.test/3'), attach(T0 + 3005, 'p3', 'D3')];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 4000 }, eventChunks: [chunk(0, entries)], audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.from, g.to, g.detail]), [['restricted-page', 'page', T0 + 1000, T0 + 3000, 'chrome://version/']]);
});

test('silence between saved event chunks is labelled missing for page and audio', () => {
  const ev = [chunk(0, [{ k: 'beat', t: T0 }, { k: 'beat', t: T0 + 1000 }]), chunk(1, [{ k: 'beat', t: T0 + 9000 }])];
  const audio = [
    { seq: 0, segment: 0, startAt: T0, endAt: T0 + 1000, bytes: 10 },
    { seq: 1, segment: 0, startAt: T0 + 5000, endAt: T0 + 6000, bytes: 10 },
  ];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 9000 }, eventChunks: ev, audioChunks: audio });
  // The audio silence inside the missing interval is not labelled twice.
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.from, g.to]), [['recovery-truncated', 'any', T0 + 1000, T0 + 9000]]);
  assert.equal(r.audio.length, 1);
  assert.equal(r.audio[0].bytes, 20);
});

test('silence between audio chunks while page evidence continues is labelled as an audio gap', () => {
  const ev = [0, 1, 2, 3, 4, 5, 6].map((i) => chunk(i, [{ k: 'beat', t: T0 + i * 1000 }]));
  const audio = [
    { seq: 0, segment: 0, startAt: T0, endAt: T0 + 1000, bytes: 10 },
    { seq: 1, segment: 0, startAt: T0 + 5000, endAt: T0 + 6000, bytes: 10 },
  ];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 6000 }, eventChunks: ev, audioChunks: audio });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.from, g.to]), [['recorder-error', 'audio', T0 + 1000, T0 + 5000]]);
});

test('a recorder-written gap covers its interval; analysis does not double-label it', () => {
  const ev = [
    chunk(0, [{ k: 'beat', t: T0 }]),
    chunk(1, [{ k: 'gap', scope: 'any', reason: 'recovery-truncated', from: T0, to: T0 + 8000, t: T0 + 8000 }, { k: 'beat', t: T0 + 8001 }]),
  ];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 9000 }, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => g.reason), ['recovery-truncated']);
});

test('an interrupted recording labels everything after the last saved chunk', () => {
  const ev = [chunk(0, [{ k: 'beat', t: T0 }, { k: 'beat', t: T0 + 2000 }])];
  const meta = { status: 'interrupted', startedAt: T0, stoppedAt: T0 + 2000, interruption: { lastSavedAt: T0 + 2000, detectedAt: T0 + 60000 } };
  const r = analyze({ meta, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.from, g.to]), [['recovery-truncated', T0 + 2000, T0 + 60000]]);
});

test('an open-ended recorder gap (microphone denied) ends at Stop', () => {
  const ev = [chunk(0, [{ k: 'gap', scope: 'audio', reason: 'mic-denied', from: T0 + 10, to: null, t: T0 + 10 }])];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 5000 }, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.to]), [['mic-denied', 'audio', T0 + 5000]]);
});

test('a missing message number in one document instance is labelled lost-messages', () => {
  const msg = (seq, t) => ({ k: 'rr', doc: 'p1', seq, t, e: { type: 3, timestamp: t } });
  const ev = [chunk(0, [attach(T0, 'p1', 'D1'), msg(1, T0 + 1), msg(2, T0 + 2), msg(5, T0 + 9)])];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 100 }, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.from, g.to, g.detail, g.documentId]), [['lost-messages', 'page', T0 + 2, T0 + 9, '2 message(s) lost', 'D1']]);
});

test('numbering continues across ports of one instance; a new instance starts again at 1', () => {
  const m = (doc, seq, t) => ({ k: 'page', type: 'x', doc, seq, t });
  const ev = [chunk(0, [attach(T0, 'p1', 'D1'), m('p1', 1, T0 + 1), m('p1', 2, T0 + 2), { ...attach(T0 + 3, 'p2', 'D1', 'reconnect'), boot: { isTop: true, inst: 'p1' } }, m('p2', 3, T0 + 4), attach(T0 + 5, 'p3', 'D2'), m('p3', 1, T0 + 6)])];
  const r = analyze({ meta: { status: 'stopped', startedAt: T0, stoppedAt: T0 + 100 }, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps, []);
});

test('a storage failure the recorder could not save is labelled from the meta record', () => {
  const ev = [chunk(0, [{ k: 'beat', t: T0 }, { k: 'beat', t: T0 + 1000 }])];
  const meta = { status: 'stopped', startedAt: T0, stoppedAt: T0 + 3000, stopReason: 'storage-full', storageError: { quota: true, message: 'x', lost: { stream: 'events', from: T0 + 1000, to: T0 + 2000 } } };
  const r = analyze({ meta, eventChunks: ev, audioChunks: [] });
  assert.deepEqual(r.gaps.map((g) => [g.reason, g.scope, g.from, g.to, g.detail]), [['recovery-truncated', 'any', T0 + 1000, T0 + 3000, 'storage-full']]);
  // Saved by the recorder as well: not labelled twice.
  const ev2 = [chunk(0, [{ k: 'beat', t: T0 }, { k: 'gap', scope: 'any', reason: 'recovery-truncated', from: T0 + 1000, to: T0 + 3000, detail: 'storage-full', t: T0 + 3000 }])];
  assert.equal(analyze({ meta, eventChunks: ev2, audioChunks: [] }).gaps.length, 1);
});
