// Unit tests for the scoring of the e2e run (board #16544): e2e/score.mjs.
// `align` counts word errors; `scoreRevision` turns a revision and the
// fixture's reference words into the WER, the word start error and the two
// timing sanity flags the e2e report quotes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as score from '../e2e/score.mjs';

interface ReferenceWord {
  w: string;
  s: number;
  e: number;
}

interface ScoredWord {
  text: string;
  startMs: number;
  endMs: number;
}

interface ScoredSegment {
  startMs: number;
  endMs: number;
  words: ScoredWord[];
}

interface Alignment {
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Matched (reference index, hypothesis index) pairs. */
  pairs: [number, number][];
}

interface Score {
  referenceWords: number;
  hypothesisWords: number;
  wer: number | null;
  substitutions: number;
  deletions: number;
  insertions: number;
  matchedWords: number;
  startBiasMs: number | null;
  startAbsMedianMs: number | null;
  startAbsP90Ms: number | null;
  startsWithin250Ms: number | null;
  wordsMonotonic: boolean;
  wordsInsideSegments: boolean;
}

// score.mjs is plain JavaScript: its JSDoc makes `range` a required `any` for
// `tsc`. These are the signatures the e2e run uses.
const align = score.align as (reference: string[], hypothesis: string[]) => Alignment;
const scoreRevision = score.scoreRevision as (reference: ReferenceWord[], revision: { segments: ScoredSegment[] }, range?: { startMs: number; endMs: number }) => Score;

/** Reference words 400 ms long, one every 500 ms from `fromS`. */
function reference(text: string, fromS = 0): ReferenceWord[] {
  return text.split(' ').map((w, index) => ({ w, s: fromS + index * 0.5, e: fromS + index * 0.5 + 0.4 }));
}

/** Hypothesis words on the same grid, each start moved by `shiftMs` (one value, or one per word). */
function words(text: string, shiftMs: number | number[] = 0, fromMs = 0): ScoredWord[] {
  return text.split(' ').map((word, index) => {
    const shift = typeof shiftMs === 'number' ? shiftMs : shiftMs[index];
    return { text: word, startMs: fromMs + index * 500 + shift, endMs: fromMs + index * 500 + 400 + shift };
  });
}

/** One segment that spans its words. */
function segment(list: ScoredWord[]): ScoredSegment {
  return { startMs: Math.min(...list.map((word) => word.startMs)), endMs: Math.max(...list.map((word) => word.endMs)), words: list };
}

const revision = (...segments: ScoredSegment[]) => ({ segments });

// --- align ------------------------------------------------------------------------------

test('align: identical words have no errors and pair every index', () => {
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'b', 'c']), {
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    pairs: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
  });
});

test('align: one wrong word is one substitution and is not paired', () => {
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'x', 'c']), {
    substitutions: 1,
    deletions: 0,
    insertions: 0,
    pairs: [
      [0, 0],
      [2, 2],
    ],
  });
});

test('align: one missing word is one deletion; later words pair one index earlier', () => {
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'c']), {
    substitutions: 0,
    deletions: 1,
    insertions: 0,
    pairs: [
      [0, 0],
      [2, 1],
    ],
  });
});

test('align: one extra word is one insertion; later words pair one index later', () => {
  assert.deepEqual(align(['a', 'c'], ['a', 'b', 'c']), {
    substitutions: 0,
    deletions: 0,
    insertions: 1,
    pairs: [
      [0, 0],
      [1, 2],
    ],
  });
});

test('align: an empty hypothesis deletes every word; an empty reference inserts every word', () => {
  assert.deepEqual(align(['a', 'b', 'c'], []), { substitutions: 0, deletions: 3, insertions: 0, pairs: [] });
  assert.deepEqual(align([], ['a', 'b']), { substitutions: 0, deletions: 0, insertions: 2, pairs: [] });
  assert.deepEqual(align([], []), { substitutions: 0, deletions: 0, insertions: 0, pairs: [] });
});

test('align: the error count is the edit distance, not a count per position', () => {
  // A word dropped at the start shifts every index; position-by-position
  // comparison would call this four errors.
  const result = align(['the', 'quick', 'brown', 'fox', 'jumps'], ['quick', 'brown', 'fox', 'jumps']);
  assert.equal(result.substitutions + result.deletions + result.insertions, 1);
  assert.equal(result.deletions, 1);
  assert.deepEqual(result.pairs, [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ]);
});

test('align: one substitution, one deletion and one insertion in one sentence', () => {
  const result = align(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'x', 'c', 'e', 'f', 'g']);
  assert.deepEqual([result.substitutions, result.deletions, result.insertions], [1, 1, 1]);
  assert.deepEqual(result.pairs, [
    [0, 0],
    [2, 2],
    [4, 3],
    [5, 4],
  ]);
});

// --- scoreRevision: word errors --------------------------------------------------------------

test('identical text scores WER 0 with every word matched', () => {
  const text = 'open the settings page now';
  assert.deepEqual(scoreRevision(reference(text), revision(segment(words(text)))), {
    referenceWords: 5,
    hypothesisWords: 5,
    wer: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    matchedWords: 5,
    startBiasMs: 0,
    startAbsMedianMs: 0,
    startAbsP90Ms: 0,
    startsWithin250Ms: 1,
    wordsMonotonic: true,
    wordsInsideSegments: true,
  });
});

test('case and punctuation are not errors; an apostrophe is part of the word', () => {
  const score = scoreRevision(reference("Open the settings, don't stop."), revision(segment(words("open THE settings don't stop"))));
  assert.equal(score.wer, 0);
  assert.equal(score.matchedWords, 5);
  const wrong = scoreRevision(reference("we don't stop"), revision(segment(words('we dont stop'))));
  assert.equal(wrong.substitutions, 1);
});

test('one substitution in four words is WER 0.25', () => {
  const score = scoreRevision(reference('open the settings page'), revision(segment(words('open the sittings page'))));
  assert.deepEqual([score.substitutions, score.deletions, score.insertions], [1, 0, 0]);
  assert.equal(score.wer, 0.25);
  assert.equal(score.matchedWords, 3);
  assert.equal(score.referenceWords, 4);
  assert.equal(score.hypothesisWords, 4);
});

test('one deletion in four words is WER 0.25 and the later words still match', () => {
  const hypothesis = words('open the settings page').filter((word) => word.text !== 'the');
  const score = scoreRevision(reference('open the settings page'), revision(segment(hypothesis)));
  assert.deepEqual([score.substitutions, score.deletions, score.insertions], [0, 1, 0]);
  assert.equal(score.wer, 0.25);
  assert.equal(score.matchedWords, 3);
  assert.equal(score.hypothesisWords, 3);
  assert.equal(score.startAbsP90Ms, 0, 'the words after the gap are compared with their own reference word');
});

test('one insertion against three reference words is WER 0.333', () => {
  const hypothesis = [...words('open the'), { text: 'big', startMs: 900, endMs: 990 }, ...words('settings', 0, 1000)];
  const score = scoreRevision(reference('open the settings'), revision(segment(hypothesis)));
  assert.deepEqual([score.substitutions, score.deletions, score.insertions], [0, 0, 1]);
  assert.equal(score.wer, 0.333);
  assert.equal(score.matchedWords, 3);
  assert.equal(score.hypothesisWords, 4);
});

test('WER is counted against the reference length and can pass 1', () => {
  const score = scoreRevision(reference('yes'), revision(segment(words('no no no'))));
  assert.equal(score.wer, 3);
  assert.equal(score.matchedWords, 0);
  assert.equal(score.startBiasMs, null, 'no matched word, no start error');
  assert.equal(score.startsWithin250Ms, null);
});

test('an empty revision deletes every reference word', () => {
  const score = scoreRevision(reference('open the settings'), revision());
  assert.equal(score.wer, 1);
  assert.equal(score.deletions, 3);
  assert.equal(score.hypothesisWords, 0);
  assert.equal(score.wordsMonotonic, true);
  assert.equal(score.wordsInsideSegments, true);
});

test('with no reference words the WER is null, not 0', () => {
  const score = scoreRevision([], revision(segment(words('open the settings'))));
  assert.equal(score.wer, null);
  assert.equal(score.referenceWords, 0);
  assert.equal(score.insertions, 3);
});

test('words are scored across segments in order', () => {
  const score = scoreRevision(reference('open the settings page now'), revision(segment(words('open the')), segment(words('settings page now', 0, 1000))));
  assert.equal(score.wer, 0);
  assert.equal(score.matchedWords, 5);
});

test('a hypothesis word that holds two words counts as two, both at its start time', () => {
  const score = scoreRevision(reference('open the settings'), revision(segment([{ text: 'open the', startMs: 0, endMs: 900 }, ...words('settings', 0, 1000)])));
  assert.equal(score.hypothesisWords, 3);
  assert.equal(score.wer, 0);
  assert.equal(score.startAbsP90Ms, 500, '"the" starts at 500 ms in the reference and is reported at 0');
});

// --- scoreRevision: start error ----------------------------------------------------------------

test('a constant +120 ms shift is a 120 ms bias, median and p90, all within 250 ms', () => {
  const text = 'open the settings page now';
  const score = scoreRevision(reference(text), revision(segment(words(text, 120))));
  assert.equal(score.wer, 0);
  assert.equal(score.startBiasMs, 120);
  assert.equal(score.startAbsMedianMs, 120);
  assert.equal(score.startAbsP90Ms, 120);
  assert.equal(score.startsWithin250Ms, 1);
});

test('a constant early shift has a negative bias and a positive absolute error', () => {
  const text = 'open the settings page now';
  const score = scoreRevision(reference(text), revision(segment(words(text, -300))));
  assert.equal(score.startBiasMs, -300);
  assert.equal(score.startAbsMedianMs, 300);
  assert.equal(score.startAbsP90Ms, 300);
  assert.equal(score.startsWithin250Ms, 0);
});

test('250 ms counts as within 250 ms; 251 ms does not', () => {
  const score = scoreRevision(reference('a b c d'), revision(segment(words('a b c d', [250, -250, 251, -251]))));
  assert.equal(score.startsWithin250Ms, 0.5);
});

test('mixed start errors: bias is the signed median, p90 the worst of ten', () => {
  const text = 'one two three four five six seven eight nine ten';
  const shifts = [-40, -30, -20, -10, 0, 10, 20, 30, 40, 400];
  const score = scoreRevision(reference(text), revision(segment(words(text, shifts))));
  assert.equal(score.wer, 0);
  assert.equal(score.startBiasMs, 10, 'upper median of the ten signed errors');
  assert.equal(score.startAbsMedianMs, 30, 'sorted absolute errors: 0 10 10 20 20 30 30 40 40 400');
  assert.equal(score.startAbsP90Ms, 400);
  assert.equal(score.startsWithin250Ms, 0.9);
});

test('errors that cancel out leave a zero bias but a non-zero absolute error', () => {
  const text = 'a b c d e';
  const score = scoreRevision(reference(text), revision(segment(words(text, [-200, -100, 0, 100, 200]))));
  assert.equal(score.startBiasMs, 0);
  assert.equal(score.startAbsMedianMs, 100);
  assert.equal(score.startAbsP90Ms, 200);
});

test('only matched words give a start error', () => {
  // The substituted word is 900 ms off; it must not enter the statistics.
  const hypothesis = words('open the sittings page', [50, 50, 900, 50]);
  const score = scoreRevision(reference('open the settings page'), revision(segment(hypothesis)));
  assert.equal(score.matchedWords, 3);
  assert.equal(score.startAbsP90Ms, 50);
  assert.equal(score.startsWithin250Ms, 1);
});

test('reference seconds and revision milliseconds are compared on one clock', () => {
  const score = scoreRevision([{ w: 'hello', s: 12.34, e: 12.8 }], revision(segment([{ text: 'hello', startMs: 12_400, endMs: 12_800 }])));
  assert.equal(score.startBiasMs, 60);
});

// --- scoreRevision: range ----------------------------------------------------------------------

const firstHalf = 'open the settings'; // 0 .. 1.4 s
const secondHalf = 'close this window'; // 5 .. 6.4 s
const twoParts = [...reference(firstHalf), ...reference(secondHalf, 5)];
const halfWrong = revision(segment(words(firstHalf)), segment(words('lose his widow', 0, 5000)));

test('without a range the whole reference is scored', () => {
  const score = scoreRevision(twoParts, halfWrong);
  assert.equal(score.referenceWords, 6);
  assert.equal(score.wer, 0.5);
});

test('a range scores only the reference and hypothesis words inside it', () => {
  const first = scoreRevision(twoParts, halfWrong, { startMs: 0, endMs: 2000 });
  assert.equal(first.referenceWords, 3);
  assert.equal(first.hypothesisWords, 3);
  assert.equal(first.wer, 0);

  const second = scoreRevision(twoParts, halfWrong, { startMs: 5000, endMs: 7000 });
  assert.equal(second.referenceWords, 3);
  assert.equal(second.hypothesisWords, 3);
  assert.equal(second.wer, 1);
  assert.equal(second.substitutions, 3);
});

test('a range with no speech has no reference words and a null WER', () => {
  const score = scoreRevision(twoParts, halfWrong, { startMs: 2000, endMs: 5000 });
  assert.equal(score.referenceWords, 0);
  assert.equal(score.hypothesisWords, 0);
  assert.equal(score.wer, null);
});

test('a reference word cut by the range edge is left out; a hypothesis word that overlaps the range stays', () => {
  // "settings" is 1.0 .. 1.4 s; the range ends at 1.2 s.
  const score = scoreRevision(reference(firstHalf), revision(segment(words(firstHalf))), { startMs: 0, endMs: 1200 });
  assert.equal(score.referenceWords, 2);
  assert.equal(score.hypothesisWords, 3);
  assert.equal(score.insertions, 1);
  assert.equal(score.wer, 0.5);
});

test('a reference word that ends exactly at the range end is inside; a hypothesis word that starts there is not', () => {
  // "the" is 0.5 .. 0.9 s; "settings" starts at 1.0 s.
  const score = scoreRevision(reference(firstHalf), revision(segment(words(firstHalf))), { startMs: 0, endMs: 1000 });
  assert.equal(score.referenceWords, 2);
  assert.equal(score.hypothesisWords, 2);
  assert.equal(score.wer, 0);
});

// --- scoreRevision: timing flags -----------------------------------------------------------------

test('words in time order inside their segment set both flags', () => {
  const score = scoreRevision(reference(firstHalf), revision(segment(words(firstHalf))));
  assert.equal(score.wordsMonotonic, true);
  assert.equal(score.wordsInsideSegments, true);
});

test('a word that starts before the word in front of it clears wordsMonotonic only', () => {
  const list = words(firstHalf);
  list[2] = { ...list[2], startMs: 300, endMs: 1400 };
  const score = scoreRevision(reference(firstHalf), revision({ startMs: 0, endMs: 1400, words: list }));
  assert.equal(score.wordsMonotonic, false);
  assert.equal(score.wordsInsideSegments, true);
});

test('a word that ends before it starts clears wordsMonotonic', () => {
  const list = words(firstHalf);
  list[1] = { ...list[1], startMs: 700, endMs: 600 };
  const score = scoreRevision(reference(firstHalf), revision({ startMs: 0, endMs: 1400, words: list }));
  assert.equal(score.wordsMonotonic, false);
  assert.equal(score.wordsInsideSegments, true);
});

test('two words with the same start time are still monotonic', () => {
  const list = words(firstHalf);
  list[1] = { ...list[1], startMs: list[0].startMs };
  const score = scoreRevision(reference(firstHalf), revision({ startMs: 0, endMs: 1400, words: list }));
  assert.equal(score.wordsMonotonic, true);
});

test('a word that ends after its segment clears wordsInsideSegments only', () => {
  const list = words(firstHalf);
  const score = scoreRevision(reference(firstHalf), revision({ startMs: 0, endMs: 1300, words: list }));
  assert.equal(score.wordsInsideSegments, false);
  assert.equal(score.wordsMonotonic, true);
});

test('a word that starts before its segment clears both flags', () => {
  const list = words(firstHalf);
  const score = scoreRevision(reference(firstHalf), revision({ startMs: 100, endMs: 1400, words: list }));
  assert.equal(score.wordsInsideSegments, false);
  assert.equal(score.wordsMonotonic, false, 'the first word is compared with the segment start');
});

test('the flags are checked per segment: a later segment may not hide a bad one', () => {
  const good = segment(words(firstHalf));
  const bad = { startMs: 5000, endMs: 5200, words: words(secondHalf, 0, 5000) };
  assert.equal(scoreRevision(twoParts, revision(bad, good)).wordsInsideSegments, false);
  assert.equal(scoreRevision(twoParts, revision(good, bad)).wordsInsideSegments, false);
});

test('the flags cover the whole revision, also with a range', () => {
  const bad = { startMs: 5000, endMs: 5200, words: words(secondHalf, 0, 5000) };
  const score = scoreRevision(twoParts, revision(segment(words(firstHalf)), bad), { startMs: 0, endMs: 2000 });
  assert.equal(score.wer, 0);
  assert.equal(score.wordsInsideSegments, false);
});
