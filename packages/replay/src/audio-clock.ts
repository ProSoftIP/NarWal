// Places narration audio on the session clock (docs/bundle-schema.md §6.3).
// Audio time is never frames / sampleRate on the session clock: the render
// clock drifted −270 ppm against the page clock in #16538. A line fitted
// through the (frames, atMs) pairs maps media time to session time.
//
// The schema fits one line. A reader that finds the pairs jump (the recorder
// lost audio and the frame count no longer matches elapsed time) fits one
// line per continuous run instead, so a single jump does not skew the whole
// recording. All runs share one slope. With no jump this is exactly the
// schema's one line.

import type { ClockPair } from '../../bundle/src/types.ts';

/**
 * Two neighbouring pairs whose session-time step differs from their audio
 * step by more than this start a new run. #16538: fit residual max 52 ms, so
 * 250 ms is noise-proof and still far below a real audio loss (a 1 s chunk).
 */
export const CLOCK_BREAK_MS = 250;

/** One straight stretch: session ms = interceptMs + slope × (media seconds × 1000). */
export interface ClockRun {
  /** Media time (seconds into the audio file) where this run starts and ends. */
  fromSec: number;
  toSec: number;
  /** Session time at fromSec and toSec. */
  fromMs: number;
  toMs: number;
  slope: number;
  interceptMs: number;
}

export interface AudioClock {
  runs: ClockRun[];
  /** Session ms of a media time, or null outside every run. */
  sessionAt(mediaSec: number): number | null;
  /** Media seconds of a session time, or null where the file holds no audio. */
  mediaAt(sessionMs: number): number | null;
}

/**
 * One slope for all runs (the drift belongs to the device clock, not to a run)
 * and one intercept per run: pooled least squares. A short run after a jump
 * then cannot get a wild slope from two jittery pairs.
 */
function fit(groups: { x: number; y: number }[][]): { slope: number; intercepts: number[] } {
  const means = groups.map((g) => ({
    x: g.reduce((sum, p) => sum + p.x, 0) / g.length,
    y: g.reduce((sum, p) => sum + p.y, 0) / g.length,
  }));
  let sxx = 0;
  let sxy = 0;
  groups.forEach((g, i) => {
    const m = means[i]!;
    for (const p of g) {
      sxx += (p.x - m.x) * (p.x - m.x);
      sxy += (p.x - m.x) * (p.y - m.y);
    }
  });
  const slope = sxx === 0 ? 1 : sxy / sxx;
  return { slope, intercepts: means.map((m) => m.y - slope * m.x) };
}

/**
 * Builds the clock from the bundle's pairs. `startMs` is the manifest's
 * session time of the first decoded sample; `decodedMs` its decoded length.
 * Media time 0 is the first sample; the first run starts there and the last
 * run ends at the decoded length.
 *
 * Pairs are sparse (one per audio chunk), so where in the media a jump
 * happened is placed with the bundle's audio gaps: a gap that ends between the
 * two runs marks where the later run starts.
 */
export function audioClock(
  pairs: readonly ClockPair[],
  startMs: number,
  decodedMs: number,
  audioGaps: readonly { startMs: number; endMs: number }[] = [],
): AudioClock {
  const points = pairs.map((p) => ({ x: (p.frames / p.sampleRate) * 1000, y: p.atMs }));
  const groups: { x: number; y: number }[][] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1];
    if (!prev || Math.abs(p.y - prev.y - (p.x - prev.x)) > CLOCK_BREAK_MS) groups.push([]);
    groups[groups.length - 1]!.push(p);
  }
  const endX = Math.max(decodedMs, points.length ? points[points.length - 1]!.x : 0);
  if (groups.length === 0) groups.push([{ x: 0, y: startMs }]);
  // The first run also passes through (0, startMs): the manifest says where sample 0 is.
  groups[0]!.unshift({ x: 0, y: startMs });

  const { slope, intercepts } = fit(groups);
  // Media time where each run after the first starts.
  const starts = groups.map((group, i) => {
    if (i === 0) return 0;
    const prev = groups[i - 1]!;
    const lastX = prev[prev.length - 1]!.x;
    const intercept = intercepts[i]!;
    const gap = audioGaps.find((g) => g.endMs >= prev[prev.length - 1]!.y && g.endMs <= group[0]!.y);
    if (!gap) return group[0]!.x;
    return Math.min(Math.max((gap.endMs - intercept) / slope, lastX), group[0]!.x);
  });

  const runs: ClockRun[] = groups.map((_, i) => {
    const intercept = intercepts[i]!;
    const fromX = starts[i]!;
    const toX = i + 1 < groups.length ? starts[i + 1]! : endX;
    return {
      fromSec: fromX / 1000,
      toSec: toX / 1000,
      fromMs: intercept + slope * fromX,
      toMs: intercept + slope * toX,
      slope,
      interceptMs: intercept,
    };
  });

  return {
    runs,
    sessionAt(mediaSec) {
      const run = runs.find((r) => mediaSec >= r.fromSec && mediaSec <= r.toSec);
      return run ? run.interceptMs + run.slope * mediaSec * 1000 : null;
    },
    mediaAt(sessionMs) {
      const run = runs.find((r) => sessionMs >= r.fromMs && sessionMs < r.toMs);
      return run ? (sessionMs - run.interceptMs) / run.slope / 1000 : null;
    },
  };
}
