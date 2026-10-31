import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdapterEvent } from '../../src/contract.ts';
import { AssemblyAiNormalizer } from '../../src/assemblyai/normalizer.ts';
import {
  ASSEMBLYAI_DEFAULT_MODEL,
  assemblyAiChunkBytes,
  buildAssemblyAiStreamUrl,
  classifyAssemblyAiError,
  redactAssemblyAiStreamUrl,
} from '../../src/assemblyai/stream.ts';
import { fixture, segments, settle } from './helpers.ts';

const run = (normalizer: AssemblyAiNormalizer, name: string): AdapterEvent[] =>
  fixture(name).messages.flatMap((message: Record<string, unknown>) => normalizer.handle(message));

test('timing: provider milliseconds land on the session clock at audioOriginMs', () => {
  // A second connection that started 60 s into the recording.
  const normalizer = new AssemblyAiNormalizer(60_000, 'aai-2', { formatTurns: true });
  const [final] = settle(segments(run(normalizer, 'session-formatted.json')));
  assert.deepEqual(
    final.words.map((word) => [word.text, word.startMs, word.endMs]),
    [['Click', 60_400, 60_640], ['the', 60_640, 60_720], ['Save', 60_720, 61_010], ['button.', 61_010, 61_380]],
  );
  assert.equal(final.startMs, 60_400);
  assert.equal(final.endMs, 61_380);
  assert.equal(normalizer.lastFinalEndMs, 61_380);
});

test('revisions (format_turns): interims share one key, words are revised, only the formatted copy is final', () => {
  const normalizer = new AssemblyAiNormalizer(0, 'aai-1', { formatTurns: true, requestedModel: ASSEMBLYAI_DEFAULT_MODEL });
  const events = run(normalizer, 'session-formatted.json');
  const turn0 = segments(events).filter((segment) => segment.segmentKey === 'aai-1:0');
  assert.deepEqual(turn0.map((segment) => segment.kind), ['interim', 'interim', 'interim', 'final']);
  // Interim text shows words still being revised ("safe" became "save").
  assert.equal(turn0[0].text, 'click the safe');
  assert.equal(turn0[1].text, 'click the save button');
  assert.equal(turn0[3].text, 'Click the Save button.');
  assert.equal(turn0[3].endOfUtterance, true);
  assert.equal(turn0[3].model, 'universal-streaming-english');
  assert.equal(normalizer.providerSessionId, 'sess-fmt-1');
  // Turn 1 ended but its formatted copy never came: still interim until flushed.
  const turn1 = segments(events).filter((segment) => segment.segmentKey === 'aai-1:1');
  assert.deepEqual(turn1.map((segment) => segment.kind), ['interim']);
  const flushed = segments(normalizer.flushPendingTurns());
  assert.deepEqual(flushed.map((segment) => [segment.segmentKey, segment.kind, segment.text]), [['aai-1:1', 'final', 'then wait']]);
  assert.equal(normalizer.lastFinalEndMs, 2750);
  assert.deepEqual(normalizer.flushPendingTurns(), []);
});

test('revisions (no format_turns, Universal-3): end_of_turn is final and later copies are ignored', () => {
  const normalizer = new AssemblyAiNormalizer(0, 'u3', { formatTurns: false });
  const events = run(normalizer, 'session-unformatted.json');
  const all = segments(events);
  assert.deepEqual(all.map((segment) => segment.kind), ['interim', 'final']);
  // An interim with an empty transcript still shows its words.
  assert.equal(all[0].text, 'open');
  assert.equal(all[1].text, 'Open settings.');
  assert.equal(all[1].model, 'universal-3-6-pro');
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage',
    provider: 'assemblyai',
    audioSeconds: 2,
    basis: 'session-duration-seconds',
  });
});

test('empty and malformed turns produce nothing', () => {
  const normalizer = new AssemblyAiNormalizer(0, 'x');
  assert.deepEqual(normalizer.handle({ type: 'Turn', turn_order: 0, end_of_turn: false, transcript: '', words: [] }), []);
  assert.deepEqual(normalizer.handle({ type: 'Turn', turn_order: 'zero', words: [{ text: 'a', start: 0, end: 1 }] }), []);
  assert.deepEqual(normalizer.handle({ type: 'SpeechStarted', timestamp: 10 }), []);
});

test('errors: Error frames use error_code; close codes follow the documented table', () => {
  const normalizer = new AssemblyAiNormalizer(0, 'x');
  const [event] = normalizer.handle({ type: 'Error', error_code: 3009, error: 'Unauthorized Connection: Too many concurrent sessions' });
  assert.equal(event.type === 'error' && event.error.kind, 'rate-limit');
  assert.equal(event.type === 'error' && event.error.code, '3009');
  for (const row of fixture('errors.json').closes) {
    const error = classifyAssemblyAiError(row.code, row.reason);
    assert.equal(error.kind, row.kind, `${row.code} ${row.reason}`);
    assert.equal(error.retryable, row.retryable, `${row.code} ${row.reason}`);
    assert.equal(error.provider, 'assemblyai');
  }
});

test('stream URL: token in the query, documented parameters, raw key refused, redactable', () => {
  const credential = { kind: 'temporary-token' as const, token: 'tmp-xyz', expiresAtMs: 1 };
  const url = new URL(buildAssemblyAiStreamUrl(credential));
  assert.equal(url.origin + url.pathname, 'wss://streaming.assemblyai.com/v3/ws');
  assert.equal(url.searchParams.get('token'), 'tmp-xyz');
  assert.equal(url.searchParams.get('encoding'), 'pcm_s16le');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('speech_model'), 'universal-streaming-english');
  assert.equal(url.searchParams.get('format_turns'), 'true');
  assert.equal(url.searchParams.get('inactivity_timeout'), null);

  const u3 = new URL(buildAssemblyAiStreamUrl(credential, { speechModel: 'universal-3-6-pro', formatTurns: true, inactivityTimeoutSeconds: 30 }));
  assert.equal(u3.searchParams.get('format_turns'), null);
  assert.equal(u3.searchParams.get('inactivity_timeout'), '30');

  assert.throws(() => buildAssemblyAiStreamUrl({ kind: 'api-key', key: 'k' }));
  assert.throws(() => buildAssemblyAiStreamUrl(credential, { speechModel: 'universal-streaming-multilingual' as never }), RangeError);
  assert.throws(() => buildAssemblyAiStreamUrl(credential, { inactivityTimeoutSeconds: 4 }), RangeError);
  assert.ok(!redactAssemblyAiStreamUrl(url.toString()).includes('tmp-xyz'));
});

test('chunk sizes stay within 50..1000 ms', () => {
  assert.equal(assemblyAiChunkBytes(50), 1600);
  assert.equal(assemblyAiChunkBytes(100), 3200);
  assert.equal(assemblyAiChunkBytes(1000), 32000);
  assert.throws(() => assemblyAiChunkBytes(49), RangeError);
  assert.throws(() => assemblyAiChunkBytes(1001), RangeError);
});
