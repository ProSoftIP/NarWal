// sherpa-onnx worker (board #16608): Parakeet TDT on the sherpa-onnx
// WebAssembly runtime, packaged with the extension (build.mjs). The model
// files come from the verified local store, are checked against their pinned
// SHA-256 again here, and are written to the runtime's in-memory file system
// only for the model load. The runtime has one thread.

import { guard } from './sherpa-guard.ts';
import createSherpaModule from '../../vendor/sherpa-onnx/sherpa-onnx-asr-wasm.js';
import type { SherpaModule } from '../../vendor/sherpa-onnx/sherpa-onnx-asr-wasm.js';
import { OfflineRecognizer } from '../../vendor/sherpa-onnx/sherpa-onnx-asr.js';
import { ENGINE_SAMPLE_RATE } from '../audio.ts';
import { MODEL_CACHE_NAME } from '../model-store.ts';
import { sha256Hex, storageKey } from '../models.ts';
import type { FinalModelId, ModelFile, SherpaRuntimeSpec } from '../models.ts';
import { sherpaWords } from './sherpa-words.ts';
import type { SherpaOfflineResult } from './sherpa-words.ts';

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
const MODEL_DIR = '/model';

let runtime: SherpaModule | null = null;
let recognizer: OfflineRecognizer | null = null;

class LoadProblem extends Error {
  readonly code: 'model-missing' | 'model-corrupt';
  constructor(code: 'model-missing' | 'model-corrupt', path: string) {
    super(`${code === 'model-missing' ? 'not stored' : 'failed the integrity check'}: ${path}`);
    this.code = code;
  }
}

async function readVerified(model: FinalModelId, file: ModelFile): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const stored = await cache.match(storageKey(model, file.path));
  if (!stored) throw new LoadProblem('model-missing', file.path);
  const data = await stored.arrayBuffer();
  if (data.byteLength !== file.bytes || (await sha256Hex(data)) !== file.sha256) throw new LoadProblem('model-corrupt', file.path);
  return new Uint8Array(data);
}

/** Bytes of WebAssembly memory the runtime holds; it never shrinks. */
const heapBytes = () => runtime?.HEAPF32.buffer.byteLength ?? 0;

async function load(runtimeBase: string, spec: SherpaRuntimeSpec, model: FinalModelId, files: ModelFile[]): Promise<{ device: string; threads: number; loadMs: number; heapBytes: number }> {
  const started = performance.now();
  const errors: string[] = [];
  runtime ??= await createSherpaModule({
    locateFile: () => `${runtimeBase}sherpa-onnx.wasm`,
    print: () => {},
    printErr: (text) => errors.push(text),
  });
  const fs = runtime.FS;
  try {
    fs.mkdir(MODEL_DIR);
  } catch {
    // Left by an earlier load in this worker.
  }
  const written: string[] = [];
  try {
    for (const file of files) {
      const path = `${MODEL_DIR}/${file.path}`;
      // canOwn: the file system keeps this buffer instead of a second copy.
      fs.writeFile(path, await readVerified(model, file), { canOwn: true });
      written.push(path);
    }
    const at = (name: string) => `${MODEL_DIR}/${name}`;
    recognizer = new OfflineRecognizer(
      {
        featConfig: { sampleRate: ENGINE_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: at(spec.encoder), decoder: at(spec.decoder), joiner: at(spec.joiner) },
          tokens: at(spec.tokens),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
          modelType: spec.modelType,
        },
        decodingMethod: 'greedy_search',
      },
      runtime,
    );
    if (!recognizer.handle) {
      recognizer = null;
      throw new Error(`sherpa-onnx could not load ${model}: ${errors.slice(-3).join(' | ') || 'no detail'}`);
    }
  } finally {
    // The runtime has read the files into its own memory; the copies here are not needed again.
    for (const path of written) fs.unlink(path);
  }
  return { device: 'wasm', threads: 1, loadMs: Math.round(performance.now() - started), heapBytes: heapBytes() };
}

function transcribe(pcm: Float32Array) {
  if (!recognizer) throw new Error('Parakeet is not loaded');
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(ENGINE_SAMPLE_RATE, pcm);
    recognizer.decode(stream);
    return sherpaWords(recognizer.getResult(stream) as SherpaOfflineResult);
  } finally {
    stream.free();
  }
}

scope.onmessage = async (event: MessageEvent) => {
  const message = event.data as { type: string; id?: number; pcm?: Float32Array; runtimeBase?: string; runtime?: SherpaRuntimeSpec; model?: FinalModelId; files?: ModelFile[] };
  if (message.type === 'load') {
    try {
      if (!message.runtime || message.runtime.modelType !== 'nemo_transducer' || !message.model || !message.files) throw new Error('no sherpa-onnx model named');
      scope.postMessage({ type: 'loaded', ...(await load(message.runtimeBase ?? '', message.runtime, message.model, message.files)) });
    } catch (error) {
      recognizer = null;
      const code = error instanceof LoadProblem ? error.code : 'engine-failed';
      scope.postMessage({ type: 'load-error', code, message: error instanceof Error ? error.message : String(error) });
    }
  } else if (message.type === 'transcribe') {
    try {
      if (!message.pcm) throw new Error('no audio');
      const started = performance.now();
      const words = transcribe(message.pcm);
      scope.postMessage({ type: 'result', id: message.id, words, ms: Math.round(performance.now() - started), heapBytes: heapBytes() });
    } catch (error) {
      scope.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
  } else if (message.type === 'ledger') {
    scope.postMessage({ type: 'ledger', attempts: guard.attempts });
  }
};
