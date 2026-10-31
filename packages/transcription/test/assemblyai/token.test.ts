import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAssemblyAiTokenRequest,
  classifyAssemblyAiTokenHttp,
  isAssemblyAiTokenUsable,
  mintAssemblyAiToken,
  parseAssemblyAiTokenResponse,
  parseRetryAfterMs,
} from '../../src/assemblyai/token.ts';
import { fixture } from './helpers.ts';

const FAKE_KEY = 'fixture-key-not-real';

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? 'not json' : JSON.stringify(body), { status, headers });
  };
  return { calls, fetchFn };
}

test('token request: GET, key in the Authorization header only, no cookies', () => {
  const request = buildAssemblyAiTokenRequest(` ${FAKE_KEY} `, { expiresInSeconds: 60, maxSessionDurationSeconds: 3600 });
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, FAKE_KEY);
  assert.equal(request.init.credentials, 'omit');
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://streaming.assemblyai.com/v3/token');
  assert.equal(url.searchParams.get('expires_in_seconds'), '60');
  assert.equal(url.searchParams.get('max_session_duration_seconds'), '3600');
  assert.ok(!request.url.includes(FAKE_KEY));
});

test('token request: documented ranges are enforced', () => {
  assert.equal(new URL(buildAssemblyAiTokenRequest(FAKE_KEY).url).searchParams.get('expires_in_seconds'), '60');
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { expiresInSeconds: 0 }), RangeError);
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { expiresInSeconds: 601 }), RangeError);
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { maxSessionDurationSeconds: 59 }), RangeError);
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { maxSessionDurationSeconds: 10801 }), RangeError);
  assert.throws(() => buildAssemblyAiTokenRequest('  '));
});

test('token expiry: expires_in_seconds becomes an absolute deadline; the margin refuses a nearly expired token', () => {
  const credential = parseAssemblyAiTokenResponse({ token: 'tmp-1', expires_in_seconds: 60 }, 1_000);
  assert.deepEqual(credential, { kind: 'temporary-token', token: 'tmp-1', expiresAtMs: 61_000 });
  assert.equal(isAssemblyAiTokenUsable(credential, 1_000), true);
  assert.equal(isAssemblyAiTokenUsable(credential, 55_999), true);
  // Within 5 s of the deadline the handshake may not finish in time.
  assert.equal(isAssemblyAiTokenUsable(credential, 56_000), false);
  assert.equal(isAssemblyAiTokenUsable(credential, 61_000), false);
  assert.equal(isAssemblyAiTokenUsable({ kind: 'api-key', key: FAKE_KEY }, 0), false);
  assert.throws(() => parseAssemblyAiTokenResponse({ token: '' }, 0));
  assert.throws(() => parseAssemblyAiTokenResponse({ token: 'tmp' }, 0));
});

test('mint: success returns only the temporary token', async () => {
  const { calls, fetchFn } = fakeFetch(200, { token: 'tmp-abc', expires_in_seconds: 60 });
  const result = await mintAssemblyAiToken(fetchFn, FAKE_KEY, { now: () => 5_000 });
  assert.deepEqual(result, { ok: true, credential: { kind: 'temporary-token', token: 'tmp-abc', expiresAtMs: 65_000 } });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes(FAKE_KEY));
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, FAKE_KEY);
});

test('mint: HTTP failures classify without leaking the key', async () => {
  for (const row of fixture('errors.json').tokenHttp) {
    const { fetchFn } = fakeFetch(row.status, row.body, row.retryAfter ? { 'retry-after': row.retryAfter } : {});
    const result = await mintAssemblyAiToken(fetchFn, FAKE_KEY, { now: () => 0 });
    assert.equal(result.ok, false, `status ${row.status}`);
    if (result.ok) continue;
    assert.equal(result.error.kind, row.kind, `status ${row.status}`);
    assert.equal(result.error.retryable, row.retryable, `status ${row.status}`);
    assert.equal(result.error.retryAfterMs, row.retryAfterMs, `status ${row.status}`);
    assert.ok(!JSON.stringify(result.error).includes(FAKE_KEY));
  }
});

test('mint: missing key, network failure, abort and a malformed body', async () => {
  const noKey = await mintAssemblyAiToken(fakeFetch(200, {}).fetchFn, '');
  assert.equal(noKey.ok === false && noKey.error.code, 'no-key');

  const offline = await mintAssemblyAiToken(async () => {
    throw new TypeError('fetch failed');
  }, FAKE_KEY);
  assert.equal(offline.ok === false && offline.error.kind, 'network');
  assert.equal(offline.ok === false && offline.error.retryable, true);

  const aborted = await mintAssemblyAiToken(async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }, FAKE_KEY);
  assert.equal(aborted.ok === false && aborted.error.retryable, false);

  const garbage = await mintAssemblyAiToken(fakeFetch(200, undefined).fetchFn, FAKE_KEY);
  assert.equal(garbage.ok === false && garbage.error.code, 'bad-token-response');
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('3', 0), 3000);
  assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfterMs('soon', 0), undefined);
  assert.equal(parseRetryAfterMs(null, 0), undefined);
});

test('classifyAssemblyAiTokenHttp keeps the provider code', () => {
  const error = classifyAssemblyAiTokenHttp(401, { error: 'Invalid API key', code: 'invalid_key' });
  assert.equal(error.code, 'http-401:invalid_key');
  assert.equal(error.message, 'Invalid API key');
});
