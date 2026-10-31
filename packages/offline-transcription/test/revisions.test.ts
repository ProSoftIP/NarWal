// Unit tests for transcript revisions (board #16544): src/revisions.ts against
// the revision file of docs/bundle-schema.md §8.1. The live collector keeps
// final text only, a revision set is append-only, and the bundle file has
// exactly the base schema fields with `extensions: false`; the default adds
// timing, gap detail and supersedes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIVE_MODEL } from '../src/contract.ts';
import type { AdapterEvent, GapReason, TranscriptGap, TranscriptRevision, TranscriptSegment } from '../src/contract.ts';
import { LiveRevisionCollector, MAX_REVISIONS, RevisionSet, toBundleRevision } from '../src/revisions.ts';

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    provider: 'browser-local',
    model: LIVE_MODEL,
    connectionId: 'c1',
    segmentKey: 'u1',
    kind: 'final',
    startMs: 1000,
    endMs: 2000,
    text: 'hello world',
    words: [
      { text: 'hello', startMs: 1000, endMs: 1400, confidence: 0.9 },
      { text: 'world', startMs: 1500, endMs: 2000 },
    ],
    endOfUtterance: true,
    ...overrides,
  };
}

function gap(reason: GapReason, startMs = 5000, endMs = 9000, detail?: string): TranscriptGap {
  return { provider: 'browser-local', startMs, endMs, reason, ...(detail === undefined ? {} : { detail }) };
}

function revision(revisionId: string, overrides: Partial<TranscriptRevision> = {}): TranscriptRevision {
  return {
    revisionId,
    provider: 'browser-local',
    model: LIVE_MODEL,
    createdAtMs: Date.UTC(2026, 9, 13, 20, 6, 0),
    source: 'live',
    segments: [segment()],
    gaps: [],
    ...overrides,
  };
}

const segmentEvent = (overrides: Partial<TranscriptSegment>): AdapterEvent => ({ type: 'segment', segment: segment(overrides) });

// --- LiveRevisionCollector -----------------------------------------------------------

test('the live collector keeps final segments with text and gaps; nothing else', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1234 });
  const events: AdapterEvent[] = [
    { type: 'state', state: 'connecting' },
    { type: 'state', state: 'open' },
    segmentEvent({ segmentKey: 'u1', kind: 'interim', text: 'hell', words: [], endOfUtterance: false }),
    segmentEvent({ segmentKey: 'u1', kind: 'interim', text: 'hello wor', words: [], endOfUtterance: false }),
    segmentEvent({ segmentKey: 'u1' }),
    { type: 'backlog', behind: true, lagMs: 4000 },
    segmentEvent({ segmentKey: 'u2', kind: 'interim', startMs: 3000, endMs: 3400, text: 'um', words: [], endOfUtterance: false }),
    // A final with empty text retracts the interim of u2.
    segmentEvent({ segmentKey: 'u2', startMs: 3000, endMs: 3400, text: '', words: [] }),
    { type: 'error', error: { provider: 'browser-local', kind: 'provider', retryable: true, code: 'engine-failed', message: 'worker stopped' } },
    { type: 'gap', gap: gap('engine-failed', 3400, 6000, 'worker stopped') },
    { type: 'usage', provider: 'browser-local', audioSeconds: 6, basis: 'audio fed' },
    { type: 'state', state: 'closed' },
  ];
  for (const event of events) collector.onEvent(event);

  assert.deepEqual(collector.revision(), {
    revisionId: 'r1',
    provider: 'browser-local',
    model: 'vosk-small-en-us',
    createdAtMs: 1234,
    source: 'live',
    segments: [segment({ segmentKey: 'u1' })],
    gaps: [gap('engine-failed', 3400, 6000, 'worker stopped')],
    timing: { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 },
  });
});

test('the live collector orders segments and gaps by start time and takes a model name', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r4', createdAtMs: 1, model: 'vosk-other' });
  collector.onEvent({ type: 'gap', gap: gap('engine-behind', 8000, 9000) });
  collector.onEvent(segmentEvent({ segmentKey: 'u3', startMs: 6000, endMs: 7000, text: 'three' }));
  collector.onEvent({ type: 'gap', gap: gap('model-missing', 0, 500) });
  collector.onEvent(segmentEvent({ segmentKey: 'u1', startMs: 1000, endMs: 2000, text: 'one' }));
  collector.onEvent(segmentEvent({ segmentKey: 'u2', startMs: 3000, endMs: 4000, text: 'two' }));
  const result = collector.revision();
  assert.equal(result.model, 'vosk-other');
  assert.deepEqual(
    result.segments.map((entry) => entry.text),
    ['one', 'two', 'three'],
  );
  assert.deepEqual(
    result.gaps.map((entry) => entry.reason),
    ['model-missing', 'engine-behind'],
  );
});

test('a Parakeet live revision names Parakeet and its approximate token times (#16617)', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  collector.onEvent(segmentEvent({ segmentKey: 'u1', model: 'parakeet-tdt-0.6b-v2-int8', timing: 'approximate' }));
  const result = collector.revision();
  assert.equal(result.model, 'parakeet-tdt-0.6b-v2-int8');
  assert.deepEqual(result.timing, { quality: 'approximate', method: 'tdt-token-times', correctionMs: -30 });
});

test('a live revision that fell back from Parakeet to Vosk names both and has mixed timing (#16617)', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  collector.onEvent(segmentEvent({ segmentKey: 'u1', model: 'parakeet-tdt-0.6b-v2-int8', timing: 'approximate' }));
  collector.onEvent(segmentEvent({ segmentKey: 'u2', startMs: 3000, endMs: 4000, text: 'later' }));
  const result = collector.revision();
  assert.equal(result.model, 'parakeet-tdt-0.6b-v2-int8+vosk-small-en-us');
  assert.deepEqual(result.timing, { quality: 'mixed', method: 'tdt-token-times+vosk-alignment', correctionMs: -30 });
});

test('a segment saved before #16617 names no model and counts as Vosk', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  collector.onEvent(segmentEvent({ segmentKey: 'u1', model: undefined as unknown as string }));
  collector.onEvent(segmentEvent({ segmentKey: 'u2', startMs: 3000, endMs: 4000, text: 'later' }));
  const result = collector.revision();
  assert.equal(result.model, 'vosk-small-en-us');
  assert.deepEqual(result.timing, { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 });
});

test('a live revision with no text names the default live model', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  collector.onEvent({ type: 'gap', gap: gap('model-missing', 0, 500) });
  assert.equal(collector.revision().model, 'vosk-small-en-us');
  assert.equal(collector.revision().timing?.quality, 'aligned');
});

test('a revision taken from the collector does not change when more events arrive', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  collector.onEvent(segmentEvent({ segmentKey: 'u1' }));
  const early = collector.revision();
  collector.onEvent(segmentEvent({ segmentKey: 'u2', startMs: 3000, endMs: 4000, text: 'later' }));
  collector.onEvent({ type: 'gap', gap: gap('engine-failed') });
  assert.equal(early.segments.length, 1);
  assert.equal(early.gaps.length, 0);
  assert.equal(collector.revision().segments.length, 2);
  assert.equal(collector.revision().gaps.length, 1);
});

test('onEvent works as a detached callback', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1 });
  const { onEvent } = collector;
  onEvent(segmentEvent({}));
  assert.equal(collector.revision().segments.length, 1);
});

// --- RevisionSet -----------------------------------------------------------------------

test('nextId gives r1, r2, … and never an ID that exists', () => {
  const set = new RevisionSet();
  assert.equal(set.nextId(), 'r1');
  assert.equal(set.nextId(), 'r1', 'asking does not reserve');
  set.add(revision(set.nextId()));
  assert.equal(set.nextId(), 'r2');
  set.add(revision(set.nextId()));
  assert.equal(set.nextId(), 'r3');
  assert.deepEqual(
    set.list().map((entry) => entry.revisionId),
    ['r1', 'r2'],
  );

  assert.equal(new RevisionSet([revision('r2')]).nextId(), 'r3');
  assert.equal(new RevisionSet([revision('r1'), revision('r3')]).nextId(), 'r4');
  assert.equal(new RevisionSet([revision('live-a'), revision('live-b')]).nextId(), 'r3');
});

test('add stores a frozen copy: later changes to the input do not reach the set', () => {
  const input = revision('r1', {
    gaps: [gap('engine-failed', 5000, 9000, 'worker stopped')],
    timing: { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 },
  });
  const set = new RevisionSet();
  set.add(input);

  input.model = 'changed';
  input.segments[0].text = 'changed';
  input.segments[0].words[0].startMs = -1;
  input.segments.push(segment({ segmentKey: 'u9' }));
  input.gaps.length = 0;
  assert.ok(input.timing);
  input.timing.correctionMs = 99;

  const kept = set.get('r1');
  assert.ok(kept);
  assert.notEqual(kept, input);
  assert.deepEqual(
    kept,
    revision('r1', {
      gaps: [gap('engine-failed', 5000, 9000, 'worker stopped')],
      timing: { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 },
    }),
  );
  assert.ok(!Object.isFrozen(input), 'the caller keeps a normal object');
});

test('a stored revision is frozen at every level', () => {
  const set = new RevisionSet();
  set.add(revision('r1', { gaps: [gap('engine-failed')], timing: { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 } }));
  const kept = set.get('r1') as TranscriptRevision;
  for (const part of [kept, kept.segments, kept.segments[0], kept.segments[0].words, kept.segments[0].words[0], kept.gaps, kept.gaps[0], kept.timing]) {
    assert.ok(Object.isFrozen(part));
  }
  assert.throws(() => {
    kept.model = 'edited';
  }, TypeError);
  assert.throws(() => {
    kept.segments[0].text = 'edited';
  }, TypeError);
  assert.throws(() => {
    kept.segments[0].words[0].endMs = 1;
  }, TypeError);
  assert.throws(() => kept.segments.push(segment()), TypeError);
  assert.throws(() => kept.gaps.pop(), TypeError);
  assert.equal(set.list()[0], kept);
  assert.equal(kept.segments[0].text, 'hello world');
});

test('a revision ID is never rewritten: a duplicate is rejected and the first stays', () => {
  const set = new RevisionSet();
  set.add(revision('r1'));
  set.add(revision('r2'), { activate: false });
  assert.throws(() => set.add(revision('r1', { model: 'second-try' })), /revision r1 exists/);
  assert.equal(set.get('r1')?.model, LIVE_MODEL);
  assert.equal(set.list().length, 2);
  assert.equal(set.activeRevision, 'r1');
  assert.throws(() => new RevisionSet([revision('r1'), revision('r1')]), /revision r1 exists/);
});

test(`a recording holds at most ${MAX_REVISIONS} revisions`, () => {
  assert.equal(MAX_REVISIONS, 32, 'docs/bundle-schema.md §8.1: up to 32 revisions');
  const set = new RevisionSet();
  for (let i = 0; i < 32; i += 1) set.add(revision(set.nextId()));
  assert.equal(set.list().length, 32);
  assert.equal(set.activeRevision, 'r32');
  assert.throws(() => set.add(revision(set.nextId())), /at most 32 transcript revisions/);
  assert.equal(set.list().length, 32);
  assert.equal(set.get('r33'), undefined);
  assert.equal(set.activeRevision, 'r32');

  const full = Array.from({ length: 33 }, (_, index) => revision(`r${index + 1}`));
  assert.equal(new RevisionSet(full.slice(0, 32)).list().length, 32);
  assert.throws(() => new RevisionSet(full), /at most 32/);
});

test('add activates the new revision unless activate is false', () => {
  const set = new RevisionSet();
  assert.equal(set.activeRevision, null);
  set.add(revision('r1'));
  assert.equal(set.activeRevision, 'r1');
  set.add(revision('r2'), { activate: false });
  assert.equal(set.activeRevision, 'r1');
  set.add(revision('r3'), { activate: true });
  assert.equal(set.activeRevision, 'r3');
  set.add(revision('r4'), {});
  assert.equal(set.activeRevision, 'r4');
});

test('setActive picks an existing revision, rejects an unknown one and edits nothing', () => {
  const set = new RevisionSet();
  set.add(revision('r1'));
  set.add(revision('r2', { source: 'after-recording', supersedes: 'r1' }));
  const before = structuredClone(set.list());

  set.setActive('r1');
  assert.equal(set.activeRevision, 'r1');
  assert.throws(() => set.setActive('r9'), /no revision r9/);
  assert.equal(set.activeRevision, 'r1', 'a failed change keeps the active revision');
  set.setActive('r2');
  assert.equal(set.activeRevision, 'r2');
  assert.deepEqual(set.list(), before);
});

test('loading existing revisions activates none unless the manifest names one', () => {
  const loaded = new RevisionSet([revision('r1'), revision('r2')]);
  assert.equal(loaded.activeRevision, null);
  assert.deepEqual(
    loaded.list().map((entry) => entry.revisionId),
    ['r1', 'r2'],
  );
  assert.equal(new RevisionSet([revision('r1'), revision('r2')], 'r1').activeRevision, 'r1');
  assert.throws(() => new RevisionSet([revision('r1')], 'r7'), /no revision r7/);
  assert.equal(new RevisionSet().get('r1'), undefined);
});

test('the array from list() cannot be used to drop a revision', () => {
  const set = new RevisionSet();
  set.add(revision('r1'));
  set.add(revision('r2'));
  const listed = set.list() as TranscriptRevision[];
  try {
    listed.pop();
  } catch {
    // A frozen array is as good as a copy.
  }
  assert.ok(set.get('r2'), 'r2 was removed through the array list() returned');
  assert.equal(set.list().length, 2);
});

// --- toBundleRevision ----------------------------------------------------------------------

const mixed = (): TranscriptRevision =>
  revision('r2', {
    source: 'after-recording',
    model: 'whisper-base.en-q8',
    supersedes: 'r1',
    timing: { quality: 'approximate', method: 'whisper-dtw', correctionMs: -120 },
    segments: [
      segment({ segmentKey: 'u1', timing: 'approximate' }),
      segment({ segmentKey: 'u2', kind: 'interim', startMs: 2500, endMs: 2800, text: 'not fin', words: [], endOfUtterance: false }),
      segment({ segmentKey: 'u3', startMs: 3000, endMs: 3200, text: '', words: [] }),
      segment({ segmentKey: 'u4', startMs: 42100, endMs: 44800, text: 'This should collapse', words: [] }),
    ],
    gaps: [gap('model-missing', 90000, 95000), gap('disconnected', 96000, 97000, 'socket closed')],
  });

test('extensions: false writes exactly the fields of the draft schema', () => {
  assert.deepEqual(toBundleRevision(mixed(), { extensions: false }), {
    revisionId: 'r2',
    source: 'after-recording',
    provider: 'browser-local',
    model: 'whisper-base.en-q8',
    language: 'en',
    createdAt: '2026-10-13T20:06:00.000Z',
    segments: [
      {
        id: 's1',
        startMs: 1000,
        endMs: 2000,
        text: 'hello world',
        words: [
          { text: 'hello', startMs: 1000, endMs: 1400, confidence: 0.9 },
          { text: 'world', startMs: 1500, endMs: 2000 },
        ],
      },
      { id: 's2', startMs: 42100, endMs: 44800, text: 'This should collapse', words: [] },
    ],
    gaps: [
      { startMs: 90000, endMs: 95000, reason: 'not-transcribed' },
      { startMs: 96000, endMs: 97000, reason: 'disconnected' },
    ],
  });
});

test('the draft file has no key the schema does not list, at any level', () => {
  const file = toBundleRevision(mixed(), { extensions: false });
  assert.deepEqual(Object.keys(file).sort(), ['createdAt', 'gaps', 'language', 'model', 'provider', 'revisionId', 'segments', 'source']);
  for (const entry of file.segments) {
    assert.deepEqual(Object.keys(entry).sort(), ['endMs', 'id', 'startMs', 'text', 'words']);
    for (const word of entry.words) assert.ok(Object.keys(word).every((key) => ['text', 'startMs', 'endMs', 'confidence'].includes(key)));
  }
  for (const entry of file.gaps) assert.deepEqual(Object.keys(entry).sort(), ['endMs', 'reason', 'startMs']);
  assert.ok(!JSON.stringify(file).includes('undefined'));
  assert.deepEqual(JSON.parse(JSON.stringify(file)), file, 'the file survives JSON unchanged');
});

test('only final segments with text reach a bundle; a word without confidence has no confidence key', () => {
  const file = toBundleRevision(mixed());
  assert.deepEqual(
    file.segments.map((entry) => [entry.id, entry.text]),
    [
      ['s1', 'hello world'],
      ['s2', 'This should collapse'],
    ],
  );
  assert.ok('confidence' in file.segments[0].words[0]);
  assert.ok(!('confidence' in file.segments[0].words[1]));
});

test('local gap reasons are stored as not-transcribed; cloud reasons are kept', () => {
  const local: GapReason[] = ['model-missing', 'model-corrupt', 'engine-failed', 'engine-behind', 'not-transcribed'];
  const cloud: GapReason[] = ['connect-failed', 'disconnected', 'provider-error', 'rate-limited', 'auth-failed', 'user-stopped-provider'];
  const all = revision('r1', { gaps: [...local, ...cloud].map((reason, index) => gap(reason, index * 1000, index * 1000 + 500)) });
  for (const extensions of [false, true]) {
    const file = toBundleRevision(all, { extensions });
    assert.deepEqual(
      file.gaps.map((entry) => entry.reason),
      [...local.map(() => 'not-transcribed'), ...cloud],
    );
    assert.deepEqual(
      file.gaps.map((entry) => [entry.startMs, entry.endMs]),
      all.gaps.map((entry) => [entry.startMs, entry.endMs]),
    );
  }
});

test('with extensions the local reason and the detail go into gap.detail', () => {
  const file = toBundleRevision(
    revision('r1', {
      gaps: [
        gap('model-missing', 0, 1000),
        gap('engine-failed', 1000, 2000, 'worker stopped'),
        gap('not-transcribed', 2000, 3000),
        gap('not-transcribed', 3000, 4000, 'no run covered it'),
        gap('disconnected', 4000, 5000),
        gap('rate-limited', 5000, 6000, 'HTTP 429'),
      ],
    }),
  );
  assert.deepEqual(file.gaps, [
    { startMs: 0, endMs: 1000, reason: 'not-transcribed', detail: 'model-missing' },
    { startMs: 1000, endMs: 2000, reason: 'not-transcribed', detail: 'engine-failed: worker stopped' },
    { startMs: 2000, endMs: 3000, reason: 'not-transcribed' },
    { startMs: 3000, endMs: 4000, reason: 'not-transcribed', detail: 'no run covered it' },
    { startMs: 4000, endMs: 5000, reason: 'disconnected' },
    { startMs: 5000, endMs: 6000, reason: 'rate-limited', detail: 'HTTP 429' },
  ]);
});

test('a gap detail is cut to 500 characters, the local reason included', () => {
  const file = toBundleRevision(
    revision('r1', {
      gaps: [
        gap('engine-failed', 0, 1000, 'x'.repeat(600)),
        gap('disconnected', 1000, 2000, 'y'.repeat(501)),
        gap('rate-limited', 2000, 3000, 'z'.repeat(500)),
        gap('not-transcribed', 3000, 4000, 'w'.repeat(499)),
      ],
    }),
  );
  assert.equal(file.gaps[0].detail, `engine-failed: ${'x'.repeat(485)}`, 'the reason stays at the front; the cut is at the end');
  assert.deepEqual(
    file.gaps.map((entry) => entry.detail?.length),
    [500, 500, 500, 499],
  );
  assert.equal(file.gaps[1].detail, 'y'.repeat(500));
});

test('a mixed revision timing is written as it is; segments keep their own quality', () => {
  const file = toBundleRevision(
    revision('r3', {
      supersedes: 'r1',
      timing: { quality: 'mixed', method: 'whisper-dtw', correctionMs: -150 },
      segments: [segment({ segmentKey: 'u1', timing: 'aligned' }), segment({ segmentKey: 'u2', startMs: 3000, endMs: 4000, timing: 'approximate' })],
    }),
  );
  assert.deepEqual(file.timing, { quality: 'mixed', method: 'whisper-dtw', correctionMs: -150 });
  assert.deepEqual(
    file.segments.map((entry) => entry.timing),
    ['aligned', 'approximate'],
  );
});

test('extensions are on by default and add timing, detail and supersedes', () => {
  const file = toBundleRevision(mixed());
  assert.deepEqual(file, toBundleRevision(mixed(), { extensions: true }));
  assert.deepEqual(file.timing, { quality: 'approximate', method: 'whisper-dtw', correctionMs: -120 });
  assert.equal(file.supersedes, 'r1');
  assert.deepEqual(
    file.segments.map((entry) => entry.timing),
    ['approximate', 'aligned'],
    'a segment without a timing quality is aligned',
  );
  assert.deepEqual(file.gaps[0], { startMs: 90000, endMs: 95000, reason: 'not-transcribed', detail: 'model-missing' });
  assert.deepEqual(file.gaps[1], { startMs: 96000, endMs: 97000, reason: 'disconnected', detail: 'socket closed' });

  // Everything else is the draft file.
  const { timing: _timing, supersedes: _supersedes, ...rest } = file;
  const draft = toBundleRevision(mixed(), { extensions: false });
  assert.deepEqual(
    { ...rest, segments: rest.segments.map(({ timing: _segmentTiming, ...entry }) => entry), gaps: rest.gaps.map(({ detail: _detail, ...entry }) => entry) },
    draft,
  );
});

test('a revision without timing or supersedes gets neither key', () => {
  const file = toBundleRevision(revision('r1'));
  assert.ok(!('timing' in file));
  assert.ok(!('supersedes' in file));
});

test('live session → revision set → bundle file', () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: Date.UTC(2026, 9, 13, 20, 6, 0) });
  collector.onEvent(segmentEvent({ kind: 'interim', text: 'hello', words: [], endOfUtterance: false }));
  collector.onEvent(segmentEvent({}));
  collector.onEvent({ type: 'gap', gap: gap('engine-behind', 2000, 6000) });
  const set = new RevisionSet();
  set.add(collector.revision());
  const stored = set.get('r1');
  assert.ok(stored);
  assert.equal(set.activeRevision, 'r1');
  assert.deepEqual(toBundleRevision(stored, { extensions: false }), {
    revisionId: 'r1',
    source: 'live',
    provider: 'browser-local',
    model: 'vosk-small-en-us',
    language: 'en',
    createdAt: '2026-10-13T20:06:00.000Z',
    segments: [
      {
        id: 's1',
        startMs: 1000,
        endMs: 2000,
        text: 'hello world',
        words: [
          { text: 'hello', startMs: 1000, endMs: 1400, confidence: 0.9 },
          { text: 'world', startMs: 1500, endMs: 2000 },
        ],
      },
    ],
    gaps: [{ startMs: 2000, endMs: 6000, reason: 'not-transcribed' }],
  });
});
