// Tests for the final model chain and the machine's tier (board #16603).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chainAfterCutShort, finalizeWithChain } from '../src/final-chain.ts';
import type { Finalize } from '../src/final-chain.ts';
import { FinalPassStopped } from '../src/final-pass.ts';
import type { FinalPassCheckpoint, FinalPassRequest, FinalPassResult } from '../src/final-pass.ts';
import { ModelError } from '../src/model-store.ts';
import { FINAL_MODEL_IDS, MODELS, TRANSFORMERS_MODEL_IDS, isSherpaModel, isTransformersModel, sherpaRuntime, transformersRuntime } from '../src/models.ts';
import { FINAL_CHAIN, LIVE_CHAIN, LIVE_MODEL_ID, RETIRED_FINAL, chainWithRetired, detectFinalTier, modelsForTier, readyLiveModel, withoutReplaced } from '../src/tier.ts';
import { pcmSource } from '../src/vad.ts';

const request: FinalPassRequest = { recordingId: 'rec', revisionId: 'rev', audio: pcmSource(new Float32Array(16000)) };

const result = (model: string): FinalPassResult => ({
  revision: { revisionId: 'rev', provider: 'browser-local', model, createdAtMs: 0, source: 'after-recording', segments: [], gaps: [] },
  stats: { spans: 0, resumedSpans: 0, engineCalls: 0, failedSpans: 0, audioMs: 0 },
});

/** A clock the fake models move: each span costs `msPerSpan[model]`. */
function fakeModels(behaviour: Record<string, Error | { msPerSpan: number; spans: number }>) {
  let clock = 0;
  const ran: string[] = [];
  const finalize: Finalize = async (req, model) => {
    ran.push(model);
    const b = behaviour[model];
    if (b instanceof Error) throw b;
    for (let done = 1; done <= b.spans; done += 1) {
      if (req.signal?.aborted) throw new FinalPassStopped('aborted', 'stopped');
      clock += b.msPerSpan;
      req.onProgress?.({ doneSpans: done, totalSpans: b.spans });
    }
    if (req.signal?.aborted) throw new FinalPassStopped('aborted', 'stopped');
    return result(model);
  };
  return { finalize, ran, now: () => clock };
}

test('the best model runs when it is installed and fast enough', async () => {
  const { finalize, ran, now } = fakeModels({ a: { msPerSpan: 1000, spans: 30 }, b: { msPerSpan: 100, spans: 30 } });
  const done = await finalizeWithChain(finalize, request, { chain: ['a', 'b'], deadlineMs: 60_000, now });
  assert.deepEqual([done.model, done.attempts, ran], ['a', [], ['a']]);
});

test('a missing, damaged or broken model falls to the next, with the reason kept', async () => {
  const { finalize, ran, now } = fakeModels({
    a: new ModelError('model-missing', 'whisper-large-v3-turbo', 'not installed'),
    b: new ModelError('model-corrupt', 'whisper-small.en-q8', 'hash differs'),
    c: new FinalPassStopped('engine-failed', 'three spans failed'),
    d: { msPerSpan: 10, spans: 3 },
  });
  const done = await finalizeWithChain(finalize, request, { chain: ['a', 'b', 'c', 'd'], deadlineMs: 60_000, now });
  assert.equal(done.model, 'd');
  assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
  assert.deepEqual(done.attempts.map((a) => a.outcome), ['model-missing', 'model-corrupt', 'engine-failed']);
});

test('a model that would miss the deadline is stopped once the projection is reliable; the last always finishes', async () => {
  // a: 100 spans × 5 s = 500 s, limit 120 s. Projected over the limit after 20 s (4 spans).
  // b: 100 spans × 2 s = 200 s, also over the limit, but it is the last: it finishes.
  const { finalize, now } = fakeModels({ a: { msPerSpan: 5000, spans: 100 }, b: { msPerSpan: 2000, spans: 100 } });
  const progress: number[] = [];
  const done = await finalizeWithChain(finalize, { ...request, onProgress: (p) => progress.push(p.doneSpans) }, { chain: ['a', 'b'], deadlineMs: 120_000, now });
  assert.equal(done.model, 'b');
  assert.equal(done.attempts[0].outcome, 'too-slow');
  assert.match(done.attempts[0].message, /would take about 8 min; the limit is 2 min/);
  assert.deepEqual(progress.slice(0, 5), [1, 2, 3, 4, 1], 'model a ran 4 spans, then b started from 1');
  assert.equal(now(), 4 * 5000 + 100 * 2000);
});

test('a resumed job goes on with the model in its checkpoint; the user stopping it is not a fallback', async () => {
  const { finalize, ran, now } = fakeModels({ a: { msPerSpan: 10, spans: 3 }, b: { msPerSpan: 10, spans: 3 } });
  const resumeFrom = { version: 1, recordingId: 'rec', revisionId: 'rev', model: 'b', plan: [], done: {} } as FinalPassCheckpoint;
  assert.equal((await finalizeWithChain(finalize, { ...request, resumeFrom }, { chain: ['a', 'b'], deadlineMs: 60_000, now })).model, 'b');
  assert.deepEqual(ran, ['b']);

  const stop = new AbortController();
  stop.abort();
  await assert.rejects(finalizeWithChain(finalize, { ...request, signal: stop.signal }, { chain: ['a', 'b'], deadlineMs: 60_000, now }), FinalPassStopped);
  assert.deepEqual(ran, ['b', 'a']);
});

test('tier: a hardware WebGPU adapter with half-precision shaders runs turbo; anything else runs WebAssembly', async () => {
  type Nav = NonNullable<Parameters<typeof detectFinalTier>[0]>;
  type Adapter = Awaited<ReturnType<NonNullable<Nav['gpu']>['requestAdapter']>>;
  const gpu = (adapter: Adapter): Nav => ({ gpu: { requestAdapter: async () => adapter } });
  const f16 = { has: (name: string) => name === 'shader-f16' };
  assert.equal(await detectFinalTier(gpu({ features: f16 })), 'webgpu');
  assert.equal(await detectFinalTier(undefined), 'wasm');
  assert.equal(await detectFinalTier({}), 'wasm');
  assert.equal(await detectFinalTier(gpu(null)), 'wasm');
  assert.equal(await detectFinalTier(gpu({ features: f16, info: { isFallbackAdapter: true } })), 'wasm', 'SwiftShader is slower than WebAssembly');
  assert.equal(await detectFinalTier(gpu({ features: f16, isFallbackAdapter: true })), 'wasm');
  assert.equal(await detectFinalTier({ gpu: { requestAdapter: async () => Promise.reject(new Error('blocked')) } }), 'wasm');
  const needsF16 = FINAL_CHAIN.webgpu.some((id) => {
    const manifest = MODELS[id];
    return manifest.engine === 'transformers.js' && Object.values(manifest.runtime.dtype).some((dtype) => dtype.includes('16'));
  });
  assert.equal(await detectFinalTier(gpu({ features: { has: () => false } })), needsF16 ? 'wasm' : 'webgpu');
});

test('tier: every chain model is pinned, and the offline option downloads Vosk, Parakeet, then its tier chain (#16617)', () => {
  assert.deepEqual(modelsForTier('wasm'), [LIVE_MODEL_ID, 'parakeet-tdt-0.6b-v2-int8', 'whisper-small.en-q8', 'moonshine-base-q8']);
  assert.deepEqual(modelsForTier('webgpu'), [LIVE_MODEL_ID, 'parakeet-tdt-0.6b-v2-int8', 'whisper-large-v3-turbo', 'whisper-small.en-q8']);
  for (const tier of ['webgpu', 'wasm'] as const) {
    assert.deepEqual(modelsForTier(tier), [...new Set([LIVE_MODEL_ID, ...LIVE_CHAIN, ...FINAL_CHAIN[tier]])]);
    for (const id of FINAL_CHAIN[tier]) {
      assert.ok(MODELS[id].files.length > 0, id);
      for (const file of MODELS[id].files) assert.match(file.sha256, /^[0-9a-f]{64}$/, `${id} ${file.path}`);
    }
  }
  assert.ok(FINAL_CHAIN.wasm.every((id) => MODELS[id].runtime?.device !== 'webgpu'), 'the WebAssembly chain never needs a GPU');
});

test('Start needs one live model, Parakeet or Vosk (#16617)', () => {
  assert.deepEqual(LIVE_CHAIN, ['parakeet-tdt-0.6b-v2-int8', 'vosk-small-en-us']);
  const status = (id: string, state: string) => ({ id, state });
  assert.equal(readyLiveModel([status('vosk-small-en-us', 'ready'), status('parakeet-tdt-0.6b-v2-int8', 'missing')])?.id, 'vosk-small-en-us');
  assert.equal(readyLiveModel([status('vosk-small-en-us', 'missing'), status('parakeet-tdt-0.6b-v2-int8', 'ready')])?.id, 'parakeet-tdt-0.6b-v2-int8');
  assert.equal(readyLiveModel([status('vosk-small-en-us', 'ready'), status('parakeet-tdt-0.6b-v2-int8', 'ready')])?.id, 'parakeet-tdt-0.6b-v2-int8', 'best first');
  assert.equal(readyLiveModel([status('vosk-small-en-us', 'downloading'), status('parakeet-tdt-0.6b-v2-int8', 'corrupt')]), undefined);
  assert.equal(readyLiveModel([status('vosk-small-en-us', 'missing'), status('whisper-small.en-q8', 'ready')]), undefined, 'a final model alone is not a live model');
});

test('base.en, retired for Moonshine, stays the last fallback only where Moonshine is not installed (#16609)', () => {
  assert.equal(RETIRED_FINAL['whisper-base.en-q8'], 'moonshine-base-q8');
  const wasm = chainWithRetired(FINAL_CHAIN.wasm);
  assert.deepEqual(wasm, ['parakeet-tdt-0.6b-v2-int8', 'whisper-small.en-q8', 'moonshine-base-q8', 'whisper-base.en-q8']);
  assert.deepEqual(chainWithRetired(FINAL_CHAIN.webgpu), FINAL_CHAIN.webgpu, 'no retired model joins a chain without its replacement');
  assert.ok(!modelsForTier('wasm').includes('whisper-base.en-q8'), 'base.en is not downloaded any more');
  const installed = (...ids: string[]) => withoutReplaced(wasm.filter((id) => ids.includes(id)));
  assert.deepEqual(installed('whisper-base.en-q8'), ['whisper-base.en-q8']);
  assert.deepEqual(installed('whisper-small.en-q8', 'whisper-base.en-q8'), ['whisper-small.en-q8', 'whisper-base.en-q8']);
  assert.deepEqual(installed('moonshine-base-q8', 'whisper-base.en-q8'), ['moonshine-base-q8']);
  assert.deepEqual(installed('whisper-small.en-q8', 'moonshine-base-q8', 'whisper-base.en-q8'), ['whisper-small.en-q8', 'moonshine-base-q8']);
  assert.deepEqual(installed(), []);
});

test('a job cut short goes on with the next model, never the same one again; the last model always stays (#16603 review item 6)', () => {
  const chain = ['turbo', 'small', 'base'];
  assert.deepEqual(chainAfterCutShort(chain, []), chain);
  assert.deepEqual(chainAfterCutShort(chain, ['turbo']), ['small', 'base']);
  assert.deepEqual(chainAfterCutShort(chain, ['turbo', 'small']), ['base']);
  assert.deepEqual(chainAfterCutShort(chain, ['turbo', 'small', 'base']), ['base'], 'the last model runs even when it was cut short');
  assert.deepEqual(chainAfterCutShort(chain, ['other']), chain);
});

test('a resumed job whose model was left out starts the next model from the start, with no checkpoint of the other model', async () => {
  const models = fakeModels({ small: { msPerSpan: 1, spans: 2 }, base: { msPerSpan: 1, spans: 2 } });
  const seen: (FinalPassCheckpoint | undefined)[] = [];
  const finalize: Finalize = (req, model) => {
    seen.push(req.resumeFrom);
    return models.finalize(req, model);
  };
  const resumeFrom = { version: 1, recordingId: 'rec', model: 'turbo' } as unknown as FinalPassCheckpoint;
  const out = await finalizeWithChain(finalize, { ...request, resumeFrom }, { chain: chainAfterCutShort(['turbo', 'small', 'base'], ['turbo']), deadlineMs: 1e9, now: models.now });
  assert.equal(out.model, 'small');
  assert.deepEqual(models.ran, ['small']);
});

test('every final model names its engine; the Whisper worker serves only transformers.js entries (#16603 review item 4)', () => {
  for (const id of FINAL_MODEL_IDS) assert.ok(['transformers.js', 'sherpa-onnx'].includes(MODELS[id].engine), `${id} engine ${MODELS[id].engine}`);
  assert.equal(MODELS['vosk-small-en-us'].engine, 'vosk');
  assert.ok(TRANSFORMERS_MODEL_IDS.every((id) => MODELS[id].engine === 'transformers.js' && transformersRuntime(id).repo));
  assert.equal(isTransformersModel('vosk-small-en-us'), false);
  assert.throws(() => transformersRuntime('vosk-small-en-us' as never), /does not run on transformers\.js/);
  assert.equal(isTransformersModel('parakeet-tdt-0.6b-v2-int8'), false, 'Parakeet is not a Whisper worker model');
});

test('the sherpa-onnx worker serves only sherpa-onnx entries (#16608)', () => {
  assert.equal(MODELS['parakeet-tdt-0.6b-v2-int8'].engine, 'sherpa-onnx');
  assert.equal(isSherpaModel('parakeet-tdt-0.6b-v2-int8'), true);
  assert.equal(isSherpaModel('whisper-small.en-q8'), false);
  assert.equal(isSherpaModel('vosk-small-en-us'), false);
  assert.equal(sherpaRuntime('parakeet-tdt-0.6b-v2-int8').modelType, 'nemo_transducer');
  assert.throws(() => sherpaRuntime('whisper-small.en-q8'), /does not run on sherpa-onnx/);
});
