// Timing and revision contract for browser-local transcription (board #16544).
//
// This is the cloud contract (packages/transcription/src/contract.ts) and the
// revision file of docs/bundle-schema.md §8.1, with the additions an offline
// engine needs. Shapes that exist in the cloud contract keep their field names
// and meaning, so one consumer reads both, and a local revision goes into the
// shared history (`addRevision`) unchanged: test/shared-contract.test.ts proves
// it. Additions are marked "local".
// Erasable TypeScript only, so `node --test` runs it without a build step.

export type CloudProviderId = 'deepgram' | 'assemblyai' | 'openai';
/** Local: the offline option is one provider with two models. */
export type LocalProviderId = 'browser-local';
export type ProviderId = CloudProviderId | LocalProviderId;

export const LOCAL_PROVIDER: LocalProviderId = 'browser-local';
/** Model names as docs/bundle-schema.md §8.1 lists them. */
export const LIVE_MODEL = 'vosk-small-en-us';
export const FINAL_MODEL = 'whisper-base.en-q8';

/** Milliseconds on the recording's session clock (0 = recording start). */
export type SessionMs = number;

/**
 * Local: how far to trust the times of a segment.
 * - `aligned`: word times come from the engine's own alignment (Vosk finals).
 * - `approximate`: times are estimates. Whisper word times come from attention
 *   alignment with a constant correction; Moonshine word times are spread over
 *   the span's speech (word-times.ts); interim text has no word times at all.
 */
export type TimingQuality = 'aligned' | 'approximate';

export interface TranscriptWord {
  text: string;
  startMs: SessionMs;
  endMs: SessionMs;
  /** 0..1 when the engine reports it; absent otherwise. */
  confidence?: number;
}

/**
 * One utterance on the session clock. An interim segment is replaced by the
 * next segment carrying the same `segmentKey`; a final one is never replaced
 * by the same connection. A final with empty text retracts its interim.
 */
export interface TranscriptSegment {
  provider: ProviderId;
  model: string;
  connectionId: string;
  segmentKey: string;
  kind: 'interim' | 'final';
  startMs: SessionMs;
  endMs: SessionMs;
  text: string;
  words: TranscriptWord[];
  endOfUtterance: boolean;
  /** Local. Absent means `aligned` (cloud adapters do not set it). */
  timing?: TimingQuality;
}

export type CloudGapReason =
  | 'connect-failed'
  | 'disconnected'
  | 'provider-error'
  | 'rate-limited'
  | 'auth-failed'
  | 'user-stopped-provider';

/** Local reasons. A bundle stores them as `not-transcribed` plus `detail`. */
export type LocalGapReason =
  | 'model-missing' // no verified model on this machine when the audio arrived
  | 'model-corrupt' // a stored model file failed its hash check
  | 'engine-failed' // the runtime crashed, stalled or could not start
  | 'engine-behind' // live recognition fell too far behind and skipped ahead
  | 'not-transcribed'; // audio no run has covered yet

export type GapReason = CloudGapReason | LocalGapReason;

/** Audio the engine never transcribed. Capture continues; the gap is evidence. */
export interface TranscriptGap {
  provider: ProviderId;
  startMs: SessionMs;
  endMs: SessionMs;
  reason: GapReason;
  detail?: string;
}

export type ErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'input'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'model'; // local: model missing, corrupt or not loadable

export interface ProviderError {
  provider: ProviderId;
  kind: ErrorKind;
  retryable: boolean;
  /** Stable code as text: `model-missing`, `model-corrupt`, `engine-stalled`, … */
  code: string;
  message: string;
  retryAfterMs?: number;
}

export type AdapterState = 'connecting' | 'open' | 'closing' | 'closed';

export type AdapterEvent =
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'gap'; gap: TranscriptGap }
  | { type: 'error'; error: ProviderError }
  | { type: 'state'; state: AdapterState }
  | { type: 'usage'; provider: ProviderId; audioSeconds: number; basis: string }
  /**
   * Local: live recognition is `lagMs` behind the captured audio. `behind` turns
   * true above the threshold ("catching up") and false again once it recovers.
   * Capture is never slowed or dropped because of it.
   */
  | { type: 'backlog'; behind: boolean; lagMs: number };

export type AudioFormat =
  | { kind: 'container'; mimeType: string }
  | { kind: 'pcm_s16le'; sampleRate: number; channels: 1 };

export interface LocalLiveOptions {
  language: 'en';
  /** Session time of the first audio sample this session will receive. */
  audioOriginMs: SessionMs;
  connectionId: string;
}

/**
 * Same surface as the cloud `LiveTranscriptionAdapter`, without a credential:
 * the offline option has none and never opens a network connection.
 */
export interface LocalLiveAdapter {
  readonly provider: LocalProviderId;
  readonly audioFormat: AudioFormat;
  start(options: LocalLiveOptions, onEvent: (event: AdapterEvent) => void): Promise<void>;
  /** Contiguous 16 kHz mono PCM16 starting at audioOriginMs. Never blocks, never throws. */
  sendAudio(chunk: ArrayBuffer): void;
  /** Flush pending words as finals, then close. */
  finish(): Promise<void>;
  /** Close immediately; pending interim segments are dropped, not promoted. */
  abort(): void;
}

/** Local: where the times of a revision come from. */
export interface RevisionTiming {
  /** `mixed`: a retry that kept aligned segments of its base next to approximate new ones. */
  quality: TimingQuality | 'mixed';
  /** `vosk-alignment`, `whisper-dtw`, or `span-interpolated` (text-only models, word-times.ts). */
  method: string;
  /** Constant already added to every word time of this revision, in ms. */
  correctionMs: number;
}

/** An engine transcript is a new revision; it never edits user corrections. */
export interface TranscriptRevision {
  revisionId: string;
  provider: ProviderId;
  model: string;
  createdAtMs: number;
  source: 'live' | 'after-recording';
  segments: TranscriptSegment[];
  gaps: TranscriptGap[];
  /** Local. */
  timing?: RevisionTiming;
  /** Local: the revision this run retried or finalized. It stays untouched. */
  supersedes?: string;
}

/** Engine seconds are relative to the first audio sample of one connection or file. */
export function providerSecondsToSessionMs(audioOriginMs: SessionMs, seconds: number): SessionMs {
  return audioOriginMs + Math.round(seconds * 1000);
}

export function localError(code: string, message: string, kind: ErrorKind = 'provider', retryable = false): ProviderError {
  return { provider: LOCAL_PROVIDER, kind, retryable, code, message };
}
