// Unit tests for the audio helpers of the offline engines (board #16544):
// src/audio.ts. PCM16 conversion, the streaming resampler to 16 kHz and the
// audio clock fit. `decodeToEnginePcm` needs a browser AudioContext; the
// end-to-end run covers it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINE_SAMPLE_RATE, StreamResampler, fitAudioClock, floatToPcm16, pcm16ToFloat } from '../src/audio.ts';
import type { AudioClockPair } from '../src/audio.ts';

const tone = (hz: number, rate: number, samples: number, amplitude = 0.5): Float32Array =>
  Float32Array.from({ length: samples }, (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / rate));

const rms = (samples: Float32Array, from = 0): number => {
  let energy = 0;
  for (let i = from; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / (samples.length - from));
};

/** Rising zero crossings: one per cycle of a tone. */
function cycles(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) count += 1;
  return count;
}

function resampleInChunks(input: Float32Array, inputRate: number, sizes: number[]): Float32Array {
  const resampler = new StreamResampler(inputRate);
  const parts: Float32Array[] = [];
  let turn = 0;
  for (let offset = 0; offset < input.length; turn += 1) {
    const size = sizes[turn % sizes.length];
    parts.push(resampler.push(input.subarray(offset, offset + size)));
    offset += size;
  }
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- PCM16 ↔ Float32 -------------------------------------------------------------

test('pcm16ToFloat scales PCM16 to -1..1 and ignores an odd trailing byte', () => {
  const pcm = Int16Array.from([-32768, -16384, 0, 1, 16384, 32767]);
  assert.deepEqual(Array.from(pcm16ToFloat(pcm.buffer)), [-1, -0.5, 0, 1 / 32768, 0.5, 32767 / 32768]);

  const odd = new Uint8Array(5);
  new DataView(odd.buffer).setInt16(0, -32768, true);
  new DataView(odd.buffer).setInt16(2, 16384, true);
  odd[4] = 0x7f;
  assert.deepEqual(Array.from(pcm16ToFloat(odd.buffer)), [-1, 0.5]);
  assert.equal(pcm16ToFloat(new ArrayBuffer(0)).length, 0);
});

test('floatToPcm16 maps full scale to the PCM16 limits and clips beyond them', () => {
  const pcm = new Int16Array(floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 1.0001, 2, -1.5, -40, Infinity, -Infinity])));
  assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 16384, -16384, 32767, 32767, -32768, -32768, 32767, -32768]);
  assert.equal(floatToPcm16(new Float32Array(7)).byteLength, 14);
});

test('Float32 → PCM16 → Float32 stays within half a quantisation step, with the sign kept', () => {
  // Both directions use the same scale, so rounding is the only error. Only
  // +1.0 itself has no PCM16 value: it becomes 32767, one step below.
  const step = 1 / 32768;
  const input = Float32Array.from({ length: 4001 }, (_, index) => (index - 2000) / 2000);
  const output = pcm16ToFloat(floatToPcm16(input));
  assert.equal(output.length, input.length);
  for (let i = 0; i < input.length; i += 1) {
    const allowed = input[i] === 1 ? step : step / 2;
    assert.ok(Math.abs(output[i] - input[i]) <= allowed + 1e-12, `sample ${input[i]} came back as ${output[i]}`);
    assert.ok(output[i] === 0 || Math.sign(output[i]) === Math.sign(input[i]));
  }
});

test('PCM16 → Float32 → PCM16 returns every value unchanged', () => {
  const input = Int16Array.from({ length: 65536 }, (_, index) => index - 32768);
  const output = new Int16Array(floatToPcm16(pcm16ToFloat(input.buffer)));
  const changed = Array.from(input).filter((value, index) => output[index] !== value);
  assert.equal(changed.length, 0, `${changed.length} values changed, the first is ${changed[0]}`);
});

// --- StreamResampler ---------------------------------------------------------------

for (const inputRate of [48000, 44100]) {
  test(`${inputRate} → 16000: the output length follows the rate ratio over a multi-chunk stream`, () => {
    // The filter needs input on both sides of an output sample, and there is no
    // flush, so the output is short by the filter half-width (12 samples, 0.75 ms).
    const seconds = 7;
    const input = tone(440, inputRate, inputRate * seconds);
    const expected = ENGINE_SAMPLE_RATE * seconds;
    const chunk = Math.round(inputRate / 100);
    const lengths = [[chunk], [chunk + 7], [128], [4096, 333, 1024]].map((sizes) => resampleInChunks(input, inputRate, sizes).length);
    for (const length of lengths) {
      assert.ok(length <= expected, `${length} samples from ${seconds} s`);
      assert.ok(expected - length <= 13, `${expected - length} samples short`);
    }
    assert.equal(new Set(lengths).size, 1, 'the chunk size does not change the length');

    const longer = resampleInChunks(tone(440, inputRate, inputRate * seconds * 2), inputRate, [chunk]).length;
    assert.equal(expected * 2 - longer, expected - lengths[0], 'the shortfall does not grow with the stream');
  });

  test(`${inputRate} → 16000: a 440 Hz tone stays 440 Hz, same level, same position in time`, () => {
    const seconds = 2;
    const out = resampleInChunks(tone(440, inputRate, inputRate * seconds), inputRate, [Math.round(inputRate / 100)]);
    const heard = cycles(out) / (out.length / ENGINE_SAMPLE_RATE);
    assert.ok(Math.abs(heard - 440) < 1, `${heard} Hz`);
    assert.ok(Math.abs(rms(out, 30) - 0.5 / Math.SQRT2) < 0.002, `level ${rms(out, 30)}`);
    // Past the first samples (the filter has no history there) the output is the same tone sampled at 16 kHz.
    for (let i = 30; i < out.length; i += 1) {
      const ideal = 0.5 * Math.sin((2 * Math.PI * 440 * i) / ENGINE_SAMPLE_RATE);
      assert.ok(Math.abs(out[i] - ideal) < 1e-3, `sample ${i}: ${out[i]} instead of ${ideal}`);
    }
    for (let i = 0; i < 30; i += 1) {
      const ideal = 0.5 * Math.sin((2 * Math.PI * 440 * i) / ENGINE_SAMPLE_RATE);
      assert.ok(Math.abs(out[i] - ideal) < 0.05, `sample ${i}: ${out[i]} instead of ${ideal}`);
    }
  });

  test(`${inputRate} → 16000: a tone above 8 kHz is removed instead of aliasing into the speech band`, () => {
    const input = tone(12000, inputRate, inputRate);
    const out = new StreamResampler(inputRate).push(input);
    // Without the low-pass a 12 kHz tone would come out as a full-level 4 kHz tone.
    const ratio = rms(out, 30) / rms(input);
    assert.ok(ratio < 0.001, `12 kHz came through at ${(20 * Math.log10(ratio)).toFixed(1)} dB`);

    const speechBand = tone(3000, inputRate, inputRate);
    const kept = rms(new StreamResampler(inputRate).push(speechBand), 30) / rms(speechBand);
    assert.ok(Math.abs(kept - 1) < 0.01, `3 kHz came through at ${kept}`);
  });

  test(`${inputRate} → 16000: pushing chunks gives exactly the samples of one push`, () => {
    // Two tones and a ramp, so a dropped or repeated sample changes the result.
    const input = tone(440, inputRate, inputRate / 2);
    const second = tone(2500, inputRate, input.length, 0.2);
    for (let i = 0; i < input.length; i += 1) input[i] += second[i] + i / input.length / 10;
    const oneShot = new StreamResampler(inputRate).push(input);
    assert.ok(oneShot.length > 7900);
    for (const sizes of [[1], [2], [127], [480], [4096], [1, 5000, 3, 77, 1024]]) {
      assert.deepEqual(resampleInChunks(input, inputRate, sizes), oneShot, `chunks of ${sizes.join(', ')}`);
    }
  });
}

test('a push smaller than the filter returns nothing and loses nothing', () => {
  const input = tone(440, 48000, 4800);
  const resampler = new StreamResampler(48000);
  assert.equal(resampler.push(new Float32Array(0)).length, 0);
  assert.equal(resampler.push(input.subarray(0, 20)).length, 0);
  const rest = resampler.push(input.subarray(20));
  assert.deepEqual(rest, new StreamResampler(48000).push(input));
});

test('16000 → 16000 passes the samples through', () => {
  const input = tone(440, 16000, 16000);
  const out = new StreamResampler(16000).push(input);
  assert.ok(input.length - out.length <= 13);
  for (let i = 0; i < out.length; i += 1) assert.ok(Math.abs(out[i] - input[i]) < 1e-6, `sample ${i}`);
});

test('the output rate is a parameter', () => {
  const out = new StreamResampler(48000, 8000).push(tone(440, 48000, 48000));
  assert.ok(8000 - out.length >= 0 && 8000 - out.length <= 13, `${out.length} samples`);
  assert.ok(Math.abs(cycles(out) / (out.length / 8000) - 440) < 1);
});

// --- fitAudioClock ---------------------------------------------------------------------

const clockPairs = (count: number, atMs: (seconds: number) => number, sampleRate = 48000): AudioClockPair[] =>
  Array.from({ length: count }, (_, index) => ({ frames: index * sampleRate, sampleRate, atMs: atMs(index) }));

test('fitAudioClock without pairs assumes audio second 0 is session 0 at the nominal rate', () => {
  const toSession = fitAudioClock([]);
  assert.equal(toSession(0), 0);
  assert.equal(toSession(12.5), 12500);
});

test('fitAudioClock with one pair takes the offset from it and the nominal rate', () => {
  const toSession = fitAudioClock([{ frames: 96000, sampleRate: 48000, atMs: 7000 }]);
  assert.equal(toSession(2), 7000);
  assert.equal(toSession(0), 5000);
  assert.equal(toSession(3.5), 8500);
});

test('fitAudioClock recovers a known offset and rate drift, also outside the pairs', () => {
  // The render clock of #16538: 270 ppm slow, recording started 4.2 s into the session.
  const truth = (seconds: number) => 4200 + seconds * 1000 * (1 - 270e-6);
  const toSession = fitAudioClock(clockPairs(60, truth));
  for (const seconds of [0, 0.5, 31.25, 59, 600, 3600]) {
    assert.ok(Math.abs(toSession(seconds) - truth(seconds)) < 1e-6, `${seconds} s → ${toSession(seconds)}, expected ${truth(seconds)}`);
  }
  assert.ok(Math.abs(toSession(3600) - (4200 + 3_600_000)) > 900, 'frames / sampleRate would be 972 ms off after an hour');
});

test('fitAudioClock reads frames at the sample rate of each pair', () => {
  const truth = (seconds: number) => 1000 + seconds * 1001;
  const pairs: AudioClockPair[] = [
    { frames: 0, sampleRate: 48000, atMs: truth(0) },
    { frames: 44100 * 10, sampleRate: 44100, atMs: truth(10) },
    { frames: 16000 * 20, sampleRate: 16000, atMs: truth(20) },
  ];
  assert.ok(Math.abs(fitAudioClock(pairs)(15) - truth(15)) < 1e-6);
});

test('fitAudioClock averages jitter in the pairs instead of following one of them', () => {
  const truth = (seconds: number) => 250 + seconds * 999.8;
  const jitter = [3, -2, 1, -3, 2, -1];
  const toSession = fitAudioClock(clockPairs(120, (seconds) => truth(seconds) + jitter[seconds % jitter.length]));
  for (const seconds of [0, 60, 119]) assert.ok(Math.abs(toSession(seconds) - truth(seconds)) < 0.5, `${seconds} s is ${toSession(seconds) - truth(seconds)} ms off`);
});

test('fitAudioClock with pairs at one audio position keeps the nominal rate', () => {
  const pair = { frames: 48000, sampleRate: 48000, atMs: 3000 };
  const toSession = fitAudioClock([pair, { ...pair, atMs: 3010 }]);
  assert.equal(toSession(1), 3005);
  assert.equal(toSession(2), 4005);
});
