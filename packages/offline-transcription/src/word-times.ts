// Word times for a model that gives text only (board #16609).
//
// Moonshine returns the text of a speech span and no times. The final pass
// spreads the words over the span's speech: the 20 ms windows the VAD counts
// as voiced (vad.ts), with pauses shorter than `shortPauseS` counted as
// speech. Each word gets a share of that speech time in proportion to its
// length in characters, so a long pause inside the span holds no word. The
// times are estimates; the pass marks them `approximate`.

import { DEFAULT_VAD } from './vad.ts';
import type { VadOptions } from './vad.ts';

export const INTERPOLATED_TIMING_METHOD = 'span-interpolated';

export interface SpreadWord {
  /** Seconds from the start of the span. */
  start: number;
  end: number;
}

interface Voiced {
  startS: number;
  endS: number;
}

/** Voiced stretches of `pcm`, with short pauses bridged. All of it when nothing is voiced. */
function voicedStretches(pcm: Float32Array, o: VadOptions): Voiced[] {
  const window = Math.round(o.sampleRate / 50);
  const out: Voiced[] = [];
  for (let offset = 0; offset < pcm.length; offset += window) {
    const end = Math.min(pcm.length, offset + window);
    let energy = 0;
    for (let i = offset; i < end; i += 1) energy += pcm[i] * pcm[i];
    if (Math.sqrt(energy / (end - offset)) <= o.vadRms) continue;
    const startS = offset / o.sampleRate;
    const endS = end / o.sampleRate;
    const last = out[out.length - 1];
    if (last && startS - last.endS <= o.shortPauseS) last.endS = endS;
    else out.push({ startS, endS });
  }
  return out.length ? out : [{ startS: 0, endS: pcm.length / o.sampleRate }];
}

/** Characters that take time to say; at least 1, so a lone symbol still gets a share. */
function weight(word: string): number {
  return Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, '').length);
}

/**
 * Start and end of each word, in seconds from the start of `pcm`. Words are in
 * order, do not overlap and lie inside voiced audio.
 */
export function spreadWords(words: string[], pcm: Float32Array, vad: Partial<VadOptions> = {}): SpreadWord[] {
  if (!words.length) return [];
  const stretches = voicedStretches(pcm, { ...DEFAULT_VAD, ...vad });
  const speechS = stretches.reduce((sum, stretch) => sum + stretch.endS - stretch.startS, 0);
  const weights = words.map(weight);
  const total = weights.reduce((sum, value) => sum + value, 0);

  // Speech time → time in the span. `atEnd` keeps a boundary that falls
  // between two stretches on the earlier one, so a word does not end after a pause.
  const place = (speech: number, atEnd: boolean): number => {
    let left = speech;
    for (let i = 0; i < stretches.length; i += 1) {
      const length = stretches[i].endS - stretches[i].startS;
      if (left < length || (atEnd && left <= length) || i === stretches.length - 1) return stretches[i].startS + Math.min(left, length);
      left -= length;
    }
    return stretches[stretches.length - 1].endS;
  };

  const out: SpreadWord[] = [];
  let done = 0;
  for (const value of weights) {
    const from = (done / total) * speechS;
    done += value;
    const to = (done / total) * speechS;
    out.push({ start: place(from, false), end: place(to, true) });
  }
  return out;
}
