// Explicit retry of a transcript gap from the recorder's local narration audio.
// The recorder keeps every chunk whether transcription worked or not, so a gap
// left by a dropped or refused connection can be sent again later, on the
// user's request, to the same provider. Never automatic, never another provider.

import type { SessionMs, TranscriptGap, TranscriptRevision } from './contract.ts';
import type { LiveTranscriptResult, LiveTranscriptionSession, PcmChunk } from './live-session.ts';
import type { Timers } from './socket.ts';
import { realTimers } from './socket.ts';

export interface RetranscribeGapOptions {
  gap: TranscriptGap;
  /** Reads the recorder's local narration PCM covering [startMs, endMs). */
  readPcm(startMs: SessionMs, endMs: SessionMs): AsyncIterable<PcmChunk>;
  /** A fresh session for the gap's provider. */
  createSession(): LiveTranscriptionSession;
  sampleRate?: number;
  /** Send speed relative to real time. Live providers process at most about 1.25x. */
  paceFactor?: number;
  timers?: Timers;
  signal?: AbortSignal;
}

export async function retranscribeGap(options: RetranscribeGapOptions): Promise<LiveTranscriptResult> {
  const timers = options.timers ?? realTimers;
  const bytesPerMs = ((options.sampleRate ?? 16_000) * 2) / 1000;
  const pace = options.paceFactor ?? 1.2;
  const session = options.createSession();
  const startedAt = timers.now();
  let sentMs = 0;
  for await (const chunk of options.readPcm(options.gap.startMs, options.gap.endMs)) {
    if (options.signal?.aborted) {
      session.abort();
      throw options.signal.reason ?? new Error('Gap retry aborted');
    }
    session.pushAudio(chunk);
    sentMs += chunk.data.byteLength / bytesPerMs;
    const wait = startedAt + sentMs / pace - timers.now();
    if (wait > 0) await new Promise<void>((resolve) => timers.setTimeout(resolve, wait));
  }
  return session.finish();
}

/**
 * Builds a new revision: the base revision with one gap replaced by what the
 * retry produced inside it. The base revision is not modified.
 */
export function applyGapRetry(
  base: TranscriptRevision,
  gap: TranscriptGap,
  retry: TranscriptRevision,
  identity: { revisionId: string; createdAtMs: number },
): TranscriptRevision {
  if (retry.provider !== base.provider || gap.provider !== base.provider) {
    throw new Error('A gap is retried only with the provider that left it');
  }
  const overlaps = (item: { startMs: SessionMs; endMs: SessionMs }) => item.startMs < gap.endMs && item.endMs > gap.startMs;
  const sameGap = (item: TranscriptGap) =>
    item.startMs === gap.startMs && item.endMs === gap.endMs && item.reason === gap.reason;
  const retryGaps = retry.gaps.filter(overlaps).map((item) => ({
    ...item,
    startMs: Math.max(item.startMs, gap.startMs),
    endMs: Math.min(item.endMs, gap.endMs),
  }));
  return {
    ...base,
    revisionId: identity.revisionId,
    createdAtMs: identity.createdAtMs,
    segments: [...base.segments, ...retry.segments.filter(overlaps)].sort((a, b) => a.startMs - b.startMs),
    gaps: [...base.gaps.filter((item) => !sameGap(item)), ...retryGaps].sort((a, b) => a.startMs - b.startMs),
  };
}
