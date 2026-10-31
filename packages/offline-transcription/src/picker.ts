// The model picker for the "On this computer" choice (board #16611).
//
// One row per model with a measured block in models.ts: its name, an
// accuracy and a speed bar of five steps, the download size, and whether it
// needs WebGPU. The bars are drawn from the measured numbers only, by the
// thresholds below; nothing here is a hand-set rating.
//
// The choice is a model id, remembered per browser profile (prefs
// `offlineModel`). No choice means the machine's tier chain (tier.ts), as
// before the picker. Choosing the live model (Vosk) keeps the live text: no
// pass runs after Stop.

import { MODELS, MODEL_IDS, modelBytes, needsWebGpu } from './models.ts';
import type { FinalModelId, ModelId, ModelMeasured } from './models.ts';
import { FINAL_CHAIN, LIVE_MODEL_ID, chainWithRetired, modelsForTier, withoutReplaced } from './tier.ts';
import type { FinalTier } from './tier.ts';

/** Short names for the picker; a model with none here shows its manifest label. */
const NAMES: Record<string, string> = {
  'parakeet-tdt-0.6b-v2-int8': 'Parakeet TDT 0.6b',
  'whisper-large-v3-turbo': 'Whisper large-v3-turbo',
  'moonshine-base-q8': 'Moonshine base',
  'whisper-small.en-q8': 'Whisper small.en',
  'whisper-base.en-q8': 'Whisper base.en',
  'vosk-small-en-us': 'Vosk small (live)',
};

/** Word error rate (percent) at or under each bound earns 5, 4, 3, 2 steps; above the last, 1. */
export const ACCURACY_WER_BOUNDS = [6, 10, 20, 35];
/** Real-time factor at or under each bound earns 5, 4, 3, 2 steps; above the last, 1. A live model keeps up: 5. */
export const SPEED_RTF_BOUNDS = [0.1, 0.2, 0.4, 0.8];

function stepsUnder(value: number, bounds: number[]): number {
  const index = bounds.findIndex((bound) => value <= bound);
  return index === -1 ? 1 : 5 - index;
}

export function accuracySteps(werPct: number): number {
  return stepsUnder(werPct, ACCURACY_WER_BOUNDS);
}

export function speedSteps(rtf: number | null): number {
  return rtf === null ? 5 : stepsUnder(rtf, SPEED_RTF_BOUNDS);
}

export interface PickerRow {
  id: ModelId;
  name: string;
  live: boolean;
  /** 1 - WER, in percent, one decimal. */
  accuracyPct: number;
  werPct: number;
  /** Where `werPct` ran, e.g. 'in the extension, browser wasm'. */
  werSetup: string;
  /** Another recording of the passage than the 113 s one, when the numbers come from one; null otherwise. */
  otherTake: string | null;
  /** The same passage run natively over the whole file; null when not run. */
  werNativePct: number | null;
  accuracySteps: number;
  rtf: number | null;
  rtfSetup: string | null;
  speedSteps: number;
  peakMemoryMb: number | null;
  memorySetup: string | null;
  source: string;
  bytes: number;
  needsWebGpu: boolean;
  /** The tier the model needs: 'webgpu' (a graphics adapter) or 'wasm' (any computer). */
  tier: FinalTier;
  /** False when this machine cannot run it; `reason` says why. */
  runnable: boolean;
  reason?: string;
  /** The model the tier runs first: what no choice means. */
  recommended: boolean;
}

export function modelName(id: string): string {
  return NAMES[id] ?? (MODELS as Record<string, { label: string }>)[id]?.label ?? id;
}

/** True when this machine's tier can run the model. */
export function runsOn(id: ModelId, tier: FinalTier): boolean {
  return !needsWebGpu(id) || tier === 'webgpu';
}

/** Every measured model, most accurate first. */
export function pickerRows(tier: FinalTier): PickerRow[] {
  const recommended = FINAL_CHAIN[tier][0];
  return MODEL_IDS.filter((id) => MODELS[id].measured)
    .map((id): PickerRow => {
      const measured = MODELS[id].measured as ModelMeasured;
      const runnable = runsOn(id, tier);
      return {
        id,
        name: modelName(id),
        live: MODELS[id].role === 'live',
        accuracyPct: Math.round((100 - measured.werPassagePct) * 10) / 10,
        werPct: measured.werPassagePct,
        werSetup: measured.werSetup,
        otherTake: measured.otherTake ?? null,
        werNativePct: measured.werNativePct,
        accuracySteps: accuracySteps(measured.werPassagePct),
        rtf: measured.rtf,
        rtfSetup: measured.rtfSetup,
        speedSteps: speedSteps(measured.rtf),
        peakMemoryMb: measured.peakMemoryMb,
        memorySetup: measured.memorySetup,
        source: measured.source,
        bytes: modelBytes(id),
        needsWebGpu: needsWebGpu(id),
        tier: needsWebGpu(id) ? 'webgpu' : 'wasm',
        runnable,
        ...(runnable ? {} : { reason: 'Needs WebGPU, and this computer has no graphics adapter that can run it.' }),
        recommended: id === recommended,
      };
    })
    .sort((a, b) => a.werPct - b.werPct);
}

/** A stored choice this machine can use, or null (the tier chain). */
export function usableChoice(choice: unknown, tier: FinalTier): ModelId | null {
  if (typeof choice !== 'string' || !(MODEL_IDS as string[]).includes(choice)) return null;
  const id = choice as ModelId;
  return MODELS[id].measured && runsOn(id, tier) ? id : null;
}

/** The model the start view names: the choice, or the tier's first model. */
export function shownModel(choice: unknown, tier: FinalTier): ModelId {
  return usableChoice(choice, tier) ?? FINAL_CHAIN[tier][0];
}

/** The models the download button installs: the live model and the chosen one (no choice: the whole tier chain). */
export function modelsToDownload(choice: unknown, tier: FinalTier): ModelId[] {
  const id = usableChoice(choice, tier);
  if (!id) return modelsForTier(tier);
  return id === LIVE_MODEL_ID ? [LIVE_MODEL_ID] : [LIVE_MODEL_ID, id];
}

/**
 * The final models to try after Stop, best first, before the installed check.
 * No choice: the tier chain (and its retired models). The live model: none
 * (the live text stays). A final model: that one, then the rest of the tier
 * chain.
 */
export function chainFor(choice: unknown, tier: FinalTier): FinalModelId[] {
  const chain = chainWithRetired(FINAL_CHAIN[tier]);
  const id = usableChoice(choice, tier);
  if (!id) return chain;
  if (MODELS[id].role === 'live') return [];
  const picked = id as FinalModelId;
  return [picked, ...chain.filter((other) => other !== picked)];
}

/**
 * The installed models of a chain that run, in order: a retired model is
 * dropped where its replacement is installed (tier.ts), except the pick, which
 * always runs first when it is installed.
 */
export function installedChain(choice: unknown, installed: readonly string[]): string[] {
  const rest = withoutReplaced(installed).filter((id) => id !== choice);
  return typeof choice === 'string' && installed.includes(choice) ? [choice, ...rest] : rest;
}
