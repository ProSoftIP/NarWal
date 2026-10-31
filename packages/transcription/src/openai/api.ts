// OpenAI after-recording transcription: request, response and error shapes (board #16547).
// Sources (read 2026-10-13, see research/cloud-transcription/README.md):
// https://developers.openai.com/api/docs/guides/speech-to-text
// https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
// https://developers.openai.com/api/docs/guides/error-codes

import type { ProviderError, UploadConsent } from '../contract.ts';

export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** "Files can be up to 25 MB." Decimal megabytes, the stricter reading. */
export const OPENAI_MAX_UPLOAD_BYTES = 25_000_000;

/** Only whisper-1 returns word timestamps ("timestamp_granularities[] is only supported for whisper-1"). */
export const OPENAI_TIMED_MODEL = 'whisper-1';

/** Upload file name extension for each accepted audio type. */
export const OPENAI_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
};

export type UploadRefusedReason = 'no-consent' | 'no-key' | 'empty' | 'oversized' | 'unsupported-type';

/** Raised before any byte leaves the machine. Nothing was uploaded and nothing was billed. */
export class UploadRefused extends Error {
  reason: UploadRefusedReason;

  constructor(reason: UploadRefusedReason, message: string) {
    super(message);
    this.name = 'UploadRefused';
    this.reason = reason;
  }
}

/** The API answered 200 with a body that does not match the documented shape. */
export class InvalidProviderResponse extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`OpenAI response does not match the documented verbose_json shape: ${issues.join('; ')}`);
    this.name = 'InvalidProviderResponse';
    this.issues = issues;
  }
}

/** Consent is for one recording, one provider and narration audio only. */
export function assertOpenAiUploadConsent(recordingId: string, consent: UploadConsent | undefined): void {
  if (consent?.provider !== 'openai' || consent.recordingId !== recordingId || consent.scope !== 'narration-audio') {
    throw new UploadRefused('no-consent', 'No upload consent for this recording and OpenAI');
  }
}

export interface OpenAiUpload {
  recordingId: string;
  audio: Blob;
  consent: UploadConsent;
  language: 'en';
}

/**
 * Builds the multipart body. Refuses without consent for this recording and
 * provider, and refuses files over the limit instead of letting the API reject
 * them after the upload.
 */
export function buildOpenAiTranscriptionForm(upload: OpenAiUpload, maxBytes = OPENAI_MAX_UPLOAD_BYTES): FormData {
  assertOpenAiUploadConsent(upload.recordingId, upload.consent);
  if (upload.audio.size === 0) throw new UploadRefused('empty', 'Audio is empty');
  if (upload.audio.size > maxBytes) {
    throw new UploadRefused('oversized', `Audio is ${upload.audio.size} bytes; OpenAI accepts at most ${maxBytes}`);
  }
  const extension = OPENAI_FILE_EXTENSIONS[upload.audio.type.split(';')[0].trim().toLowerCase()];
  if (!extension) {
    throw new UploadRefused('unsupported-type', `OpenAI does not accept ${upload.audio.type || 'untyped audio'}`);
  }

  const form = new FormData();
  form.set('file', upload.audio, `narration.${extension}`);
  form.set('model', OPENAI_TIMED_MODEL);
  form.set('language', upload.language);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  return form;
}

/** A validated whisper-1 verbose_json body. Times are seconds from the start of the uploaded file. */
export interface OpenAiTimedTranscript {
  text: string;
  durationSeconds: number | null;
  words: Array<{ text: string; startSeconds: number; endSeconds: number }>;
  segments: Array<{ id: number; startSeconds: number; endSeconds: number; text: string }>;
  /** Billed audio, from `usage: { type: "duration", seconds }`. */
  billedSeconds: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Checks a 200 body against the documented verbose_json shape and returns only
 * the fields NarWal uses. Spoken text with no word list is rejected: the
 * transcript would have no word timing, which is the reason to use whisper-1.
 */
export function parseOpenAiVerboseJson(body: unknown): OpenAiTimedTranscript {
  if (!isRecord(body)) throw new InvalidProviderResponse(['body is not a JSON object']);
  const issues: string[] = [];

  const text = typeof body.text === 'string' ? body.text : '';
  if (typeof body.text !== 'string') issues.push('text is not a string');

  let durationSeconds: number | null = null;
  if (body.duration !== undefined) {
    // The reference types `duration` as a number; some responses carry it as numeric text.
    const duration = typeof body.duration === 'string' ? Number(body.duration) : body.duration;
    if (isTime(duration)) durationSeconds = duration;
    else issues.push('duration is not a non-negative number');
  }

  const words: OpenAiTimedTranscript['words'] = [];
  if (Array.isArray(body.words)) {
    body.words.forEach((word, index) => {
      if (!isRecord(word) || typeof word.word !== 'string' || !isTime(word.start) || !isTime(word.end)) {
        issues.push(`words[${index}] needs word, start and end`);
      } else if (word.end < word.start) {
        issues.push(`words[${index}] ends before it starts`);
      } else {
        words.push({ text: word.word.trim(), startSeconds: word.start, endSeconds: word.end });
      }
    });
  } else if (body.words !== undefined) {
    issues.push('words is not an array');
  } else if (text.trim() !== '') {
    issues.push('text is present but words is missing');
  }

  const segments: OpenAiTimedTranscript['segments'] = [];
  if (Array.isArray(body.segments)) {
    body.segments.forEach((segment, index) => {
      if (!isRecord(segment) || typeof segment.text !== 'string' || !isTime(segment.start) || !isTime(segment.end)) {
        issues.push(`segments[${index}] needs text, start and end`);
      } else if (segment.end < segment.start) {
        issues.push(`segments[${index}] ends before it starts`);
      } else {
        segments.push({
          id: typeof segment.id === 'number' ? segment.id : index,
          startSeconds: segment.start,
          endSeconds: segment.end,
          text: segment.text.trim(),
        });
      }
    });
  } else if (body.segments !== undefined) {
    issues.push('segments is not an array');
  }

  let billedSeconds: number | null = null;
  if (isRecord(body.usage) && body.usage.type === 'duration' && isTime(body.usage.seconds)) {
    billedSeconds = body.usage.seconds;
  }

  if (issues.length > 0) throw new InvalidProviderResponse(issues);
  // The model can emit words slightly out of order around long pauses; the session timeline is ordered.
  words.sort((a, b) => a.startSeconds - b.startSeconds);
  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  return { text, durationSeconds, words, segments, billedSeconds };
}

/** `Retry-After` is seconds or an HTTP date. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

// OpenAI's 401 text repeats the key with its middle starred out
// ("sk-proj-****abcd"): the characters left are still part of the key.
const OPENAI_KEY_TEXT = /\bsk-[A-Za-z0-9_*-]{4,}/g;

/** Takes every OpenAI key, whole or starred out, from provider text. */
export function stripOpenAiKeyText(text: string): string {
  return text.replace(OPENAI_KEY_TEXT, '[redacted]');
}

export function classifyOpenAiHttpError(
  status: number,
  body: { error?: { type?: string; code?: string | null; message?: string } } | undefined,
  retryAfterMs?: number,
): ProviderError {
  const error = body?.error ?? {};
  const message = stripOpenAiKeyText(error.message ?? `HTTP ${status}`);
  const code = error.code ?? String(status);
  const retryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };
  const base = { provider: 'openai' as const, code, message };
  // "Retrying billing, spend, or quota errors won't restore API access."
  if (error.type === 'insufficient_quota' || code === 'insufficient_quota' || code === 'credit_balance_exhausted') {
    return { ...base, kind: 'quota', retryable: false };
  }
  if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
  if (status === 429) return { ...base, kind: 'rate-limit', retryable: true, ...retryAfter };
  if (status === 400 || status === 413 || status === 415) return { ...base, kind: 'input', retryable: false };
  if (status === 408) return { ...base, kind: 'timeout', retryable: true };
  if (status >= 500) return { ...base, kind: 'provider', retryable: true, ...retryAfter };
  return { ...base, kind: 'provider', retryable: false };
}
