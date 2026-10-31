// OpenAI whisper-1 live smoke test (board #16547). Runs the product code path with no
// NarWal server: OpenAiWhisperAdapter.transcribeDetailed() with the user's key, the same
// call the extension makes after a recording stops.
//
//   node scripts/openai-smoke.ts --audio speech.flac                 # dry run, sends nothing
//   OPENAI_API_KEY=... node scripts/openai-smoke.ts --audio speech.flac --live
//
// Options:
//   --reference words.json     known word times ({ durationS, words: [{ w, s, e }] }); checks the timing
//   --max-upload-bytes N       a small limit that forces the long-recording path (16-bit PCM WAV only):
//                              ffmpeg -i speech.flac -ac 1 -ar 16000 -c:a pcm_s16le speech.wav
//   --overlap-ms N             audio shared by neighbouring uploads (default 4000)
//   --origin-ms N              session time of the first sample (default 0)
//   --save-response file.json  writes the raw verbose_json body; for several uploads, { uploads: [body, ...] }
//
// Use non-sensitive speech: the audio goes to OpenAI and the key is charged $0.006 per minute.
// The key is never printed. Not covered here: the chrome-extension:// Origin and the browser
// decoder (createDecodingSlicer); those are proved by the first in-extension recording.

import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import type { BatchTranscriptionRequest } from '../src/contract.ts';
import {
  OPENAI_FILE_EXTENSIONS,
  OPENAI_MAX_UPLOAD_BYTES,
  OPENAI_WHISPER_INFO,
  OpenAiWhisperAdapter,
  TranscriptionFailed,
  UploadRefused,
  describeOpenAiUpload,
  wavPcmSlicer,
} from '../src/openai/index.ts';
import { validateTranscriptRevision } from '../src/revisions.ts';

const { values } = parseArgs({
  options: {
    audio: { type: 'string' },
    live: { type: 'boolean', default: false },
    reference: { type: 'string' },
    'max-upload-bytes': { type: 'string', default: String(OPENAI_MAX_UPLOAD_BYTES) },
    'overlap-ms': { type: 'string', default: '4000' },
    'origin-ms': { type: 'string', default: '0' },
    'save-response': { type: 'string' },
  },
});

function fail(message: string): never {
  console.log(`VERDICT=ERROR ${message}`);
  process.exit(2);
}

if (!values.audio) fail('--audio <file> is required');
const extension = extname(values.audio).slice(1).toLowerCase();
const mimeType = Object.entries(OPENAI_FILE_EXTENSIONS).find(([, known]) => known === extension)?.[0];
if (!mimeType) fail(`unknown audio type .${extension}; use one of ${[...new Set(Object.values(OPENAI_FILE_EXTENSIONS))].join(', ')}`);
const maxUploadBytes = Number(values['max-upload-bytes']);
const overlapMs = Number(values['overlap-ms']);
const audioOriginMs = Number(values['origin-ms']);
if (![maxUploadBytes, overlapMs, audioOriginMs].every((value) => Number.isFinite(value) && value >= 0)) fail('numeric options must be numbers');

interface Reference {
  durationS: number;
  words: Array<{ w: string; s: number; e: number }>;
}
const reference: Reference | null = values.reference ? JSON.parse(readFileSync(values.reference, 'utf8')) : null;
const audio = new Blob([readFileSync(values.audio)], { type: mimeType });
const never = new AbortController().signal;

// Length before the upload: from the reference, or from the WAV header when the file is one.
const knownDurationMs = reference
  ? Math.round(reference.durationS * 1000)
  : extension === 'wav'
    ? (await wavPcmSlicer(audio, never)).durationMs
    : null;
console.log(`audio: ${audio.size} bytes ${mimeType} length=${knownDurationMs ?? 'unknown'}ms audioOriginMs=${audioOriginMs} limit=${maxUploadBytes} bytes`);

const request: BatchTranscriptionRequest = {
  recordingId: 'smoke-1',
  audio,
  audioOriginMs,
  consent: { provider: 'openai', recordingId: 'smoke-1', grantedAtMs: Date.now(), scope: 'narration-audio' },
  language: 'en',
};

let planned = { uploads: 1, uploadedAudioMs: null as number | null };
const rawBodies: unknown[] = [];
const wallStart = Date.now();
const adapter = new OpenAiWhisperAdapter({
  slicer: wavPcmSlicer,
  maxUploadBytes,
  overlapMs,
  // A dry run stops at the first upload: its fetch sends nothing and is not tried again.
  maxAttempts: values.live ? 4 : 1,
  fetch: async (input, init) => {
    if (!values.live) throw new Error('dry run');
    const response = await fetch(input, init);
    if (response.ok && values['save-response']) rawBodies.push(await response.clone().json());
    return response;
  },
  onProgress: (event) => {
    if (event.type === 'plan') planned = { uploads: event.uploads, uploadedAudioMs: event.uploadedAudioMs };
    else if (!values.live) return;
    else if (event.type === 'upload-start') console.log(`upload ${event.index + 1}/${planned.uploads}: attempt ${event.attempt}`);
    else if (event.type === 'retry') console.log(`upload ${event.index + 1}: retry in ${event.delayMs} ms after kind=${event.error.kind} code=${event.error.code}`);
    else console.log(`upload ${event.index + 1}/${planned.uploads}: done at ${Date.now() - wallStart} ms`);
  },
});

if (!values.live) {
  try {
    await adapter.transcribeDetailed(request, { kind: 'api-key', key: 'dry-run-no-key' }, never);
  } catch (cause) {
    if (cause instanceof UploadRefused) fail(`refused before upload (${cause.reason}): ${cause.message}`);
  }
  const lines = describeOpenAiUpload({ durationMs: knownDurationMs, uploadedAudioMs: planned.uploadedAudioMs ?? knownDurationMs, uploads: planned.uploads, retranscription: false });
  console.log(`plan: ${planned.uploads} upload(s), uploaded audio ${planned.uploadedAudioMs ?? knownDurationMs ?? 'unknown'} ms`);
  for (const [name, line] of Object.entries(lines)) console.log(`  ${name}: ${line}`);
  console.log('VERDICT=DRY-RUN nothing sent; add --live with OPENAI_API_KEY set');
  process.exit(0);
}
const key = process.env.OPENAI_API_KEY ?? '';
if (!key) {
  console.log('VERDICT=UNTESTED --live given but OPENAI_API_KEY is not set');
  process.exit(0);
}

let result;
try {
  result = await adapter.transcribeDetailed(request, { kind: 'api-key', key }, never);
} catch (cause) {
  if (cause instanceof TranscriptionFailed) {
    console.log(`error: kind=${cause.error.kind} code=${cause.error.code} retryable=${cause.error.retryable} ${cause.error.message}`);
    console.log('VERDICT=FAIL no transcript');
  } else if (cause instanceof UploadRefused) {
    console.log(`VERDICT=FAIL refused before upload (${cause.reason}): ${cause.message}`);
  } else {
    console.log(`VERDICT=FAIL ${cause instanceof Error ? cause.message.split(key).join('[redacted]') : 'unknown error'}`);
  }
  process.exit(1);
}
if (values['save-response'] && rawBodies.length > 0) {
  writeFileSync(values['save-response'], `${JSON.stringify(result.uploads === 1 ? rawBodies[0] : { uploads: rawBodies }, null, 2)}\n`);
  console.log(`response: saved to ${values['save-response']}`);
}

const { revision } = result;
const words = revision.segments.flatMap((segment) => segment.words);
const issues = validateTranscriptRevision(revision);
console.log(`model: ${revision.model} (${OPENAI_WHISPER_INFO.timing}); wall time ${Date.now() - wallStart} ms`);
console.log(`uploads: ${result.completedUploads}/${result.uploads} done; billed ${result.billedAudioSeconds} s; list-price estimate $${result.estimatedCostUsd.toFixed(4)}`);
console.log(`segments: ${revision.segments.length}, words: ${words.length}, gaps: ${revision.gaps.length}`);
for (const segment of revision.segments) console.log(`  [${segment.startMs}..${segment.endMs} ms] ${segment.text}`);
if (result.error) console.log(`error: kind=${result.error.kind} code=${result.error.code} ${result.error.message}`);
console.log(`contract: ${issues.length === 0 ? 'revision is valid' : issues.join('; ')}`);

const checks: Array<[string, boolean]> = [
  ['words', words.length > 0],
  ['no-error', result.error === undefined && revision.gaps.length === 0],
  ['contract', issues.length === 0],
  ['all-uploads', result.completedUploads === result.uploads],
  ['word-order', words.every((word, index) => index === 0 || word.startMs >= words[index - 1].startMs)],
];
if (words.length > 0) {
  const lastEndMs = Math.max(...words.map((word) => word.endMs));
  console.log(`clock: first word ${words[0].startMs} ms, last word end ${lastEndMs} ms (origin ${audioOriginMs})`);
  checks.push(['on-session-clock', words[0].startMs >= audioOriginMs && (knownDurationMs === null || lastEndMs <= audioOriginMs + knownDurationMs + 1000)]);
}

if (reference && words.length > 0) {
  // Each reference word is paired with the next transcript word of the same text, a few words ahead at most.
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const errors: number[] = [];
  let cursor = 0;
  for (const expected of reference.words) {
    const found = words.slice(cursor, cursor + 6).findIndex((word) => normalize(word.text) === normalize(expected.w));
    if (found === -1) continue;
    errors.push(Math.abs(words[cursor + found].startMs - audioOriginMs - expected.s * 1000));
    cursor += found + 1;
  }
  errors.sort((a, b) => a - b);
  const at = (share: number) => Math.round(errors[Math.min(errors.length - 1, Math.floor(errors.length * share))] ?? Number.NaN);
  const matched = errors.length / reference.words.length;
  console.log(
    `reference: ${errors.length}/${reference.words.length} words matched; ${words.length} words returned; start-time error median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`,
  );
  checks.push(['reference-words', matched >= 0.9 && words.length <= reference.words.length * 1.1]);
  checks.push(['reference-timing', at(0.5) <= 500]);
}

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
console.log(failed.length === 0 ? `VERDICT=PASS ${checks.map(([name]) => name).join(' ')}` : `VERDICT=FAIL ${failed.join(' ')}`);
process.exit(failed.length === 0 ? 0 : 1);
