// Deepgram live sessions end to end against scripted sockets: partial/final
// reconciliation, disconnections, rejected keys and timing offsets.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { LiveCredential } from '../../src/contract.ts';
import { createDeepgramSession } from '../../src/deepgram/index.ts';
import { classifyDeepgramHttp } from '../../src/deepgram/protocol.ts';
import type { LiveSessionSnapshot, ReconnectPolicy } from '../../src/live-session.ts';
import { ProviderErrorException } from '../../src/provider-error.ts';
import { FAKE_KEY, ManualTimers, SocketRecorder, dgResults, fixture, pcm, settle } from '../helpers.ts';

function harness(options: { credential?: (call: number) => LiveCredential; reconnect?: Partial<ReconnectPolicy> } = {}) {
  const sockets = new SocketRecorder();
  const timers = new ManualTimers();
  const updates: LiveSessionSnapshot[] = [];
  let credentialCalls = 0;
  let ids = 0;
  const session = createDeepgramSession({
    getCredential: async () => {
      credentialCalls += 1;
      return options.credential
        ? options.credential(credentialCalls)
        : { kind: 'temporary-token', token: `jwt-${credentialCalls}`, expiresAtMs: 0 };
    },
    createSocket: sockets.create,
    timers,
    reconnect: options.reconnect,
    onUpdate: (snapshot) => updates.push(snapshot),
    createId: () => `id-${++ids}`,
  });
  const push = (fromMs: number, toMs: number) => {
    for (let at = fromMs; at < toMs; at += 100) session.pushAudio(pcm(at, 100));
  };
  return { sockets, timers, updates, session, push, credentialCalls: () => credentialCalls };
}

async function openLast(sockets: SocketRecorder) {
  await settle();
  sockets.last.serverOpen();
  await settle();
}

test('timing offset: words land at the session time of the first sample; interim is replaced by final', async () => {
  const { sockets, session, push } = harness();
  push(1_500, 3_800);
  await openLast(sockets);
  assert.equal(session.snapshot().status.phase, 'live');
  assert.equal(sockets.last.audioFrames().length, 23);

  const [speechStarted, interim, final, utteranceEnd, metadata] = fixture('deepgram/deepgram-connection-1.json').messages;
  sockets.last.serverSend(speechStarted);
  sockets.last.serverSend(interim);
  assert.deepEqual(session.snapshot().interim.map((segment) => segment.text), ['this should']);
  assert.deepEqual(session.snapshot().finals, []);
  sockets.last.serverSend(final);
  sockets.last.serverSend(utteranceEnd);
  assert.deepEqual(session.snapshot().interim, []);
  const [segment] = session.snapshot().finals;
  assert.equal(segment.text, 'This should collapse.');
  assert.equal(segment.words[0].startMs, 1_920);
  assert.equal(segment.endMs, 3_800);

  const finishing = session.finish();
  assert.deepEqual(sockets.last.textFrames().at(-1), { type: 'CloseStream' });
  sockets.last.serverSend(metadata);
  sockets.last.serverClose(1000);
  const result = await finishing;
  assert.equal(result.revision.provider, 'deepgram');
  assert.equal(result.revision.source, 'live');
  assert.equal(result.revision.model, 'general-nova-3');
  assert.deepEqual(result.revision.gaps, []);
  assert.deepEqual(result.revision.segments.map((item) => item.text), ['This should collapse.']);
  assert.deepEqual(result.usage, { audioSeconds: 2.3, basis: 'processed-audio-seconds' });
  assert.equal(result.service?.api, 'wss://api.deepgram.com/v1/listen');
  assert.deepEqual(result.service?.requestIds, ['req-1']);
  assert.equal(session.snapshot().status.phase, 'finished');
});

test('interim words still pending at Stop are flushed by CloseStream, not lost', async () => {
  const { sockets, session, push } = harness();
  push(0, 3_000);
  await openLast(sockets);
  const flush = fixture('deepgram/flush-on-close.json');
  for (const message of flush.beforeClose) sockets.last.serverSend(message);
  assert.deepEqual(session.snapshot().interim.map((segment) => segment.text), ['then click']);
  const finishing = session.finish();
  for (const message of flush.afterCloseStream) sockets.last.serverSend(message);
  sockets.last.serverClose(1000);
  const { revision } = await finishing;
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['Open the report.', 'Then click export.']);
  assert.deepEqual(revision.gaps, []);
});

test('a short drop reconnects with a fresh credential, replays buffered audio and drops repeated words', async () => {
  const { sockets, timers, session, push, credentialCalls } = harness();
  push(0, 2_000);
  await openLast(sockets);
  sockets.last.serverSend(dgResults({ start: 0, duration: 1.05, isFinal: true, words: [{ word: 'Open', start: 0.1, end: 0.4 }, { word: 'menu', start: 0.4, end: 1.04 }] }));
  sockets.last.serverSend(dgResults({ start: 1.05, duration: 0.6, isFinal: false, words: [{ word: 'then', start: 1.1, end: 1.3 }] }));
  sockets.last.serverClose(1006);
  const status = session.snapshot().status;
  assert.deepEqual([status.phase, status.attempt, status.error?.kind], ['reconnecting', 1, 'network']);
  assert.deepEqual(session.snapshot().interim, [], 'interims of a dropped connection are discarded');

  push(2_000, 2_500);
  timers.advance(1_000);
  await openLast(sockets);
  assert.equal(sockets.sockets.length, 2);
  assert.equal(credentialCalls(), 2);
  assert.deepEqual(sockets.last.protocols, ['bearer', 'jwt-2']);
  // Replay starts at the buffered chunk holding the last final end (1050 ms).
  assert.equal(sockets.last.audioFrames().length, 15);
  // Connection 2's clock starts at 1000 ms. Its first word ends at 1040 ms, inside
  // the window connection 1 already finalized.
  sockets.last.serverSend(dgResults({ start: 0, duration: 0.5, isFinal: true, words: [{ word: 'menu', start: 0.02, end: 0.04 }, { word: 'then', start: 0.1, end: 0.3 }, { word: 'click', start: 0.3, end: 0.45 }] }));
  sockets.last.serverSend(dgResults({ start: 0.5, duration: 1.0, isFinal: true, words: [] }));
  const finishing = session.finish();
  sockets.last.serverClose(1000);
  const { revision } = await finishing;
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['Open menu', 'then click']);
  assert.equal(revision.segments[1].words[0].startMs, 1_100);
  assert.deepEqual(revision.gaps, []);
});

test('a long outage resumes at live audio and records the gap', async () => {
  const { sockets, timers, session, push } = harness({ reconnect: { maxReplayMs: 2_000 } });
  push(0, 1_000);
  await openLast(sockets);
  sockets.last.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'First', start: 0.2, end: 0.5 }] }));
  sockets.last.serverClose(1011, 'NET-0001');
  assert.equal(session.snapshot().status.error?.kind, 'timeout');
  push(1_000, 5_000);
  timers.advance(1_000);
  await openLast(sockets);
  assert.equal(sockets.last.audioFrames().length, 0, 'no stale backlog is replayed');
  push(5_000, 5_100);
  assert.equal(sockets.last.audioFrames().length, 1);
  sockets.last.serverSend(dgResults({ start: 0, duration: 0.1, isFinal: true, words: [{ word: 'Next', start: 0.01, end: 0.09 }] }));
  const finishing = session.finish();
  sockets.last.serverClose(1000);
  const { revision } = await finishing;
  assert.deepEqual(revision.gaps, [{ provider: 'deepgram', startMs: 1_000, endMs: 5_000, reason: 'disconnected' }]);
  assert.equal(revision.segments[1].words[0].startMs, 5_010);
});

test('a rejected key stops at once: no retry, no other provider, capture keeps its audio as a gap', async () => {
  const { sockets, timers, session, push, credentialCalls } = harness({
    credential: () => {
      throw new ProviderErrorException(classifyDeepgramHttp(401, 'Invalid credentials.'));
    },
  });
  push(0, 100);
  await settle();
  const status = session.snapshot().status;
  assert.deepEqual([status.phase, status.error?.kind, status.error?.message], ['stopped', 'auth', 'Invalid credentials.']);
  push(100, 1_000);
  timers.advance(60_000);
  await settle();
  assert.equal(sockets.sockets.length, 0);
  assert.equal(credentialCalls(), 1);
  const { revision } = await session.finish();
  assert.deepEqual(revision.gaps, [{ provider: 'deepgram', startMs: 0, endMs: 1_000, reason: 'auth-failed' }]);
  assert.deepEqual(revision.segments, []);
});

test('a refused handshake is re-checked through the credential call, which names the key as the cause', async () => {
  const { sockets, timers, session, push } = harness({
    credential: (call) => {
      if (call === 1) return { kind: 'temporary-token', token: 'jwt-1', expiresAtMs: 0 };
      throw new ProviderErrorException(classifyDeepgramHttp(401, 'Invalid credentials.'));
    },
  });
  push(0, 500);
  await settle();
  sockets.last.serverClose(1006);
  await settle();
  assert.equal(session.snapshot().status.phase, 'reconnecting');
  timers.advance(1_000);
  await settle();
  assert.equal(session.snapshot().status.phase, 'stopped');
  assert.equal(session.snapshot().status.error?.kind, 'auth');
  assert.equal(sockets.sockets.length, 1);
  const { revision } = await session.finish();
  assert.deepEqual(revision.gaps, [{ provider: 'deepgram', startMs: 0, endMs: 500, reason: 'auth-failed' }]);
});

test('rate limiting waits for Retry-After before the next attempt', async () => {
  const { sockets, timers, session, push } = harness({
    credential: (call) => {
      if (call === 1) throw new ProviderErrorException({ ...classifyDeepgramHttp(429), retryAfterMs: 7_000 });
      return { kind: 'temporary-token', token: 'jwt', expiresAtMs: 0 };
    },
  });
  push(0, 100);
  await settle();
  assert.equal(session.snapshot().status.error?.kind, 'rate-limit');
  timers.advance(6_999);
  await settle();
  assert.equal(sockets.sockets.length, 0);
  timers.advance(1);
  await openLast(sockets);
  assert.equal(session.snapshot().status.phase, 'live');
});

test('after repeated failures the session stops; an explicit retry uses the same provider and closes the gap', async () => {
  const { sockets, timers, session, push } = harness({ reconnect: { maxAttempts: 2, maxReplayMs: 2_000 } });
  push(0, 100);
  await openLast(sockets);
  sockets.last.serverSend(dgResults({ start: 0, duration: 0.1, isFinal: true, words: [] }));
  sockets.last.serverClose(1011, '');
  timers.advance(1_000);
  await settle();
  sockets.last.serverClose(1006);
  await settle();
  timers.advance(2_000);
  await settle();
  sockets.last.serverClose(1006);
  await settle();
  assert.equal(session.snapshot().status.phase, 'stopped');
  assert.equal(sockets.sockets.length, 3);
  timers.advance(60_000);
  await settle();
  assert.equal(sockets.sockets.length, 3, 'no automatic retry after stopping');

  push(100, 6_000);
  session.retry();
  await openLast(sockets);
  assert.equal(session.snapshot().status.phase, 'live');
  assert.ok(sockets.sockets.every((socket) => socket.url.startsWith('wss://api.deepgram.com/v1/listen')));
  const finishing = session.finish();
  sockets.last.serverClose(1000);
  const { revision } = await finishing;
  assert.deepEqual(revision.gaps, [{ provider: 'deepgram', startMs: 100, endMs: 6_000, reason: 'disconnected' }]);
});

test('a recorder pause starts a new connection at the resumed audio; the pause is not a gap', async () => {
  const { sockets, session, push } = harness();
  push(0, 1_000);
  await openLast(sockets);
  const first = sockets.last;
  first.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'Before', start: 0.1, end: 0.5 }] }));
  session.pushAudio(pcm(5_000, 100));
  assert.deepEqual(first.textFrames().at(-1), { type: 'CloseStream' });
  first.serverClose(1000);
  await openLast(sockets);
  assert.equal(sockets.sockets.length, 2);
  assert.equal(sockets.last.audioFrames().length, 1);
  sockets.last.serverSend(dgResults({ start: 0, duration: 0.1, isFinal: true, words: [{ word: 'after', start: 0.02, end: 0.08 }] }));
  const finishing = session.finish();
  sockets.last.serverClose(1000);
  const { revision } = await finishing;
  assert.deepEqual(revision.segments.map((segment) => [segment.text, segment.words[0].startMs]), [['Before', 100], ['after', 5_020]]);
  assert.deepEqual(revision.gaps, []);
});

test('the user can stop transcription mid-recording; the rest is a user-stopped gap', async () => {
  const { sockets, session, push } = harness();
  push(0, 1_000);
  await openLast(sockets);
  sockets.last.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'Hello', start: 0.1, end: 0.5 }] }));
  const stopping = session.stopTranscribing();
  sockets.last.serverClose(1000);
  await stopping;
  assert.equal(session.snapshot().status.phase, 'stopped');
  push(1_000, 3_000);
  const { revision } = await session.finish();
  assert.deepEqual(revision.gaps, [{ provider: 'deepgram', startMs: 1_000, endMs: 3_000, reason: 'user-stopped-provider' }]);
});

test('a direct key never appears in snapshots, errors or the transcript', async () => {
  const { sockets, timers, updates, session, push } = harness({ credential: () => ({ kind: 'api-key', key: FAKE_KEY }) });
  push(0, 1_000);
  await openLast(sockets);
  assert.deepEqual(sockets.last.protocols, ['token', FAKE_KEY]);
  sockets.last.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'Hi', start: 0.1, end: 0.3 }] }));
  sockets.last.serverClose(1011, `NET-0001 for ${FAKE_KEY}`);
  timers.advance(1_000);
  await openLast(sockets);
  const finishing = session.finish();
  sockets.last.serverClose(1000);
  const result = await finishing;
  const serialized = JSON.stringify({ updates, result });
  assert.ok(serialized.includes('NET-0001'));
  assert.ok(!serialized.includes(FAKE_KEY));
  assert.equal(result.service?.auth, 'api-key');
});

test('pushAudio after finish is ignored and never throws', async () => {
  const { session } = harness();
  await session.finish();
  session.pushAudio(pcm(0, 100));
  assert.equal(session.snapshot().status.phase, 'finished');
});

test('a socket constructor that throws is a failed connect: the session retries instead of hanging in connecting', async () => {
  const sockets = new SocketRecorder();
  const timers = new ManualTimers();
  let creates = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const session = createDeepgramSession({
      getCredential: async () => ({ kind: 'temporary-token', token: `jwt-${creates + 1}`, expiresAtMs: 0 }),
      createSocket: (url, protocols) => {
        creates += 1;
        if (creates === 1) throw new SyntaxError("Failed to construct 'WebSocket': invalid subprotocol");
        return sockets.create(url, protocols);
      },
      timers,
      createId: () => `id-${creates}`,
    });
    for (let at = 0; at < 1_000; at += 100) session.pushAudio(pcm(at, 100));
    await settle();
    const status = session.snapshot().status;
    assert.deepEqual([status.phase, status.attempt, status.error?.code], ['reconnecting', 1, 'unknown']);
    assert.match(status.error?.message ?? '', /invalid subprotocol/);

    timers.advance(1_000);
    await openLast(sockets);
    assert.equal(session.snapshot().status.phase, 'live');
    assert.equal(sockets.last.audioFrames().length, 10, 'buffered audio reaches the retried connection');

    sockets.last.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'Start', start: 0.1, end: 0.9 }] }));
    const finishing = session.finish();
    sockets.last.serverClose(1000);
    const { revision } = await finishing;
    assert.deepEqual(revision.segments.map((segment) => segment.text), ['Start']);
    assert.deepEqual(revision.gaps, []);
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
