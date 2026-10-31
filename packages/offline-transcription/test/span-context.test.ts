// Board #16621: a span cut mid-speech, or under a second long, is decoded with
// the audio around it; its words are kept by start time and a word at the cut
// is kept once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFinalPass } from '../src/final-pass.ts';
import type { FinalEngine, FinalEngineWord, FinalPassCheckpoint } from '../src/final-pass.ts';
import { SPAN_CONTEXT, contextRead, keepSpanWords } from '../src/span-context.ts';
import { pcmSource, planSpeech } from '../src/vad.ts';

const RATE = 16000;
const word = (text: string, start: number, end = start + 0.3): FinalEngineWord => ({ text, start, end });
const s = (seconds: number) => Math.round(seconds * RATE);

test('context only at a mid-speech cut and around a short span, inside the recording', () => {
  const plan = [
    { startSample: s(0.5), endSample: s(0.8) }, // short, silence around it
    { startSample: s(3), endSample: s(10) }, // silence before, cut after
    { startSample: s(10), endSample: s(18) }, // cut before, silence after
    { startSample: s(25), endSample: s(29.9) }, // silence around it
  ];
  const length = s(30);
  assert.deepEqual(contextRead(plan, 0, length, RATE), { startSample: 0, endSample: s(2.8) });
  assert.deepEqual(contextRead(plan, 1, length, RATE), { startSample: s(3), endSample: s(12) });
  assert.deepEqual(contextRead(plan, 2, length, RATE), { startSample: s(8), endSample: s(18) });
  assert.deepEqual(contextRead(plan, 3, length, RATE), plan[3]);
  assert.deepEqual(contextRead(plan, 1, length, RATE, { contextS: 1, shortSpanS: 1 }), { startSample: s(3), endSample: s(11) });
  assert.equal(SPAN_CONTEXT.contextS * 2 + 20 <= 30, true, 'a widened 20 s span stays inside Whisper’s 30 s window');
});

const SPAN = { startSample: s(10), endSample: s(18) };
const BOTH = { startSample: s(8), endSample: s(20) };
const keep = (words: FinalEngineWord[], previous: { text: string; start: number } | null, read = BOTH) => keepSpanWords(words, SPAN, read, RATE, previous).map((w) => w.text);

test('words are kept by start time on a widened side only; blank words are dropped', () => {
  const words = [word('before', 8.5), word(' ', 9), word('in', 10.2), word('last', 17.8, 18.4), word('after', 18.2)];
  assert.deepEqual(keep(words, null), ['in', 'last']);
  assert.deepEqual(keep(words, null, { startSample: s(10), endSample: s(20) }), ['before', 'in', 'last']);
  assert.deepEqual(keep(words, null, SPAN), ['before', 'in', 'last', 'after']);
});

test('at a cut: a word both decodes heard is kept once', () => {
  const words = [word('across', 9.85), word('the', 10.3)];
  assert.deepEqual(keep(words, { text: 'Across', start: 9.8 }), ['the']);
  const late = [word('across,', 10.05), word('the', 10.3)];
  assert.deepEqual(keep(late, { text: 'across', start: 9.8 }), ['the']);
});

test('at a cut: a word the span before missed is recovered from just before the cut', () => {
  const words = [word('far', 9.2), word('That’s', 9.7), word('the', 10.1)];
  assert.deepEqual(keep(words, { text: 'far', start: 9.2 }), ['That’s', 'the']);
  // Not when the span before ended with it, or it is earlier than that span's last word.
  assert.deepEqual(keep(words, { text: 'thats', start: 9.65 }), ['the']);
  assert.deepEqual(keep(words, { text: 'went', start: 9.75 }), ['the']);
});

/** 25 s of speech with no long pause, so the VAD cuts it at 20 s. */
function longSpeech(): Float32Array {
  const pcm = new Float32Array(27 * RATE);
  for (let i = 1 * RATE; i < 26 * RATE; i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return pcm;
}

test('the final pass decodes a cut span with context, keeps each word once, and carries the cut over a resume', async () => {
  const audio = pcmSource(longSpeech());
  const plan = await planSpeech(audio);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].endSample, plan[1].startSample, 'the two spans share a cut');
  const cutS = plan[1].startSample / RATE;
  const decodes: [number, number][] = [];
  let lastStart = 0;
  // The engine hears a timeline; each decode places "split" on its own side of the cut.
  const engine: FinalEngine = {
    timing: { method: 'test', biasMs: 0 },
    async transcribe(pcm) {
      const offset = lastStart;
      const first = decodes.length === 0;
      decodes.push([Math.round(offset * RATE), Math.round(offset * RATE) + pcm.length]);
      const timeline = [word('one', 2), word('split', first ? cutS - 0.2 : cutS + 0.1), word('two', cutS + 1), word('three', 25)];
      return timeline.filter((w) => w.start >= offset && w.start < offset + pcm.length / RATE).map((w) => ({ ...w, start: w.start - offset, end: w.end - offset }));
    },
  };
  const audioSpy = { ...audio, read: async (from: number, to: number) => ((lastStart = from / RATE), audio.read(from, to)) };

  let saved: FinalPassCheckpoint | null = null;
  const controller = new AbortController();
  await assert.rejects(
    runFinalPass(
      { getEngine: async () => engine },
      { recordingId: 'rec', revisionId: 'r2', audio: audioSpy, signal: controller.signal, onCheckpoint: (c) => ((saved = structuredClone(c)), controller.abort()) },
    ),
  );
  assert.deepEqual(decodes[0], [plan[0].startSample, plan[0].endSample + 2 * RATE]);
  const checkpoint = saved as unknown as FinalPassCheckpoint;
  assert.deepEqual(checkpoint.done['0'].tail, { text: 'split', start: cutS - 0.2 });

  const { revision, stats } = await runFinalPass({ getEngine: async () => engine }, { recordingId: 'rec', revisionId: 'r3', audio: audioSpy, resumeFrom: checkpoint });
  assert.deepEqual(decodes[1], [plan[1].startSample - 2 * RATE, plan[1].endSample]);
  assert.equal(stats.resumedSpans, 1);
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['one split', 'two three']);
});

test('a text-only engine and contextS 0 decode bare spans', async () => {
  const audio = pcmSource(longSpeech());
  const plan = await planSpeech(audio);
  for (const [engine, context] of [
    [{ wordTimes: 'none', transcribe: async () => [word('x', 0)] }, undefined],
    [{ transcribe: async () => [word('x', 0.5)] }, { contextS: 0 }],
  ] as [FinalEngine, { contextS: number } | undefined][]) {
    const lengths: number[] = [];
    const spy = { ...audio, read: async (from: number, to: number) => (lengths.push(to - from), audio.read(from, to)) };
    await runFinalPass({ getEngine: async () => engine, context }, { recordingId: 'rec', revisionId: 'r2', audio: spy });
    assert.deepEqual(lengths.slice(-2), plan.map((span) => span.endSample - span.startSample));
  }
});
