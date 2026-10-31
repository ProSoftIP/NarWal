import assert from 'node:assert/strict';
import test from 'node:test';

import { mintDeepgramCredential, testDeepgramKey } from '../../src/deepgram/credentials.ts';
import { DEEPGRAM_GRANT_URL, DEEPGRAM_PROJECTS_URL } from '../../src/deepgram/protocol.ts';
import { ProviderErrorException } from '../../src/provider-error.ts';
import { FAKE_KEY } from '../helpers.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  return { calls, fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function rejected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (thrown) {
    assert.ok(thrown instanceof ProviderErrorException);
    return thrown.error;
  }
  assert.fail('expected a ProviderErrorException');
}

test('grant mode mints a short-lived token with the key in the header only', async () => {
  const { calls, fetch } = fakeFetch(() => json(200, { access_token: 'jwt-1', expires_in: 30 }));
  const credential = await mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 5_000 });
  assert.deepEqual(credential, { kind: 'temporary-token', token: 'jwt-1', expiresAtMs: 35_000 });
  assert.equal(calls[0].url, DEEPGRAM_GRANT_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Token ${FAKE_KEY}`);
});

test('a rejected key is an auth error with no key text', async () => {
  const { fetch } = fakeFetch(() => json(401, { err_code: 'INVALID_AUTH', err_msg: `Invalid credentials: ${FAKE_KEY}` }));
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 0 }));
  assert.equal(error.kind, 'auth');
  assert.equal(error.retryable, false);
  assert.equal(error.code, '401');
  assert.ok(!error.message.includes(FAKE_KEY));
  assert.match(error.message, /\[redacted\]/);
});

test('a wrong key as Deepgram answers it live (400 BAD_REQUEST) is an auth error, not an input error', async () => {
  const { fetch } = fakeFetch(() => json(400, { err_code: 'BAD_REQUEST', err_msg: 'Invalid credentials.' }));
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 0 }));
  assert.deepEqual([error.kind, error.retryable, error.code, error.message], ['auth', false, '400', 'Invalid credentials.']);
});

test('direct-key mode reads the /v1/projects error text from message', async () => {
  const { fetch } = fakeFetch(() => json(401, { category: 'UNAUTHORIZED', message: 'Authentication failed.', details: 'Check that you are using the correct credentials.' }));
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'direct-key', fetch, nowMs: () => 0 }));
  assert.deepEqual([error.kind, error.message], ['auth', 'Authentication failed.']);
});

test('a key without Member permission says so and does not fall back to direct-key', async () => {
  const { calls, fetch } = fakeFetch(() => json(403, { err_code: 'FORBIDDEN', err_msg: 'Insufficient permissions.' }));
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 0 }));
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /Member permission/);
  assert.equal(calls.length, 1);
});

test('rate limiting carries Retry-After', async () => {
  const { fetch } = fakeFetch(() => json(429, { err_msg: 'Too many requests' }, { 'Retry-After': '7' }));
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 0 }));
  assert.deepEqual([error.kind, error.retryable, error.retryAfterMs], ['rate-limit', true, 7_000]);
});

test('a network failure is retryable and redacted', async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError(`Failed to fetch with ${FAKE_KEY}`);
  });
  const error = await rejected(mintDeepgramCredential({ key: FAKE_KEY, mode: 'grant', fetch, nowMs: () => 0 }));
  assert.deepEqual([error.kind, error.retryable], ['network', true]);
  assert.ok(!error.message.includes(FAKE_KEY));
});

test('direct-key mode checks the key over REST, then hands back the key itself', async () => {
  const { calls, fetch } = fakeFetch(() => json(200, { projects: [] }));
  const credential = await mintDeepgramCredential({ key: FAKE_KEY, mode: 'direct-key', fetch, nowMs: () => 0 });
  assert.deepEqual(credential, { kind: 'api-key', key: FAKE_KEY });
  assert.equal(calls[0].url, DEEPGRAM_PROJECTS_URL);
  assert.equal(calls[0].init.method, 'GET');
});

test('testDeepgramKey reports the verdict without throwing', async () => {
  const ok = await testDeepgramKey({ key: FAKE_KEY, mode: 'grant', fetch: fakeFetch(() => json(200, { access_token: 'j', expires_in: 30 })).fetch, nowMs: () => 0 });
  assert.deepEqual(ok, { ok: true });
  const bad = await testDeepgramKey({ key: FAKE_KEY, mode: 'grant', fetch: fakeFetch(() => json(401, {})).fetch, nowMs: () => 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.kind, 'auth');
});
