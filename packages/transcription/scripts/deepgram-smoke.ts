// Deepgram live smoke test (board #16545). Runs the product code path with no
// NarWal server: mintDeepgramCredential() with the user's key (what the service
// worker does; a 30 s JWT from /v1/auth/grant), then a Deepgram live session
// over a plain WebSocket with the bearer subprotocol (what the offscreen
// document does). It streams a WAV at real time.
//
//   node scripts/deepgram-smoke.ts --audio speech.wav            # dry run, sends nothing
//   DEEPGRAM_API_KEY=... node scripts/deepgram-smoke.ts --audio speech.wav --live
//
// The WAV must be 16 kHz mono 16-bit PCM:
//   ffmpeg -i input.m4a -ac 1 -ar 16000 -c:a pcm_s16le speech.wav
// Use non-sensitive speech. The key and token are never printed.
// Not covered here: the chrome-extension:// Origin and the service worker.
// Those are proved by the first in-extension recording.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDeepgramSession, mintDeepgramCredential, type DeepgramAuthMode } from '../src/deepgram/index.ts';
import { DEEPGRAM_DEFAULT_MODEL } from '../src/deepgram/protocol.ts';
import type { LiveSessionSnapshot } from '../src/live-session.ts';

const { values } = parseArgs({
  options: {
    audio: { type: 'string' },
    live: { type: 'boolean', default: false },
    model: { type: 'string', default: DEEPGRAM_DEFAULT_MODEL },
    auth: { type: 'string', default: 'grant' },
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
const auth = values.auth as DeepgramAuthMode;
if (auth !== 'grant' && auth !== 'direct-key') fail('--auth must be grant or direct-key');
const audioOriginMs = Number(values['origin-ms']);
const pcm = readWavPcm(values.audio);
const audioMs = (pcm.byteLength / 2 / 16000) * 1000;
console.log(`audio=${Math.round(audioMs)}ms model=${values.model} auth=${auth} audioOriginMs=${audioOriginMs}`);

if (!values.live) {
  console.log('VERDICT=DRY-RUN nothing sent; add --live with DEEPGRAM_API_KEY set');
  process.exit(0);
}
const key = process.env.DEEPGRAM_API_KEY ?? '';
if (!key) {
  console.log('VERDICT=UNTESTED --live given but DEEPGRAM_API_KEY is not set');
  process.exit(0);
}
if (typeof WebSocket !== 'function') fail('this Node has no global WebSocket (need Node 22+)');

let credentialCalls = 0;
const phases: string[] = [];
const session = createDeepgramSession({
  model: values.model,
  getCredential: async () => {
    credentialCalls += 1;
    const credential = await mintDeepgramCredential({ key, mode: auth, fetch, nowMs: Date.now });
    const ttl = credential.kind === 'temporary-token' ? `${Math.round((credential.expiresAtMs - Date.now()) / 1000)}s token` : 'direct key';
    console.log(`credential #${credentialCalls}: ${ttl}, no server`);
    return credential;
  },
  onUpdate: (snapshot: LiveSessionSnapshot) => {
    const { phase, error } = snapshot.status;
    if (phases.at(-1) !== phase) {
      phases.push(phase);
      console.log(`status: ${phase}${error ? ` (${error.kind}/${error.code}: ${error.message})` : ''}`);
    }
  },
});

// Real-time feed in 20 ms pieces, as the AudioWorklet delivers them.
const pieceBytes = 640;
const streamStart = Date.now();
for (let offset = 0; offset < pcm.byteLength; offset += pieceBytes) {
  const piece = pcm.slice(offset, offset + pieceBytes);
  session.pushAudio({ data: piece.buffer, startMs: audioOriginMs + (offset / 2 / 16000) * 1000 });
  const due = streamStart + ((offset + pieceBytes) / 2 / 16000) * 1000;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
const { revision, service, usage } = await session.finish();

const words = revision.segments.flatMap((segment) => segment.words);
console.log(`segments: ${revision.segments.length} final, ${words.length} words, ${revision.gaps.length} gaps`);
for (const segment of revision.segments) console.log(`  [${segment.startMs}..${segment.endMs} ms] ${segment.text}`);
for (const gap of revision.gaps) console.log(`  gap [${gap.startMs}..${gap.endMs} ms] ${gap.reason}${gap.detail ? ` (${gap.detail})` : ''}`);
if (words.length > 0) {
  console.log(`clock: first word ${words[0].startMs} ms, last word end ${words.at(-1)?.endMs} ms, audio ${Math.round(audioMs)} ms (+ origin ${audioOriginMs})`);
}
console.log(`service: api=${service?.api} requested=${service?.requestedModel} reported=${service?.reportedModel ?? 'none'} version=${service?.modelVersion ?? 'none'} requestIds=${service?.requestIds.length ?? 0} auth=${service?.auth}`);
console.log(`revision: provider=${revision.provider} source=${revision.source} model=${revision.model}`);
console.log(`usage: ${usage ? `${usage.audioSeconds}s ${usage.basis}` : 'none reported'}`);
const ok =
  words.length > 0 &&
  revision.gaps.length === 0 &&
  !phases.includes('reconnecting') &&
  !phases.includes('stopped') &&
  words.every((word) => word.startMs >= audioOriginMs && word.endMs <= audioOriginMs + audioMs + 1000);
console.log(ok ? 'VERDICT=PASS' : `VERDICT=FAIL words=${words.length} gaps=${revision.gaps.length} phases=${phases.join('>')}`);
process.exit(ok ? 0 : 1);
