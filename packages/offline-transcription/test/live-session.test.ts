// Board #16544: the live session against a scripted engine. Covers the event
// contract, flow control, falling behind, skipping ahead, engine failure and
// restart, a missing model, and Stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterEvent } from '../src/contract.ts';
import { LocalLiveSession } from '../src/live-session.ts';
import type { LiveEngine, LiveEngineMessage, LiveSessionConfig } from '../src/live-session.ts';
import { ModelError } from '../src/model-store.ts';

const RATE = 16000;
const audio = (ms: number, value = 0.1) => new Float32Array((ms * RATE) / 1000).fill(value);

class ScriptedEngine implements LiveEngine {
  fed: Float32Array[] = [];
  flushes = 0;
  closed = false;
  send: (message: LiveEngineMessage) => void = () => {};
  feed(samples: Float32Array): void {
    this.fed.push(samples);
  }
  flush(): void {
    this.flushes += 1;
  }
  close(): void {
    this.closed = true;
  }
  get fedSamples(): number {
    return this.fed.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  partial(text: string): void {
    this.send({ type: 'partial', text });
  }
  result(text = '', words: { word: string; start: number; end: number; conf?: number }[] = []): void {
    this.send({ type: 'result', text, words });
  }
}

function setup(config: Partial<LiveSessionConfig> = {}) {
  const engines: ScriptedEngine[] = [];
  const events: AdapterEvent[] = [];
  const timers: (() => void)[] = [];
  const state = { clock: 0, failWith: null as Error | null, hold: false };
  const session = new LocalLiveSession({
    createEngine: async (onMessage) => {
      if (state.hold) await new Promise(() => {});
      if (state.failWith) throw state.failWith;
      const engine = new ScriptedEngine();
      engine.send = onMessage;
      engines.push(engine);
      return engine;
    },
    now: () => state.clock,
    timers: { set: (fn) => timers.push(fn), clear: () => {} },
    ...config,
  });
  const start = () => session.start({ language: 'en', audioOriginMs: 1000, connectionId: 'c' }, (event) => events.push(event));
  const of = <T extends AdapterEvent['type']>(type: T) => events.filter((event): event is Extract<AdapterEvent, { type: T }> => event.type === type);
  const states = () => of('state').map((event) => event.state);
  return { session, engines, events, timers, state, start, of, states };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('start opens the engine and reports the PCM format the cloud adapters use', async () => {
  const t = setup();
  await t.start();
  assert.deepEqual(t.states(), ['connecting', 'open']);
  assert.equal(t.session.provider, 'browser-local');
  assert.deepEqual(t.session.audioFormat, { kind: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  await assert.rejects(t.start(), /called twice/);
});

test('sendAudio takes 16-bit PCM; pushAudio copies the caller buffer', async () => {
  const t = setup();
  await t.start();
  const pcm = new Int16Array(1600).fill(16384);
  t.session.sendAudio(pcm.buffer);
  assert.equal(t.engines[0].fed[0].length, 1600);
  assert.ok(Math.abs(t.engines[0].fed[0][0] - 0.5) < 1e-3);
  const mine = audio(100, 0.25);
  t.session.pushAudio(mine);
  mine.fill(9);
  assert.equal(t.engines[0].fed[1][0], 0.25);
});

test('the engine never holds more than the window; queued audio is merged up to the chunk limit', async () => {
  const t = setup({ window: 2, maxChunkMs: 500 });
  await t.start();
  for (let i = 0; i < 20; i += 1) t.session.pushAudio(audio(100));
  const engine = t.engines[0];
  assert.equal(engine.fed.length, 2);
  engine.partial('');
  assert.equal(engine.fed.length, 3);
  assert.equal(engine.fed[2].length, 0.5 * RATE);
  let answered = 1;
  while (answered < engine.fed.length) {
    engine.partial('');
    answered += 1;
    assert.ok(engine.fed.length - answered <= 2);
  }
  assert.equal(engine.fedSamples, 2 * RATE);
  assert.equal(t.session.stats().processedSamples, 2 * RATE);
  assert.equal(t.session.stats().lagMs, 0);
});

test('partials become interim segments without word times; a repeat or an empty partial adds nothing', async () => {
  const t = setup();
  await t.start();
  t.session.pushAudio(audio(100));
  t.session.pushAudio(audio(100));
  t.session.pushAudio(audio(100));
  t.engines[0].partial('hello');
  t.engines[0].partial('hello');
  t.engines[0].partial('');
  const segments = t.of('segment');
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].segment, {
    provider: 'browser-local',
    model: 'vosk-small-en-us',
    connectionId: 'c',
    segmentKey: 'c:0',
    kind: 'interim',
    startMs: 1000,
    endMs: 1100,
    text: 'hello',
    words: [],
    endOfUtterance: false,
    timing: 'approximate',
  });
});

test('a result becomes a final segment with word times on the session clock; the next utterance has a new key', async () => {
  const t = setup();
  await t.start();
  t.session.pushAudio(audio(400));
  t.engines[0].partial('hello');
  t.session.pushAudio(audio(400));
  t.engines[0].result('hello world', [
    { word: 'hello', start: 0.1, end: 0.3, conf: 0.9 },
    { word: 'world', start: 0.35, end: 0.6 },
  ]);
  t.session.pushAudio(audio(200));
  t.engines[0].partial('again');
  const [interim, final, next] = t.of('segment').map((event) => event.segment);
  assert.equal(interim.segmentKey, final.segmentKey);
  assert.equal(final.kind, 'final');
  assert.equal(final.timing, 'aligned');
  assert.equal(final.endOfUtterance, true);
  assert.deepEqual(final.words, [
    { text: 'hello', startMs: 1100, endMs: 1300, confidence: 0.9 },
    { text: 'world', startMs: 1350, endMs: 1600 },
  ]);
  assert.equal(final.startMs, 1100);
  assert.equal(final.endMs, 1600);
  assert.equal(next.segmentKey, 'c:1');
  assert.equal(next.startMs, 1800);
});

test('an empty result retracts a shown interim and is silent otherwise', async () => {
  const t = setup();
  await t.start();
  t.session.pushAudio(audio(100));
  t.engines[0].result('');
  assert.equal(t.of('segment').length, 0);
  t.session.pushAudio(audio(100));
  t.engines[0].partial('uh');
  t.session.pushAudio(audio(100));
  t.engines[0].result('');
  const segments = t.of('segment').map((event) => event.segment);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].kind, 'final');
  assert.equal(segments[1].text, '');
  assert.equal(segments[1].segmentKey, segments[0].segmentKey);
});

test('falling behind is reported, with the lag, and so is recovery', async () => {
  const t = setup({ behindMs: 1000, recoveredMs: 300, maxBacklogMs: 60000 });
  await t.start();
  for (let i = 0; i < 10; i += 1) t.session.pushAudio(audio(100));
  assert.equal(t.of('backlog').length, 0);
  t.session.pushAudio(audio(100));
  assert.deepEqual(t.of('backlog').at(-1), { type: 'backlog', behind: true, lagMs: 1100 });
  assert.equal(t.session.stats().behind, true);
  const engine = t.engines[0];
  for (let answered = 0; answered < engine.fed.length; answered += 1) engine.partial('');
  assert.deepEqual(t.of('backlog').at(-1), { type: 'backlog', behind: false, lagMs: 0 });
  assert.equal(t.session.stats().maxLagMs, 1100);
  assert.equal(t.session.stats().receivedSamples, 1.1 * RATE);
});

test('past the backlog limit the session skips ahead: the skipped audio is a gap and later word times stay on the session clock', async () => {
  const t = setup({ window: 2, maxBacklogMs: 1000, keepAfterSkipMs: 200, behindMs: 60000 });
  await t.start();
  const engine = t.engines[0];
  for (let i = 0; i < 13; i += 1) t.session.pushAudio(audio(100));
  // 2 chunks (200 ms) are with the engine, 1100 ms queued: 900 ms are dropped, 200 ms kept.
  assert.equal(engine.fed.length, 2);
  assert.equal(engine.flushes, 1);
  assert.equal(t.of('gap').length, 0, 'the gap is announced after the engine closes the utterance it was in');
  engine.partial('before');
  engine.partial('before the');
  engine.result('before the skip', [{ word: 'before', start: 0.05, end: 0.15 }]);
  assert.deepEqual(t.of('gap')[0].gap, {
    provider: 'browser-local',
    startMs: 1200,
    endMs: 2100,
    reason: 'engine-behind',
    detail: 'live recognition skipped ahead; retry from the captured audio',
  });
  assert.equal(t.session.stats().skips, 1);
  assert.equal(t.session.stats().receivedSamples, 1.3 * RATE);
  assert.equal(engine.fedSamples, 0.4 * RATE, 'the kept 200 ms went to the engine after the skip');
  // The engine has now heard 0.4 s; its 0.25 s is 50 ms into the audio after the skip.
  engine.result('after', [{ word: 'after', start: 0.25, end: 0.35 }]);
  const after = t.of('segment').at(-1)!.segment;
  assert.equal(after.connectionId, 'c.1');
  assert.equal(after.segmentKey, 'c.1:0');
  assert.deepEqual(after.words, [{ text: 'after', startMs: 2150, endMs: 2250 }]);
});

test('a missing model does not reject start: error, closed, and the audio is one gap', async () => {
  const t = setup();
  t.state.failWith = new ModelError('model-missing', 'vosk-small-en-us', 'not downloaded');
  await t.start();
  assert.deepEqual(t.states(), ['connecting', 'closed']);
  assert.deepEqual(t.of('error')[0].error, { provider: 'browser-local', kind: 'model', retryable: false, code: 'model-missing', message: 'not downloaded' });
  for (let i = 0; i < 10; i += 1) t.session.pushAudio(audio(100));
  assert.equal(t.session.stats().receivedSamples, RATE);
  await t.session.finish();
  assert.deepEqual(t.of('gap').map((event) => event.gap), [{ provider: 'browser-local', startMs: 1000, endMs: 2000, reason: 'model-missing' }]);
  assert.deepEqual(t.states(), ['connecting', 'closed']);
  assert.equal(t.engines.length, 0);
});

test('a corrupt model is reported as model-corrupt', async () => {
  const t = setup();
  t.state.failWith = new ModelError('model-corrupt', 'vosk-small-en-us', 'bad file');
  await t.start();
  t.session.pushAudio(audio(500));
  await t.session.finish();
  assert.equal(t.of('error')[0].error.code, 'model-corrupt');
  assert.equal(t.of('gap')[0].gap.reason, 'model-corrupt');
});

test('an engine error restarts the engine; the audio it held is a gap; answers from the old engine are ignored', async () => {
  const t = setup({ maxRestarts: 1 });
  await t.start();
  const first = t.engines[0];
  t.session.pushAudio(audio(300));
  t.session.pushAudio(audio(300));
  first.partial('lost words');
  first.send({ type: 'error', message: 'wasm trap' });
  assert.equal(first.closed, true);
  const error = t.of('error')[0].error;
  assert.equal(error.kind, 'provider');
  assert.equal(error.retryable, true);
  assert.equal(error.code, 'engine-error');
  assert.deepEqual(t.of('gap')[0].gap, { provider: 'browser-local', startMs: 1000, endMs: 1600, reason: 'engine-failed', detail: 'engine-error' });
  const retracted = t.of('segment').at(-1)!.segment;
  assert.equal(retracted.kind, 'final');
  assert.equal(retracted.text, '');
  await settle();
  assert.deepEqual(t.states(), ['connecting', 'open', 'connecting', 'open']);
  assert.equal(t.engines.length, 2);
  first.result('ghost', [{ word: 'ghost', start: 0, end: 0.1 }]);
  assert.equal(t.of('segment').filter((event) => event.segment.text === 'ghost').length, 0);
  t.session.pushAudio(audio(200));
  t.engines[1].result('back', [{ word: 'back', start: 0.05, end: 0.15 }]);
  const back = t.of('segment').at(-1)!.segment;
  assert.equal(back.connectionId, 'c.1');
  assert.deepEqual(back.words, [{ text: 'back', startMs: 1650, endMs: 1750 }]);
  assert.equal(t.session.stats().restarts, 1);

  // A second failure is past the restart limit: the session stops transcribing, capture goes on.
  t.session.pushAudio(audio(100));
  t.engines[1].send({ type: 'error', message: 'again' });
  assert.equal(t.of('error').at(-1)!.error.retryable, false);
  assert.equal(t.states().at(-1), 'closed');
  t.session.pushAudio(audio(1000));
  await t.session.finish();
  const last = t.of('gap').at(-1)!.gap;
  assert.equal(last.reason, 'engine-failed');
  assert.equal(last.endMs, 1000 + 1900);
  assert.equal(t.session.stats().receivedSamples, 1.9 * RATE);
});

test('an engine that stops answering is restarted', async () => {
  const t = setup({ stallMs: 5000 });
  await t.start();
  t.session.pushAudio(audio(100));
  t.state.clock = 4000;
  t.session.pushAudio(audio(100));
  assert.equal(t.of('error').length, 0);
  t.state.clock = 5200;
  t.session.pushAudio(audio(100));
  assert.equal(t.of('error')[0].error.code, 'engine-stalled');
  assert.equal(t.engines[0].closed, true);
  assert.equal(t.states().at(-1), 'connecting');
});

test('finish drains the engine, flushes the last utterance and closes', async () => {
  const t = setup();
  await t.start();
  const engine = t.engines[0];
  t.session.pushAudio(audio(300));
  t.session.pushAudio(audio(300));
  t.session.pushAudio(audio(300));
  const done = t.session.finish();
  await settle();
  assert.equal(engine.flushes, 0, 'no flush while audio is still queued');
  engine.partial('one');
  engine.partial('one two');
  engine.partial('one two three');
  assert.equal(engine.flushes, 1);
  engine.result('one two three', [{ word: 'one', start: 0.1, end: 0.2 }]);
  await done;
  assert.deepEqual(t.states(), ['connecting', 'open', 'closing', 'closed']);
  assert.equal(t.of('segment').at(-1)!.segment.kind, 'final');
  assert.equal(t.of('gap').length, 0);
  assert.equal(engine.closed, true);
  t.session.pushAudio(audio(100));
  assert.equal(t.session.stats().receivedSamples, 0.9 * RATE, 'audio after finish is ignored');
});

test('finish does not wait for a slow engine: the unheard tail is a gap marked engine-behind', async () => {
  const t = setup();
  await t.start();
  t.session.pushAudio(audio(400));
  t.engines[0].partial('half');
  t.session.pushAudio(audio(400));
  const done = t.session.finish();
  await settle();
  t.timers.forEach((fire) => fire());
  await done;
  const gap = t.of('gap')[0].gap;
  assert.equal(gap.reason, 'engine-behind');
  assert.equal(gap.startMs, 1000);
  assert.equal(gap.endMs, 1800);
  assert.equal(t.of('segment').at(-1)!.segment.text, '', 'the interim is retracted, not left as text');
  assert.equal(t.states().at(-1), 'closed');
});

test('finish while the engine is still loading records the audio as a gap', async () => {
  const t = setup();
  t.state.hold = true;
  void t.start();
  await settle();
  t.session.pushAudio(audio(700));
  const done = t.session.finish();
  await settle();
  t.timers.forEach((fire) => fire());
  await done;
  assert.deepEqual(t.of('gap')[0].gap, { provider: 'browser-local', startMs: 1000, endMs: 1700, reason: 'engine-failed', detail: 'engine was not ready when the recording stopped' });
  assert.deepEqual(t.states(), ['connecting', 'closed']);
});

test('abort closes at once and ignores later engine answers', async () => {
  const t = setup();
  await t.start();
  t.session.pushAudio(audio(100));
  t.session.abort();
  assert.equal(t.engines[0].closed, true);
  assert.equal(t.states().at(-1), 'closed');
  t.engines[0].result('late', [{ word: 'late', start: 0, end: 0.05 }]);
  assert.equal(t.of('segment').length, 0);
});
