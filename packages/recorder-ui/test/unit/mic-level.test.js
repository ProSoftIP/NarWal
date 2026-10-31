import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARD_LEVEL, HEARD_RMS, RECORDING_QUIET_MS, TEST_QUIET_MS, createSilenceWatch, measureLevel, meterValue } from '../../src/mic-level.js';

const tone = (amplitude, n = 1024) => Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((i / n) * 2 * Math.PI * 8));

test('level of a block: RMS and peak; silence is zero (board #16785)', () => {
  assert.deepEqual(measureLevel(new Float32Array(512)), { rms: 0, peak: 0 });
  assert.deepEqual(measureLevel([]), { rms: 0, peak: 0 });
  const loud = measureLevel(tone(0.5));
  assert.ok(Math.abs(loud.rms - 0.5 / Math.SQRT2) < 0.001, String(loud.rms));
  assert.ok(Math.abs(loud.peak - 0.5) < 0.001, String(loud.peak));
});

test('the meter maps -60..0 dBFS to empty..full', () => {
  assert.equal(meterValue(0), 0);
  assert.equal(meterValue(NaN), 0);
  assert.equal(meterValue(0.0001), 0, '-80 dBFS is empty');
  assert.equal(meterValue(1), 1);
  assert.equal(meterValue(2), 1);
  assert.ok(Math.abs(meterValue(0.1) - 2 / 3) < 1e-9, '-20 dBFS is two thirds');
  assert.ok(HEARD_LEVEL > 0.1 && HEARD_LEVEL < 0.2, String(HEARD_LEVEL));
  assert.equal(meterValue(HEARD_RMS), HEARD_LEVEL);
});

test('test bar: "No sound" after 3 s without sound, cleared by sound', () => {
  const watch = createSilenceWatch(0);
  assert.equal(watch.state().silent, false);
  assert.equal(watch.feed(0.0005, TEST_QUIET_MS - 100).silent, false);
  const quiet = watch.feed(0.0005, TEST_QUIET_MS);
  assert.equal(quiet.silent, true);
  assert.equal(quiet.heard, false);
  const voice = watch.feed(0.05, TEST_QUIET_MS + 100);
  assert.equal(voice.silent, false);
  assert.equal(voice.heard, true);
  assert.ok(voice.level > HEARD_LEVEL);
  assert.equal(watch.feed(0, TEST_QUIET_MS + 100 + TEST_QUIET_MS).silent, true, 'quiet again for 3 s');
});

test('recording: "never heard" only when nothing at all was heard in the first 10 s', () => {
  const flat = createSilenceWatch(1000);
  assert.equal(flat.feed(0, 1000 + RECORDING_QUIET_MS - 1).neverHeard, false);
  assert.equal(flat.feed(0, 1000 + RECORDING_QUIET_MS).neverHeard, true);
  const spoke = createSilenceWatch(0);
  spoke.feed(0.01, 500);
  assert.equal(spoke.feed(0, RECORDING_QUIET_MS * 3).neverHeard, false, 'a pause later is not a dead microphone');
});
