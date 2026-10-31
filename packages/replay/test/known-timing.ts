// A bundle whose every timing is known, for seek and sync tests (unit and
// browser). The page shows `tick N` where N = floor(session seconds), set
// exactly on each whole second, so the text at any replay time proves the page
// is within PAGE_TOLERANCE_MS of it. Timeline (session ms):
//
//   0 ─ d1 /first ─ 12000 │ 12000–12060 navigation-blind-window │ d2 /second ─ 30000
//   20000–21000 recorder-paused (page and audio gaps; the audio file skips it)
//   24000–25500 mic-track-ended (the audio file skips it)
//
// Narration: fixtures/known-timing.webm, 880 Hz beeps on each media second.
// Its clock pairs carry the −270 ppm drift and ±25 ms jitter measured in #16538.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CREATED = '2026-10-13T20:00:00.000Z';
export const ORIGIN = Date.parse(CREATED);
export const DURATION_MS = 30000;
export const NAVIGATION_MS = 12000;
export const D2_SNAPSHOT_MS = 12060;
export const PAUSE = { startMs: 20000, endMs: 21000 };
export const MIC_LOSS = { startMs: 24000, endMs: 25500 };
export const AUDIO_START_MS = 100;
export const DRIFT = 270e-6;
const JITTER = [12, -18, 7, -25, 20, -9, 3, 16, -22, 0, 25, -14];
/** Session time the audio file has no audio for. */
const LOSSES = [PAUSE, MIC_LOSS];
export const DECODED_MS = Math.round((DURATION_MS - AUDIO_START_MS - LOSSES.reduce((sum, l) => sum + l.endMs - l.startMs, 0)) / (1 + DRIFT));
export const SITE = 'https://known-timing.example.test';
export const AUDIO_PATH = 'audio/narration.webm';

export const AUDIO_FIXTURE = new URL('../fixtures/known-timing.webm', import.meta.url);

/** The session time a media time was spoken (no jitter): the truth the fit must recover. */
export function trueSessionMs(mediaMs: number): number {
  let at = AUDIO_START_MS + mediaMs * (1 + DRIFT);
  for (const loss of LOSSES) if (at >= loss.startMs) at += loss.endMs - loss.startMs;
  return at;
}

/** Text of `#tick` at a session time where a page is shown. */
export function expectedTick(t: number): string {
  return `tick ${Math.floor(t / 1000)}`;
}

type Obj = Record<string, any>;
const enc = new TextEncoder();
const json = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const jsonl = (lines: unknown[]): Uint8Array => enc.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const MEDIA: Record<string, string> = { '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.webm': 'audio/webm' };

/** Adds manifest.json, listing every file with its size and hash. */
export function withManifest(manifest: Obj, files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const listed = [...files.keys()].sort().map((path) => {
    const bytes = files.get(path)!;
    return { path, bytes: bytes.length, sha256: sha256(bytes), mediaType: MEDIA[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' };
  });
  return new Map([['manifest.json', json({ ...manifest, files: listed })], ...files]);
}

export function manifest(extra: Obj = {}): Obj {
  return {
    format: 'narwal.bundle',
    schemaVersion: '1.0',
    recordingId: 'rec_known_timing',
    title: 'Known timing',
    createdAt: CREATED,
    producer: { name: 'narwal-replay-test', version: '1.0.0' },
    environment: { browser: 'Chrome', browserVersion: '155.0.7600.0', platform: 'linux' },
    clock: { originEpochMs: ORIGIN },
    durationMs: DURATION_MS,
    state: 'complete',
    privacy: { inputValues: 'masked', excludedRegions: 0, urlPolicy: 'redact-query-values', audio: 'not-redacted' },
    derivation: { pointerDwellMinMs: 300 },
    audio: { file: AUDIO_PATH, mediaType: 'audio/webm;codecs=opus', clock: 'audio/clock.jsonl', startMs: AUDIO_START_MS, decodedMs: DECODED_MS },
    transcript: { activeRevision: 'r1' },
    ...extra,
  };
}

export function documentRecord(key: string, path: string, title: string, attachedMs: number, detachedMs: number | null, extra: Obj = {}): Obj {
  return {
    key,
    browserDocumentId: `KNOWN-${key.toUpperCase()}`,
    frameId: 0,
    parentKey: null,
    frameNode: null,
    url: `${SITE}${path}`,
    title,
    navigationType: 'navigate',
    transition: 'link',
    attachedMs,
    detachedMs,
    attachments: [{ atMs: attachedMs, reason: 'boot' }],
    capture: 'full',
    rrweb: `rrweb/${key}.jsonl`,
    ...extra,
  };
}

/** rrweb stream writer: one envelope per event, seq from 0. */
export function rrwebStream(): { line(atMs: number, event: Obj): void; lines: Obj[] } {
  const lines: Obj[] = [];
  return {
    lines,
    line(atMs, event) {
      lines.push({ seq: lines.length, sentMs: atMs, receivedMs: atMs + 1, event: { ...event, timestamp: ORIGIN + atMs } });
    },
  };
}

const TEXT_ID = 9;

/** A full snapshot of a page with `#doc` and `#tick`, then `body` children as given. */
export function snapshot(docName: string, tick: string, body: Obj[] = [], head: Obj[] = []): Obj {
  return {
    type: 2,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
          {
            type: 2,
            id: 3,
            tagName: 'html',
            attributes: {},
            childNodes: [
              { type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: head },
              {
                type: 2,
                id: 5,
                tagName: 'body',
                attributes: { style: 'margin:0;font:32px sans-serif;background:#fff' },
                childNodes: [
                  { type: 2, id: 6, tagName: 'p', attributes: { id: 'doc' }, childNodes: [{ type: 3, id: 7, textContent: docName }] },
                  { type: 2, id: 8, tagName: 'p', attributes: { id: 'tick' }, childNodes: [{ type: 3, id: TEXT_ID, textContent: tick }] },
                  ...body,
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { left: 0, top: 0 },
    },
  };
}

const tickMutation = (n: number): Obj => ({ type: 3, data: { source: 0, texts: [{ id: TEXT_ID, value: `tick ${n}` }], attributes: [], removes: [], adds: [] } });
const meta = (path: string): Obj => ({ type: 4, data: { href: `${SITE}${path}`, width: 800, height: 600 } });

function d1Stream(): Obj[] {
  const s = rrwebStream();
  s.line(5, meta('/first'));
  s.line(10, snapshot('first page', 'tick 0'));
  for (let n = 1; n < NAVIGATION_MS / 1000; n++) s.line(n * 1000, tickMutation(n));
  return s.lines;
}

function d2Stream(): Obj[] {
  const s = rrwebStream();
  s.line(D2_SNAPSHOT_MS - 2, meta('/second'));
  s.line(D2_SNAPSHOT_MS, snapshot('second page', expectedTick(D2_SNAPSHOT_MS)));
  for (let n = Math.ceil(D2_SNAPSHOT_MS / 1000); n < DURATION_MS / 1000; n++) {
    if (n * 1000 >= PAUSE.startMs && n * 1000 < PAUSE.endMs) continue; // paused: nothing recorded
    s.line(n * 1000, tickMutation(n));
  }
  return s.lines;
}

/** Clock pairs every media second: drift, jitter, and a jump where the microphone was lost. */
export function clockPairs(): Obj[] {
  const pairs: Obj[] = [];
  for (let k = 1; k * 1000 <= DECODED_MS; k++) {
    pairs.push({ frames: k * 48000, sampleRate: 48000, atMs: Math.round((trueSessionMs(k * 1000) + JITTER[k % JITTER.length]!) * 10) / 10 });
  }
  return pairs;
}

export const box = (x: number, y: number, w: number, h: number): Obj => ({ x, y, w, h });
const tickRef = { node: 8, tag: 'p', role: 'paragraph', name: 'tick', nameSource: 'text', box: box(0, 70, 800, 40) };
const docRef = { node: 6, tag: 'p', role: 'paragraph', name: 'first page', nameSource: 'text', box: box(0, 20, 800, 40) };
const top = { x: 0, y: 0 };

export const UTTERANCES = [
  { id: 's1', startMs: 2000, endMs: 3500, text: 'the first page starts here' },
  { id: 's2', startMs: 14000, endMs: 16000, text: 'the second page after the navigation' },
  { id: 's3', startMs: 26000, endMs: 27000, text: 'the microphone came back' },
];

export function wordsOf(startMs: number, endMs: number, text: string): Obj[] {
  const words = text.split(' ');
  const step = (endMs - startMs) / words.length;
  return words.map((w, i) => ({ text: w, startMs: startMs + i * step, endMs: startMs + (i + 1) * step, confidence: 0.9 }));
}

export function knownRevision(): Obj {
  return {
    revisionId: 'r1',
    source: 'after-recording',
    provider: 'openai',
    model: 'whisper-1',
    language: 'en',
    createdAt: '2026-10-13T20:01:00.000Z',
    segments: UTTERANCES.map((u) => ({ id: u.id, startMs: u.startMs, endMs: u.endMs, text: u.text, words: wordsOf(u.startMs, u.endMs, u.text) })),
    gaps: [{ startMs: MIC_LOSS.startMs, endMs: MIC_LOSS.endMs, reason: 'not-transcribed', detail: 'no audio' }],
  };
}

export interface KnownTimingOptions {
  /** Replaces the transcript revisions (file name `transcript/<revisionId>.json`). */
  revisions?: Obj[];
  activeRevision?: string | null;
  /** Leave out the narration and its clock. */
  noAudio?: boolean;
  /** Extra page markup added to the first snapshot of d1 (body, head). */
  body?: Obj[];
  head?: Obj[];
}

/** The bundle as a file map (paths to bytes), ready for validateBundle or packBundle. */
export function knownTimingFiles(options: KnownTimingOptions = {}): Map<string, Uint8Array> {
  const revisions = options.revisions ?? [knownRevision()];
  const files = new Map<string, Uint8Array>();
  files.set(
    'documents.json',
    json({
      documents: [
        documentRecord('d1', '/first', 'First', 0, NAVIGATION_MS, { transition: 'typed' }),
        documentRecord('d2', '/second', 'Second', NAVIGATION_MS, null),
      ],
    }),
  );
  files.set(
    'observations.jsonl',
    jsonl([
      { id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' },
      { id: 'o2', kind: 'viewport', basis: 'observed', atMs: 0, w: 800, h: 600, dpr: 1 },
      { id: 'o3', kind: 'route', basis: 'observed', atMs: 0, doc: 'd1', url: `${SITE}/first`, title: 'First', transition: 'typed' },
      { id: 'o4', kind: 'click', basis: 'observed', atMs: 5000, doc: 'd1', target: tickRef, button: 'left', count: 1, point: { x: 400, y: 90 }, scroll: top },
      { id: 'o5', kind: 'marker-element', basis: 'user-marked', atMs: 8000, doc: 'd1', target: docRef, via: 'right-click', point: { x: 100, y: 40 }, scroll: top },
      { id: 'o6', kind: 'pointer-dwell', basis: 'derived', atMs: 9000, endMs: 10500, doc: 'd1', target: tickRef, scroll: top },
      { id: 'o7', kind: 'route', basis: 'observed', atMs: NAVIGATION_MS, doc: 'd2', url: `${SITE}/second`, title: 'Second', transition: 'link' },
      { id: 'o8', kind: 'marker-region', basis: 'user-marked', atMs: 15000, endMs: 15800, doc: 'd2', rect: box(50, 50, 300, 200), scroll: top, contains: [] },
      { id: 'o9', kind: 'recording', basis: 'observed', atMs: PAUSE.startMs, state: 'paused' },
      { id: 'o10', kind: 'recording', basis: 'observed', atMs: PAUSE.endMs, state: 'resumed' },
      { id: 'o11', kind: 'recording', basis: 'observed', atMs: DURATION_MS, state: 'stopped' },
    ]),
  );
  files.set(
    'gaps.jsonl',
    jsonl([
      { id: 'g1', scope: 'page', startMs: NAVIGATION_MS, endMs: D2_SNAPSHOT_MS, reason: 'navigation-blind-window', doc: 'd2' },
      { id: 'g2', scope: 'page', startMs: PAUSE.startMs, endMs: PAUSE.endMs, reason: 'recorder-paused', doc: 'd2' },
      { id: 'g3', scope: 'audio', startMs: PAUSE.startMs, endMs: PAUSE.endMs, reason: 'recorder-paused' },
      { id: 'g4', scope: 'audio', startMs: MIC_LOSS.startMs, endMs: MIC_LOSS.endMs, reason: 'mic-track-ended', detail: 'device unplugged' },
    ]),
  );
  files.set(
    'edits.jsonl',
    jsonl([
      ...(revisions.some((r) => r.revisionId === 'r1' && r.segments.some((s: Obj) => s.id === 's2' && s.text.split(' ').length > 1))
        ? [{ id: 'c1', type: 'correction', revisionId: 'r1', segmentId: 's2', wordStart: 1, wordEnd: 2, text: 'next', createdAt: '2026-10-13T20:02:00.000Z' }]
        : []),
      { id: 'n1', type: 'note', atMs: 8000, endMs: 9000, text: 'the marked heading', createdAt: '2026-10-13T20:02:30.000Z' },
    ]),
  );
  for (const r of revisions) files.set(`transcript/${r.revisionId}.json`, json(r));
  const s1 = d1Stream();
  if (options.body || options.head) s1[1]!.event = { ...snapshot('first page', 'tick 0', options.body, options.head), timestamp: s1[1]!.event.timestamp };
  files.set('rrweb/d1.jsonl', jsonl(s1));
  files.set('rrweb/d2.jsonl', jsonl(d2Stream()));
  if (!options.noAudio) {
    files.set(AUDIO_PATH, new Uint8Array(readFileSync(AUDIO_FIXTURE)));
    files.set('audio/clock.jsonl', jsonl(clockPairs()));
  }
  const activeRevision = options.activeRevision === undefined ? (revisions[0]?.revisionId ?? null) : options.activeRevision;
  return withManifest(manifest({ transcript: { activeRevision }, ...(options.noAudio ? { audio: null } : {}) }), files);
}
