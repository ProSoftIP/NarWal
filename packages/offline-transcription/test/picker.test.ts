// Tests for the model picker's rows and choice (board #16611).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODELS, MODEL_IDS, modelBytes } from '../src/models.ts';
import { accuracySteps, chainFor, installedChain, modelsToDownload, pickerRows, shownModel, speedSteps, usableChoice } from '../src/picker.ts';
import { FINAL_CHAIN, LIVE_MODEL_ID, chainWithRetired, modelsForTier } from '../src/tier.ts';

test('every model has measured numbers, so every model is a row', () => {
  for (const id of MODEL_IDS) assert.ok(MODELS[id].measured, `${id} has no measured block`);
  assert.deepEqual(pickerRows('wasm').map((row) => row.id).sort(), [...MODEL_IDS].sort());
});

test('the bars come from the measured numbers by the stated bounds', () => {
  assert.deepEqual([5.1, 6, 6.1, 9.8, 10, 10.1, 20, 28.6, 35, 45.3].map(accuracySteps), [5, 5, 4, 4, 4, 3, 3, 2, 2, 1]);
  assert.deepEqual([0.05, 0.1, 0.14, 0.2, 0.35, 0.4, 0.8, 1.06].map(speedSteps), [5, 5, 4, 4, 3, 3, 2, 1]);
  assert.equal(speedSteps(null), 5, 'a live model keeps up with speech');
});

test('rows are most accurate first, with the numbers that made the bars', () => {
  const rows = pickerRows('webgpu');
  const wer = rows.map((row) => row.werPct);
  assert.deepEqual(wer, [...wer].sort((a, b) => a - b));
  const turbo = rows.find((row) => row.id === 'whisper-large-v3-turbo');
  assert.equal(turbo?.accuracyPct, 90.6);
  assert.equal(turbo?.accuracySteps, 4);
  assert.equal(turbo?.bytes, modelBytes('whisper-large-v3-turbo'));
  assert.equal(turbo?.needsWebGpu, true);
  assert.equal(turbo?.recommended, true);
  assert.match(turbo?.otherTake ?? '', /different take: .*120-second .*rec_49bbce68/, "turbo's numbers are from Matt's other take (#16621)");
  assert.deepEqual(rows.filter((row) => row.otherTake !== null).map((row) => row.id), ['whisper-large-v3-turbo']);
  const vosk = rows.find((row) => row.id === LIVE_MODEL_ID);
  assert.equal(vosk?.live, true);
  assert.equal(vosk?.accuracySteps, 1);
  assert.equal(vosk?.rtf, null);
});

test('a model the machine cannot run is listed, greyed, with the reason', () => {
  const turbo = pickerRows('wasm').find((row) => row.id === 'whisper-large-v3-turbo');
  assert.equal(turbo?.runnable, false);
  assert.match(turbo?.reason ?? '', /WebGPU/);
  assert.equal(pickerRows('webgpu').find((row) => row.id === 'whisper-large-v3-turbo')?.runnable, true);
  assert.equal(pickerRows('wasm').find((row) => row.recommended)?.id, FINAL_CHAIN.wasm[0]);
});

test('a choice is used only when it is known and this machine runs it', () => {
  assert.equal(usableChoice('whisper-base.en-q8', 'wasm'), 'whisper-base.en-q8');
  assert.equal(usableChoice('whisper-large-v3-turbo', 'wasm'), null);
  assert.equal(usableChoice('whisper-large-v3-turbo', 'webgpu'), 'whisper-large-v3-turbo');
  assert.equal(usableChoice('no-such-model', 'wasm'), null);
  assert.equal(usableChoice(null, 'wasm'), null);
  assert.equal(usableChoice(7, 'wasm'), null);
  assert.equal(shownModel(null, 'wasm'), FINAL_CHAIN.wasm[0]);
  assert.equal(shownModel('whisper-large-v3-turbo', 'wasm'), FINAL_CHAIN.wasm[0]);
  assert.equal(shownModel('whisper-base.en-q8', 'webgpu'), 'whisper-base.en-q8');
});

test('the download is the live model and the chosen one; no choice is the tier chain as before', () => {
  assert.deepEqual(modelsToDownload(null, 'wasm'), modelsForTier('wasm'));
  assert.deepEqual(modelsToDownload('whisper-base.en-q8', 'wasm'), [LIVE_MODEL_ID, 'whisper-base.en-q8']);
  assert.deepEqual(modelsToDownload(LIVE_MODEL_ID, 'wasm'), [LIVE_MODEL_ID]);
  assert.deepEqual(modelsToDownload('whisper-large-v3-turbo', 'wasm'), modelsForTier('wasm'));
});

test('every on-this-computer model is a row, Parakeet included, with the tier it needs', () => {
  const rows = pickerRows('wasm');
  for (const id of ['parakeet-tdt-0.6b-v2-int8', 'whisper-large-v3-turbo', 'moonshine-base-q8', 'whisper-small.en-q8', 'whisper-base.en-q8', LIVE_MODEL_ID]) {
    assert.ok(rows.some((row) => row.id === id), id);
  }
  const parakeet = rows.find((row) => row.id === 'parakeet-tdt-0.6b-v2-int8');
  assert.deepEqual([parakeet?.werPct, parakeet?.werNativePct, parakeet?.rtf, parakeet?.tier, parakeet?.recommended], [5.6, 5.1, 0.32, 'wasm', true]);
  assert.deepEqual(rows.map((row) => [row.id, row.tier]).filter(([, tier]) => tier === 'webgpu'), [['whisper-large-v3-turbo', 'webgpu']]);
});

test('the chain after Stop: the chosen model first, then the rest of the tier chain', () => {
  assert.deepEqual(chainFor(null, 'wasm'), chainWithRetired(FINAL_CHAIN.wasm));
  assert.deepEqual(chainFor(LIVE_MODEL_ID, 'wasm'), []);
  assert.deepEqual(chainFor('whisper-base.en-q8', 'wasm'), ['whisper-base.en-q8', ...FINAL_CHAIN.wasm]);
  assert.deepEqual(chainFor('moonshine-base-q8', 'wasm'), ['moonshine-base-q8', ...chainWithRetired(FINAL_CHAIN.wasm).filter((id) => id !== 'moonshine-base-q8')]);
  assert.deepEqual(chainFor('whisper-large-v3-turbo', 'wasm'), chainWithRetired(FINAL_CHAIN.wasm), 'a WebGPU choice on a WebAssembly machine is no choice');
});

test('only installed models run; a retired pick still runs first, a retired fallback only without its replacement', () => {
  assert.deepEqual(installedChain('whisper-base.en-q8', ['whisper-base.en-q8', 'moonshine-base-q8']), ['whisper-base.en-q8', 'moonshine-base-q8']);
  assert.deepEqual(installedChain(null, ['moonshine-base-q8', 'whisper-base.en-q8']), ['moonshine-base-q8']);
  assert.deepEqual(installedChain(null, ['whisper-base.en-q8']), ['whisper-base.en-q8']);
  assert.deepEqual(installedChain('whisper-small.en-q8', ['parakeet-tdt-0.6b-v2-int8']), ['parakeet-tdt-0.6b-v2-int8'], 'a pick that is not installed is passed over');
  assert.deepEqual(installedChain('whisper-small.en-q8', []), []);
});
