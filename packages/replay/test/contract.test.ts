// Board #16549: replay reads transcripts through the shared contract, so the
// output of every adapter (Deepgram, AssemblyAI, OpenAI, browser-local live
// and final) replays the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderId, TranscriptRevision } from '../../transcription/src/contract.ts';
import { toStoredRevision } from '../../transcription/src/revisions.ts';
import { toBundleRevision } from '../../offline-transcription/src/revisions.ts';
import { loadReplay } from '../src/load.ts';
import { stateAt } from '../src/model.ts';
import { MIC_LOSS, UTTERANCES, knownTimingFiles } from './known-timing.ts';

const MODELS: Record<ProviderId, string> = {
  deepgram: 'nova-3',
  assemblyai: 'universal-streaming',
  openai: 'whisper-1',
  'browser-local': 'vosk-small-en-us',
};

/** What an adapter hands over: session-ms segments with word times. */
function adapterRevision(provider: ProviderId, source: TranscriptRevision['source']): TranscriptRevision {
  return {
    revisionId: `${provider}-run`,
    provider,
    model: MODELS[provider],
    createdAtMs: Date.parse('2026-10-13T20:01:00Z'),
    source,
    segments: UTTERANCES.map((u, i) => {
      const words = u.text.split(' ');
      const step = (u.endMs - u.startMs) / words.length;
      return {
        provider,
        model: MODELS[provider],
        connectionId: 'c1',
        segmentKey: `c1:${i}`,
        kind: 'final' as const,
        startMs: u.startMs,
        endMs: u.endMs,
        text: u.text,
        words: words.map((text, k) => ({ text, startMs: u.startMs + k * step, endMs: u.startMs + (k + 1) * step, confidence: 0.8 })),
        endOfUtterance: true,
        ...(provider === 'browser-local' ? { timing: 'aligned' as const } : {}),
      };
    }),
    gaps: [{ provider, startMs: MIC_LOSS.startMs, endMs: MIC_LOSS.endMs, reason: provider === 'browser-local' ? 'engine-failed' : 'disconnected' }],
  };
}

const cases: [string, () => object][] = [
  ['deepgram (live)', () => toStoredRevision(adapterRevision('deepgram', 'live'), 'r1')],
  ['assemblyai (live)', () => toStoredRevision(adapterRevision('assemblyai', 'live'), 'r1')],
  ['openai (after recording)', () => toStoredRevision(adapterRevision('openai', 'after-recording'), 'r1')],
  ['browser-local via the shared history', () => toStoredRevision(adapterRevision('browser-local', 'live'), 'r1')],
  ['browser-local via the offline package', () => toBundleRevision({ ...adapterRevision('browser-local', 'after-recording'), revisionId: 'r1' })],
];

for (const [name, make] of cases) {
  test(`a ${name} revision replays with the same seeks`, async () => {
    const revision = make() as { provider: string };
    const { model } = await loadReplay(knownTimingFiles({ revisions: [revision] }));
    assert.equal(model.transcript?.provider, revision.provider);
    assert.equal(model.utterances.length, UTTERANCES.length);
    for (const [i, u] of UTTERANCES.entries()) {
      assert.equal(stateAt(model, u.startMs).utterance, i);
      assert.equal(stateAt(model, u.endMs - 1).utterance, i);
      assert.equal(stateAt(model, u.endMs).utterance, -1);
    }
    // The correction in edits.jsonl applies to every adapter's segment s2.
    assert.equal(model.utterances[1]!.text, 'the next page after the navigation');
    const gap = stateAt(model, MIC_LOSS.startMs + 1).gaps.find((g) => g.effect === 'no-transcript');
    assert.ok(gap, 'the provider gap is shown');
  });
}
