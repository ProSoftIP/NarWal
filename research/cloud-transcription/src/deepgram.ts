// Deepgram live (v1 /listen, Nova-3) pieces for NarWal. Sources (read 2026-10-13):
// https://developers.deepgram.com/reference/speech-to-text/listen-streaming
// https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
// https://developers.deepgram.com/reference/auth/tokens/grant
// https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio
// https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors

import type { AdapterEvent, LiveCredential, ProviderError, TranscriptWord } from './contract.ts';
import { providerSecondsToSessionMs } from './contract.ts';

export const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
export const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

/** Deepgram closes a socket that receives nothing for 10 s; KeepAlive every 3-5 s. */
export const DEEPGRAM_KEEPALIVE_MS = 4000;

/**
 * Request the extension service worker sends to mint a short-lived JWT with the
 * user's key. The key needs at least Member permission. The JWT only has to be
 * valid while the socket opens. Deepgram's REST API has no browser CORS headers,
 * so this runs in an extension context with host permission, not a page.
 */
export function buildDeepgramGrantRequest(apiKey: string, ttlSeconds = 30) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new RangeError('ttlSeconds must be an integer from 1 to 3600');
  }
  return {
    url: DEEPGRAM_GRANT_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      // The field is ttl_seconds; a body with `ttl` is ignored and gives 30 s.
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    },
  };
}

export function parseDeepgramGrantResponse(body: unknown, nowMs: number): LiveCredential {
  const record = body as { access_token?: unknown; expires_in?: unknown };
  if (typeof record?.access_token !== 'string' || record.access_token.length === 0) {
    throw new Error('Deepgram grant response has no access_token');
  }
  const seconds = typeof record.expires_in === 'number' ? record.expires_in : 0;
  return { kind: 'temporary-token', token: record.access_token, expiresAtMs: nowMs + seconds * 1000 };
}

/**
 * Browser sockets cannot set Authorization, so credentials ride in
 * Sec-WebSocket-Protocol. ['token', KEY] is documented; ['bearer', JWT] is what
 * Deepgram's official JS SDK sends for a granted token (not in the docs).
 */
export function deepgramSubprotocols(credential: LiveCredential): [string, string] {
  return credential.kind === 'temporary-token' ? ['bearer', credential.token] : ['token', credential.key];
}

export interface ListenUrlOptions {
  model?: string;
  /** Raw PCM needs encoding and sample_rate; container audio must omit both. */
  pcmSampleRate?: number;
  utteranceEndMs?: number;
}

export function buildDeepgramListenUrl(options: ListenUrlOptions = {}): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', options.model ?? 'nova-3');
  url.searchParams.set('language', 'en');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('utterance_end_ms', String(options.utteranceEndMs ?? 1000));
  if (options.pcmSampleRate !== undefined) {
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(options.pcmSampleRate));
  }
  return url.toString();
}

/** Text frames the client sends. Audio goes as binary frames. */
export const DeepgramControl = {
  keepAlive: JSON.stringify({ type: 'KeepAlive' }),
  finalize: JSON.stringify({ type: 'Finalize' }),
  closeStream: JSON.stringify({ type: 'CloseStream' }),
} as const;

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
}

/**
 * Converts server messages from one connection to contract events. Deepgram
 * restarts its clock at 0 on every connection, so each connection needs its own
 * normalizer with the session time of its first audio sample.
 */
export class DeepgramNormalizer {
  private readonly audioOriginMs: number;
  private readonly connectionId: string;
  private readonly requestedModel: string;

  constructor(audioOriginMs: number, connectionId: string, requestedModel = 'nova-3') {
    this.audioOriginMs = audioOriginMs;
    this.connectionId = connectionId;
    this.requestedModel = requestedModel;
  }

  handle(message: Record<string, unknown>): AdapterEvent[] {
    switch (message.type) {
      case 'Results':
        return this.results(message);
      case 'Metadata':
        return [
          {
            type: 'usage',
            provider: 'deepgram',
            // Deepgram bills processed audio duration, per second.
            audioSeconds: Number(message.duration ?? 0),
            basis: 'processed-audio-seconds',
          },
        ];
      case 'Error':
        return [
          {
            type: 'error',
            error: {
              provider: 'deepgram',
              kind: 'provider',
              retryable: true,
              code: String(message.code ?? message.variant ?? 'Error'),
              message: String(message.description ?? message.message ?? ''),
            },
          },
        ];
      default:
        // SpeechStarted and UtteranceEnd carry no words; speech_final on Results
        // already marks utterance ends for the transcript.
        return [];
    }
  }

  private results(message: Record<string, unknown>): AdapterEvent[] {
    const channel = message.channel as { alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> } | undefined;
    const best = channel?.alternatives?.[0];
    if (!best) return [];
    const words: TranscriptWord[] = (best.words ?? []).map((word) => ({
      text: word.punctuated_word ?? word.word,
      startMs: providerSecondsToSessionMs(this.audioOriginMs, word.start),
      endMs: providerSecondsToSessionMs(this.audioOriginMs, word.end),
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
    }));
    const start = Number(message.start ?? 0);
    const duration = Number(message.duration ?? 0);
    const metadata = message.metadata as { model_info?: { name?: string } } | undefined;
    const startMs = providerSecondsToSessionMs(this.audioOriginMs, start);
    return [
      {
        type: 'segment',
        segment: {
          provider: 'deepgram',
          model: metadata?.model_info?.name ?? this.requestedModel,
          connectionId: this.connectionId,
          // Interim results for one audio window share `start` until is_final
          // closes the window; the next window starts later.
          segmentKey: `${this.connectionId}:${startMs}`,
          kind: message.is_final === true ? 'final' : 'interim',
          startMs,
          endMs: providerSecondsToSessionMs(this.audioOriginMs, start + duration),
          text: best.transcript ?? '',
          words,
          endOfUtterance: message.speech_final === true,
        },
      },
    ];
  }
}

/**
 * Maps a WebSocket close to the contract. A failed handshake (401, 429)
 * reaches browser code only as close 1006 with no reason, so the adapter
 * re-checks the key through the grant request before retrying, which returns a
 * readable HTTP status.
 */
export function classifyDeepgramClose(code: number, reason: string): ProviderError {
  const base = { provider: 'deepgram' as const, code: String(code), message: reason };
  if (code === 1008 || /DATA-0000/.test(reason)) return { ...base, kind: 'input', retryable: false };
  if (/NET-0001|NET-0002/.test(reason)) return { ...base, kind: 'timeout', retryable: true };
  if (code === 1011) return { ...base, kind: 'provider', retryable: true };
  if (code === 1000) return { ...base, kind: 'provider', retryable: false };
  return { ...base, kind: 'network', retryable: true };
}

/** For the grant request and REST calls, where the HTTP status is visible. */
export function classifyDeepgramHttp(status: number, message = ''): ProviderError {
  const base = { provider: 'deepgram' as const, code: String(status), message };
  if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
  // 402 is not in Deepgram's docs; treated as an out-of-credit answer if it appears.
  if (status === 402) return { ...base, kind: 'quota', retryable: false };
  if (status === 429) return { ...base, kind: 'rate-limit', retryable: true };
  if (status === 400) return { ...base, kind: 'input', retryable: false };
  return { ...base, kind: 'provider', retryable: status >= 500 };
}
