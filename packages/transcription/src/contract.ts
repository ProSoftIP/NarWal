// Proposed provider-neutral transcription contract for NarWal (board #16540).
// Research artifact: implementation slices H/I/J (#16545-#16547) adopt or revise it.
// Erasable TypeScript only, so `node --test` runs it without a build step.

/** `browser-local` is the offline option (packages/offline-transcription, board #16544). */
export type ProviderId = 'deepgram' | 'assemblyai' | 'openai' | 'browser-local';

/**
 * How far to trust the times of a segment. `approximate` times are estimates
 * (Whisper attention alignment with a constant correction). Absent means `aligned`.
 */
export type TimingQuality = 'aligned' | 'approximate';

/** Milliseconds on the recording's session clock (0 = recording start). */
export type SessionMs = number;

export interface TranscriptWord {
  text: string;
  startMs: SessionMs;
  endMs: SessionMs;
  /** 0..1 when the provider reports it; absent otherwise. */
  confidence?: number;
}

/**
 * One provider utterance on the session clock. An interim segment is replaced
 * by the next segment carrying the same `segmentKey`; a final one is never
 * replaced by the same connection.
 */
export interface TranscriptSegment {
  provider: ProviderId;
  /** Model identifier the provider reported or that the request named. */
  model: string;
  connectionId: string;
  segmentKey: string;
  kind: 'interim' | 'final';
  startMs: SessionMs;
  endMs: SessionMs;
  text: string;
  words: TranscriptWord[];
  /** Provider decided the speaker finished an utterance or turn. */
  endOfUtterance: boolean;
  timing?: TimingQuality;
}

export type GapReason =
  | 'connect-failed'
  | 'disconnected'
  | 'provider-error'
  | 'rate-limited'
  | 'auth-failed'
  | 'user-stopped-provider'
  // Offline option. A bundle stores these as `not-transcribed` with the reason in `detail`.
  | 'model-missing'
  | 'model-corrupt'
  | 'engine-failed'
  | 'engine-behind'
  | 'not-transcribed';

/** Audio the provider never transcribed. Capture continues; the gap is evidence. */
export interface TranscriptGap {
  provider: ProviderId;
  startMs: SessionMs;
  endMs: SessionMs;
  reason: GapReason;
  detail?: string;
}

export type ErrorKind =
  | 'auth' // bad, revoked or under-scoped key or token
  | 'quota' // out of credit or billing problem: retry will not help
  | 'rate-limit' // concurrency or request rate: retry after a delay
  | 'input' // audio format, size or parameter rejected
  | 'timeout' // provider closed an idle stream
  | 'network' // transport dropped without a provider verdict
  | 'provider'; // provider-side failure

export interface ProviderError {
  provider: ProviderId;
  kind: ErrorKind;
  retryable: boolean;
  /** Provider code, WebSocket close code or HTTP status, as text. */
  code: string;
  message: string;
  retryAfterMs?: number;
}

export type AdapterEvent =
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'gap'; gap: TranscriptGap }
  | { type: 'error'; error: ProviderError }
  | { type: 'state'; state: 'connecting' | 'open' | 'closing' | 'closed' }
  | { type: 'usage'; provider: ProviderId; audioSeconds: number; basis: string };

/** Audio the adapter expects; the capture layer converts before calling sendAudio. */
export type AudioFormat =
  | { kind: 'container'; mimeType: string } // e.g. audio/webm;codecs=opus from MediaRecorder
  | { kind: 'pcm_s16le'; sampleRate: number; channels: 1 };

/**
 * Credentials never cross into page contexts. The service worker resolves a
 * stored key into the narrowest credential the provider supports and hands only
 * that to the context that owns the socket (the offscreen document).
 */
export type LiveCredential =
  | { kind: 'temporary-token'; token: string; expiresAtMs: number }
  | { kind: 'api-key'; key: string };

export interface LiveSessionOptions {
  credential: LiveCredential;
  language: 'en';
  /** Session time of the first audio sample this connection will receive. */
  audioOriginMs: SessionMs;
  connectionId: string;
}

/** Live adapters: Deepgram and AssemblyAI. One instance per provider connection. */
export interface LiveTranscriptionAdapter {
  readonly provider: ProviderId;
  readonly audioFormat: AudioFormat;
  start(options: LiveSessionOptions, onEvent: (event: AdapterEvent) => void): Promise<void>;
  /** Chunks are contiguous audio starting at audioOriginMs; the adapter never reorders. */
  sendAudio(chunk: ArrayBuffer): void;
  /** Ask the provider to flush pending words as finals, then close cleanly. */
  finish(): Promise<void>;
  /** Close immediately; pending interim segments are dropped, not promoted. */
  abort(): void;
}

/** Explicit, per-upload consent. Absence means the adapter must refuse. */
export interface UploadConsent {
  provider: ProviderId;
  recordingId: string;
  grantedAtMs: number;
  /** Narration audio only; page capture is never uploaded for transcription. */
  scope: 'narration-audio';
}

export interface BatchTranscriptionRequest {
  recordingId: string;
  audio: Blob;
  /** Session time of the first sample in `audio` (0 for a whole-recording file). */
  audioOriginMs: SessionMs;
  consent: UploadConsent;
  language: 'en';
}

/** A provider transcript is a new revision; it never edits user corrections. */
export interface TranscriptRevision {
  revisionId: string;
  provider: ProviderId;
  model: string;
  createdAtMs: number;
  source: 'live' | 'after-recording';
  segments: TranscriptSegment[];
  gaps: TranscriptGap[];
  /** Where the times come from, when the engine says. `mixed` is for a revision that carries segments of both kinds. */
  timing?: { quality: TimingQuality | 'mixed'; method: string; correctionMs: number };
  /** The earlier revision this run retried or finalized. It stays untouched. */
  supersedes?: string;
}

/** After-recording adapter: OpenAI. */
export interface BatchTranscriptionAdapter {
  readonly provider: ProviderId;
  transcribe(
    request: BatchTranscriptionRequest,
    credential: { kind: 'api-key'; key: string },
    signal: AbortSignal,
  ): Promise<TranscriptRevision>;
}

/** Provider seconds are relative to the first audio byte of one connection or file. */
export function providerSecondsToSessionMs(audioOriginMs: SessionMs, seconds: number): SessionMs {
  return audioOriginMs + Math.round(seconds * 1000);
}

export function providerMsToSessionMs(audioOriginMs: SessionMs, ms: number): SessionMs {
  return audioOriginMs + Math.round(ms);
}

/**
 * Builds the gap between two provider connections. `lastFinalEndMs` is the end
 * of the last final segment (the audio the provider finished), not of its last
 * word. Returns null when the new connection resumed at or before it (replay).
 */
export function gapBetweenConnections(
  provider: ProviderId,
  lastFinalEndMs: SessionMs,
  resumedAudioOriginMs: SessionMs,
  reason: GapReason,
): TranscriptGap | null {
  if (resumedAudioOriginMs <= lastFinalEndMs) return null;
  return { provider, startMs: lastFinalEndMs, endMs: resumedAudioOriginMs, reason };
}

/**
 * Drops words a replayed connection reports again. Replay starts at the last
 * finalized word end, so only words that end after it are new.
 */
export function dropReplayedWords(words: TranscriptWord[], lastFinalEndMs: SessionMs): TranscriptWord[] {
  return words.filter((word) => word.endMs > lastFinalEndMs);
}
