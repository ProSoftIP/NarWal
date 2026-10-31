// Unit tests for the states the recorder UI shows for the offline option
// (board #16544, for the provider selection UI of #16551): src/status.ts.
// One model state folded from the live and the final model, and one
// transcript state folded from a live session's events.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localError } from '../src/contract.ts';
import type { AdapterEvent } from '../src/contract.ts';
import { MemoryBlobStore, ModelStore } from '../src/model-store.ts';
import type { ModelErrorCode, ModelState, ModelStatus } from '../src/model-store.ts';
import { UiTranscriptTracker, uiOfflineModel } from '../src/status.ts';
import type { UiTranscript } from '../src/status.ts';

function status(id: ModelStatus['id'], state: ModelState, bytesDone: number, bytesTotal: number, error?: { code: ModelErrorCode; message: string }): ModelStatus {
  return { id, state, bytesDone, bytesTotal, badFiles: state === 'corrupt' ? ['model.tar.gz'] : [], verified: false, ...(error ? { error } : {}) };
}

const live = (state: ModelState, bytesDone = 0, error?: { code: ModelErrorCode; message: string }) => status('vosk-small-en-us', state, bytesDone, 40, error);
const final = (state: ModelState, bytesDone = 0, error?: { code: ModelErrorCode; message: string }) => status('whisper-base.en-q8', state, bytesDone, 80, error);

/** Feeds the events and returns the state after each one. */
function run(events: AdapterEvent[], tracker = new UiTranscriptTracker()): UiTranscript[] {
  return events.map((event) => {
    tracker.onEvent(event);
    return tracker.get();
  });
}

const state = (value: 'connecting' | 'open' | 'closing' | 'closed'): AdapterEvent => ({ type: 'state', state: value });
const backlog = (behind: boolean, lagMs: number): AdapterEvent => ({ type: 'backlog', behind, lagMs });
const modelFailure = (code: string): AdapterEvent => ({ type: 'error', error: localError(code, `${code} (test)`, 'model') });
const engineFailure = (retryable: boolean): AdapterEvent => ({ type: 'error', error: localError('engine-stalled', 'no result for 10 s', 'provider', retryable) });

// --- uiOfflineModel ------------------------------------------------------------------

test('both models missing, or only one ready, is missing; the bytes are the sum', () => {
  assert.deepEqual(uiOfflineModel([live('missing'), final('missing')]), { state: 'missing', bytesDone: 0, bytesTotal: 120 });
  assert.deepEqual(uiOfflineModel([live('ready', 40), final('missing', 25)]), { state: 'missing', bytesDone: 65, bytesTotal: 120 });
  assert.deepEqual(uiOfflineModel([live('missing'), final('ready', 80)]), { state: 'missing', bytesDone: 80, bytesTotal: 120 });
});

test('no model status at all is missing, not ready', () => {
  assert.deepEqual(uiOfflineModel([]), { state: 'missing', bytesDone: 0, bytesTotal: 0 });
});

test('one model downloading makes the option downloading, with the summed progress', () => {
  assert.deepEqual(uiOfflineModel([live('ready', 40), final('downloading', 20)]), { state: 'downloading', bytesDone: 60, bytesTotal: 120 });
  assert.deepEqual(uiOfflineModel([live('downloading', 10), final('missing')]), { state: 'downloading', bytesDone: 10, bytesTotal: 120 });
});

test('ready needs every model ready', () => {
  assert.deepEqual(uiOfflineModel([live('ready', 40), final('ready', 80)]), { state: 'ready', bytesDone: 120, bytesTotal: 120 });
  assert.equal(uiOfflineModel([live('ready', 40)]).state, 'ready');
  assert.equal(uiOfflineModel([live('ready', 40), final('failed')]).state, 'failed');
});

test('a failed download is failed with the code and message of the error', () => {
  const failed = final('failed', 30, { code: 'hash-mismatch', message: 'tokenizer.json: SHA-256 does not match the pinned value; nothing was stored' });
  assert.deepEqual(uiOfflineModel([live('ready', 40), failed]), {
    state: 'failed',
    bytesDone: 70,
    bytesTotal: 120,
    reasonCode: 'hash-mismatch',
    reason: 'tokenizer.json: SHA-256 does not match the pinned value; nothing was stored',
  });
  assert.equal(uiOfflineModel([live('failed', 0, { code: 'aborted', message: 'cancelled' }), final('missing')]).reasonCode, 'aborted');
});

test('a failed status without an error still gets a stable code and a sentence', () => {
  const ui = uiOfflineModel([live('failed'), final('ready', 80)]);
  assert.equal(ui.state, 'failed');
  assert.equal(ui.reasonCode, 'download-failed');
  assert.ok(ui.reason);
});

test('a download that runs again hides the failure of the other model until it ends', () => {
  const failed = live('failed', 0, { code: 'download-failed', message: 'HTTP 503' });
  assert.deepEqual(uiOfflineModel([failed, final('downloading', 20)]), { state: 'downloading', bytesDone: 20, bytesTotal: 120 });
});

test('corrupt wins over every other state and is failed with model-corrupt', () => {
  const failed = final('failed', 0, { code: 'download-failed', message: 'HTTP 503' });
  for (const other of [final('missing'), final('downloading', 20), final('ready', 80), failed]) {
    const ui = uiOfflineModel([live('corrupt'), other]);
    assert.equal(ui.state, 'failed', `corrupt with ${other.state}`);
    assert.equal(ui.reasonCode, 'model-corrupt');
    assert.match(ui.reason ?? '', /Repair/);
    assert.equal(ui.bytesTotal, 120);
    assert.deepEqual(uiOfflineModel([other, live('corrupt')]), { ...ui }, 'the order of the models does not matter');
  }
});

test('the statuses of a real empty store fold to missing with both pinned sizes', async () => {
  const store = new ModelStore({
    blobs: new MemoryBlobStore(),
    fetch: () => {
      throw new Error('status must not fetch');
    },
  });
  const ui = uiOfflineModel(await store.statusAll());
  assert.equal(ui.state, 'missing');
  assert.equal(ui.bytesDone, 0);
  assert.ok(ui.bytesTotal > 120_000_000, 'Vosk 41 MB + Whisper 80 MB');
  assert.equal(ui.reasonCode, undefined);
});

// --- UiTranscriptTracker ----------------------------------------------------------------

test('before any event the transcript is disconnected with no reason', () => {
  assert.deepEqual(new UiTranscriptTracker().get(), { state: 'disconnected', reasonCode: '', reason: '', lagMs: 0 });
});

test('connecting → open is live', () => {
  assert.deepEqual(run([state('connecting'), state('open')]), [
    { state: 'connecting', reasonCode: '', reason: '', lagMs: 0 },
    { state: 'live', reasonCode: '', reason: '', lagMs: 0 },
  ]);
});

test('model-missing then closed is disconnected with model-missing and a sentence for the user', () => {
  const states = run([state('connecting'), modelFailure('model-missing'), state('closed')]);
  assert.equal(states[1].state, 'connecting', 'the error alone does not change the state');
  assert.deepEqual(states[2], {
    state: 'disconnected',
    reasonCode: 'model-missing',
    reason: 'The offline model is not downloaded. Recording continues; transcribe later.',
    lagMs: 0,
  });
});

test('model-corrupt then closed is disconnected with model-corrupt', () => {
  const last = run([state('connecting'), modelFailure('model-corrupt'), state('closed')]).at(-1);
  assert.equal(last?.state, 'disconnected');
  assert.equal(last?.reasonCode, 'model-corrupt');
  assert.match(last?.reason ?? '', /damaged.*repair/i);
});

test('backlog behind is live and catching up; recovered clears it', () => {
  const states = run([state('connecting'), state('open'), backlog(true, 6400), backlog(true, 9100), backlog(false, 300)]);
  assert.deepEqual(states[2], { state: 'live', reasonCode: 'catching-up', reason: 'Catching up (6 s behind). Nothing is lost.', lagMs: 6400 });
  assert.equal(states[3].state, 'live');
  assert.equal(states[3].reasonCode, 'catching-up');
  assert.equal(states[3].lagMs, 9100);
  assert.match(states[3].reason, /9 s behind/);
  assert.deepEqual(states[4], { state: 'live', reasonCode: '', reason: '', lagMs: 300 });
});

test('a backlog event outside live changes nothing', () => {
  const tracker = new UiTranscriptTracker();
  assert.deepEqual(run([backlog(true, 5000)], tracker), [{ state: 'disconnected', reasonCode: '', reason: '', lagMs: 0 }]);
  assert.deepEqual(run([state('connecting'), backlog(true, 5000)], tracker).at(-1), { state: 'connecting', reasonCode: '', reason: '', lagMs: 0 });
  assert.deepEqual(run([state('open'), state('closed'), backlog(true, 5000)], tracker).at(-1)?.state, 'disconnected');
});

test('an engine error then connecting is reconnecting; open makes it live again', () => {
  const states = run([state('connecting'), state('open'), backlog(true, 7000), engineFailure(true), state('connecting'), state('open')]);
  assert.equal(states[3].state, 'live', 'the error alone does not change the state');
  assert.deepEqual(states[4], { state: 'reconnecting', reasonCode: 'engine-failed', reason: '', lagMs: 0 });
  assert.deepEqual(states[5], { state: 'live', reasonCode: '', reason: '', lagMs: 0 });
});

test('an engine error before the first open is reconnecting too', () => {
  const states = run([state('connecting'), engineFailure(true), state('connecting')]);
  assert.deepEqual(states[2], { state: 'reconnecting', reasonCode: 'engine-failed', reason: '', lagMs: 0 });
});

test('connecting again after an open without an error is reconnecting with no reason', () => {
  const states = run([state('connecting'), state('open'), state('connecting')]);
  assert.deepEqual(states[2], { state: 'reconnecting', reasonCode: '', reason: '', lagMs: 0 });
});

test('closed after open is disconnected and stopped', () => {
  const states = run([state('connecting'), state('open'), state('closing'), state('closed')]);
  assert.equal(states[2].state, 'live', 'closing still shows the live text');
  assert.deepEqual(states[3], { state: 'disconnected', reasonCode: 'stopped', reason: 'Stopped.', lagMs: 0 });
});

test('an engine error that ends the session is disconnected with engine-failed', () => {
  const last = run([state('connecting'), state('open'), engineFailure(false), state('closed')]).at(-1);
  assert.deepEqual(last, {
    state: 'disconnected',
    reasonCode: 'engine-failed',
    reason: 'Offline transcription stopped. Recording continues; transcribe later.',
    lagMs: 0,
  });
});

test('an error that a later open recovered from is not the reason of a later stop', () => {
  const last = run([state('connecting'), state('open'), engineFailure(true), state('connecting'), state('open'), state('closed')]).at(-1);
  assert.equal(last?.reasonCode, 'stopped');
});

test('a second session after a model failure starts clean once it opens', () => {
  const tracker = new UiTranscriptTracker();
  run([state('connecting'), modelFailure('model-missing'), state('closed')], tracker);
  const states = run([state('connecting'), state('open'), state('closed')], tracker);
  assert.equal(states[1].state, 'live');
  assert.equal(states[1].reasonCode, '');
  assert.equal(states[2].reasonCode, 'stopped');
});

test('segment, gap and usage events do not change the transcript state', () => {
  const tracker = new UiTranscriptTracker();
  run([state('connecting'), state('open'), backlog(true, 5000)], tracker);
  const before = tracker.get();
  run(
    [
      {
        type: 'segment',
        segment: { provider: 'browser-local', model: 'vosk-small-en-us', connectionId: 'c1', segmentKey: 'u1', kind: 'interim', startMs: 0, endMs: 500, text: 'hi', words: [], endOfUtterance: false },
      },
      { type: 'gap', gap: { provider: 'browser-local', startMs: 0, endMs: 500, reason: 'engine-behind' } },
      { type: 'usage', provider: 'browser-local', audioSeconds: 3, basis: 'audio fed' },
    ],
    tracker,
  );
  assert.deepEqual(tracker.get(), before);
});

test('onEvent works as a detached callback', () => {
  const tracker = new UiTranscriptTracker();
  const { onEvent } = tracker;
  onEvent(state('connecting'));
  onEvent(state('open'));
  assert.equal(tracker.get().state, 'live');
});
