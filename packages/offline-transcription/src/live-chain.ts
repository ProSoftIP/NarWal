// The live engine chain (board #16617): Parakeet when it is installed, Vosk
// otherwise. When Parakeet cannot load, fails, stalls or falls behind far
// enough to skip audio, the session's restart opens Vosk, and Parakeet is not
// tried again in this document: a model that broke or was too slow once would
// be so in the next recording too.

import type { LiveEngine, LiveEngineFactory } from './live-session.ts';
import { ModelError } from './model-store.ts';

export interface LiveChainOptions {
  /** Best first. */
  primary: LiveEngineFactory;
  fallback: LiveEngineFactory;
  /** True when the primary model is stored. Asked before every engine opens. */
  primaryInstalled: () => Promise<boolean>;
  /** Told once, when the primary is given up. */
  onPrimaryFailed?: (reason: string) => void;
}

export function liveEngineChain(options: LiveChainOptions): LiveEngineFactory {
  let failed = false;
  const giveUp = (reason: string) => {
    if (failed) return;
    failed = true;
    options.onPrimaryFailed?.(reason);
  };
  return async (onMessage) => {
    if (failed || !(await options.primaryInstalled().catch(() => false))) return options.fallback(onMessage);
    let engine: LiveEngine;
    try {
      engine = await options.primary(onMessage);
    } catch (error) {
      giveUp(error instanceof Error ? error.message : String(error));
      try {
        return await options.fallback(onMessage);
      } catch (fallbackError) {
        // Neither model can run. A broken primary is the one to repair; a missing fallback says nothing new.
        if (error instanceof ModelError && fallbackError instanceof ModelError && fallbackError.code === 'model-missing') throw error;
        throw fallbackError;
      }
    }
    return {
      model: engine.model,
      timing: engine.timing,
      fallsBack: true,
      feed: (samples) => engine.feed(samples),
      flush: () => engine.flush(),
      close: (reason) => {
        if (reason === 'failed') giveUp('the engine failed while recording');
        if (reason === 'behind') giveUp('the engine could not keep up with the recording');
        engine.close(reason);
      },
    };
  };
}
