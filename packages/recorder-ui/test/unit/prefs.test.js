import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs, memoryStorageArea, PREFS_KEY } from '../../src/prefs.js';

test('defaults: instructions are shown and the offline choice is picked', async () => {
  const prefs = createPrefs(memoryStorageArea());
  assert.deepEqual(await prefs.get(), { skipInstructions: false, transcription: 'offline', offlineModel: null, microphone: null });
});

test('the skip choice is stored and read back by a new instance', async () => {
  const area = memoryStorageArea();
  await createPrefs(area).update({ skipInstructions: true });
  assert.equal((await createPrefs(area).get()).skipInstructions, true);
  assert.equal(area.data[PREFS_KEY].skipInstructions, true);
});

test('bad stored values fall back to the defaults', async () => {
  for (const bad of ['yes', 7, null, [], { skipInstructions: 'true', transcription: 'some-other-cloud' }]) {
    const got = await createPrefs(memoryStorageArea({ [PREFS_KEY]: bad })).get();
    assert.equal(got.skipInstructions, false);
    assert.equal(got.transcription, 'offline');
  }
});

test("update keeps another module's field in the same object", async () => {
  const area = memoryStorageArea({ [PREFS_KEY]: { deepgramAuth: 'grant', transcription: 'deepgram' } });
  const next = await createPrefs(area).update({ skipInstructions: true });
  assert.deepEqual(next, { deepgramAuth: 'grant', transcription: 'deepgram', skipInstructions: true, offlineModel: null, microphone: null });
  assert.equal(area.data[PREFS_KEY].deepgramAuth, 'grant');
});

test('prefs never hold a provider key', async () => {
  const area = memoryStorageArea();
  const prefs = createPrefs(area);
  await prefs.update({ transcription: 'openai' });
  assert.deepEqual(Object.keys(area.data), [PREFS_KEY]);
  assert.deepEqual(Object.keys(area.data[PREFS_KEY]).sort(), ['microphone', 'offlineModel', 'skipInstructions', 'transcription']);
});

test('the chosen speech model is remembered; a bad value is no choice (board #16611)', async () => {
  const area = memoryStorageArea();
  await createPrefs(area).update({ offlineModel: 'whisper-small.en-q8' });
  assert.equal((await createPrefs(area).get()).offlineModel, 'whisper-small.en-q8');
  for (const bad of ['', 7, {}, null]) {
    const got = await createPrefs(memoryStorageArea({ [PREFS_KEY]: { offlineModel: bad } })).get();
    assert.equal(got.offlineModel, null);
  }
});

test('the chosen microphone is remembered with its name; a bad value is the default (board #16785)', async () => {
  const area = memoryStorageArea();
  await createPrefs(area).update({ microphone: { id: 'abc123', label: 'USB headset' } });
  assert.deepEqual((await createPrefs(area).get()).microphone, { id: 'abc123', label: 'USB headset' });
  await createPrefs(area).update({ microphone: null });
  assert.equal((await createPrefs(area).get()).microphone, null);
  for (const bad of ['abc', 7, {}, { id: '' }, { id: 3, label: 'x' }]) {
    assert.equal((await createPrefs(memoryStorageArea({ [PREFS_KEY]: { microphone: bad } })).get()).microphone, null, JSON.stringify(bad));
  }
  assert.deepEqual((await createPrefs(memoryStorageArea({ [PREFS_KEY]: { microphone: { id: 'x' } } })).get()).microphone, { id: 'x', label: '' });
});
