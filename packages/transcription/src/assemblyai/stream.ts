// AssemblyAI Universal Streaming v3 socket parameters and close classification (board #16546).
// Sources (read 2026-10-13):
// https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
// https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures

import type { LiveCredential, ProviderError } from '../contract.ts';

export const ASSEMBLYAI_STREAM_URL = 'wss://streaming.assemblyai.com/v3/ws';

/**
 * Models NarWal offers for English narration (v1 is English only, q3533).
 * `universal-streaming-english` is the default: the lowest price, and it is the
 * model that supports `format_turns`. `universal-3-6-pro` is AssemblyAI's own
 * default and costs three times as much; it formats final turns itself.
 */
export const ASSEMBLYAI_ENGLISH_MODELS = ['universal-streaming-english', 'universal-3-6-pro'] as const;
export type AssemblyAiEnglishModel = (typeof ASSEMBLYAI_ENGLISH_MODELS)[number];
export const ASSEMBLYAI_DEFAULT_MODEL: AssemblyAiEnglishModel = 'universal-streaming-english';

/** `format_turns` is a Universal Streaming parameter; Universal-3 models ignore it. */
export function assemblyAiModelSupportsFormatTurns(model: string): boolean {
  return model.startsWith('universal-streaming');
}

/** PCM NarWal sends: the shared 16 kHz mono pcm_s16le path from the offscreen AudioWorklet. */
export const ASSEMBLYAI_SAMPLE_RATE = 16000;

export interface StreamUrlOptions {
  sampleRate?: number;
  speechModel?: AssemblyAiEnglishModel;
  /** Ignored for models that do not support it. Defaults to true where supported. */
  formatTurns?: boolean;
  /** 5..3600 s. Unset: AssemblyAI keeps an idle socket open (and billed) until Terminate. */
  inactivityTimeoutSeconds?: number;
}

export function resolveFormatTurns(options: StreamUrlOptions): boolean {
  const model = options.speechModel ?? ASSEMBLYAI_DEFAULT_MODEL;
  return assemblyAiModelSupportsFormatTurns(model) && (options.formatTurns ?? true);
}

/**
 * Browser WebSockets cannot set an Authorization header, so the socket opens
 * with `?token=`. A raw API key is refused: AssemblyAI documents only temporary
 * tokens for the query parameter, and a key in a URL can reach logs.
 */
export function buildAssemblyAiStreamUrl(credential: LiveCredential, options: StreamUrlOptions = {}): string {
  if (credential.kind !== 'temporary-token') {
    throw new Error('AssemblyAI browser sockets need a temporary token, not an API key');
  }
  const model = options.speechModel ?? ASSEMBLYAI_DEFAULT_MODEL;
  if (!(ASSEMBLYAI_ENGLISH_MODELS as readonly string[]).includes(model)) {
    throw new RangeError(`Unsupported AssemblyAI model for English narration: ${model}`);
  }
  const url = new URL(ASSEMBLYAI_STREAM_URL);
  url.searchParams.set('sample_rate', String(options.sampleRate ?? ASSEMBLYAI_SAMPLE_RATE));
  url.searchParams.set('encoding', 'pcm_s16le');
  url.searchParams.set('speech_model', model);
  if (assemblyAiModelSupportsFormatTurns(model)) {
    url.searchParams.set('format_turns', String(resolveFormatTurns(options)));
  }
  if (options.inactivityTimeoutSeconds !== undefined) {
    const seconds = options.inactivityTimeoutSeconds;
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
      throw new RangeError('inactivityTimeoutSeconds must be an integer from 5 to 3600');
    }
    url.searchParams.set('inactivity_timeout', String(seconds));
  }
  url.searchParams.set('token', credential.token);
  return url.toString();
}

/** Strips the token from a stream URL so it can appear in logs and error text. */
export function redactAssemblyAiStreamUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('token')) parsed.searchParams.set('token', 'REDACTED');
  return parsed.toString();
}

export const ASSEMBLYAI_MIN_CHUNK_MS = 50;
export const ASSEMBLYAI_MAX_CHUNK_MS = 1000;

/** AssemblyAI accepts 50..1000 ms per binary message and closes with 3007 otherwise. */
export function assemblyAiChunkBytes(chunkMs: number, sampleRate = ASSEMBLYAI_SAMPLE_RATE): number {
  if (chunkMs < ASSEMBLYAI_MIN_CHUNK_MS || chunkMs > ASSEMBLYAI_MAX_CHUNK_MS) {
    throw new RangeError('AssemblyAI chunks must be 50 to 1000 ms');
  }
  return Math.round((sampleRate * chunkMs) / 1000) * 2;
}

/**
 * Maps a WebSocket close or an `Error` frame (code, text) to a contract error.
 * The server sends `{type:"Error", error_code, error}` before closing with the
 * same code; the close reason is cut at 123 bytes, so the frame text wins.
 */
export function classifyAssemblyAiError(code: number | undefined, reason: string): ProviderError {
  const base = { provider: 'assemblyai' as const, code: code === undefined ? 'error-frame' : String(code), message: reason };
  if (/too many concurrent/i.test(reason) || code === 3009) return { ...base, kind: 'rate-limit', retryable: true };
  if (/balance|insufficient|disabled|billing/i.test(reason)) return { ...base, kind: 'quota', retryable: false };
  switch (code) {
    case 1008:
      // The socket only ever sees a temporary token. Observed 2026-10-13: a bad
      // token gets an Error frame "Unauthorized Connection: Invalid API key",
      // then close 1008. Because the token was minted seconds earlier with a
      // key the REST endpoint accepted, the likely cause is the token (expired
      // or already used), which a new mint fixes. The live session mints again
      // before every retry; a key that is really bad then fails that mint as
      // non-retryable auth, so this cannot loop on a bad key.
      return { ...base, kind: 'auth', retryable: true };
    case 1011:
    case 3005:
      return { ...base, kind: 'provider', retryable: true };
    case 3006:
      return /inactiv|timeout/i.test(reason) ? { ...base, kind: 'timeout', retryable: true } : { ...base, kind: 'input', retryable: false };
    case 3007:
      return { ...base, kind: 'input', retryable: false };
    case 3008:
      // Session reached its maximum duration; a new session continues the recording.
      return { ...base, kind: 'timeout', retryable: true };
    case 1000:
    case 1001:
    case 1006:
      return { ...base, kind: 'network', retryable: true };
    case undefined:
      return { ...base, kind: 'provider', retryable: true };
    default:
      return { ...base, kind: 'provider', retryable: true };
  }
}
