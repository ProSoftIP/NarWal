// Optional live probe for the direct auth paths (board #16540).
// Uses only fetch and a header-less WebSocket, the same limits browser code has.
// Default is a dry run that sends nothing. A live run needs --live, the
// provider key in the environment, and a non-sensitive 16-bit mono PCM WAV.
//
//   node probe/live-probe.ts --provider deepgram|assemblyai|openai --audio speech.wav [--live]
//        [--deepgram-auth grant|key] [--consent-upload]
//
// Keys come from DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY or OPENAI_API_KEY and are never printed.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import type { AdapterEvent, LiveCredential, TranscriptSegment } from '../src/contract.ts';
import {
  DeepgramControl,
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
import { buildOpenAiTranscriptionForm, classifyOpenAiHttpError, normalizeOpenAiVerboseJson, OPENAI_TRANSCRIPTIONS_URL } from '../src/openai.ts';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    audio: { type: 'string' },
    live: { type: 'boolean', default: false },
    'deepgram-auth': { type: 'string', default: 'grant' },
    'consent-upload': { type: 'boolean', default: false },
  },
});

const ENV_KEYS = { deepgram: 'DEEPGRAM_API_KEY', assemblyai: 'ASSEMBLYAI_API_KEY', openai: 'OPENAI_API_KEY' } as const;
type Provider = keyof typeof ENV_KEYS;

function finish(verdict: string, detail: Record<string, unknown>, exitCode: number): never {
  console.log(JSON.stringify({ ...detail, verdict }, null, 2));
  console.log(`VERDICT=${verdict}`);
  process.exit(exitCode);
}

function readPcmWav(path: string) {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error('need 16-bit mono PCM WAV');
      return { sampleRate, pcm: bytes.subarray(offset + 8, offset + 8 + size), file: bytes };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

const provider = values.provider as Provider;
if (!(provider in ENV_KEYS) || !values.audio) {
  finish('USAGE', { usage: 'node probe/live-probe.ts --provider deepgram|assemblyai|openai --audio speech.wav [--live]' }, 64);
}
const wav = readPcmWav(values.audio);
const audioSeconds = wav.pcm.length / 2 / wav.sampleRate;
const key = process.env[ENV_KEYS[provider]];

if (!values.live) {
  finish('DRY-RUN', { provider, audioSeconds, keyPresent: Boolean(key), note: 'nothing sent; add --live to call the provider' }, 0);
}
if (!key) finish('UNTESTED', { provider, reason: `${ENV_KEYS[provider]} is not set` }, 3);

const finals = (events: AdapterEvent[]) => {
  const byKey = new Map<string, TranscriptSegment>();
  for (const event of events) if (event.type === 'segment') byKey.set(event.segment.segmentKey, event.segment);
  return [...byKey.values()].filter((segment) => segment.kind === 'final');
};

function summarize(events: AdapterEvent[], auth: string, startedAt: number) {
  const segments = finals(events);
  const words = segments.flatMap((segment) => segment.words);
  return {
    provider,
    auth,
    audioSeconds,
    wallSeconds: (Date.now() - startedAt) / 1000,
    finalSegments: segments.length,
    words: words.length,
    firstWord: words[0] ?? null,
    lastWord: words.at(-1) ?? null,
    usage: events.filter((event) => event.type === 'usage'),
    errors: events.filter((event) => event.type === 'error'),
  };
}

/** Sends PCM at real time in fixed chunks. */
async function streamPcm(socket: WebSocket, chunkBytes: number, sampleRate: number) {
  const chunkMs = (chunkBytes / 2 / sampleRate) * 1000;
  for (let offset = 0; offset < wav.pcm.length; offset += chunkBytes) {
    socket.send(wav.pcm.subarray(offset, offset + chunkBytes));
    await new Promise((resolve) => setTimeout(resolve, chunkMs));
  }
}

function openSocket(url: string, protocols: string[] | undefined, onMessage: (message: Record<string, unknown>) => void) {
  return new Promise<{ socket: WebSocket; closed: Promise<{ code: number; reason: string }> }>((resolve, reject) => {
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      socket.addEventListener('close', (event) => done({ code: event.code, reason: event.reason }));
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') onMessage(JSON.parse(event.data));
    });
    socket.addEventListener('open', () => resolve({ socket, closed }), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket failed to open')), { once: true });
  });
}

const startedAt = Date.now();
const events: AdapterEvent[] = [];

if (provider === 'deepgram') {
  let credential: LiveCredential = { kind: 'api-key', key };
  if (values['deepgram-auth'] === 'grant') {
    const grant = buildDeepgramGrantRequest(key, 30);
    const response = await fetch(grant.url, grant.init);
    if (!response.ok) finish('FAIL', { provider, step: 'grant', error: classifyDeepgramHttp(response.status) }, 1);
    credential = parseDeepgramGrantResponse(await response.json(), Date.now());
  }
  const normalizer = new DeepgramNormalizer(0, 'probe-1');
  const { socket, closed } = await openSocket(
    buildDeepgramListenUrl({ pcmSampleRate: wav.sampleRate }),
    deepgramSubprotocols(credential),
    (message) => events.push(...normalizer.handle(message)),
  );
  await streamPcm(socket, Math.round(wav.sampleRate / 10) * 2, wav.sampleRate);
  socket.send(DeepgramControl.finalize);
  socket.send(DeepgramControl.closeStream);
  const close = await closed;
  if (close.code !== 1000) events.push({ type: 'error', error: classifyDeepgramClose(close.code, close.reason) });
  const summary = summarize(events, credential.kind === 'temporary-token' ? 'grant-jwt-bearer-subprotocol' : 'api-key-token-subprotocol', startedAt);
  finish(summary.words > 0 ? 'PASS' : 'FAIL', summary, summary.words > 0 ? 0 : 1);
}

if (provider === 'assemblyai') {
  const request = buildAssemblyAiTokenRequest(key, { expiresInSeconds: 60, maxSessionDurationSeconds: 600 });
  const response = await fetch(request.url, request.init);
  if (!response.ok) finish('FAIL', { provider, step: 'token', status: response.status }, 1);
  const credential = parseAssemblyAiTokenResponse(await response.json(), Date.now());
  const normalizer = new AssemblyAiNormalizer(0, 'probe-1', { formatTurns: true });
  const { socket, closed } = await openSocket(
    buildAssemblyAiStreamUrl(credential, { sampleRate: wav.sampleRate, formatTurns: true }),
    undefined,
    (message) => events.push(...normalizer.handle(message)),
  );
  await streamPcm(socket, assemblyAiChunkBytes(100, wav.sampleRate), wav.sampleRate);
  socket.send(JSON.stringify({ type: 'Terminate' }));
  const close = await closed;
  if (close.code !== 1000) events.push({ type: 'error', error: classifyAssemblyAiError(close.code, close.reason) });
  const summary = summarize(events, 'temporary-token-query', startedAt);
  finish(summary.words > 0 ? 'PASS' : 'FAIL', summary, summary.words > 0 ? 0 : 1);
}

if (provider === 'openai') {
  if (!values['consent-upload']) finish('REFUSED', { provider, reason: 'upload needs --consent-upload' }, 2);
  const recordingId = 'probe-recording';
  const form = buildOpenAiTranscriptionForm({
    recordingId,
    audio: new Blob([wav.file], { type: 'audio/wav' }),
    audioOriginMs: 0,
    language: 'en',
    consent: { provider: 'openai', recordingId, grantedAtMs: Date.now(), scope: 'narration-audio' },
  });
  const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const body = await response.json();
  if (!response.ok) finish('FAIL', { provider, error: classifyOpenAiHttpError(response.status, body, response.headers.get('retry-after')) }, 1);
  const revision = normalizeOpenAiVerboseJson(body, { audioOriginMs: 0, revisionId: 'probe-rev', createdAtMs: Date.now() });
  events.push(...revision.segments.map((segment) => ({ type: 'segment' as const, segment })));
  if (body.usage) events.push({ type: 'usage', provider: 'openai', audioSeconds: Number(body.usage.seconds ?? 0), basis: String(body.usage.type) });
  const summary = summarize(events, 'api-key-bearer-header', startedAt);
  finish(summary.words > 0 ? 'PASS' : 'FAIL', summary, summary.words > 0 ? 0 : 1);
}
