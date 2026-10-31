// Splitting a long narration into uploads, and joining the answers on the session clock (board #16547).
// Every time in this file is milliseconds. "File clock" starts at the first sample of the
// narration file; the session clock adds the file's `audioOriginMs`.

import type { ProviderId, SessionMs, TranscriptSegment, TranscriptWord } from '../contract.ts';
import { providerSecondsToSessionMs } from '../contract.ts';
import type { OpenAiTimedTranscript } from './api.ts';

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface UploadChunk {
  index: number;
  /** The part of the file this upload is the planned owner of. Core ranges tile the file. */
  core: TimeRange;
  /** The audio actually uploaded: the core plus half the overlap on each inner side. */
  upload: TimeRange;
}

export interface ChunkPlanInput {
  durationMs: number;
  /** Byte rate of the audio as it will be uploaded. */
  bytesPerSecond: number;
  /** Fixed container bytes in each upload, e.g. a 44-byte WAV header. */
  headerBytes?: number;
  maxBytes: number;
  /** Audio two neighbouring uploads share, so no word is cut in half. */
  overlapMs: number;
  /** Optional shorter limit on one upload's length. */
  maxChunkMs?: number;
}

/**
 * Plans uploads that each fit `maxBytes`. Cores have equal length, so the last
 * upload is never a fragment too short to transcribe well.
 */
export function planUploadChunks(input: ChunkPlanInput): UploadChunk[] {
  const { durationMs, bytesPerSecond, maxBytes, overlapMs } = input;
  const headerBytes = input.headerBytes ?? 0;
  if (!(durationMs > 0) || !(bytesPerSecond > 0)) throw new RangeError('duration and byte rate must be positive');
  if (overlapMs < 0) throw new RangeError('overlap must not be negative');

  // 1% headroom covers frame rounding at both ends of a slice.
  let maxUploadMs = Math.floor((((maxBytes - headerBytes) * 0.99) / bytesPerSecond) * 1000);
  if (input.maxChunkMs !== undefined) maxUploadMs = Math.min(maxUploadMs, input.maxChunkMs);
  if (durationMs <= maxUploadMs) {
    const whole = { startMs: 0, endMs: durationMs };
    return [{ index: 0, core: whole, upload: { ...whole } }];
  }
  const maxCoreMs = maxUploadMs - overlapMs;
  if (maxCoreMs <= overlapMs) throw new RangeError('upload limit is too small for this overlap');

  const count = Math.ceil(durationMs / maxCoreMs);
  const coreMs = Math.ceil(durationMs / count);
  const half = Math.floor(overlapMs / 2);
  const chunks: UploadChunk[] = [];
  for (let index = 0; index < count; index += 1) {
    const core = { startMs: index * coreMs, endMs: Math.min(durationMs, (index + 1) * coreMs) };
    chunks.push({
      index,
      core,
      upload: {
        startMs: index === 0 ? 0 : core.startMs - half,
        endMs: index === count - 1 ? durationMs : core.endMs + half,
      },
    });
  }
  return chunks;
}

/** Fewer milliseconds per word than this is not speech. */
const MIN_SPOKEN_WORD_MS = 50;
/** How close to the end of the audio a segment must end to count as its tail. */
const TAIL_WINDOW_SECONDS = 0.1;

/**
 * Removes what whisper-1 adds when an upload ends in silence: segments with no
 * text, and a phrase pressed into the last few milliseconds (seen live: a
 * repeated "Number 10." given 40 ms). Only the tail is checked; a segment
 * elsewhere is kept as the provider sent it.
 */
export function dropUnspokenTail(transcript: OpenAiTimedTranscript): OpenAiTimedTranscript {
  const segments = transcript.segments.filter((segment) => segment.text !== '');
  const audioEnd = Math.max(transcript.durationSeconds ?? 0, ...segments.map((segment) => segment.endSeconds));
  let words = transcript.words;
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    const spokenMs = (last.endSeconds - last.startSeconds) * 1000;
    const wordCount = last.text.split(/\s+/).filter(Boolean).length;
    if (last.endSeconds < audioEnd - TAIL_WINDOW_SECONDS || spokenMs >= wordCount * MIN_SPOKEN_WORD_MS) break;
    segments.pop();
    words = words.filter((word) => word.startSeconds < last.startSeconds);
  }
  if (segments.length === transcript.segments.length) return transcript;
  return { ...transcript, segments, words };
}

/** One upload's answer, moved to the session clock. */
export interface ChunkTranscript {
  index: number;
  /** Uploaded range on the session clock. `endMs` is the provider's duration when the plan had none. */
  range: TimeRange;
  words: TranscriptWord[];
  segments: Array<{ id: number; startMs: SessionMs; endMs: SessionMs; text: string }>;
}

/**
 * Moves provider seconds to the session clock. `uploadStartMs` is where this
 * upload starts on the file clock; the provider clock starts at 0 for each file.
 */
export function toChunkTranscript(
  transcript: OpenAiTimedTranscript,
  context: { index: number; audioOriginMs: SessionMs; uploadStartMs: number; uploadEndMs: number | null },
): ChunkTranscript {
  const origin = context.audioOriginMs + context.uploadStartMs;
  const providerEndMs = Math.max(
    Math.round((transcript.durationSeconds ?? 0) * 1000),
    ...transcript.words.map((word) => Math.round(word.endSeconds * 1000)),
    ...transcript.segments.map((segment) => Math.round(segment.endSeconds * 1000)),
    0,
  );
  const endMs =
    context.uploadEndMs === null ? origin + providerEndMs : context.audioOriginMs + context.uploadEndMs;
  // The model can place a last word past the end of the audio; no word may leave its upload.
  const clamp = (ms: SessionMs) => Math.min(Math.max(ms, origin), endMs);
  return {
    index: context.index,
    range: { startMs: origin, endMs },
    words: transcript.words.map((word) => ({
      text: word.text,
      startMs: clamp(providerSecondsToSessionMs(origin, word.startSeconds)),
      endMs: clamp(providerSecondsToSessionMs(origin, word.endSeconds)),
    })),
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      startMs: clamp(providerSecondsToSessionMs(origin, segment.startSeconds)),
      endMs: clamp(providerSecondsToSessionMs(origin, segment.endSeconds)),
      text: segment.text,
    })),
  };
}

const midpoint = (item: { startMs: number; endMs: number }) => (item.startMs + item.endMs) / 2;

/**
 * Picks where the earlier upload stops owning words and the later one starts.
 * Both uploads transcribed the zone; a cut inside a word would drop or repeat
 * it, so the cut goes in the middle of the longest silence the earlier upload
 * heard there. With no silence to use, the planned boundary stands.
 */
export function chooseCut(zone: TimeRange, plannedMs: SessionMs, earlierWords: TranscriptWord[]): SessionMs {
  const inZone = earlierWords
    .filter((word) => word.endMs > zone.startMs && word.startMs < zone.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (inZone.length === 0) return plannedMs;

  let best = { width: 0, cut: plannedMs };
  const consider = (startMs: number, endMs: number) => {
    const from = Math.max(startMs, zone.startMs);
    const to = Math.min(endMs, zone.endMs);
    if (to - from > best.width) best = { width: to - from, cut: Math.round((from + to) / 2) };
  };
  consider(zone.startMs, inZone[0].startMs);
  for (let index = 1; index < inZone.length; index += 1) consider(inZone[index - 1].endMs, inZone[index].startMs);
  consider(inZone[inZone.length - 1].endMs, zone.endMs);
  return best.cut;
}

function nearestSegmentIndex(segments: ChunkTranscript['segments'], word: TranscriptWord): number {
  const mid = midpoint(word);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  segments.forEach((segment, index) => {
    const distance = mid < segment.startMs ? segment.startMs - mid : mid >= segment.endMs ? mid - segment.endMs : -1;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export interface MergeContext {
  provider: ProviderId;
  model: string;
  revisionId: string;
}

/**
 * Joins consecutive uploads into contract segments. Each word is kept from
 * exactly one upload: the one that owns the word's midpoint. A segment that
 * crosses a cut keeps only its own words, and its text is rebuilt from them.
 */
export function mergeChunkTranscripts(chunks: ChunkTranscript[], context: MergeContext): TranscriptSegment[] {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const cuts: SessionMs[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const earlier = ordered[index - 1];
    const later = ordered[index];
    const zone = { startMs: later.range.startMs, endMs: earlier.range.endMs };
    cuts.push(
      zone.endMs > zone.startMs
        ? chooseCut(zone, Math.round((zone.startMs + zone.endMs) / 2), earlier.words)
        : later.range.startMs,
    );
  }

  const merged: TranscriptSegment[] = [];
  ordered.forEach((chunk, position) => {
    const fromMs = position === 0 ? Number.NEGATIVE_INFINITY : cuts[position - 1];
    const toMs = position === ordered.length - 1 ? Number.POSITIVE_INFINITY : cuts[position];
    const owns = (item: { startMs: number; endMs: number }) => midpoint(item) >= fromMs && midpoint(item) < toMs;

    // Text with words but no segment list still becomes one utterance.
    const segments =
      chunk.segments.length > 0 || chunk.words.length === 0
        ? chunk.segments
        : [
            {
              id: 0,
              startMs: chunk.words[0].startMs,
              endMs: chunk.words[chunk.words.length - 1].endMs,
              text: chunk.words.map((word) => word.text).join(' '),
            },
          ];
    const wordsBySegment: TranscriptWord[][] = segments.map(() => []);
    for (const word of chunk.words) wordsBySegment[nearestSegmentIndex(segments, word)].push(word);

    segments.forEach((segment, index) => {
      const all = wordsBySegment[index];
      const kept = all.filter(owns);
      if (all.length === 0 ? !owns(segment) : kept.length === 0) return;
      const trimmed = kept.length < all.length;
      // A segment's silence can reach over the cut; its bounds stay inside what this upload owns.
      const startMs = Math.max(trimmed ? kept[0].startMs : segment.startMs, Math.min(fromMs, kept[0]?.startMs ?? fromMs));
      const endMs = Math.min(trimmed ? kept[kept.length - 1].endMs : segment.endMs, Math.max(toMs, kept[kept.length - 1]?.endMs ?? toMs));
      merged.push({
        provider: context.provider,
        model: context.model,
        connectionId: `${context.revisionId}:${chunk.index}`,
        segmentKey: `${context.revisionId}:${chunk.index}:${segment.id}`,
        kind: 'final',
        startMs,
        endMs: Math.max(startMs, endMs),
        text: trimmed ? kept.map((word) => word.text).join(' ') : segment.text,
        words: kept,
        endOfUtterance: true,
      });
    });
  });
  merged.sort((a, b) => a.startMs - b.startMs);
  return merged;
}
