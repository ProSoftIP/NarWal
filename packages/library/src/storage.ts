// What the library needs from a durable store. Two implementations:
// storage-idb.ts (the extension) and storage-memory.ts (tests, previews).

import type { ManifestFile } from './bundle.ts';
import { NarwalError } from './errors.ts';

/** Bump when the shape of `LibraryRecord` or the store layout changes; add a migration in library.ts. */
export const STORAGE_VERSION = 1;

export interface StorageMeta {
  storageVersion: number;
  /** Product version that last wrote the store, for support. */
  writtenBy: string;
  updatedAt: string;
}

export type RecordingOrigin =
  | { kind: 'recorded'; savedAt: string }
  | {
      kind: 'imported';
      importedAt: string;
      /** SHA-256 and size of the archive file the user chose. */
      archiveSha256: string;
      archiveBytes: number;
      /** Base name the user's file had, for display only. */
      fileName: string | null;
    };

export interface HistoryEvent {
  event: 'saved' | 'imported' | 'updated' | 'exported' | 'deleted' | 'restored';
  at: string;
}

export interface LibraryRecord {
  /** Library key. Not the bundle's `recordingId`: two imports may share that. */
  id: string;
  recordingId: string;
  title: string;
  /** Manifest `createdAt`: when the recording was made. */
  createdAt: string;
  durationMs: number;
  /** As written by the producer; never rewritten by the library. */
  schemaVersion: string;
  state: 'complete' | 'recovered';
  /** SHA-256 of `manifest.json`. */
  contentSha256: string;
  /** All file bytes, manifest included. */
  bytes: number;
  /** Manifest `files`, for listing without reading the manifest. */
  files: ManifestFile[];
  origin: RecordingOrigin;
  history: HistoryEvent[];
  addedAt: string;
  updatedAt: string;
  /** Set while the recording is in the trash. */
  deletedAt: string | null;
  /** Counts writes. The store sets it: 1 when added, plus 1 on every change. */
  revision: number;
}

/** One record and all of its files, read at one moment. */
export interface StoredRecording {
  record: LibraryRecord;
  files: Map<string, Uint8Array>;
}

/**
 * Changes one record inside the store's write. Runs synchronously; `current`
 * is the record as stored at that moment, or undefined if there is none.
 * Return the new record, or null to leave the stored record as it is. A throw
 * writes nothing and reaches the caller.
 */
export type RecordChange = (current: LibraryRecord | undefined) => LibraryRecord | null;

// Every write that depends on what is stored reads and writes in one step, so
// two pages, or two calls on one page, cannot overwrite each other's change.
export interface LibraryStorage {
  readMeta(): Promise<StorageMeta | undefined>;
  writeMeta(meta: StorageMeta): Promise<void>;
  listRecords(): Promise<LibraryRecord[]>;
  getRecord(id: string): Promise<LibraryRecord | undefined>;
  /** The record and all of its files from one read, never half of one write and half of the next. */
  readRecording(id: string): Promise<StoredRecording | undefined>;
  /** Adds a new recording with revision 1. Fails, writing nothing, if the ID is taken. */
  addRecording(record: LibraryRecord, files: ReadonlyMap<string, Uint8Array>): Promise<LibraryRecord>;
  /**
   * Writes the record and replaces all of its files, if the stored record is
   * still at `expectedRevision`. Otherwise throws `recording-conflict` and
   * writes nothing. Returns the record as stored.
   */
  replaceRecording(
    record: LibraryRecord,
    files: ReadonlyMap<string, Uint8Array>,
    expectedRevision: number,
  ): Promise<LibraryRecord>;
  /** Reads, changes and writes one record in one step. Returns the record as stored afterwards. */
  updateRecord(id: string, change: RecordChange): Promise<LibraryRecord | undefined>;
  readFile(id: string, path: string): Promise<Uint8Array | undefined>;
  /**
   * Removes the record and all of its files if the stored record is still at
   * `expectedRevision`; otherwise throws `recording-conflict` and removes
   * nothing. A missing record is not an error.
   */
  removeRecording(id: string, expectedRevision: number): Promise<void>;
}

export function conflictError(id: string, expected: number, stored: number | undefined): NarwalError {
  return new NarwalError(
    'recording-conflict',
    'The recording changed while this change was being made. Nothing was saved; open it again and retry.',
    { id, expected, stored: stored ?? null },
  );
}
