// AssemblyAI Universal Streaming (v3) pieces for NarWal. Sources (read 2026-10-13):
// https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
// https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
// https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures

import type { AdapterEvent, LiveCredential, ProviderError, TranscriptWord } from './contract.ts';
import { providerMsToSessionMs } from './contract.ts';

export const ASSEMBLYAI_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
export const ASSEMBLYAI_STREAM_URL = 'wss://streaming.assemblyai.com/v3/ws';

/** Session-duration cap AssemblyAI applies to a token unless told otherwise. */
export const ASSEMBLYAI_MAX_SESSION_SECONDS = 10800;

export interface TokenRequestOptions {
  /** Window in which the token can open a socket: 1..600 s. */
  expiresInSeconds?: number;
  /** Cap on each session the token opens: 60..10800 s. */
  maxSessionDurationSeconds?: number;
}

/**
 * Request the extension service worker sends to mint a temporary streaming
 * token with the user's own key. The endpoint has no CORS headers, so this must
 * run in an extension context with host permission for streaming.assemblyai.com,
 * never in a content script.
 */
export function buildAssemblyAiTokenRequest(apiKey: string, options: TokenRequestOptions = {}) {
  const expiresInSeconds = options.expiresInSeconds ?? 60;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 600) {
    throw new RangeError('expiresInSeconds must be an integer from 1 to 600');
  }
  const url = new URL(ASSEMBLYAI_TOKEN_URL);
  url.searchParams.set('expires_in_seconds', String(expiresInSeconds));
  if (options.maxSessionDurationSeconds !== undefined) {
    const max = options.maxSessionDurationSeconds;
    if (!Number.isInteger(max) || max < 60 || max > ASSEMBLYAI_MAX_SESSION_SECONDS) {
      throw new RangeError('maxSessionDurationSeconds must be an integer from 60 to 10800');
    }
    url.searchParams.set('max_session_duration_seconds', String(max));
  }
  // The key goes in the header with no "Bearer" prefix; never in the URL.
  return { url: url.toString(), init: { method: 'GET', headers: { Authorization: apiKey } } };
}

export function parseAssemblyAiTokenResponse(body: unknown, nowMs: number): LiveCredential {
  const record = body as { token?: unknown; expires_in_seconds?: unknown };
  if (typeof record?.token !== 'string' || record.token.length === 0) {
    throw new Error('AssemblyAI token response has no token');
  }
  const seconds = typeof record.expires_in_seconds === 'number' ? record.expires_in_seconds : 0;
  return { kind: 'temporary-token', token: record.token, expiresAtMs: nowMs + seconds * 1000 };
}

export interface StreamUrlOptions {
  sampleRate?: number;
  speechModel?: string;
  formatTurns?: boolean;
}

/**
 * Browser WebSockets cannot set an Authorization header, so the socket opens
 * with `?token=`. A raw API key is refused here: AssemblyAI documents only
 * temporary tokens for the query parameter.
 */
export function buildAssemblyAiStreamUrl(credential: LiveCredential, options: StreamUrlOptions = {}): string {
  if (credential.kind !== 'temporary-token') {
    throw new Error('AssemblyAI browser sockets need a temporary token, not an API key');
  }
  const url = new URL(ASSEMBLYAI_STREAM_URL);
  url.searchParams.set('sample_rate', String(options.sampleRate ?? 16000));
  url.searchParams.set('encoding', 'pcm_s16le');
  if (options.speechModel) url.searchParams.set('speech_model', options.speechModel);
  if (options.formatTurns !== undefined) url.searchParams.set('format_turns', String(options.formatTurns));
  url.searchParams.set('token', credential.token);
  return url.toString();
}

/** AssemblyAI accepts 50..1000 ms per binary message and closes with 3007 otherwise. */
export function assemblyAiChunkBytes(chunkMs: number, sampleRate = 16000): number {
  if (chunkMs < 50 || chunkMs > 1000) throw new RangeError('AssemblyAI chunks must be 50 to 1000 ms');
  return Math.round((sampleRate * chunkMs) / 1000) * 2;
}

interface AssemblyAiWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  word_is_final?: boolean;
}

/** Converts server messages from one connection to contract events on the session clock. */
export class AssemblyAiNormalizer {
  private model = 'unknown';
  private readonly audioOriginMs: number;
  private readonly connectionId: string;
  private readonly formatTurns: boolean;

  constructor(audioOriginMs: number, connectionId: string, options: { formatTurns?: boolean } = {}) {
    this.audioOriginMs = audioOriginMs;
    this.connectionId = connectionId;
    this.formatTurns = options.formatTurns ?? false;
  }

  handle(message: Record<string, unknown>): AdapterEvent[] {
    switch (message.type) {
      case 'Begin': {
        const configuration = message.configuration as { speech_model?: string; model?: string } | undefined;
        this.model = configuration?.speech_model ?? configuration?.model ?? this.model;
        return [{ type: 'state', state: 'open' }];
      }
      case 'Turn':
        return [this.turn(message)];
      case 'Termination':
        return [
          {
            type: 'usage',
            provider: 'assemblyai',
            // Billing follows how long the session was open, not audio sent.
            audioSeconds: Number(message.session_duration_seconds ?? 0),
            basis: 'session-duration-seconds',
          },
          { type: 'state', state: 'closed' },
        ];
      case 'Error':
        return [{ type: 'error', error: classifyAssemblyAiError(undefined, String(message.error ?? '')) }];
      default:
        return [];
    }
  }

  private turn(message: Record<string, unknown>): AdapterEvent {
    const raw = (message.words as AssemblyAiWord[] | undefined) ?? [];
    const words: TranscriptWord[] = raw.map((word) => ({
      text: word.text,
      startMs: providerMsToSessionMs(this.audioOriginMs, word.start),
      endMs: providerMsToSessionMs(this.audioOriginMs, word.end),
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
    }));
    const endOfTurn = message.end_of_turn === true;
    // With format_turns the formatted copy of a finished turn follows the
    // unformatted one; only the formatted copy is final.
    const final = endOfTurn && (!this.formatTurns || message.turn_is_formatted === true);
    return {
      type: 'segment',
      segment: {
        provider: 'assemblyai',
        model: this.model,
        connectionId: this.connectionId,
        segmentKey: `${this.connectionId}:${String(message.turn_order)}`,
        kind: final ? 'final' : 'interim',
        startMs: words[0]?.startMs ?? this.audioOriginMs,
        endMs: words.at(-1)?.endMs ?? this.audioOriginMs,
        text: String(message.transcript ?? ''),
        words,
        endOfUtterance: final,
      },
    };
  }
}

/** Maps a WebSocket close (code, reason) to the contract error kinds. */
export function classifyAssemblyAiError(code: number | undefined, reason: string): ProviderError {
  const base = { provider: 'assemblyai' as const, code: code === undefined ? 'error-frame' : String(code), message: reason };
  if (/too many concurrent/i.test(reason) || code === 3009) return { ...base, kind: 'rate-limit', retryable: true };
  if (/balance|insufficient|disabled|billing/i.test(reason)) return { ...base, kind: 'quota', retryable: false };
  switch (code) {
    case 1008:
      return { ...base, kind: 'auth', retryable: false };
    case 1011:
    case 3005:
      return { ...base, kind: 'provider', retryable: true };
    case 3006:
      return /inactiv|timeout/i.test(reason)
        ? { ...base, kind: 'timeout', retryable: true }
        : { ...base, kind: 'input', retryable: false };
    case 3007:
      return { ...base, kind: 'input', retryable: false };
    case 3008:
      // Session reached its maximum duration; a new session continues the recording.
      return { ...base, kind: 'timeout', retryable: true };
    case 1000:
    case 1001:
    case 1006:
    case undefined:
      return { ...base, kind: code === undefined ? 'provider' : 'network', retryable: true };
    default:
      return { ...base, kind: 'provider', retryable: true };
  }
}
