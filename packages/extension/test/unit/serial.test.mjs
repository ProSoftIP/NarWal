import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerial } from '../../src/sw/serial.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a second job waits until the first has finished', async () => {
  const serial = createSerial();
  const log = [];
  let release;
  const first = serial(async () => {
    log.push('first:start');
    await new Promise((r) => (release = r));
    log.push('first:end');
    return 1;
  });
  const second = serial(async () => {
    log.push('second:start');
    return 2;
  });
  await tick();
  assert.deepEqual(log, ['first:start']);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(log, ['first:start', 'first:end', 'second:start']);
});

test('a job that throws rejects its own caller and the next job still runs', async () => {
  const serial = createSerial();
  const failed = serial(async () => {
    throw new Error('boom');
  });
  const next = serial(() => 'ran');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ran');
});

test('a job that throws synchronously is also contained', async () => {
  const serial = createSerial();
  const failed = serial(() => {
    throw new Error('sync boom');
  });
  await assert.rejects(failed, /sync boom/);
  assert.equal(await serial(() => 'ran'), 'ran');
});
