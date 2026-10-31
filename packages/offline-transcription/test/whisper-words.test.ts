// Board #16621: words from Whisper word pieces. A piece without a leading space
// continues the word before it, so an amount stays one word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whisperWords } from '../src/engines/whisper-words.ts';

test('pieces without a leading space join the word before them', () => {
  const words = whisperWords([
    { text: ' It', timestamp: [0.1, 0.3] },
    { text: ' cost', timestamp: [0.3, 0.6] },
    { text: ' $123', timestamp: [0.6, 1.2] },
    { text: ',456', timestamp: [1.2, 1.7] },
    { text: '.78.', timestamp: [1.7, 2.1] },
    { text: ' Then', timestamp: [2.5, 2.8] },
  ]);
  assert.deepEqual(words, [
    { text: 'It', start: 0.1, end: 0.3 },
    { text: 'cost', start: 0.3, end: 0.6 },
    { text: '$123,456.78.', start: 0.6, end: 2.1 },
    { text: 'Then', start: 2.5, end: 2.8 },
  ]);
});

test('a first piece without a space starts a word; blank pieces and a missing end are handled', () => {
  assert.deepEqual(
    whisperWords([
      { text: 'Hello', timestamp: [0, 0.4] },
      { text: ' ', timestamp: [0.4, 0.5] },
      { text: ' world', timestamp: [0.6, null] },
    ]),
    [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'world', start: 0.6, end: 0.6 },
    ],
  );
  assert.deepEqual(whisperWords([]), []);
});
