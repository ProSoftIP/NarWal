// Seeks on the known-timing bundle: the right page at the right offset before
// and after the navigation, the narration at the right media time, and every
// missing stretch shown as a gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memorySource } from '../../bundle/src/memory-source.ts';
import type { RrwebLine } from '../../bundle/src/types.ts';
import { validateBundle } from '../../bundle/src/validate.ts';
import { loadReplay } from '../src/load.ts';
import { AUDIO_SYNC_TOLERANCE_MS, CLICK_HOLD_MS, PAGE_TOLERANCE_MS, buildReplayModel, parseRrwebStream, stateAt, type ReplayModel } from '../src/model.ts';
import { D2_SNAPSHOT_MS, DURATION_MS, MIC_LOSS, NAVIGATION_MS, PAUSE, expectedTick, knownTimingFiles, trueSessionMs } from './known-timing.ts';

/** The `#tick` text rrweb shows after replaying `page` up to `offsetMs`. */
function tickShown(model: ReplayModel, docKey: string, offsetMs: number): string | null {
  const page = model.pages.get(docKey)!;
  const base = page.events[0]!.timestamp;
  let text: string | null = null;
  for (const e of page.events) {
    if (e.timestamp - base > offsetMs) break;
    const data = e.data as any;
    if (e.type === 2) text = JSON.stringify(data.node).match(/"id":9,"textContent":"([^"]+)"/)?.[1] ?? null;
    if (e.type === 3 && data.source === 0) for (const t of data.texts ?? []) if (t.id === 9) text = t.value;
  }
  return text;
}

const loaded = await loadReplay(knownTimingFiles());
const model = loaded.model;
const noPage = (t: number) => stateAt(model, t).gaps.filter((g) => g.effect === 'no-page').map((g) => g.reason);

/** Media time of `t` with no jitter, from the fixture's own truth. */
function trueMediaSec(t: number): number {
  let lo = 0;
  let hi = 40000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (trueSessionMs(mid) < t) lo = mid;
    else hi = mid;
  }
  return lo / 1000;
}

test('the bundle loads with one span per page and the navigation between them', () => {
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(model.spans, [
    { docKey: 'd1', fromMs: 0, toMs: NAVIGATION_MS },
    { docKey: 'd2', fromMs: NAVIGATION_MS, toMs: DURATION_MS },
  ]);
  assert.ok(loaded.audio && loaded.audio.length > 1000);
});

test(`every seek shows the page state of that instant to within ${PAGE_TOLERANCE_MS} ms, before and after the navigation`, () => {
  const times: number[] = [];
  for (let s = 0; s < DURATION_MS / 1000; s++) times.push(s * 1000 - PAGE_TOLERANCE_MS, s * 1000 + PAGE_TOLERANCE_MS, s * 1000 + 500);
  times.push(DURATION_MS);
  let checked = 0;
  for (const t of times.filter((x) => x >= 0)) {
    const state = stateAt(model, t);
    if (!state.page) continue;
    const doc = t < NAVIGATION_MS ? 'd1' : 'd2';
    assert.equal(state.page.docKey, doc, `t=${t}`);
    // The last instant shows the final state.
    const expected = expectedTick(Math.min(t, DURATION_MS - 1));
    assert.equal(tickShown(model, doc, state.page.offsetMs), expected, `t=${t}`);
    checked++;
  }
  assert.ok(checked > 70, `checked ${checked}`);
});

test('the navigation blind window and the pause hide the page and say why', () => {
  assert.deepEqual(noPage(NAVIGATION_MS + 1), ['navigation-blind-window']);
  assert.equal(stateAt(model, NAVIGATION_MS + 30).page, null);
  assert.equal(stateAt(model, NAVIGATION_MS - 1).page?.docKey, 'd1');
  assert.equal(stateAt(model, D2_SNAPSHOT_MS).page?.docKey, 'd2');
  assert.deepEqual(noPage(PAUSE.startMs + 500), ['recorder-paused']);
  assert.equal(stateAt(model, PAUSE.startMs + 500).page, null);
  assert.equal(stateAt(model, PAUSE.startMs + 500).audio, null);
  assert.equal(tickShown(model, 'd2', stateAt(model, PAUSE.endMs).page!.offsetMs), expectedTick(PAUSE.endMs));
  assert.equal(stateAt(model, PAUSE.startMs - 1).page?.docKey, 'd2');
});

test('the lost microphone silences narration and the transcript but not the page', () => {
  const state = stateAt(model, MIC_LOSS.startMs + 700);
  assert.equal(state.page?.docKey, 'd2');
  assert.equal(state.audio, null);
  assert.deepEqual(
    state.gaps.map((g) => [g.effect, g.reason]),
    [
      ['no-audio', 'mic-track-ended'],
      ['no-transcript', 'not-transcribed'],
    ],
  );
});

test(`narration seeks land within ${AUDIO_SYNC_TOLERANCE_MS} ms of the true media time, across both audio jumps`, () => {
  let worst = 0;
  for (let t = 200; t < DURATION_MS; t += 100) {
    const state = stateAt(model, t);
    const inLoss = [PAUSE, MIC_LOSS].some((l) => t >= l.startMs && t < l.endMs);
    if (inLoss) {
      assert.equal(state.audio, null, `t=${t}`);
      continue;
    }
    const nearJump = [PAUSE, MIC_LOSS].some((l) => Math.abs(t - l.endMs) < AUDIO_SYNC_TOLERANCE_MS);
    if (nearJump) continue;
    assert.ok(state.audio, `t=${t} has no audio`);
    worst = Math.max(worst, Math.abs(state.audio.mediaSec - trueMediaSec(t)) * 1000);
  }
  assert.ok(worst < AUDIO_SYNC_TOLERANCE_MS, `worst ${worst} ms`);
});

test('transcript seeks use the active revision with corrections applied', () => {
  assert.equal(model.transcript?.provider, 'openai');
  assert.equal(stateAt(model, 1999).utterance, -1);
  assert.equal(stateAt(model, 2000).utterance, 0);
  const u = model.utterances[stateAt(model, 15000).utterance]!;
  assert.equal(u.text, 'the next page after the navigation');
  assert.equal(u.heard, 'the second page after the navigation');
  assert.equal(u.corrected, true);
  assert.equal(stateAt(model, 16000).utterance, -1);
  assert.equal(model.utterances[stateAt(model, 26500).utterance]!.segmentId, 's3');
});

test('markers show on their page at their time and nowhere else', () => {
  const ids = (t: number) => stateAt(model, t).markers.map((m) => `${m.kind}:${m.id}`);
  assert.deepEqual(ids(4999), []);
  assert.deepEqual(ids(5000), ['click:o4']);
  assert.deepEqual(ids(5000 + CLICK_HOLD_MS), []);
  assert.deepEqual(ids(8500), ['element:o5']);
  assert.deepEqual(ids(9600), ['element:o5', 'dwell:o6']);
  assert.deepEqual(ids(15400), ['region:o8']);
  assert.deepEqual(ids(PAUSE.startMs + 10), []);
  assert.deepEqual(stateAt(model, 5000).markers[0]!.point, { x: 400, y: 90 });
  assert.deepEqual(stateAt(model, 8500).notes.map((n) => n.text), ['the marked heading']);
});

test('page time with no snapshot and no recorded reason becomes a derived gap', async () => {
  const result = await validateBundle(memorySource(knownTimingFiles()));
  const streams = new Map<string, RrwebLine[]>([['d2', parseRrwebStream(knownTimingFiles().get('rrweb/d2.jsonl')!)]]);
  const derived = buildReplayModel(result.bundle!, streams);
  const gap = derived.gaps.find((g) => g.derived && g.effect === 'no-page')!;
  assert.deepEqual([gap.startMs, gap.endMs, gap.reason], [0, NAVIGATION_MS, 'no-page-evidence']);
  assert.equal(stateAt(derived, 3000).page, null);
  assert.deepEqual(stateAt(derived, 3000).gaps.map((g) => g.reason), ['no-page-evidence']);
});

test('a page restored from the back-forward cache shows again from its own stream', async () => {
  const result = await validateBundle(memorySource(knownTimingFiles()));
  const bundle = result.bundle!;
  const [d1, d2] = bundle.documents;
  d1!.detachedMs = null;
  d1!.attachments = [
    { atMs: 0, reason: 'boot' },
    { atMs: 25000, reason: 'bfcache-restore' },
  ];
  d2!.detachedMs = 25000;
  const files = knownTimingFiles();
  const streams = new Map(['d1', 'd2'].map((k) => [k, parseRrwebStream(files.get(`rrweb/${k}.jsonl`)!)] as const));
  const restored = buildReplayModel(bundle, streams);
  assert.deepEqual(
    restored.spans.map((s) => [s.docKey, s.fromMs, s.toMs]),
    [
      ['d1', 0, NAVIGATION_MS],
      ['d2', NAVIGATION_MS, 25000],
      ['d1', 25000, DURATION_MS],
    ],
  );
  const state = stateAt(restored, 26000);
  assert.equal(state.page?.docKey, 'd1');
  // d1's last change was before the navigation: the restored page shows that state.
  assert.equal(tickShown(restored, 'd1', state.page!.offsetMs), 'tick 11');
});

test('a bundle without narration says so for its whole length', async () => {
  const { model: silent, audio } = await loadReplay(knownTimingFiles({ noAudio: true }));
  assert.equal(audio, null);
  assert.equal(silent.audio, null);
  assert.equal(stateAt(silent, 5000).audio, null);
  // Recorded audio gaps keep their reason; the rest of the time is "no narration".
  assert.deepEqual(
    silent.gaps.filter((g) => g.effect === 'no-audio').map((g) => [g.reason, g.startMs, g.endMs]),
    [
      ['no-narration', 0, PAUSE.startMs],
      ['recorder-paused', PAUSE.startMs, PAUSE.endMs],
      ['no-narration', PAUSE.endMs, MIC_LOSS.startMs],
      ['mic-track-ended', MIC_LOSS.startMs, MIC_LOSS.endMs],
      ['no-narration', MIC_LOSS.endMs, DURATION_MS],
    ],
  );
});
