// Board #27487: which gaps the "Missing evidence" list shows. A derived
// no-page gap under a second at the start, the end or a page change is the
// page loading and is left out; every other gap is listed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTLE_GAP_MS, listedGaps, type PageSpan, type ReplayGap, type ReplayModel } from '../src/model.ts';

const DURATION_MS = 360977.7;

// The page spans of rec_229eafb1: three pages, each loading for a few ms.
const SPANS: PageSpan[] = [
  { docKey: 'd1', fromMs: 85.4, toMs: 83353.6 },
  { docKey: 'd2', fromMs: 83371.5, toMs: 166879.6 },
  { docKey: 'd3', fromMs: 166898.8, toMs: 360597.5 },
];

function noPage(startMs: number, endMs: number, derived = true, reason = 'no-page-evidence'): ReplayGap {
  return { id: derived ? null : 'g1', scope: 'page', reason, startMs, endMs, effect: 'no-page', derived };
}

function modelOf(gaps: ReplayGap[], spans: PageSpan[] = SPANS): ReplayModel {
  return { durationMs: DURATION_MS, spans, gaps } as unknown as ReplayModel;
}

const listed = (gaps: ReplayGap[], spans?: PageSpan[]) => listedGaps(modelOf(gaps, spans)).map((g) => [g.startMs, g.endMs]);

test('NO: the four page-loading gaps of rec_229eafb1 list zero rows', () => {
  const gaps = [noPage(0, 85.4), noPage(83353.6, 83371.5), noPage(166879.6, 166898.8), noPage(360597.5, DURATION_MS)];
  assert.deepEqual(listed(gaps), []);
  assert.equal(modelOf(gaps).gaps.length, 4, 'the model keeps them for the timeline and the stage');
});

test('NO: a page loading after it attached, before its first snapshot, is not listed', () => {
  assert.deepEqual(listed([noPage(83353.6, 83700)]), []);
});

test('YES: a page-change gap of a second or longer is listed', () => {
  assert.deepEqual(listed([noPage(83353.6, 83353.6 + SETTLE_GAP_MS)]), [[83353.6, 84353.6]]);
  assert.deepEqual(listed([noPage(0, 2500)]), [[0, 2500]]);
  assert.deepEqual(listed([noPage(DURATION_MS - 1200, DURATION_MS)]), [[DURATION_MS - 1200, DURATION_MS]]);
});

test('YES: a short gap mid-page is listed', () => {
  assert.deepEqual(listed([noPage(40000, 40300)]), [[40000, 40300]]);
});

test('YES: a short page that never had a snapshot is listed', () => {
  const spans = [...SPANS.slice(0, 1), { docKey: 'redirect', fromMs: 83353.6, toMs: 83600 }, { docKey: 'd2', fromMs: 83600, toMs: 166879.6 }];
  assert.deepEqual(listed([noPage(83353.6, 83600)], spans), [[83353.6, 83600]]);
});

test('YES: a recorded gap is listed however short, and so is every other effect', () => {
  const recorded = noPage(83353.6, 83371.5, false, 'navigation-blind-window');
  const audio: ReplayGap = { id: null, scope: 'audio', reason: 'no-narration', startMs: 0, endMs: 85.4, effect: 'no-audio', derived: true };
  assert.deepEqual(listed([recorded, audio]), [
    [83353.6, 83371.5],
    [0, 85.4],
  ]);
});
