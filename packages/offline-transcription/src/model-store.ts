// Verified model storage for the offline option (board #16544).
//
// The only code in this package that contacts a network host is `install`
// (and `repair`, which calls it). Both run on an explicit user action. A file
// is stored only after its size and SHA-256 match the pinned manifest, so a
// partial or tampered download never looks installed.

import { MODELS, MODEL_IDS, modelBytes, sha256Hex, storageKey } from './models.ts';
import type { ModelFile, ModelId } from './models.ts';

export interface BlobStore {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, blob: Blob): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Blob>();
  async get(key: string): Promise<Blob | undefined> {
    return this.blobs.get(key);
  }
  async put(key: string, blob: Blob): Promise<void> {
    this.blobs.set(key, blob);
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

export const MODEL_CACHE_NAME = 'narwal-models-v1';

/** Cache API store. Pages and workers of one extension origin share it. */
export function cacheBlobStore(cacheName: string = MODEL_CACHE_NAME): BlobStore {
  const open = () => caches.open(cacheName);
  return {
    async get(key) {
      const response = await (await open()).match(key);
      return response ? response.blob() : undefined;
    },
    async put(key, blob) {
      await (await open()).put(key, new Response(blob, { headers: { 'content-length': String(blob.size) } }));
    },
    async delete(key) {
      await (await open()).delete(key);
    },
  };
}

export type ModelErrorCode = 'model-missing' | 'model-corrupt' | 'download-failed' | 'hash-mismatch' | 'aborted';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly modelId: ModelId;
  constructor(code: ModelErrorCode, modelId: ModelId, message: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.modelId = modelId;
  }
}

/**
 * - `missing`: not installed (bytesDone > 0 when a download can resume).
 * - `downloading`: an install is running.
 * - `ready`: every file is present with the pinned size (and hash, after `verify`).
 * - `corrupt`: a stored file has the wrong size or failed its hash check.
 * - `failed`: the last install stopped with an error; nothing unverified was kept.
 */
export type ModelState = 'missing' | 'downloading' | 'ready' | 'corrupt' | 'failed';

export interface ModelStatus {
  id: ModelId;
  state: ModelState;
  bytesDone: number;
  bytesTotal: number;
  /** Paths that failed the last check. */
  badFiles: string[];
  /** True when every file passed a hash check since it was last written. */
  verified: boolean;
  error?: { code: ModelErrorCode; message: string };
}

export interface DownloadRecord {
  modelId: ModelId;
  path: string;
  host: string;
  bytes: number;
  ok: boolean;
  atMs: number;
}

export interface InstallOptions {
  signal?: AbortSignal;
  onProgress?: (status: ModelStatus) => void;
}

export interface ModelStoreConfig {
  blobs: BlobStore;
  /** Used by `install` only. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Hash mismatches are retried this many times before the install fails. */
  hashRetries?: number;
  /** Called after `remove`, for runtime-owned copies (the Vosk extracted model). */
  onRemoved?: (id: ModelId) => Promise<void>;
}

export class ModelStore {
  /** Every download this store made, for the "what did we fetch" evidence. */
  readonly downloads: DownloadRecord[] = [];
  private readonly config: ModelStoreConfig;
  private readonly installing = new Map<ModelId, { promise: Promise<ModelStatus>; done: Map<string, number> }>();
  private readonly bad = new Map<ModelId, Set<string>>();
  private readonly verifiedOk = new Map<ModelId, Set<string>>();
  private readonly lastError = new Map<ModelId, { code: ModelErrorCode; message: string }>();

  constructor(config: ModelStoreConfig) {
    this.config = config;
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  /** Cheap check: presence and size only. `verify` adds the hash check. */
  async status(id: ModelId): Promise<ModelStatus> {
    const files = MODELS[id].files;
    const bytesTotal = modelBytes(id);
    const running = this.installing.get(id);
    if (running) {
      let bytesDone = 0;
      for (const bytes of running.done.values()) bytesDone += bytes;
      return { id, state: 'downloading', bytesDone, bytesTotal, badFiles: [], verified: false };
    }
    const bad = new Set(this.bad.get(id) ?? []);
    const verifiedOk = this.verifiedOk.get(id) ?? new Set<string>();
    let bytesDone = 0;
    let present = 0;
    for (const file of files) {
      const blob = await this.config.blobs.get(storageKey(id, file.path));
      if (!blob) {
        bad.delete(file.path);
        continue;
      }
      if (blob.size !== file.bytes) bad.add(file.path);
      if (bad.has(file.path)) continue;
      present += 1;
      bytesDone += file.bytes;
    }
    const badFiles = files.filter((file) => bad.has(file.path)).map((file) => file.path);
    const error = this.lastError.get(id);
    let state: ModelState;
    if (badFiles.length) state = 'corrupt';
    else if (present === files.length) state = 'ready';
    else if (error) state = 'failed';
    else state = 'missing';
    const verified = state === 'ready' && files.every((file) => verifiedOk.has(file.path));
    return { id, state, bytesDone, bytesTotal, badFiles, verified, ...(state === 'failed' && error ? { error } : {}) };
  }

  /** Every model, or the ones named (the models of this machine's tier, tier.ts). */
  async statusAll(ids: ModelId[] = MODEL_IDS): Promise<ModelStatus[]> {
    return Promise.all(ids.map((id) => this.status(id)));
  }

  /** Full check: hashes every stored file against the manifest. */
  async verify(id: ModelId): Promise<ModelStatus> {
    if (this.installing.has(id)) return this.status(id);
    const bad = new Set<string>();
    const ok = new Set<string>();
    for (const file of MODELS[id].files) {
      const blob = await this.config.blobs.get(storageKey(id, file.path));
      if (!blob) continue;
      if (blob.size === file.bytes && (await sha256Hex(await blob.arrayBuffer())) === file.sha256) ok.add(file.path);
      else bad.add(file.path);
    }
    this.bad.set(id, bad);
    this.verifiedOk.set(id, ok);
    return this.status(id);
  }

  /**
   * Returns the model files after a fresh hash check, or throws `model-missing`
   * or `model-corrupt`. Runtimes load only through this (or the same check in
   * their worker), so an unverified byte never reaches them.
   */
  async openVerified(id: ModelId): Promise<Map<string, Blob>> {
    const status = await this.verify(id);
    if (status.state === 'corrupt') {
      throw new ModelError('model-corrupt', id, `${id}: ${status.badFiles.join(', ')} failed the integrity check`);
    }
    if (status.state !== 'ready') throw new ModelError('model-missing', id, `${id} is not installed on this machine`);
    const out = new Map<string, Blob>();
    for (const file of MODELS[id].files) {
      const blob = await this.config.blobs.get(storageKey(id, file.path));
      if (!blob) throw new ModelError('model-missing', id, `${id}: ${file.path} disappeared`);
      out.set(file.path, blob);
    }
    return out;
  }

  /**
   * Downloads the files that are not already stored and verified. Explicit:
   * nothing in this package calls it on its own. Safe to call again after a
   * failure; files that were verified earlier are not fetched again.
   */
  install(id: ModelId, options: InstallOptions = {}): Promise<ModelStatus> {
    const running = this.installing.get(id);
    if (running) return running.promise;
    const done = new Map<string, number>();
    // Only this install's own registration is removed: a caller may start the next one before this settles.
    const promise: Promise<ModelStatus> = this.runInstall(id, options, done).finally(() => {
      if (this.installing.get(id)?.promise === promise) this.installing.delete(id);
    });
    this.installing.set(id, { promise, done });
    return promise;
  }

  private async runInstall(id: ModelId, options: InstallOptions, done: Map<string, number>): Promise<ModelStatus> {
    const bytesTotal = modelBytes(id);
    let lastReported = -1;
    const report = (force = false) => {
      if (!options.onProgress) return;
      let bytesDone = 0;
      for (const bytes of done.values()) bytesDone += bytes;
      if (!force && bytesDone - lastReported < bytesTotal / 200) return;
      lastReported = bytesDone;
      options.onProgress({ id, state: 'downloading', bytesDone, bytesTotal, badFiles: [], verified: false });
    };
    this.lastError.delete(id);
    try {
      const verifiedOk = this.verifiedOk.get(id) ?? new Set<string>();
      this.verifiedOk.set(id, verifiedOk);
      for (const file of MODELS[id].files) {
        const key = storageKey(id, file.path);
        const existing = await this.config.blobs.get(key);
        if (existing && existing.size === file.bytes && (await sha256Hex(await existing.arrayBuffer())) === file.sha256) {
          done.set(file.path, file.bytes);
          verifiedOk.add(file.path);
          this.bad.get(id)?.delete(file.path);
          report();
          continue;
        }
        if (existing) await this.config.blobs.delete(key);
        const blob = await this.download(id, file, options.signal, (bytes) => {
          done.set(file.path, bytes);
          report();
        });
        await this.config.blobs.put(key, blob);
        done.set(file.path, file.bytes);
        verifiedOk.add(file.path);
        this.bad.get(id)?.delete(file.path);
        report(true);
      }
    } catch (error) {
      const modelError =
        error instanceof ModelError ? error : new ModelError('download-failed', id, error instanceof Error ? error.message : String(error));
      this.lastError.set(id, { code: modelError.code, message: modelError.message });
      throw modelError;
    }
    this.installing.delete(id);
    const status = await this.status(id);
    options.onProgress?.(status);
    return status;
  }

  private async download(id: ModelId, file: ModelFile, signal: AbortSignal | undefined, onBytes: (bytes: number) => void): Promise<Blob> {
    const fetchFn = this.config.fetch ?? fetch;
    const attempts = 1 + (this.config.hashRetries ?? 1);
    const host = new URL(file.url).host;
    let mismatch = '';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const record: DownloadRecord = { modelId: id, path: file.path, host, bytes: 0, ok: false, atMs: this.now() };
      this.downloads.push(record);
      const parts: Uint8Array[] = [];
      try {
        const response = await fetchFn(file.url, { signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
        if (!response.ok || !response.body) throw new ModelError('download-failed', id, `${file.path}: HTTP ${response.status} from ${host}`);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          record.bytes += value.byteLength;
          if (record.bytes > file.bytes) {
            await reader.cancel();
            break;
          }
          onBytes(record.bytes);
        }
      } catch (error) {
        if (signal?.aborted) throw new ModelError('aborted', id, `${file.path}: download cancelled`);
        if (error instanceof ModelError) throw error;
        throw new ModelError('download-failed', id, `${file.path}: ${error instanceof Error ? error.message : String(error)} (${host})`);
      }
      const blob = new Blob(parts as BlobPart[]);
      if (blob.size !== file.bytes) {
        mismatch = `${file.path}: got ${blob.size} bytes, expected ${file.bytes}`;
      } else if ((await sha256Hex(await blob.arrayBuffer())) !== file.sha256) {
        mismatch = `${file.path}: SHA-256 does not match the pinned value`;
      } else {
        record.ok = true;
        return blob;
      }
      onBytes(0);
    }
    throw new ModelError('hash-mismatch', id, `${mismatch}; nothing was stored`);
  }

  /** Verifies, deletes the files that fail, and downloads only those again. */
  async repair(id: ModelId, options: InstallOptions = {}): Promise<ModelStatus> {
    const status = await this.verify(id);
    for (const path of status.badFiles) await this.config.blobs.delete(storageKey(id, path));
    this.bad.delete(id);
    return this.install(id, options);
  }

  async remove(id: ModelId): Promise<void> {
    for (const file of MODELS[id].files) await this.config.blobs.delete(storageKey(id, file.path));
    this.bad.delete(id);
    this.verifiedOk.delete(id);
    this.lastError.delete(id);
    await this.config.onRemoved?.(id);
  }
}
