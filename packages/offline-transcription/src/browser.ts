// Browser wiring for the offline option (board #16544): Cache API model store,
// packaged Vosk worker, packaged Whisper and sherpa-onnx workers. Live text
// comes from Parakeet when it is installed, from Vosk otherwise (#16617). `runtimeBase` is the URL of
// the directory build.mjs wrote (inside the extension package), with a
// trailing slash.

import { PARAKEET_LIVE_MODEL, parakeetLiveFactory } from './engines/parakeet-live.ts';
import { VoskRuntime, deleteVoskExtractedModel } from './engines/vosk-client.ts';
import { WhisperRuntime } from './engines/whisper-client.ts';
import { liveEngineChain } from './live-chain.ts';
import { ModelStore, cacheBlobStore } from './model-store.ts';
import type { NetworkAttempt } from './network-guard.ts';
import { OfflineTranscriber } from './offline-transcriber.ts';
import type { OfflineTranscriberDeps } from './offline-transcriber.ts';

export interface BrowserOfflineTranscriber {
  transcriber: OfflineTranscriber;
  vosk: VoskRuntime;
  whisper: WhisperRuntime;
  /** The live Parakeet worker, apart from the final pass's so neither evicts the other's model. Runs only while a live engine is open. */
  live: WhisperRuntime;
  /** Why live Parakeet was given up in this document, if it was; Vosk runs instead. */
  liveFallback: string | null;
  /** Requests the engine workers made or tried to make. Anything `blocked` is a defect. */
  engineNetworkLedger(): Promise<{ vosk: NetworkAttempt[]; whisper: NetworkAttempt[]; live: NetworkAttempt[] }>;
  dispose(): void;
}

export function createBrowserOfflineTranscriber(
  runtimeBase: string,
  options: Pick<OfflineTranscriberDeps, 'live' | 'final'> & { maxThreads?: number } = {},
): BrowserOfflineTranscriber {
  const models = new ModelStore({
    blobs: cacheBlobStore(),
    onRemoved: async (id) => {
      if (id === 'vosk-small-en-us') await deleteVoskExtractedModel();
    },
  });
  const vosk = new VoskRuntime({ workerUrl: `${runtimeBase}vosk-worker.js`, store: models });
  const whisper = new WhisperRuntime({ workerUrl: `${runtimeBase}whisper-worker.js`, runtimeBase, store: models, maxThreads: options.maxThreads });
  // A live span is at most 8 s of audio; one that takes 30 s means the engine is no use live.
  const live = new WhisperRuntime({ workerUrl: `${runtimeBase}whisper-worker.js`, runtimeBase, store: models, transcribeTimeoutMs: 30_000 });
  const createLiveEngine = liveEngineChain({
    primary: parakeetLiveFactory(live),
    fallback: vosk.createEngine,
    primaryInstalled: async () => (await models.status(PARAKEET_LIVE_MODEL)).state === 'ready',
    onPrimaryFailed: (reason) => {
      result.liveFallback = reason;
    },
  });
  const transcriber = new OfflineTranscriber({
    models,
    createLiveEngine,
    getFinalEngine: whisper.getEngine,
    live: options.live,
    final: options.final,
  });
  const result: BrowserOfflineTranscriber = {
    transcriber,
    vosk,
    whisper,
    live,
    liveFallback: null,
    async engineNetworkLedger() {
      return { vosk: await vosk.networkLedger(), whisper: await whisper.networkLedger(), live: await live.networkLedger() };
    },
    dispose() {
      vosk.terminate();
      whisper.terminate();
      live.terminate();
    },
  };
  return result;
}
