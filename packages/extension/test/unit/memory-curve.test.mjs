// Board #16591: how the soak reads the recorder's memory. The process curve is
// Vosk's WebAssembly memory filling for 10 minutes, then a sawtooth of garbage;
// what is left after a garbage collection is level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEAPS, LIMITS, garbageIsBounded, liveLevelsOff, liveMemory, mappingsOf, ownMB, slope, trend } from '../e2e/memory.mjs';

const validation = (name) => JSON.parse(readFileSync(new URL(`../../../../docs/validation/${name}.json`, import.meta.url), 'utf8'));
const summary = (name) => validation(name).scenarios.soak.summary;
/** Whole extension processes, shared files included: all the runs before #16591 recorded. */
const totals = (name) => summary(name).samples.filter((s) => typeof s.atMin === 'number').map((s) => [s.atMin, s.tree.byType['renderer:extension']]);
const curves = validation('recorder-memory-curves-2026-10-14');

test('slope is the least-squares line', () => {
  assert.equal(slope([[0, 1], [1, 3], [2, 5]]), 2);
  assert.equal(slope([[0, 5], [10, 5], [20, 5]]), 0);
  assert.equal(slope([[3, 7]]), 0);
  assert.equal(slope([[3, 7], [3, 9]]), 0, 'no spread in time');
});

test('trend ignores points outside its minutes and points that are not numbers', () => {
  const t = trend([[0.5, 900], [1, 100], [2, 104], ['after-stop', 20], [3, undefined], [4, 102]], 1);
  assert.deepEqual(t, { points: 3, fromMin: 1, firstMB: 100, lastMB: 102, minMB: 100, maxMB: 104, rangeMB: 4, mbPerMin: 0.43 });
  assert.deepEqual(trend([[1, 100]], 1), { points: 1, fromMin: 1 });
  assert.deepEqual(trend([[0.5, 900], [1, 100], [2, 104], [3, 108], [4, 500]], 1, 3), { points: 3, fromMin: 1, toMin: 3, firstMB: 100, lastMB: 108, minMB: 100, maxMB: 108, rangeMB: 8, mbPerMin: 4 });
  assert.deepEqual(trend([[1, 100], [4, 500]], 1, 3), { points: 1, fromMin: 1, toMin: 3 });
});

test('the first reading, 2.7 MB a minute, was a line from a trough to a peak', () => {
  for (const name of ['soak-30min-2026-10-13', 'soak-30min-2026-10-14']) {
    const points = totals(name);
    const [first, last] = [points.find(([min]) => min >= 1), points.at(-1)];
    assert.ok((last[1] - first[1]) / (last[0] - first[0]) > 2.5, name);
    // After minute 10 it is a sawtooth whose peaks did not rise.
    const [early, late] = [trend(points, 10, 20), trend(points, 20)];
    assert.ok(early.rangeMB >= 25, `${name}: ${JSON.stringify(early)}`);
    assert.ok(late.maxMB - early.maxMB <= 2, `${name}: ${JSON.stringify([early, late])}`);
  }
});

test('a garbage collection at minute 18 left what minute 0.5 held, plus the Vosk memory filled since', () => {
  const { minute05, steps } = curves.collected;
  const [before, after] = [steps[0], steps.at(-1)];
  assert.deepEqual(steps.map((s) => s.step), ['before', ...['service-worker', 'offscreen', 'worklet', 'vosk-worker'].map((name) => `collected ${name}`)]);
  assert.ok(steps.every((s, i) => i === 0 || s.ownMB <= steps[i - 1].ownMB), 'each collection frees memory');
  assert.ok(before.ownMB - after.ownMB > 20);
  assert.ok(Math.abs(after.ownMB - after.voskMemoryMB - (minute05.ownMB - minute05.voskMemoryMB)) <= 1, JSON.stringify({ minute05, after }));
});

test('the curve as shipped climbs less after minute 10 than with either change that was tried', () => {
  const perMin = (name) => trend(curves[name].samples.map(([min, own]) => [min, own]), 10).mbPerMin;
  assert.ok(perMin('natural') < 1);
  assert.ok(perMin('handedBack') > 1.5 && perMin('detached') > 5, JSON.stringify([perMin('handedBack'), perMin('detached')]));
  // Detached chunks left the count of the Vosk worker heap and kept their memory.
  const detached = curves.detached.samples.filter(([min]) => min >= 1);
  assert.ok(trend(detached.map(([min, , , buffers]) => [min, buffers])).rangeMB < 1);
  assert.ok(trend(detached.map(([min, , partitionAlloc]) => [min, partitionAlloc]), 10).mbPerMin > 3.8, 'the audio rate and more');
});

const reading = (atMin, beforeMB, liveMB, collected = HEAPS) => ({ atMin, collected, beforeMB, liveMB });

test('liveMemory reads what is left after each collection and what it freed', () => {
  assert.deepEqual(liveMemory([reading(12, 330, 310), reading(21, 355.5, 312.4), reading(30, 340, 311)]), {
    readings: 3,
    collectedEveryHeap: 3,
    atMin: [12, 21, 30],
    liveMB: [310, 312.4, 311],
    riseMB: 2.4,
    freedMB: [20, 43.1, 29],
    mostFreedMB: 43.1,
  });
  const none = liveMemory([]);
  assert.equal(none.riseMB, null);
  assert.equal(liveLevelsOff(none), false);
});

test('level live memory passes; a leak, garbage that piles up, a missed heap or too few readings do not', () => {
  const level = [reading(12, 330, 310), reading(21, 352, 312), reading(30, 345, 313)];
  assert.equal(liveLevelsOff(liveMemory(level)), true);
  assert.equal(garbageIsBounded(liveMemory(level)), true);

  const leak = [reading(12, 330, 310), reading(21, 340, 313), reading(30, 345, 310 + LIMITS.liveRiseMB + 0.1)];
  assert.equal(liveLevelsOff(liveMemory(leak)), false);
  const piled = [reading(12, 330, 310), reading(21, 310 + LIMITS.freedMB + 0.1, 310), reading(30, 345, 310)];
  assert.equal(liveLevelsOff(liveMemory(piled)), true);
  assert.equal(garbageIsBounded(liveMemory(piled)), false);
  const missed = [reading(12, 330, 310), reading(21, 340, 311, HEAPS.filter((name) => name !== 'service-worker')), reading(30, 345, 310)];
  assert.equal(liveLevelsOff(liveMemory(missed)), false);
  assert.equal(garbageIsBounded(liveMemory(missed)), false);
  assert.equal(liveLevelsOff(liveMemory(level.slice(1))), false);
});

test('the 30-minute soak of this change passes both checks', () => {
  const { minutes, live } = summary('soak-30min-2026-10-14-memory');
  assert.equal(minutes, 30);
  const m = liveMemory(live);
  assert.equal(liveLevelsOff(m), true, JSON.stringify(m));
  assert.equal(garbageIsBounded(m), true, JSON.stringify(m));
});

test('mappingsOf sums PSS by kind of mapping and keeps the largest sandbox mapping', () => {
  const smaps = [
    '7f0000000000-7f0000100000 rw-p 00000000 00:00 0                          [anon:v8-sandbox]',
    'Size:               1024 kB',
    'Pss:                 512 kB',
    'Pss_Dirty:           512 kB',
    '7f0000100000-7f0000200000 rw-p 00000000 00:00 0                          [anon:v8-sandbox]',
    'Pss:                1024 kB',
    '7f0000200000-7f0000300000 rw-p 00000000 00:00 0                          [anon:partition_alloc]',
    'Pss:                2048 kB',
    '7f0000300000-7f0000400000 r-xp 00000000 00:00 0                          [anon:v8]',
    'Pss:                 256 kB',
    '7f0000400000-7f0000500000 rw-p 00000000 00:00 0                          [anon:v8-pointer-table]',
    'Pss:                 256 kB',
    '7f0000500000-7f0000600000 r-xp 00000000 fd:01 123                        /opt/chromium/chrome',
    'Pss:                4096 kB',
    '7f0000600000-7f0000700000 rw-p 00000000 00:00 0 ',
    'Pss:                 102 kB',
    '7ffc00000000-7ffc00021000 rw-p 00000000 00:00 0                          [stack]',
    'Pss:                 103 kB',
  ].join('\n');
  const m = mappingsOf(smaps);
  assert.deepEqual(m, { sandboxMB: 1.5, partitionAllocMB: 2, v8MB: 0.5, fileMB: 4, otherMB: 0.2, largestSandboxMB: 1 });
  assert.equal(ownMB(m), 4.2, 'everything but the shared files');
  assert.deepEqual(mappingsOf(''), { sandboxMB: 0, partitionAllocMB: 0, v8MB: 0, fileMB: 0, otherMB: 0, largestSandboxMB: 0 });
});
