import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdapterEvent, LiveCredential } from '../../src/contract.ts';
import { AssemblyAiConnectError, AssemblyAiLiveAdapter } from '../../src/assemblyai/adapter.ts';
import { FakeSocket, ManualClock, bytesToMs, fixture, pcm, segments, settle } from './helpers.ts';

function setup(options: ConstructorParameters<typeof AssemblyAiLiveAdapter>[0] = {}) {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const adapter = new AssemblyAiLiveAdapter({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  const events: AdapterEvent[] = [];
  const token = (): LiveCredential => ({ kind: 'temporary-token', token: 'tmp-token-1', expiresAtMs: clock.nowMs + 60_000 });
  const start = (audioOriginMs = 0, credential: LiveCredential = token()) =>
    adapter.start({ credential, language: 'en', audioOriginMs, connectionId: 'c1' }, (event) => events.push(event));
  const states = () => events.flatMap((event) => (event.type === 'state' ? [event.state] : []));
  const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
  return { adapter, clock, sockets, events, start, states, errors };
}

const BEGIN = { type: 'Begin', id: 's1', expires_at: 1792000000, configuration: { model: 'universal-streaming-english' } };

async function openSession(context: ReturnType<typeof setup>, audioOriginMs = 0) {
  const started = context.start(audioOriginMs);
  const socket = context.sockets[0];
  socket.open();
  socket.receive(BEGIN);
  await started;
  return socket;
}

test('start: socket URL carries the temporary token, never an API key; resolves on Begin', async () => {
  const context = setup();
  const socket = await openSession(context);
  const url = new URL(socket.url);
  assert.equal(url.searchParams.get('token'), 'tmp-token-1');
  assert.equal(url.searchParams.get('speech_model'), 'universal-streaming-english');
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(context.states(), ['connecting', 'open']);
  assert.equal(context.adapter.reportedModel, 'universal-streaming-english');
  assert.equal(context.clock.pending, 0, 'connect timer cleared');
  await assert.rejects(context.start(), /runs once/);
});

test('token expiry: an expired or nearly expired token is refused before any socket opens, as retryable', async () => {
  const context = setup();
  const expired = { kind: 'temporary-token' as const, token: 'old', expiresAtMs: context.clock.nowMs + 4_000 };
  await assert.rejects(context.start(0, expired), (error: unknown) => {
    assert.ok(error instanceof AssemblyAiConnectError);
    assert.equal(error.error.code, 'token-expired');
    assert.equal(error.error.kind, 'auth');
    assert.equal(error.error.retryable, true);
    return true;
  });
  assert.equal(context.sockets.length, 0);
  assert.deepEqual(context.states(), ['connecting', 'closed']);
  assert.deepEqual(context.errors(), [], 'start failures surface only as the rejection');
});

test('start: a raw API key is refused; it must stay in the service worker', async () => {
  const context = setup();
  await assert.rejects(context.start(0, { kind: 'api-key', key: 'fixture-key-not-real' }), (error: unknown) => {
    assert.equal((error as AssemblyAiConnectError).error.code, 'api-key-refused');
    assert.equal((error as AssemblyAiConnectError).error.retryable, false);
    assert.ok(!(error as Error).message.includes('fixture-key-not-real'));
    return true;
  });
  assert.equal(context.sockets.length, 0);
});

test('start: close before Begin rejects with the Error frame classification and emits no error event', async () => {
  const context = setup();
  const started = context.start();
  const socket = context.sockets[0];
  socket.open();
  socket.receive({ type: 'Error', error_code: 1008, error: 'Unauthorized Connection: Insufficient balance' });
  socket.serverClose(1008, 'See Error message for details');
  await assert.rejects(started, (error: unknown) => {
    assert.equal((error as AssemblyAiConnectError).error.kind, 'quota');
    assert.equal((error as AssemblyAiConnectError).error.retryable, false);
    return true;
  });
  assert.deepEqual(context.errors(), []);
  assert.deepEqual(context.states(), ['connecting', 'closed']);
});

test('start: a failed handshake (1006) rejects as a retryable network error; the message never holds the token', async () => {
  const context = setup();
  const started = context.start();
  context.sockets[0].serverClose(1006, '');
  await assert.rejects(started, (error: unknown) => {
    assert.equal((error as AssemblyAiConnectError).error.kind, 'network');
    assert.equal((error as AssemblyAiConnectError).error.retryable, true);
    assert.ok(!JSON.stringify((error as AssemblyAiConnectError).error).includes('tmp-token-1'));
    return true;
  });
});

test('start: no Begin within the connect timeout closes the socket and rejects', async () => {
  const context = setup({ connectTimeoutMs: 2_000 });
  const started = context.start();
  context.sockets[0].open();
  context.clock.advance(2_000);
  await assert.rejects(started, (error: unknown) => (error as AssemblyAiConnectError).error.code === 'connect-timeout');
  assert.ok(context.sockets[0].closedWith);
});

test('audio: chunks are reframed to 100 ms messages; audio sent before Begin waits for it', async () => {
  const context = setup();
  const started = context.start();
  const socket = context.sockets[0];
  socket.open();
  context.adapter.sendAudio(pcm(130));
  assert.equal(socket.audioFrames.length, 0, 'nothing before Begin');
  socket.receive(BEGIN);
  await started;
  assert.deepEqual(socket.audioFrames.map((frame) => bytesToMs(frame.byteLength)), [100]);
  context.adapter.sendAudio(pcm(30));
  context.adapter.sendAudio(pcm(30));
  context.clock.advance(100);
  context.adapter.sendAudio(pcm(30));
  assert.deepEqual(socket.audioFrames.map((frame) => bytesToMs(frame.byteLength)), [100, 100]);
});

test('pacing: a replayed backlog never exceeds 1.2x real time plus one frame', async () => {
  const context = setup();
  const socket = await openSession(context);
  context.adapter.sendAudio(pcm(10_000));
  const sentMs = () => socket.audioFrames.reduce((total, frame) => total + bytesToMs(frame.byteLength), 0);
  assert.equal(sentMs(), 100);
  for (let elapsed = 250; elapsed <= 5_000; elapsed += 250) {
    context.clock.advance(250);
    assert.ok(sentMs() <= elapsed * 1.2 + 100 + 1e-9, `at ${elapsed} ms sent ${sentMs()} ms`);
    assert.ok(sentMs() >= elapsed * 1.2 - 100, `pacer keeps up at ${elapsed} ms (sent ${sentMs()} ms)`);
  }
  context.clock.advance(10_000);
  assert.equal(sentMs(), 10_000);
});

test('finish: pads the tail, sends ForceEndpoint then Terminate, promotes the turn left unformatted, resolves on close', async () => {
  const context = setup();
  const socket = await openSession(context, 5_000);
  for (const message of fixture('session-formatted.json').messages.slice(1)) socket.receive(message);
  context.adapter.sendAudio(pcm(120));
  const finished = context.adapter.finish();
  assert.equal(context.adapter.finish(), finished, 'finish is idempotent');
  context.clock.advance(50);
  const frames = socket.audioFrames.map((frame) => bytesToMs(frame.byteLength));
  assert.deepEqual(frames, [100, 50], 'a 20 ms tail is padded to the 50 ms minimum');
  assert.deepEqual(socket.controlMessages, ['ForceEndpoint', 'Terminate']);
  socket.receive({ type: 'Termination', audio_duration_seconds: 3, session_duration_seconds: 4 });
  socket.serverClose(1000, '');
  await finished;
  const finals = settle(segments(context.events));
  assert.deepEqual(finals.map((segment) => segment.text), ['Click the Save button.', 'then wait']);
  assert.deepEqual([finals[1].startMs, finals[1].endMs], [7_200, 7_750]);
  assert.deepEqual(context.errors(), [], 'a clean close is not an error');
  assert.deepEqual(context.states(), ['connecting', 'open', 'closing', 'closed']);
  assert.deepEqual(context.events.find((event) => event.type === 'usage'), {
    type: 'usage',
    provider: 'assemblyai',
    audioSeconds: 4,
    basis: 'session-duration-seconds',
  });
  context.adapter.sendAudio(pcm(100));
  assert.equal(socket.audioFrames.length, 2, 'no audio after finish');
});

test('finish: waits for paced backlog before Terminate', async () => {
  const context = setup();
  const socket = await openSession(context);
  context.adapter.sendAudio(pcm(1_000));
  void context.adapter.finish();
  assert.deepEqual(socket.controlMessages, []);
  context.clock.advance(1_000);
  assert.deepEqual(socket.controlMessages, ['ForceEndpoint', 'Terminate']);
});

test('finish: with no reply, the timeout closes the socket and still resolves with finals', async () => {
  const context = setup({ finishTimeoutMs: 3_000 });
  const socket = await openSession(context);
  socket.receive({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: false, transcript: 'hello there',
    words: [{ text: 'hello', start: 0, end: 300, word_is_final: true }, { text: 'there', start: 300, end: 600, word_is_final: true }] });
  const finished = context.adapter.finish();
  context.clock.advance(3_000);
  await finished;
  assert.deepEqual(socket.closedWith?.code, 1000);
  assert.deepEqual(settle(segments(context.events)).map((segment) => segment.text), ['hello there']);
  assert.equal(context.states().at(-1), 'closed');
});

test('mid-session close: 3008 max duration is one retryable timeout error; Error frame plus close is reported once', async () => {
  const context = setup();
  const socket = await openSession(context);
  socket.serverClose(3008, 'Session Expired: Maximum session duration exceeded');
  assert.deepEqual(context.errors().map((error) => [error.kind, error.retryable, error.code]), [['timeout', true, '3008']]);
  assert.equal(context.states().at(-1), 'closed');

  const second = setup();
  const socket2 = await openSession(second);
  socket2.receive({ type: 'Error', error_code: 3005, error: 'Session Cancelled: An error occurred' });
  socket2.serverClose(3005, 'Session Cancelled: An error occurred');
  assert.deepEqual(second.errors().map((error) => [error.kind, error.code]), [['provider', '3005']]);
});

test('mid-session close: interim and unformatted turns are not promoted, so the session replays from lastFinalEndMs', async () => {
  const context = setup();
  const socket = await openSession(context, 10_000);
  const messages = fixture('session-formatted.json').messages.slice(1);
  for (const message of messages) socket.receive(message);
  socket.serverClose(1006, '');
  assert.deepEqual(settle(segments(context.events)).map((segment) => segment.text), ['Click the Save button.']);
  assert.equal(context.adapter.lastFinalEndMs, 11_380);
  assert.deepEqual(context.errors().map((error) => error.kind), ['network']);
});

test('abort: sends Terminate, closes at once, drops interims, ignores later messages', async () => {
  const context = setup();
  const socket = await openSession(context);
  socket.receive({ type: 'Turn', turn_order: 0, end_of_turn: false, transcript: '', words: [{ text: 'half', start: 0, end: 200, word_is_final: false }] });
  context.adapter.sendAudio(pcm(500));
  context.adapter.abort();
  assert.ok(socket.controlMessages.includes('Terminate'));
  assert.equal(socket.closedWith?.code, 1000);
  assert.equal(context.states().at(-1), 'closed');
  socket.receive({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'half done', words: [] });
  assert.deepEqual(settle(segments(context.events)), []);
  assert.equal(context.clock.pending, 0, 'no timers left');
  context.adapter.abort();
});

test('a listener that throws does not strand start() or finish()', async () => {
  const context = setup({ finishTimeoutMs: 1_000 });
  const thrown: string[] = [];
  const started = context.adapter.start(
    { credential: { kind: 'temporary-token', token: 'tmp-token-1', expiresAtMs: context.clock.nowMs + 60_000 }, language: 'en', audioOriginMs: 0, connectionId: 'c1' },
    (event) => {
      if (event.type === 'state') {
        thrown.push(event.state);
        throw new Error(`listener fault on ${event.state}`);
      }
    },
  );
  const socket = context.sockets[0];
  socket.open();
  socket.receive(BEGIN);
  await started;
  context.adapter.sendAudio(pcm(100));
  assert.equal(socket.audioFrames.length, 1, 'queued audio still sent after a throwing open listener');
  const finished = context.adapter.finish();
  socket.receive({ type: 'Termination', audio_duration_seconds: 0, session_duration_seconds: 1 });
  socket.serverClose(1000, '');
  await finished;
  assert.deepEqual(thrown, ['connecting', 'open', 'closing', 'closed']);
});

test('abort while connecting rejects start() as non-retryable', async () => {
  const context = setup();
  const started = context.start();
  context.adapter.abort();
  await assert.rejects(started, (error: unknown) => (error as AssemblyAiConnectError).error.code === 'aborted');
});
