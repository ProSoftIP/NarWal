// Audio context around a speech span (board #16621).
//
// The VAD cuts a long run of speech at a short pause (vad.ts, maxSegS). A
// model that hears a span starting or ending mid-sentence guesses the words at
// the cut, and a span under a second (a click, a breath) makes it invent one.
// #16621 measured Parakeet at 9.0% WER on the passage with bare spans and 5.1%
// on the whole file. Decoding such a span with 2 s of the audio around it, and
// keeping only the words that start inside the span, gave 5.6%.
//
// The words of a decode are kept by start time, so a word that straddles a cut
// lands in one span. When the two decodes disagree on which side it starts, the
// word is kept once: a repeated first word is dropped, and a word the next
// decode heard just before the cut, which the span before did not end with, is
// kept.

import type { FinalEngineWord } from './final-pass.ts';
import type { SpeechSpan } from './vad.ts';

export interface SpanContextOptions {
  /** Seconds of audio read on each side of a span that needs context. */
  contextS: number;
  /** A span shorter than this gets context on both sides even with silence around it. */
  shortSpanS: number;
}

export const SPAN_CONTEXT: SpanContextOptions = { contextS: 2, shortSpanS: 1 };

/** How far before a cut a word the span before missed may start. */
const CUT_SLACK_S = 0.5;
/** A repeated word within this of the previous span's last word is the same word. */
const SAME_WORD_S = 0.5;
/** The recovered word must start this much after the previous span's last word. */
const MIN_GAP_S = 0.1;

/** The audio to decode for `plan[index]`: the span, widened at a mid-speech cut or when the span is short. */
export function contextRead(plan: SpeechSpan[], index: number, lengthSamples: number, sampleRate: number, options: SpanContextOptions = SPAN_CONTEXT): SpeechSpan {
  const span = plan[index];
  const pad = Math.round(options.contextS * sampleRate);
  const short = span.endSample - span.startSample < options.shortSpanS * sampleRate;
  const cutBefore = index > 0 && plan[index - 1].endSample === span.startSample;
  const cutAfter = index + 1 < plan.length && plan[index + 1].startSample === span.endSample;
  return {
    startSample: short || cutBefore ? Math.max(0, span.startSample - pad) : span.startSample,
    endSample: short || cutAfter ? Math.min(lengthSamples, span.endSample + pad) : span.endSample,
  };
}

/** The last word a span kept, in audio seconds; carried to the span after a cut. */
export interface SpanTail {
  text: string;
  start: number;
}

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The words of one span from a decode of `read` (contextRead). Times are in
 * audio seconds. A side that was not widened keeps every word; the pass clamps
 * its times. `previous` is the last word of the span before when the two spans
 * share a cut, else null.
 */
export function keepSpanWords(words: FinalEngineWord[], span: SpeechSpan, read: SpeechSpan, sampleRate: number, previous: SpanTail | null): FinalEngineWord[] {
  const startS = span.startSample / sampleRate;
  const lower = read.startSample < span.startSample ? startS : -Infinity;
  const upper = read.endSample > span.endSample ? span.endSample / sampleRate : Infinity;
  const heard = words.filter((word) => word.text.trim());
  let kept = heard.filter((word) => word.start >= lower && word.start < upper);
  if (!previous) return kept;
  if (kept.length && normal(kept[0].text) === normal(previous.text) && Math.abs(kept[0].start - previous.start) < SAME_WORD_S) kept = kept.slice(1);
  const before = heard.filter((word) => word.start >= startS - CUT_SLACK_S && word.start < startS).at(-1);
  if (before && normal(before.text) !== normal(previous.text) && before.start > previous.start + MIN_GAP_S) kept = [before, ...kept];
  return kept;
}
