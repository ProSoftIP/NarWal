// Microphone level for the test bar and the strip's meter (board #16785).
// Pure: the callers read samples from an AnalyserNode and pass them here.

/** Below this RMS (about -50 dBFS) the microphone counts as silent. */
export const HEARD_RMS = 0.003;
/** While testing: no sound for this long says "No sound from …". */
export const TEST_QUIET_MS = 3000;
/** While recording: no sound at all in the first this-many ms says so on the strip. */
export const RECORDING_QUIET_MS = 10000;

const FLOOR_DB = -60;

/**
 * RMS and peak of one block of time-domain samples (-1..1).
 * @param {ArrayLike<number>} samples
 */
export function measureLevel(samples) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak };
}

/** The meter's fill, 0..1, for an RMS: -60 dBFS and below is empty, 0 dBFS full. */
export function meterValue(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/** The meter's fill at which the microphone counts as hearing sound. */
export const HEARD_LEVEL = meterValue(HEARD_RMS);

/**
 * Watches levels over time.
 *   heard     some sound since the watch started
 *   quietMs   how long since the last sound (or since the start)
 *   silent    the test bar's "No sound": quiet for TEST_QUIET_MS
 *   neverHeard  the strip's "No microphone sound": nothing in the first RECORDING_QUIET_MS
 * @param {number} startAt  ms
 * @param {{quietMs?: number, firstMs?: number}} [limits]
 */
export function createSilenceWatch(startAt, { quietMs = TEST_QUIET_MS, firstMs = RECORDING_QUIET_MS } = {}) {
  let heard = false;
  let lastSound = startAt;
  let lastAt = startAt;
  let level = 0;
  return {
    /** @param {number} rms @param {number} at ms */
    feed(rms, at) {
      lastAt = at;
      level = meterValue(rms);
      if (rms >= HEARD_RMS) {
        heard = true;
        lastSound = at;
      }
      return this.state();
    },
    state() {
      const quiet = lastAt - lastSound;
      return {
        level,
        heard,
        quietMs: quiet,
        silent: quiet >= quietMs,
        neverHeard: !heard && lastAt - startAt >= firstMs,
      };
    },
  };
}
