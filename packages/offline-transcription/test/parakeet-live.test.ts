// Board #16617: Parakeet on the live path. The span engine against a stubbed
// transcriber, the shared live worker, and the Parakeet-then-Vosk chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterEvent } from '../src/contract.ts';
import { LIVE_VAD, PARAKEET_LIVE_MODEL, SpanLiveEngine, parakeetLiveFactory } from '../src/engines/parakeet-live.ts';
import type { SpanRuntime } from '../src/engines/parakeet-live.ts';
import type { FinalEngineWord } from '../src/final-pass.ts';
import { liveEngineChain } from '../src/live-chain.ts';
import { LocalLiveSession } from '../src/live-session.ts';
import type { LiveEngine, LiveEngineFactory, LiveEngineMessage } from '../src/live-session.ts';
import { ModelError } from '../src/model-store.ts';

const RATE = 16000;
const audio = (ms: number, value: number) => new Float32Array((ms * RATE) / 1000).fill(value);
const speech = (ms: number) => audio(ms, 0.1);
const silence = (ms: number) => audio(ms, 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Feeds `parts` to the engine in 100 ms chunks. */
function feedChunks(engine: LiveEngine, ...parts: Float32Array[]): number {
  let chunks = 0;
  for (const part of parts) {
    for (let at = 0; at < part.length; at += RATE / 10) {
      engine.feed(part.subarray(at, Math.min(part.length, at + RATE / 10)));
      chunks += 1;
    }
  }
  return chunks;
}

function stubEngine(words: FinalEngineWord[] = [{ text: 'hello', start: 0.25, end: 0.6 }, { text: ' world', start: 0.7, end: 1.1 }]) {
  const messages: LiveEngineMessage[] = [];
  const calls: Float32Array[] = [];
  let closes = 0;
  const engine = new SpanLiveEngine({
    model: PARAKEET_LIVE_MODEL,
    transcribe: async (pcm) => {
      calls.push(pcm);
      return words;
    },
    onMessage: (message) => messages.push(message),
    biasMs: 30,
    onClose: () => {
      closes += 1;
    },
  });
  return { engine, messages, calls, closes: () => closes };
}

test('a feed that closes no span is answered with an empty partial; the feed that closes one with its words', async () => {
  const t = stubEngine();
  assert.equal(t.engine.model, PARAKEET_LIVE_MODEL);
  assert.equal(t.engine.timing, 'approximate');
  // Speech 0.5-1.5 s; the span is 0.3-1.7 s (0.2 s kept around speech) and closes at 2.1 s, after a 0.6 s pause.
  const chunks = feedChunks(t.engine, silence(500), speech(1000), silence(1000));
  await settle();
  assert.equal(t.messages.length, chunks, 'one answer per feed');
  const results = t.messages.map((message, index) => ({ message, index })).filter(({ message }) => message.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].index, 20, 'answered in the feed that ends at 2.1 s');
  assert.ok(t.messages.every((message) => message.type === 'result' || (message.type === 'partial' && message.text === '')));
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].length, 1.4 * RATE, 'the span, not the whole buffer');
  assert.equal(t.calls[0][0], 0, 'starts 0.2 s before the speech');
  assert.equal(t.calls[0][0.2 * RATE], Math.fround(0.1));
  const result = results[0].message as Extract<LiveEngineMessage, { type: 'result' }>;
  assert.equal(result.text, 'hello world');
  // Engine-fed seconds: span start + word time - 30 ms.
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  near(result.words[0].start, 0.52);
  near(result.words[0].end, 0.87);
  assert.equal(result.words[1].word, 'world');
  near(result.words[1].start, 0.97);
  near(result.words[1].end, 1.37);
});

test('answers stay in feed order while a span is being transcribed', async () => {
  const messages: LiveEngineMessage[] = [];
  let release: (words: FinalEngineWord[]) => void = () => {};
  const engine = new SpanLiveEngine({
    model: PARAKEET_LIVE_MODEL,
    transcribe: () => new Promise((resolve) => (release = resolve)),
    onMessage: (message) => messages.push(message),
  });
  feedChunks(engine, speech(1000), silence(700));
  await settle();
  assert.equal(messages.length, 15, 'the feeds before the span closed');
  feedChunks(engine, silence(300));
  await settle();
  assert.equal(messages.length, 15, 'later feeds wait for the span');
  release([{ text: 'one', start: 0.1, end: 0.3 }]);
  await settle();
  assert.deepEqual(
    messages.slice(15).map((message) => message.type),
    ['result', 'partial', 'partial', 'partial', 'partial'],
  );
});

test('flush closes the open span; audio after it is placed after everything fed before', async () => {
  const t = stubEngine([{ text: 'word', start: 0.1, end: 0.2 }]);
  feedChunks(t.engine, speech(1000));
  t.engine.flush();
  await settle();
  const first = t.messages.at(-1) as Extract<LiveEngineMessage, { type: 'result' }>;
  assert.equal(first.type, 'result');
  assert.equal(t.calls[0].length, RATE, 'the whole open span');
  // The session may skip audio here; the next span's times count from 1.0 s of fed audio.
  feedChunks(t.engine, silence(500), speech(500), silence(800));
  await settle();
  const second = t.messages.findLast((message) => message.type === 'result') as Extract<LiveEngineMessage, { type: 'result' }>;
  assert.equal(t.messages.filter((message) => message.type === 'result').length, 2);
  // The span starts at 1.3 s of fed audio (1.0 + 0.5 - 0.2); the word 0.1 s into it, less 30 ms.
  assert.ok(Math.abs(second.words[0].start - (1.3 + 0.1 - 0.03)) < 1e-9, String(second.words[0].start));
  t.engine.flush();
  await settle();
  assert.deepEqual(t.messages.at(-1), { type: 'result', text: '', words: [] }, 'a flush with no open span answers with no words');
});

test('a span longer than the live limit is cut, so text appears while someone keeps talking', async () => {
  const t = stubEngine([{ text: 'go', start: 0, end: 0.1 }]);
  feedChunks(t.engine, speech(9000));
  await settle();
  assert.equal(t.calls.length, 1);
  assert.ok(LIVE_VAD.maxSegS! < 9, 'the test speaks longer than the limit');
  assert.equal(t.calls[0].length, LIVE_VAD.maxSegS! * RATE);
});

test('a failed span is an error message; nothing is sent after close', async () => {
  const messages: LiveEngineMessage[] = [];
  const engine = new SpanLiveEngine({
    model: PARAKEET_LIVE_MODEL,
    transcribe: async () => {
      throw new Error('Parakeet worker stopped');
    },
    onMessage: (message) => messages.push(message),
  });
  feedChunks(engine, speech(500), silence(700));
  await settle();
  assert.deepEqual(messages.find((message) => message.type !== 'partial'), { type: 'error', message: 'Parakeet worker stopped' });
  const t = stubEngine();
  feedChunks(t.engine, speech(500));
  t.engine.close();
  t.engine.close();
  feedChunks(t.engine, silence(700));
  t.engine.flush();
  await settle();
  assert.equal(t.closes(), 1);
  assert.equal(t.messages.length, 0);
});

function stubRuntime(fail?: Error) {
  const runtime = { loads: 0, terminates: 0 };
  const api: SpanRuntime = {
    getEngine: async () => {
      runtime.loads += 1;
      if (fail) throw fail;
      return { transcribe: async () => [], timing: { method: 'tdt-token-times', biasMs: 30 } };
    },
    terminate: () => {
      runtime.terminates += 1;
    },
  };
  return { runtime, api };
}

test('live Parakeet engines share one worker, stopped when the last one closes', async () => {
  const { runtime, api } = stubRuntime();
  const factory = parakeetLiveFactory(api);
  const a = await factory(() => {});
  const b = await factory(() => {});
  assert.equal(a.model, PARAKEET_LIVE_MODEL);
  a.close();
  assert.equal(runtime.terminates, 0, 'one engine is still open');
  b.close();
  b.close();
  assert.equal(runtime.terminates, 1);
  const broken = stubRuntime(new ModelError('model-corrupt', PARAKEET_LIVE_MODEL, 'bad file'));
  await assert.rejects(parakeetLiveFactory(broken.api)(() => {}), ModelError);
  assert.equal(broken.runtime.terminates, 1, 'a failed load leaves no worker behind');
});

function chain(options: { installed?: boolean; primaryFails?: Error; fallbackFails?: Error } = {}) {
  const opened: string[] = [];
  const reasons: string[] = [];
  const make =
    (model: string, fails?: Error): LiveEngineFactory =>
    async () => {
      if (fails) throw fails;
      opened.push(model);
      return { model, feed: () => {}, flush: () => {}, close: () => {} };
    };
  const factory = liveEngineChain({
    primary: make('parakeet', options.primaryFails),
    fallback: make('vosk', options.fallbackFails),
    primaryInstalled: async () => options.installed ?? true,
    onPrimaryFailed: (reason) => reasons.push(reason),
  });
  return { factory, opened, reasons };
}

test('the live chain opens Parakeet when installed and Vosk when not', async () => {
  const installed = chain();
  assert.equal((await installed.factory(() => {})).model, 'parakeet');
  const missing = chain({ installed: false });
  assert.equal((await missing.factory(() => {})).model, 'vosk');
  assert.deepEqual(missing.reasons, [], 'a model that is not installed has not failed');
});

test('a Parakeet that cannot load falls back to Vosk for the rest of the document', async () => {
  const t = chain({ primaryFails: new Error('Parakeet model load timed out') });
  assert.equal((await t.factory(() => {})).model, 'vosk');
  assert.equal((await t.factory(() => {})).model, 'vosk');
  assert.deepEqual(t.reasons, ['Parakeet model load timed out']);
});

test('a Parakeet the session gave up on is not opened again; a normal close is no failure', async () => {
  const t = chain();
  (await t.factory(() => {})).close();
  assert.equal((await t.factory(() => {})).model, 'parakeet');
  (await t.factory(() => {})).close('failed');
  assert.equal((await t.factory(() => {})).model, 'vosk');
  assert.equal(t.reasons.length, 1);
});

test('with neither live model usable, the error names the one to repair', async () => {
  const corrupt = new ModelError('model-corrupt', PARAKEET_LIVE_MODEL, 'bad file');
  const voskMissing = new ModelError('model-missing', 'vosk-small-en-us', 'not installed');
  await assert.rejects(chain({ primaryFails: corrupt, fallbackFails: voskMissing }).factory(() => {}), (error) => error === corrupt);
  await assert.rejects(chain({ primaryFails: new Error('crash'), fallbackFails: voskMissing }).factory(() => {}), (error) => error === voskMissing);
  await assert.rejects(chain({ installed: false, fallbackFails: voskMissing }).factory(() => {}), (error) => error === voskMissing);
});

test('a session on live Parakeet emits Parakeet finals with approximate times on the session clock', async () => {
  const { api } = stubRuntime();
  api.getEngine = async () => ({ transcribe: async () => [{ text: 'hello', start: 0.25, end: 0.6 }], timing: { method: 'tdt-token-times', biasMs: 30 } });
  const events: AdapterEvent[] = [];
  const session = new LocalLiveSession({ createEngine: parakeetLiveFactory(api) });
  await session.start({ language: 'en', audioOriginMs: 1000, connectionId: 'c' }, (event) => events.push(event));
  for (const part of [silence(500), speech(1000), silence(1000)]) {
    for (let at = 0; at < part.length; at += RATE / 10) session.pushAudio(part.subarray(at, at + RATE / 10));
    await settle();
  }
  await session.finish();
  const finals = events.flatMap((event) => (event.type === 'segment' && event.segment.kind === 'final' ? [event.segment] : []));
  assert.equal(finals.length, 1);
  assert.equal(finals[0].model, PARAKEET_LIVE_MODEL);
  assert.equal(finals[0].timing, 'approximate');
  assert.equal(finals[0].text, 'hello');
  // 1000 ms origin + 0.3 s span start + 0.25 s - 30 ms.
  assert.equal(finals[0].words[0].startMs, 1520);
  assert.equal(finals[0].words[0].endMs, 1870);
});

test('a session whose Parakeet fails while recording carries on with Vosk', async () => {
  const events: AdapterEvent[] = [];
  const vosk: LiveEngineFactory = async (onMessage) => ({
    feed: () => queueMicrotask(() => onMessage({ type: 'result', text: 'vosk text', words: [{ word: 'vosk', start: 0, end: 0.1 }] })),
    flush: () => queueMicrotask(() => onMessage({ type: 'result', text: '', words: [] })),
    close: () => {},
  });
  const parakeet = parakeetLiveFactory({
    getEngine: async () => ({
      transcribe: async () => {
        throw new Error('Parakeet worker crashed');
      },
    }),
    terminate: () => {},
  });
  const session = new LocalLiveSession({ createEngine: liveEngineChain({ primary: parakeet, fallback: vosk, primaryInstalled: async () => true }) });
  await session.start({ language: 'en', audioOriginMs: 0, connectionId: 'c' }, (event) => events.push(event));
  session.pushAudio(speech(500));
  session.pushAudio(silence(500));
  session.pushAudio(silence(500));
  for (let i = 0; i < 5; i += 1) await settle();
  session.pushAudio(speech(300));
  for (let i = 0; i < 5; i += 1) await settle();
  await session.finish();
  assert.ok(events.some((event) => event.type === 'error' && event.error.message === 'Parakeet worker crashed'));
  const finals = events.flatMap((event) => (event.type === 'segment' && event.segment.kind === 'final' && event.segment.text ? [event.segment] : []));
  assert.ok(finals.length > 0);
  assert.ok(finals.every((segment) => segment.model === 'vosk-small-en-us' && segment.timing === 'aligned'));
});

test('a Parakeet that falls behind far enough to skip hands over to Vosk at the first skip, not every minute', async () => {
  const events: AdapterEvent[] = [];
  const reasons: string[] = [];
  const fed: Record<string, number> = { parakeet: 0, vosk: 0 };
  const closes: (string | undefined)[] = [];
  // A Parakeet that never answers in time; a Vosk that answers each feed at once.
  const parakeet: LiveEngineFactory = async () => ({
    model: PARAKEET_LIVE_MODEL,
    feed: (samples) => {
      fed.parakeet += samples.length;
    },
    flush: () => {},
    close: (reason) => closes.push(reason),
  });
  const vosk: LiveEngineFactory = async (onMessage) => ({
    feed: (samples) => {
      fed.vosk += samples.length;
      queueMicrotask(() => onMessage({ type: 'partial', text: '' }));
    },
    flush: () => queueMicrotask(() => onMessage({ type: 'result', text: '', words: [] })),
    close: () => {},
  });
  const session = new LocalLiveSession({
    createEngine: liveEngineChain({ primary: parakeet, fallback: vosk, primaryInstalled: async () => true, onPrimaryFailed: (reason) => reasons.push(reason) }),
    maxBacklogMs: 1000,
    keepAfterSkipMs: 200,
    behindMs: 60_000,
  });
  await session.start({ language: 'en', audioOriginMs: 1000, connectionId: 'c' }, (event) => events.push(event));
  // 2 chunks (200 ms) are with Parakeet, 1100 ms queued: 900 ms are dropped, 200 ms kept.
  for (let i = 0; i < 13; i += 1) session.pushAudio(speech(100));
  assert.deepEqual(closes, ['behind']);
  assert.deepEqual(reasons, ['the engine could not keep up with the recording']);
  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.type === 'error' && error.error.code, 'engine-behind');
  const gaps = events.flatMap((event) => (event.type === 'gap' ? [event.gap] : []));
  // What Parakeet held unanswered and the skipped audio are one gap the final pass fills.
  assert.deepEqual(gaps, [{ provider: 'browser-local', startMs: 1000, endMs: 2100, reason: 'engine-behind', detail: 'engine-behind' }]);
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(fed.vosk, 0.2 * RATE, 'Vosk starts on the 200 ms kept after the skip');
  // Vosk keeps up.
  for (let i = 0; i < 30; i += 1) {
    session.pushAudio(speech(100));
    await settle();
  }
  assert.equal(fed.vosk, 3.2 * RATE);
  // Behind on Vosk is an ordinary skip: Vosk stays, Parakeet is not reopened.
  for (let i = 0; i < 13; i += 1) session.pushAudio(speech(100));
  for (let i = 0; i < 5; i += 1) await settle();
  await session.finish();
  assert.equal(fed.parakeet, 0.2 * RATE);
  assert.equal(session.stats().skips, 2);
  assert.equal(session.stats().restarts, 1);
  assert.deepEqual(closes, ['behind']);
  assert.equal(reasons.length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});
