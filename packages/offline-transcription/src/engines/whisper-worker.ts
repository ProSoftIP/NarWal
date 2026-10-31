// Whisper worker (board #16544): transformers.js on the packaged ONNX Runtime
// build, reading the model from the verified local store. Which model, and
// whether it runs on WebAssembly or WebGPU, comes with the load message
// (models.ts, tier.ts; board #16603). Moonshine runs here too (#16609): it
// returns text only, and the final pass gives its words their times.

import { guard, modelProblems } from './whisper-guard.ts';
import { whisperWords } from './whisper-words.ts';
import { env, pipeline } from '@huggingface/transformers';
import type { TransformersRuntimeSpec } from '../models.ts';

type Asr = (
  pcm: Float32Array,
  options: { return_timestamps: 'word' } | { max_new_tokens: number },
) => Promise<{ text?: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

let asr: (Asr & { dispose?: () => Promise<void> }) | null = null;
let textOnly = false;

/**
 * Moonshine's pipeline allows 6 tokens per whole second of audio by default
 * (a guard against repeated output), which is none for a span under 1 s. This
 * rounds up and allows at least 12.
 */
function moonshineTokens(samples: number): number {
  return Math.max(12, Math.ceil((samples / 16000) * 6));
}
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null; crossOriginIsolated: boolean };

async function load(runtimeBase: string, maxThreads: number, runtime: TransformersRuntimeSpec): Promise<{ device: string; threads: number; loadMs: number }> {
  const started = performance.now();
  env.allowLocalModels = false;
  env.allowRemoteModels = true; // "remote" requests are answered by the guard from local storage
  env.useBrowserCache = false;
  (env as { useCustomCache?: boolean }).useCustomCache = false;
  (env as { useWasmCache?: boolean }).useWasmCache = false;
  (env as { fetch?: typeof fetch }).fetch = self.fetch;
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = {
    mjs: `${runtimeBase}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${runtimeBase}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  // Threads need cross-origin isolation (SharedArrayBuffer).
  const threads = scope.crossOriginIsolated ? Math.max(1, Math.min(maxThreads, navigator.hardwareConcurrency || 1)) : 1;
  wasm.numThreads = threads;
  wasm.proxy = false;
  modelProblems.missing.length = 0;
  modelProblems.corrupt.length = 0;
  if (runtime.device === 'webgpu' && !(navigator as { gpu?: unknown }).gpu) throw new Error('this browser has no WebGPU');
  textOnly = runtime.wordTimes === 'none';
  asr = (await pipeline('automatic-speech-recognition', runtime.repo, {
    device: runtime.device,
    dtype: runtime.dtype as Record<string, 'fp32'>,
  })) as unknown as Asr;
  return { device: runtime.device, threads, loadMs: Math.round(performance.now() - started) };
}

scope.onmessage = async (event: MessageEvent) => {
  const message = event.data as { type: string; id?: number; pcm?: Float32Array; runtimeBase?: string; maxThreads?: number; runtime?: TransformersRuntimeSpec };
  if (message.type === 'load') {
    try {
      if (!message.runtime) throw new Error('no model named');
      const info = await load(message.runtimeBase ?? '', message.maxThreads ?? 4, message.runtime);
      if (modelProblems.corrupt.length || modelProblems.missing.length) throw new Error('a pinned model file was not usable');
      scope.postMessage({ type: 'loaded', ...info });
    } catch (error) {
      const code = modelProblems.corrupt.length ? 'model-corrupt' : modelProblems.missing.length ? 'model-missing' : 'engine-failed';
      const files = [...modelProblems.corrupt, ...modelProblems.missing].join(', ');
      asr = null;
      scope.postMessage({ type: 'load-error', code, message: `${error instanceof Error ? error.message : String(error)}${files ? ` (${files})` : ''}` });
    }
  } else if (message.type === 'transcribe') {
    try {
      if (!asr || !message.pcm) throw new Error('Whisper is not loaded');
      const started = performance.now();
      const pcm = message.pcm;
      const out = await asr(pcm, textOnly ? { max_new_tokens: moonshineTokens(pcm.length) } : { return_timestamps: 'word' });
      // Text only: the words carry no times (start and end 0); the final pass places them.
      const words = textOnly
        ? (out.text ?? '').split(/\s+/).filter(Boolean).map((text) => ({ text, start: 0, end: 0 }))
        : whisperWords(out.chunks ?? []);
      scope.postMessage({ type: 'result', id: message.id, words, ms: Math.round(performance.now() - started) });
    } catch (error) {
      scope.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
  } else if (message.type === 'ledger') {
    scope.postMessage({ type: 'ledger', attempts: guard.attempts });
  }
};
