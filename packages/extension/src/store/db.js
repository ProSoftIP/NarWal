// Durable local store for recordings (IndexedDB, extension origin). Shared by
// the offscreen recorder (writes), the service worker (recovery) and the
// extension pages (reopen). Every chunk is its own transaction, so a failed
// write never removes chunks that were already saved.
//
// Stores:
//   recordings  { id, format, status, tabId, startedAt, stoppedAt, stopReason, ... }
//               status: 'recording' | 'stopped' | 'interrupted'
//   chunks      key [recordingId, stream, seq]
//               stream 'events': { entries[], startAt, endAt, count, bytes }
//               stream 'audio':  { data: Blob (Opus WebM), segment, startAt, endAt, bytes, mime }
//               stream 'transcript': { entry: {type:'segment', segment} | {type:'gap', gap} }
//                 one live final line or gap, saved as it arrives (board #16570)
//               stream 'history' seq 0: { history }
//                 the recording's TranscriptHistory (transcription/src/revisions.ts):
//                 immutable revisions, the active one, user edits; bundle schema §8
//               stream 'final-checkpoint' seq 0: { checkpoint }
//                 an unfinished after-recording pass on this computer (board #16603)
// Times are wall-clock milliseconds (shared/clock.js).
import { createTranscriptHistory, RevisionConflict } from '../../../transcription/src/revisions.ts';

export const DB_NAME = 'narwal';
export const DB_VERSION = 1;
// Local storage format. The portable bundle (board #16541) is produced from
// this by export (board #16548); the store itself is not the bundle.
export const FORMAT = 'narwal-local/1';
export const STREAMS = ['events', 'audio'];
// Derived text, not capture: kept apart from STREAMS so they take no part in
// recovery gaps.
export const TRANSCRIPT_STREAM = 'transcript';
export const HISTORY_STREAM = 'history';
export const FINAL_CHECKPOINT_STREAM = 'final-checkpoint';

export function openDb(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recordingId', 'stream', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** True for errors that mean the disk or the origin's quota is full. */
export function isQuotaError(err) {
  if (!err) return false;
  if (err.name === 'QuotaExceededError') return true;
  return err.name === 'UnknownError' && /quota|space|disk/i.test(String(err.message));
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => {}; // onabort follows with the same error.
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Every key of one recording sorts between [id] and [id, []]: IndexedDB
// orders arrays after numbers and strings, and a shorter prefix first.
const recordingRange = (id) => IDBKeyRange.bound([id], [id, []]);
const streamRange = (id, stream) => IDBKeyRange.bound([id, stream], [id, stream, []]);

export async function putRecording(db, meta) {
  const tx = db.transaction('recordings', 'readwrite');
  tx.objectStore('recordings').put(meta);
  await done(tx);
}

export async function updateRecording(db, id, patch) {
  const tx = db.transaction('recordings', 'readwrite');
  const os = tx.objectStore('recordings');
  const current = await request(os.get(id));
  const next = { ...(current || { id }), ...patch };
  os.put(next);
  await done(tx);
  return next;
}

export async function getRecording(db, id) {
  return request(db.transaction('recordings').objectStore('recordings').get(id));
}

export async function listRecordings(db) {
  const all = await request(db.transaction('recordings').objectStore('recordings').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function putChunk(db, chunk) {
  if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST && globalThis.__narwalFailWrites) {
    throw new DOMException('Simulated full disk (test hook)', 'QuotaExceededError');
  }
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put(chunk);
  await done(tx);
}

export async function readChunks(db, recordingId, stream) {
  const range = stream ? streamRange(recordingId, stream) : recordingRange(recordingId);
  return request(db.transaction('chunks').objectStore('chunks').getAll(range));
}

async function lastChunk(db, recordingId, stream) {
  const cursor = await request(db.transaction('chunks').objectStore('chunks').openCursor(streamRange(recordingId, stream), 'prev'));
  return cursor ? cursor.value : null;
}

/** Next free sequence number per stream, so a resumed recorder appends. */
export async function nextSeq(db, recordingId) {
  const out = {};
  for (const stream of STREAMS) {
    const last = await lastChunk(db, recordingId, stream);
    out[stream] = last ? last.seq + 1 : 0;
  }
  return out;
}

/** End time of the newest saved chunk in any stream, or null. */
export async function lastPersistedAt(db, recordingId) {
  let at = null;
  for (const stream of STREAMS) {
    const last = await lastChunk(db, recordingId, stream);
    if (last && (at === null || last.endAt > at)) at = last.endAt;
  }
  return at;
}

/** Next free sequence number of one stream. */
export async function nextStreamSeq(db, recordingId, stream) {
  const last = await lastChunk(db, recordingId, stream);
  return last ? last.seq + 1 : 0;
}

export async function putTranscriptEntry(db, recordingId, seq, entry) {
  await putChunk(db, { recordingId, stream: TRANSCRIPT_STREAM, seq, entry });
}

export async function readTranscriptEntries(db, recordingId) {
  return (await readChunks(db, recordingId, TRANSCRIPT_STREAM)).map((chunk) => chunk.entry);
}

const historyKey = (recordingId) => [recordingId, HISTORY_STREAM, 0];

/** The recording's transcript history, or an empty one. */
export async function readTranscriptHistory(db, recordingId) {
  const record = await request(db.transaction('chunks').objectStore('chunks').get(historyKey(recordingId)));
  return record ? record.history : createTranscriptHistory(recordingId);
}

/**
 * Saves the history if nobody changed it since `expectedVersion` was read.
 * Otherwise RevisionConflict 'stale-version' (TranscriptHistoryStore.write).
 */
export async function writeTranscriptHistory(db, recordingId, next, expectedVersion) {
  const tx = db.transaction('chunks', 'readwrite');
  const os = tx.objectStore('chunks');
  const record = await request(os.get(historyKey(recordingId)));
  const version = record ? record.history.version : 0;
  if (version !== expectedVersion) {
    tx.abort();
    throw new RevisionConflict('stale-version', `History is at version ${version}; the change was made against ${expectedVersion}`);
  }
  os.put({ recordingId, stream: HISTORY_STREAM, seq: 0, history: next });
  await done(tx);
}

/**
 * Applies `change` (history -> new history, synchronous and pure) to the
 * newest saved history, again if another writer got there first.
 */
export async function updateTranscriptHistory(db, recordingId, change) {
  for (let attempt = 1; ; attempt += 1) {
    const current = await readTranscriptHistory(db, recordingId);
    const next = change(current);
    if (next === current) return current;
    try {
      await writeTranscriptHistory(db, recordingId, next, current.version);
      return next;
    } catch (err) {
      if (!(err instanceof RevisionConflict && err.reason === 'stale-version') || attempt >= 5) throw err;
    }
  }
}

/** The TranscriptHistoryStore of one recording (transcription/src/revisions.ts). */
export function transcriptHistoryStore(db, recordingId) {
  return {
    read: () => readTranscriptHistory(db, recordingId),
    write: (next, expectedVersion) => writeTranscriptHistory(db, recordingId, next, expectedVersion),
  };
}

const checkpointKey = (recordingId) => [recordingId, FINAL_CHECKPOINT_STREAM, 0];

/** The unfinished after-recording pass of a recording, or null. */
export async function readFinalCheckpoint(db, recordingId) {
  const record = await request(db.transaction('chunks').objectStore('chunks').get(checkpointKey(recordingId)));
  return record ? record.checkpoint : null;
}

export async function writeFinalCheckpoint(db, recordingId, checkpoint) {
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put({ recordingId, stream: FINAL_CHECKPOINT_STREAM, seq: 0, checkpoint });
  await done(tx);
}

export async function clearFinalCheckpoint(db, recordingId) {
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').delete(checkpointKey(recordingId));
  await done(tx);
}


/**
 * Removes a recording for good (board #17003): every chunk of every stream
 * and its entry in `recordings`, in one transaction, so a failure leaves the
 * recording whole. Not recoverable. Returns false when there was nothing.
 */
export async function deleteRecording(db, id) {
  const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
  const found = request(tx.objectStore('recordings').count(id));
  tx.objectStore('chunks').delete(recordingRange(id));
  tx.objectStore('recordings').delete(id);
  await done(tx);
  return (await found) > 0;
}

/** Bytes of one saved chunk: the size written with it, else the audio Blob's. */
function chunkBytes(chunk) {
  if (Number.isFinite(chunk.bytes)) return chunk.bytes;
  if (chunk.data && Number.isFinite(chunk.data.size)) return chunk.data.size;
  return 0;
}

/**
 * Bytes saved per recording, from the sizes written with its page events and
 * audio (board #17003). Transcript lines and history are text and not counted.
 * Returns { total, byId: Map<id, bytes> }.
 */
export async function savedBytes(db) {
  const byId = new Map();
  let total = 0;
  await new Promise((resolve, reject) => {
    const req = db.transaction('chunks').objectStore('chunks').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const n = chunkBytes(cursor.value);
      if (n) {
        byId.set(cursor.value.recordingId, (byId.get(cursor.value.recordingId) || 0) + n);
        total += n;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { total, byId };
}
