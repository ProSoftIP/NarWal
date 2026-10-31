// The improved transcript on this computer after Stop (board #16603). Fake
// store and a fake engine behind the real final pass (offline-transcription
// final-pass.ts and final-chain.ts): no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalJobs, failureOf, liveRevisionOf, MAX_RESUMES, mergeParts, narrationParts } from '../../src/offscreen/local-job.js';
import { addRevision, createTranscriptHistory } from '../../../transcription/src/revisions.ts';
import { runFinalPass } from '../../../offline-transcription/src/final-pass.ts';
import { ModelError } from '../../../offline-transcription/src/model-store.ts';
import { pcmSource, planSpeech } from '../../../offline-transcription/src/vad.ts';

const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const RATE = 16000;

/** One second of tone, one second of silence, `spans` times: one speech span each. */
function speech(spans) {
  const pcm = new Float32Array(RATE * 2 * spans + RATE);
  for (let span = 0; span < spans; span += 1) {
    const from = RATE * (2 * span + 0.5);
    for (let i = 0; i < RATE; i += 1) pcm[from + i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return pcm;
}

const LIVE = {
  revisionId: 'live',
  provider: 'browser-local',
  model: 'vosk-small-en-us',
  createdAtMs: T0 + 10_000,
  source: 'live',
  segments: [{ provider: 'browser-local', model: 'vosk-small-en-us', connectionId: 'live', segmentKey: 'live:0', kind: 'final', startMs: 500, endMs: 1500, text: 'hello word', words: [{ text: 'hello', startMs: 500, endMs: 900 }, { text: 'word', startMs: 1000, endMs: 1500 }], endOfUtterance: true }],
  gaps: [],
};

function fakeStore({ transcription = 'offline', parts = [[T0 + 2000, T0 + 9000]], clock = [], live = true, offlineModel } = {}) {
  const metas = new Map([['r1', { id: 'r1', status: 'stopped', startedAt: T0, stoppedAt: T0 + 20_000, transcription, ...(offlineModel ? { offlineModel } : {}) }]]);
  const audio = parts.map(([startAt, endAt], seq) => ({ recordingId: 'r1', stream: 'audio', seq, segment: seq, startAt, endAt, bytes: 4, mime: 'audio/webm;codecs=opus', data: new Blob([new Uint8Array([seq])]) }));
  const events = [{ recordingId: 'r1', stream: 'events', seq: 0, entries: clock }];
  let history = createTranscriptHistory('r1');
  if (live) history = addRevision(history, LIVE);
  let checkpoint = null;
  const states = [];
  const store = {
    getRecording: async (id) => metas.get(id),
    updateRecording: async (id, patch) => {
      const next = { ...metas.get(id), ...patch };
      metas.set(id, next);
      if (patch.afterTranscript) states.push(patch.afterTranscript);
      return next;
    },
    readAudio: async () => audio,
    readEvents: async () => events,
    readCheckpoint: async () => (checkpoint ? structuredClone(checkpoint) : null),
    writeCheckpoint: async (_id, next) => (checkpoint = structuredClone(next)),
    clearCheckpoint: async () => (checkpoint = null),
    readHistory: async () => history,
    updateHistory: async (_id, change) => (history = change(history)),
  };
  return { store, metas, states, history: () => history, checkpoint: () => checkpoint, setCheckpoint: (next) => (checkpoint = next) };
}

/** A fake Whisper: one word per span, half a second into it. `engines[model]` overrides per model. */
function fakeOffline({ engines = {}, calls = [] } = {}) {
  const word = { transcribe: async () => [{ text: 'improved', start: 0.5, end: 0.8 }] };
  return async () => ({
    finalize: (request, model) =>
      runFinalPass(
        {
          model,
          now: () => T0 + 60_000,
          getEngine: async () => {
            const engine = engines[model] || word;
            if (engine instanceof Error) throw engine;
            return {
              transcribe: (pcm) => {
                calls.push(model);
                return engine.transcribe(pcm);
              },
            };
          },
        },
        request,
      ),
  });
}

function jobs(store, options = {}) {
  let ended;
  const end = new Promise((resolve) => (ended = resolve));
  const local = createLocalJobs({
    store,
    openOffline: fakeOffline(options),
    now: () => T0 + 30_000,
    // `defaultChain`: the real one (FINAL_CHAIN of this machine's tier, Node has no WebGPU).
    // `pickedChain`: the real chain from the recording's picked model (board #16611).
    ...(options.defaultChain || options.pickedChain ? {} : { chain: async () => options.chain || ['whisper-large-v3-turbo', 'whisper-small.en-q8'] }),
    decode: async () => speech(options.spans || 3),
    ...(options.installed ? { installed: options.installed } : {}),
    ...(options.release ? { release: options.release } : {}),
    onEnd: () => ended(),
  });
  return { local, end };
}

test('after Stop with the offline choice, the final pass replaces the live transcript', async () => {
  const { store, states, history, checkpoint } = fakeStore();
  const { local, end } = jobs(store);

  assert.deepEqual(await local.run('r1'), { ok: true, state: 'improving' });
  assert.deepEqual(local.running(), ['r1']);
  await end;

  const h = history();
  assert.equal(h.revisions.length, 2);
  const revision = h.revisions[1];
  assert.equal(h.activeRevision, revision.revisionId);
  assert.deepEqual([revision.provider, revision.model, revision.source, revision.supersedes], ['browser-local', 'whisper-large-v3-turbo', 'after-recording', 'r1']);
  assert.deepEqual(revision.segments.map((s) => s.text), ['improved', 'improved', 'improved']);
  // No clock pairs: the part starts 2 s into the session; the word is 0.5 s into the span; Whisper's 150 ms bias comes off.
  const [first] = await planSpeech(pcmSource(speech(3), RATE));
  assert.equal(revision.segments[0].startMs, 2000 + Math.round((first.startSample / RATE) * 1000) + 500 - 150);
  assert.equal(checkpoint(), null);
  assert.deepEqual(local.running(), []);

  assert.ok(states.every((s) => s.provider === 'browser-local'));
  assert.equal(states[0].state, 'improving');
  const progress = states.filter((s) => s.state === 'improving').map((s) => s.progress);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.deepEqual(states.at(-1), { state: 'done', jobId: states[0].jobId, revisionId: revision.revisionId, activated: true, partial: false, model: 'whisper-large-v3-turbo', provider: 'browser-local', at: T0 + 30_000 });
});

test('a model that is not installed falls back to the next in the chain', async () => {
  const { store, history } = fakeStore();
  const calls = [];
  const { local, end } = jobs(store, { calls, engines: { 'whisper-large-v3-turbo': new ModelError('model-missing', 'whisper-large-v3-turbo', 'not installed') } });
  await local.run('r1');
  await end;
  assert.equal(history().revisions[1].model, 'whisper-small.en-q8');
  assert.ok(calls.every((model) => model === 'whisper-small.en-q8'));
});

test('no model at all: the job fails, the live transcript stays, and Try again waits for the install', async () => {
  const { store, states, history, checkpoint } = fakeStore();
  const missing = (id) => new ModelError('model-missing', id, `${id} is not installed`);
  const { local, end } = jobs(store, { engines: { 'whisper-large-v3-turbo': missing('whisper-large-v3-turbo'), 'whisper-small.en-q8': missing('whisper-small.en-q8') } });
  await local.run('r1');
  await end;
  assert.equal(history().revisions.length, 1);
  assert.equal(history().activeRevision, 'r1');
  const last = states.at(-1);
  assert.equal(last.state, 'failed');
  assert.deepEqual([last.error.kind, last.error.code, last.error.retryable], ['model', 'model-missing', false]);
  assert.equal(checkpoint(), null);
});

/** A first document that transcribes one span with `model`, then never answers again. */
async function cutShortAfterOneSpan(store, checkpoint, model, chain) {
  let answered = 0;
  const hang = { transcribe: () => (answered++ === 0 ? Promise.resolve([{ text: 'first', start: 0.1, end: 0.4 }]) : new Promise(() => {})) };
  const first = jobs(store, { chain, engines: { [model]: hang } });
  await first.local.run('r1');
  for (let i = 0; i < 100 && !(checkpoint() && checkpoint().current); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return checkpoint();
}

test('a job the browser cut short goes on in a new document with the next model of the chain (#16603 review item 6)', async () => {
  const { store, history, checkpoint } = fakeStore();
  const saved = await cutShortAfterOneSpan(store, checkpoint, 'whisper-large-v3-turbo');
  assert.equal(saved.current.pass.model, 'whisper-large-v3-turbo');
  assert.equal(saved.model, 'whisper-large-v3-turbo');

  const calls = [];
  const second = jobs(store, { calls });
  assert.deepEqual(await second.local.resumeAll(['r1']), ['r1']);
  await second.end;
  // The model that was running may be what stopped the document: it is not run again.
  assert.ok(calls.length === 3 && calls.every((model) => model === 'whisper-small.en-q8'), calls);
  const revision = history().revisions[1];
  assert.equal(revision.model, 'whisper-small.en-q8');
  assert.deepEqual(revision.segments.map((s) => s.text), ['improved', 'improved', 'improved']);
  assert.equal(checkpoint(), null);
});

test('the last model of the chain cut short goes on from its checkpoint: only the spans not done run', async () => {
  const chain = ['whisper-small.en-q8'];
  const { store, history, checkpoint } = fakeStore();
  const saved = await cutShortAfterOneSpan(store, checkpoint, 'whisper-small.en-q8', chain);
  assert.equal(Object.keys(saved.current.pass.done).length, 1);

  const calls = [];
  const second = jobs(store, { calls, chain });
  assert.deepEqual(await second.local.resumeAll(['r1']), ['r1']);
  await second.end;
  assert.equal(calls.length, 2);
  const revision = history().revisions[1];
  assert.deepEqual(revision.segments.map((s) => s.text), ['first', 'improved', 'improved']);
  assert.equal(revision.revisionId, 'r2');
  assert.equal(checkpoint(), null);
});

test('a job this document runs already counts as started on resume (#16603 review item 5)', async () => {
  const { store, checkpoint } = fakeStore();
  const hang = { transcribe: () => new Promise(() => {}) };
  const { local } = jobs(store, { engines: { 'whisper-large-v3-turbo': hang } });
  await local.run('r1');
  for (let i = 0; i < 100 && !checkpoint(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await local.resumeAll(['r1']), ['r1']);
});

test('no final model installed: the job fails at once, before the run returns (#16603 review item 1)', async () => {
  const { store, states, history, checkpoint, metas } = fakeStore();
  const calls = [];
  const { local } = jobs(store, { calls, installed: async () => [] });
  const reply = await local.run('r1');
  assert.deepEqual([reply.ok, reply.error], [false, 'model-missing']);
  // Nothing is left improving: Export and the strip do not wait.
  assert.equal(metas.get('r1').afterTranscript.state, 'failed');
  assert.deepEqual([states.at(-1).error.kind, states.at(-1).error.code], ['model', 'model-missing']);
  assert.ok(!states.some((s) => s.state === 'improving'));
  assert.deepEqual(local.running(), []);
  assert.deepEqual(calls, []);
  assert.equal(history().activeRevision, 'r1');
  assert.equal(checkpoint(), null);
});

test('a final model that is not installed is passed over; the next installed one runs (#16603 review item 2)', async () => {
  const { store, history, states } = fakeStore();
  const calls = [];
  const { local, end } = jobs(store, { calls, installed: async (models) => models.filter((m) => m !== 'whisper-large-v3-turbo') });
  await local.run('r1');
  await end;
  assert.ok(calls.length && calls.every((model) => model === 'whisper-small.en-q8'), calls);
  assert.equal(history().revisions[1].model, 'whisper-small.en-q8');
  assert.equal(states[0].model, 'whisper-small.en-q8');
});

test('an install with base.en and no Moonshine keeps base.en as the last fallback; with Moonshine, base.en never runs (#16609)', async () => {
  for (const [have, runs] of [
    [['whisper-base.en-q8'], 'whisper-base.en-q8'],
    [['moonshine-base-q8', 'whisper-base.en-q8'], 'moonshine-base-q8'],
  ]) {
    const { store, history } = fakeStore();
    const calls = [];
    const { local, end } = jobs(store, { calls, defaultChain: true, installed: async (models) => models.filter((m) => have.includes(m)) });
    await local.run('r1');
    await end;
    assert.ok(calls.length && calls.every((model) => model === runs), `${have}: ${calls}`);
    assert.equal(history().revisions[1].model, runs);
  }
});

test('a final text that fails the sanity check is stored but not made active (#16603 review item 3)', async () => {
  const cases = [
    { name: 'empty', engine: { transcribe: async () => [] }, code: 'empty' },
    { name: 'a loop', engine: { transcribe: async () => [{ text: 'thank you thank you thank you thank you thank you thank you thank you thank you', start: 0.1, end: 0.9 }] }, code: 'repetition' },
  ];
  for (const { name, engine, code } of cases) {
    const { store, history, states } = fakeStore();
    const { local, end } = jobs(store, { engines: { 'whisper-large-v3-turbo': engine } });
    await local.run('r1');
    await end;
    const h = history();
    assert.equal(h.activeRevision, 'r1', `${name}: the live transcript stays active`);
    assert.equal(h.revisions.length, 2, `${name}: the improved text is kept for a look`);
    const last = states.at(-1);
    assert.deepEqual([last.state, last.error.kind, last.error.code, last.revisionId], ['failed', 'implausible', code, h.revisions[1].revisionId], name);
  }
});

test('every span fails: the revision is partial and Try again stays, not implausible (#16603 re-review)', async () => {
  const { store, history, states } = fakeStore();
  const broken = { transcribe: async () => { throw new Error('engine broke'); } };
  const { local, end } = jobs(store, { spans: 2, chain: ['whisper-large-v3-turbo'], engines: { 'whisper-large-v3-turbo': broken } });
  await local.run('r1');
  await end;
  const h = history();
  assert.equal(h.activeRevision, 'r1', 'the live transcript stays active');
  assert.equal(h.revisions[1].gaps.length, 2);
  const last = states.at(-1);
  assert.deepEqual([last.state, last.partial, last.error.kind, last.error.retryable], ['done', true, 'partial', true]);
});

test('far fewer words than the live text: the live transcript stays', async () => {
  const words = Array.from({ length: 30 }, (_, i) => ({ text: `w${i}`, startMs: 500 + i * 10, endMs: 505 + i * 10 }));
  const long = { ...LIVE, segments: [{ ...LIVE.segments[0], text: words.map((w) => w.text).join(' '), words }] };
  const { store, history, states } = fakeStore({ live: false });
  await store.updateHistory('r1', (h) => addRevision(h, long));
  const { local, end } = jobs(store);
  await local.run('r1');
  await end;
  assert.equal(history().activeRevision, 'r1');
  assert.equal(states.at(-1).error.code, 'too-few-words');
});

test('the final engine is released when the last job ends', async () => {
  const { store } = fakeStore();
  let released = 0;
  const { local, end } = jobs(store, { release: () => (released += 1) });
  await local.run('r1');
  assert.equal(released, 0);
  await end;
  assert.equal(released, 1);
});

test('a job resumed too often is not resumed again', async () => {
  const { store, setCheckpoint, checkpoint } = fakeStore();
  setCheckpoint({ version: 1, jobId: 'j', startedAt: T0, revisionId: 'local-x', parts: {}, current: null, resumes: MAX_RESUMES });
  const { local } = jobs(store);
  assert.deepEqual(await local.resumeAll(['r1']), []);
  assert.equal(checkpoint(), null);
  assert.equal((await local.run('r1', { resume: true })).error, 'no-checkpoint');
});

test('two audio parts: each runs with its own clock and they make one revision', async () => {
  const clock = [
    { k: 'audio', type: 'clock', segment: 1, frames: 0, sampleRate: 48000, t: T0 + 12_000 },
    { k: 'audio', type: 'clock', segment: 1, frames: 48000, sampleRate: 48000, t: T0 + 13_000 },
  ];
  const { store, history } = fakeStore({ parts: [[T0 + 2000, T0 + 9000], [T0 + 12_000, T0 + 19_000]], clock });
  const { local, end } = jobs(store, { spans: 1 });
  await local.run('r1');
  await end;
  const revision = history().revisions[1];
  // Part 2 is placed by its clock pairs (frame 0 at 12 s), not by where part 1 ended.
  const [first, second] = revision.segments.map((s) => s.startMs);
  assert.equal(second - first, 10_000);
});

test('a recording without the offline choice, or without audio, is refused', async () => {
  const openai = fakeStore({ transcription: 'openai' });
  assert.equal((await jobs(openai.store).local.run('r1')).error, 'not-offline');
  const silent = fakeStore({ parts: [] });
  assert.equal((await jobs(silent.store).local.run('r1')).error, 'no-audio');
  assert.equal(silent.states.at(-1).error.code, 'no-audio');
});

test('with no live revision the improved one stands alone and becomes active', async () => {
  const { store, history } = fakeStore({ live: false });
  const { local, end } = jobs(store);
  await local.run('r1');
  await end;
  const h = history();
  assert.equal(h.revisions.length, 1);
  assert.equal(h.revisions[0].supersedes, undefined);
  assert.equal(h.activeRevision, h.revisions[0].revisionId);
});

test('helpers: live revision, parts with clock, merge, failure text', () => {
  const h = addRevision(createTranscriptHistory('r1'), LIVE);
  assert.equal(liveRevisionOf(h), 'r1');
  assert.equal(liveRevisionOf(createTranscriptHistory('r1')), null);

  const parts = narrationParts({ startedAt: T0 }, [{ segment: 0, seq: 0, startAt: T0 + 100, endAt: T0 + 1100, bytes: 0, data: new Blob([]) }], []);
  assert.deepEqual(parts, []);

  const segment = (startMs) => ({ ...LIVE.segments[0], segmentKey: 'x:0', startMs, endMs: startMs + 1000, words: [], timing: 'approximate' });
  const merged = mergeParts({ revisionId: 'local-a', parts: [{ model: 'm1', segments: [segment(0)], gaps: [] }, { model: 'm2', segments: [segment(5000)], gaps: [] }], now: () => T0 });
  assert.equal(merged.model, 'm1+m2');
  // Each part numbers its segments from 0: the merge keeps the keys unique.
  assert.equal(new Set(merged.segments.map((s) => s.segmentKey)).size, 2);

  assert.equal(failureOf(new ModelError('model-corrupt', 'x', 'bad hash')).kind, 'model');
  assert.equal(failureOf(new Error('boom')).retryable, true);
});

// The picker (board #16611). This test machine has no WebGPU: the chain is
// the WebAssembly tier's, with the picked model first. Only installed models run.
const only = (have) => async (models) => models.filter((m) => have.includes(m));

test('a picked model runs first, even a retired one; a pick that is not installed is passed over', async () => {
  for (const [have, runs] of [
    [['whisper-base.en-q8', 'moonshine-base-q8'], 'whisper-base.en-q8'],
    [['moonshine-base-q8'], 'moonshine-base-q8'],
  ]) {
    const { store, history } = fakeStore({ offlineModel: 'whisper-base.en-q8' });
    const calls = [];
    const { local, end } = jobs(store, { calls, pickedChain: true, installed: only(have) });
    await local.run('r1');
    await end;
    assert.ok(calls.length && calls.every((model) => model === runs), `${have}: ${calls}`);
    assert.equal(history().revisions[1].model, runs);
  }
});

test('a picked model that is not downloaded, with no fallback downloaded: the job fails at once as a model failure', async () => {
  const { store, states, history } = fakeStore({ offlineModel: 'whisper-base.en-q8' });
  const calls = [];
  const { local } = jobs(store, { calls, pickedChain: true, installed: only([]) });
  const reply = await local.run('r1');
  assert.deepEqual([reply.ok, reply.error], [false, 'model-missing']);
  assert.equal(history().revisions.length, 1);
  assert.deepEqual([states.at(-1).state, states.at(-1).error.kind], ['failed', 'model']);
  assert.match(states.at(-1).error.message, /the picked model whisper-base\.en-q8 is not downloaded/);
  assert.deepEqual(calls, []);
});

test('the live model picked: no pass after Stop, the live transcript stays, no job state', async () => {
  const { store, states, history } = fakeStore({ offlineModel: 'vosk-small-en-us' });
  const calls = [];
  const { local } = jobs(store, { calls, pickedChain: true });
  const reply = await local.run('r1');
  assert.deepEqual([reply.ok, reply.error], [false, 'live-only']);
  assert.deepEqual(local.running(), []);
  assert.deepEqual(states, []);
  assert.deepEqual(calls, []);
  assert.equal(history().revisions.length, 1);
});

test('a picked model this machine cannot run counts as no pick: the tier chain runs', async () => {
  const { store, history } = fakeStore({ offlineModel: 'whisper-large-v3-turbo' });
  const { local, end } = jobs(store, { pickedChain: true });
  await local.run('r1');
  await end;
  assert.equal(history().revisions[1].model, 'parakeet-tdt-0.6b-v2-int8');
});
