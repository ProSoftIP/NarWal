// Board #17003: deleting a recording removes every chunk and its entry, and
// nothing of any other recording; the space counted for the popup drops by
// what it held. Runs on fake-indexeddb.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../src/store/db.js';
import { bytesText, recordingsBytes } from '../../src/store/usage.js';

let n = 0;
async function freshDb() {
  // One database per test: the store's name is fixed, so each gets its own factory.
  n += 1;
  return store.openDb(new IDBFactory());
}

async function seed(db, id, { events = 2, audio = 1, eventBytes = 1000, audioBytes = 5000 } = {}) {
  await store.putRecording(db, { id, format: store.FORMAT, status: 'stopped', startedAt: 1000 + n, stoppedAt: 61_000 + n });
  for (let seq = 0; seq < events; seq += 1) await store.putChunk(db, { recordingId: id, stream: 'events', seq, entries: [], startAt: seq, endAt: seq + 1, count: 0, bytes: eventBytes });
  for (let seq = 0; seq < audio; seq += 1) await store.putChunk(db, { recordingId: id, stream: 'audio', seq, data: { size: audioBytes }, segment: 0, startAt: seq, endAt: seq + 1, mime: 'audio/webm' });
  await store.putTranscriptEntry(db, id, 0, { type: 'segment', segment: { text: 'hello' } });
  await store.writeFinalCheckpoint(db, id, { at: 1 });
}

const libraryOf = (records) => ({ listRecords: async () => records });

test('delete removes every chunk and the entry of that recording only', async () => {
  const db = await freshDb();
  await seed(db, 'a');
  await seed(db, 'b');
  assert.equal(await store.deleteRecording(db, 'a'), true);
  assert.equal(await store.getRecording(db, 'a'), undefined);
  assert.deepEqual(await store.readChunks(db, 'a'), []);
  assert.equal(await store.readFinalCheckpoint(db, 'a'), null);
  assert.equal((await store.listRecordings(db)).length, 1);
  // Must-say-NO twin: the other recording keeps every chunk.
  assert.ok(await store.getRecording(db, 'b'));
  assert.equal((await store.readChunks(db, 'b')).length, 5);
  assert.equal((await store.readChunks(db, 'b', 'audio')).length, 1);
});

test('a recording whose id starts like another one is not deleted with it', async () => {
  const db = await freshDb();
  await seed(db, 'rec-1');
  await seed(db, 'rec-10');
  await store.deleteRecording(db, 'rec-1');
  assert.equal((await store.readChunks(db, 'rec-10')).length, 5);
});

test('deleting a recording that is not there says so and changes nothing', async () => {
  const db = await freshDb();
  await seed(db, 'a');
  assert.equal(await store.deleteRecording(db, 'missing'), false);
  assert.equal((await store.readChunks(db, 'a')).length, 5);
});

test('the space counted drops by what the deleted recording held', async () => {
  const db = await freshDb();
  await seed(db, 'a', { events: 3, eventBytes: 2000, audio: 2, audioBytes: 10_000 });
  await seed(db, 'b');
  const library = libraryOf([{ bytes: 40_000 }, { bytes: 500 }]);
  const before = await recordingsBytes({ db, storage: library });
  assert.equal(before, 3 * 2000 + 2 * 10_000 + (2 * 1000 + 5000) + 40_500);
  const { byId } = await store.savedBytes(db);
  assert.equal(byId.get('a'), 26_000);
  await store.deleteRecording(db, 'a');
  const after = await recordingsBytes({ db, storage: library });
  assert.equal(before - after, 26_000);
  // Must-say-NO twin: nothing deleted, nothing freed.
  await store.deleteRecording(db, 'a');
  assert.equal(await recordingsBytes({ db, storage: library }), after);
});

test('space is said in plain units', () => {
  assert.equal(bytesText(0), 'nothing');
  assert.equal(bytesText(NaN), 'nothing');
  assert.equal(bytesText(512), '512 bytes');
  assert.equal(bytesText(12_300), '12 KB');
  assert.equal(bytesText(4_250_000), '4.3 MB');
  assert.equal(bytesText(48_400_000), '48 MB');
  assert.equal(bytesText(1_900_000_000), '1.9 GB');
});
