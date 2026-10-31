// Main-thread client for the final-model workers (board #16544): the Whisper
// worker, and the sherpa-onnx worker for Parakeet (board #16608). One worker
// runs at a time, so only one final model is in memory.

import type { FinalEngine, FinalEngineTiming, FinalEngineWord } from '../final-pass.ts';
import { FINAL_MODEL } from '../contract.ts';
import { ModelError } from '../model-store.ts';
import type { ModelStore } from '../model-store.ts';
import { MODELS, isFinalModel, isSherpaModel, sherpaRuntime, transformersRuntime } from '../models.ts';
import type { FinalModelId } from '../models.ts';
import type { NetworkAttempt } from '../network-guard.ts';

export interface WhisperRuntimeOptions {
  workerUrl: string;
  /** The sherpa-onnx worker; `<runtimeBase>sherpa-worker.js` when not given. */
  sherpaWorkerUrl?: string;
  /** URL of the directory that holds the packaged ONNX Runtime files, with a trailing slash. */
  runtimeBase: string;
  store: ModelStore;
  maxThreads?: number;
  loadTimeoutMs?: number;
  /**
   * Longest one transcription may take. After it the worker counts as hung:
   * it is stopped, the call fails (the final pass records a gap) and the next
   * call starts a new worker. A span is at most 20 s of audio, 24 s with its context (span-context.ts).
   */
  transcribeTimeoutMs?: number;
}

export const WHISPER_TRANSCRIBE_TIMEOUT_MS = 120_000;

/**
 * Parakeet's times are the TDT decoder's token frames (80 ms). In the
 * extension on the e2e fixture (#16608) word starts ran 33 ms late at the
 * median; on Matt's passage they ran about 45 ms late (30 ms behind Vosk,
 * which runs 15 ms behind forced alignment, #16539). The pass moves them
 * 30 ms earlier, less than either measurement, so a start is never moved
 * ahead of the word.
 */
export const SHERPA_TIMING: FinalEngineTiming = { method: 'tdt-token-times', biasMs: 30 };

/** "Whisper" or "Parakeet": the name in a final model worker's errors. */
const engineName = (model: FinalModelId): string => (isSherpaModel(model) ? 'Parakeet' : 'Whisper');

interface Pending {
  resolve: (words: FinalEngineWord[]) => void;
  reject: (error: Error) => void;
}

export class WhisperRuntime {
  /** Model, device, threads and load time of the running engine, for the measurements. */
  info: { model: FinalModelId; device: string; threads: number; loadMs: number; heapBytes?: number } | null = null;
  private readonly options: WhisperRuntimeOptions;
  private worker: Worker | null = null;
  /** The model the worker holds, or is loading. */
  private model: FinalModelId | null = null;
  private loading: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private onControl: ((message: { type: string; [key: string]: unknown }) => void) | null = null;
  /** Fails the start in progress, if any. */
  private abortStart: ((error: Error) => void) | null = null;
  private nextId = 0;

  constructor(options: WhisperRuntimeOptions) {
    this.options = options;
  }

  /**
   * Verifies the stored model, then loads it. Rejects with ModelError when it
   * is missing or corrupt. Asking for another model replaces the worker.
   */
  readonly getEngine = async (model: string = FINAL_MODEL): Promise<FinalEngine> => {
    if (!isFinalModel(model)) throw new Error(`${model} is not a final model`);
    await this.load(model);
    const transcribe = (pcm: Float32Array) => this.transcribe(model, pcm);
    // A sherpa-onnx model has no transformers.js runtime: transformersRuntime() throws for it.
    if (isSherpaModel(model)) return { transcribe, timing: SHERPA_TIMING };
    return { transcribe, wordTimes: transformersRuntime(model).wordTimes ?? 'model' };
  };

  private async load(model: FinalModelId): Promise<void> {
    await this.options.store.openVerified(model);
    if (this.model !== model) this.stop(this.stopped());
    if (!this.loading) {
      this.model = model;
      const attempt: Promise<void> = this.spawn(model).catch((error) => {
        // A terminate() and a new load may have run since; that worker is not ours to stop.
        if (this.loading === attempt) this.terminate();
        throw error;
      });
      this.loading = attempt;
    }
    await this.loading;
  }

  private spawn(model: FinalModelId): Promise<void> {
    this.stop(this.stopped());
    this.model = model;
    const sherpa = isSherpaModel(model);
    const name = engineName(model);
    const url = sherpa ? (this.options.sherpaWorkerUrl ?? `${this.options.runtimeBase}sherpa-worker.js`) : this.options.workerUrl;
    const worker = new Worker(url, { type: 'module' });
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      let starting = true;
      const settle = (error?: Error) => {
        if (!starting) return;
        starting = false;
        clearTimeout(timer);
        this.onControl = null;
        this.abortStart = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => settle(new Error(`${name} model load timed out`)), this.options.loadTimeoutMs ?? 180_000);
      worker.onmessage = (event) => {
        const message = event.data as { type: string; id?: number; words?: FinalEngineWord[]; message?: string; heapBytes?: number };
        // The Parakeet worker reports its WebAssembly heap; keep the largest.
        if (this.info && message.heapBytes) this.info.heapBytes = Math.max(this.info.heapBytes ?? 0, message.heapBytes);
        const pending = message.id === undefined ? undefined : this.pending.get(message.id);
        if (pending && message.id !== undefined) {
          this.pending.delete(message.id);
          if (message.type === 'result') pending.resolve(message.words ?? []);
          else pending.reject(new Error(message.message || `${name} failed`));
        } else {
          this.onControl?.(message);
        }
      };
      worker.onerror = (event) => {
        const reason = event.message || `${name} worker crashed`;
        if (starting) settle(new Error(reason));
        else if (this.worker === worker) this.stop(reason);
      };
      this.abortStart = settle;
      this.onControl = (message) => {
        if (message.type === 'loaded') {
          this.info = { model, device: message.device as string, threads: message.threads as number, loadMs: message.loadMs as number, ...(message.heapBytes ? { heapBytes: message.heapBytes as number } : {}) };
          settle();
        } else if (message.type === 'load-error') {
          const code = message.code as string;
          const text = String(message.message);
          settle(code === 'model-corrupt' || code === 'model-missing' ? new ModelError(code, model, text) : new Error(text));
        }
      };
      const runtime = sherpa ? sherpaRuntime(model) : transformersRuntime(model);
      worker.postMessage({ type: 'load', runtimeBase: this.options.runtimeBase, maxThreads: this.options.maxThreads ?? 4, runtime, model, files: MODELS[model].files });
    });
  }

  private async transcribe(model: FinalModelId, pcm: Float32Array): Promise<FinalEngineWord[]> {
    // A worker stopped after a crash or a timeout is started again here.
    if (!this.loading || this.model !== model) await this.load(model);
    else await this.loading;
    const worker = this.worker;
    if (!worker) throw new Error('final model worker is not running');
    const id = ++this.nextId;
    const copy = pcm.slice();
    const timeoutMs = this.options.transcribeTimeoutMs ?? WHISPER_TRANSCRIBE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.worker === worker) this.stop(`${engineName(model)} did not answer within ${Math.round(timeoutMs / 1000)} s; the worker was stopped`);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (words) => {
          clearTimeout(timer);
          resolve(words);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ type: 'transcribe', id, pcm: copy }, [copy.buffer]);
    });
  }

  /** "Whisper worker stopped" or "Parakeet worker stopped", for the model the worker holds. */
  private stopped(): string {
    return `${this.model ? engineName(this.model) : 'Final model'} worker stopped`;
  }

  /** Stops the worker and fails every transcription still waiting on it. */
  private stop(reason: string): void {
    const pending = [...this.pending.values()];
    this.abortStart?.(new Error(reason));
    this.worker?.terminate();
    this.worker = null;
    this.model = null;
    this.loading = null;
    this.pending.clear();
    this.onControl = null;
    this.info = null;
    for (const entry of pending) entry.reject(new Error(reason));
  }

  networkLedger(): Promise<NetworkAttempt[]> {
    const worker = this.worker;
    if (!worker || this.onControl) return Promise.resolve([]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish([]), 5000);
      const finish = (attempts: NetworkAttempt[]) => {
        clearTimeout(timer);
        this.onControl = null;
        resolve(attempts);
      };
      this.onControl = (message) => {
        if (message.type === 'ledger') finish(message.attempts as NetworkAttempt[]);
      };
      worker.postMessage({ type: 'ledger' });
    });
  }

  terminate(): void {
    this.stop(this.stopped());
  }
}
