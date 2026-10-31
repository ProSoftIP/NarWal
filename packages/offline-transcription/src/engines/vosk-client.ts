// Main-thread client for the packaged Vosk worker (board #16544).
//
// Speaks the vosk-browser 0.0.8 worker protocol directly. The upstream client
// starts its worker from a blob URL, which an MV3 extension page may not do;
// build.mjs ships the same worker as a packaged file instead.

import { ENGINE_SAMPLE_RATE } from '../audio.ts';
import type { LiveEngine, LiveEngineFactory, LiveEngineMessage } from '../live-session.ts';
import type { ModelStore } from '../model-store.ts';
import { voskLoadUrl } from '../models.ts';
import type { NetworkAttempt } from '../network-guard.ts';

export interface VoskRuntimeOptions {
  workerUrl: string;
  store: ModelStore;
  loadTimeoutMs?: number;
}

interface VoskWorkerMessage {
  event: string;
  recognizerId?: string;
  result?: unknown;
  error?: string;
  attempts?: NetworkAttempt[];
}

/** Name of the IndexedDB database the Vosk worker extracts its model into. */
export const VOSK_EXTRACTED_DB = '/vosk';

export function deleteVoskExtractedModel(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(VOSK_EXTRACTED_DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

export class VoskRuntime {
  private readonly options: VoskRuntimeOptions;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private readonly recognizers = new Map<string, (message: LiveEngineMessage) => void>();
  private onModelMessage: ((message: VoskWorkerMessage) => void) | null = null;
  /** Fails the start in progress, if any. */
  private abortStart: ((error: Error) => void) | null = null;
  private nextId = 0;

  constructor(options: VoskRuntimeOptions) {
    this.options = options;
  }

  /** Verifies the stored archive, then loads it. Rejects with ModelError when it is missing or corrupt. */
  async load(): Promise<void> {
    // Checked on every call, also when the worker is warm: a model that was
    // removed or damaged since must not keep answering.
    await this.options.store.openVerified('vosk-small-en-us');
    if (!this.loading) {
      // `loading` keeps this promise through the second attempt: a load() in
      // between must wait for it, not start a second worker (#16569).
      const attempt: Promise<void> = this.spawn().catch(async (firstError) => {
        if (this.loading !== attempt) throw firstError; // terminate() ran meanwhile
        // The extracted copy in IndexedDB may be the broken part; rebuild it once from the verified archive.
        this.stopWorker();
        await deleteVoskExtractedModel();
        if (this.loading !== attempt) throw firstError;
        return this.spawn().catch((secondError) => {
          if (this.loading === attempt) this.terminate();
          throw new Error(`Vosk could not start: ${secondError instanceof Error ? secondError.message : firstError}`);
        });
      });
      this.loading = attempt;
    }
    await this.loading;
  }

  private spawn(): Promise<void> {
    this.stopWorker();
    const worker = new Worker(this.options.workerUrl);
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      let starting = true;
      const settle = (error?: Error) => {
        if (!starting) return;
        starting = false;
        clearTimeout(timer);
        this.onModelMessage = null;
        this.abortStart = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => settle(new Error('Vosk model load timed out')), this.options.loadTimeoutMs ?? 120_000);
      worker.onmessage = (event: MessageEvent<VoskWorkerMessage>) => this.dispatch(event.data);
      // A crash while the model loads fails this start, so load() can retry it.
      worker.onerror = (event) => {
        const reason = event.message || 'Vosk worker crashed';
        if (starting) settle(new Error(reason));
        else if (this.worker === worker) this.crashed(reason);
      };
      this.abortStart = settle;
      this.onModelMessage = (message) => {
        if (message.event === 'load' && message.result === true) settle();
        else if (message.event === 'load' || message.event === 'error') settle(new Error(message.error || 'Vosk model did not load'));
      };
      worker.postMessage({ action: 'set', key: 'logLevel', value: -1 });
      worker.postMessage({ action: 'load', modelUrl: voskLoadUrl() });
    });
  }

  private dispatch(message: VoskWorkerMessage): void {
    if (!message) return;
    const listener = message.recognizerId ? this.recognizers.get(message.recognizerId) : undefined;
    if (!listener) {
      this.onModelMessage?.(message);
      return;
    }
    if (message.event === 'partialresult') {
      listener({ type: 'partial', text: (message.result as { partial?: string })?.partial ?? '' });
    } else if (message.event === 'result') {
      const result = (message.result ?? {}) as { text?: string; result?: { word: string; start: number; end: number; conf?: number }[] };
      listener({ type: 'result', text: result.text ?? '', words: result.result ?? [] });
    } else if (message.event === 'error') {
      listener({ type: 'error', message: message.error || 'Vosk recognizer error' });
    }
  }

  private crashed(reason: string): void {
    const listeners = [...this.recognizers.values()];
    this.terminate();
    for (const listener of listeners) listener({ type: 'error', message: reason });
  }

  readonly createEngine: LiveEngineFactory = async (onMessage) => {
    await this.load();
    const worker = this.worker;
    if (!worker) throw new Error('Vosk worker is not running');
    const recognizerId = `narwal-${++this.nextId}`;
    this.recognizers.set(recognizerId, onMessage);
    worker.postMessage({ action: 'create', recognizerId, sampleRate: ENGINE_SAMPLE_RATE });
    worker.postMessage({ action: 'set', recognizerId, key: 'words', value: true });
    const alive = () => this.worker === worker && this.recognizers.has(recognizerId);
    const engine: LiveEngine = {
      feed: (samples) => {
        if (!alive()) return;
        // Kaldi expects the int16 range.
        const data = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) data[i] = samples[i] * 0x8000;
        worker.postMessage({ action: 'audioChunk', recognizerId, data, sampleRate: ENGINE_SAMPLE_RATE }, [data.buffer]);
      },
      flush: () => {
        if (alive()) worker.postMessage({ action: 'retrieveFinalResult', recognizerId });
      },
      close: () => {
        if (!alive()) return;
        this.recognizers.delete(recognizerId);
        worker.postMessage({ action: 'remove', recognizerId });
      },
    };
    return engine;
  };

  /** Every request the worker made or tried to make since it started. */
  networkLedger(): Promise<NetworkAttempt[]> {
    const worker = this.worker;
    if (!worker) return Promise.resolve([]);
    return new Promise((resolve) => {
      const previous = this.onModelMessage;
      const timer = setTimeout(() => finish([]), 5000);
      const finish = (attempts: NetworkAttempt[]) => {
        clearTimeout(timer);
        this.onModelMessage = previous;
        resolve(attempts);
      };
      this.onModelMessage = (message) => {
        if (message.event === 'narwal:ledger') finish(message.attempts ?? []);
        else previous?.(message);
      };
      worker.postMessage({ action: 'narwal:ledger' });
    });
  }

  terminate(): void {
    this.stopWorker();
    this.loading = null;
  }

  private stopWorker(): void {
    this.abortStart?.(new Error('Vosk worker stopped'));
    this.worker?.terminate();
    this.worker = null;
    this.recognizers.clear();
    this.onModelMessage = null;
  }
}
