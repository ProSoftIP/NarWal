// The local recording library: what the user has recorded or imported, kept
// on this device until they delete it.
//
// The library takes a storage object and nothing else. It has no access to
// provider keys, cookies, tabs or the network, so import cannot read a
// credential or act on a site, and export cannot upload: `exportBundle`
// returns bytes and the caller saves them where the user chooses.

import {
  DEFAULT_BUNDLE_LIMITS,
  bundleFileName,
  checkBundleFiles,
  packBundle,
  sha256Hex,
  unpackBundle,
} from './bundle.ts';
import type { BundleDeriver, BundleFiles, BundleLimits, BundleManifest, BundleValidator, CheckedBundle, ValidationIssue } from './bundle.ts';
import { NarwalError } from './errors.ts';
import { conflictError, STORAGE_VERSION } from './storage.ts';
import type { HistoryEvent, LibraryRecord, LibraryStorage, RecordingOrigin, StoredRecording } from './storage.ts';
import { checkLayersOnly } from './update-rules.ts';

const HISTORY_LIMIT = 200;

/** `interrupted`: the recording ended without a normal stop and was recovered (manifest state `recovered`). */
export type RecordingStatus = 'saved' | 'interrupted';

export interface RecordingSummary extends LibraryRecord {
  status: RecordingStatus;
}

/**
 * A recording the recorder still holds as raw chunks: in progress, or
 * interrupted and not yet recovered into a bundle (board #16542).
 */
export interface PendingRecording {
  id: string;
  status: 'recording' | 'interrupted';
  startedAt: string;
  title: string | null;
}

/** Moves stored data from one storage version to the next. */
export type StorageMigration = (storage: LibraryStorage) => Promise<void>;

export interface LibraryOptions {
  storage: LibraryStorage;
  /** Product version, written to the store for support. */
  productVersion: string;
  validate?: BundleValidator;
  /** Regenerates derived files on export. The extension always passes `deriveAgentFiles`. */
  derive?: BundleDeriver;
  limits?: BundleLimits;
  /** Lists recordings the recorder has not yet turned into bundles. */
  pending?: () => Promise<PendingRecording[]>;
  now?: () => Date;
  newId?: () => string;
  /** Test seams; production uses STORAGE_VERSION and the built-in table. */
  storageVersion?: number;
  migrations?: Readonly<Record<number, StorageMigration>>;
}

export interface ExportedBundle {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface ImportResult {
  recording: RecordingSummary;
  warnings: ValidationIssue[];
}

// Key N moves the store from version N to N + 1.
const MIGRATIONS: Readonly<Record<number, StorageMigration>> = {};

function summarize(record: LibraryRecord): RecordingSummary {
  return { ...record, status: record.state === 'recovered' ? 'interrupted' : 'saved' };
}

function notFound(id: string): NarwalError {
  return new NarwalError('recording-not-found', 'That recording is not in the library', { id });
}

function requireLive(record: LibraryRecord): void {
  if (record.deletedAt !== null) {
    throw new NarwalError('recording-state', 'That recording is in the trash; restore it first', { id: record.id });
  }
}

function baseName(fileName: string | undefined): string | null {
  if (fileName === undefined) return null;
  // Display only: drop any directory and control characters, and bound the length.
  const name = fileName
    .slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200);
  return name === '' ? null : name;
}

export class RecordingLibrary {
  #storage: LibraryStorage;
  #validate: BundleValidator | undefined;
  #derive: BundleDeriver | undefined;
  #limits: BundleLimits;
  #pending: (() => Promise<PendingRecording[]>) | undefined;
  #now: () => Date;
  #newId: () => string;

  private constructor(options: LibraryOptions) {
    this.#storage = options.storage;
    this.#validate = options.validate;
    this.#derive = options.derive;
    this.#limits = options.limits ?? DEFAULT_BUNDLE_LIMITS;
    this.#pending = options.pending;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Opens the store and brings it to this version. A store written by a newer
   * NarWal is left untouched and refused: an older build must not guess at it.
   */
  static async open(options: LibraryOptions): Promise<RecordingLibrary> {
    const target = options.storageVersion ?? STORAGE_VERSION;
    const migrations = options.migrations ?? MIGRATIONS;
    const now = options.now ?? (() => new Date());
    const { storage } = options;
    const meta = await storage.readMeta();
    const stamp = (storageVersion: number) =>
      storage.writeMeta({ storageVersion, writtenBy: options.productVersion, updatedAt: now().toISOString() });

    if (!meta) {
      await stamp(target);
    } else if (meta.storageVersion > target) {
      throw new NarwalError(
        'storage-newer',
        'Your recordings were saved by a newer NarWal. Install that version again to open them; nothing was changed.',
        { stored: meta.storageVersion, supported: target, writtenBy: meta.writtenBy },
      );
    } else {
      for (let version = meta.storageVersion; version < target; version += 1) {
        const migrate = migrations[version];
        if (!migrate) {
          throw new NarwalError('storage-migration-missing', `No migration from storage version ${version}`, {
            stored: meta.storageVersion,
            supported: target,
          });
        }
        await migrate(storage);
        // Stamp each step, so a stop between steps resumes at the right one.
        await stamp(version + 1);
      }
    }
    return new RecordingLibrary(options);
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  async #require(id: string): Promise<LibraryRecord> {
    const record = await this.#storage.getRecord(id);
    if (!record) throw notFound(id);
    return record;
  }

  /** A live recording and its files, read together. */
  async #readLive(id: string): Promise<StoredRecording> {
    const stored = await this.#storage.readRecording(id);
    if (!stored) throw notFound(id);
    requireLive(stored.record);
    return stored;
  }

  /**
   * Adds a history event, and the fields `patch` returns, to the record as
   * stored at the moment of the write, never to an earlier read: a change
   * made meanwhile by another call or page stays. `patch` may throw to write
   * nothing, or return null to leave the record as it is.
   */
  async #change(
    id: string,
    event: HistoryEvent['event'],
    patch: (current: LibraryRecord, at: string) => Partial<LibraryRecord> | null = () => ({}),
  ): Promise<RecordingSummary> {
    const at = this.#stamp();
    const stored = await this.#storage.updateRecord(id, (current) => {
      if (!current) throw notFound(id);
      const fields = patch(current, at);
      if (fields === null) return null;
      return {
        ...current,
        ...fields,
        updatedAt: at,
        history: [...current.history, { event, at }].slice(-HISTORY_LIMIT),
      };
    });
    if (!stored) throw notFound(id);
    return summarize(stored);
  }

  #describe(checked: CheckedBundle): Pick<
    LibraryRecord,
    'recordingId' | 'title' | 'createdAt' | 'durationMs' | 'schemaVersion' | 'state' | 'contentSha256' | 'bytes' | 'files'
  > {
    const manifest: BundleManifest = checked.manifest;
    return {
      recordingId: manifest.recordingId,
      title: manifest.title,
      createdAt: manifest.createdAt,
      durationMs: manifest.durationMs,
      schemaVersion: manifest.schemaVersion,
      state: manifest.state,
      contentSha256: checked.contentSha256,
      bytes: checked.bytes,
      // Only the four listed fields: an extra manifest field must not reach the index.
      files: manifest.files.map(({ path, bytes, sha256, mediaType }) => ({ path, bytes, sha256, mediaType })),
    };
  }

  async #add(checked: CheckedBundle, origin: RecordingOrigin, event: 'saved' | 'imported'): Promise<RecordingSummary> {
    const at = origin.kind === 'recorded' ? origin.savedAt : origin.importedAt;
    const record: LibraryRecord = {
      id: this.#newId(),
      ...this.#describe(checked),
      origin,
      history: [{ event, at }],
      addedAt: at,
      updatedAt: at,
      deletedAt: null,
      revision: 1,
    };
    return summarize(await this.#storage.addRecording(record, checked.files));
  }

  /** Saved and interrupted recordings, newest first. The trash is not included. */
  async list(): Promise<RecordingSummary[]> {
    const records = await this.#storage.listRecords();
    return records
      .filter((record) => record.deletedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.addedAt.localeCompare(a.addedAt))
      .map(summarize);
  }

  /** Deleted recordings that can still be restored, most recently deleted first. */
  async listTrash(): Promise<RecordingSummary[]> {
    const records = await this.#storage.listRecords();
    return records
      .filter((record) => record.deletedAt !== null)
      .sort((a, b) => (b.deletedAt as string).localeCompare(a.deletedAt as string))
      .map(summarize);
  }

  /** Recordings in progress or interrupted before the recorder made a bundle of them. */
  async listPending(): Promise<PendingRecording[]> {
    return this.#pending ? this.#pending() : [];
  }

  async get(id: string): Promise<RecordingSummary> {
    return summarize(await this.#require(id));
  }

  /** One file of a recording, as stored. Trashed recordings stay readable until purged. */
  async readFile(id: string, path: string): Promise<Uint8Array> {
    await this.#require(id);
    const bytes = await this.#storage.readFile(id, path);
    if (!bytes) throw new NarwalError('file-missing', `Recording has no file "${path}"`, { id, path });
    return bytes;
  }

  /** The whole bundle tree of a recording, read at one moment. */
  async readFiles(id: string): Promise<Map<string, Uint8Array>> {
    return (await this.read(id)).files;
  }

  /**
   * The recording and its whole bundle tree from one read. Pass
   * `recording.revision` to `update` as `expectedRevision` for a write built
   * from these files.
   */
  async read(id: string): Promise<{ recording: RecordingSummary; files: Map<string, Uint8Array> }> {
    const stored = await this.#storage.readRecording(id);
    if (!stored) throw notFound(id);
    return { recording: summarize(stored.record), files: stored.files };
  }

  /** Adds a bundle tree made on this device. A recovered tree is listed as interrupted. */
  async save(files: BundleFiles): Promise<RecordingSummary> {
    const checked = await checkBundleFiles(files, { limits: this.#limits, ...this.#validator() });
    return this.#add(checked, { kind: 'recorded', savedAt: this.#stamp() }, 'saved');
  }

  /**
   * Replaces a recording's bundle tree, for layers added after capture
   * (corrections, notes, a new transcript revision). The recording keeps its
   * library entry, origin and history. The new tree may only add layers
   * (update-rules.ts); captured files stay as they were.
   *
   * `files` must be built from the tree as stored at `expectedRevision`
   * (`read(id).recording.revision`). If the stored recording is at another
   * revision, nothing is written and the call fails with `recording-conflict`:
   * a tree read before another write would otherwise pass the layer check and
   * undo that write's manifest change (the active transcript revision).
   * Without `expectedRevision`, the revision this call reads is used, so only
   * a write landing during this call is caught.
   */
  async update(id: string, files: BundleFiles, options: { expectedRevision?: number } = {}): Promise<RecordingSummary> {
    const current = await this.#readLive(id);
    const { record } = current;
    const expected = options.expectedRevision ?? record.revision;
    if (record.revision !== expected) throw conflictError(id, expected, record.revision);
    const checked = await checkBundleFiles(files, { limits: this.#limits, ...this.#validator() });
    if (checked.manifest.recordingId !== record.recordingId) {
      throw new NarwalError('recording-state', 'The new files belong to a different recording', {
        id,
        expected: record.recordingId,
        received: checked.manifest.recordingId,
      });
    }
    checkLayersOnly(current.files, checked.files);
    const at = this.#stamp();
    const next: LibraryRecord = {
      ...record,
      ...this.#describe(checked),
      updatedAt: at,
      history: [...record.history, { event: 'updated' as const, at }].slice(-HISTORY_LIMIT),
    };
    return summarize(await this.#storage.replaceRecording(next, checked.files, expected));
  }

  /**
   * Packs one recording for the user to save or send. Explicit only: nothing
   * in NarWal calls this without a user action, and the bytes go nowhere but
   * back to the caller.
   */
  async exportBundle(id: string): Promise<ExportedBundle> {
    // One read: the record and files match even if an update lands meanwhile.
    const { record, files: stored } = await this.#readLive(id);
    // Derived files are written fresh: an imported copy's README.md, AGENTS.md or
    // agent/* may say anything, and must not be passed on as NarWal's words.
    const files = this.#derive ? await this.#derive(stored) : stored;
    // Re-checked on the way out: stored data that no longer matches its
    // manifest, or holds a credential, must not leave the device.
    const bytes = await packBundle(files, { limits: this.#limits, ...this.#validator() });
    const exported = { fileName: bundleFileName(record), bytes, sha256: await sha256Hex(bytes) };
    try {
      // History only: a delete or update made while packing stays as it is.
      await this.#change(id, 'exported');
    } catch (error) {
      // Removed for good while packing: the user still gets the bytes they asked for.
      if (!(error instanceof NarwalError && error.code === 'recording-not-found')) throw error;
    }
    return exported;
  }

  /**
   * Adds a bundle from an archive file. The archive is untrusted: it is
   * checked in full first, and a failed check stores nothing.
   */
  async importBundle(
    archive: Uint8Array,
    options: { fileName?: string; allowDuplicate?: boolean } = {},
  ): Promise<ImportResult> {
    const checked = await unpackBundle(archive, { limits: this.#limits, ...this.#validator() });
    if (!options.allowDuplicate) {
      const existing = (await this.#storage.listRecords()).find(
        (record) => record.contentSha256 === checked.contentSha256,
      );
      if (existing) {
        throw new NarwalError(
          'duplicate-import',
          existing.deletedAt === null
            ? 'This recording is already in your library'
            : 'This recording is in your trash; restore it instead',
          { id: existing.id, inTrash: existing.deletedAt !== null },
        );
      }
    }
    const origin: RecordingOrigin = {
      kind: 'imported',
      importedAt: this.#stamp(),
      archiveSha256: await sha256Hex(archive),
      archiveBytes: archive.length,
      fileName: baseName(options.fileName),
    };
    return { recording: await this.#add(checked, origin, 'imported'), warnings: checked.warnings };
  }

  /** Moves a recording to the trash. Its data stays on the device until `purge`. */
  async delete(id: string): Promise<RecordingSummary> {
    return this.#change(id, 'deleted', (current, at) => {
      requireLive(current);
      return { deletedAt: at };
    });
  }

  async restore(id: string): Promise<RecordingSummary> {
    return this.#change(id, 'restored', (current) => (current.deletedAt === null ? null : { deletedAt: null }));
  }

  /** Removes a trashed recording for good. Not recoverable. */
  async purge(id: string, options: { confirm: true }): Promise<void> {
    this.#requireConfirm(options);
    const record = await this.#require(id);
    if (record.deletedAt === null) {
      throw new NarwalError('recording-state', 'Move the recording to the trash before removing it for good', { id });
    }
    // Only as read: a restore made meanwhile wins, and the recording stays.
    await this.#storage.removeRecording(id, record.revision);
  }

  /** Removes every trashed recording for good. Returns how many were removed. */
  async emptyTrash(options: { confirm: true }): Promise<number> {
    this.#requireConfirm(options);
    let removed = 0;
    for (const record of await this.listTrash()) {
      try {
        await this.#storage.removeRecording(record.id, record.revision);
        removed += 1;
      } catch (error) {
        // Restored or changed since the list was read: leave it.
        if (!(error instanceof NarwalError && error.code === 'recording-conflict')) throw error;
      }
    }
    return removed;
  }

  #requireConfirm(options: { confirm: true } | undefined): void {
    // A runtime check as well as a type: callers are plain JavaScript pages.
    if (options?.confirm !== true) {
      throw new NarwalError('confirmation-required', 'Permanent removal needs an explicit confirmation');
    }
  }

  #validator(): { validate?: BundleValidator } {
    return this.#validate ? { validate: this.#validate } : {};
  }
}
