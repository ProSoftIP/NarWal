// Board #16608: words from a Parakeet TDT result. Tokens join into words at a
// leading space; an amount after a word is a word of its own; a word's last
// token may not claim a long pause as speech.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sherpaWords } from '../src/engines/sherpa-words.ts';

test('tokens with a leading space start words; the rest continue them', () => {
  const words = sherpaWords({
    tokens: [' The', ' qu', 'ick', ' fox', '.'],
    timestamps: [0.08, 0.32, 0.48, 0.8, 1.04],
    durations: [0.16, 0.16, 0.24, 0.24, 0.08],
  });
  assert.deepEqual(words, [
    { text: 'The', start: 0.08, end: 0.24 },
    { text: 'quick', start: 0.32, end: 0.72 },
    { text: 'fox.', start: 0.8, end: 1.12 },
  ]);
});

test('an amount written against the word before it is a word of its own', () => {
  const words = sherpaWords({ tokens: [' of', '$', '1', '2', '3', ' each'], timestamps: [0, 0.16, 0.24, 0.32, 0.4, 0.64], durations: [0.08, 0.08, 0.08, 0.08, 0.08, 0.16] });
  assert.deepEqual(
    words.map((word) => word.text),
    ['of', '$123', 'each'],
  );
  assert.equal(words[1].start, 0.16);
});

test('a duration over a pause is cut to 0.4 s; missing times fall back to the word before', () => {
  const words = sherpaWords({ tokens: [' yes', ' no'], timestamps: [0.5], durations: [3] });
  assert.deepEqual(words, [
    { text: 'yes', start: 0.5, end: 0.9 },
    { text: 'no', start: 0.9, end: 0.9 },
  ]);
  assert.deepEqual(sherpaWords({}), []);
  assert.deepEqual(sherpaWords({ tokens: [' ', ''], timestamps: [0, 0.1] }), []);
});
