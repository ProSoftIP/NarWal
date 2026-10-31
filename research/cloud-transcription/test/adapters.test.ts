// Fixture tests for the proposed NarWal transcription contract (board #16540).
// Run: node --test research/cloud-transcription/test/  (Node 22.18+ strips types)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { AdapterEvent, TranscriptSegment } from '../src/contract.ts';
import { dropReplayedWords, gapBetweenConnections } from '../src/contract.ts';
import {
  DeepgramNormalizer,
  buildDeepgramGrantRequest,
  buildDeepgramListenUrl,
  classifyDeepgramClose,
  classifyDeepgramHttp,
  deepgramSubprotocols,
  parseDeepgramGrantResponse,
} from '../src/deepgram.ts';
import {
  AssemblyAiNormalizer,
  assemblyAiChunkBytes,
  buildAssemblyAiStreamUrl,
  buildAssemblyAiTokenRequest,
  classifyAssemblyAiError,
  parseAssemblyAiTokenResponse,
} from '../src/assemblyai.ts';
import {
  OPENAI_MAX_UPLOAD_BYTES,
  UploadRefused,
  buildOpenAiTranscriptionForm,
  classifyOpenAiHttpError,
  normalizeOpenAiVerboseJson,
  planUploadRanges,
} from '../src/openai.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const segments = (events: AdapterEvent[]): TranscriptSegment[] =>
  events.flatMap((event) => (event.type === 'segment' ? [event.segment] : []));

/** Applies interim/final replacement the way the transcript store would. */
function settle(all: TranscriptSegment[]): TranscriptSegment[] {
  const byKey = new Map<string, TranscriptSegment>();
  for (const segment of all) byKey.set(segment.segmentKey, segment);
  return [...byKey.values()].filter((segment) => segment.kind === 'final');
}

const FAKE_KEY = 'fixture-key-not-real';

test('Deepgram: grant request keeps the key in the header and uses ttl_seconds', () => {
  const request = buildDeepgramGrantRequest(FAKE_KEY, 30);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Token ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(request.init.body), { ttl_seconds: 30 });
  assert.ok(!request.url.includes(FAKE_KEY));
  assert.throws(() => buildDeepgramGrantRequest(FAKE_KEY, 3601), RangeError);
});

test('Deepgram: granted JWT uses the bearer subprotocol; a raw key uses token', () => {
  const credential = parseDeepgramGrantResponse({ access_token: 'jwt-abc', expires_in: 30 }, 1_000);
  assert.deepEqual(credential, { kind: 'temporary-token', token: 'jwt-abc', expiresAtMs: 31_000 });
  assert.deepEqual(deepgramSubprotocols(credential), ['bearer', 'jwt-abc']);
  assert.deepEqual(deepgramSubprotocols({ kind: 'api-key', key: FAKE_KEY }), ['token', FAKE_KEY]);
  assert.throws(() => parseDeepgramGrantResponse({}, 0));
});

test('Deepgram: listen URL omits encoding for container audio and sets it for PCM', () => {
  const container = new URL(buildDeepgramListenUrl());
  assert.equal(container.searchParams.get('encoding'), null);
  assert.equal(container.searchParams.get('sample_rate'), null);
  assert.equal(container.searchParams.get('language'), 'en');
  assert.equal(container.searchParams.get('interim_results'), 'true');
  const pcm = new URL(buildDeepgramListenUrl({ pcmSampleRate: 16000 }));
  assert.equal(pcm.searchParams.get('encoding'), 'linear16');
  assert.equal(pcm.searchParams.get('sample_rate'), '16000');
});

test('Deepgram: results map to the session clock and interim is replaced by final', () => {
  const normalizer = new DeepgramNormalizer(10_000, 'dg-1');
  const events: AdapterEvent[] = fixture('deepgram-connection-1.json').messages.flatMap((m: Record<string, unknown>) => normalizer.handle(m));
  const all = segments(events);
  assert.equal(all.length, 2);
  assert.equal(all[0].kind, 'interim');
  assert.equal(all[0].segmentKey, all[1].segmentKey);
  const [final] = settle(all);
  assert.equal(final.text, 'This should collapse.');
  assert.equal(final.model, 'general-nova-3');
  assert.equal(final.endOfUtterance, true);
  assert.deepEqual(
    final.words.map((w) => [w.text, w.startMs, w.endMs]),
    [['This', 10_420, 10_610], ['should', 10_610, 10_950], ['collapse.', 10_950, 11_600]],
  );
  const usage = events.find((e) => e.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', provider: 'deepgram', audioSeconds: 2.3, basis: 'processed-audio-seconds' });
});

test('Deepgram: a reconnect restarts the provider clock; the session clock stays monotonic', () => {
  const first = settle(segments(fixture('deepgram-connection-1.json').messages.flatMap((m: Record<string, unknown>) => new DeepgramNormalizer(10_000, 'dg-1').handle(m))));
  // A final segment covers its whole audio window (start + duration), not just its last word.
  const lastFinalEndMs = first.at(-1)!.endMs; // 12_300

  // Case 1: audio between connections was lost; the gap is recorded, not invented.
  const resumedAt = 14_000;
  const gap = gapBetweenConnections('deepgram', lastFinalEndMs, resumedAt, 'disconnected');
  assert.deepEqual(gap, { provider: 'deepgram', startMs: 12_300, endMs: 14_000, reason: 'disconnected' });
  const second = settle(segments(fixture('deepgram-connection-2.json').messages.flatMap((m: Record<string, unknown>) => new DeepgramNormalizer(resumedAt, 'dg-2').handle(m))));
  assert.equal(second[0].words[0].startMs, 14_200);
  assert.ok(second[0].startMs >= first.at(-1)!.endMs);

  // Case 2: buffered audio was replayed from the last final end; no gap.
  assert.equal(gapBetweenConnections('deepgram', lastFinalEndMs, lastFinalEndMs, 'disconnected'), null);
});

test('Deepgram: close codes classify into contract errors', () => {
  assert.equal(classifyDeepgramClose(1008, 'DATA-0000').kind, 'input');
  assert.deepEqual(
    [classifyDeepgramClose(1011, 'NET-0001').kind, classifyDeepgramClose(1011, 'NET-0001').retryable],
    ['timeout', true],
  );
  assert.equal(classifyDeepgramClose(1006, '').kind, 'network');
  assert.equal(classifyDeepgramHttp(401).kind, 'auth');
  assert.equal(classifyDeepgramHttp(429).retryable, true);
});

test('AssemblyAI: token request uses GET with the key header, never the URL', () => {
  const request = buildAssemblyAiTokenRequest(FAKE_KEY, { expiresInSeconds: 60, maxSessionDurationSeconds: 3600 });
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, FAKE_KEY);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('expires_in_seconds'), '60');
  assert.equal(url.searchParams.get('max_session_duration_seconds'), '3600');
  assert.ok(!request.url.includes(FAKE_KEY));
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { expiresInSeconds: 601 }), RangeError);
  assert.throws(() => buildAssemblyAiTokenRequest(FAKE_KEY, { maxSessionDurationSeconds: 59 }), RangeError);
});

test('AssemblyAI: stream URL carries the temporary token and refuses a raw key', () => {
  const credential = parseAssemblyAiTokenResponse({ token: 'tmp-xyz', expires_in_seconds: 60 }, 0);
  const url = new URL(buildAssemblyAiStreamUrl(credential, { formatTurns: true }));
  assert.equal(url.searchParams.get('token'), 'tmp-xyz');
  assert.equal(url.searchParams.get('encoding'), 'pcm_s16le');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.throws(() => buildAssemblyAiStreamUrl({ kind: 'api-key', key: FAKE_KEY }));
});

test('AssemblyAI: chunk size stays within 50..1000 ms', () => {
  assert.equal(assemblyAiChunkBytes(50), 1600);
  assert.throws(() => assemblyAiChunkBytes(20), RangeError);
  assert.throws(() => assemblyAiChunkBytes(1500), RangeError);
});

test('AssemblyAI: turns map ms to the session clock; only the formatted end-of-turn is final', () => {
  const normalizer = new AssemblyAiNormalizer(10_000, 'aai-1', { formatTurns: true });
  const events: AdapterEvent[] = fixture('assemblyai-session.json').messages.flatMap((m: Record<string, unknown>) => normalizer.handle(m));
  const all = segments(events);
  assert.deepEqual(all.map((s) => s.kind), ['interim', 'interim', 'final']);
  const [final] = settle(all);
  assert.equal(final.text, 'This should collapse.');
  assert.equal(final.model, 'universal-streaming-english');
  assert.deepEqual(final.words.map((w) => [w.startMs, w.endMs]), [[10_420, 10_610], [10_610, 10_950], [10_950, 11_600]]);
  const usage = events.find((e) => e.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', provider: 'assemblyai', audioSeconds: 3, basis: 'session-duration-seconds' });
});

test('AssemblyAI: close codes classify into contract errors', () => {
  assert.equal(classifyAssemblyAiError(1008, 'Unauthorized connection: invalid token').kind, 'auth');
  assert.equal(classifyAssemblyAiError(1008, 'Unauthorized connection: Too many concurrent sessions').kind, 'rate-limit');
  assert.equal(classifyAssemblyAiError(1008, 'Insufficient balance').kind, 'quota');
  assert.equal(classifyAssemblyAiError(3009, '').kind, 'rate-limit');
  assert.equal(classifyAssemblyAiError(3007, 'chunk too small').retryable, false);
  assert.equal(classifyAssemblyAiError(3008, 'max session duration').kind, 'timeout');
});

test('Both providers produce the same session-clock words for the same speech', () => {
  const dg = settle(segments(fixture('deepgram-connection-1.json').messages.flatMap((m: Record<string, unknown>) => new DeepgramNormalizer(0, 'a').handle(m))));
  const aai = settle(segments(fixture('assemblyai-session.json').messages.flatMap((m: Record<string, unknown>) => new AssemblyAiNormalizer(0, 'b', { formatTurns: true }).handle(m))));
  assert.deepEqual(
    dg[0].words.map((w) => [w.startMs, w.endMs]),
    aai[0].words.map((w) => [w.startMs, w.endMs]),
  );
});

const consent = { provider: 'openai' as const, recordingId: 'rec-1', grantedAtMs: 1, scope: 'narration-audio' as const };

test('OpenAI: form asks whisper-1 for verbose_json word and segment timestamps', () => {
  const audio = new Blob([new Uint8Array(10)], { type: 'audio/webm;codecs=opus' });
  const form = buildOpenAiTranscriptionForm({ recordingId: 'rec-1', audio, audioOriginMs: 0, consent, language: 'en' });
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('language'), 'en');
  assert.deepEqual(form.getAll('timestamp_granularities[]'), ['word', 'segment']);
  assert.equal((form.get('file') as File).name, 'narration.webm');
});

test('OpenAI: refuses without matching consent, over 25 MB, or an unsupported type', () => {
  const audio = new Blob([new Uint8Array(10)], { type: 'audio/webm' });
  const base = { recordingId: 'rec-1', audio, audioOriginMs: 0, language: 'en' as const };
  assert.throws(() => buildOpenAiTranscriptionForm({ ...base, consent: undefined as never }), UploadRefused);
  assert.throws(() => buildOpenAiTranscriptionForm({ ...base, consent: { ...consent, recordingId: 'other' } }), UploadRefused);
  assert.throws(() => buildOpenAiTranscriptionForm({ ...base, consent: { ...consent, provider: 'deepgram' } }), UploadRefused);
  const big = { size: OPENAI_MAX_UPLOAD_BYTES + 1, type: 'audio/webm' } as Blob;
  assert.throws(() => buildOpenAiTranscriptionForm({ ...base, audio: big, consent }), UploadRefused);
  const video = new Blob([new Uint8Array(1)], { type: 'video/x-matroska' });
  assert.throws(() => buildOpenAiTranscriptionForm({ ...base, audio: video, consent }), UploadRefused);
});

test('OpenAI: verbose_json becomes a final revision on the session clock', () => {
  const revision = normalizeOpenAiVerboseJson(fixture('openai-verbose.json'), { audioOriginMs: 60_000, revisionId: 'rev-1', createdAtMs: 5 });
  assert.equal(revision.source, 'after-recording');
  assert.deepEqual(revision.segments.map((s) => s.text), ['This should collapse.', 'Revenue heading.']);
  assert.deepEqual(revision.segments.map((s) => s.words.length), [3, 2]);
  assert.equal(revision.segments[1].words[0].startMs, 63_100);
  assert.ok(revision.segments.every((s) => s.kind === 'final'));
});

test('OpenAI: a long recording splits into ranges under the upload limit', () => {
  // 32 kbit/s Opus = 4000 B/s; 30 minutes fits one upload.
  assert.equal(planUploadRanges(30 * 60_000, 4000).length, 1);
  // 16 kHz mono PCM WAV = 32000 B/s; 30 minutes needs several.
  const ranges = planUploadRanges(30 * 60_000, 32_000);
  assert.ok(ranges.length > 1);
  assert.equal(ranges[0].startMs, 0);
  assert.equal(ranges.at(-1)!.endMs, 30 * 60_000);
  for (const range of ranges) assert.ok(((range.endMs - range.startMs) / 1000) * 32_000 <= OPENAI_MAX_UPLOAD_BYTES);
});

test('OpenAI: HTTP errors classify; quota is never retried', () => {
  assert.deepEqual(
    [classifyOpenAiHttpError(429, { error: { type: 'insufficient_quota' } }).kind, classifyOpenAiHttpError(429, { error: { type: 'insufficient_quota' } }).retryable],
    ['quota', false],
  );
  const limited = classifyOpenAiHttpError(429, { error: { code: 'rate_limit_exceeded' } }, '7');
  assert.deepEqual([limited.kind, limited.retryable, limited.retryAfterMs], ['rate-limit', true, 7000]);
  assert.equal(classifyOpenAiHttpError(401, undefined).kind, 'auth');
  assert.equal(classifyOpenAiHttpError(413, undefined).kind, 'input');
  assert.equal(classifyOpenAiHttpError(503, undefined).retryable, true);
});

test('Replay after reconnect drops words already finalized', () => {
  const words = [
    { text: 'collapse.', startMs: 10_950, endMs: 11_600 },
    { text: 'Revenue', startMs: 11_700, endMs: 12_100 },
  ];
  assert.deepEqual(dropReplayedWords(words, 11_600).map((w) => w.text), ['Revenue']);
});
