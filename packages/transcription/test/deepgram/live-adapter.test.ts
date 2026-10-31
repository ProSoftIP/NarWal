import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdapterEvent, LiveSessionOptions } from '../../src/contract.ts';
import { DeepgramLiveAdapter } from '../../src/deepgram/live-adapter.ts';
import { ProviderErrorException } from '../../src/provider-error.ts';
import { FAKE_KEY, ManualTimers, SocketRecorder, fixture, pcm, settle } from '../helpers.ts';

function setup(credential: LiveSessionOptions['credential'] = { kind: 'temporary-token', token: 'jwt-1', expiresAtMs: 0 }) {
  const sockets = new SocketRecorder();
  const timers = new ManualTimers();
  const adapter = new DeepgramLiveAdapter({ createSocket: sockets.create, timers });
  const events: AdapterEvent[] = [];
  const started = adapter.start({ credential, language: 'en', audioOriginMs: 2_000, connectionId: 'c1' }, (event) => events.push(event));
  return { sockets, timers, adapter, events, started };
}

test('opens with the bearer subprotocol and flushes audio queued while connecting', async () => {
  const { sockets, adapter, events, started } = setup();
  adapter.sendAudio(pcm(2_000, 100).data);
  adapter.sendAudio(pcm(2_100, 100).data);
  const socket = sockets.last;
  assert.deepEqual(socket.protocols, ['bearer', 'jwt-1']);
  assert.equal(new URL(socket.url).searchParams.get('encoding'), 'linear16');
  socket.serverOpen();
  await started;
  assert.equal(socket.audioFrames().length, 2);
  assert.deepEqual(events.filter((event) => event.type === 'state').map((event) => event.type === 'state' && event.state), ['connecting', 'open']);
});

test('sends KeepAlive only after 4 s without audio', async () => {
  const { sockets, timers, adapter, started } = setup();
  sockets.last.serverOpen();
  await started;
  timers.advance(3_000);
  adapter.sendAudio(pcm(2_000, 100).data);
  timers.advance(3_000);
  assert.deepEqual(sockets.last.textFrames(), []);
  timers.advance(1_000);
  assert.deepEqual(sockets.last.textFrames(), [{ type: 'KeepAlive' }]);
});

test('finish sends CloseStream, keeps the flushed finals and resolves on the close', async () => {
  const { sockets, adapter, events, started } = setup();
  const socket = sockets.last;
  socket.serverOpen();
  await started;
  const flush = fixture('deepgram/flush-on-close.json');
  for (const message of flush.beforeClose) socket.serverSend(message);
  const finished = adapter.finish();
  assert.deepEqual(socket.textFrames().at(-1), { type: 'CloseStream' });
  for (const message of flush.afterCloseStream) socket.serverSend(message);
  socket.serverClose(1000);
  await finished;
  const finals = events.flatMap((event) => (event.type === 'segment' && event.segment.kind === 'final' ? [event.segment] : []));
  assert.deepEqual(finals.map((segment) => segment.text), ['Open the report.', 'Then click export.']);
  assert.equal(finals[1].startMs, 3_800);
  assert.equal(events.filter((event) => event.type === 'error').length, 0, 'a clean finish is not an error');
  assert.deepEqual(adapter.serviceRecord(), {
    provider: 'deepgram',
    api: 'wss://api.deepgram.com/v1/listen',
    requestedModel: 'nova-3',
    reportedModel: 'general-nova-3',
    modelVersion: '2026-01-01.0',
    requestIds: ['req-flush'],
    auth: 'temporary-token',
  });
});

test('finish gives up after the timeout and closes the socket itself', async () => {
  const { sockets, timers, adapter, started } = setup();
  sockets.last.serverOpen();
  await started;
  const finished = adapter.finish();
  timers.advance(10_000);
  await finished;
  assert.equal(sockets.last.closedByClient?.reason, 'finish timeout');
});

test('an unexpected close becomes a classified error event, with secrets redacted', async () => {
  const { sockets, adapter, events, started } = setup({ kind: 'api-key', key: FAKE_KEY });
  assert.deepEqual(sockets.last.protocols, ['token', FAKE_KEY]);
  sockets.last.serverOpen();
  await started;
  sockets.last.serverClose(1011, `NET-0001 idle ${FAKE_KEY}`);
  const error = events.find((event) => event.type === 'error');
  assert.ok(error && error.type === 'error');
  assert.equal(error.error.kind, 'timeout');
  assert.ok(!error.error.message.includes(FAKE_KEY));
  assert.deepEqual(events.at(-1), { type: 'state', state: 'closed' });
  adapter.sendAudio(pcm(0, 100).data); // ignored after close, no throw
  assert.equal(adapter.serviceRecord().auth, 'api-key');
});

test('a refused handshake rejects start with a network error and emits no error event', async () => {
  const { sockets, events, started } = setup();
  sockets.last.serverClose(1006);
  await assert.rejects(started, (thrown) => thrown instanceof ProviderErrorException && thrown.error.kind === 'network');
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
});

test('a socket that never opens times out', async () => {
  const { timers, started } = setup();
  timers.advance(10_000);
  await assert.rejects(started, (thrown) => thrown instanceof ProviderErrorException && thrown.error.code === 'connect-timeout');
});

test('abort closes at once and ignores later messages', async () => {
  const { sockets, adapter, events, started } = setup();
  sockets.last.serverOpen();
  await started;
  adapter.abort();
  sockets.last.serverSend(fixture('deepgram/flush-on-close.json').afterCloseStream[0]);
  await settle();
  assert.equal(events.filter((event) => event.type === 'segment').length, 0);
  assert.equal(sockets.last.closedByClient?.reason, 'aborted');
});

test('abort while connecting rejects start, so nothing waits on it forever', async () => {
  const { sockets, adapter, started } = setup();
  adapter.abort();
  await assert.rejects(started, (thrown: unknown) => {
    assert.ok(thrown instanceof ProviderErrorException);
    assert.equal(thrown.error.code, 'aborted');
    assert.equal(thrown.error.retryable, false);
    return true;
  });
  assert.equal(sockets.last.closedByClient?.reason, 'aborted');
  sockets.last.serverOpen();
  adapter.sendAudio(pcm(2_000, 100).data);
  assert.equal(sockets.last.audioFrames().length, 0, 'a late open after abort sends nothing');
});
