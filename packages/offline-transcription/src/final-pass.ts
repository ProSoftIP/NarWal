// Final transcript from captured audio (board #16544).
//
// Runs a final model (Parakeet, Whisper or Moonshine, tier.ts) over the recording
// after Stop, or over chosen time ranges as a retry. Every run produces a new immutable revision. Progress is
// checkpointed after each speech span, so a closed tab or a crashed engine
// costs one span, not the whole run. A span the engine cannot transcribe
// becomes a gap; it is never filled by another provider. A span cut
// mid-speech, or under a second long, is decoded with the audio around it
// (span-context.ts).

import { FINAL_MODEL, LOCAL_PROVIDER } from './contract.ts';
import type { SessionMs, TranscriptGap, TranscriptRevision, TranscriptSegment, TranscriptWord } from './contract.ts';
import { ModelError } from './model-store.ts';
import { SPAN_CONTEXT, contextRead, keepSpanWords } from './span-context.ts';
import type { SpanContextOptions, SpanTail } from './span-context.ts';
import { planSpeech } from './vad.ts';
import type { PcmSource, SpeechSpan, VadOptions } from './vad.ts';
import { INTERPOLATED_TIMING_METHOD, spreadWords } from './word-times.ts';

export interface FinalEngineWord {
  text: string;
  /** Seconds from the start of the audio passed to `transcribe`. */
  start: number;
  end: number;
}

/** How an engine's word times were made, and the correction the pass applies. */
export interface FinalEngineTiming {
  /** The revision's `timing.method`. */
  method: string;
  /** Subtracted from every word time. */
  biasMs: number;
}

export interface FinalEngine {
  transcribe(pcm: Float32Array): Promise<FinalEngineWord[]>;
  /**
   * `none`: the model gives text only (Moonshine). `start` and `end` are
   * ignored; the pass spreads the words over the span's speech (word-times.ts).
   */
  wordTimes?: 'model' | 'none';
  /** Whisper DTW times (`WHISPER_TIMING_BIAS_MS`) when not given. Ignored for `wordTimes: 'none'`. */
  timing?: FinalEngineTiming;
}

/**
 * Whisper word times come from attention alignment (DTW) and run late: #16539
 * measured a start bias of +0.152 s (2 min) to +0.160 s (30 min) on this model.
 * The pass subtracts this constant and marks every time `approximate`.
 */
export const WHISPER_TIMING_BIAS_MS = 150;

export interface FinalPassCheckpoint {
  version: 1;
  recordingId: string;
  revisionId: string;
  model: string;
  plan: SpeechSpan[];
  /** Span index → result. Only spans with a segment (or no speech) are skipped on resume. */
  done: Record<string, { segment?: TranscriptSegment; gap?: TranscriptGap; tail?: SpanTail }>;
}

export interface TimeRange {
  startMs: SessionMs;
  endMs: SessionMs;
}

export interface FinalPassRequest {
  recordingId: string;
  /** A new ID. A revision is never written twice. */
  revisionId: string;
  audio: PcmSource;
  /** Session time of the first sample of `audio`. Ignored when `timeMap` is given. */
  audioOriginMs?: SessionMs;
  /** Audio seconds → session ms, from `fitAudioClock` over the bundle's clock pairs. */
  timeMap?: (audioSeconds: number) => SessionMs;
  /** Retry: transcribe only speech inside these ranges (for example the gaps of `base`). */
  ranges?: TimeRange[];
  /** With `ranges`: the revision whose other segments and gaps are carried over, unchanged. */
  base?: TranscriptRevision;
  /** The revision this run replaces as the active one (it is kept). */
  supersedes?: string;
  resumeFrom?: FinalPassCheckpoint;
  onCheckpoint?: (checkpoint: FinalPassCheckpoint) => void | Promise<void>;
  onProgress?: (progress: { doneSpans: number; totalSpans: number }) => void;
  signal?: AbortSignal;
}

export interface FinalPassConfig {
  /** Loads the verified model. Rejects with ModelError when it is missing or corrupt. */
  getEngine: () => Promise<FinalEngine>;
  model?: string;
  /** Epoch ms, for `createdAtMs`. */
  now?: () => number;
  biasMs?: number;
  vad?: Partial<VadOptions>;
  /** Audio around a span (SPAN_CONTEXT). `contextS: 0` decodes bare spans. Not used for `wordTimes: 'none'`. */
  context?: Partial<SpanContextOptions>;
  /** Extra attempts per span before it becomes a gap. */
  retries?: number;
  /** This many failed spans in a row stop the run; the checkpoint stays valid. */
  maxConsecutiveFailures?: number;
}

export interface FinalPassResult {
  revision: TranscriptRevision;
  stats: { spans: number; resumedSpans: number; engineCalls: number; failedSpans: number; audioMs: number };
}

export class FinalPassStopped extends Error {
  readonly code: 'aborted' | 'engine-failed';
  constructor(code: 'aborted' | 'engine-failed', message: string) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'FinalPassStopped';
    this.code = code;
  }
}

function samePlan(a: SpeechSpan[], b: SpeechSpan[]): boolean {
  return a.length === b.length && a.every((span, i) => span.startSample === b[i].startSample && span.endSample === b[i].endSample);
}

function overlaps(startMs: number, endMs: number, ranges: TimeRange[]): boolean {
  return ranges.some((range) => startMs < range.endMs && endMs > range.startMs);
}

export async function runFinalPass(config: FinalPassConfig, request: FinalPassRequest): Promise<FinalPassResult> {
  const model = config.model ?? FINAL_MODEL;
  const retries = config.retries ?? 1;
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  const rate = request.audio.sampleRate;
  const toMs = (audioSeconds: number): SessionMs =>
    Math.round(request.timeMap ? request.timeMap(audioSeconds) : (request.audioOriginMs ?? 0) + audioSeconds * 1000);

  // Fails here, before any work, when the model is missing or corrupt.
  const engine = await config.getEngine();
  const interpolated = engine.wordTimes === 'none';
  // The model corrections do not apply to times the pass estimates itself.
  const biasMs = interpolated ? 0 : (config.biasMs ?? engine.timing?.biasMs ?? WHISPER_TIMING_BIAS_MS);

  let plan = await planSpeech(request.audio, config.vad);
  if (request.ranges) {
    const ranges = request.ranges;
    plan = plan.filter((span) => overlaps(toMs(span.startSample / rate), toMs(span.endSample / rate), ranges));
  }

  const resume = request.resumeFrom;
  const resumable = resume && resume.version === 1 && resume.recordingId === request.recordingId && resume.model === model && samePlan(resume.plan, plan);
  const checkpoint: FinalPassCheckpoint = {
    version: 1,
    recordingId: request.recordingId,
    revisionId: request.revisionId,
    model,
    plan,
    done: {},
  };
  let resumedSpans = 0;
  if (resumable) {
    for (const [index, entry] of Object.entries(resume.done)) {
      if (entry.gap) continue; // a failed span is tried again
      checkpoint.done[index] = entry.segment ? { segment: rekey(entry.segment, request.revisionId, Number(index)), ...(entry.tail ? { tail: entry.tail } : {}) } : {};
      resumedSpans += 1;
    }
  }

  let engineCalls = 0;
  let failedSpans = 0;
  let consecutiveFailures = 0;
  let audioSamples = 0;
  const context = { ...SPAN_CONTEXT, ...config.context };
  const withContext = !interpolated && context.contextS > 0;
  for (let index = 0; index < plan.length; index += 1) {
    const span = plan[index];
    if (checkpoint.done[index]) {
      audioSamples += span.endSample - span.startSample;
      continue;
    }
    if (request.signal?.aborted) throw new FinalPassStopped('aborted', 'final pass cancelled; resume from the last checkpoint');
    const read = withContext ? contextRead(plan, index, request.audio.lengthSamples, rate, context) : span;
    audioSamples += read.endSample - read.startSample;
    const pcm = await request.audio.read(read.startSample, read.endSample);
    let words: FinalEngineWord[] | null = null;
    let failure = '';
    for (let attempt = 0; attempt <= retries && !words; attempt += 1) {
      try {
        engineCalls += 1;
        words = await engine.transcribe(pcm);
      } catch (error) {
        if (error instanceof ModelError) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    const spanStartS = span.startSample / rate;
    const spanEndS = span.endSample / rate;
    if (!words) {
      failedSpans += 1;
      consecutiveFailures += 1;
      checkpoint.done[index] = {
        gap: { provider: LOCAL_PROVIDER, startMs: toMs(spanStartS), endMs: toMs(spanEndS), reason: 'engine-failed', detail: failure },
      };
      if (consecutiveFailures >= maxConsecutiveFailures) {
        await request.onCheckpoint?.(checkpoint);
        throw new FinalPassStopped('engine-failed', `final pass stopped after ${consecutiveFailures} failed spans: ${failure}`);
      }
    } else {
      consecutiveFailures = 0;
      const out: TranscriptWord[] = [];
      let floorS = spanStartS;
      const offsetS = read.startSample / rate;
      if (interpolated) {
        const texts = words.map((word) => word.text.trim()).filter(Boolean);
        const times = spreadWords(texts, pcm, { ...config.vad, sampleRate: rate });
        words = texts.map((text, i) => ({ text, ...times[i] }));
      }
      // Audio seconds from here on.
      words = words.map((word) => ({ text: word.text, start: offsetS + word.start, end: offsetS + word.end }));
      let tail: SpanTail | undefined;
      if (withContext) {
        const before = index > 0 && plan[index - 1].endSample === span.startSample ? checkpoint.done[index - 1]?.tail : undefined;
        words = keepSpanWords(words, span, read, rate, before ?? null);
        const last = words.at(-1);
        if (last) tail = { text: last.text.trim(), start: last.start };
      }
      for (const word of words) {
        const text = word.text.trim();
        if (!text) continue;
        const startS = Math.min(spanEndS, Math.max(floorS, word.start - biasMs / 1000));
        const endS = Math.min(spanEndS, Math.max(startS, word.end - biasMs / 1000));
        out.push({ text, startMs: toMs(startS), endMs: Math.max(toMs(startS), toMs(endS)) });
        floorS = startS;
      }
      checkpoint.done[index] = out.length
        ? {
            ...(tail ? { tail } : {}),
            segment: {
              provider: LOCAL_PROVIDER,
              model,
              connectionId: request.revisionId,
              segmentKey: `${request.revisionId}:${index}`,
              kind: 'final',
              startMs: out[0].startMs,
              endMs: out[out.length - 1].endMs,
              text: out.map((word) => word.text).join(' '),
              words: out,
              endOfUtterance: true,
              timing: 'approximate',
            },
          }
        : {};
    }
    await request.onCheckpoint?.(checkpoint);
    request.onProgress?.({ doneSpans: Object.keys(checkpoint.done).length, totalSpans: plan.length });
  }

  let segments: TranscriptSegment[] = [];
  let gaps: TranscriptGap[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const entry = checkpoint.done[index];
    if (entry?.segment) segments.push(entry.segment);
    if (entry?.gap) gaps.push(entry.gap);
  }
  if (request.ranges && request.base) {
    const retried = plan.map((span) => ({ startMs: toMs(span.startSample / rate), endMs: toMs(span.endSample / rate) }));
    const replaced = [...request.ranges, ...retried];
    segments = [...request.base.segments.filter((segment) => !overlaps(segment.startMs, segment.endMs, replaced)), ...segments];
    gaps = [...request.base.gaps.filter((gap) => !overlaps(gap.startMs, gap.endMs, replaced)), ...gaps];
  }
  segments.sort((a, b) => a.startMs - b.startMs);
  gaps.sort((a, b) => a.startMs - b.startMs);

  const supersedes = request.supersedes ?? request.base?.revisionId;
  return {
    revision: {
      revisionId: request.revisionId,
      provider: LOCAL_PROVIDER,
      model,
      createdAtMs: (config.now ?? Date.now)(),
      source: 'after-recording',
      segments,
      gaps,
      // A retry over a live revision keeps that revision's aligned segments next to the new ones.
      timing: {
        quality: segments.every((segment) => segment.timing === 'approximate') ? 'approximate' : 'mixed',
        method: interpolated ? INTERPOLATED_TIMING_METHOD : (engine.timing?.method ?? 'whisper-dtw'),
        correctionMs: biasMs ? -biasMs : 0,
      },
      ...(supersedes ? { supersedes } : {}),
    },
    stats: { spans: plan.length, resumedSpans, engineCalls, failedSpans, audioMs: Math.round((audioSamples / rate) * 1000) },
  };
}

function rekey(segment: TranscriptSegment, revisionId: string, index: number): TranscriptSegment {
  return { ...segment, connectionId: revisionId, segmentKey: `${revisionId}:${index}` };
}
