// Board #27484: Saved recordings hands a picked .narwal.zip to the replay
// page through IndexedDB. The replay page takes it once; a second take, or a
// take with nothing handed over, finds nothing. Runs on fake-indexeddb.
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_REPLAY_URL, handOver, onFileDrop, takeHandedOver } from '../../src/ui/shared-file.js';

const fileOf = (name, bytes) => ({ name, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test('a handed-over file is taken once, with its name and bytes', async () => {
  const idb = new IDBFactory();
  await handOver(fileOf('Dashboard review.narwal.zip', [80, 75, 3, 4, 9]), idb);
  const taken = await takeHandedOver(idb);
  assert.equal(taken.fileName, 'Dashboard review.narwal.zip');
  assert.ok(taken.bytes instanceof Uint8Array);
  assert.deepEqual([...taken.bytes], [80, 75, 3, 4, 9]);
  assert.equal(await takeHandedOver(idb), null);
});

test('nothing handed over: the take is null', async () => {
  assert.equal(await takeHandedOver(new IDBFactory()), null);
});

test('a newer pick replaces one that was never taken', async () => {
  const idb = new IDBFactory();
  await handOver(fileOf('first.narwal.zip', [1]), idb);
  await handOver(fileOf('second.narwal.zip', [2, 2]), idb);
  const taken = await takeHandedOver(idb);
  assert.equal(taken.fileName, 'second.narwal.zip');
  assert.deepEqual([...taken.bytes], [2, 2]);
});

test('the replay page that takes it is asked with ?shared=1', () => {
  assert.equal(SHARED_REPLAY_URL, 'replay.html?shared=1');
});

function dropTarget() {
  const handlers = {};
  return { handlers, addEventListener: (type, fn) => { handlers[type] = fn; } };
}

function dragEvent(types, files = []) {
  const event = { prevented: false, dataTransfer: { types, files, dropEffect: 'none' } };
  event.preventDefault = () => { event.prevented = true; };
  return event;
}

test('a dropped file is opened here, not shown by the browser', () => {
  const target = dropTarget();
  const opened = [];
  onFileDrop(target, (file) => opened.push(file));
  const file = { name: 'shared.narwal.zip' };
  const over = dragEvent(['Files']);
  target.handlers.dragover(over);
  assert.equal(over.prevented, true);
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  const drop = dragEvent(['Files'], [file]);
  target.handlers.drop(drop);
  assert.equal(drop.prevented, true);
  assert.deepEqual(opened, [file]);
});

test('a drag of text or a link is left to the browser', () => {
  const target = dropTarget();
  const opened = [];
  onFileDrop(target, (file) => opened.push(file));
  const over = dragEvent(['text/plain']);
  target.handlers.dragover(over);
  const drop = dragEvent(['text/uri-list']);
  target.handlers.drop(drop);
  assert.equal(over.prevented, false);
  assert.equal(drop.prevented, false);
  assert.deepEqual(opened, []);
});
