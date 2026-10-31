// Service-worker side of Deepgram authentication. Only the service worker reads
// the stored key; it hands the offscreen document (which owns the socket) a
// 30 s JWT, or the raw key only when the user turned on direct-key mode.

import type { LiveCredential, ProviderError } from '../contract.ts';
import { ProviderErrorException, redactSecrets } from '../provider-error.ts';
import {
  DEEPGRAM_PROJECTS_URL,
  buildDeepgramGrantRequest,
  classifyDeepgramHttp,
  parseDeepgramGrantResponse,
} from './protocol.ts';

/**
 * grant: mint a short-lived JWT per connection (needs a Member key).
 * direct-key: send the key itself in Sec-WebSocket-Protocol. A setting the user
 * turns on; never an automatic fallback when a grant is refused.
 */
export type DeepgramAuthMode = 'grant' | 'direct-key';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeepgramCredentialOptions {
  key: string;
  mode: DeepgramAuthMode;
  fetch: FetchLike;
  nowMs: () => number;
  ttlSeconds?: number;
}

/**
 * Resolves the user's key into the credential for one connection. Throws
 * ProviderErrorException with a readable kind: the session calls this before
 * every reconnect because a failed WebSocket handshake hides its HTTP status.
 */
export async function mintDeepgramCredential(options: DeepgramCredentialOptions): Promise<LiveCredential> {
  if (options.mode === 'direct-key') {
    await verifyWithRequest(options, DEEPGRAM_PROJECTS_URL, {
      method: 'GET',
      headers: { Authorization: `Token ${options.key}` },
    });
    return { kind: 'api-key', key: options.key };
  }
  const request = buildDeepgramGrantRequest(options.key, options.ttlSeconds ?? 30);
  const body = await verifyWithRequest(options, request.url, request.init);
  return parseDeepgramGrantResponse(body, options.nowMs());
}

/** Settings page "Test key": the same call a recording makes, nothing stored. */
export async function testDeepgramKey(
  options: DeepgramCredentialOptions,
): Promise<{ ok: true } | { ok: false; error: ProviderError }> {
  try {
    await mintDeepgramCredential(options);
    return { ok: true };
  } catch (thrown) {
    if (thrown instanceof ProviderErrorException) return { ok: false, error: thrown.error };
    throw thrown;
  }
}

async function verifyWithRequest(options: DeepgramCredentialOptions, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(url, init);
  } catch (thrown) {
    throw new ProviderErrorException({
      provider: 'deepgram',
      kind: 'network',
      retryable: true,
      code: 'fetch-failed',
      message: redactSecrets(thrown instanceof Error ? thrown.message : String(thrown), [options.key]),
    });
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body;
  // The grant answers { err_code, err_msg }; /v1/projects answers { category, message }.
  const reply = body as { err_msg?: unknown; message?: unknown } | null;
  const providerMessage = reply?.err_msg ?? reply?.message;
  const error = classifyDeepgramHttp(
    response.status,
    redactSecrets(typeof providerMessage === 'string' ? providerMessage : response.statusText, [options.key]),
  );
  if (response.status === 403 && options.mode === 'grant') {
    error.message =
      'This Deepgram key cannot mint temporary tokens (it needs Member permission). Use a Member key, or turn on direct-key mode in settings.';
  }
  const retryAfter = Number(response.headers.get('Retry-After'));
  if (error.kind === 'rate-limit' && Number.isFinite(retryAfter) && retryAfter > 0) {
    error.retryAfterMs = retryAfter * 1000;
  }
  throw new ProviderErrorException(error);
}
