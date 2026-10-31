// OpenAI after-recording transcription pieces for NarWal. Sources (read 2026-10-13):
// https://developers.openai.com/api/docs/guides/speech-to-text
// https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
// https://developers.openai.com/api/docs/guides/error-codes

import type {
  BatchTranscriptionRequest,
  ProviderError,
  TranscriptRevision,
  TranscriptSegment,
  TranscriptWord,
} from './contract.ts';
import { providerSecondsToSessionMs } from './contract.ts';

export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** "Files can be up to 25 MB." Decimal megabytes, the stricter reading. */
export const OPENAI_MAX_UPLOAD_BYTES = 25_000_000;

/** Only whisper-1 returns word timestamps ("timestamp_granularities[] is only supported for whisper-1"). */
export const OPENAI_TIMED_MODEL = 'whisper-1';

const FILE_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
};

export class UploadRefused extends Error {}

/**
 * Builds the multipart body. Refuses without consent for this recording and
 * provider, and refuses files over the limit instead of letting the API reject
 * them after a paid-for upload attempt.
 */
export function buildOpenAiTranscriptionForm(request: BatchTranscriptionRequest): FormData {
  const { consent } = request;
  if (consent?.provider !== 'openai' || consent.recordingId !== request.recordingId || consent.scope !== 'narration-audio') {
    throw new UploadRefused('No upload consent for this recording and OpenAI');
  }
  if (request.audio.size > OPENAI_MAX_UPLOAD_BYTES) {
    throw new UploadRefused(`Audio is ${request.audio.size} bytes; OpenAI accepts at most ${OPENAI_MAX_UPLOAD_BYTES}`);
  }
  const mimeBase = request.audio.type.split(';')[0].trim();
  const extension = FILE_EXTENSIONS[mimeBase];
  if (!extension) throw new UploadRefused(`OpenAI does not accept ${request.audio.type || 'untyped audio'}`);

  const form = new FormData();
  form.set('file', request.audio, `narration.${extension}`);
  form.set('model', OPENAI_TIMED_MODEL);
  form.set('language', request.language);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  return form;
}

/**
 * Splits a recording longer than one upload into time ranges. Each range is
 * re-encoded by the caller and sent with its own audioOriginMs, so word times
 * land on the session clock.
 */
export function planUploadRanges(durationMs: number, bytesPerSecond: number, maxBytes = OPENAI_MAX_UPLOAD_BYTES) {
  if (durationMs <= 0 || bytesPerSecond <= 0) throw new RangeError('duration and byte rate must be positive');
  // Keep 5% headroom for container overhead.
  const maxMs = Math.floor(((maxBytes * 0.95) / bytesPerSecond) * 1000);
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  for (let startMs = 0; startMs < durationMs; startMs += maxMs) {
    ranges.push({ startMs, endMs: Math.min(durationMs, startMs + maxMs) });
  }
  return ranges;
}

interface VerboseJson {
  text?: string;
  duration?: number;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

export function normalizeOpenAiVerboseJson(
  body: VerboseJson,
  context: { audioOriginMs: number; revisionId: string; createdAtMs: number },
): TranscriptRevision {
  const { audioOriginMs } = context;
  const words: TranscriptWord[] = (body.words ?? []).map((word) => ({
    text: word.word,
    startMs: providerSecondsToSessionMs(audioOriginMs, word.start),
    endMs: providerSecondsToSessionMs(audioOriginMs, word.end),
  }));
  const connectionId = context.revisionId;
  const segments: TranscriptSegment[] = (body.segments ?? []).map((segment) => {
    const startMs = providerSecondsToSessionMs(audioOriginMs, segment.start);
    const endMs = providerSecondsToSessionMs(audioOriginMs, segment.end);
    return {
      provider: 'openai',
      model: OPENAI_TIMED_MODEL,
      connectionId,
      segmentKey: `${connectionId}:${segment.id}`,
      kind: 'final',
      startMs,
      endMs,
      text: segment.text.trim(),
      // A word belongs to the segment that contains its midpoint.
      words: words.filter((word) => {
        const mid = (word.startMs + word.endMs) / 2;
        return mid >= startMs && mid < endMs;
      }),
      endOfUtterance: true,
    };
  });
  return {
    revisionId: context.revisionId,
    provider: 'openai',
    model: OPENAI_TIMED_MODEL,
    createdAtMs: context.createdAtMs,
    source: 'after-recording',
    segments,
    gaps: [],
  };
}

export function classifyOpenAiHttpError(
  status: number,
  body: { error?: { type?: string; code?: string; message?: string } } | undefined,
  retryAfterHeader?: string | null,
): ProviderError {
  const error = body?.error ?? {};
  const message = error.message ?? `HTTP ${status}`;
  const code = error.code ?? String(status);
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const retryAfter = Number.isFinite(retryAfterSeconds) ? { retryAfterMs: retryAfterSeconds * 1000 } : {};
  const base = { provider: 'openai' as const, code, message };
  // "Retrying billing, spend, or quota errors won't restore API access."
  if (error.type === 'insufficient_quota' || code === 'credit_balance_exhausted') {
    return { ...base, kind: 'quota', retryable: false };
  }
  if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
  if (status === 429) return { ...base, kind: 'rate-limit', retryable: true, ...retryAfter };
  if (status === 400 || status === 413 || status === 415) return { ...base, kind: 'input', retryable: false };
  if (status === 408) return { ...base, kind: 'timeout', retryable: true };
  if (status >= 500) return { ...base, kind: 'provider', retryable: true, ...retryAfter };
  return { ...base, kind: 'provider', retryable: false };
}
