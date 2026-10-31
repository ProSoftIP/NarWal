// Tests for the sanity check before a final pass replaces the live text
// (board #16603, review item 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { implausibleFinal, longestLoop, wordsOf } from '../src/plausible.ts';

const LIVE = 'this is a now wall test recording for the team i am reading a fixed passage so every speech model can be scored against the same words';
const GOOD = "This is a Narwhal test recording for the team. I'm reading a fixed passage so every speech model can be scored against the same words.";

test('words: punctuation, hyphens and dashes split words', () => {
  assert.deepEqual(wordsOf("I'm here — 15000-15000, ok."), ["i'm", 'here', '15000', '15000', 'ok']);
  assert.deepEqual(wordsOf('  ...  '), []);
});

test('a good final text replaces the live one', () => {
  assert.equal(implausibleFinal(GOOD, LIVE), null);
  assert.equal(implausibleFinal(GOOD, null), null);
});

test('no words: the live text stays', () => {
  assert.equal(implausibleFinal('', LIVE)?.code, 'empty');
  assert.equal(implausibleFinal(' . , ', null)?.code, 'empty');
});

test('a loop: the live text stays', () => {
  // Moonshine on the whole 113 s passage in one call (#16603 measurements).
  const loop = Array.from({ length: 60 }, () => '15000').join('-');
  const out = implausibleFinal(`The total of ${loop}`, LIVE);
  assert.equal(out?.code, 'repetition');
  assert.match(out!.message, /repeats one phrase 60 times/);
  assert.doesNotMatch(out!.message, /15000/);
  // A phrase loop, the usual Whisper hallucination.
  assert.equal(implausibleFinal(`${GOOD} ${'thank you for watching '.repeat(6)}`, LIVE)?.code, 'repetition');
});

test('speech that repeats a little is not a loop', () => {
  assert.equal(implausibleFinal(`No, no, no, no. ${GOOD} Very very very good.`, LIVE), null);
  assert.equal(longestLoop(wordsOf('no no no no')).repeats, 4);
});

test('far fewer words than the live text: the live text stays', () => {
  const out = implausibleFinal('This is a Narwhal test recording.', LIVE);
  assert.equal(out?.code, 'too-few-words');
  assert.match(out!.message, /6 words where the live one has 27/);
  // Too little live text to compare: allowed.
  assert.equal(implausibleFinal('Hello.', 'hello there my friend'), null);
});
