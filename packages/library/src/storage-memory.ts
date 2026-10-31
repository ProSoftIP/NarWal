// In-memory LibraryStorage. Values are copied in and out, as IndexedDB does,
// so a caller cannot change stored data through a reference it kept. Each
// method does its read and write with no `await` between them, so it is one
// step, as an IndexedDB transaction is.

import { conflictError } from './storage.ts';
import type { LibraryRecord, LibraryStorage, RecordChange, StorageMeta, StoredRecording } from './storage.ts';

function copyFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const copy = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) copy.set(path, bytes.slice());
  return copy;
}

export class MemoryLibraryStorage implements LibraryStorage {
  #meta: StorageMeta | undefined;
  #records = new Map<string, LibraryRecord>();
  #files = new Map<string, Map<string, Uint8Array>>();

  async readMeta(): Promise<StorageMeta | undefined> {
    return this.#meta && structuredClone(this.#meta);
  }

  async writeMeta(meta: StorageMeta): Promise<void> {
    this.#meta = structuredClone(meta);
  }

  async listRecords(): Promise<LibraryRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async getRecord(id: string): Promise<LibraryRecord | undefined> {
    const record = this.#records.get(id);
    return record && structuredClone(record);
  }

  async readRecording(id: string): Promise<StoredRecording | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    return { record: structuredClone(record), files: copyFiles(this.#files.get(id) ?? new Map()) };
  }

  async addRecording(record: LibraryRecord, files: ReadonlyMap<string, Uint8Array>): Promise<LibraryRecord> {
    if (this.#records.has(record.id)) throw new Error(`Recording ${record.id} already exists`);
    const stored = structuredClone({ ...record, revision: 1 });
    this.#records.set(record.id, stored);
    this.#files.set(record.id, copyFiles(files));
    return structuredClone(stored);
  }

  async replaceRecording(
    record: LibraryRecord,
    files: ReadonlyMap<string, Uint8Array>,
    expectedRevision: number,
  ): Promise<LibraryRecord> {
    const current = this.#records.get(record.id);
    if (current?.revision !== expectedRevision) throw conflictError(record.id, expectedRevision, current?.revision);
    const stored = structuredClone({ ...record, revision: current.revision + 1 });
    this.#records.set(record.id, stored);
    this.#files.set(record.id, copyFiles(files));
    return structuredClone(stored);
  }

  async updateRecord(id: string, change: RecordChange): Promise<LibraryRecord | undefined> {
    const current = this.#records.get(id);
    const next = change(current && structuredClone(current));
    if (next === null) return current && structuredClone(current);
    if (!current) throw new Error(`No recording ${id}`);
    const stored = structuredClone({ ...next, id, revision: current.revision + 1 });
    this.#records.set(id, stored);
    return structuredClone(stored);
  }

  async readFile(id: string, path: string): Promise<Uint8Array | undefined> {
    return this.#files.get(id)?.get(path)?.slice();
  }

  async removeRecording(id: string, expectedRevision: number): Promise<void> {
    const current = this.#records.get(id);
    if (!current) return;
    if (current.revision !== expectedRevision) throw conflictError(id, expectedRevision, current.revision);
    this.#records.delete(id);
    this.#files.delete(id);
  }
}
