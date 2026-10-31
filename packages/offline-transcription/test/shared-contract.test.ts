// Board #16544: the offline option feeds the timing and revision contract the
// cloud adapters use. A live revision and a final revision made here go into
// the shared history of packages/transcription, and the file that history
// stores is the file this package writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptRevision as SharedRevision } from '../../transcription/src/contract.ts';
import { RevisionConflict, addRevision, createTranscriptHistory, validateTranscriptRevision } from '../../transcription/src/revisions.ts';
import type { AdapterEvent, TranscriptRevision, TranscriptSegment } from '../src/contract.ts';
import { runFinalPass } from '../src/final-pass.ts';
import { LiveRevisionCollector, toBundleRevision } from '../src/revisions.ts';
import { pcmSource } from '../src/vad.ts';

const RATE = 16000;
const CREATED = Date.parse('2026-10-13T20:00:00Z');

function liveSegment(key: string, kind: 'interim' | 'final', words: [string, number, number][]): TranscriptSegment {
  return {
    provider: 'browser-local',
    model: 'vosk-small-en-us',
    connectionId: 'c1',
    segmentKey: key,
    kind,
    startMs: words[0][1],
    endMs: words[words.length - 1][2],
    text: words.map(([text]) => text).join(' '),
    words: kind === 'final' ? words.map(([text, startMs, endMs]) => ({ text, startMs, endMs, confidence: 0.9 })) : [],
    endOfUtterance: kind === 'final',
    timing: kind === 'final' ? 'aligned' : 'approximate',
  };
}

/** A live revision with one gap of every local reason. */
function liveRevision(): TranscriptRevision {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: CREATED });
  const events: AdapterEvent[] = [
    { type: 'state', state: 'open' },
    { type: 'segment', segment: liveSegment('c1:0', 'interim', [['this', 400, 900]]) },
    { type: 'segment', segment: liveSegment('c1:0', 'final', [['this', 420, 610], ['should', 610, 950], ['collapse', 950, 1600]]) },
    { type: 'backlog', behind: true, lagMs: 4000 },
    { type: 'gap', gap: { provider: 'browser-local', startMs: 2000, endMs: 3000, reason: 'engine-behind', detail: 'skipped 1000 ms' } },
    { type: 'gap', gap: { provider: 'browser-local', startMs: 4000, endMs: 5000, reason: 'model-missing' } },
    { type: 'gap', gap: { provider: 'browser-local', startMs: 6000, endMs: 7000, reason: 'model-corrupt', detail: 'x'.repeat(600) } },
    { type: 'gap', gap: { provider: 'browser-local', startMs: 8000, endMs: 9000, reason: 'engine-failed' } },
    { type: 'gap', gap: { provider: 'browser-local', startMs: 9500, endMs: 9900, reason: 'not-transcribed' } },
    { type: 'segment', segment: liveSegment('c1:1', 'final', [['revenue', 10100, 10600], ['heading', 10600, 11000]]) },
  ];
  for (const event of events) collector.onEvent(event);
  return collector.revision();
}

async function finalRevision(supersedes: string): Promise<TranscriptRevision> {
  const pcm = new Float32Array(4 * RATE);
  for (let i = RATE; i < 3 * RATE; i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  const engine = { transcribe: async () => [{ text: 'This', start: 0.5, end: 0.8 }, { text: 'collapses.', start: 0.8, end: 1.4 }] };
  const { revision } = await runFinalPass(
    { getEngine: async () => engine, now: () => CREATED + 60_000 },
    { recordingId: 'rec-1', revisionId: 'r2', audio: pcmSource(pcm), supersedes },
  );
  return revision;
}

test('a local revision is a revision of the shared contract', async () => {
  const live = liveRevision();
  const final = await finalRevision('r1');
  // Compile-time: `tsc` refuses these two lines if a local field leaves the shared contract.
  const shared: SharedRevision[] = [live, final];
  for (const revision of shared) assert.deepEqual(validateTranscriptRevision(revision), []);
  assert.deepEqual(validateTranscriptRevision({ ...final, timing: { quality: 'exact', method: '', correctionMs: Number.NaN } }), [
    'timing.quality is unknown',
    'timing.method is empty or longer than 200 characters',
    'timing.correctionMs is not a number',
  ]);
});

test('the shared history stores live and final local revisions as the files this package writes', async () => {
  const live = liveRevision();
  const final = await finalRevision('r1');
  let history = createTranscriptHistory('rec-1');
  history = addRevision(history, live);
  history = addRevision(history, final);

  assert.deepEqual(history.revisions.map((revision) => revision.revisionId), ['r1', 'r2']);
  assert.equal(history.activeRevision, 'r2');
  assert.deepEqual(history.revisions[0], toBundleRevision(live));
  assert.deepEqual(history.revisions[1], toBundleRevision(final));

  const [storedLive, storedFinal] = history.revisions;
  assert.equal(storedLive.provider, 'browser-local');
  assert.deepEqual(storedLive.timing, { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 });
  assert.deepEqual(storedLive.segments.map((segment) => segment.timing), ['aligned', 'aligned']);
  assert.equal(storedLive.segments.length, 2, 'interim text never reaches a stored revision');
  assert.deepEqual(storedLive.gaps.map((gap) => gap.reason), Array(5).fill('not-transcribed'));
  assert.deepEqual(storedLive.gaps.slice(0, 2).map((gap) => gap.detail), ['engine-behind: skipped 1000 ms', 'model-missing']);
  assert.equal(storedLive.gaps[2].detail?.length, 500, 'detail is cut to the 500 characters the bundle allows');
  assert.equal('detail' in storedLive.gaps[4], false);
  assert.deepEqual(storedFinal.timing, { quality: 'approximate', method: 'whisper-dtw', correctionMs: -150 });
  assert.deepEqual(storedFinal.segments.map((segment) => segment.timing), ['approximate']);
  assert.equal(storedFinal.supersedes, 'r1');
  assert.deepEqual(history.revisions[0], toBundleRevision(live), 'the live revision is unchanged by the final one');
});

test('the shared history refuses a revision that supersedes one it does not hold', async () => {
  const final = await finalRevision('r9');
  const history = addRevision(createTranscriptHistory('rec-1'), liveRevision());
  assert.throws(() => addRevision(history, final), (error) => error instanceof RevisionConflict && error.reason === 'unknown-revision');
  assert.equal(history.revisions.length, 1);
});
