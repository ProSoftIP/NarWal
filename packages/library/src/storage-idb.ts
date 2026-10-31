// IndexedDB LibraryStorage for the extension origin.
//
// The library has its own database. The recorder's database (`narwal`, board
// #16542) holds raw capture chunks and has its own version number; sharing one
// database would make two packages race on `onupgradeneeded`.
//
// Stores:
//   meta        key 'meta'            StorageMeta
//   recordings  keyPath 'id'          LibraryRecord
//   files       key [id, path]        Uint8Array
//
// IndexedDB layout changes go through LIBRARY_DB_VERSION here; changes to the
// record shape go through STORAGE_VERSION and the migrations in library.ts.

import { NarwalError } from './errors.ts';
import { conflictError } from './storage.ts';
import type { LibraryRecord, LibraryStorage, RecordChange, StorageMeta, StoredRecording } from './storage.ts';

export const LIBRARY_DB_NAME = 'narwal-library';
export const LIBRARY_DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// A full disk or an exhausted origin quota reaches the caller as one typed error.
function storageError(error: DOMException | null): Error {
  if (error?.name === 'QuotaExceededError') {
    return new NarwalError('storage-full', 'There is not enough storage space for this recording. Nothing was saved.');
  }
  return error ?? new DOMException('Transaction aborted', 'AbortError');
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(storageError(tx.error));
    tx.onerror = () => {}; // onabort follows with the same error.
  });
}

/**
 * Reads one record and decides the write in the same transaction. `decide`
 * runs in the request's success event, while the transaction is still
 * active, so nothing can write between the read and the write. A throw from
 * `decide` aborts the transaction and reaches the caller.
 */
async function readThenWrite<T>(
  tx: IDBTransaction,
  id: string,
  decide: (current: LibraryRecord | undefined) => T,
): Promise<T> {
  const finished = done(tx);
  let result: { value: T } | undefined;
  let failure: { error: unknown } | undefined;
  const read = tx.objectStore('recordings').get(id);
  read.onsuccess = () => {
    try {
      result = { value: decide(read.result as LibraryRecord | undefined) };
    } catch (error) {
      failure = { error };
      tx.abort();
    }
  };
  try {
    await finished;
  } catch (error) {
    throw failure ? failure.error : error;
  }
  if (!result) throw new Error('IndexedDB transaction finished without reading');
  return result.value;
}

export class IdbLibraryStorage implements LibraryStorage {
  #db: IDBDatabase;
  #keyRange: typeof IDBKeyRange;

  constructor(db: IDBDatabase, keyRange: typeof IDBKeyRange) {
    this.#db = db;
    this.#keyRange = keyRange;
  }

  static open(
    factory: IDBFactory = globalThis.indexedDB,
    keyRange: typeof IDBKeyRange = globalThis.IDBKeyRange,
  ): Promise<IdbLibraryStorage> {
    return new Promise((resolve, reject) => {
      const req = factory.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      // Another open page holds an older layout; the upgrade waits for it.
      req.onblocked = () => reject(new DOMException('Close other NarWal pages, then try again', 'AbortError'));
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer extension page upgrade the database instead of blocking it.
        db.onversionchange = () => db.close();
        resolve(new IdbLibraryStorage(db, keyRange));
      };
      req.onerror = () => reject(req.error);
    });
  }

  close(): void {
    this.#db.close();
  }

  // Every key of one recording sorts between [id] and [id, []]: IndexedDB
  // orders arrays after strings, and a shorter prefix first.
  #filesOf(id: string): IDBKeyRange {
    return this.#keyRange.bound([id], [id, []]);
  }

  async readMeta(): Promise<StorageMeta | undefined> {
    return request(this.#db.transaction('meta').objectStore('meta').get('meta'));
  }

  async writeMeta(meta: StorageMeta): Promise<void> {
    const tx = this.#db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta, 'meta');
    await done(tx);
  }

  async listRecords(): Promise<LibraryRecord[]> {
    return request(this.#db.transaction('recordings').objectStore('recordings').getAll());
  }

  async getRecord(id: string): Promise<LibraryRecord | undefined> {
    return request(this.#db.transaction('recordings').objectStore('recordings').get(id));
  }

  async readRecording(id: string): Promise<StoredRecording | undefined> {
    // One transaction: the three reads see the same committed state.
    const tx = this.#db.transaction(['recordings', 'files']);
    const files = tx.objectStore('files');
    const [record, keys, values] = await Promise.all([
      request(tx.objectStore('recordings').get(id) as IDBRequest<LibraryRecord | undefined>),
      request(files.getAllKeys(this.#filesOf(id))),
      request(files.getAll(this.#filesOf(id)) as IDBRequest<Uint8Array[]>),
    ]);
    if (!record) return undefined;
    const tree = new Map<string, Uint8Array>();
    keys.forEach((key, index) => tree.set((key as [string, string])[1], values[index] as Uint8Array));
    return { record, files: tree };
  }

  async addRecording(record: LibraryRecord, files: ReadonlyMap<string, Uint8Array>): Promise<LibraryRecord> {
    const tx = this.#db.transaction(['recordings', 'files'], 'readwrite');
    const stored = { ...record, revision: 1 };
    // `add`, not `put`: an existing ID fails the transaction.
    tx.objectStore('recordings').add(stored);
    const store = tx.objectStore('files');
    for (const [path, bytes] of files) store.put(bytes, [record.id, path]);
    await done(tx);
    return stored;
  }

  async replaceRecording(
    record: LibraryRecord,
    files: ReadonlyMap<string, Uint8Array>,
    expectedRevision: number,
  ): Promise<LibraryRecord> {
    const tx = this.#db.transaction(['recordings', 'files'], 'readwrite');
    return readThenWrite(tx, record.id, (current) => {
      if (current?.revision !== expectedRevision) throw conflictError(record.id, expectedRevision, current?.revision);
      const stored = { ...record, revision: current.revision + 1 };
      const store = tx.objectStore('files');
      store.delete(this.#filesOf(record.id));
      for (const [path, bytes] of files) store.put(bytes, [record.id, path]);
      tx.objectStore('recordings').put(stored);
      return stored;
    });
  }

  async updateRecord(id: string, change: RecordChange): Promise<LibraryRecord | undefined> {
    const tx = this.#db.transaction('recordings', 'readwrite');
    return readThenWrite(tx, id, (current) => {
      const next = change(current && structuredClone(current));
      if (next === null) return current;
      if (!current) throw new Error(`No recording ${id}`);
      const stored = { ...next, id, revision: current.revision + 1 };
      tx.objectStore('recordings').put(stored);
      return stored;
    });
  }

  async readFile(id: string, path: string): Promise<Uint8Array | undefined> {
    return request(this.#db.transaction('files').objectStore('files').get([id, path]));
  }

  async removeRecording(id: string, expectedRevision: number): Promise<void> {
    const tx = this.#db.transaction(['recordings', 'files'], 'readwrite');
    await readThenWrite(tx, id, (current) => {
      if (!current) return;
      if (current.revision !== expectedRevision) throw conflictError(id, expectedRevision, current.revision);
      tx.objectStore('files').delete(this.#filesOf(id));
      tx.objectStore('recordings').delete(id);
    });
  }
}
