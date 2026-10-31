// Tests for transcript revisions and retranscription (board #16547).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BatchTranscriptionAdapter, TranscriptRevision } from '../src/contract.ts';
import { OpenAiWhisperAdapter, TranscriptionFailed, UploadRefused } from '../src/openai/index.ts';
import type { CorrectionEdit, StoredEdit, TranscriptHistory, TranscriptHistoryStore } from '../src/revisions.ts';
import {
  InvalidRevision,
  MAX_REVISIONS,
  PENDING_STALE_AFTER_MS,
  RevisionConflict,
  activateRevision,
  activeCorrections,
  addImprovedRevision,
  addRevision,
  beginRetranscription,
  cancelRetranscription,
  carryCorrections,
  completeRetranscription,
  createTranscriptHistory,
  planCarryForward,
  retranscribe,
} from '../src/revisions.ts';
import { CREDENTIAL, FAKE_KEY, RECORDING_ID, consent, fakeFetch, fixture, instant, json, request, webm } from './openai/helpers.ts';

const never = new AbortController().signal;

type Words = Array<[string, number, number]>;

/** A contract revision; each inner list is one segment of [text, startMs, endMs] words. */
function revision(id: string, segments: Words[], extra: Partial<TranscriptRevision> = {}): TranscriptRevision {
  return {
    revisionId: id,
    provider: 'openai',
    model: 'whisper-1',
    createdAtMs: Date.parse('2026-10-13T20:00:00Z'),
    source: 'after-recording',
    gaps: [],
    segments: segments.map((words, index) => ({
      provider: 'openai',
      model: 'whisper-1',
      connectionId: id,
      segmentKey: `${id}:${index}`,
      kind: 'final',
      startMs: words[0][1],
      endMs: words[words.length - 1][2],
      text: `${words.map(([text]) => text).join(' ')}.`,
      words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
      endOfUtterance: true,
    })),
    ...extra,
  };
}

const LIVE: Words[] = [
  [['This', 420, 610], ['should', 610, 950], ['colapse', 950, 1600]],
  [['Revenue', 3100, 3600], ['heading', 3600, 4000]],
];
/** The same speech from another run: a few ms apart, one word spelled right. */
const AGAIN: Words[] = [
  [['This', 400, 600], ['should', 615, 940], ['collapse', 960, 1590]],
  [['Revenue', 3080, 3610], ['heading', 3610, 4010]],
];

const correction = (id: string, fields: Partial<CorrectionEdit> = {}): CorrectionEdit => ({
  id,
  type: 'correction',
  revisionId: 'r1',
  segmentId: 's2',
  wordStart: 0,
  wordEnd: 1,
  text: 'Income',
  createdAt: '2026-10-13T20:01:00.000Z',
  ...fields,
});

const withEdits = (history: TranscriptHistory, ...edits: StoredEdit[]): TranscriptHistory => ({
  ...history,
  version: history.version + 1,
  edits: [...history.edits, ...edits],
});

/** History with one live revision (r1) that the user reads. */
const started = () => addRevision(createTranscriptHistory(RECORDING_ID), revision('live-1', LIVE, { provider: 'deepgram', model: 'nova-3', source: 'live', segments: revision('live-1', LIVE).segments.map((segment) => ({ ...segment, provider: 'deepgram' as const })) }));

/** Two revisions, r1 with `edits`, r2 from `next`; returns the carry plan from r1 to r2. */
function plan(next: Words[], ...edits: StoredEdit[]) {
  const history = addRevision(withEdits(started(), ...edits), revision('again', next));
  return { history, items: planCarryForward(history, 'r1', 'r2') };
}

function memoryStore(initial: TranscriptHistory) {
  const state = { history: initial, writes: 0, refuseNextWrite: false };
  const store: TranscriptHistoryStore = {
    read: async () => state.history,
    write: async (next, expectedVersion) => {
      if (state.refuseNextWrite || state.history.version !== expectedVersion) {
        state.refuseNextWrite = false;
        throw new RevisionConflict('stale-version', 'stored version moved');
      }
      state.history = next;
      state.writes += 1;
    },
  };
  return { store, state };
}

const adapterReturning = (result: TranscriptRevision | Error, during?: () => void) => {
  const calls: unknown[] = [];
  const adapter: BatchTranscriptionAdapter = {
    provider: 'openai',
    transcribe: async (...args) => {
      calls.push(args);
      during?.();
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { adapter, calls };
};

const job = (jobId = 'job-1', startedAtMs = 5000) => ({ jobId, startedAtMs });
const conflict = (reason: string) => (error: unknown) => error instanceof RevisionConflict && error.reason === reason;

// --- revisions are appended, never edited ---------------------------------

test('a retranscription is a new active revision; the original and the edits are kept', async () => {
  const before = withEdits(started(), correction('c1'), { id: 'n1', type: 'note', atMs: 70_300, text: 'Same on mobile' });
  const frozen = structuredClone(before);
  const { store, state } = memoryStore(before);
  const { adapter, calls } = adapterReturning(revision('again', AGAIN));

  const result = await retranscribe(store, adapter, request(webm()), CREDENTIAL, never, job());

  assert.equal(calls.length, 1);
  assert.equal(result.revisionId, 'r2');
  assert.equal(result.activated, true);
  assert.equal(state.history, result.history);
  assert.deepEqual(result.history.revisions.map((stored) => stored.revisionId), ['r1', 'r2']);
  assert.equal(result.history.activeRevision, 'r2');
  assert.equal(result.history.pending, null);
  // The first transcript and every earlier edit are byte-for-byte what they were.
  assert.deepEqual(result.history.revisions[0], frozen.revisions[0]);
  assert.deepEqual(result.history.edits.slice(0, 2), frozen.edits);
  assert.deepEqual(before, frozen);
  // The user can go back to the first transcript; that removes nothing either.
  const back = activateRevision(result.history, 'r1');
  assert.equal(back.activeRevision, 'r1');
  assert.equal(back.revisions.length, 2);
});

test('a stored revision has the bundle schema shape and no provider-side IDs', () => {
  const history = addRevision(createTranscriptHistory(RECORDING_ID), revision('openai-7c1f', AGAIN, { gaps: [{ provider: 'openai', startMs: 9000, endMs: 9500, reason: 'rate-limited', detail: '429: slow down' }] }));
  const [stored] = history.revisions;
  assert.deepEqual(Object.keys(stored), ['revisionId', 'source', 'provider', 'model', 'language', 'createdAt', 'segments', 'gaps']);
  assert.deepEqual(
    { ...stored, segments: stored.segments.length },
    { revisionId: 'r1', source: 'after-recording', provider: 'openai', model: 'whisper-1', language: 'en', createdAt: '2026-10-13T20:00:00.000Z', segments: 2, gaps: [{ startMs: 9000, endMs: 9500, reason: 'rate-limited', detail: '429: slow down' }] },
  );
  assert.deepEqual(stored.segments[0], {
    id: 's1',
    startMs: 400,
    endMs: 1590,
    text: 'This should collapse.',
    words: [{ text: 'This', startMs: 400, endMs: 600 }, { text: 'should', startMs: 615, endMs: 940 }, { text: 'collapse', startMs: 960, endMs: 1590 }],
  });
  assert.ok(!JSON.stringify(history).includes('openai-7c1f'));
});

test('a revision that breaks the contract is not stored', () => {
  const interim = revision('x', AGAIN);
  interim.segments[0].kind = 'interim';
  assert.throws(() => addRevision(createTranscriptHistory(RECORDING_ID), interim), InvalidRevision);
});

// --- user corrections survive a retranscription ---------------------------

test('corrections: carried to the same words in the new revision, with carriedFrom', () => {
  const { history, items } = plan(AGAIN, correction('c1'));
  assert.deepEqual(items.map((item) => [item.correction.id, item.outcome, item.originalText, item.revisionText]), [['c1', 'carried', 'Revenue', 'Revenue']]);

  const carried = carryCorrections(history, 'r1', 'r2', '2026-10-13T20:06:00.000Z');
  assert.deepEqual(carried.history.edits, [
    correction('c1'),
    { id: 'c2', type: 'correction', revisionId: 'r2', segmentId: 's2', wordStart: 0, wordEnd: 1, text: 'Income', createdAt: '2026-10-13T20:06:00.000Z', carriedFrom: 'c1' },
  ]);
  assert.deepEqual(activeCorrections(carried.history, 'r1').map((edit) => edit.id), ['c1']);
  assert.deepEqual(activeCorrections(carried.history, 'r2').map((edit) => edit.id), ['c2']);
  // Carrying again writes nothing: the plan skips what is already carried.
  const twice = carryCorrections(carried.history, 'r1', 'r2', '2026-10-13T20:07:00.000Z');
  assert.equal(twice.history, carried.history);
  assert.deepEqual(twice.items, []);
});

test('corrections: a whole-segment correction and a moved word index are carried', () => {
  // The new run splits differently: "Revenue heading" is now words 3-4 of one segment.
  const merged: Words[] = [[...AGAIN[0], ...AGAIN[1]]];
  const moved = plan(merged, correction('c1', { wordStart: 1, wordEnd: 2, text: 'title' }));
  assert.deepEqual(moved.items[0].target, { segmentId: 's1', wordStart: 4, wordEnd: 5 });
  assert.equal(moved.items[0].outcome, 'carried');

  const whole = plan(AGAIN, correction('c1', { wordStart: undefined, wordEnd: undefined, text: 'Income title.' }));
  assert.deepEqual([whole.items[0].outcome, whole.items[0].target], ['carried', { segmentId: 's2' }]);
  const carried = carryCorrections(whole.history, 'r1', 'r2', 'now');
  assert.deepEqual(carried.history.edits.at(-1), { id: 'c2', type: 'correction', revisionId: 'r2', segmentId: 's2', text: 'Income title.', createdAt: 'now', carriedFrom: 'c1' });
});

test('corrections: redundant when the new revision already says what the user wrote', () => {
  const { history, items } = plan(AGAIN, correction('c1', { segmentId: 's1', wordStart: 2, wordEnd: 3, text: 'Collapse' }));
  assert.deepEqual([items[0].outcome, items[0].originalText, items[0].revisionText], ['redundant', 'colapse', 'collapse']);
  assert.equal(carryCorrections(history, 'r1', 'r2', 'now').history, history);
});

test('revision conflict: the new revision differs where the user corrected; nothing is applied or dropped', () => {
  const different: Words[] = [AGAIN[0], [['Avenue', 3080, 3610], ['heading', 3610, 4010]]];
  const { history, items } = plan(different, correction('c1'));
  assert.deepEqual(items, [
    { correction: correction('c1'), outcome: 'conflict', reason: 'text-changed', originalText: 'Revenue', revisionText: 'Avenue', target: { segmentId: 's2', wordStart: 0, wordEnd: 1 } },
  ]);
  const carried = carryCorrections(history, 'r1', 'r2', 'now');
  assert.equal(carried.history, history);
  assert.deepEqual(activeCorrections(history, 'r1'), [correction('c1')]);
  assert.deepEqual(activeCorrections(history, 'r2'), []);
});

test('a retranscription that conflicts with a correction is stored but not activated; matching corrections are carried', async () => {
  const different: Words[] = [AGAIN[0], [['Avenue', 3080, 3610], ['heading', 3610, 4010]]];
  // c1 ("Revenue" → "Income") meets "Avenue": a conflict. c2 ("heading" → "title") still matches.
  const title = correction('c2', { wordStart: 1, wordEnd: 2, text: 'title' });
  const { store, state } = memoryStore(withEdits(started(), correction('c1'), title));
  const result = await retranscribe(store, adapterReturning(revision('again', different)).adapter, request(webm()), CREDENTIAL, never, job());

  assert.deepEqual([result.revisionId, result.activated, result.notActivated], ['r2', false, 'conflicts']);
  assert.deepEqual(result.items.map((item) => [item.correction.id, item.outcome]), [['c1', 'conflict'], ['c2', 'carried']]);
  assert.equal(state.history, result.history);
  // The user still reads r1 with both corrections; r2 waits with c2 carried onto it.
  assert.equal(state.history.activeRevision, 'r1');
  assert.equal(state.history.pending, null);
  assert.deepEqual(activeCorrections(state.history, 'r1'), [correction('c1'), title]);
  assert.deepEqual(activeCorrections(state.history, 'r2').map((edit) => [edit.segmentId, edit.wordStart, edit.text, edit.carriedFrom]), [['s2', 1, 'title', 'c2']]);
  assert.equal(activateRevision(state.history, 'r2').activeRevision, 'r2');
});

test('revision conflict: no words, words split over two segments, range already corrected, broken source', () => {
  const reason = (next: Words[], ...edits: StoredEdit[]) => plan(next, ...edits).items.map((item) => item.reason ?? item.outcome);

  assert.deepEqual(reason([AGAIN[0]], correction('c1')), ['no-words']);

  const both = correction('c1', { wordStart: 0, wordEnd: 2, text: 'Income title' });
  const split: Words[] = [AGAIN[0], [['Revenue', 3080, 3610]], [['heading', 3610, 4010]]];
  assert.deepEqual(reason(split, both), ['spans-segments']);

  const onNew = correction('c9', { revisionId: 'r2', text: 'Sales' });
  assert.deepEqual(reason(AGAIN, correction('c1'), onNew), ['already-corrected']);
  assert.deepEqual(reason(AGAIN, correction('c1'), correction('c9', { revisionId: 'r2', wordStart: 1, wordEnd: 2 })), ['carried']);

  assert.deepEqual(reason(AGAIN, correction('c1', { segmentId: 's9' })), ['source-invalid']);
  assert.deepEqual(reason(AGAIN, correction('c1', { wordStart: 5, wordEnd: 6 })), ['source-invalid']);
});

test('corrections: superseded and retracted ones are not carried', () => {
  const edits = [
    correction('c1'),
    correction('c2', { text: 'Sales', supersedes: 'c1' }),
    correction('c3', { segmentId: 's1', wordStart: 0, wordEnd: 1, text: 'That' }),
    { id: 'x1', type: 'retract', target: 'c3' },
  ];
  const { items } = plan(AGAIN, ...edits);
  assert.deepEqual(items.map((item) => [item.correction.id, item.correction.text, item.outcome]), [['c2', 'Sales', 'carried']]);
});

test('corrections made during the upload are kept and carried too', async () => {
  const { store, state } = memoryStore(withEdits(started(), correction('c1')));
  // The user fixes another word while the audio is uploading.
  const { adapter } = adapterReturning(revision('again', AGAIN), () => {
    state.history = withEdits(state.history, correction('c2', { segmentId: 's2', wordStart: 1, wordEnd: 2, text: 'title' }));
  });
  const result = await retranscribe(store, adapter, request(webm()), CREDENTIAL, never, job());

  assert.deepEqual(result.items.map((item) => [item.correction.id, item.outcome]), [['c1', 'carried'], ['c2', 'carried']]);
  assert.deepEqual(result.history.edits.map((edit) => [edit.id, edit.revisionId, edit.carriedFrom]), [
    ['c1', 'r1', undefined],
    ['c2', 'r1', undefined],
    ['c3', 'r2', 'c1'],
    ['c4', 'r2', 'c2'],
  ]);
});

// --- revision conflicts between writers and jobs --------------------------

test('revision conflict: a write against an old version is refused', () => {
  const history = started();
  assert.throws(() => addRevision(history, revision('again', AGAIN), { expectedVersion: 0 }), conflict('stale-version'));
  assert.throws(() => activateRevision(history, 'r1', { expectedVersion: 0 }), conflict('stale-version'));
  assert.throws(() => beginRetranscription(history, { ...job(), consent: consent() }, { expectedVersion: 7 }), conflict('stale-version'));
  assert.throws(() => carryCorrections(history, 'r1', 'r1', 'now', { expectedVersion: 0 }), conflict('stale-version'));
  assert.equal(addRevision(history, revision('again', AGAIN), { expectedVersion: 1 }).version, 2);
  assert.throws(() => activateRevision(history, 'r9'), conflict('unknown-revision'));
});

test('revision conflict: the store moved under the job; the result lands on the newest history', async () => {
  const { store, state } = memoryStore(started());
  const { adapter } = adapterReturning(revision('again', AGAIN), () => {
    state.refuseNextWrite = true;
  });
  const result = await retranscribe(store, adapter, request(webm()), CREDENTIAL, never, job());
  assert.equal(result.history.activeRevision, 'r2');
  assert.equal(state.history.revisions.length, 2);
  assert.equal(state.writes, 2); // begin, then complete on the second try
});

test('revision conflict: a second job for the same recording is refused before it uploads', async () => {
  const { store, state } = memoryStore(beginRetranscription(started(), { ...job('job-1', 5000), consent: consent(1) }));
  const { adapter, calls } = adapterReturning(revision('again', AGAIN));
  await assert.rejects(
    retranscribe(store, adapter, request(webm(), { consent: consent(2) }), CREDENTIAL, never, job('job-2', 6000)),
    conflict('retranscription-in-progress'),
  );
  assert.equal(calls.length, 0);
  assert.equal(state.history.pending?.jobId, 'job-1');
});

test('revision conflict: an abandoned job is replaced; its late result is stored but does not take over', () => {
  let history = beginRetranscription(started(), { ...job('job-1', 0), consent: consent(1) });
  history = beginRetranscription(history, { ...job('job-2', PENDING_STALE_AFTER_MS), consent: consent(2) });
  assert.equal(history.pending?.jobId, 'job-2');

  // job-1 was slow, not dead. The user was charged for its transcript, so it is kept.
  const late = completeRetranscription(history, 'job-1', revision('late', AGAIN));
  assert.deepEqual([late.revisionId, late.activated, late.notActivated], ['r2', false, 'job-replaced']);
  assert.equal(late.history.activeRevision, 'r1');
  assert.equal(late.history.pending?.jobId, 'job-2');

  const current = completeRetranscription(late.history, 'job-2', revision('current', AGAIN));
  assert.deepEqual([current.revisionId, current.activated], ['r3', true]);
  assert.equal(current.history.activeRevision, 'r3');
  assert.equal(current.history.pending, null);
});

test('an incomplete retranscription is stored but does not replace the transcript the user reads', async () => {
  const gap = { provider: 'openai' as const, startMs: 1600, endMs: 4000, reason: 'connect-failed' as const, detail: 'network: fetch failed' };
  const partial = revision('partial', [AGAIN[0]], { gaps: [gap] });
  const before = withEdits(started(), correction('c1'));
  const { store, state } = memoryStore(before);
  const result = await retranscribe(store, adapterReturning(partial).adapter, request(webm()), CREDENTIAL, never, job());

  assert.deepEqual([result.revisionId, result.activated, result.notActivated, result.items], ['r2', false, 'incomplete', []]);
  assert.equal(state.history.activeRevision, 'r1');
  assert.equal(state.history.pending, null);
  assert.deepEqual(state.history.revisions[1].gaps, [{ startMs: 1600, endMs: 4000, reason: 'connect-failed', detail: 'network: fetch failed' }]);
  assert.deepEqual(state.history.edits, before.edits);

  // The user can still choose it; the corrections are carried at that point.
  const chosen = carryCorrections(activateRevision(state.history, 'r2'), 'r1', 'r2', '2026-10-13T20:05:00Z');
  assert.equal(chosen.history.activeRevision, 'r2');
  assert.equal(chosen.items.length, 1);
});

test('an incomplete first transcript becomes the active one: there is nothing to keep instead', () => {
  const gap = { provider: 'openai' as const, startMs: 1600, endMs: 4000, reason: 'rate-limited' as const };
  const history = beginRetranscription(createTranscriptHistory(RECORDING_ID), { ...job('job-1', 0), consent: consent(1) });
  const first = completeRetranscription(history, 'job-1', revision('partial', [AGAIN[0]], { gaps: [gap] }));
  assert.deepEqual([first.revisionId, first.activated, first.notActivated], ['r1', true, undefined]);
  assert.equal(first.history.activeRevision, 'r1');
});

test('consent: one consent covers one upload job', async () => {
  const { store, state } = memoryStore(started());
  const first = adapterReturning(revision('again', AGAIN));
  await retranscribe(store, first.adapter, request(webm(), { consent: consent(1000) }), CREDENTIAL, never, job('job-1'));

  const second = adapterReturning(revision('third', AGAIN));
  await assert.rejects(
    retranscribe(store, second.adapter, request(webm(), { consent: consent(1000) }), CREDENTIAL, never, job('job-2')),
    conflict('consent-already-used'),
  );
  assert.equal(second.calls.length, 0);
  await assert.rejects(
    retranscribe(store, second.adapter, request(webm(), { consent: consent(3000, { recordingId: 'rec-2' }) }), CREDENTIAL, never, job('job-2')),
    conflict('wrong-recording'),
  );

  await retranscribe(store, second.adapter, request(webm(), { consent: consent(2000) }), CREDENTIAL, never, job('job-2'));
  assert.deepEqual(state.history.revisions.map((stored) => stored.revisionId), ['r1', 'r2', 'r3']);
});

test('a failed job leaves revisions and edits as they were', async () => {
  const before = withEdits(started(), correction('c1'));
  const failure = new TranscriptionFailed({ provider: 'openai', kind: 'auth', retryable: false, code: 'invalid_api_key', message: 'Incorrect API key' });
  const { store, state } = memoryStore(before);
  await assert.rejects(retranscribe(store, adapterReturning(failure).adapter, request(webm()), CREDENTIAL, never, job()), TranscriptionFailed);

  assert.deepEqual(state.history.revisions, before.revisions);
  assert.deepEqual(state.history.edits, before.edits);
  assert.equal(state.history.activeRevision, 'r1');
  assert.equal(state.history.pending, null);
  // The audio may have been uploaded, so the consent is spent.
  assert.equal(state.history.usedConsents.length, 1);
});

test('a job refused before upload gives the consent back', async () => {
  const { store, state } = memoryStore(started());
  const adapter = new OpenAiWhisperAdapter({ fetch: fakeFetch([]).fetch, maxUploadBytes: 100 });
  await assert.rejects(retranscribe(store, adapter, request(webm(500)), CREDENTIAL, never, job()), UploadRefused);
  assert.equal(state.history.pending, null);
  assert.deepEqual(state.history.usedConsents, []);

  // cancelRetranscription for a job that is not pending changes nothing.
  assert.equal(cancelRetranscription(state.history, 'job-9'), state.history);
});

test('revision limit: the 33rd transcript is refused before the upload', async () => {
  let history = createTranscriptHistory(RECORDING_ID);
  for (let index = 0; index < MAX_REVISIONS; index += 1) history = addRevision(history, revision(`run-${index}`, AGAIN));
  assert.equal(history.revisions.at(-1)!.revisionId, 'r32');
  assert.throws(() => addRevision(history, revision('one-more', AGAIN)), conflict('revision-limit'));

  const { store } = memoryStore(history);
  const { adapter, calls } = adapterReturning(revision('one-more', AGAIN));
  await assert.rejects(retranscribe(store, adapter, request(webm()), CREDENTIAL, never, job()), conflict('revision-limit'));
  assert.equal(calls.length, 0);
});

// --- end to end with the OpenAI adapter -----------------------------------

test('OpenAI retranscription of a live transcript, end to end', async () => {
  const live: Words[] = [[['This', 430, 600], ['should', 600, 960], ['collapse', 960, 1590]], [['Revenue', 3090, 3590], ['heading', 3610, 3990]]];
  const first = addRevision(createTranscriptHistory(RECORDING_ID), revision('live', live, { provider: 'deepgram', model: 'nova-3', source: 'live', segments: revision('live', live).segments.map((segment) => ({ ...segment, provider: 'deepgram' as const })) }));
  const { store, state } = memoryStore(withEdits(first, correction('c1', { segmentId: 's2', wordStart: 0, wordEnd: 1, text: 'Income' })));
  const { fetch, uploads } = fakeFetch([json(fixture('verbose-short.json'))]);
  const adapter = new OpenAiWhisperAdapter({ fetch, ...instant().options });

  const result = await retranscribe(store, adapter, request(webm()), CREDENTIAL, never, job());

  assert.equal(uploads.length, 1);
  const [original, again] = state.history.revisions;
  assert.deepEqual([original.revisionId, original.provider, original.source], ['r1', 'deepgram', 'live']);
  assert.deepEqual([again.revisionId, again.provider, again.model, again.source], ['r2', 'openai', 'whisper-1', 'after-recording']);
  assert.deepEqual(again.segments.map((segment) => segment.text), ['This should collapse.', 'Revenue heading.']);
  assert.deepEqual(result.items.map((item) => item.outcome), ['carried']);
  assert.deepEqual(activeCorrections(state.history, 'r2').map((edit) => [edit.segmentId, edit.wordStart, edit.wordEnd, edit.text]), [['s2', 0, 1, 'Income']]);
  // What is stored has no credential in it.
  assert.ok(!JSON.stringify(state.history).includes(FAKE_KEY));
});

test('a browser-local revision keeps its timing quality, and its gap reasons become not-transcribed (board #16544)', () => {
  const live = revision('live', LIVE, { source: 'live', provider: 'browser-local', model: 'vosk-small-en-us' });
  live.segments.forEach((segment) => { segment.provider = 'browser-local'; });
  live.timing = { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 };
  live.gaps = [{ provider: 'browser-local', startMs: 5000, endMs: 6000, reason: 'engine-behind', detail: 'skipped 1000 ms' }];
  const final = revision('final', LIVE, { provider: 'browser-local', model: 'whisper-base.en-q8', supersedes: 'r1' });
  final.segments.forEach((segment) => { segment.provider = 'browser-local'; segment.timing = 'approximate'; });
  final.timing = { quality: 'approximate', method: 'whisper-dtw', correctionMs: -150 };

  let history = addRevision(createTranscriptHistory(RECORDING_ID), live);
  history = addRevision(history, final);
  const [first, second] = history.revisions;
  assert.equal(first.provider, 'browser-local');
  assert.deepEqual(first.timing, { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 });
  assert.deepEqual(first.segments.map((segment) => segment.timing), ['aligned', 'aligned']);
  assert.deepEqual(first.gaps, [{ startMs: 5000, endMs: 6000, reason: 'not-transcribed', detail: 'engine-behind: skipped 1000 ms' }]);
  assert.deepEqual(second.segments.map((segment) => segment.timing), ['approximate', 'approximate']);
  assert.equal(second.supersedes, 'r1');

  // A cloud revision is stored as before: no timing fields appear.
  const cloud = addRevision(history, revision('cloud', LIVE)).revisions[2];
  assert.equal('timing' in cloud, false);
  assert.equal('timing' in cloud.segments[0], false);
  assert.equal('supersedes' in cloud, false);

  assert.throws(() => addRevision(history, { ...final, supersedes: 'r9' }), (error) => error instanceof RevisionConflict && error.reason === 'unknown-revision');
  assert.throws(() => addRevision(history, { ...final, timing: { quality: 'exact' as 'aligned', method: 'x', correctionMs: 0 } }), InvalidRevision);
});

test('an improved transcript made on this computer follows the same rules, with no upload job (board #16603)', () => {
  const pending = { ...started(), pending: { jobId: 'openai-job', startedAtMs: 5000 } } as TranscriptHistory;
  // Carried corrections; the OpenAI job that may be running is left alone.
  const title = correction('c2', { wordStart: 1, wordEnd: 2, text: 'title' });
  const local = revision('local', AGAIN, { supersedes: 'r1' });
  const onThisComputer = { ...local, provider: 'browser-local' as const, segments: local.segments.map((segment) => ({ ...segment, provider: 'browser-local' as const })) };
  const done = addImprovedRevision(withEdits(pending, title), onThisComputer);
  assert.deepEqual([done.revisionId, done.activated, done.notActivated], ['r2', true, undefined]);
  assert.equal(done.history.activeRevision, 'r2');
  assert.deepEqual(done.history.pending, pending.pending);
  assert.deepEqual(activeCorrections(done.history, 'r2').map((edit) => [edit.text, edit.carriedFrom]), [['title', 'c2']]);

  const different: Words[] = [AGAIN[0], [['Avenue', 3080, 3610], ['heading', 3610, 4010]]];
  const conflicted = addImprovedRevision(withEdits(started(), correction('c1')), revision('local', different));
  assert.deepEqual([conflicted.activated, conflicted.notActivated, conflicted.history.activeRevision], [false, 'conflicts', 'r1']);

  const gap = { provider: 'openai' as const, startMs: 3000, endMs: 4000, reason: 'provider-error' as const };
  const partial = addImprovedRevision(started(), revision('local', AGAIN, { gaps: [gap] }));
  assert.deepEqual([partial.activated, partial.notActivated, partial.history.activeRevision], [false, 'incomplete', 'r1']);
  const first = addImprovedRevision(createTranscriptHistory(RECORDING_ID), revision('local', AGAIN, { gaps: [gap] }));
  assert.deepEqual([first.activated, first.history.activeRevision], [true, 'r1']);
});
