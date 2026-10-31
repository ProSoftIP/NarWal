// AssemblyAI live smoke test (board #16546). Runs the product code path with no
// NarWal server: mintAssemblyAiToken() with the user's key (what the service
// worker does), then AssemblyAiLiveAdapter over a plain WebSocket with only
// `?token=` (what the offscreen document does). It streams a WAV at real time.
//
//   node scripts/assemblyai-smoke.ts --audio speech.wav            # dry run, sends nothing
//   ASSEMBLYAI_API_KEY=... node scripts/assemblyai-smoke.ts --audio speech.wav --live
//
// The WAV must be 16 kHz mono 16-bit PCM:
//   ffmpeg -i input.m4a -ac 1 -ar 16000 -c:a pcm_s16le speech.wav
// Use non-sensitive scripted speech. The key and token are never printed.
// Not covered here: the chrome-extension:// Origin and the service worker's
// CORS exemption. Those are proved by the first in-extension recording.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AdapterEvent, TranscriptSegment } from '../src/contract.ts';
import {
  ASSEMBLYAI_DEFAULT_MODEL,
  ASSEMBLYAI_ENGLISH_MODELS,
  AssemblyAiConnectError,
  AssemblyAiLiveAdapter,
  type AssemblyAiEnglishModel,
  mintAssemblyAiToken,
} from '../src/assemblyai/index.ts';

const { values } = parseArgs({
  options: {
    audio: { type: 'string' },
    live: { type: 'boolean', default: false },
    model: { type: 'string', default: ASSEMBLYAI_DEFAULT_MODEL },
    'origin-ms': { type: 'string', default: '0' },
  },
});

function fail(message: string): never {
  console.log(`VERDICT=ERROR ${message}`);
  process.exit(2);
}

/** Returns the PCM payload of a 16 kHz mono s16le WAV. */
function readWavPcm(path: string): Uint8Array {
  const file = readFileSync(path);
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') fail('not a RIFF/WAVE file');
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; codec: number } | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { codec: file.readUInt16LE(body), channels: file.readUInt16LE(body + 2), sampleRate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
        fail(`WAV must be 16 kHz mono 16-bit PCM; got ${JSON.stringify(format)}`);
      }
      return new Uint8Array(file.buffer, file.byteOffset + body, Math.min(size, file.length - body));
    }
    offset = body + size + (size % 2);
  }
  fail('WAV has no data chunk');
}

if (!values.audio) fail('--audio <16 kHz mono WAV> is required');
const model = values.model as AssemblyAiEnglishModel;
if (!(ASSEMBLYAI_ENGLISH_MODELS as readonly string[]).includes(model)) fail(`--model must be one of ${ASSEMBLYAI_ENGLISH_MODELS.join(', ')}`);
const audioOriginMs = Number(values['origin-ms']);
const pcm = readWavPcm(values.audio);
const audioMs = (pcm.byteLength / 2 / 16000) * 1000;
console.log(`audio=${Math.round(audioMs)}ms model=${model} audioOriginMs=${audioOriginMs}`);

if (!values.live) {
  console.log('VERDICT=DRY-RUN nothing sent; add --live with ASSEMBLYAI_API_KEY set');
  process.exit(0);
}
const key = process.env.ASSEMBLYAI_API_KEY ?? '';
if (!key) {
  console.log('VERDICT=UNTESTED --live given but ASSEMBLYAI_API_KEY is not set');
  process.exit(0);
}
if (typeof WebSocket !== 'function') fail('this Node has no global WebSocket (need Node 22+)');

const minted = await mintAssemblyAiToken(fetch, key, { expiresInSeconds: 60, maxSessionDurationSeconds: 600 });
if (!minted.ok) {
  console.log(`token: FAILED kind=${minted.error.kind} code=${minted.error.code} message=${minted.error.message}`);
  console.log('VERDICT=FAIL token mint');
  process.exit(1);
}
console.log(`token: minted with the user key, no server; expires in ${Math.round((minted.credential.expiresAtMs - Date.now()) / 1000)}s`);

const events: AdapterEvent[] = [];
const firstSeenMs = new Map<string, number>();
const wallStart = Date.now();
const adapter = new AssemblyAiLiveAdapter({ speechModel: model });
try {
  await adapter.start({ credential: minted.credential, language: 'en', audioOriginMs, connectionId: 'smoke-1' }, (event) => {
    events.push(event);
    if (event.type === 'segment' && !firstSeenMs.has(event.segment.segmentKey)) firstSeenMs.set(event.segment.segmentKey, Date.now() - wallStart);
    if (event.type === 'error') console.log(`error: kind=${event.error.kind} code=${event.error.code} retryable=${event.error.retryable} ${event.error.message}`);
  });
} catch (cause) {
  const error = cause instanceof AssemblyAiConnectError ? cause.error : null;
  console.log(`socket: FAILED ${error ? `kind=${error.kind} code=${error.code} ${error.message}` : String(cause)}`);
  console.log('VERDICT=FAIL socket');
  process.exit(1);
}
console.log(`socket: Begin received (token query auth); model reported by AssemblyAI: ${adapter.reportedModel}`);

// Real-time feed in 20 ms pieces, as the AudioWorklet delivers them; the adapter reframes.
const pieceBytes = 640;
const streamStart = Date.now();
for (let offset = 0; offset < pcm.byteLength; offset += pieceBytes) {
  adapter.sendAudio(pcm.slice(offset, offset + pieceBytes).buffer);
  const due = streamStart + ((offset + pieceBytes) / 2 / 16000) * 1000;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
await adapter.finish();

const segments = events.flatMap((event) => (event.type === 'segment' ? [event.segment] : []));
const byKey = new Map<string, TranscriptSegment>();
for (const segment of segments) byKey.set(segment.segmentKey, segment);
const finals = [...byKey.values()].filter((segment) => segment.kind === 'final');
const words = finals.flatMap((segment) => segment.words);
const errors = events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
const usage = events.find((event) => event.type === 'usage');
console.log(`segments: ${segments.filter((s) => s.kind === 'interim').length} interim, ${finals.length} final, ${words.length} final words`);
for (const segment of finals) {
  console.log(`  [${segment.startMs}..${segment.endMs} ms] ${segment.text}  (first seen ${firstSeenMs.get(segment.segmentKey)} ms after start)`);
}
if (words.length > 0) {
  console.log(`clock: first word ${words[0].startMs} ms, last word end ${words.at(-1)?.endMs} ms, audio ${Math.round(audioMs)} ms (+ origin ${audioOriginMs})`);
}
console.log(`usage: ${usage && usage.type === 'usage' ? `${usage.audioSeconds}s ${usage.basis}` : 'none reported'}`);
const ok = words.length > 0 && errors.length === 0 && words.every((word) => word.startMs >= audioOriginMs && word.endMs <= audioOriginMs + audioMs + 1000);
console.log(ok ? 'VERDICT=PASS' : `VERDICT=FAIL errors=${errors.length} words=${words.length}`);
process.exit(ok ? 0 : 1);
