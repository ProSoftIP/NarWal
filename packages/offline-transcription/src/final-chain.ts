// The final pass with a fallback chain (board #16603).
//
// Runs the best model of the machine's tier (tier.ts). The next model in the
// chain runs when one is not installed, is damaged, cannot load, fails span
// after span, or would not finish before the job's deadline. The last model
// in the chain always runs to the end: a slow transcript beats none.

import { FinalPassStopped } from './final-pass.ts';
import type { FinalPassRequest, FinalPassResult } from './final-pass.ts';
import { ModelError } from './model-store.ts';

export type ChainOutcome = 'model-missing' | 'model-corrupt' | 'load-failed' | 'engine-failed' | 'too-slow';

export interface ChainAttempt {
  model: string;
  outcome: ChainOutcome;
  message: string;
}

export interface ChainOptions {
  /** Best first (FINAL_CHAIN in tier.ts). */
  chain: string[];
  /** The whole job's time budget, from its start. */
  deadlineMs: number;
  now?: () => number;
  /** No switch on a projection before this much of a model's run has passed: early spans are noisy. */
  minProjectionMs?: number;
  /** Called when a model starts. */
  onModel?: (model: string, attempts: ChainAttempt[]) => void;
}

export type Finalize = (request: FinalPassRequest, model: string) => Promise<FinalPassResult>;

export interface ChainResult extends FinalPassResult {
  model: string;
  /** The models that did not produce the revision, and why. */
  attempts: ChainAttempt[];
}

/**
 * The chain for a job that was cut short and goes on. The model that was
 * running may be what stopped the document (no memory left, a crashed GPU
 * process), so each model that was cut short is left out and the next one
 * runs. The last model is never left out: a slow transcript beats none.
 */
export function chainAfterCutShort(chain: string[], cutShort: readonly string[]): string[] {
  const rest = chain.filter((model) => !cutShort.includes(model));
  return rest.length ? rest : chain.slice(-1);
}

function outcomeOf(error: unknown): ChainOutcome {
  if (error instanceof ModelError) return error.code === 'model-corrupt' ? 'model-corrupt' : 'model-missing';
  if (error instanceof FinalPassStopped) return 'engine-failed';
  return 'load-failed';
}

export async function finalizeWithChain(finalize: Finalize, request: FinalPassRequest, options: ChainOptions): Promise<ChainResult> {
  if (!options.chain.length) throw new Error('no final model to run');
  const now = options.now ?? Date.now;
  const minProjectionMs = options.minProjectionMs ?? 20_000;
  const startedAt = now();
  const attempts: ChainAttempt[] = [];
  // A resumed job goes on with the model it was running, when that model is
  // still in the chain (chainAfterCutShort may have left it out).
  const resumed = request.resumeFrom ? options.chain.indexOf(request.resumeFrom.model) : -1;

  for (let index = Math.max(0, resumed); index < options.chain.length; index += 1) {
    const model = options.chain[index];
    const last = index === options.chain.length - 1;
    const modelStartedAt = now();
    const stop = new AbortController();
    const outer = request.signal;
    const forward = () => stop.abort(outer?.reason);
    if (outer?.aborted) forward();
    else outer?.addEventListener('abort', forward, { once: true });
    let slow = '';
    let ran = 0;
    options.onModel?.(model, attempts);
    try {
      const result = await finalize(
        {
          ...request,
          signal: stop.signal,
          onProgress(progress) {
            request.onProgress?.(progress);
            ran += 1;
            if (last || slow) return;
            const spent = now() - modelStartedAt;
            if (spent < minProjectionMs) return;
            const projected = modelStartedAt - startedAt + (spent / ran) * (ran + progress.totalSpans - progress.doneSpans);
            if (projected > options.deadlineMs) {
              slow = `would take about ${Math.round(projected / 60_000)} min; the limit is ${Math.round(options.deadlineMs / 60_000)} min`;
              stop.abort();
            }
          },
        },
        model,
      );
      return { ...result, model, attempts };
    } catch (error) {
      if (outer?.aborted) throw error;
      if (last) throw error;
      attempts.push({ model, outcome: slow ? 'too-slow' : outcomeOf(error), message: slow || (error instanceof Error ? error.message : String(error)) });
    } finally {
      outer?.removeEventListener('abort', forward);
    }
  }
  throw new Error('unreachable');
}
