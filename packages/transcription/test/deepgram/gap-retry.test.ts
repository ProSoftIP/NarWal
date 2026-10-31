import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranscriptGap, TranscriptRevision } from '../../src/contract.ts';
import { createDeepgramSession } from '../../src/deepgram/index.ts';
import { applyGapRetry, retranscribeGap } from '../../src/gap-retry.ts';
import type { PcmChunk } from '../../src/live-session.ts';
import { ManualTimers, SocketRecorder, dgResults, pcm, settle } from '../helpers.ts';

const gap: TranscriptGap = { provider: 'deepgram', startMs: 1_000, endMs: 3_000, reason: 'disconnected' };

const base: TranscriptRevision = {
  revisionId: 'r1',
  provider: 'deepgram',
  model: 'general-nova-3',
  createdAtMs: 1,
  source: 'live',
  segments: [
    { provider: 'deepgram', model: 'general-nova-3', connectionId: 'a', segmentKey: 'a:0', kind: 'final', startMs: 0, endMs: 1_000, text: 'Before.', words: [{ text: 'Before.', startMs: 200, endMs: 600 }], endOfUtterance: true },
  ],
  gaps: [gap],
};

test('an explicit gap retry streams local audio at a paced rate and fills the gap in a new revision', async () => {
  const sockets = new SocketRecorder();
  const timers = new ManualTimers();
  async function* readPcm(startMs: number, endMs: number): AsyncIterable<PcmChunk> {
    for (let at = startMs; at < endMs; at += 100) yield pcm(at, 100);
  }
  const retrying = retranscribeGap({
    gap,
    readPcm,
    timers,
    createSession: () => createDeepgramSession({ getCredential: async () => ({ kind: 'temporary-token', token: 't', expiresAtMs: 0 }), createSocket: sockets.create, timers }),
  });
  await settle();
  sockets.last.serverOpen();
  // 2 s of audio at 1.2x real time takes about 1.67 s to send.
  for (let step = 0; step < 20; step += 1) {
    timers.advance(100);
    await settle(2);
  }
  assert.equal(sockets.last.audioFrames().length, 20);
  sockets.last.serverSend(dgResults({ start: 0, duration: 1.0, isFinal: true, words: [{ word: 'Recovered', start: 0.5, end: 0.9 }] }));
  sockets.last.serverSend(dgResults({ start: 1.0, duration: 1.0, isFinal: true, words: [] }));
  await settle();
  assert.deepEqual(sockets.last.textFrames().at(-1), { type: 'CloseStream' });
  sockets.last.serverClose(1000);
  const result = await retrying;
  assert.deepEqual(result.revision.gaps, []);
  assert.equal(result.revision.segments[0].words[0].startMs, 1_500);

  const merged = applyGapRetry(base, gap, result.revision, { revisionId: 'r2', createdAtMs: 2 });
  assert.deepEqual(merged.segments.map((segment) => segment.text), ['Before.', 'Recovered']);
  assert.deepEqual(merged.gaps, []);
  assert.equal(merged.revisionId, 'r2');
  assert.deepEqual(base.gaps, [gap], 'the base revision is not edited');
});

test('a gap is never retried with another provider', () => {
  const other: TranscriptRevision = { ...base, provider: 'assemblyai', gaps: [], segments: [] };
  assert.throws(() => applyGapRetry(base, gap, other, { revisionId: 'r3', createdAtMs: 3 }), /provider that left it/);
});

test('what the retry could not transcribe stays a gap, clipped to the original range', () => {
  const retry: TranscriptRevision = { ...base, segments: [], gaps: [{ provider: 'deepgram', startMs: 1_000, endMs: 9_000, reason: 'auth-failed' }] };
  const merged = applyGapRetry(base, gap, retry, { revisionId: 'r4', createdAtMs: 4 });
  assert.deepEqual(merged.gaps, [{ provider: 'deepgram', startMs: 1_000, endMs: 3_000, reason: 'auth-failed' }]);
});
