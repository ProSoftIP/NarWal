// Audio helpers for the offline engines (board #16544). Both engines take
// 16 kHz mono. Live audio arrives as PCM16 (the cloud adapters' format) or
// Float32; captured audio is decoded from the bundle's narration file.

import type { SessionMs } from './contract.ts';

export const ENGINE_SAMPLE_RATE = 16000;

export function pcm16ToFloat(chunk: ArrayBuffer): Float32Array {
  const input = new Int16Array(chunk, 0, Math.floor(chunk.byteLength / 2));
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] / 0x8000;
  return out;
}

export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    // Same scale as pcm16ToFloat, so PCM16 → Float32 → PCM16 returns every value unchanged.
    out[i] = Math.min(0x7fff, Math.round(value * 0x8000));
  }
  return out.buffer;
}

/**
 * Streaming resampler to 16 kHz for a capture tap that runs at the device rate
 * (usually 48 kHz). Windowed-sinc low-pass, so speech above 8 kHz does not alias.
 */
export class StreamResampler {
  private readonly ratio: number;
  private readonly half: number;
  private readonly cutoff: number;
  private history = new Float32Array(0);
  /** Input index (in all samples seen) of history[0]. */
  private historyStart = 0;
  private nextOut = 0;

  constructor(inputRate: number, outputRate: number = ENGINE_SAMPLE_RATE, taps = 24) {
    this.ratio = inputRate / outputRate;
    this.cutoff = Math.min(1, outputRate / inputRate);
    this.half = Math.ceil(taps / this.cutoff / 2);
  }

  push(input: Float32Array): Float32Array {
    const data = new Float32Array(this.history.length + input.length);
    data.set(this.history);
    data.set(input, this.history.length);
    const end = this.historyStart + data.length;
    const out: number[] = [];
    for (;;) {
      const center = this.nextOut * this.ratio;
      const last = Math.floor(center) + this.half;
      if (last >= end) break;
      const first = Math.floor(center) - this.half + 1;
      let sum = 0;
      let weight = 0;
      for (let index = Math.max(first, this.historyStart); index <= last; index += 1) {
        const x = (index - center) * this.cutoff;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const hann = 0.5 + 0.5 * Math.cos((Math.PI * (index - center)) / this.half);
        const w = sinc * hann;
        sum += data[index - this.historyStart] * w;
        weight += w;
      }
      out.push(weight ? sum / weight : 0);
      this.nextOut += 1;
    }
    const keepFrom = Math.max(this.historyStart, Math.floor(this.nextOut * this.ratio) - this.half + 1);
    this.history = data.slice(keepFrom - this.historyStart);
    this.historyStart = keepFrom;
    return Float32Array.from(out);
  }
}

/**
 * Decodes a captured narration file (WebM/Opus, FLAC, WAV) to 16 kHz mono.
 * Needs a document (page or offscreen document); workers have no AudioContext.
 */
export async function decodeToEnginePcm(data: ArrayBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, ENGINE_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(data);
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i += 1) mono[i] += samples[i] / buffer.numberOfChannels;
  }
  return mono;
}

export interface AudioClockPair {
  frames: number;
  sampleRate: number;
  atMs: SessionMs;
}

/**
 * Places decoded audio on the session clock from the bundle's `audio/clock.jsonl`
 * (docs/bundle-schema.md §6.3): least-squares line through the pairs, never
 * `frames / sampleRate` (the render clock drifted −270 ppm in #16538).
 * Returns seconds-of-audio → session ms.
 */
export function fitAudioClock(pairs: AudioClockPair[]): (audioSeconds: number) => SessionMs {
  if (pairs.length === 0) return (seconds) => seconds * 1000;
  const xs = pairs.map((pair) => pair.frames / pair.sampleRate);
  const ys = pairs.map((pair) => pair.atMs);
  if (pairs.length === 1) return (seconds) => ys[0] + (seconds - xs[0]) * 1000;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  const slope = sxx > 0 ? sxy / sxx : 1000;
  return (seconds) => meanY + slope * (seconds - meanX);
}
