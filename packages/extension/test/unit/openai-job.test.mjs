// The OpenAI transcript after Stop (board #16588). Regression check for the
// gap the #16531 delivery check found: the popup offered "OpenAI Whisper —
// After recording" and nothing ran it. Fake store, fake fetch with the
// whisper-1 fixture; no network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOpenAiJobs, deadlineFor, failureOf } from '../../src/offscreen/openai-job.js';
import { createTranscriptHistory, RevisionConflict } from '../../../transcription/src/revisions.ts';

const FAKE_KEY = 'sk-test-fixture-16588-not-a-real-key';
const T0 = Date.UTC(2026, 9, 13, 23, 0, 0);
const VERBOSE = readFileSync(new URL('../../../transcription/fixtures/openai/verbose-short.json', import.meta.url), 'utf8');

function fakeStore({ transcription = 'openai', parts = [[T0, T0 + 6000]] } = {}) {
  const metas = new Map([['r1', { id: 'r1', status: 'stopped', startedAt: T0, stoppedAt: T0 + 20_000, transcription }]]);
  const audio = parts.map(([startAt, endAt], seq) => ({ recordingId: 'r1', stream: 'audio', seq, segment: seq, startAt, endAt, bytes: 4, mime: 'audio/webm;codecs=opus', data: new Blob([new Uint8Array([26, 69, 223, 163])]) }));
  let history = createTranscriptHistory('r1');
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
    historyStore: () => ({
      read: async () => history,
      write: async (next, expectedVersion) => {
        if (history.version !== expectedVersion) throw new RevisionConflict('stale-version', 'stale');
        history = next;
      },
    }),
    updateHistory: async (_id, change) => (history = change(history)),
  };
  return { store, metas, states, history: () => history };
}

function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization || init.headers.authorization });
    const answer = answers.shift();
    if (answer === 401) {
      return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(VERBOSE, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

function jobs(store, fetch, key = FAKE_KEY, options = {}) {
  let ended;
  const end = new Promise((resolve) => (ended = resolve));
  const openai = createOpenAiJobs({ store, getKey: async () => ({ ok: true, key }), now: () => T0 + 30_000, fetch, onEnd: () => ended(), ...options });
  return { openai, end };
}

test('after Stop with OpenAI and a saved key, the narration goes to OpenAI and the answer is the active revision', async () => {
  const { store, metas, states, history } = fakeStore();
  const { fetch, calls } = fakeFetch([200]);
  const { openai, end } = jobs(store, fetch);

  const started = await openai.run('r1');
  assert.deepEqual(started, { ok: true, state: 'uploading' });
  assert.deepEqual(openai.running(), ['r1']);
  await end;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${FAKE_KEY}`);
  const h = history();
  assert.equal(h.revisions.length, 1);
  const revision = h.revisions[0];
  assert.equal(h.activeRevision, revision.revisionId);
  assert.deepEqual([revision.provider, revision.model, revision.source], ['openai', 'whisper-1', 'after-recording']);
  assert.deepEqual(revision.segments.map((s) => s.text), ['This should collapse.', 'Revenue heading.']);
  assert.equal(h.pending, null);

  // Uploading 0 of 1, then 1 of 1, then done.
  assert.deepEqual(states[0], { state: 'uploading', jobId: states[0].jobId, startedAt: T0 + 30_000, done: 0, total: 1, at: T0 + 30_000 });
  assert.deepEqual(states.at(-2).done, 1);
  assert.equal(states.at(-1).state, 'done');
  const last = metas.get('r1').afterTranscript;
  assert.deepEqual([last.state, last.activated, last.partial, last.revisionId], ['done', true, false, revision.revisionId]);
  assert.deepEqual(openai.running(), []);
  assert.ok(!JSON.stringify([...metas.values(), h]).includes(FAKE_KEY), 'the key is never saved');
});

test('a refused key fails the job with the key taken out, and Try again makes the transcript', async () => {
  const { store, metas, history } = fakeStore();
  const { fetch } = fakeFetch([401, 200]);
  let { openai, end } = jobs(store, fetch);
  await openai.run('r1');
  await end;
  const failed = metas.get('r1').afterTranscript;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.kind, 'auth');
  assert.ok(!failed.error.message.includes(FAKE_KEY), failed.error.message);
  assert.equal(history().activeRevision, null);
  assert.equal(history().pending, null);

  ({ openai, end } = jobs(store, fetch));
  await openai.run('r1');
  await end;
  assert.equal(metas.get('r1').afterTranscript.state, 'done');
  assert.equal(history().revisions.length, 1);
  assert.ok(!JSON.stringify([...metas.values(), history()]).includes(FAKE_KEY));
});

test('no saved key, no audio, or a recording without OpenAI: nothing is sent', async () => {
  const noKey = fakeStore();
  const a = fakeFetch([]);
  const { openai } = jobs(noKey.store, a.fetch, null);
  assert.deepEqual(await openai.run('r1'), { ok: false, error: 'no-key', message: 'no OpenAI key is saved' });
  assert.equal(noKey.metas.get('r1').afterTranscript.state, 'no-key');

  const noAudio = fakeStore({ parts: [] });
  const r = await jobs(noAudio.store, a.fetch).openai.run('r1');
  assert.equal(r.error, 'no-audio');
  assert.equal(noAudio.metas.get('r1').afterTranscript.error.code, 'no-audio');

  const offline = fakeStore({ transcription: 'offline' });
  assert.equal((await jobs(offline.store, a.fetch).openai.run('r1')).error, 'not-openai');
  assert.equal((await jobs(offline.store, a.fetch).openai.run('missing')).error, 'unknown-recording');
  assert.equal(a.calls.length, 0);
});

test('two audio parts: each is its own upload; a later part that fails is a gap, not a lost transcript', async () => {
  const { store, metas, history } = fakeStore({ parts: [[T0, T0 + 6000], [T0 + 10_000, T0 + 16_000]] });
  const { fetch, calls } = fakeFetch([200, 401]);
  const { openai, end } = jobs(store, fetch);
  await openai.run('r1');
  await end;
  assert.equal(calls.length, 2);
  const revision = history().revisions[0];
  assert.equal(history().activeRevision, revision.revisionId);
  assert.deepEqual(revision.gaps.map((g) => [g.startMs, g.endMs, g.reason]), [[10_000, 16_000, 'auth-failed']]);
  const job = metas.get('r1').afterTranscript;
  assert.deepEqual([job.state, job.partial, job.error.kind], ['done', true, 'partial']);
  assert.ok(!JSON.stringify([...metas.values(), history()]).includes(FAKE_KEY));
});

test('failureOf keeps plain fields and never the key', () => {
  const f = failureOf(new Error(`boom ${FAKE_KEY}`), FAKE_KEY);
  assert.equal(f.kind, 'error');
  assert.ok(!f.message.includes(FAKE_KEY));
});

// Review of NarWal#29: OpenAI's 401 text repeats the key with its middle
// starred out, and the last characters are still the key's.
test("OpenAI's starred-out key in a 401 is not saved, last characters included", async () => {
  const { store, metas } = fakeStore();
  const key = 'sk-proj-fixture16588notARealKeyZq9X';
  const masked = `sk-proj-${'*'.repeat(40)}${key.slice(-4)}`;
  const fetch = async () =>
    new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${masked}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: 'invalid_request_error', code: 'invalid_api_key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const { openai, end } = jobs(store, fetch, key);
  await openai.run('r1');
  await end;
  const { error } = metas.get('r1').afterTranscript;
  assert.deepEqual([error.kind, error.retryable], ['auth', false]);
  assert.equal(error.message, 'Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.');
  assert.ok(!JSON.stringify(metas.get('r1')).includes(key.slice(-4)), 'no part of the key is saved');
  assert.equal(failureOf(new Error(`bad ${masked}`), 'another-key').message, 'bad [redacted]');
});

// Review of NarWal#29: a hung upload showed "uploading" for about 40 minutes
// (four tries at ten minutes each). A job has one overall limit.
test('an upload that hangs ends at the deadline as a failure the user can try again', async () => {
  const { store, metas, history } = fakeStore();
  let sent = 0;
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      sent += 1;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  const { openai, end } = jobs(store, hang, FAKE_KEY, { deadlineMs: () => 30 });
  assert.deepEqual(await openai.run('r1'), { ok: true, state: 'uploading' });
  await end;
  assert.equal(sent, 1, 'the hung upload is not tried again after the deadline');
  const job = metas.get('r1').afterTranscript;
  assert.equal(job.state, 'failed');
  assert.deepEqual(job.error, { kind: 'timeout', code: 'deadline', message: 'no transcript after 1 min', retryable: true });
  assert.deepEqual(openai.running(), []);
  assert.equal(history().pending, null, 'the history is free for Try again');
  assert.equal(history().activeRevision, null);
});

test('the deadline is ten minutes plus a quarter of the narration', () => {
  assert.equal(deadlineFor(0), 600_000);
  assert.equal(deadlineFor(30 * 60_000), 600_000 + 450_000);
  assert.equal(deadlineFor(-5), 600_000);
});
