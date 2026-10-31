// Unit tests for the verified model store and the pinned manifests (board
// #16544): src/model-store.ts and src/models.ts.
//
// The store takes no manifest: it reads `MODELS` on every call. The pinned
// files are 41 MB and 80 MB, so most tests here swap `MODELS[id].files` for a
// few small files with real SHA-256 values and put the pinned list back after
// each test. `node --test` runs each file in its own process, so the swap never
// reaches another test file. The "pinned manifest" tests use the real list and
// only send bodies the store must refuse.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryBlobStore, ModelError, ModelStore } from '../src/model-store.ts';
import type { ModelErrorCode, ModelStatus, ModelStoreConfig } from '../src/model-store.ts';
import { MODELS, MODEL_DOWNLOAD_HOSTS, MODEL_IDS, modelBytes, sha256Hex, storageKey, voskLoadUrl } from '../src/models.ts';
import type { ModelFile, ModelId } from '../src/models.ts';

const LIVE: ModelId = 'vosk-small-en-us';
const FINAL: ModelId = 'whisper-base.en-q8';

const PINNED = new Map(MODEL_IDS.map((id) => [id, MODELS[id].files] as const));
afterEach(() => {
  for (const [id, files] of PINNED) MODELS[id].files = files;
});

type Bytes = Uint8Array<ArrayBuffer>;

function bytes(length: number, seed: number): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17) & 0xff;
  return out;
}

interface SmallModel {
  id: ModelId;
  files: ModelFile[];
  /** Correct content by download URL. */
  byUrl: Map<string, Bytes>;
  /** Correct content by path. */
  byPath: Map<string, Bytes>;
  total: number;
}

/** Replaces the manifest of `id` with small files. `afterEach` restores the pinned one. */
async function smallModel(id: ModelId, contents: Record<string, Bytes>): Promise<SmallModel> {
  const files: ModelFile[] = [];
  const byUrl = new Map<string, Bytes>();
  const byPath = new Map<string, Bytes>();
  for (const [path, data] of Object.entries(contents)) {
    const url = `https://models.test/${id}/${path}`;
    files.push({ path, url, bytes: data.byteLength, sha256: await sha256Hex(data) });
    byUrl.set(url, data);
    byPath.set(path, data);
  }
  MODELS[id].files = files;
  return { id, files, byUrl, byPath, total: files.reduce((sum, file) => sum + file.bytes, 0) };
}

const threeFiles = () =>
  smallModel(FINAL, { 'config.json': bytes(64, 1), 'tokenizer.json': bytes(300, 2), 'onnx/encoder.onnx': bytes(1000, 3) });

type Responder = (url: string, attempt: number, init: RequestInit | undefined) => Response | Promise<Response>;

/** A `fetch` stand-in. `attempt` counts earlier calls for the same URL. */
function fakeNet(respond: Responder) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const attempt = calls.filter((call) => call.url === url).length;
    calls.push({ url, init });
    return respond(url, attempt, init);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, urls: () => calls.map((call) => call.url) };
}

const serving =
  (model: SmallModel): Responder =>
  (url) => {
    const data = model.byUrl.get(url);
    return data ? new Response(data) : new Response('not found', { status: 404 });
  };

const noNet = () =>
  fakeNet(() => {
    throw new Error('this call must not use the network');
  });

function storeWith(net: { fetch: typeof fetch }, extra: Partial<ModelStoreConfig> = {}) {
  const blobs = new MemoryBlobStore();
  const store = new ModelStore({ blobs, fetch: net.fetch, now: () => 1_700_000_000_000, ...extra });
  return { blobs, store };
}

async function seed(blobs: MemoryBlobStore, model: SmallModel, overrides: Record<string, Bytes> = {}, skip: string[] = []): Promise<void> {
  for (const file of model.files) {
    if (skip.includes(file.path)) continue;
    const data = overrides[file.path] ?? model.byPath.get(file.path);
    assert.ok(data);
    await blobs.put(storageKey(model.id, file.path), new Blob([data]));
  }
}

async function stored(blobs: MemoryBlobStore, id: ModelId, path: string): Promise<Uint8Array | undefined> {
  const blob = await blobs.get(storageKey(id, path));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}

async function modelError(promise: Promise<unknown>, code: ModelErrorCode, id: ModelId): Promise<ModelError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ModelError, `expected a ModelError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.equal(caught.modelId, id);
  return caught;
}

/** Same size as the good file, different content. */
function damaged(data: Bytes): Bytes {
  const copy = data.slice();
  copy[copy.length >> 1] ^= 0xff;
  return copy;
}

// --- models.ts ---------------------------------------------------------------

test('sha256Hex matches the SHA-256 test vector', async () => {
  const abc = new TextEncoder().encode('abc');
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex(abc), expected);
  assert.equal(await sha256Hex(abc.buffer), expected);
});

test('pinned manifest: every file is pinned to a size, a SHA-256 and an allowed https host', () => {
  const allowed = (host: string) =>
    MODEL_DOWNLOAD_HOSTS.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern));
  const keys = new Set<string>();
  for (const id of MODEL_IDS) {
    assert.equal(MODELS[id].id, id);
    assert.ok(MODELS[id].files.length > 0);
    for (const file of MODELS[id].files) {
      const url = new URL(file.url);
      assert.equal(url.protocol, 'https:', file.url);
      assert.ok(allowed(url.host), `${url.host} is not in MODEL_DOWNLOAD_HOSTS`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(file.bytes) && file.bytes > 0);
      keys.add(storageKey(id, file.path));
    }
  }
  assert.equal(keys.size, MODEL_IDS.reduce((sum, id) => sum + MODELS[id].files.length, 0), 'storage keys are unique');
  for (const key of keys) assert.ok(new URL(key).hostname.endsWith('.invalid'), 'a storage key can never resolve');
});

test('voskLoadUrl changes when the pinned archive hash changes', async () => {
  const before = voskLoadUrl();
  const model = await smallModel(LIVE, { 'model.tar.gz': bytes(50, 9) });
  const after = voskLoadUrl();
  assert.notEqual(after, before);
  assert.ok(after.includes(model.files[0].sha256.slice(0, 16)));
  assert.ok(new URL(after).hostname.endsWith('.invalid'));
});

// --- pinned manifest, real sizes and hashes -----------------------------------

test('pinned manifest: a new store reports every model missing with the pinned totals and does not fetch', async () => {
  const net = noNet();
  const { store } = storeWith(net);
  const statuses = await store.statusAll();
  assert.deepEqual(
    statuses.map((status) => [status.id, status.state, status.bytesDone, status.verified]),
    MODEL_IDS.map((id) => [id, 'missing', 0, false]),
  );
  assert.equal(statuses[0].id, LIVE);
  assert.equal(statuses[0].bytesTotal, 41184862);
  for (const status of statuses) assert.equal(status.bytesTotal, modelBytes(status.id));
  assert.ok(modelBytes(FINAL) > 79_000_000);
  // The models of one tier only (board #16603).
  assert.deepEqual((await store.statusAll([LIVE, FINAL])).map((status) => status.id), [LIVE, FINAL]);
  assert.equal(net.calls.length, 0);
});

test('pinned manifest: a body of the pinned size with other content is refused (Whisper config.json)', async () => {
  const config = MODELS[FINAL].files[0];
  assert.equal(config.path, 'config.json');
  const net = fakeNet((url) => (url === config.url ? new Response(new Uint8Array(config.bytes)) : new Response('', { status: 500 })));
  const { blobs, store } = storeWith(net);
  const error = await modelError(store.install(FINAL), 'hash-mismatch', FINAL);
  assert.match(error.message, /config\.json: SHA-256 does not match/);
  assert.deepEqual(net.urls(), [config.url, config.url], 'one retry, and no later file is fetched');
  assert.equal(blobs.blobs.size, 0);
});

test('pinned manifest: a short body is refused (Vosk archive)', async () => {
  const net = fakeNet(() => new Response(bytes(16, 1)));
  const { blobs, store } = storeWith(net, { hashRetries: 0 });
  const error = await modelError(store.install(LIVE), 'hash-mismatch', LIVE);
  assert.match(error.message, /got 16 bytes, expected 41184862/);
  assert.equal(blobs.blobs.size, 0);
  assert.equal((await store.status(LIVE)).state, 'failed');
});

// --- status, install -----------------------------------------------------------

test('missing → install → ready: every file is fetched once and stored byte for byte', async () => {
  const model = await threeFiles();
  const net = fakeNet(serving(model));
  const { blobs, store } = storeWith(net);

  assert.deepEqual(await store.status(FINAL), { id: FINAL, state: 'missing', bytesDone: 0, bytesTotal: 1364, badFiles: [], verified: false });

  const installed = await store.install(FINAL);
  assert.deepEqual(installed, { id: FINAL, state: 'ready', bytesDone: 1364, bytesTotal: 1364, badFiles: [], verified: true });
  assert.deepEqual(await store.status(FINAL), installed);
  assert.deepEqual(
    net.urls(),
    model.files.map((file) => file.url),
  );
  for (const file of model.files) assert.deepEqual(await stored(blobs, FINAL, file.path), model.byPath.get(file.path));
  assert.equal(blobs.blobs.size, 3);
  assert.equal((await store.status(LIVE)).state, 'missing', 'the other model is untouched');
});

test('status, statusAll, verify and openVerified never fetch, installed or not', async () => {
  const model = await threeFiles();
  const net = noNet();
  const { blobs, store } = storeWith(net);

  await store.status(FINAL);
  await store.statusAll();
  await store.verify(FINAL);
  await modelError(store.openVerified(FINAL), 'model-missing', FINAL);

  await seed(blobs, model);
  assert.equal((await store.status(FINAL)).state, 'ready');
  assert.equal((await store.verify(FINAL)).verified, true);
  assert.equal((await store.openVerified(FINAL)).size, 3);

  await seed(blobs, model, { 'tokenizer.json': damaged(bytes(300, 2)) });
  assert.equal((await store.verify(FINAL)).state, 'corrupt');
  await modelError(store.openVerified(FINAL), 'model-corrupt', FINAL);

  assert.equal(net.calls.length, 0);
  assert.equal(store.downloads.length, 0);
});

test('the default configuration uses the global fetch only inside install', async () => {
  const model = await smallModel(LIVE, { 'model.tar.gz': bytes(40, 4) });
  const realFetch = globalThis.fetch;
  const net = fakeNet(serving(model));
  globalThis.fetch = net.fetch;
  try {
    const store = new ModelStore({ blobs: new MemoryBlobStore() });
    await store.status(LIVE);
    await store.verify(LIVE);
    assert.equal(net.calls.length, 0);
    assert.equal((await store.install(LIVE)).state, 'ready');
    assert.equal(net.calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a download sends no credentials and bypasses the HTTP cache', async () => {
  const model = await smallModel(LIVE, { 'model.tar.gz': bytes(40, 4) });
  const net = fakeNet(serving(model));
  const { store } = storeWith(net);
  await store.install(LIVE);
  assert.equal(net.calls[0].init?.credentials, 'omit');
  assert.equal(net.calls[0].init?.cache, 'no-store');
});

test('a presence check alone reports ready but not verified; verify adds the hash check', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  await seed(blobs, model);
  const cheap = await store.status(FINAL);
  assert.equal(cheap.state, 'ready');
  assert.equal(cheap.verified, false);
  const full = await store.verify(FINAL);
  assert.equal(full.state, 'ready');
  assert.equal(full.verified, true);
  assert.equal((await store.status(FINAL)).verified, true);
});

test('a partly stored model is missing, with the stored bytes counted', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  await seed(blobs, model, {}, ['onnx/encoder.onnx']);
  const status = await store.status(FINAL);
  assert.equal(status.state, 'missing');
  assert.equal(status.bytesDone, 364);
  assert.deepEqual(status.badFiles, []);
});

test('install skips files that are already stored and correct', async () => {
  const model = await threeFiles();
  const net = fakeNet(serving(model));
  const { blobs, store } = storeWith(net);
  await seed(blobs, model, {}, ['tokenizer.json']);
  const status = await store.install(FINAL);
  assert.equal(status.state, 'ready');
  assert.equal(status.verified, true);
  assert.deepEqual(net.urls(), ['https://models.test/whisper-base.en-q8/tokenizer.json']);
});

test('install replaces a stored file that fails its hash check', async () => {
  const model = await threeFiles();
  const net = fakeNet(serving(model));
  const { blobs, store } = storeWith(net);
  await seed(blobs, model, { 'config.json': damaged(bytes(64, 1)) });
  assert.equal((await store.install(FINAL)).state, 'ready');
  assert.deepEqual(net.urls(), ['https://models.test/whisper-base.en-q8/config.json']);
  assert.deepEqual(await stored(blobs, FINAL, 'config.json'), bytes(64, 1));
});

test('install reports progress as downloading, then the final ready status', async () => {
  const model = await threeFiles();
  const { store } = storeWith(fakeNet(serving(model)));
  const seen: ModelStatus[] = [];
  const result = await store.install(FINAL, { onProgress: (status) => seen.push(status) });
  assert.ok(seen.length >= 4, 'at least one report per file and the final one');
  assert.deepEqual(seen.at(-1), result);
  const running = seen.slice(0, -1);
  assert.ok(running.every((status) => status.state === 'downloading' && status.bytesTotal === 1364 && !status.verified));
  for (let i = 1; i < running.length; i += 1) assert.ok(running[i].bytesDone >= running[i - 1].bytesDone);
  assert.equal(running.at(-1)?.bytesDone, 1364);
});

// --- refusing bad downloads ------------------------------------------------------

test('a short body is refused: nothing is stored and the download is tried 1 + hashRetries times', async () => {
  const model = await threeFiles();
  const net = fakeNet((url) => new Response(model.byUrl.get(url)?.subarray(0, 10)));
  const { blobs, store } = storeWith(net, { hashRetries: 2 });
  const error = await modelError(store.install(FINAL), 'hash-mismatch', FINAL);
  assert.match(error.message, /config\.json: got 10 bytes, expected 64; nothing was stored/);
  const first = model.files[0].url;
  assert.deepEqual(net.urls(), [first, first, first]);
  assert.equal(blobs.blobs.size, 0);
  const status = await store.status(FINAL);
  assert.equal(status.state, 'failed');
  assert.equal(status.bytesDone, 0);
  assert.equal(status.error?.code, 'hash-mismatch');
});

test('a body of the right size with the wrong content is refused and retried', async () => {
  const model = await threeFiles();
  const net = fakeNet((url) => {
    const data = model.byUrl.get(url);
    return data ? new Response(damaged(data)) : new Response('', { status: 404 });
  });
  const { blobs, store } = storeWith(net, { hashRetries: 3 });
  const error = await modelError(store.install(FINAL), 'hash-mismatch', FINAL);
  assert.match(error.message, /config\.json: SHA-256 does not match the pinned value; nothing was stored/);
  assert.equal(net.calls.length, 4);
  assert.equal(blobs.blobs.size, 0);
  assert.deepEqual(
    store.downloads.map((record) => [record.path, record.bytes, record.ok]),
    Array.from({ length: 4 }, () => ['config.json', 64, false]),
  );
});

test('hashRetries: 0 means one attempt; the default is one retry', async () => {
  await smallModel(LIVE, { 'model.tar.gz': bytes(40, 4) });
  const wrong: Responder = () => new Response(bytes(40, 5));

  const once = fakeNet(wrong);
  await modelError(storeWith(once, { hashRetries: 0 }).store.install(LIVE), 'hash-mismatch', LIVE);
  assert.equal(once.calls.length, 1);

  const twice = fakeNet(wrong);
  await modelError(storeWith(twice).store.install(LIVE), 'hash-mismatch', LIVE);
  assert.equal(twice.calls.length, 2);
});

test('a retry that returns the right bytes completes the install', async () => {
  const model = await threeFiles();
  const flaky = 'https://models.test/whisper-base.en-q8/tokenizer.json';
  const net = fakeNet((url, attempt) => {
    const data = model.byUrl.get(url);
    assert.ok(data);
    return new Response(url === flaky && attempt === 0 ? damaged(data) : data);
  });
  const { blobs, store } = storeWith(net, { hashRetries: 1 });
  const status = await store.install(FINAL);
  assert.equal(status.state, 'ready');
  assert.equal(status.verified, true);
  assert.deepEqual(await stored(blobs, FINAL, 'tokenizer.json'), bytes(300, 2));
  assert.deepEqual(
    store.downloads.map((record) => [record.path, record.ok]),
    [
      ['config.json', true],
      ['tokenizer.json', false],
      ['tokenizer.json', true],
      ['onnx/encoder.onnx', true],
    ],
  );
});

test('a body larger than the pinned size is cut off, not read to the end', { timeout: 10_000 }, async () => {
  await smallModel(LIVE, { 'model.tar.gz': bytes(100, 4) });
  let pulled = 0;
  let cancelled = 0;
  const net = fakeNet(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(bytes(64, pulled));
          },
          cancel() {
            cancelled += 1;
          },
        }),
      ),
  );
  const { blobs, store } = storeWith(net, { hashRetries: 1 });
  const error = await modelError(store.install(LIVE), 'hash-mismatch', LIVE);
  assert.match(error.message, /got 128 bytes, expected 100/);
  assert.equal(cancelled, 2, 'each attempt cancels the endless body');
  assert.ok(pulled <= 8, `read ${pulled} chunks of an endless body`);
  assert.equal(blobs.blobs.size, 0);
});

// --- download errors ---------------------------------------------------------------

test('an HTTP error fails the install with download-failed and the state is failed', async () => {
  const model = await threeFiles();
  const net = fakeNet((url) => (url.endsWith('/tokenizer.json') ? new Response('gone', { status: 503 }) : serving(model)(url, 0, undefined)));
  const { blobs, store } = storeWith(net, { hashRetries: 3 });

  const error = await modelError(store.install(FINAL), 'download-failed', FINAL);
  assert.match(error.message, /tokenizer\.json: HTTP 503 from models\.test/);
  assert.equal(net.urls().filter((url) => url.endsWith('/tokenizer.json')).length, 1, 'an HTTP error is not a hash retry');

  const status = await store.status(FINAL);
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.error, { code: 'download-failed', message: error.message });
  assert.equal(status.bytesDone, 64, 'the file verified before the error is kept');
  assert.equal(status.verified, false);
  assert.deepEqual([...blobs.blobs.keys()], [storageKey(FINAL, 'config.json')]);
});

test('a network failure inside fetch is download-failed and names the host', async () => {
  await threeFiles();
  const net = fakeNet(() => {
    throw new TypeError('fetch failed');
  });
  const { store } = storeWith(net);
  const error = await modelError(store.install(FINAL), 'download-failed', FINAL);
  assert.match(error.message, /config\.json: fetch failed \(models\.test\)/);
  assert.equal((await store.status(FINAL)).state, 'failed');
});

test('install after a failure fetches only what is still missing and clears the failure', async () => {
  const model = await threeFiles();
  let online = false;
  const net = fakeNet((url) => (online || url.endsWith('/config.json') ? serving(model)(url, 0, undefined) : new Response('', { status: 500 })));
  const { store } = storeWith(net);
  await modelError(store.install(FINAL), 'download-failed', FINAL);
  assert.equal((await store.status(FINAL)).state, 'failed');

  online = true;
  net.calls.length = 0;
  const status = await store.install(FINAL);
  assert.equal(status.state, 'ready');
  assert.equal(status.verified, true);
  assert.equal(status.error, undefined);
  assert.deepEqual(net.urls(), ['https://models.test/whisper-base.en-q8/tokenizer.json', 'https://models.test/whisper-base.en-q8/onnx/encoder.onnx']);
});

// --- openVerified, verify ------------------------------------------------------------

test('openVerified returns every file of a verified model', async () => {
  const model = await threeFiles();
  const { store } = storeWith(fakeNet(serving(model)));
  await store.install(FINAL);
  const files = await store.openVerified(FINAL);
  assert.deepEqual([...files.keys()], ['config.json', 'tokenizer.json', 'onnx/encoder.onnx']);
  for (const [path, blob] of files) assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), model.byPath.get(path));
});

test('openVerified throws model-missing for an absent or partly stored model', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  const absent = await modelError(store.openVerified(FINAL), 'model-missing', FINAL);
  assert.match(absent.message, /not installed/);
  await seed(blobs, model, {}, ['onnx/encoder.onnx']);
  await modelError(store.openVerified(FINAL), 'model-missing', FINAL);
});

test('openVerified throws model-corrupt and names the file, also for a wrong-size file', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  await seed(blobs, model, { 'tokenizer.json': damaged(bytes(300, 2)) });
  const sameSize = await modelError(store.openVerified(FINAL), 'model-corrupt', FINAL);
  assert.match(sameSize.message, /tokenizer\.json failed the integrity check/);

  await seed(blobs, model, { 'config.json': bytes(63, 1) });
  const truncated = await modelError(store.openVerified(FINAL), 'model-corrupt', FINAL);
  assert.match(truncated.message, /config\.json/);
});

test('openVerified hashes again on every call: a file damaged after install is caught', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(fakeNet(serving(model)));
  await store.install(FINAL);
  assert.equal((await store.openVerified(FINAL)).size, 3);
  await blobs.put(storageKey(FINAL, 'onnx/encoder.onnx'), new Blob([damaged(bytes(1000, 3))]));
  await modelError(store.openVerified(FINAL), 'model-corrupt', FINAL);
});

test('verify flags a same-size corrupted file; the cheap status cannot see it before that', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  await seed(blobs, model, { 'tokenizer.json': damaged(bytes(300, 2)) });

  assert.equal((await store.status(FINAL)).state, 'ready', 'presence and size only');

  const verified = await store.verify(FINAL);
  assert.equal(verified.state, 'corrupt');
  assert.deepEqual(verified.badFiles, ['tokenizer.json']);
  assert.equal(verified.verified, false);
  assert.equal(verified.bytesDone, 1064, 'a bad file does not count as done');

  const after = await store.status(FINAL);
  assert.equal(after.state, 'corrupt', 'the verdict stays until the file is replaced');
  assert.deepEqual(after.badFiles, ['tokenizer.json']);
});

test('a stored file with the wrong size is corrupt even without verify', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(noNet());
  await seed(blobs, model, { 'onnx/encoder.onnx': bytes(999, 3) });
  const status = await store.status(FINAL);
  assert.equal(status.state, 'corrupt');
  assert.deepEqual(status.badFiles, ['onnx/encoder.onnx']);
});

// --- repair, remove --------------------------------------------------------------------

test('repair downloads only the files that fail verification', async () => {
  const model = await threeFiles();
  const net = fakeNet(serving(model));
  const { blobs, store } = storeWith(net);
  await store.install(FINAL);
  net.calls.length = 0;

  await blobs.put(storageKey(FINAL, 'tokenizer.json'), new Blob([damaged(bytes(300, 2))]));
  const status = await store.repair(FINAL);

  assert.deepEqual(net.urls(), ['https://models.test/whisper-base.en-q8/tokenizer.json']);
  assert.deepEqual(status, { id: FINAL, state: 'ready', bytesDone: 1364, bytesTotal: 1364, badFiles: [], verified: true });
  assert.deepEqual(await stored(blobs, FINAL, 'tokenizer.json'), bytes(300, 2));
  assert.equal((await store.openVerified(FINAL)).size, 3);
});

test('repair of a healthy model downloads nothing', async () => {
  const model = await threeFiles();
  const net = fakeNet(serving(model));
  const { store } = storeWith(net);
  await store.install(FINAL);
  net.calls.length = 0;
  assert.equal((await store.repair(FINAL)).state, 'ready');
  assert.equal(net.calls.length, 0);
});

test('a repair that cannot download leaves the bad file deleted, never in place', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(fakeNet(() => new Response('', { status: 500 })));
  await seed(blobs, model, { 'config.json': damaged(bytes(64, 1)) });
  await modelError(store.repair(FINAL), 'download-failed', FINAL);
  assert.equal(await stored(blobs, FINAL, 'config.json'), undefined);
  assert.equal((await store.status(FINAL)).state, 'failed');
  await modelError(store.openVerified(FINAL), 'model-missing', FINAL);
});

test('remove deletes the files of that model only and calls onRemoved', async () => {
  const final = await threeFiles();
  const live = await smallModel(LIVE, { 'model.tar.gz': bytes(40, 4) });
  const removed: ModelId[] = [];
  const net = fakeNet((url) => new Response(final.byUrl.get(url) ?? live.byUrl.get(url)));
  const { blobs, store } = storeWith(net, {
    onRemoved: async (id) => {
      removed.push(id);
    },
  });
  await store.install(FINAL);
  await store.install(LIVE);
  assert.equal(blobs.blobs.size, 4);

  await store.remove(FINAL);

  assert.deepEqual(removed, [FINAL]);
  assert.deepEqual([...blobs.blobs.keys()], [storageKey(LIVE, 'model.tar.gz')]);
  assert.deepEqual(await store.status(FINAL), { id: FINAL, state: 'missing', bytesDone: 0, bytesTotal: 1364, badFiles: [], verified: false });
  assert.equal((await store.status(LIVE)).state, 'ready');
  await modelError(store.openVerified(FINAL), 'model-missing', FINAL);
});

test('remove clears a failed or corrupt verdict', async () => {
  const model = await threeFiles();
  const { blobs, store } = storeWith(fakeNet(() => new Response('', { status: 500 })));
  await modelError(store.install(FINAL), 'download-failed', FINAL);
  assert.equal((await store.status(FINAL)).state, 'failed');
  await store.remove(FINAL);
  assert.equal((await store.status(FINAL)).state, 'missing');

  await seed(blobs, model, { 'config.json': damaged(bytes(64, 1)) });
  assert.equal((await store.verify(FINAL)).state, 'corrupt');
  await store.remove(FINAL);
  assert.equal((await store.status(FINAL)).state, 'missing');
});

// --- concurrency, abort -------------------------------------------------------------------

test('concurrent install calls share one download; status is downloading meanwhile', async () => {
  const model = await threeFiles();
  let reachedSecond = () => {};
  const secondStarted = new Promise<void>((resolve) => (reachedSecond = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const net = fakeNet(async (url) => {
    if (url.endsWith('/tokenizer.json')) {
      reachedSecond();
      await gate;
    }
    return serving(model)(url, 0, undefined);
  });
  const { store } = storeWith(net);

  const first = store.install(FINAL);
  const second = store.install(FINAL);
  assert.equal(second, first);

  await secondStarted;
  const third = store.install(FINAL);
  assert.equal(third, first);
  assert.deepEqual(await store.status(FINAL), { id: FINAL, state: 'downloading', bytesDone: 64, bytesTotal: 1364, badFiles: [], verified: false });
  assert.equal((await store.verify(FINAL)).state, 'downloading', 'verify does not judge a model that is still downloading');

  release();
  const statuses = await Promise.all([first, second, third]);
  assert.ok(statuses.every((status) => status.state === 'ready'));
  assert.deepEqual(
    net.urls(),
    model.files.map((file) => file.url),
  );

  const later = store.install(FINAL);
  assert.notEqual(later, first, 'a finished install is not reused');
  assert.equal((await later).state, 'ready');
  assert.equal(net.calls.length, 3, 'and it downloads nothing again');
});

test('an install started from the ready callback of the previous one is still shared', async () => {
  const model = await threeFiles();
  const { store } = storeWith(fakeNet(serving(model)));
  let second: Promise<ModelStatus> | undefined;
  await store.install(FINAL, {
    onProgress: (status) => {
      if (status.state === 'ready') second ??= store.install(FINAL);
    },
  });
  assert.ok(second);
  const third = store.install(FINAL);
  assert.equal(third, second, 'the second install is still running, so the third call must join it');
  await Promise.all([second, third]);
});

test('abort while a body is streaming: aborted, nothing stored, and a later install works', async () => {
  const model = await threeFiles();
  const controller = new AbortController();
  const net = fakeNet((url, _attempt, init) => {
    const data = model.byUrl.get(url);
    const signal = init?.signal;
    assert.ok(data);
    assert.ok(signal);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(data.subarray(0, data.length / 2));
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        },
        // Runs once the store has taken the first half.
        pull() {
          controller.abort();
        },
      }),
    );
  });
  const { blobs, store } = storeWith(net, { hashRetries: 3 });

  const error = await modelError(store.install(FINAL, { signal: controller.signal }), 'aborted', FINAL);
  assert.match(error.message, /config\.json: download cancelled/);
  assert.equal(net.calls.length, 1, 'an abort is not retried');
  assert.equal(blobs.blobs.size, 0);
  assert.deepEqual(
    store.downloads.map((record) => [record.path, record.bytes, record.ok]),
    [['config.json', 32, false]],
  );
  const status = await store.status(FINAL);
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'aborted');

  const retry = new ModelStore({ blobs, fetch: fakeNet(serving(model)).fetch });
  assert.equal((await retry.install(FINAL)).state, 'ready');
});

test('the signal of the caller reaches fetch; an already aborted signal stops the install', async () => {
  await threeFiles();
  const signal = AbortSignal.abort();
  const net = fakeNet((_url, _attempt, init) => {
    // What the real fetch does with an aborted signal.
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Response('unexpected');
  });
  const { blobs, store } = storeWith(net);
  await modelError(store.install(FINAL, { signal }), 'aborted', FINAL);
  assert.equal(net.calls[0].init?.signal, signal);
  assert.equal(net.calls.length, 1);
  assert.equal(blobs.blobs.size, 0);
});

// --- download ledger ------------------------------------------------------------------------

test('the downloads ledger records model, path, host, bytes, result and time of every attempt', async () => {
  const final = await threeFiles();
  const live = await smallModel(LIVE, { 'model.tar.gz': bytes(40, 4) });
  MODELS[LIVE].files[0].url = 'https://archive.test:8443/vosk/model.tar.gz';
  let clock = 1000;
  const net = fakeNet((url) => {
    if (url.startsWith('https://archive.test:8443/')) return new Response(live.byPath.get('model.tar.gz'));
    if (url.endsWith('/tokenizer.json')) return new Response('nope', { status: 404 });
    return serving(final)(url, 0, undefined);
  });
  const { store } = storeWith(net, { now: () => (clock += 10) });

  assert.deepEqual(store.downloads, []);
  await store.install(LIVE);
  await modelError(store.install(FINAL), 'download-failed', FINAL);

  assert.deepEqual(store.downloads, [
    { modelId: LIVE, path: 'model.tar.gz', host: 'archive.test:8443', bytes: 40, ok: true, atMs: 1010 },
    { modelId: FINAL, path: 'config.json', host: 'models.test', bytes: 64, ok: true, atMs: 1020 },
    { modelId: FINAL, path: 'tokenizer.json', host: 'models.test', bytes: 0, ok: false, atMs: 1030 },
  ]);

  await store.status(FINAL);
  await store.verify(LIVE);
  await store.openVerified(LIVE);
  assert.equal(store.downloads.length, 3, 'checks add nothing to the ledger');
});
