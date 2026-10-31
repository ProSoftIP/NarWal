import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyStorageNotRestricted, ProviderKeyStore, maskKey } from '../src/key-store.ts';
import type { StorageAreaLike } from '../src/key-store.ts';
import { FAKE_KEY } from './helpers.ts';

function memoryArea(options: { withAccessLevel?: boolean; accessLevelFails?: boolean } = {}) {
  const items = new Map<string, unknown>();
  const levels: string[] = [];
  const area: StorageAreaLike = {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => items.has(key)).map((key) => [key, items.get(key)]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) items.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) items.delete(key);
    },
  };
  if (options.withAccessLevel !== false) {
    area.setAccessLevel = async ({ accessLevel }) => {
      if (options.accessLevelFails) throw new Error('unsupported');
      levels.push(accessLevel);
    };
  }
  return { area, items, levels };
}

test('refuses to store a key until storage is restricted to trusted contexts', async () => {
  const { area, items, levels } = memoryArea();
  const store = new ProviderKeyStore(area);
  await assert.rejects(store.setKey('deepgram', FAKE_KEY), KeyStorageNotRestricted);
  assert.equal(items.size, 0);
  assert.equal(await store.restrictToTrustedContexts(), true);
  assert.deepEqual(levels, ['TRUSTED_CONTEXTS']);
  await store.setKey('deepgram', `  ${FAKE_KEY}\n`);
  assert.deepEqual([...items.keys()], ['narwal.key.deepgram']);
  assert.equal(await store.getKey('deepgram'), FAKE_KEY);
  assert.equal(await store.hasKey('deepgram'), true);
  assert.equal(await store.hasKey('assemblyai'), false);
  await store.removeKey('deepgram');
  assert.equal(await store.getKey('deepgram'), null);
});

test('a browser without setAccessLevel, or one that refuses it, never stores keys', async () => {
  for (const options of [{ withAccessLevel: false }, { accessLevelFails: true }]) {
    const store = new ProviderKeyStore(memoryArea(options).area);
    assert.equal(await store.restrictToTrustedContexts(), false);
    await assert.rejects(store.setKey('deepgram', FAKE_KEY), KeyStorageNotRestricted);
  }
});

test('rejects a key with spaces and masks keys for display', async () => {
  const store = new ProviderKeyStore(memoryArea().area);
  await store.restrictToTrustedContexts();
  await assert.rejects(store.setKey('deepgram', 'two words'), TypeError);
  await assert.rejects(store.setKey('deepgram', '   '), TypeError);
  assert.equal(maskKey(FAKE_KEY), '••••cdef');
  assert.equal(maskKey('abc'), '••••');
});
