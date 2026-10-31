// Board #16569: worker lifecycle of the two engine clients. A fake Worker
// stands in for the packaged workers; each test scripts its replies.
//
// Vosk: a failed first start is retried once, and the worker that retry starts
// is the only one; a later load() must reuse it, not start a second worker.
// Whisper: a transcription that never answers fails after the per-job timeout,
// becomes a gap in the final pass, and the next call starts a new worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoskRuntime } from '../src/engines/vosk-client.ts';
import { SHERPA_TIMING, WhisperRuntime } from '../src/engines/whisper-client.ts';
import { finalizeWithChain } from '../src/final-chain.ts';
import { runFinalPass } from '../src/final-pass.ts';
import type { ModelStore } from '../src/model-store.ts';
import { OfflineTranscriber } from '../src/offline-transcriber.ts';
import { FINAL_CHAIN } from '../src/tier.ts';
import { pcmSource } from '../src/vad.ts';

type Reply = (worker: FakeWorker, message: Record<string, unknown>) => void;

class FakeWorker {
  static created: FakeWorker[] = [];
  static reply: Reply = () => {};
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  readonly posted: Record<string, unknown>[] = [];

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWorker.created.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    if (this.terminated) return;
    this.posted.push(message);
    // Replies arrive asynchronously, as from a real worker.
    queueMicrotask(() => {
      if (!this.terminated) FakeWorker.reply(this, message);
    });
  }

  send(data: unknown): void {
    if (!this.terminated) this.onmessage?.({ data });
  }

  crash(message: string): void {
    if (!this.terminated) this.onerror?.({ message });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const store = { openVerified: async () => new Map() } as unknown as ModelStore;

function install(reply: Reply): void {
  FakeWorker.created = [];
  FakeWorker.reply = reply;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    deleteDatabase() {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => (request.onsuccess as () => void)?.());
      return request;
    },
  };
}

const live = (): FakeWorker[] => FakeWorker.created.filter((worker) => !worker.terminated);

// ---- Vosk ----------------------------------------------------------------

test('vosk: a load after a retried first start reuses the retry worker', async () => {
  install((worker, message) => {
    if (message.action !== 'load') return;
    if (FakeWorker.created.indexOf(worker) === 0) worker.send({ event: 'error', error: 'extracted model unreadable' });
    else worker.send({ event: 'load', result: true });
  });
  const vosk = new VoskRuntime({ workerUrl: 'vosk-worker.js', store });
  await vosk.load();
  assert.equal(FakeWorker.created.length, 2, 'one retry after the failed start');
  assert.equal(FakeWorker.created[0].terminated, true, 'the failed worker is stopped');

  await vosk.load();
  await vosk.createEngine(() => {});
  assert.equal(FakeWorker.created.length, 2, 'no further worker after the retry succeeded');
  assert.deepEqual(live(), [FakeWorker.created[1]]);
  vosk.terminate();
});

test('vosk: a crash during the first start is retried at once, not after the load timeout', async () => {
  install((worker, message) => {
    if (message.action !== 'load') return;
    if (FakeWorker.created.indexOf(worker) === 0) worker.crash('out of memory');
    else worker.send({ event: 'load', result: true });
  });
  const vosk = new VoskRuntime({ workerUrl: 'vosk-worker.js', store, loadTimeoutMs: 60_000 });
  const started = Date.now();
  await vosk.load();
  assert.ok(Date.now() - started < 5000);
  await vosk.load();
  assert.equal(FakeWorker.created.length, 2);
  assert.deepEqual(live(), [FakeWorker.created[1]]);
  vosk.terminate();
});

test('vosk: two failed starts reject, stop every worker, and a later load starts fresh', async () => {
  let fail = true;
  install((worker, message) => {
    if (message.action !== 'load') return;
    if (fail) worker.send({ event: 'error', error: 'bad model' });
    else worker.send({ event: 'load', result: true });
  });
  const vosk = new VoskRuntime({ workerUrl: 'vosk-worker.js', store });
  await assert.rejects(vosk.load(), /Vosk could not start: bad model/);
  assert.equal(FakeWorker.created.length, 2);
  assert.deepEqual(live(), []);

  fail = false;
  await vosk.load();
  assert.equal(FakeWorker.created.length, 3);
  assert.deepEqual(live(), [FakeWorker.created[2]]);
  vosk.terminate();
});

test('vosk: terminate during a start fails that load and leaves a new load untouched', async () => {
  let answer = false;
  install((worker, message) => {
    if (message.action === 'load' && answer) worker.send({ event: 'load', result: true });
  });
  const vosk = new VoskRuntime({ workerUrl: 'vosk-worker.js', store, loadTimeoutMs: 60_000 });
  const first = vosk.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vosk.terminate();
  await assert.rejects(first, /Vosk worker stopped/);

  answer = true;
  await vosk.load();
  // Give a stale retry from the first load every chance to run.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeWorker.created.length, 2);
  assert.deepEqual(live(), [FakeWorker.created[1]]);
  vosk.terminate();
});

// ---- Whisper -------------------------------------------------------------

function whisperReplies(hang: (call: number) => boolean): Reply {
  let calls = 0;
  return (worker, message) => {
    if (message.type === 'load') worker.send({ type: 'loaded', threads: 2, loadMs: 1 });
    if (message.type === 'transcribe') {
      calls += 1;
      if (!hang(calls)) worker.send({ type: 'result', id: message.id, words: [{ text: 'hello', start: 0.2, end: 0.5 }] });
    }
  };
}

test('whisper: a transcription that never answers fails after the timeout and stops the hung worker', async () => {
  install(whisperReplies((call) => call === 1));
  const whisper = new WhisperRuntime({ workerUrl: 'whisper-worker.js', runtimeBase: 'runtime/', store, transcribeTimeoutMs: 50 });
  const engine = await whisper.getEngine();
  await assert.rejects(engine.transcribe(new Float32Array(16000)), /did not answer within/);
  assert.equal(FakeWorker.created[0].terminated, true);

  // The next call starts a new worker and succeeds.
  const words = await engine.transcribe(new Float32Array(16000));
  assert.equal(words[0].text, 'hello');
  assert.equal(FakeWorker.created.length, 2);
  assert.deepEqual(live(), [FakeWorker.created[1]]);
  whisper.terminate();
});

test('whisper: the final pass records a hung span as a gap and finishes the run', async () => {
  const rate = 16000;
  const pcm = new Float32Array(9 * rate);
  for (const [from, to] of [
    [1, 3],
    [5, 8],
  ]) {
    for (let i = from * rate; i < to * rate; i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / rate);
  }
  // The first span hangs on both attempts; the second span answers.
  install(whisperReplies((call) => call <= 2));
  const whisper = new WhisperRuntime({ workerUrl: 'whisper-worker.js', runtimeBase: 'runtime/', store, transcribeTimeoutMs: 50 });
  const { revision, stats } = await runFinalPass(
    { getEngine: whisper.getEngine, now: () => 0 },
    { recordingId: 'rec', revisionId: 'rev', audio: pcmSource(pcm, rate) },
  );
  assert.equal(stats.spans, 2);
  assert.equal(stats.failedSpans, 1);
  assert.equal(revision.gaps.length, 1);
  assert.equal(revision.gaps[0].reason, 'engine-failed');
  assert.match(revision.gaps[0].detail ?? '', /did not answer within/);
  assert.equal(revision.segments.length, 1);
  assert.equal(revision.segments[0].text, 'hello');
  assert.deepEqual(live(), [FakeWorker.created.at(-1)]);
  whisper.terminate();
});

test('whisper: terminate fails a transcription that is still waiting', async () => {
  install(whisperReplies(() => true));
  const whisper = new WhisperRuntime({ workerUrl: 'whisper-worker.js', runtimeBase: 'runtime/', store, transcribeTimeoutMs: 60_000 });
  const engine = await whisper.getEngine();
  const call = engine.transcribe(new Float32Array(16000));
  await new Promise((resolve) => setTimeout(resolve, 0));
  whisper.terminate();
  await assert.rejects(call, /Whisper worker stopped/);
  assert.deepEqual(live(), []);
});

// ---- Parakeet (board #16608) ---------------------------------------------

test('parakeet: runs in the sherpa worker with its own timing; Whisper keeps its worker', async () => {
  install(whisperReplies(() => false));
  const client = new WhisperRuntime({ workerUrl: 'runtime/whisper-worker.js', runtimeBase: 'runtime/', store });
  const parakeet = await client.getEngine('parakeet-tdt-0.6b-v2-int8');
  assert.deepEqual(parakeet.timing, SHERPA_TIMING);
  assert.equal((await parakeet.transcribe(new Float32Array(16000)))[0].text, 'hello');
  assert.equal(FakeWorker.created[0].url, 'runtime/sherpa-worker.js');
  const load = FakeWorker.created[0].posted.find((message) => message.type === 'load');
  assert.equal((load?.runtime as { modelType?: string }).modelType, 'nemo_transducer');
  assert.equal(load?.model, 'parakeet-tdt-0.6b-v2-int8');

  assert.equal(parakeet.wordTimes, undefined, 'Parakeet gives its own word times');

  const whisper = await client.getEngine('whisper-base.en-q8');
  assert.equal(whisper.timing, undefined);
  assert.equal(whisper.wordTimes, 'model');
  await whisper.transcribe(new Float32Array(16000));
  assert.equal(FakeWorker.created.at(-1)?.url, 'runtime/whisper-worker.js');
  assert.deepEqual(live(), [FakeWorker.created.at(-1)]);
  client.terminate();
});

test('parakeet: the WebAssembly chain runs Parakeet itself, with its token times 30 ms earlier, not small.en after a failed load', async () => {
  const rate = 16000;
  const pcm = new Float32Array(6 * rate);
  for (let i = 1 * rate; i < 3 * rate; i += 1) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / rate);
  install(whisperReplies(() => false));
  const client = new WhisperRuntime({ workerUrl: 'runtime/whisper-worker.js', runtimeBase: 'runtime/', store });
  const transcriber = new OfflineTranscriber({ models: store, createLiveEngine: () => Promise.reject(new Error('no live engine')), getFinalEngine: client.getEngine, final: { now: () => 0 } });
  const done = await finalizeWithChain((request, model) => transcriber.finalize(request, model), { recordingId: 'rec', revisionId: 'rev', audio: pcmSource(pcm, rate) }, { chain: FINAL_CHAIN.wasm, deadlineMs: 60_000, now: () => 0 });
  assert.equal(FINAL_CHAIN.wasm[0], 'parakeet-tdt-0.6b-v2-int8');
  assert.deepEqual(done.attempts, [], 'Parakeet loaded: no fallback');
  assert.equal(done.model, 'parakeet-tdt-0.6b-v2-int8');
  assert.equal(done.revision.model, 'parakeet-tdt-0.6b-v2-int8');
  assert.deepEqual(done.revision.timing, { quality: 'approximate', method: 'tdt-token-times', correctionMs: -SHERPA_TIMING.biasMs });
  assert.deepEqual(FakeWorker.created.map((worker) => worker.url), ['runtime/sherpa-worker.js']);
  client.terminate();
});
