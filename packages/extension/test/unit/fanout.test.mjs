import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanOut } from '../../src/offscreen/fanout.js';

test('a throwing or rejecting consumer is reported and the others still receive the item', async () => {
  const got = [];
  const errors = [];
  const consumers = new Set([
    () => {
      throw new Error('transcriber crashed');
    },
    async () => {
      throw new Error('socket closed');
    },
    (item) => got.push(item),
  ]);
  fanOut(consumers, 'chunk-1', (err) => errors.push(err.message));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, ['chunk-1']);
  assert.deepEqual(errors.sort(), ['socket closed', 'transcriber crashed']);
});
