import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOWNLOAD_HEARTBEAT_MS, combineModelState, toViewModel } from '../../src/shared/model-view.js';

const T0 = 1_700_000_000_000;
const missing = { state: 'missing', bytesDone: 0, bytesTotal: 100 };
const ready = { state: 'ready', bytesDone: 100, bytesTotal: 100 };

test('stored files win when ready or when no download reported', () => {
  assert.equal(combineModelState(ready, { state: 'downloading', at: T0 }, T0), ready);
  assert.equal(combineModelState(missing, null, T0), missing);
});

test('a running download shows its progress until its page stops reporting', () => {
  const report = { state: 'downloading', bytesDone: 40, bytesTotal: 100, at: T0 };
  assert.equal(combineModelState(missing, report, T0 + DOWNLOAD_HEARTBEAT_MS), report);
  assert.equal(combineModelState(missing, report, T0 + DOWNLOAD_HEARTBEAT_MS * 3), missing);
});

test('a failed download is shown until the files say more', () => {
  const report = { state: 'failed', bytesDone: 0, bytesTotal: 100, reason: 'offline', at: T0 };
  assert.equal(combineModelState(missing, report, T0 + 60_000), report);
  const corrupt = { state: 'failed', reason: 'damaged' };
  assert.equal(combineModelState(corrupt, report, T0), corrupt);
});

test('the view model carries a reason only when failed', () => {
  assert.deepEqual(toViewModel({ state: 'failed', bytesDone: 1, bytesTotal: 2, reason: 'no network', reasonCode: 'download-failed' }), {
    state: 'failed',
    bytesDone: 1,
    bytesTotal: 2,
    error: 'no network',
  });
  assert.deepEqual(toViewModel({ state: 'missing', bytesDone: 0, bytesTotal: 2, reason: 'x' }), { state: 'missing', bytesDone: 0, bytesTotal: 2 });
});

// Board #16603 review item 2: Start needs only the live model.
test('the live model alone decides the state; the final models ride along as `final`', () => {
  const stored = { ...ready, final: { state: 'missing', bytesDone: 0, bytesTotal: 815e6 } };
  assert.deepEqual(toViewModel(combineModelState(stored, null, T0)), { state: 'ready', bytesDone: 100, bytesTotal: 100, final: { state: 'missing', bytesDone: 0, bytesTotal: 815e6 } });
  const downloading = { state: 'downloading', bytesDone: 300e6, bytesTotal: 900e6, at: T0 };
  assert.deepEqual(combineModelState(stored, downloading, T0).final, { state: 'downloading', bytesDone: 300e6, bytesTotal: 900e6 });
  assert.equal(combineModelState(stored, downloading, T0).state, 'ready');
  assert.equal(combineModelState(stored, { state: 'failed', at: T0 }, T0).final.state, 'failed');
  const allReady = { ...ready, final: { state: 'ready', bytesDone: 1, bytesTotal: 1 } };
  assert.equal(combineModelState(allReady, downloading, T0), allReady);
});

test('a download report with a `final` part gives the final note its own bytes', () => {
  const stored = { ...ready, final: { state: 'missing', bytesDone: 0, bytesTotal: 800 } };
  const report = { state: 'downloading', bytesDone: 500, bytesTotal: 900, final: { state: 'downloading', bytesDone: 400, bytesTotal: 800 }, at: T0 };
  assert.deepEqual(combineModelState(stored, report, T0).final, { state: 'downloading', bytesDone: 400, bytesTotal: 800 });
});

test('the view model names the model the choice uses, with its measured bars (#16611)', async () => {
  const { pickerRows } = await import('../../../offline-transcription/src/picker.ts');
  const row = pickerRows('wasm').find((r) => r.id === 'whisper-small.en-q8');
  assert.deepEqual(toViewModel({ state: 'ready', bytesDone: 1, bytesTotal: 1 }, row).choice, {
    id: 'whisper-small.en-q8',
    name: 'Whisper small.en',
    accuracySteps: 4,
    speedSteps: 2,
    recommended: false,
  });
  assert.equal('choice' in toViewModel({ state: 'ready', bytesDone: 1, bytesTotal: 1 }), false);
});
