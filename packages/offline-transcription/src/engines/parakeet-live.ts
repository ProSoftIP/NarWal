// Parakeet on the live path (board #16617).
//
// Vosk streams words as they are spoken but gets about half of them wrong on
// Matt's reading passage (45.3% WER, #16603). Parakeet TDT is not a streaming
// model, so the live path cuts the audio into speech spans with the same
// energy VAD as the final pass and transcribes each span when it closes: the
// text of a sentence appears a pause (0.6 s) plus the decode time after it was
// spoken. A span is cut at LIVE_VAD.maxSegS, so someone who never pauses still
// sees text every few seconds.
//
// The engine answers the session's feeds in order, as LiveEngine requires: a
// feed that closes no span is answered at once with an empty partial, a feed
// that closes one is answered when its text is ready. Feeds behind it wait in
// the session, which reports a backlog and skips ahead when it grows too long.

import { ENGINE_SAMPLE_RATE } from '../audio.ts';
import type { FinalEngine, FinalEngineWord } from '../final-pass.ts';
import type { LiveEngine, LiveEngineFactory, LiveEngineMessage, LiveEngineWord } from '../live-session.ts';
import type { FinalModelId } from '../models.ts';
import { SpeechSegmenter } from '../vad.ts';
import type { SpeechSpan, VadOptions } from '../vad.ts';

export const PARAKEET_LIVE_MODEL: FinalModelId = 'parakeet-tdt-0.6b-v2-int8';

/**
 * The final pass's VAD with shorter spans. Without a pause the text of a
 * span appears up to maxSegS plus its decode time after the span began.
 * Measured (docs/validation/parakeet-live-16617): 6 s keeps the
 * passage at 12.0% WER, as 8 s does, with each word on screen 4.7 s (p50)
 * after it was spoken; 5 s gave 13.2% and 4 s 19.7%.
 */
export const LIVE_VAD: Partial<VadOptions> = { maxSegS: 6 };

export interface SpanLiveEngineOptions {
  model: string;
  /** Words of one span, seconds from the span's first sample. */
  transcribe: (pcm: Float32Array) => Promise<FinalEngineWord[]>;
  onMessage: (message: LiveEngineMessage) => void;
  /** Moved off every word time, as the final pass does (SHERPA_TIMING). */
  biasMs?: number;
  vad?: Partial<VadOptions>;
  onClose?: () => void;
}

/** A LiveEngine over a model that transcribes whole spans of audio. */
export class SpanLiveEngine implements LiveEngine {
  readonly model: string;
  readonly timing = 'approximate' as const;
  private readonly options: SpanLiveEngineOptions;
  private readonly vad: Partial<VadOptions>;
  private segmenter: SpeechSegmenter;
  /** Engine-fed sample where the current segmenter's sample 0 is. A flush starts a new one. */
  private base = 0;
  private fed = 0;
  /** Fed audio a span that is still open may need; `audioStart` is the engine-fed index of its first sample. */
  private audio: Float32Array[] = [];
  private audioStart = 0;
  private answers: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: SpanLiveEngineOptions) {
    this.options = options;
    this.model = options.model;
    this.vad = { ...LIVE_VAD, ...options.vad, sampleRate: ENGINE_SAMPLE_RATE };
    this.segmenter = new SpeechSegmenter(this.vad);
  }

  feed(samples: Float32Array): void {
    if (this.closed) return;
    this.audio.push(samples);
    this.fed += samples.length;
    const spans = this.cut(this.segmenter.push(samples));
    this.trim(this.base + this.segmenter.openFrom);
    this.answer(spans, false);
  }

  flush(): void {
    if (this.closed) return;
    const spans = this.cut(this.segmenter.flush());
    // The session may skip audio after a flush: the next feed is not contiguous with this one.
    this.segmenter = new SpeechSegmenter(this.vad);
    this.base = this.fed;
    this.trim(this.fed);
    this.answer(spans, true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.audio = [];
    this.options.onClose?.();
  }

  /** Copies each span's audio now: the buffer is trimmed before the span is transcribed. */
  private cut(spans: SpeechSpan[]): { startSample: number; endSample: number; pcm: Float32Array }[] {
    return spans.map((span) => {
      const startSample = this.base + span.startSample;
      const endSample = this.base + span.endSample;
      return { startSample, endSample, pcm: this.read(startSample, endSample) };
    });
  }

  private read(start: number, end: number): Float32Array {
    const out = new Float32Array(Math.max(0, end - start));
    let at = this.audioStart;
    for (const chunk of this.audio) {
      const from = Math.max(start, at);
      const to = Math.min(end, at + chunk.length);
      if (to > from) out.set(chunk.subarray(from - at, to - at), from - start);
      at += chunk.length;
      if (at >= end) break;
    }
    return out;
  }

  /** Drops whole chunks that end before `keepFrom`. */
  private trim(keepFrom: number): void {
    while (this.audio.length && this.audioStart + this.audio[0].length <= keepFrom) {
      this.audioStart += this.audio[0].length;
      this.audio.shift();
    }
  }

  private answer(spans: { startSample: number; endSample: number; pcm: Float32Array }[], flush: boolean): void {
    this.answers = this.answers.then(async () => {
      if (this.closed) return;
      if (!spans.length && !flush) {
        this.options.onMessage({ type: 'partial', text: '' });
        return;
      }
      const words: LiveEngineWord[] = [];
      try {
        for (const span of spans) {
          const found = await this.options.transcribe(span.pcm);
          if (this.closed) return;
          words.push(...this.place(found, span.startSample / ENGINE_SAMPLE_RATE, span.endSample / ENGINE_SAMPLE_RATE));
        }
      } catch (error) {
        if (this.closed) return;
        this.options.onMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.options.onMessage({ type: 'result', text: words.map((word) => word.word).join(' '), words });
    });
  }

  /** Span-relative words to engine-fed seconds, kept inside the span and in order, as the final pass places them. */
  private place(found: FinalEngineWord[], spanStartS: number, spanEndS: number): LiveEngineWord[] {
    const biasS = (this.options.biasMs ?? 0) / 1000;
    const out: LiveEngineWord[] = [];
    let floorS = spanStartS;
    for (const word of found) {
      const text = word.text.trim();
      if (!text) continue;
      const start = Math.min(spanEndS, Math.max(floorS, spanStartS + word.start - biasS));
      const end = Math.min(spanEndS, Math.max(start, spanStartS + word.end - biasS));
      out.push({ word: text, start, end });
      floorS = start;
    }
    return out;
  }
}

/** The runtime part the live Parakeet engine uses: a WhisperRuntime of its own. */
export interface SpanRuntime {
  getEngine(model: string): Promise<FinalEngine>;
  terminate(): void;
}

/**
 * Live engines on Parakeet. Every open engine shares one worker; it is
 * stopped when the last one closes, so its 1 GB heap is freed before the final
 * pass after Stop loads a model of its own.
 */
export function parakeetLiveFactory(runtime: SpanRuntime, options: { model?: FinalModelId; vad?: Partial<VadOptions> } = {}): LiveEngineFactory {
  const model = options.model ?? PARAKEET_LIVE_MODEL;
  let open = 0;
  return async (onMessage) => {
    let engine: FinalEngine;
    try {
      engine = await runtime.getEngine(model);
    } catch (error) {
      if (open === 0) runtime.terminate();
      throw error;
    }
    open += 1;
    return new SpanLiveEngine({
      model,
      transcribe: (pcm) => engine.transcribe(pcm),
      onMessage,
      biasMs: engine.timing?.biasMs ?? 0,
      vad: options.vad,
      onClose: () => {
        open -= 1;
        if (open === 0) runtime.terminate();
      },
    });
  };
}
