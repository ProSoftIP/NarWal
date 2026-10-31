import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterTranscriptNext, afterTranscriptStatus, failureText, toRecorderStatus, transcriptState } from '../../src/shared/ui-status.js';

const T0 = 1_700_000_000_000;
const context = { tab: { ok: true, title: 'Payroll' }, mic: 'granted', online: true, model: { state: 'ready' }, keys: { deepgram: true } };

test('no recording: idle with the context the popup read', () => {
  const s = toRecorderStatus({ ok: true, now: T0, live: null, stopping: null, lastResult: null }, context);
  assert.equal(s.phase, 'idle');
  assert.deepEqual([s.tab, s.mic, s.online, s.model, s.keys], [context.tab, 'granted', true, { state: 'ready' }, { deepgram: true }]);
});

test('the popup says how many areas of the page are hidden (#16592)', () => {
  const idle = { ok: true, now: T0, live: null, stopping: null, lastResult: null };
  assert.equal(toRecorderStatus(idle, { ...context, hidden: 2 }).hidden, 2);
  assert.equal(toRecorderStatus(idle, context).hidden, 0);
  // An area the page lost is not counted as hidden: it blocks Start instead.
  const lost = toRecorderStatus(idle, { ...context, hidden: 1, hiddenLost: 2 });
  assert.equal(lost.hidden, 1);
  assert.equal(lost.hiddenLost, 2);
  assert.equal(toRecorderStatus(idle, context).hiddenLost, 0);
});

test('the strip has no context: the defaults never block anything it shows', () => {
  const s = toRecorderStatus({ now: T0, live: { id: 'r1', tabId: 4, startedAt: T0 - 5000, transcription: 'offline' } });
  assert.equal(s.phase, 'recording');
  assert.equal(s.elapsedMs, 5000);
  assert.equal(s.elsewhere, false);
  assert.equal(s.recordingId, 'r1');
});

test('recording: time from the worker clock, microphone state from the recorder', () => {
  const live = { id: 'r1', tabId: 4, startedAt: T0 - 61_000, transcription: 'deepgram' };
  const on = toRecorderStatus({ now: T0, live, recorder: { audio: { state: 'recording' }, transcript: { state: 'live' } } }, { ...context, tabId: 4 });
  assert.deepEqual([on.phase, on.elapsedMs, on.micLive, on.elsewhere, on.transcription], ['recording', 61_000, true, false, 'deepgram']);
  assert.deepEqual(on.transcript, { state: 'live' });
  for (const audio of ['unavailable', 'lost']) {
    const off = toRecorderStatus({ now: T0, live, recorder: { audio: { state: audio } } }, context);
    assert.equal(off.micLive, false, audio);
  }
});

test('a popup opened on another tab knows the recording is elsewhere', () => {
  const live = { id: 'r1', tabId: 4, startedAt: T0, transcription: 'offline' };
  assert.equal(toRecorderStatus({ now: T0, live }, { ...context, tabId: 9 }).elsewhere, true);
});

test('stopping shows the time the recording ran', () => {
  const s = toRecorderStatus({ now: T0 + 9000, stopping: { id: 'r1', startedAt: T0, at: T0 + 3000, transcription: 'offline' } }, context);
  assert.deepEqual([s.phase, s.elapsedMs, s.recordingId], ['stopping', 3000, 'r1']);
});

test('a normal stop is saved; a dismissed one is idle again', () => {
  const last = { id: 'r1', stopReason: 'user', storageError: null, at: T0 + 4000, startedAt: T0, transcription: 'openai' };
  const saved = toRecorderStatus({ now: T0 + 5000, lastResult: last }, context);
  assert.deepEqual([saved.phase, saved.elapsedMs, saved.recordingId, saved.error], ['saved', 4000, 'r1', undefined]);
  assert.equal(toRecorderStatus({ now: T0, lastResult: { ...last, dismissed: true } }, context).phase, 'idle');
});

test('the OpenAI job after Stop (#16588) reaches the saved status in plain words, never with a key or text', () => {
  const last = { id: 'r1', stopReason: 'user', storageError: null, at: T0 + 4000, startedAt: T0, transcription: 'openai' };
  const at = (afterTranscript) => toRecorderStatus({ now: T0 + 5000, lastResult: last, afterTranscript }, context).afterTranscript;
  assert.equal(at(null), undefined);
  assert.deepEqual(at({ state: 'uploading', jobId: 'j', startedAt: T0, done: 0, total: 1, at: T0 }), { state: 'uploading', done: 0, total: 1 });
  assert.deepEqual(at({ state: 'done', jobId: 'j', revisionId: 'r1', activated: true, partial: false, at: T0 }), { state: 'done', activated: true });
  assert.deepEqual(at({ state: 'no-key', at: T0 }), { state: 'no-key' });
  const failed = at({ state: 'failed', error: { kind: 'auth', code: '401', message: 'Incorrect API key provided: sk-[redacted]', retryable: false } });
  assert.deepEqual(failed, { state: 'failed', detail: 'OpenAI did not accept the key', next: 'after-fix' });
  assert.equal(afterTranscriptStatus({ state: 'failed', error: { kind: 'input', code: 'no-audio', message: 'x' } }).detail, 'no narration audio was saved');
  assert.equal(afterTranscriptStatus({ state: 'failed', error: { kind: 'interrupted', code: 'interrupted', message: 'x' } }).detail, 'the browser stopped the upload before it finished');
  assert.deepEqual(afterTranscriptStatus({ state: 'done', partial: true, activated: true, error: { kind: 'partial', code: 'partial', message: 'network: lost' } }), {
    state: 'partial',
    detail: 'network: lost',
    activated: true,
  });
});

// Review of NarWal#29: each upload is paid for. Try again is only for a
// failure the same upload can put right; a ready transcript never asks again.
test('what an OpenAI job allows next: Try again, after a fix, or never', () => {
  const failed = (error) => afterTranscriptNext({ state: 'failed', error });
  assert.equal(failed({ kind: 'rate-limit', code: '429', retryable: true }), 'retry');
  assert.equal(failed({ kind: 'network', code: 'network', retryable: true }), 'retry');
  assert.equal(failed({ kind: 'timeout', code: 'deadline', retryable: true }), 'retry');
  assert.equal(failed({ kind: 'interrupted', code: 'interrupted', retryable: true }), 'retry');
  assert.equal(failed({ kind: 'auth', code: 'invalid_api_key', retryable: false }), 'after-fix');
  assert.equal(failed({ kind: 'quota', code: 'insufficient_quota', retryable: false }), 'after-fix');
  assert.equal(failed({ kind: 'input', code: 'no-audio', retryable: false }), 'never');
  assert.equal(failed({ kind: 'refused', code: 'refused-consent', retryable: false }), 'never');
  // Saved before the field existed: as it was, Try again.
  assert.equal(failed({ kind: 'provider', code: '500' }), 'retry');
  assert.equal(afterTranscriptNext({ state: 'done', activated: true, partial: true }), 'retry');
  assert.equal(afterTranscriptNext({ state: 'done', activated: true, partial: false }), 'never');
  assert.equal(afterTranscriptNext({ state: 'uploading', done: 0, total: 1 }), 'never');
  assert.equal(afterTranscriptNext({ state: 'no-key' }), 'after-fix');
  assert.equal(afterTranscriptNext(null), 'never');
  assert.equal(afterTranscriptStatus({ state: 'failed', error: { kind: 'rate-limit', code: '429', retryable: true } }).next, 'retry');
  assert.equal(afterTranscriptStatus({ state: 'failed', error: { kind: 'input', code: 'no-audio', retryable: false } }).next, 'never');
});

test('storage full: failed, in plain words, saying earlier data is kept', () => {
  const last = { id: 'r1', stopReason: 'storage-full', storageError: { quota: true, at: T0 }, at: T0, startedAt: T0 - 1000 };
  const s = toRecorderStatus({ now: T0, lastResult: last }, context);
  assert.equal(s.phase, 'failed');
  assert.match(s.error, /^Storage is full\. Recording stopped at .+\. Everything saved before that is kept$/);
  const other = failureText({ at: T0, storageError: { quota: false, message: 'disk error' } });
  assert.match(other, /^Saving failed at .+ \(disk error\)\. Recording stopped\. Everything saved before that is kept$/);
  assert.equal(failureText({ storageError: null }), '');
});

test('transcript state: after the recording for OpenAI, the report for live choices, otherwise off', () => {
  assert.deepEqual(transcriptState('openai', { state: 'live' }), { state: 'after-recording' });
  assert.deepEqual(transcriptState('deepgram', { state: 'reconnecting', detail: 2 }), { state: 'reconnecting', detail: '2' });
  assert.deepEqual(transcriptState('offline', { state: 'disconnected' }), { state: 'disconnected' });
  assert.deepEqual(transcriptState('offline', null), { state: 'off' });
  assert.deepEqual(transcriptState('assemblyai', { state: 'something-new' }), { state: 'off' });
});

test('board #16785: a silent microphone and the default-microphone fallback reach the strip', () => {
  const live = { id: 'r1', tabId: 4, startedAt: T0 - 12_000, transcription: 'offline' };
  const quiet = toRecorderStatus({ now: T0, live, recorder: { micSilent: true, audio: { state: 'recording', deviceFallback: true } } }, context);
  assert.equal(quiet.micSilent, true);
  assert.equal(quiet.micFallback, true);
  const fine = toRecorderStatus({ now: T0, live, recorder: { audio: { state: 'recording' } } }, context);
  assert.equal(fine.micSilent, false);
  assert.equal(fine.micFallback, false);
});
