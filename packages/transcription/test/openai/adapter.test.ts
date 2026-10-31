// Fixture tests for the OpenAI whisper-1 adapter (board #16547).
// Run: npm test  (Node 22.18+ strips types; no network, no key)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderError, TranscriptRevision } from '../../src/contract.ts';
import {
  InvalidProviderResponse,
  OPENAI_MAX_UPLOAD_BYTES,
  OPENAI_TRANSCRIPTIONS_URL,
  OpenAiWhisperAdapter,
  TranscriptionFailed,
  UploadRefused,
  classifyOpenAiHttpError,
  stripOpenAiKeyText,
  dropUnspokenTail,
  parseOpenAiVerboseJson,
  parseRetryAfterMs,
  wavPcmSlicer,
} from '../../src/openai/index.ts';
import type { OpenAiProgress } from '../../src/openai/index.ts';
import { ProviderErrorException } from '../../src/provider-error.ts';
import { validateTranscriptRevision } from '../../src/revisions.ts';
import { CREDENTIAL, FAKE_KEY, consent, fakeFetch, fixture, instant, json, request, verbose, wav, webm } from './helpers.ts';

const never = new AbortController().signal;
const allWords = (revision: TranscriptRevision) => revision.segments.flatMap((segment) => segment.words);

/** 20 s of 1000 Hz mono WAV against a 12 s upload limit: three uploads with 4 s overlaps. */
const LONG = { audio: wav(20), maxUploadBytes: 24_288, overlapMs: 4000, slicer: wavPcmSlicer };

const rejects = async (promise: Promise<unknown>, reason: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof UploadRefused && error.reason === reason);

// --- one upload -----------------------------------------------------------

test('a short recording is one upload with the documented whisper-1 parameters', async () => {
  const { fetch, uploads } = fakeFetch([json(fixture('verbose-short.json'))]);
  const adapter = new OpenAiWhisperAdapter({ fetch, ...instant().options });
  const result = await adapter.transcribeDetailed(request(webm(), { audioOriginMs: 10_000 }), CREDENTIAL, never);

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(uploads[0].file.name, 'narration.webm');
  assert.deepEqual(uploads[0].fields, {
    model: ['whisper-1'],
    language: ['en'],
    response_format: ['verbose_json'],
    'timestamp_granularities[]': ['word', 'segment'],
  });

  const { revision } = result;
  assert.equal(revision.provider, 'openai');
  assert.equal(revision.model, 'whisper-1');
  assert.equal(revision.source, 'after-recording');
  assert.deepEqual(revision.gaps, []);
  assert.deepEqual(revision.segments.map((segment) => segment.text), ['This should collapse.', 'Revenue heading.']);
  // Provider seconds from the start of the file, moved by the file's place on the session clock.
  assert.deepEqual(
    allWords(revision).map((word) => [word.text, word.startMs, word.endMs]),
    [
      ['This', 10_420, 10_610],
      ['should', 10_610, 10_950],
      ['collapse', 10_950, 11_600],
      ['Revenue', 13_100, 13_600],
      ['heading', 13_600, 14_000],
    ],
  );
  assert.ok(revision.segments.every((segment) => segment.kind === 'final'));
  assert.deepEqual(validateTranscriptRevision(revision), []);
  assert.equal(result.billedAudioSeconds, 5);
  assert.equal(result.estimatedCostUsd, (5 / 60) * 0.006);
});

test('the default fetch is called without a receiver', async (t) => {
  // Browsers throw "Illegal invocation" when fetch is called as a method of another object.
  t.mock.method(globalThis, 'fetch', function (this: unknown, url: string) {
    assert.equal(this, undefined);
    assert.equal(url, OPENAI_TRANSCRIPTIONS_URL);
    return Promise.resolve(json(fixture('verbose-short.json')));
  });
  const revision = await new OpenAiWhisperAdapter().transcribe(request(webm()), CREDENTIAL, never);
  assert.equal(revision.segments.length, 2);
});

test('silence is a valid empty transcript', async () => {
  const { fetch } = fakeFetch([json({ text: '', duration: 3.2, usage: { type: 'duration', seconds: 4 } })]);
  const revision = await new OpenAiWhisperAdapter({ fetch }).transcribe(request(webm()), CREDENTIAL, never);
  assert.deepEqual(revision.segments, []);
  assert.deepEqual(validateTranscriptRevision(revision), []);
});

// --- long audio boundaries ------------------------------------------------

test('long audio: three overlapping uploads, each under the limit, sent in order', async () => {
  const bodies = fixture('long-three-uploads.json').uploads;
  const { fetch, uploads } = fakeFetch(bodies.map((body: unknown) => json(body)));
  const progress: OpenAiProgress[] = [];
  const adapter = new OpenAiWhisperAdapter({ fetch, ...LONG, ...instant().options, onProgress: (event) => progress.push(event) });
  const result = await adapter.transcribeDetailed(request(LONG.audio), CREDENTIAL, never);

  // 2000 bytes per second plus a 44-byte header: 0-8.667 s, 4.667-15.334 s, 11.334-20 s.
  assert.deepEqual(uploads.map((upload) => upload.file.size), [17_378, 21_378, 17_376]);
  assert.ok(uploads.every((upload) => upload.file.size <= LONG.maxUploadBytes && upload.file.name === 'narration.wav'));
  assert.deepEqual(progress[0], { type: 'plan', uploads: 3, uploadedAudioMs: 8667 + 10_667 + 8666 });
  assert.deepEqual(
    progress.filter((event) => event.type === 'upload-done').map((event) => event.index),
    [0, 1, 2],
  );
  assert.equal(result.uploads, 3);
  assert.equal(result.completedUploads, 3);
  assert.equal(result.billedAudioSeconds, 29);
});

test('long audio: every word appears once, on the session clock, across both boundaries', async () => {
  const bodies = fixture('long-three-uploads.json').uploads;
  for (const audioOriginMs of [0, 60_000]) {
    const { fetch } = fakeFetch(bodies.map((body: unknown) => json(body)));
    const adapter = new OpenAiWhisperAdapter({ fetch, ...LONG, ...instant().options });
    const revision = await adapter.transcribe(request(LONG.audio, { audioOriginMs }), CREDENTIAL, never);
    const words = allWords(revision);

    // "delta", "golf" and "hotel" were heard by two uploads; "ech" and "Lie" are halves of cut words.
    assert.deepEqual(
      words.map((word) => word.text.toLowerCase()),
      ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'],
    );
    // Upload 2 starts at 4.667 s and upload 3 at 11.334 s; their clocks restart at 0.
    const at = (text: string) => words.find((word) => word.text.toLowerCase() === text)!;
    assert.deepEqual([at('alpha').startMs, at('alpha').endMs], [audioOriginMs + 1000, audioOriginMs + 1400]);
    assert.deepEqual([at('echo').startMs, at('echo').endMs], [audioOriginMs + 4667 + 3750, audioOriginMs + 4667 + 4300]);
    assert.deepEqual([at('juliet').startMs, at('juliet').endMs], [audioOriginMs + 11_334 + 8000, audioOriginMs + 11_334 + 8500]);
    for (let index = 1; index < words.length; index += 1) assert.ok(words[index].startMs >= words[index - 1].endMs);

    // A segment cut at a boundary keeps only its own words, and its text matches them.
    assert.deepEqual(
      revision.segments.map((segment) => segment.text),
      ['Alpha bravo charlie', 'delta echo foxtrot golf', 'hotel india juliet'],
    );
    assert.equal(new Set(revision.segments.map((segment) => segment.segmentKey)).size, 3);
    assert.deepEqual(validateTranscriptRevision(revision), []);
  }
});

test('long audio: a later upload that fails leaves a gap to the end, not a silent hole', async () => {
  const [first] = fixture('long-three-uploads.json').uploads;
  const { fetch, uploads } = fakeFetch([json(first), json({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 401)]);
  const adapter = new OpenAiWhisperAdapter({ fetch, ...LONG, ...instant().options });
  const result = await adapter.transcribeDetailed(request(LONG.audio, { audioOriginMs: 5000 }), CREDENTIAL, never);

  assert.equal(uploads.length, 2); // the third upload is not attempted after a key failure
  assert.equal(result.completedUploads, 1);
  assert.equal(result.error?.kind, 'auth');
  // With no later upload to compare, the first keeps all its words, cut word included.
  assert.deepEqual(allWords(result.revision).map((word) => word.text), ['Alpha', 'bravo', 'charlie', 'delta', 'ech']);
  assert.deepEqual(result.revision.gaps, [
    { provider: 'openai', startMs: 5000 + 8667, endMs: 5000 + 20_000, reason: 'auth-failed', detail: 'invalid_api_key: Incorrect API key' },
  ]);
  assert.deepEqual(validateTranscriptRevision(result.revision), []);
});

test('long audio: a part refused after an upload keeps the transcript the user paid for', async () => {
  const [first] = fixture('long-three-uploads.json').uploads;
  const { fetch, uploads } = fakeFetch([json(first)]);
  let slices = 0;
  const adapter = new OpenAiWhisperAdapter({
    fetch,
    ...LONG,
    // The second part comes back over the limit: it is not sent, and the first is not thrown away.
    slicer: async () => ({ durationMs: 20_000, bytesPerSecond: 2000, headerBytes: 44, slice: () => wav((slices += 1) === 1 ? 10 : 13) }),
  });
  const result = await adapter.transcribeDetailed(request(LONG.audio), CREDENTIAL, never);

  assert.equal(uploads.length, 1);
  assert.equal(result.completedUploads, 1);
  assert.deepEqual([result.error?.kind, result.error?.code, result.error?.retryable], ['input', 'refused-oversized', false]);
  assert.deepEqual(allWords(result.revision).map((word) => word.text), ['Alpha', 'bravo', 'charlie', 'delta', 'ech']);
  assert.deepEqual(result.revision.gaps.map((gap) => [gap.startMs, gap.endMs, gap.reason]), [[8667, 20_000, 'provider-error']]);
  assert.deepEqual(validateTranscriptRevision(result.revision), []);
});

test('a word the model places past the end of the audio is held inside its upload', async () => {
  const { fetch } = fakeFetch([json(verbose([['late', 2.8, 4.9]], 3))]);
  const revision = await new OpenAiWhisperAdapter({ fetch }).transcribe(request(webm()), CREDENTIAL, never);
  assert.deepEqual([allWords(revision)[0].startMs, allWords(revision)[0].endMs], [2800, 4900]);

  // With a planned range, the end of the upload is known before the provider answers.
  const bodies = [verbose([['one', 1, 1.5]], 8.667), verbose([['two', 4, 4.5]], 10.667), verbose([['three', 8, 9.9]], 8.666)];
  const long = fakeFetch(bodies.map((body) => json(body)));
  const sliced = await new OpenAiWhisperAdapter({ fetch: long.fetch, ...LONG }).transcribe(request(LONG.audio), CREDENTIAL, never);
  const three = allWords(sliced).find((word) => word.text === 'three')!;
  assert.deepEqual([three.startMs, three.endMs], [11_334 + 8000, 20_000]);
});

// --- answers recorded from the live API (2026-10-13) ------------------------

const spoken = (revision: TranscriptRevision) => allWords(revision).map((word) => word.text.toLowerCase().replace(/[^a-z0-9]/g, ''));

test('live answer: one upload becomes a valid revision with every word timed', async () => {
  const { fetch } = fakeFetch([json(fixture('live-speech-en-31s.json'))]);
  const result = await new OpenAiWhisperAdapter({ fetch, ...instant().options }).transcribeDetailed(request(webm()), CREDENTIAL, never);

  assert.deepEqual(validateTranscriptRevision(result.revision), []);
  assert.equal(result.billedAudioSeconds, 32);
  assert.equal(allWords(result.revision).length, 69);
  assert.deepEqual(spoken(result.revision).slice(0, 4), ['he', 'hoped', 'there', 'would']);
  assert.deepEqual(spoken(result.revision).slice(-3), ['waiting', 'on', 'you']);
  assert.ok(allWords(result.revision).every((word) => word.endMs <= 31_500));
});

test('live answer: four uploads join into the words of the one-upload answer, each once', async () => {
  const recorded = fixture('live-speech-en-31s-four-uploads.json');
  const { durationMs, sampleRate, maxUploadBytes, overlapMs } = recorded.audio;
  const { fetch, uploads } = fakeFetch(recorded.uploads.map((body: unknown) => json(body)));
  const adapter = new OpenAiWhisperAdapter({ fetch, slicer: wavPcmSlicer, maxUploadBytes, overlapMs, ...instant().options });
  const result = await adapter.transcribeDetailed(request(wav(durationMs / 1000, sampleRate), { audioOriginMs: 5000 }), CREDENTIAL, never);
  const whole = await new OpenAiWhisperAdapter({ fetch: fakeFetch([json(fixture('live-speech-en-31s.json'))]).fetch }).transcribe(request(webm()), CREDENTIAL, never);

  assert.equal(uploads.length, 4);
  assert.deepEqual(validateTranscriptRevision(result.revision), []);
  // The two runs differ only in spelling ("Hullo"/"Hello", "ten"/"10"); no word is lost or repeated at a cut.
  const words = allWords(result.revision);
  assert.equal(words.length, 69);
  const differing = spoken(result.revision).filter((text, index) => text !== spoken(whole)[index]);
  assert.deepEqual(differing, ['counseled', 'hello', '10']);
  // Same place on the session clock as the one-upload answer, moved by audioOriginMs.
  allWords(whole).forEach((word, index) => {
    assert.ok(Math.abs(words[index].startMs - 5000 - word.startMs) <= 600, `${word.text}: ${words[index].startMs - 5000} against ${word.startMs}`);
  });
  // whisper-1 put a second "Number 10." and three empty segments in the closing silence.
  assert.deepEqual(spoken(result.revision).slice(-3), ['waiting', 'on', 'you']);
  assert.ok(result.revision.segments.every((segment) => segment.text !== '' && segment.words.length > 0));
  assert.equal(result.billedAudioSeconds, 44);
});

test('only an unspoken tail is dropped: a short word elsewhere and a normal ending are kept', () => {
  const body = (segments: Array<[string, number, number]>, duration: number) =>
    parseOpenAiVerboseJson({
      text: segments.map(([text]) => text).join(' '),
      duration,
      segments: segments.map(([text, start, end], id) => ({ id, start, end, text })),
      words: segments.flatMap(([text, start, end]) => text.split(' ').filter(Boolean).map((word) => ({ word, start, end }))),
    });
  const texts = (transcript: ReturnType<typeof body>) => [transcript.segments.map((segment) => segment.text), transcript.words.map((word) => word.text)];

  // 40 ms for two words at the end of the audio is not speech; the empty segment goes too.
  assert.deepEqual(texts(dropUnspokenTail(body([['Fresh Nelly', 7.6, 9.4], ['Number 10.', 9.8, 9.84], ['', 9.84, 9.84]], 9.87))), [['Fresh Nelly'], ['Fresh', 'Nelly']]);
  // The same short segment in the middle of the audio stays: only the tail is judged.
  const middle = body([['Yes.', 2, 2.04], ['Fresh Nelly', 7.6, 9.4]], 9.87);
  assert.equal(dropUnspokenTail(middle), middle);
  // A word cut off by the end of an upload has time behind it; the next upload supplies it whole.
  const cut = body([['Any good in your', 11.24, 11.84]], 11.87);
  assert.equal(dropUnspokenTail(cut), cut);
  // With no length from the provider, the last segment end is the end of the audio.
  assert.deepEqual(texts(dropUnspokenTail(body([['Hello there', 0.5, 1.2], ['Thanks.', 1.5, 1.5]], 0)))[0], ['Hello there']);
});

// --- retry ----------------------------------------------------------------

test('retry: a 429 waits for Retry-After, then succeeds', async () => {
  const limited = json({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '20' });
  const { fetch, uploads } = fakeFetch([limited, json(fixture('verbose-short.json'))]);
  const timing = instant();
  const progress: OpenAiProgress[] = [];
  const adapter = new OpenAiWhisperAdapter({ fetch, ...timing.options, onProgress: (event) => progress.push(event) });
  const revision = await adapter.transcribe(request(webm()), CREDENTIAL, never);

  assert.equal(uploads.length, 2);
  assert.deepEqual(timing.sleeps, [20_000]);
  assert.equal(revision.segments.length, 2);
  const retry = progress.find((event) => event.type === 'retry');
  assert.ok(retry?.type === 'retry' && retry.error.kind === 'rate-limit' && retry.delayMs === 20_000);
});

test('retry: server and network failures back off exponentially up to the attempt limit', async () => {
  const { fetch, uploads } = fakeFetch([json({ error: { message: 'boom' } }, 500), new TypeError('Failed to fetch'), json({}, 503), json({}, 502)]);
  const timing = instant();
  const adapter = new OpenAiWhisperAdapter({ fetch, ...timing.options });
  await assert.rejects(
    adapter.transcribe(request(webm()), CREDENTIAL, never),
    (error: unknown) => error instanceof TranscriptionFailed && error.error.kind === 'provider' && error.error.retryable && error.error.code === '502',
  );
  assert.equal(uploads.length, 4);
  assert.deepEqual(timing.sleeps, [1000, 2000, 4000]);
});

test('retry: a network failure recovers on the next attempt', async () => {
  const { fetch, uploads } = fakeFetch([new TypeError('Failed to fetch'), json(fixture('verbose-short.json'))]);
  const revision = await new OpenAiWhisperAdapter({ fetch, ...instant().options }).transcribe(request(webm()), CREDENTIAL, never);
  assert.equal(uploads.length, 2);
  assert.equal(revision.segments.length, 2);
});

test('retry: key, quota and input errors are not retried', async () => {
  const cases: Array<[Response, ProviderError['kind']]> = [
    [json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 401), 'auth'],
    [json({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429), 'quota'],
    [json({ error: { message: 'Invalid file format', type: 'invalid_request_error' } }, 400), 'input'],
  ];
  for (const [response, kind] of cases) {
    const { fetch, uploads } = fakeFetch([response]);
    const timing = instant();
    await assert.rejects(
      new OpenAiWhisperAdapter({ fetch, ...timing.options }).transcribe(request(webm()), CREDENTIAL, never),
      (error: unknown) => error instanceof TranscriptionFailed && error.error.kind === kind && !error.error.retryable,
    );
    assert.equal(uploads.length, 1);
    assert.deepEqual(timing.sleeps, []);
  }
});

test('retry: a Retry-After longer than the cap ends the job instead of waiting', async () => {
  const { fetch, uploads } = fakeFetch([json({ error: { message: 'slow down' } }, 429, { 'retry-after': '3600' })]);
  const timing = instant();
  await assert.rejects(
    new OpenAiWhisperAdapter({ fetch, ...timing.options }).transcribe(request(webm()), CREDENTIAL, never),
    (error: unknown) => error instanceof TranscriptionFailed && error.error.kind === 'rate-limit' && error.error.retryAfterMs === 3_600_000,
  );
  assert.equal(uploads.length, 1);
  assert.deepEqual(timing.sleeps, []);
});

test('retry: cancelling stops the wait and sends nothing more', async () => {
  const controller = new AbortController();
  const { fetch, uploads } = fakeFetch([json({}, 500), json(fixture('verbose-short.json'))]);
  const adapter = new OpenAiWhisperAdapter({
    fetch,
    sleep: async (_ms, signal) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(adapter.transcribe(request(webm()), CREDENTIAL, controller.signal), { name: 'AbortError' });
  assert.equal(uploads.length, 1);
});

/** A `fetch` that never answers; it ends only when its signal does, as the real one. */
function stalledFetch(replies: Response[]) {
  let calls = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const reply = replies.shift();
    if (reply) return reply;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

test('timeout: an attempt with no answer is ended and tried again', async () => {
  const events: OpenAiProgress[] = [];
  const stalled = stalledFetch([]);
  let attempts = 0;
  const fetch = ((url, init) => ((attempts += 1) === 1 ? stalled.fetch(url, init) : Promise.resolve(json(fixture('verbose-short.json'))))) as typeof globalThis.fetch;
  const adapter = new OpenAiWhisperAdapter({ fetch, requestTimeoutMs: 20, onProgress: (event) => events.push(event), ...instant().options });
  const revision = await adapter.transcribe(request(webm()), CREDENTIAL, never);

  assert.equal(attempts, 2);
  assert.ok(allWords(revision).length > 0);
  const retry = events.find((event) => event.type === 'retry');
  assert.deepEqual(retry?.type === 'retry' && [retry.error.kind, retry.error.code, retry.error.retryable], ['timeout', 'request-timeout', true]);
});

test('timeout: every attempt timing out ends the job as a timeout, and a cancel is not one', async () => {
  const stalled = stalledFetch([]);
  const adapter = new OpenAiWhisperAdapter({ fetch: stalled.fetch, requestTimeoutMs: 5, maxAttempts: 2, ...instant().options });
  await assert.rejects(
    adapter.transcribe(request(webm()), CREDENTIAL, never),
    (error: unknown) => error instanceof TranscriptionFailed && error.error.kind === 'timeout' && /No answer from OpenAI/.test(error.error.message),
  );
  assert.equal(stalled.calls(), 2);

  const controller = new AbortController();
  const cancelled = new OpenAiWhisperAdapter({ fetch: stalledFetch([]).fetch, requestTimeoutMs: 60_000 }).transcribe(request(webm()), CREDENTIAL, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});

test('Retry-After is read as seconds or as an HTTP date', () => {
  assert.equal(parseRetryAfterMs('1.5', 0), 1500);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('2026-10-21T07:28:00Z')), 10_000);
  assert.equal(parseRetryAfterMs('soon', 0), undefined);
  assert.equal(parseRetryAfterMs(null, 0), undefined);
  assert.equal(classifyOpenAiHttpError(503, undefined, 2000).retryAfterMs, 2000);
});

// --- rejected and oversized files -----------------------------------------

test('refused before upload: no consent, another recording, another provider, another scope', async () => {
  const { fetch, uploads } = fakeFetch([]);
  const adapter = new OpenAiWhisperAdapter({ fetch });
  const bad = [
    undefined,
    consent(1, { recordingId: 'rec-2' }),
    consent(1, { provider: 'deepgram' }),
    consent(1, { scope: 'page-capture' as 'narration-audio' }),
  ];
  for (const granted of bad) {
    await rejects(adapter.transcribe(request(webm(), { consent: granted as never }), CREDENTIAL, never), 'no-consent');
  }
  assert.equal(uploads.length, 0);
});

test('refused before upload: no key, empty audio, a type OpenAI does not accept', async () => {
  const { fetch, uploads } = fakeFetch([]);
  const adapter = new OpenAiWhisperAdapter({ fetch });
  await rejects(adapter.transcribe(request(webm()), { kind: 'api-key', key: '  ' }, never), 'no-key');
  await rejects(adapter.transcribe(request(webm(0)), CREDENTIAL, never), 'empty');
  await rejects(adapter.transcribe(request(new Blob(['x'], { type: 'video/quicktime' })), CREDENTIAL, never), 'unsupported-type');
  await rejects(adapter.transcribe(request(new Blob(['x'])), CREDENTIAL, never), 'unsupported-type');
  assert.equal(uploads.length, 0);
});

test('oversized: refused without a slicer, at the 25 MB limit', async () => {
  const { fetch, uploads } = fakeFetch([json(fixture('verbose-short.json'))]);
  const adapter = new OpenAiWhisperAdapter({ fetch });
  await rejects(adapter.transcribe(request(webm(OPENAI_MAX_UPLOAD_BYTES + 1)), CREDENTIAL, never), 'oversized');
  assert.equal(uploads.length, 0);
  await adapter.transcribe(request(webm(OPENAI_MAX_UPLOAD_BYTES)), CREDENTIAL, never);
  assert.equal(uploads.length, 1);
});

test('oversized: a slicer that returns a part over the limit is refused, not sent', async () => {
  const { fetch, uploads } = fakeFetch([]);
  const adapter = new OpenAiWhisperAdapter({
    fetch,
    maxUploadBytes: 24_288,
    slicer: async () => ({ durationMs: 20_000, bytesPerSecond: 2000, headerBytes: 44, slice: () => wav(13) }),
  });
  await rejects(adapter.transcribe(request(wav(20)), CREDENTIAL, never), 'oversized');
  assert.equal(uploads.length, 0);
});

test('oversized: audio the slicer cannot read is refused', async () => {
  const adapter = new OpenAiWhisperAdapter({ fetch: fakeFetch([]).fetch, maxUploadBytes: 100, slicer: wavPcmSlicer });
  await rejects(adapter.transcribe(request(webm(500)), CREDENTIAL, never), 'unsupported-type');
});

test('rejected by OpenAI: 413 and 415 are input errors and are not sent again', async () => {
  for (const status of [413, 415]) {
    const { fetch, uploads } = fakeFetch([json({ error: { message: 'Maximum content size limit exceeded' } }, status)]);
    await assert.rejects(
      new OpenAiWhisperAdapter({ fetch, ...instant().options }).transcribe(request(webm()), CREDENTIAL, never),
      (error: unknown) => error instanceof TranscriptionFailed && error.error.kind === 'input' && error.error.code === String(status),
    );
    assert.equal(uploads.length, 1);
  }
});

test('the API key never appears in an error', async () => {
  const echo = json({ error: { message: `Incorrect API key provided: ${FAKE_KEY}.`, code: 'invalid_api_key' } }, 401);
  const { fetch } = fakeFetch([echo]);
  const error = await new OpenAiWhisperAdapter({ fetch }).transcribe(request(webm()), CREDENTIAL, never).catch((caught) => caught);
  assert.ok(error instanceof TranscriptionFailed);
  // The same error class and redaction as the live adapters, so one handler covers every provider.
  assert.ok(error instanceof ProviderErrorException);
  assert.ok(!JSON.stringify([error.message, error.error]).includes(FAKE_KEY));
  assert.match(error.error.message, /\[redacted\]/);

  const network = fakeFetch(Array.from({ length: 4 }, () => new TypeError(`connect failed for Bearer ${FAKE_KEY}`)));
  const failed = await new OpenAiWhisperAdapter({ fetch: network.fetch, ...instant().options }).transcribe(request(webm()), CREDENTIAL, never).catch((caught) => caught);
  assert.equal(failed.error.kind, 'network');
  assert.ok(!failed.message.includes(FAKE_KEY));
});

// Board #16588: OpenAI's 401 text repeats the key with its middle starred out.
test("OpenAI's starred-out key is taken from the error, last characters included", () => {
  const masked = `sk-proj-${'*'.repeat(40)}${FAKE_KEY.slice(-4)}`;
  const body = { error: { message: `Incorrect API key provided: ${masked}. You can find your API key at https://platform.openai.com/account/api-keys.`, code: 'invalid_api_key' } };
  const error = classifyOpenAiHttpError(401, body);
  assert.deepEqual([error.kind, error.retryable], ['auth', false]);
  assert.equal(error.message, 'Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.');
  assert.equal(stripOpenAiKeyText('the task was skipped; risk-free'), 'the task was skipped; risk-free');
});

// --- response against the shared contract ---------------------------------

test('contract: the documented response becomes a revision the contract validator accepts', () => {
  const parsed = parseOpenAiVerboseJson(fixture('verbose-short.json'));
  assert.equal(parsed.words.length, 5);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.durationSeconds, 4.1);
  assert.equal(parsed.billedSeconds, 5);
});

test('contract: text with no word list is rejected, because it has no word timing', async () => {
  // This is what gpt-4o-transcribe returns; whisper-1 with the wrong parameters does the same.
  assert.throws(() => parseOpenAiVerboseJson({ text: 'This should collapse.' }), InvalidProviderResponse);
  const { fetch, uploads } = fakeFetch([json({ text: 'This should collapse.' })]);
  await assert.rejects(
    new OpenAiWhisperAdapter({ fetch, ...instant().options }).transcribe(request(webm()), CREDENTIAL, never),
    (error: unknown) => error instanceof TranscriptionFailed && error.error.code === 'invalid-response' && !error.error.retryable,
  );
  assert.equal(uploads.length, 1);
});

test('contract: malformed times and shapes are named', () => {
  const issues = (body: unknown) => {
    try {
      parseOpenAiVerboseJson(body);
      return [];
    } catch (error) {
      return (error as InvalidProviderResponse).issues;
    }
  };
  assert.deepEqual(issues('text'), ['body is not a JSON object']);
  assert.deepEqual(issues({ text: 'a', words: [{ word: 'a', start: 2, end: 1 }] }), ['words[0] ends before it starts']);
  assert.deepEqual(issues({ text: 'a', words: [{ word: 'a', start: '0', end: 1 }] }), ['words[0] needs word, start and end']);
  assert.deepEqual(issues({ text: 'a', words: [{ word: 'a', start: -1, end: 1 }] }), ['words[0] needs word, start and end']);
  assert.deepEqual(issues({ text: 'a', words: 'a' }), ['words is not an array']);
  assert.deepEqual(issues({ text: 'a', words: [], segments: [{ start: 0, end: null, text: 'a' }] }), ['segments[0] needs text, start and end']);
  assert.deepEqual(issues({ words: [] }), ['text is not a string']);
});

test('contract: a truncated body is tried again; words out of order are sorted', async () => {
  const body = { text: 'b a', duration: 2, words: [{ word: 'b', start: 1, end: 1.5 }, { word: 'a', start: 0.2, end: 0.6 }] };
  const { fetch, uploads } = fakeFetch([new Response('{"text": "b', { status: 200 }), json(body)]);
  const revision = await new OpenAiWhisperAdapter({ fetch, ...instant().options }).transcribe(request(webm()), CREDENTIAL, never);
  assert.equal(uploads.length, 2);
  // No segment list: the words still form one utterance.
  assert.equal(revision.segments.length, 1);
  assert.deepEqual(allWords(revision).map((word) => word.text), ['a', 'b']);
  assert.deepEqual(validateTranscriptRevision(revision), []);
});

test('contract: the validator names a revision that breaks the contract', () => {
  const revision = {
    revisionId: 'r',
    provider: 'openai',
    model: 'whisper-1',
    createdAtMs: 1,
    source: 'after-recording',
    gaps: [{ provider: 'openai', startMs: 5, endMs: 5, reason: 'disconnected' }],
    segments: [
      { provider: 'openai', model: 'whisper-1', connectionId: 'c', segmentKey: 'k', kind: 'interim', startMs: 10, endMs: 5, text: 'x', endOfUtterance: true,
        words: [{ text: 'x', startMs: 3, endMs: 4 }, { text: 'y', startMs: 1, endMs: 2, confidence: 2 }] },
      { provider: 'deepgram', model: 'whisper-1', connectionId: 'c', segmentKey: 'k', kind: 'final', startMs: 0, endMs: 1, text: 'x', endOfUtterance: true, words: [] },
    ],
  };
  assert.deepEqual(validateTranscriptRevision(revision), [
    'segments[0] is not final',
    'segments[0] has an invalid time range',
    'segments[0].words[1] starts before the word ahead of it',
    'segments[0].words[1] confidence is outside 0..1',
    'segments[1] repeats segmentKey k',
    'segments[1] is from another provider',
    'gaps[0] has an invalid time range',
  ]);
});
