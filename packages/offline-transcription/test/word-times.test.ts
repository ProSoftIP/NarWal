// Board #16609: word times for a text-only final model (Moonshine), spread
// over the span's speech.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadWords } from '../src/word-times.ts';

const RATE = 16000;

/** A tone over each `[from, to]` second range of a `seconds` long clip. */
function clip(seconds: number, voiced: [number, number][]): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (const [from, to] of voiced) {
    for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return pcm;
}

const near = (actual: number, expected: number, tolerance = 0.021) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('no words, no times', () => {
  assert.deepEqual(spreadWords([], clip(1, [[0, 1]])), []);
});

test('leading and trailing silence hold no word', () => {
  const times = spreadWords(['one', 'two'], clip(2, [[0.4, 1.6]]));
  near(times[0].start, 0.4);
  near(times[1].end, 1.6);
});

test('each word gets speech time in proportion to its characters', () => {
  const times = spreadWords(['ab', 'abcdef'], clip(1, [[0, 0.8]]));
  near(times[0].start, 0);
  near(times[0].end, 0.2);
  near(times[1].start, 0.2);
  near(times[1].end, 0.8);
});

test('punctuation does not take time; a lone symbol still gets a share', () => {
  const times = spreadWords(['"Yes,"', 'no.', '&'], clip(1, [[0, 0.6]]));
  near(times[0].end - times[0].start, 0.3);
  near(times[1].end - times[1].start, 0.2);
  near(times[2].end - times[2].start, 0.1);
});

test('a long pause inside the span holds no word; a word ends before the pause', () => {
  const times = spreadWords(['aaaa', 'bbbb'], clip(3, [[0, 1], [2, 3]]));
  near(times[0].start, 0);
  near(times[0].end, 1);
  near(times[1].start, 2);
  near(times[1].end, 3);
});

test('a short pause counts as speech', () => {
  const times = spreadWords(['aaaa', 'bbbb'], clip(2.1, [[0, 1], [1.1, 2.1]]));
  near(times[0].end, 1.05);
  near(times[1].start, 1.05);
});

test('times are in order, do not overlap and stay inside the clip', () => {
  const words = 'the quick brown fox jumps over the lazy dog again and again'.split(' ');
  const times = spreadWords(words, clip(5, [[0.3, 1.2], [1.9, 2.4], [3, 4.6]]));
  assert.equal(times.length, words.length);
  let previous = 0;
  for (const time of times) {
    assert.ok(time.start >= previous && time.end > time.start && time.end <= 5, JSON.stringify(times));
    previous = time.end;
  }
});

test('a clip with no voiced audio spreads the words over all of it', () => {
  const times = spreadWords(['a', 'b'], new Float32Array(RATE));
  near(times[0].start, 0);
  near(times[0].end, 0.5);
  near(times[1].end, 1);
});
