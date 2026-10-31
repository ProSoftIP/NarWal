import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdapterEvent, TranscriptSegment } from '../../src/contract.ts';
import {
  DEEPGRAM_IDENTITY,
  DeepgramNormalizer,
  buildDeepgramGrantRequest,
  buildDeepgramListenUrl,
  classifyDeepgramClose,
  classifyDeepgramHttp,
  deepgramSubprotocols,
  parseDeepgramGrantResponse,
} from '../../src/deepgram/protocol.ts';
import { FAKE_KEY, fixture } from '../helpers.ts';

const segments = (events: AdapterEvent[]): TranscriptSegment[] =>
  events.flatMap((event) => (event.type === 'segment' ? [event.segment] : []));

test('grant request keeps the key in the header and uses ttl_seconds', () => {
  const request = buildDeepgramGrantRequest(FAKE_KEY, 30);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Token ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(request.init.body), { ttl_seconds: 30 });
  assert.ok(!request.url.includes(FAKE_KEY));
  assert.throws(() => buildDeepgramGrantRequest(FAKE_KEY, 0), RangeError);
  assert.throws(() => buildDeepgramGrantRequest(FAKE_KEY, 3601), RangeError);
});

test('granted JWT uses the bearer subprotocol; a raw key uses token', () => {
  const credential = parseDeepgramGrantResponse({ access_token: 'jwt-abc', expires_in: 30 }, 1_000);
  assert.deepEqual(credential, { kind: 'temporary-token', token: 'jwt-abc', expiresAtMs: 31_000 });
  assert.deepEqual(deepgramSubprotocols(credential), ['bearer', 'jwt-abc']);
  assert.deepEqual(deepgramSubprotocols({ kind: 'api-key', key: FAKE_KEY }), ['token', FAKE_KEY]);
  assert.throws(() => parseDeepgramGrantResponse({}, 0));
});

test('listen URL sets PCM parameters and never carries a credential', () => {
  const container = new URL(buildDeepgramListenUrl());
  assert.equal(container.searchParams.get('encoding'), null);
  assert.equal(container.searchParams.get('model'), 'nova-3');
  assert.equal(container.searchParams.get('interim_results'), 'true');
  const pcm = new URL(buildDeepgramListenUrl({ pcmSampleRate: 16000 }));
  assert.equal(pcm.searchParams.get('encoding'), 'linear16');
  assert.equal(pcm.searchParams.get('sample_rate'), '16000');
  assert.equal(pcm.searchParams.get('channels'), '1');
  assert.ok(![...pcm.searchParams.keys()].some((name) => /token|key|auth/i.test(name)));
});

test('results land on the session clock; interim and final share a segment key', () => {
  const normalizer = new DeepgramNormalizer(10_000, 'dg-1');
  const events: AdapterEvent[] = fixture('deepgram/deepgram-connection-1.json').messages.flatMap((message: Record<string, unknown>) => normalizer.handle(message));
  const all = segments(events);
  assert.deepEqual(all.map((segment) => segment.kind), ['interim', 'final']);
  assert.equal(all[0].segmentKey, all[1].segmentKey);
  assert.equal(all[1].text, 'This should collapse.');
  assert.deepEqual(all[1].words.map((word) => [word.startMs, word.endMs]), [[10_420, 10_610], [10_610, 10_950], [10_950, 11_600]]);
  // A final covers its whole audio window (start + duration), not just its last word.
  assert.equal(all[1].endMs, 12_300);
  assert.equal(all[1].endOfUtterance, true);
  assert.equal(all[1].model, 'general-nova-3');
  assert.deepEqual(events.find((event: AdapterEvent) => event.type === 'usage'), {
    type: 'usage',
    provider: 'deepgram',
    audioSeconds: 2.3,
    basis: 'processed-audio-seconds',
  });
});

test('normalizer records the model, version and request id Deepgram reported', () => {
  const normalizer = new DeepgramNormalizer(0, 'dg-1');
  for (const message of fixture('deepgram/flush-on-close.json').beforeClose) normalizer.handle(message);
  assert.deepEqual(normalizer.observed, { requestId: 'req-flush', reportedModel: 'general-nova-3', modelVersion: '2026-01-01.0' });
});

test('close codes and HTTP statuses classify into contract errors', () => {
  assert.equal(classifyDeepgramClose(1008, 'DATA-0000').kind, 'input');
  assert.deepEqual([classifyDeepgramClose(1011, 'NET-0001').kind, classifyDeepgramClose(1011, 'NET-0001').retryable], ['timeout', true]);
  assert.equal(classifyDeepgramClose(1011, '').kind, 'provider');
  assert.equal(classifyDeepgramClose(1006, '').kind, 'network');
  assert.equal(classifyDeepgramHttp(401).kind, 'auth');
  // Live 2026-10-13: a wrong key on /v1/auth/grant is 400 "Invalid credentials.".
  assert.deepEqual([classifyDeepgramHttp(400, 'Invalid credentials.').kind, classifyDeepgramHttp(400, 'Invalid credentials.').retryable], ['auth', false]);
  assert.equal(classifyDeepgramHttp(400, 'Bad ttl_seconds').kind, 'input');
  assert.equal(classifyDeepgramHttp(403).retryable, false);
  assert.equal(classifyDeepgramHttp(402).kind, 'quota');
  assert.equal(classifyDeepgramHttp(429).retryable, true);
  assert.equal(classifyDeepgramHttp(503).retryable, true);
});

test('provider identity states direct provider billing and what is sent', () => {
  assert.equal(DEEPGRAM_IDENTITY.billing, 'direct-provider');
  assert.match(DEEPGRAM_IDENTITY.billingNotice, /your own Deepgram account/);
  assert.match(DEEPGRAM_IDENTITY.consentNotice, /narration audio streams to Deepgram/);
  assert.match(DEEPGRAM_IDENTITY.consentNotice, /Page content is never sent/);
});
