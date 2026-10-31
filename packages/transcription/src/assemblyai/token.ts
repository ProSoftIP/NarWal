// AssemblyAI temporary streaming tokens, minted with the user's own key (board #16546).
// Source (read 2026-10-13):
// https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
//
// Runs in the extension service worker only. The token endpoint sends no CORS
// headers, so it works only from an extension context with host permission for
// https://streaming.assemblyai.com/*. The key stays in the service worker; the
// offscreen document that owns the socket receives only the minted token.

import type { LiveCredential, ProviderError } from '../contract.ts';

export const ASSEMBLYAI_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';

/** Cap AssemblyAI applies to each session unless the token sets a lower one. */
export const ASSEMBLYAI_MAX_SESSION_SECONDS = 10800;

/** Redemption window NarWal asks for: long enough to open one socket, short enough to be worthless later. */
export const ASSEMBLYAI_DEFAULT_TOKEN_SECONDS = 60;

/**
 * A token this close to its redemption deadline is not used to open a socket:
 * the handshake can take longer than the time left.
 */
export const ASSEMBLYAI_TOKEN_EXPIRY_MARGIN_MS = 5000;

export interface TokenRequestOptions {
  /** Window in which the token can open a socket: 1..600 s. It does not limit the session. */
  expiresInSeconds?: number;
  /** Cap on each session the token opens: 60..10800 s. */
  maxSessionDurationSeconds?: number;
}

export function buildAssemblyAiTokenRequest(apiKey: string, options: TokenRequestOptions = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('AssemblyAI API key is empty');
  const expiresInSeconds = options.expiresInSeconds ?? ASSEMBLYAI_DEFAULT_TOKEN_SECONDS;
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
  // The key goes in the header with no "Bearer" prefix, never in the URL.
  // credentials: 'omit' keeps browser cookies for assemblyai.com off the request.
  return {
    url: url.toString(),
    init: { method: 'GET', headers: { Authorization: apiKey.trim() }, credentials: 'omit' as const },
  };
}

export function parseAssemblyAiTokenResponse(body: unknown, nowMs: number): LiveCredential & { kind: 'temporary-token' } {
  const record = body as { token?: unknown; expires_in_seconds?: unknown } | null;
  if (typeof record?.token !== 'string' || record.token.length === 0) {
    throw new Error('AssemblyAI token response has no token');
  }
  const seconds = record.expires_in_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('AssemblyAI token response has no expires_in_seconds');
  }
  return { kind: 'temporary-token', token: record.token, expiresAtMs: nowMs + seconds * 1000 };
}

/** True while the token can still open a socket with the safety margin to spare. */
export function isAssemblyAiTokenUsable(
  credential: LiveCredential,
  nowMs: number,
  marginMs = ASSEMBLYAI_TOKEN_EXPIRY_MARGIN_MS,
): boolean {
  return credential.kind === 'temporary-token' && credential.token.length > 0 && credential.expiresAtMs - marginMs > nowMs;
}

/** Parses a Retry-After header value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Maps a failed token request to a contract error. The REST call returns a
 * readable status, unlike a failed WebSocket handshake (close 1006 only), so a
 * fresh mint is how the session tells a bad key from a network fault.
 * The error text never includes the key: only the status and the provider's
 * own `error` field are kept.
 */
export function classifyAssemblyAiTokenHttp(status: number, body: unknown, retryAfterMs?: number): ProviderError {
  const record = (body ?? {}) as { error?: unknown; code?: unknown; detail?: unknown };
  // Documented body: {error, code?}. Observed 2026-10-13 from the live
  // endpoint: {detail: "Invalid API key"} with HTTP 404, and a FastAPI-style
  // {detail: [...]} with HTTP 422 for a missing parameter or header.
  const providerText =
    typeof record.error === 'string' ? record.error : typeof record.detail === 'string' ? record.detail : '';
  const base = {
    provider: 'assemblyai' as const,
    code: `http-${status}${typeof record.code === 'string' ? `:${record.code}` : ''}`,
    message: providerText || `AssemblyAI token request failed with HTTP ${status}`,
  };
  if (status === 401 || status === 403 || /invalid api key|unauthori[sz]ed/i.test(providerText)) {
    return { ...base, kind: 'auth', retryable: false };
  }
  if (status === 402 || /balance|insufficient|billing|disabled|payment/i.test(providerText)) {
    return { ...base, kind: 'quota', retryable: false };
  }
  if (status === 429) return { ...base, kind: 'rate-limit', retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  if (status === 400 || status === 422) return { ...base, kind: 'input', retryable: false };
  return { ...base, kind: 'provider', retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

export type MintResult =
  | { ok: true; credential: LiveCredential & { kind: 'temporary-token' } }
  | { ok: false; error: ProviderError };

export interface MintOptions extends TokenRequestOptions {
  now?: () => number;
  signal?: AbortSignal;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Mints one temporary token for one connection. Never throws for provider or
 * network failures: the caller turns `error` into its own exception type (the
 * live session's ProviderErrorException) so auth, quota and rate-limit stay
 * distinguishable.
 */
export async function mintAssemblyAiToken(fetchFn: FetchLike, apiKey: string, options: MintOptions = {}): Promise<MintResult> {
  const now = options.now ?? Date.now;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return {
      ok: false,
      error: { provider: 'assemblyai', kind: 'auth', retryable: false, code: 'no-key', message: 'No AssemblyAI API key is saved' },
    };
  }
  const request = buildAssemblyAiTokenRequest(apiKey, options);
  let response: Response;
  try {
    response = await fetchFn(request.url, { ...request.init, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (cause) {
    const aborted = (cause as { name?: string })?.name === 'AbortError';
    return {
      ok: false,
      error: {
        provider: 'assemblyai',
        kind: 'network',
        retryable: !aborted,
        code: aborted ? 'aborted' : 'fetch-failed',
        // TypeError text from fetch carries no request data; the key is in a header, never the URL.
        message: aborted ? 'Token request was cancelled' : `Could not reach AssemblyAI: ${String((cause as Error)?.message ?? cause)}`,
      },
    };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { ok: false, error: classifyAssemblyAiTokenHttp(response.status, body, parseRetryAfterMs(response.headers.get('retry-after'), now())) };
  }
  try {
    return { ok: true, credential: parseAssemblyAiTokenResponse(body, now()) };
  } catch (cause) {
    return {
      ok: false,
      error: { provider: 'assemblyai', kind: 'provider', retryable: true, code: 'bad-token-response', message: (cause as Error).message },
    };
  }
}
