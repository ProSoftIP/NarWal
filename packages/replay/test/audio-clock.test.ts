import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_BREAK_MS, audioClock } from '../src/audio-clock.ts';
import { AUDIO_SYNC_TOLERANCE_MS } from '../src/model.ts';
import { AUDIO_START_MS, DECODED_MS, MIC_LOSS, PAUSE, clockPairs, trueSessionMs } from './known-timing.ts';

const pairs = () => clockPairs() as { frames: number; sampleRate: number; atMs: number }[];

test('the fit recovers −270 ppm drift through ±25 ms jitter to within the sync tolerance', () => {
  const clock = audioClock(pairs(), AUDIO_START_MS, DECODED_MS, [PAUSE, MIC_LOSS]);
  assert.equal(clock.runs.length, 3);
  for (const run of clock.runs) assert.ok(Math.abs(run.slope - (1 + 270e-6)) < 0.001, `slope ${run.slope}`);
  let worst = 0;
  // Where in the media a jump happened is known only to within the fit error.
  const nearJump = (t: number) => [PAUSE, MIC_LOSS].some((l) => Math.abs(t - l.endMs) < AUDIO_SYNC_TOLERANCE_MS);
  for (let mediaMs = 0; mediaMs <= DECODED_MS; mediaMs += 50) {
    if (nearJump(trueSessionMs(mediaMs))) continue;
    const at = clock.sessionAt(mediaMs / 1000);
    assert.notEqual(at, null, `media ${mediaMs} ms has no session time`);
    worst = Math.max(worst, Math.abs(at! - trueSessionMs(mediaMs)));
    const back = clock.mediaAt(trueSessionMs(mediaMs));
    if (back !== null) assert.ok(Math.abs(back * 1000 - mediaMs) < AUDIO_SYNC_TOLERANCE_MS);
  }
  assert.ok(worst < AUDIO_SYNC_TOLERANCE_MS, `worst error ${worst} ms`);
});

test('session time with no audio maps to no media time', () => {
  const clock = audioClock(pairs(), AUDIO_START_MS, DECODED_MS, [PAUSE, MIC_LOSS]);
  for (const t of [0, 50, PAUSE.startMs + 100, 20500, PAUSE.endMs - 100, MIC_LOSS.startMs + 100, 25000, MIC_LOSS.endMs - 100]) {
    assert.equal(clock.mediaAt(t), null, `t=${t}`);
  }
  for (const t of [AUDIO_START_MS + 10, PAUSE.startMs - 100, PAUSE.endMs + 100, MIC_LOSS.endMs + 100, 29900]) {
    assert.notEqual(clock.mediaAt(t), null, `t=${t}`);
  }
});

test('without gaps a jump still splits the runs at the first pair after it', () => {
  const clock = audioClock(pairs(), AUDIO_START_MS, DECODED_MS);
  assert.equal(clock.runs.length, 3);
  const second = clock.runs[1]!;
  assert.equal(second.fromSec % 1, 0, 'starts on a pair');
});

test('pairs with no jump give the one schema line through the first sample', () => {
  const steady = Array.from({ length: 10 }, (_, k) => ({ frames: (k + 1) * 48000, sampleRate: 48000, atMs: 200 + (k + 1) * 1000 * 1.0003 }));
  const clock = audioClock(steady, 200, 10000);
  assert.equal(clock.runs.length, 1);
  assert.ok(Math.abs(clock.sessionAt(0)! - 200) < 0.001);
  assert.ok(Math.abs(clock.sessionAt(10)! - (200 + 10000 * 1.0003)) < 0.001);
  // Jitter below the break threshold never splits.
  const noisy = steady.map((p, k) => ({ ...p, atMs: p.atMs + (k % 2 ? CLOCK_BREAK_MS - 10 : 0) / 2 }));
  assert.equal(audioClock(noisy, 200, 10000).runs.length, 1);
});

test('a reader does not assume the sample rate', () => {
  const at44 = Array.from({ length: 5 }, (_, k) => ({ frames: (k + 1) * 44100, sampleRate: 44100, atMs: 1000 + (k + 1) * 1000 }));
  const clock = audioClock(at44, 1000, 5000);
  assert.ok(Math.abs(clock.mediaAt(3500)! - 2.5) < 1e-9);
});
