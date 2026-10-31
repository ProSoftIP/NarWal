// Which final model runs on this machine (board #16603), and the live chain
// (board #16617).
//
// The final pass after Stop uses the most accurate model the machine can run
// in time. A machine with a real WebGPU adapter runs Whisper large-v3-turbo on
// the GPU; any other machine runs Parakeet TDT on WebAssembly. Each tier is
// a chain: when a model cannot load, is not installed, or would not finish in
// time, the next one runs. This file is the one place that names the models;
// a different model is a change to FINAL_CHAIN (and its pinned files in
// models.ts), nothing else.

import { MODELS } from './models.ts';
import type { FinalModelId, ModelId } from './models.ts';

export type FinalTier = 'webgpu' | 'wasm';

/**
 * Best first. Chosen by word error rate on Matt's 113 s reading passage
 * (#16603; live Vosk 45.3%): Parakeet TDT 0.6B v2 int8 5.1%, turbo q4f16
 * 6.0%, Moonshine base 9.4%, small.en 9.8%, base.en 28.6%.
 * Without WebGPU, Parakeet runs first (#16608): in the extension, on one
 * WebAssembly thread, with 2 s of context at span cuts (#16621), it takes
 * 0.32 x the audio length on one core on that passage (about 0.42 x on a
 * loaded machine before #16621), inside the job's limit of 10 min + audio/4
 * up to about 147 min of audio, and scores 5.6% against 9.0% for small.en
 * there (docs/validation/accuracy-16621). When it cannot load or would not finish in
 * time, the chain moves to small.en, then to Moonshine base (#16609). In
 * Chromium WebAssembly on that passage Moonshine took 0.06 x audio length at
 * 4 threads and 0.11 at 1 thread, against 0.14 and 0.26 for base.en, which it
 * replaced (e2e/bench-final.mjs). Its word times are interpolated.
 */
export const FINAL_CHAIN: Record<FinalTier, FinalModelId[]> = {
  webgpu: ['whisper-large-v3-turbo', 'whisper-small.en-q8'],
  wasm: ['parakeet-tdt-0.6b-v2-int8', 'whisper-small.en-q8', 'moonshine-base-q8'],
};

export const LIVE_MODEL_ID: ModelId = 'vosk-small-en-us';

/**
 * The live engines, best first (#16617). Parakeet runs on the speech spans
 * while recording (engines/parakeet-live.ts); Vosk is the fallback when
 * Parakeet is not installed or fails. Start needs either one.
 */
export const LIVE_CHAIN: ModelId[] = ['parakeet-tdt-0.6b-v2-int8', LIVE_MODEL_ID];

/**
 * Models taken out of a chain, each with the one that replaced it. A computer
 * set up before the change may hold the old model and not the new one; there
 * the old one stays the last fallback, so it keeps its final pass. It is not
 * downloaded any more (`modelsForTier`).
 */
export const RETIRED_FINAL: Partial<Record<FinalModelId, FinalModelId>> = {
  'whisper-base.en-q8': 'moonshine-base-q8', // #16609
};

/** The chain, then each retired model whose replacement is in it, to try when installed. */
export function chainWithRetired(chain: readonly FinalModelId[]): FinalModelId[] {
  const retired = (Object.keys(RETIRED_FINAL) as FinalModelId[]).filter((id) => chain.includes(RETIRED_FINAL[id]!) && !chain.includes(id));
  return [...chain, ...retired];
}

/** The installed models, best first, less each retired one whose replacement is installed. */
export function withoutReplaced(installed: readonly string[]): string[] {
  return installed.filter((id) => {
    const replacement = RETIRED_FINAL[id as FinalModelId];
    return !replacement || !installed.includes(replacement);
  });
}

/**
 * The models the offline option downloads on a machine of this tier, in
 * order: Vosk first (41 MB, so Start works soon), then Parakeet for the live
 * text, then the final chain. Each model once.
 */
export function modelsForTier(tier: FinalTier): ModelId[] {
  return [...new Set<ModelId>([LIVE_MODEL_ID, ...LIVE_CHAIN, ...FINAL_CHAIN[tier]])];
}

/** The best stored live model's status, if one is stored: Start needs only one (#16617). */
export function readyLiveModel<T extends { id: string; state: string }>(statuses: readonly T[]): T | undefined {
  return LIVE_CHAIN.map((id) => statuses.find((status) => status.id === id && status.state === 'ready')).find(Boolean);
}

interface GpuAdapterLike {
  features?: { has(name: string): boolean };
  info?: { isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}

interface NavigatorLike {
  gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapterLike | null> };
}

/** True when a model needs half-precision shaders on the GPU. */
function needsF16(tier: FinalTier): boolean {
  return FINAL_CHAIN[tier].some((id) => {
    const runtime = MODELS[id].runtime;
    return runtime?.device === 'webgpu' && Object.values(runtime.dtype).some((dtype) => dtype.includes('16'));
  });
}

/**
 * `webgpu` when the browser has a hardware WebGPU adapter that can run the
 * WebGPU chain. A software adapter (SwiftShader, `isFallbackAdapter`) counts
 * as none: it is far slower than WebAssembly for these models.
 */
export async function detectFinalTier(nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined): Promise<FinalTier> {
  if (!nav?.gpu) return 'wasm';
  let adapter: GpuAdapterLike | null = null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    return 'wasm';
  }
  if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return 'wasm';
  if (needsF16('webgpu') && !adapter.features?.has('shader-f16')) return 'wasm';
  return 'webgpu';
}
