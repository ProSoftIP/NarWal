// Board #16544: the final pass over captured audio. Covers the timing
// correction, engine failures, checkpoint and resume, retry of time ranges on
// top of an earlier revision, and the missing-model path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptRevision } from '../src/contract.ts';
import { FinalPassStopped, WHISPER_TIMING_BIAS_MS, runFinalPass } from '../src/final-pass.ts';
import type { FinalEngine, FinalEngineWord, FinalPassCheckpoint, FinalPassRequest } from '../src/final-pass.ts';
import { ModelError } from '../src/model-store.ts';
import { SHERPA_TIMING } from '../src/engines/whisper-client.ts';
import { pcmSource, planSpeech } from '../src/vad.ts';

const RATE = 16000;

/** Speech (a tone) at 1–3 s, 5–8 s and 10–12 s of a 13 s recording. */
function recording(): Float32Array {
  const pcm = new Float32Array(13 * RATE);
  for (const [from, to] of [
    [1, 3],
    [5, 8],
    [10, 12],
  ]) {
    for (let i = from * RATE; i < to * RATE; i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return pcm;
}

function scripted(answer: (call: number, pcm: Float32Array) => FinalEngineWord[] | Error) {
  const calls: number[] = [];
  const engine: FinalEngine = {
    async transcribe(pcm) {
      calls.push(pcm.length);
      const out = answer(calls.length - 1, pcm);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { engine, calls, getEngine: async () => engine };
}

const word = (text: string, start: number, end: number): FinalEngineWord => ({ text, start, end });
const request = (extra: Partial<FinalPassRequest> = {}): FinalPassRequest => ({ recordingId: 'rec', revisionId: 'r2', audio: pcmSource(recording()), ...extra });

test('the fixture has three speech spans', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  assert.equal(plan.length, 3);
  assert.ok(Math.abs(plan[0].startSample / RATE - 0.8) <= 0.05, `span starts ${plan[0].startSample / RATE}`);
});

test('one engine call per span; word times are moved earlier by the measured bias and marked approximate', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const s = scripted((call) => [word(` w${call}a`, 0.5, 0.8), word(` w${call}b`, 0.9, 1.2)]);
  const { revision, stats } = await runFinalPass({ getEngine: s.getEngine, now: () => 42 }, request({ audioOriginMs: 2000 }));
  assert.deepEqual(s.calls, plan.map((span) => span.endSample - span.startSample));
  assert.deepEqual(stats, { spans: 3, resumedSpans: 0, engineCalls: 3, failedSpans: 0, audioMs: Math.round((s.calls.reduce((a, b) => a + b, 0) / RATE) * 1000) });
  assert.equal(revision.revisionId, 'r2');
  assert.equal(revision.provider, 'browser-local');
  assert.equal(revision.model, 'whisper-base.en-q8');
  assert.equal(revision.source, 'after-recording');
  assert.equal(revision.createdAtMs, 42);
  assert.deepEqual(revision.timing, { quality: 'approximate', method: 'whisper-dtw', correctionMs: -WHISPER_TIMING_BIAS_MS });
  assert.deepEqual(revision.gaps, []);
  assert.equal(revision.segments.length, 3);
  const spanStartMs = 2000 + (plan[1].startSample / RATE) * 1000;
  const second = revision.segments[1];
  assert.equal(second.text, 'w1a w1b');
  assert.equal(second.kind, 'final');
  assert.equal(second.timing, 'approximate');
  assert.equal(second.segmentKey, 'r2:1');
  assert.deepEqual(second.words, [
    { text: 'w1a', startMs: Math.round(spanStartMs + 500 - 150), endMs: Math.round(spanStartMs + 800 - 150) },
    { text: 'w1b', startMs: Math.round(spanStartMs + 900 - 150), endMs: Math.round(spanStartMs + 1200 - 150) },
  ]);
  assert.equal(second.startMs, second.words[0].startMs);
  assert.equal(second.endMs, second.words[1].endMs);
});

test('a text-only engine: words are spread over the span, uncorrected, and marked span-interpolated (#16609)', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const engine: FinalEngine = { wordTimes: 'none', transcribe: async () => [word('Hello', 0, 0), word(' ', 0, 0), word('world.', 0, 0)] };
  const { revision } = await runFinalPass({ getEngine: async () => engine, biasMs: 150 }, request({ audioOriginMs: 0 }));
  assert.deepEqual(revision.timing, { quality: 'approximate', method: 'span-interpolated', correctionMs: 0 });
  assert.equal(revision.segments.length, 3);
  const second = revision.segments[1];
  assert.equal(second.text, 'Hello world.');
  assert.equal(second.timing, 'approximate');
  // Speech in the second span is 5–8 s: the first word starts with it, the second ends with it.
  const [hello, world] = second.words;
  assert.ok(Math.abs(hello.startMs - 5000) <= 20, `starts ${hello.startMs}`);
  assert.ok(Math.abs(world.endMs - 8000) <= 20, `ends ${world.endMs}`);
  assert.ok(Math.abs(hello.endMs - 6500) <= 20 && hello.endMs === world.startMs, JSON.stringify(second.words));
  assert.ok(second.startMs >= Math.round((plan[1].startSample / RATE) * 1000) && second.endMs <= Math.round((plan[1].endSample / RATE) * 1000));
});

test('an engine that declares its own timing sets the method and bias (Parakeet: token times, 30 ms earlier)', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const engine: FinalEngine = { timing: SHERPA_TIMING, transcribe: async () => [word(' w', 0.5, 0.8)] };
  const { revision } = await runFinalPass({ getEngine: async () => engine, model: 'parakeet-tdt-0.6b-v2-int8', now: () => 0 }, request());
  assert.deepEqual(revision.timing, { quality: 'approximate', method: 'tdt-token-times', correctionMs: -30 });
  assert.equal(revision.model, 'parakeet-tdt-0.6b-v2-int8');
  const spanStartMs = (plan[0].startSample / RATE) * 1000;
  assert.deepEqual(revision.segments[0].words, [{ text: 'w', startMs: Math.round(spanStartMs + 470), endMs: Math.round(spanStartMs + 770) }]);
});

test('an engine timing with no bias leaves the times and records no correction', async () => {
  const engine: FinalEngine = { timing: { method: 'tdt-token-times', biasMs: 0 }, transcribe: async () => [word(' w', 0.5, 0.8)] };
  const { revision } = await runFinalPass({ getEngine: async () => engine, now: () => 0 }, request());
  assert.deepEqual(revision.timing, { quality: 'approximate', method: 'tdt-token-times', correctionMs: 0 });
});

test('corrected times stay inside the span and in order; blank words are dropped', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const spanStartMs = Math.round((plan[0].startSample / RATE) * 1000);
  const spanEndMs = Math.round((plan[0].endSample / RATE) * 1000);
  const s = scripted((call) => (call === 0 ? [word('early', 0.05, 0.1), word('  ', 0.2, 0.3), word('back', 0.02, 0.4), word('late', 99, 100)] : []));
  const { revision } = await runFinalPass({ getEngine: s.getEngine }, request());
  assert.equal(revision.segments.length, 1, 'spans with no words give no segment');
  assert.deepEqual(revision.gaps, [], 'and no gap: the engine heard them');
  const words = revision.segments[0].words;
  assert.deepEqual(words.map((entry) => entry.text), ['early', 'back', 'late']);
  assert.equal(words[0].startMs, spanStartMs, 'a start before the span is moved to its start');
  assert.ok(words[1].startMs >= words[0].startMs);
  assert.equal(words[2].startMs, spanEndMs, 'a start after the span is moved to its end');
  for (const entry of words) assert.ok(entry.endMs >= entry.startMs && entry.endMs <= spanEndMs);
});

test('timeMap places words on the session clock', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const s = scripted(() => [word('a', 0.5, 0.6)]);
  const { revision } = await runFinalPass({ getEngine: s.getEngine, biasMs: 0 }, request({ audioOriginMs: 999999, timeMap: (seconds) => 500 + seconds * 1001 }));
  assert.equal(revision.segments[0].words[0].startMs, Math.round(500 + (plan[0].startSample / RATE + 0.5) * 1001));
});

test('a missing or corrupt model fails before any work and yields no revision', async () => {
  const missing = new ModelError('model-missing', 'whisper-base.en-q8', 'not downloaded');
  await assert.rejects(runFinalPass({ getEngine: async () => Promise.reject(missing) }, request()), (error) => error === missing);
  const corrupt = new ModelError('model-corrupt', 'whisper-base.en-q8', 'bad');
  const s = scripted(() => corrupt);
  await assert.rejects(runFinalPass({ getEngine: s.getEngine }, request()), (error) => error === corrupt);
  assert.equal(s.calls.length, 1, 'a model error is not retried');
});

test('a failed span is retried, then becomes a gap; the other spans are kept', async () => {
  const once = scripted((call) => (call === 1 ? new Error('out of memory') : [word('ok', 0.3, 0.5)]));
  const first = await runFinalPass({ getEngine: once.getEngine }, request());
  assert.equal(first.stats.engineCalls, 4);
  assert.equal(first.stats.failedSpans, 0);
  assert.equal(first.revision.segments.length, 3);

  const plan = await planSpeech(pcmSource(recording()));
  const middle = plan[1].endSample - plan[1].startSample;
  const always = scripted((_call, pcm) => (pcm.length === middle ? new Error('out of memory') : [word('ok', 0.3, 0.5)]));
  const second = await runFinalPass({ getEngine: always.getEngine, retries: 2 }, request());
  assert.equal(second.stats.engineCalls, 5);
  assert.equal(second.stats.failedSpans, 1);
  assert.equal(second.revision.segments.length, 2);
  assert.deepEqual(second.revision.gaps, [
    { provider: 'browser-local', startMs: Math.round((plan[1].startSample / RATE) * 1000), endMs: Math.round((plan[1].endSample / RATE) * 1000), reason: 'engine-failed', detail: 'out of memory' },
  ]);
});

test('repeated failures stop the run with the checkpoint saved', async () => {
  const s = scripted(() => new Error('dead'));
  const saved: FinalPassCheckpoint[] = [];
  await assert.rejects(
    runFinalPass({ getEngine: s.getEngine, retries: 0, maxConsecutiveFailures: 2 }, request({ onCheckpoint: (checkpoint) => void saved.push(structuredClone(checkpoint)) })),
    (error) => error instanceof FinalPassStopped && error.code === 'engine-failed',
  );
  assert.equal(s.calls.length, 2);
  assert.deepEqual(Object.keys(saved.at(-1)!.done), ['0', '1']);
  assert.ok(saved.at(-1)!.done['1'].gap);
});

test('cancel, then resume: finished spans are not transcribed again and take the new revision ID', async () => {
  const controller = new AbortController();
  let saved: FinalPassCheckpoint | null = null;
  const progress: number[] = [];
  const first = scripted((call) => [word(`first${call}`, 0.3, 0.5)]);
  await assert.rejects(
    runFinalPass(
      { getEngine: first.getEngine },
      request({
        signal: controller.signal,
        onProgress: ({ doneSpans }) => progress.push(doneSpans),
        onCheckpoint: (checkpoint) => {
          saved = structuredClone(checkpoint);
          controller.abort();
        },
      }),
    ),
    (error) => error instanceof FinalPassStopped && error.code === 'aborted' && error.name === 'AbortError',
  );
  assert.equal(first.calls.length, 1);
  assert.deepEqual(progress, [1]);
  assert.ok(saved);

  const second = scripted((call) => [word(`second${call}`, 0.3, 0.5)]);
  const { revision, stats } = await runFinalPass({ getEngine: second.getEngine }, request({ revisionId: 'r3', resumeFrom: saved }));
  assert.equal(second.calls.length, 2);
  assert.equal(stats.resumedSpans, 1);
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['first0', 'second0', 'second1']);
  assert.deepEqual(revision.segments.map((segment) => segment.segmentKey), ['r3:0', 'r3:1', 'r3:2']);
  assert.ok(revision.segments.every((segment) => segment.connectionId === 'r3'));
});

test('a checkpoint from another recording, model or plan is not used; a failed span in a checkpoint is tried again', async () => {
  const good = scripted(() => [word('x', 0.3, 0.5)]);
  let saved: FinalPassCheckpoint | null = null;
  await runFinalPass({ getEngine: good.getEngine }, request({ onCheckpoint: (checkpoint) => void (saved = structuredClone(checkpoint)) }));
  const checkpoint = saved as unknown as FinalPassCheckpoint;

  for (const stale of [
    { ...checkpoint, recordingId: 'other' },
    { ...checkpoint, model: 'whisper-tiny' },
    { ...checkpoint, plan: checkpoint.plan.slice(1) },
  ]) {
    const s = scripted(() => [word('y', 0.3, 0.5)]);
    const { stats } = await runFinalPass({ getEngine: s.getEngine }, request({ revisionId: 'r3', resumeFrom: stale }));
    assert.equal(stats.resumedSpans, 0);
    assert.equal(s.calls.length, 3);
  }

  const withGap: FinalPassCheckpoint = structuredClone(checkpoint);
  withGap.done['1'] = { gap: { provider: 'browser-local', startMs: 0, endMs: 1, reason: 'engine-failed' } };
  const s = scripted(() => [word('again', 0.3, 0.5)]);
  const { revision, stats } = await runFinalPass({ getEngine: s.getEngine }, request({ revisionId: 'r3', resumeFrom: withGap }));
  assert.equal(s.calls.length, 1);
  assert.equal(stats.resumedSpans, 2);
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['x', 'again', 'x']);
  assert.deepEqual(revision.gaps, []);
});

test('retry of a time range builds a new revision on the old one and leaves the old one untouched', async () => {
  const plan = await planSpeech(pcmSource(recording()));
  const ms = (sample: number) => Math.round((sample / RATE) * 1000);
  const seed = scripted((call) => [word(`old${call}`, 0.3, 0.5)]);
  const base = (await runFinalPass({ getEngine: seed.getEngine }, request())).revision;
  const live: TranscriptRevision = {
    ...base,
    revisionId: 'r1',
    segments: [base.segments[0], base.segments[2]],
    gaps: [{ provider: 'browser-local', startMs: ms(plan[1].startSample), endMs: ms(plan[1].endSample), reason: 'engine-behind' }],
  };
  const before = structuredClone(live);

  const s = scripted(() => [word('filled', 0.3, 0.5)]);
  const { revision, stats } = await runFinalPass({ getEngine: s.getEngine }, request({ revisionId: 'r5', ranges: live.gaps.map((gap) => ({ startMs: gap.startMs, endMs: gap.endMs })), base: live }));
  assert.equal(s.calls.length, 1, 'only the span inside the range goes to the engine');
  assert.equal(stats.spans, 1);
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['old0', 'filled', 'old2']);
  assert.deepEqual(revision.gaps, []);
  assert.equal(revision.supersedes, 'r1');
  assert.equal(revision.revisionId, 'r5');
  assert.equal(revision.timing?.quality, 'approximate');

  // Over a live revision the aligned segments stay aligned, so the retry is `mixed`.
  const aligned: TranscriptRevision = { ...live, segments: live.segments.map(({ timing: _timing, ...segment }) => segment) };
  const mixed = await runFinalPass({ getEngine: scripted(() => [word('filled', 0.3, 0.5)]).getEngine }, request({ revisionId: 'r7', ranges: [{ startMs: live.gaps[0].startMs, endMs: live.gaps[0].endMs }], base: aligned }));
  assert.equal(mixed.revision.timing?.quality, 'mixed');
  assert.deepEqual(mixed.revision.segments.map((segment) => segment.timing), [undefined, 'approximate', undefined]);
  assert.deepEqual(live, before);
  assert.equal(revision.segments[0], live.segments[0], 'untouched segments are carried over as they are');

  const none = scripted(() => []);
  const empty = await runFinalPass({ getEngine: none.getEngine }, request({ revisionId: 'r6', ranges: [{ startMs: 3500, endMs: 4500 }], base: live, supersedes: 'r5' }));
  assert.equal(none.calls.length, 0, 'a range with no speech needs no engine call');
  assert.equal(empty.revision.segments.length, 2);
  assert.equal(empty.revision.gaps.length, 1);
  assert.equal(empty.revision.supersedes, 'r5');
});
