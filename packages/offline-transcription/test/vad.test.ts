// Unit tests for the energy voice-activity segmentation of the final pass
// (board #16544): src/vad.ts. Synthetic 16 kHz PCM: silence is zeros, speech is
// a 440 Hz sine far above `vadRms`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_VAD, SpeechSegmenter, pcmSource, planSpeech } from '../src/vad.ts';
import type { PcmSource, SpeechSpan, VadOptions } from '../src/vad.ts';

const RATE = 16000;
/** One 20 ms analysis window. */
const WINDOW = 320;
const TAIL = DEFAULT_VAD.tailS * RATE;
const MAX = DEFAULT_VAD.maxSegS * RATE;
const s = (seconds: number) => Math.round(seconds * RATE);

type Part = ['speech' | 'silence' | 'hiss', number];

interface Audio {
  pcm: Float32Array;
  /** Sample ranges of the speech parts. */
  speech: SpeechSpan[];
}

/** Builds audio from parts of `[kind, seconds]`. `hiss` is a sine below the default threshold. */
function audio(parts: Part[], rate = RATE): Audio {
  const lengths = parts.map(([, seconds]) => Math.round(seconds * rate));
  const pcm = new Float32Array(lengths.reduce((sum, length) => sum + length, 0));
  const speech: SpeechSpan[] = [];
  let offset = 0;
  parts.forEach(([kind], index) => {
    const amplitude = kind === 'speech' ? 0.1 : kind === 'hiss' ? 0.002 : 0;
    if (amplitude) for (let i = offset; i < offset + lengths[index]; i += 1) pcm[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate);
    if (kind === 'speech') speech.push({ startSample: offset, endSample: offset + lengths[index] });
    offset += lengths[index];
  });
  return { pcm, speech };
}

function onePush(pcm: Float32Array, options: Partial<VadOptions> = {}): SpeechSpan[] {
  const segmenter = new SpeechSegmenter(options);
  return [...segmenter.push(pcm), ...segmenter.flush()];
}

function inChunks(pcm: Float32Array, sizes: number[], options: Partial<VadOptions> = {}): SpeechSpan[] {
  const segmenter = new SpeechSegmenter(options);
  const spans: SpeechSpan[] = [];
  let turn = 0;
  for (let offset = 0; offset < pcm.length; turn += 1) {
    const size = sizes[turn % sizes.length];
    spans.push(...segmenter.push(pcm.subarray(offset, offset + size)));
    offset += size;
  }
  spans.push(...segmenter.flush());
  return spans;
}

/** Ordered, not overlapping, not empty, inside the audio. */
function assertWellFormed(spans: SpeechSpan[], length: number): void {
  let previousEnd = 0;
  for (const span of spans) {
    assert.ok(Number.isInteger(span.startSample) && Number.isInteger(span.endSample));
    assert.ok(span.startSample >= previousEnd, `span ${JSON.stringify(span)} starts before ${previousEnd}`);
    assert.ok(span.endSample > span.startSample, `span ${JSON.stringify(span)} is empty`);
    assert.ok(span.endSample <= length, `span ${JSON.stringify(span)} ends after the audio (${length})`);
    previousEnd = span.endSample;
  }
}

function assertCovered(spans: SpeechSpan[], speech: SpeechSpan[]): void {
  for (const part of speech) {
    for (let at = part.startSample; at < part.endSample; ) {
      const span = spans.find((candidate) => candidate.startSample <= at && candidate.endSample > at);
      assert.ok(span, `speech sample ${at} is in no span`);
      at = span.endSample;
    }
  }
}

const lengths = (spans: SpeechSpan[]) => spans.map((span) => span.endSample - span.startSample);

test('empty and all-silence input give no spans', async () => {
  assert.deepEqual(onePush(new Float32Array(0)), []);
  assert.deepEqual(onePush(new Float32Array(s(5))), []);
  assert.deepEqual(await planSpeech(pcmSource(new Float32Array(0))), []);
  assert.deepEqual(await planSpeech(pcmSource(new Float32Array(s(45)))), []);
  assert.deepEqual(new SpeechSegmenter().flush(), []);
});

test('sound below vadRms is silence; vadRms is the threshold', async () => {
  const { pcm } = audio([
    ['hiss', 2],
    ['speech', 1],
    ['hiss', 2],
  ]);
  assert.deepEqual(await planSpeech(pcmSource(pcm)), [{ startSample: s(2) - TAIL, endSample: s(3) + TAIL }]);
  assert.deepEqual(await planSpeech(pcmSource(pcm), { vadRms: 0.2 }), [], 'a threshold above the speech level hears nothing');
  assert.deepEqual(await planSpeech(pcmSource(pcm), { vadRms: 0.0005 }), [{ startSample: 0, endSample: s(5) }], 'a threshold below the hiss hears all of it');
});

test('one utterance becomes one span: the speech plus tailS on both sides', async () => {
  const { pcm, speech } = audio([
    ['silence', 1],
    ['speech', 2],
    ['silence', 1.5],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.deepEqual(spans, [{ startSample: s(1) - TAIL, endSample: s(3) + TAIL }]);
  assertCovered(spans, speech);
  assert.deepEqual(await planSpeech(pcmSource(pcm), { tailS: 0.5 }), [{ startSample: s(0.5), endSample: s(3.5) }]);
});

test('the padding stops at the start and the end of the audio', async () => {
  const whole = audio([['speech', 2]]);
  assert.deepEqual(await planSpeech(pcmSource(whole.pcm)), [{ startSample: 0, endSample: s(2) }]);

  const nearEdges = audio([
    ['silence', 0.1],
    ['speech', 2],
    ['silence', 0.1],
  ]);
  assert.deepEqual(await planSpeech(pcmSource(nearEdges.pcm)), [{ startSample: 0, endSample: s(2.2) }]);
});

test('speech that does not start on a window edge is still covered', async () => {
  const { pcm, speech } = audio([
    ['silence', 1.003],
    ['speech', 2.011],
    ['silence', 1.507],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.equal(spans.length, 1);
  assertWellFormed(spans, pcm.length);
  assertCovered(spans, speech);
  assert.ok(speech[0].startSample - spans[0].startSample <= TAIL + WINDOW);
  assert.ok(spans[0].endSample - speech[0].endSample <= TAIL + WINDOW);
});

test('a pause of pauseS or longer splits; a shorter pause does not', async () => {
  const withPause = (seconds: number) =>
    audio([
      ['silence', 1],
      ['speech', 2],
      ['silence', seconds],
      ['speech', 1],
      ['silence', 1],
    ]);

  const short = withPause(0.58);
  assert.deepEqual(await planSpeech(pcmSource(short.pcm)), [{ startSample: s(1) - TAIL, endSample: s(4.58) + TAIL }]);

  const exact = withPause(0.6);
  const atLimit = await planSpeech(pcmSource(exact.pcm));
  assert.equal(atLimit.length, 2);
  assert.equal(atLimit[0].endSample, s(3) + TAIL);
  assert.equal(atLimit[1].endSample, s(4.6) + TAIL);
  assertWellFormed(atLimit, exact.pcm.length);
  assertCovered(atLimit, exact.speech);

  const long = withPause(2);
  assert.deepEqual(await planSpeech(pcmSource(long.pcm)), [
    { startSample: s(1) - TAIL, endSample: s(3) + TAIL },
    { startSample: s(5) - TAIL, endSample: s(6) + TAIL },
  ]);

  assert.equal((await planSpeech(pcmSource(short.pcm), { pauseS: 0.3 })).length, 2, 'pauseS is configurable');
  assert.equal((await planSpeech(pcmSource(long.pcm), { pauseS: 3 })).length, 1);
});

test('silence between utterances is left out of every span', async () => {
  const { pcm } = audio([
    ['speech', 1],
    ['silence', 4],
    ['speech', 1],
    ['silence', 4],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.deepEqual(lengths(spans), [s(1) + TAIL, s(1) + 2 * TAIL]);
  for (const at of [s(1.5), s(3), s(4.5), s(7), s(9.9)]) {
    assert.ok(!spans.some((span) => span.startSample <= at && span.endSample > at), `silent sample ${at} is inside a span`);
  }
});

test('push returns a span when its pause has passed; flush closes the open span', () => {
  const { pcm } = audio([
    ['silence', 1],
    ['speech', 2],
    ['silence', 1],
    ['speech', 1],
  ]);
  const segmenter = new SpeechSegmenter();
  assert.deepEqual(segmenter.push(pcm.subarray(0, s(3.5))), [], 'the pause is only 0.5 s old');
  assert.deepEqual(segmenter.push(pcm.subarray(s(3.5), s(3.7))), [{ startSample: s(1) - TAIL, endSample: s(3) + TAIL }]);
  assert.deepEqual(segmenter.push(pcm.subarray(s(3.7))), [], 'the second utterance is still open');
  assert.deepEqual(segmenter.flush(), [{ startSample: s(4) - TAIL, endSample: s(5) }]);
  assert.deepEqual(segmenter.flush(), [], 'a second flush has nothing left');
});

test('flush after a closed span returns nothing', () => {
  const { pcm } = audio([
    ['speech', 1],
    ['silence', 2],
  ]);
  const segmenter = new SpeechSegmenter();
  assert.deepEqual(segmenter.push(pcm), [{ startSample: 0, endSample: s(1) + TAIL }]);
  assert.deepEqual(segmenter.flush(), []);
});

test('flush counts a trailing part window when it limits the tail padding', () => {
  // 1 s of speech, then 100 samples: less than one window, so never analysed.
  const { pcm } = audio([['speech', 1]]);
  const padded = new Float32Array(pcm.length + 100);
  padded.set(pcm);
  assert.deepEqual(onePush(padded), [{ startSample: 0, endSample: s(1) + 100 }]);
});

test('speech without a pause is cut every maxSegS; the pieces join without a hole', async () => {
  const { pcm, speech } = audio([
    ['silence', 1],
    ['speech', 45],
    ['silence', 1],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  const first = s(1) - TAIL;
  assert.deepEqual(spans, [
    { startSample: first, endSample: first + MAX },
    { startSample: first + MAX, endSample: first + 2 * MAX },
    { startSample: first + 2 * MAX, endSample: s(46) + TAIL },
  ]);
  assertCovered(spans, speech);

  const quick = await planSpeech(pcmSource(pcm), { maxSegS: 5 });
  assert.ok(lengths(quick).every((length) => length <= 5 * RATE));
  assert.equal(quick.length, 10);
  assertWellFormed(quick, pcm.length);
  assertCovered(quick, speech);
});

test('a long span is cut inside the last short pause, not in the middle of a word', async () => {
  const { pcm, speech } = audio([
    ['speech', 6],
    ['silence', 0.3],
    ['speech', 6],
    ['silence', 0.3],
    ['speech', 18],
    ['silence', 1],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.equal(spans.length, 2);
  const cut = spans[0].endSample;
  assert.ok(cut > s(12.3) && cut < s(12.6), `cut at ${cut / RATE} s, expected inside the pause at 12.3–12.6 s`);
  assert.equal(spans[0].startSample, 0);
  assert.equal(spans[1].startSample, cut, 'no audio is lost at the cut');
  assert.equal(spans[1].endSample, s(30.6) + TAIL);
  assert.ok(lengths(spans).every((length) => length <= MAX));
  assertCovered(spans, speech);
});

test('a pause shorter than shortPauseS is not a cut point', async () => {
  const { pcm } = audio([
    ['speech', 12],
    ['silence', 0.1],
    ['speech', 18],
    ['silence', 1],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.equal(spans[0].endSample, MAX, 'cut at the limit');
  assert.equal(spans[1].startSample, MAX);
});

test('a short pause in the first second of a span is not used as the cut', async () => {
  const { pcm } = audio([
    ['speech', 0.5],
    ['silence', 0.3],
    ['speech', 25],
    ['silence', 1],
  ]);
  const spans = await planSpeech(pcmSource(pcm));
  assert.deepEqual(lengths(spans), [MAX, s(25.8) + TAIL - MAX], 'a cut at 0.65 s would leave a fragment too short to transcribe');
});

const AFTER_SHORT_PAUSE_CUT: Part[] = [
  ['silence', 1],
  ['speech', 15],
  ['silence', 0.3],
  ['speech', 40],
  ['silence', 1],
];

test('the span after a short-pause cut is also no longer than maxSegS', async () => {
  // The cut inside a short pause stays on the 20 ms window grid, so the next
  // span reaches the limit on a window edge, not half a window past it.
  const { pcm, speech } = audio(AFTER_SHORT_PAUSE_CUT);
  const spans = await planSpeech(pcmSource(pcm));
  assert.equal(spans.length, 4);
  assert.ok(spans[0].endSample > s(16) && spans[0].endSample < s(16.3), 'first cut inside the short pause');
  assert.equal(spans[0].endSample % WINDOW, 0, 'the cut is on the window grid');
  assert.ok(Math.max(...lengths(spans)) <= MAX, `longest span is ${Math.max(...lengths(spans)) / RATE} s`);
  assertWellFormed(spans, pcm.length);
  assertCovered(spans, speech);
  for (let i = 1; i < spans.length; i += 1) assert.equal(spans[i].startSample, spans[i - 1].endSample);
});

test('many utterances: one span each, ordered, not overlapping, all speech covered', async () => {
  // Deterministic pseudo-random lengths; every pause is at least pauseS.
  let state = 16544;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const parts: Part[] = [['silence', 0.37]];
  for (let i = 0; i < 25; i += 1) {
    parts.push(['speech', 0.2 + next() * 5], ['silence', 0.7 + next() * 2]);
  }
  const { pcm, speech } = audio(parts);
  const spans = await planSpeech(pcmSource(pcm));
  assert.equal(spans.length, 25);
  assertWellFormed(spans, pcm.length);
  assertCovered(spans, speech);
  spans.forEach((span, index) => {
    const length = span.endSample - span.startSample;
    const spoken = speech[index].endSample - speech[index].startSample;
    assert.ok(length <= spoken + 2 * (TAIL + WINDOW) + (DEFAULT_VAD.pauseS * RATE - TAIL), `span ${index} carries too much silence`);
  });
  const total = lengths(spans).reduce((sum, length) => sum + length, 0);
  assert.ok(total < pcm.length * 0.85, 'the long pauses are not in the plan');
});

test('streaming in odd chunk sizes gives the same plan as one push', () => {
  const { pcm } = audio([
    ['silence', 0.731],
    ['speech', 2.2],
    ['silence', 0.61],
    ['speech', 0.4],
    ['silence', 0.3],
    ['speech', 23.5],
    ['silence', 0.2],
    ['speech', 3],
    ['silence', 1.9],
    ['speech', 1.123],
  ]);
  const options: Partial<VadOptions> = { maxSegS: 8 };
  const expected = onePush(pcm, options);
  assert.ok(expected.length >= 5, 'the audio has pause splits and length cuts');
  assertWellFormed(expected, pcm.length);
  for (const sizes of [[1], [7], [319], [320], [321], [4801], [16000], [1, 4096, 13, 333, 9973]]) {
    assert.deepEqual(inChunks(pcm, sizes, options), expected, `chunks of ${sizes.join(', ')}`);
  }
});

test('planSpeech gives the same plan as one push and reads the source in blocks of 30 s or less', async () => {
  const { pcm } = audio([
    ['silence', 2],
    ['speech', 27.9],
    ['silence', 0.4],
    ['speech', 31],
    ['silence', 5],
    ['speech', 4],
  ]);
  const reads: [number, number][] = [];
  const source: PcmSource = {
    sampleRate: RATE,
    lengthSamples: pcm.length,
    async read(startSample, endSample) {
      reads.push([startSample, endSample]);
      return pcm.slice(startSample, endSample);
    },
  };
  const spans = await planSpeech(source);
  assert.deepEqual(spans, onePush(pcm));
  assert.ok(reads.length >= 3);
  assert.equal(reads[0][0], 0);
  assert.equal(reads.at(-1)?.[1], pcm.length);
  reads.forEach(([start, end], index) => {
    assert.ok(end - start <= 30 * RATE, 'a read is at most 30 s');
    if (index > 0) assert.equal(start, reads[index - 1][1], 'reads are contiguous');
  });
});

test('planSpeech uses the sample rate of the source', async () => {
  const parts: Part[] = [
    ['silence', 1],
    ['speech', 2],
    ['silence', 1],
    ['speech', 1],
    ['silence', 1],
  ];
  const at8k = await planSpeech(pcmSource(audio(parts, 8000).pcm, 8000), { sampleRate: 16000 });
  const at16k = await planSpeech(pcmSource(audio(parts).pcm));
  assert.equal(at16k.length, 2);
  assert.deepEqual(
    at8k,
    at16k.map((span) => ({ startSample: span.startSample / 2, endSample: span.endSample / 2 })),
  );
});

test('pcmSource reads the requested sample range', async () => {
  const pcm = Float32Array.from({ length: 100 }, (_, index) => index);
  const source = pcmSource(pcm, 8000);
  assert.equal(source.sampleRate, 8000);
  assert.equal(source.lengthSamples, 100);
  assert.deepEqual(Array.from(await source.read(10, 14)), [10, 11, 12, 13]);
  assert.equal(pcmSource(pcm).sampleRate, 16000);
});
