// Builds the committed fixture bundles under fixtures/ and fixtures/expected.json.
//   node scripts/build-fixtures.ts           rewrite fixtures/good and fixtures/bad
//   node scripts/build-fixtures.ts --check   rebuild in a temp dir; exit 1 if anything differs
// Good bundles must validate before they are written. The silent narration audio is made once
// with ffmpeg (bit-exact flags) and reused, so the build needs no ffmpeg after the first run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { README_PATHS, buildAgentView, renderMarkdown, renderReadme, stableJson } from '../src/agent-view.ts';
import { memorySource } from '../src/memory-source.ts';
import { validateBundle } from '../src/validate.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const AUDIO_PATH = 'audio/narration.webm';
const AUDIO_FIXTURE = join(ROOT, 'good', 'dashboard-walkthrough', AUDIO_PATH);

type Obj = Record<string, any>;

/** A bundle as records; serialized by pack(). */
interface Spec {
  manifest: Obj;
  documents: Obj[];
  /** Schema 1.1: the windows of a recording that followed more than one. */
  windows?: Obj[];
  observations: Obj[];
  gaps: Obj[];
  edits: Obj[] | null;
  revisions: Obj[];
  rrweb: Record<string, Obj[]>;
  audio: Uint8Array | null;
  clock: Obj[] | null;
}

interface Expect {
  ok: boolean;
  errors: string[];
  warnings: string[];
  why: string;
}

interface Fixture {
  name: string;
  files: Map<string, Uint8Array>;
  expect: Expect;
}

const enc = new TextEncoder();
const json = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const jsonl = (lines: unknown[]): Uint8Array => enc.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const MEDIA: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.webm': 'audio/webm',
};

function mediaType(path: string): string {
  return MEDIA[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
}

function withManifest(manifest: Obj, files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const listed = [...files.keys()].sort().map((path) => {
    const bytes = files.get(path)!;
    return { path, bytes: bytes.length, sha256: sha256(bytes), mediaType: mediaType(path) };
  });
  return new Map([['manifest.json', json({ ...manifest, files: listed })], ...files]);
}

/** Serializes a spec; with `agent`, validates it and adds the derived agent exports. */
async function pack(spec: Spec, agent: boolean): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  files.set('documents.json', json(spec.windows ? { documents: spec.documents, windows: spec.windows } : { documents: spec.documents }));
  files.set('observations.jsonl', jsonl(spec.observations));
  files.set('gaps.jsonl', jsonl(spec.gaps));
  if (spec.edits) files.set('edits.jsonl', jsonl(spec.edits));
  for (const r of spec.revisions) files.set(`transcript/${r.revisionId}.json`, json(r));
  for (const [path, lines] of Object.entries(spec.rrweb)) files.set(path, jsonl(lines));
  if (spec.audio) files.set(AUDIO_PATH, spec.audio);
  if (spec.clock) files.set('audio/clock.jsonl', jsonl(spec.clock));
  if (!agent) return withManifest(spec.manifest, files);

  const result = await validateBundle(memorySource(withManifest(spec.manifest, files)));
  if (!result.bundle) throw new Error(`fixture does not validate: ${JSON.stringify(result.errors, null, 2)}`);
  const view = buildAgentView(result.bundle);
  files.set('agent/walkthrough.md', enc.encode(renderMarkdown(view)));
  files.set('agent/walkthrough.json', enc.encode(stableJson(view)));
  for (const path of README_PATHS) files.set(path, enc.encode(renderReadme(view)));
  return withManifest(spec.manifest, files);
}

// ---------- shared records ----------

const CREATED = '2026-10-13T20:00:00.000Z';
const ORIGIN = Date.parse(CREATED) + 0.25;
const SITE = 'https://app.example.test';

function el(node: number, tag: string, role: string | null, name: string, nameSource = 'text', box?: Obj): Obj {
  const ref: Obj = { node, tag, role, name, nameSource };
  if (box) ref.box = box;
  return ref;
}

function manifest(recordingId: string, title: string, durationMs: number, audio: Obj | null, activeRevision: string | null, excludedRegions: number): Obj {
  return {
    format: 'narwal.bundle',
    schemaVersion: '1.0',
    recordingId,
    title,
    createdAt: CREATED,
    producer: { name: 'narwal-fixture-builder', version: '1.0.0' },
    environment: { browser: 'Chrome', browserVersion: '155.0.7600.0', platform: 'linux' },
    clock: { originEpochMs: ORIGIN },
    durationMs,
    state: 'complete',
    privacy: { inputValues: 'masked', excludedRegions, urlPolicy: 'redact-query-values', audio: 'not-redacted' },
    derivation: { pointerDwellMinMs: 300 },
    audio,
    transcript: { activeRevision },
  };
}

function document(key: string, url: string, title: string, attachedMs: number, detachedMs: number | null, extra: Obj = {}): Obj {
  return {
    key,
    browserDocumentId: `FIXTURE-DOC-${key.toUpperCase()}`,
    frameId: 0,
    parentKey: null,
    frameNode: null,
    url,
    title,
    navigationType: 'navigate',
    transition: 'typed',
    attachedMs,
    detachedMs,
    attachments: [{ atMs: attachedMs, reason: 'boot' }],
    capture: 'full',
    rrweb: `rrweb/${key}.jsonl`,
    ...extra,
  };
}

function rrwebLine(seq: number, atMs: number, event: Obj): Obj {
  return { seq, sentMs: atMs, receivedMs: Math.round((atMs + 0.6) * 10) / 10, event: { ...event, timestamp: Math.round(ORIGIN + atMs) } };
}

function snapshotStart(href: string, atMs: number): Obj[] {
  return [
    rrwebLine(0, atMs, { type: 4, data: { href, width: 1280, height: 800 } }),
    rrwebLine(1, atMs + 2, {
      type: 2,
      data: {
        node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [] }] },
        initialOffset: { left: 0, top: 0 },
      },
    }),
  ];
}

/** A segment with evenly spaced word times. */
function segment(id: string, startMs: number, endMs: number, text: string): Obj {
  const words = text.split(' ');
  const step = (endMs - startMs) / words.length;
  return {
    id,
    startMs,
    endMs,
    text,
    words: words.map((w, i) => ({
      text: w,
      startMs: Math.round((startMs + i * step) * 10) / 10,
      endMs: Math.round((startMs + (i + 1) * step) * 10) / 10,
      confidence: 0.9,
    })),
  };
}

// ---------- good: minimal ----------

function minimal(): Spec {
  const signIn = el(14, 'a', 'link', 'Sign in', 'text', { x: 1100, y: 16, w: 80, h: 32 });
  return {
    manifest: manifest('rec_fixture_minimal', 'Sign-in link check', 5000, null, null, 0),
    documents: [document('d1', `${SITE}/`, 'Home', 0, null)],
    observations: [
      { id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' },
      { id: 'o2', kind: 'route', basis: 'observed', atMs: 0, doc: 'd1', url: `${SITE}/`, title: 'Home', transition: 'typed' },
      { id: 'o3', kind: 'click', basis: 'observed', atMs: 2000, doc: 'd1', target: signIn, button: 'left', count: 1, point: { x: 1130, y: 30 }, scroll: { x: 0, y: 0 } },
      { id: 'o4', kind: 'recording', basis: 'observed', atMs: 5000, state: 'stopped' },
    ],
    gaps: [{ id: 'g1', scope: 'audio', startMs: 0, endMs: 5000, reason: 'mic-denied', detail: 'microphone permission denied' }],
    edits: null,
    revisions: [],
    rrweb: { 'rrweb/d1.jsonl': snapshotStart(`${SITE}/`, 5) },
    audio: null,
    clock: null,
  };
}

// ---------- good: two windows (schema 1.1, board #16754) ----------

// The companies page opens a vendor sign-in popup; the person marks the
// button there, switches back, then back to the popup, which closes.
function twoWindows(): Spec {
  const VENDOR = 'https://login.vendor.example.test';
  const connect = el(31, 'button', 'button', 'Connect bank', 'text', { x: 900, y: 120, w: 140, h: 36 });
  const allow = el(22, 'button', 'button', 'Allow access', 'text', { x: 180, y: 420, w: 160, h: 40 });
  const user = el(12, 'input', 'textbox', 'Email', 'label', { x: 40, y: 200, w: 400, h: 32 });
  const popupUrl = `${VENDOR}/authorize?client_id=_&state=_`;
  const m = manifest('rec_fixture_two_windows', 'Companies page bank connection', 30000, null, null, 0);
  m.schemaVersion = '1.1';
  return {
    manifest: m,
    windows: [
      { key: 'w1', opener: null, type: 'tab', openedMs: 0, closedMs: null },
      { key: 'w2', opener: 'w1', type: 'popup', openedMs: 8000, closedMs: 20000 },
    ],
    documents: [
      document('d1', `${SITE}/companies`, 'Companies', 0, null, { window: 'w1' }),
      document('d2', popupUrl, 'Sign in to Vendor', 8000.5, 20000, { window: 'w2', transition: 'link' }),
    ],
    observations: [
      { id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' },
      { id: 'o2', kind: 'route', basis: 'observed', atMs: 0, doc: 'd1', url: `${SITE}/companies`, title: 'Companies', transition: 'typed' },
      { id: 'o3', kind: 'click', basis: 'observed', atMs: 7500, doc: 'd1', target: connect, button: 'left', count: 1, point: { x: 970, y: 138 }, scroll: { x: 0, y: 0 } },
      { id: 'o4', kind: 'window', basis: 'observed', atMs: 8000, window: 'w2', state: 'opened', opener: 'w1', url: popupUrl, title: 'Sign in to Vendor' },
      { id: 'o5', kind: 'route', basis: 'observed', atMs: 8000.5, doc: 'd2', url: popupUrl, title: 'Sign in to Vendor', transition: 'link' },
      { id: 'o6', kind: 'input', basis: 'observed', atMs: 10000, doc: 'd2', target: user, inputType: 'email', value: { state: 'masked' }, count: 12 },
      { id: 'o7', kind: 'marker-element', basis: 'user-marked', atMs: 12000, doc: 'd2', target: allow, via: 'right-click', point: { x: 260, y: 440 }, scroll: { x: 0, y: 0 } },
      { id: 'o8', kind: 'window', basis: 'observed', atMs: 15000, window: 'w1', state: 'focused' },
      { id: 'o9', kind: 'marker-element', basis: 'user-marked', atMs: 16000, doc: 'd1', target: connect, via: 'right-click', point: { x: 970, y: 138 }, scroll: { x: 0, y: 0 } },
      { id: 'o10', kind: 'window', basis: 'observed', atMs: 18000, window: 'w2', state: 'focused' },
      { id: 'o11', kind: 'click', basis: 'observed', atMs: 19500, doc: 'd2', target: allow, button: 'left', count: 1, point: { x: 260, y: 440 }, scroll: { x: 0, y: 0 } },
      { id: 'o12', kind: 'window', basis: 'observed', atMs: 20000, window: 'w2', state: 'closed' },
      { id: 'o13', kind: 'window', basis: 'observed', atMs: 20100, window: 'w1', state: 'focused' },
      { id: 'o14', kind: 'recording', basis: 'observed', atMs: 30000, state: 'stopped' },
    ],
    gaps: [{ id: 'g1', scope: 'audio', startMs: 0, endMs: 30000, reason: 'mic-denied', detail: 'microphone permission denied' }],
    edits: null,
    revisions: [],
    rrweb: { 'rrweb/d1.jsonl': snapshotStart(`${SITE}/companies`, 5), 'rrweb/d2.jsonl': snapshotStart(popupUrl, 8005) },
    audio: null,
    clock: null,
  };
}

// ---------- good: dashboard walkthrough ----------

function dashboard(audio: Uint8Array): Spec {
  const box = (x: number, y: number, w: number, h: number): Obj => ({ x, y, w, h });
  const revenue = el(42, 'h2', 'heading', 'Revenue', 'text', box(24, 310, 640, 32));
  const q3 = el(57, 'td', 'cell', 'Q3', 'text', box(300, 360, 80, 24));
  const nav = el(9, 'nav', 'navigation', 'Main', 'aria-label', box(0, 64, 200, 700));
  const total = el(120, 'span', null, 'Total: $12,400', 'text', box(480, 400, 140, 20));
  const north = el(61, 'td', 'cell', 'North 4,100', 'text', box(40, 220, 150, 24));
  const south = el(62, 'td', 'cell', 'South 3,900', 'text', box(200, 220, 150, 24));
  const east = el(63, 'td', 'cell', 'East 2,200', 'text', box(40, 250, 150, 24));
  const west = el(64, 'td', 'cell', 'West 2,200', 'text', box(200, 250, 150, 24));
  const hidden = { node: 77, tag: 'div', role: null, nameSource: 'none', excluded: true, box: box(700, 300, 400, 200) };
  const exportButton = el(15, 'button', 'button', 'Export', 'text', box(1040, 80, 96, 36));
  const search = el(21, 'input', 'textbox', 'Search reports', 'placeholder', box(240, 80, 320, 36));
  const regionTable = el(30, 'table', 'table', 'Region totals', 'aria-label', box(24, 160, 900, 400));
  const top = { x: 0, y: 0 };
  const reports = `${SITE}/reports?range=_`;

  const said: [string, number, number, string, string][] = [
    ['s1', 42100, 44800, 'this should collapse', 'This should collapse'],
    ['s2', 45000, 47900, 'and this toll is wrong', 'and this toll is wrong'],
    ['s3', 50000, 56000, 'these four numbers should line up', 'These four numbers should line up'],
    ['s4', 61000, 64500, 'the export button does nothing', 'The export button does nothing'],
    ['s5', 66000, 69000, 'this table needs a total row', 'This table needs a total row'],
  ];
  const noAudio = { startMs: 72000, endMs: 75400, reason: 'not-transcribed', detail: 'no audio' };
  const revision = (revisionId: string, source: string, provider: string, model: string, createdAt: string, column: 3 | 4, extra: Obj = {}): Obj => ({
    revisionId,
    source,
    provider,
    model,
    language: 'en',
    createdAt,
    ...extra,
    segments: said.map((s) => segment(s[0], s[1], s[2], s[column])),
    gaps: [noAudio],
  });
  const whisper = { timing: { quality: 'approximate', method: 'whisper-dtw', correctionMs: -150 }, supersedes: 'r1' };

  return {
    manifest: {
      ...manifest(
        'rec_fixture_dashboard',
        'Dashboard review',
        80000,
        { file: AUDIO_PATH, mediaType: 'audio/webm;codecs=opus', clock: 'audio/clock.jsonl', startMs: 102.3, decodedMs: 79800 },
        'r2',
        1,
      ),
      purpose: "Review of yesterday's dashboard changes; each thing I point at is a change request",
    },
    documents: [
      document('d1', `${SITE}/dashboard`, 'Dashboard', 0, 60000),
      document('d2', reports, 'Reports', 60400, null, { transition: 'link', capture: 'partial' }),
      document('d3', 'https://charts.example.test/embed?id=_', '', 60600, null, {
        frameId: 4,
        parentKey: 'd2',
        transition: 'auto_subframe',
        capture: 'none',
        rrweb: null,
      }),
    ],
    observations: [
      { id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' },
      { id: 'o2', kind: 'viewport', basis: 'observed', atMs: 0, w: 1280, h: 800, dpr: 1 },
      { id: 'o3', kind: 'route', basis: 'observed', atMs: 0, doc: 'd1', url: `${SITE}/dashboard`, title: 'Dashboard', transition: 'typed' },
      { id: 'o4', kind: 'exclusion', basis: 'observed', atMs: 1000, doc: 'd1', state: 'added', target: hidden, scroll: top },
      { id: 'o5', kind: 'pointer-dwell', basis: 'derived', atMs: 20000, endMs: 20400, doc: 'd1', target: q3, scroll: top },
      { id: 'o6', kind: 'pointer-dwell', basis: 'derived', atMs: 25000, endMs: 27000, doc: 'd1', target: nav, scroll: top },
      { id: 'o7', kind: 'pointer-dwell', basis: 'derived', atMs: 42300, endMs: 44400, doc: 'd1', target: revenue, scroll: top },
      { id: 'o8', kind: 'marker-element', basis: 'user-marked', atMs: 46200, doc: 'd1', target: total, via: 'right-click', point: { x: 520, y: 410 }, scroll: top },
      { id: 'o9', kind: 'pointer-dwell', basis: 'derived', atMs: 50500, endMs: 51500, doc: 'd1', target: north, scroll: top },
      { id: 'o10', kind: 'pointer-dwell', basis: 'derived', atMs: 51800, endMs: 53300, doc: 'd1', target: south, scroll: top },
      { id: 'o11', kind: 'marker-region', basis: 'user-marked', atMs: 53000, endMs: 54000, doc: 'd1', rect: box(40, 200, 320, 180), scroll: top, contains: [north, south, east, west], text: 'North 4,100 South 3,900 East 2,200 West 2,200' },
      { id: 'o12', kind: 'pointer-dwell', basis: 'derived', atMs: 54000, endMs: 54800, doc: 'd1', target: east, scroll: top },
      { id: 'o13', kind: 'pointer-dwell', basis: 'derived', atMs: 55000, endMs: 55600, doc: 'd1', target: west, scroll: top },
      { id: 'o14', kind: 'scroll', basis: 'observed', atMs: 57000, endMs: 57600, doc: 'd1', target: null, from: top, to: { x: 0, y: 640 } },
      { id: 'o15', kind: 'route', basis: 'observed', atMs: 60400, doc: 'd2', url: reports, title: 'Reports', transition: 'link' },
      { id: 'o16', kind: 'click', basis: 'observed', atMs: 62000, doc: 'd2', target: exportButton, button: 'left', count: 1, point: { x: 1088, y: 98 }, scroll: top },
      { id: 'o17', kind: 'input', basis: 'observed', atMs: 63000, endMs: 63800, doc: 'd2', target: search, inputType: 'insertText', value: { state: 'masked' }, count: 4, scroll: top },
      { id: 'o18', kind: 'selection', basis: 'observed', atMs: 67000, doc: 'd2', target: regionTable, text: 'Region totals', scroll: top },
      { id: 'o19', kind: 'visibility', basis: 'observed', atMs: 76000, state: 'hidden' },
      { id: 'o20', kind: 'visibility', basis: 'observed', atMs: 77000, state: 'visible' },
      { id: 'o21', kind: 'recording', basis: 'observed', atMs: 80000, state: 'stopped' },
    ],
    gaps: [
      { id: 'g1', scope: 'page', startMs: 60000, endMs: 60400, reason: 'navigation-blind-window', doc: 'd2' },
      { id: 'g2', scope: 'frame', startMs: 60600, endMs: 80000, reason: 'cross-origin-frame', doc: 'd2', detail: 'chart frame not stitched' },
      { id: 'g3', scope: 'page', startMs: 65000, endMs: 65200, reason: 'lost-messages', doc: 'd2', detail: 'seq 2' },
      { id: 'g4', scope: 'audio', startMs: 72000, endMs: 75400, reason: 'mic-track-ended', detail: 'device unplugged' },
      { id: 'g5', scope: 'page', startMs: 76000, endMs: 77000, reason: 'tab-hidden' },
    ],
    edits: [
      { id: 'c1', type: 'correction', revisionId: 'r1', segmentId: 's2', wordStart: 2, wordEnd: 3, text: 'total', createdAt: '2026-10-13T20:02:00.000Z' },
      { id: 'n1', type: 'note', atMs: 70300, text: 'Same on mobil', createdAt: '2026-10-13T20:02:30.000Z' },
      { id: 'n2', type: 'note', atMs: 70300, text: 'Same on mobile', createdAt: '2026-10-13T20:02:40.000Z', supersedes: 'n1' },
      { id: 'n3', type: 'note', atMs: 30000, text: 'ignore this', createdAt: '2026-10-13T20:03:00.000Z' },
      { id: 'x1', type: 'retract', target: 'n3', createdAt: '2026-10-13T20:03:10.000Z' },
      { id: 'c2', type: 'correction', revisionId: 'r2', segmentId: 's2', wordStart: 2, wordEnd: 3, text: 'total', createdAt: '2026-10-13T20:05:00.000Z', carriedFrom: 'c1' },
    ],
    revisions: [
      revision('r1', 'live', 'browser-local', 'vosk-model-small-en-us-0.15', '2026-10-13T20:01:21.000Z', 3),
      revision('r2', 'after-recording', 'openai', 'whisper-1', '2026-10-13T20:04:00.000Z', 4, whisper),
    ],
    rrweb: {
      'rrweb/d1.jsonl': [
        ...snapshotStart(`${SITE}/dashboard`, 5),
        rrwebLine(2, 42300, { type: 3, data: { source: 1, positions: [{ x: 300, y: 320, id: 42, timeOffset: 0 }] } }),
        rrwebLine(3, 57600, { type: 3, data: { source: 3, id: 1, x: 0, y: 640 } }),
      ],
      'rrweb/d2.jsonl': [
        ...snapshotStart(reports, 60400),
        rrwebLine(3, 65300, { type: 3, data: { source: 2, type: 2, id: 15, x: 1088, y: 98 } }),
      ],
    },
    audio,
    clock: Array.from({ length: 8 }, (_, k) => ({
      frames: (k + 1) * 480000,
      sampleRate: 48000,
      atMs: Math.round((102.3 + (k + 1) * 10000 * (1 + 270e-6)) * 10) / 10,
    })),
  };
}

// ---------- fixture list ----------

const clone = <T>(v: T): T => structuredClone(v);
const ok = (why: string, warnings: string[] = []): Expect => ({ ok: true, errors: [], warnings, why });
const bad = (why: string, errors: string[], warnings: string[] = []): Expect => ({ ok: false, errors, warnings, why });

function edited(files: Map<string, Uint8Array>, path: string, change: (text: string) => string): Map<string, Uint8Array> {
  const out = new Map(files);
  out.set(path, enc.encode(change(new TextDecoder().decode(files.get(path)!))));
  return out;
}

async function fixtures(audio: Uint8Array): Promise<{ good: Fixture[]; bad: Fixture[] }> {
  const m = minimal();
  const d = dashboard(audio);
  const tw = twoWindows();
  const twoWindowFiles = await pack(tw, true);
  const dashboardFiles = await pack(d, true);
  const minimalFiles = await pack(m, true);

  const variant = async (base: Spec, change: (s: Spec) => void, agent = false): Promise<Map<string, Uint8Array>> => {
    const s = clone(base);
    change(s);
    return pack(s, agent);
  };
  const obs = (s: Spec, id: string): Obj => s.observations.find((o) => o.id === id)!;
  // Bad fixtures need no narration bytes; the audio gap g4 keeps audio: null valid.
  const dq: Spec = clone({ ...d, audio: null, clock: null });
  dq.manifest.audio = null;

  const newerMinor = await variant(
    m,
    (s) => {
      s.manifest.schemaVersion = '1.2';
      s.manifest.recordingSource = 'toolbar';
      s.observations.splice(3, 0, { id: 'o5', kind: 'hover-intent', basis: 'derived', atMs: 3000, endMs: 3600, doc: 'd1', confidence: 0.7 });
      s.gaps.push({ id: 'g2', scope: 'page', startMs: 4000, endMs: 4500, reason: 'devtools-open' });
    },
    true,
  );

  const good: Fixture[] = [
    { name: 'minimal', files: minimalFiles, expect: ok('No narration (microphone denied, explained by an audio gap), one page, one click.') },
    {
      name: 'dashboard-walkthrough',
      files: dashboardFiles,
      expect: ok(
        'Narrated two-page walkthrough: two transcript revisions with a carried correction, notes with supersede and retract, markers, dwells, a masked input, a cross-origin frame, lost rrweb messages and an audio gap.',
      ),
    },
    {
      name: 'newer-minor',
      files: newerMinor,
      expect: ok('Schema 1.2 from a newer writer: unknown field, kind and gap reason are kept and reported as warnings.', [
        'W_NEWER_MINOR',
        'W_UNKNOWN_FIELD',
        'W_UNKNOWN_KIND',
        'W_UNKNOWN_REASON',
      ]),
    },
    {
      name: 'two-windows',
      files: twoWindowFiles,
      expect: ok('Schema 1.1: the recorded page opens a sign-in popup; marks in both windows, switches between them, the popup closes.'),
    },
    {
      name: 'stale-agent-export',
      files: withManifest(
        JSON.parse(new TextDecoder().decode(minimalFiles.get('manifest.json')!)),
        new Map([...edited(minimalFiles, 'agent/walkthrough.md', (t) => t.replace('Sign-in link check', 'Old title'))].filter(([p]) => p !== 'manifest.json')),
      ),
      expect: ok('The derived Markdown export no longer matches the bundle; it is regenerable, so this is a warning.', ['W_AGENT_STALE']),
    },
  ];

  const plainDashboard = await pack(dq, false);
  const plainMinimal = await pack(m, false);
  const without = (files: Map<string, Uint8Array>, path: string): Map<string, Uint8Array> => {
    const out = new Map(files);
    out.delete(path);
    return out;
  };

  const badList: Fixture[] = [
    {
      name: 'hash-mismatch',
      files: edited(plainDashboard, 'observations.jsonl', (t) => t.replace('"Revenue"', '"Revenux"')),
      expect: bad('A file changed after the manifest was written (same size).', ['E_HASH']),
    },
    {
      name: 'size-mismatch',
      files: edited(plainMinimal, 'gaps.jsonl', (t) => `${t}{"id":"g2","scope":"page","startMs":0,"endMs":1,"reason":"tab-hidden"}\n`),
      expect: bad('A file grew after the manifest was written.', ['E_SIZE']),
    },
    {
      name: 'unlisted-file',
      files: new Map([...plainMinimal, ['notes.md', enc.encode('not listed\n')]]),
      expect: bad('A file is present but not listed in manifest.files.', ['E_FILE_UNLISTED']),
    },
    {
      name: 'listed-file-missing',
      files: without(plainMinimal, 'rrweb/d1.jsonl'),
      expect: bad('A listed file is absent.', ['E_FILE_MISSING']),
    },
    {
      name: 'no-manifest',
      files: without(plainMinimal, 'manifest.json'),
      expect: bad('No manifest.json.', ['E_MANIFEST_MISSING']),
    },
    {
      name: 'major-version',
      files: await variant(m, (s) => void (s.manifest.schemaVersion = '2.0')),
      expect: bad('A different major version is refused.', ['E_VERSION']),
    },
    {
      name: 'unknown-kind-same-version',
      files: await variant(m, (s) => s.observations.splice(3, 0, { id: 'o5', kind: 'hover-intent', basis: 'derived', atMs: 3000, endMs: 3600, doc: 'd1' })),
      expect: bad('An observation kind 1.0 does not define, in a 1.0 bundle, is a writer bug.', ['E_UNKNOWN_KIND']),
    },
    {
      name: 'window-missing',
      files: await variant(tw, (s) => void (s.observations.find((o) => o.id === 'o10')!.window = 'w9')),
      expect: bad('A window observation must name a window documents.json lists.', ['E_REF']),
    },
    {
      name: 'document-without-window',
      files: await variant(tw, (s) => void delete s.documents[1].window),
      expect: bad('When documents.json lists windows, every document says which window it was in.', ['E_FIELD']),
    },
    {
      name: 'wrong-basis',
      files: await variant(dq, (s) => void (obs(s, 'o8').basis = 'observed')),
      expect: bad('A marker must be user-marked; observed and user-marked evidence never mix.', ['E_FIELD']),
    },
    {
      name: 'credential-field',
      files: await variant(m, (s) => void (s.gaps[0].authorization = 'not-a-real-value')),
      expect: bad('A credential-shaped field name anywhere outside rrweb.', ['E_CREDENTIAL'], ['W_UNKNOWN_FIELD']),
    },
    {
      name: 'credential-string',
      files: await variant(dq, (s) => void (s.edits![2].text = 'Bearer not-a-real-token')),
      expect: bad('A note that starts with "Bearer ".', ['E_CREDENTIAL']),
    },
    {
      name: 'credential-key-substring',
      files: await variant(m, (s) => void (s.gaps[0].refresh_token = 'not-a-real-value')),
      expect: bad('A field whose name contains a credential word ("refresh_token").', ['E_CREDENTIAL'], ['W_UNKNOWN_FIELD']),
    },
    {
      name: 'credential-sk-key',
      // Fake: 'sk-' then 24 key characters, built so no key-shaped literal sits in this source.
      files: await variant(dq, (s) => void (s.edits![2].text = `see ${['sk', 'fixturefixturefixture000'].join('-')}`)),
      expect: bad('A note holds an "sk-" API key shape at the start of a word.', ['E_CREDENTIAL']),
    },
    {
      name: 'credential-purpose',
      files: await variant(m, (s) => void (s.manifest.purpose = `token ${['sk', 'fixturefixturefixture000'].join('-')}`)),
      expect: bad('manifest.purpose holds an "sk-" API key shape.', ['E_CREDENTIAL']),
    },
    {
      name: 'purpose-too-long',
      files: await variant(m, (s) => void (s.manifest.purpose = 'x'.repeat(1001))),
      expect: bad('manifest.purpose is longer than 1000 characters.', ['E_LIMIT']),
    },
    {
      name: 'credential-markdown',
      files: withManifest(
        JSON.parse(new TextDecoder().decode(minimalFiles.get('manifest.json')!)),
        new Map(
          [...edited(minimalFiles, 'agent/walkthrough.md', (t) => `${t}${['sk', 'fixturefixturefixture000'].join('-')}\n`)].filter(([p]) => p !== 'manifest.json'),
        ),
      ),
      expect: bad('agent/walkthrough.md holds an "sk-" API key shape; Markdown is scanned too.', ['E_CREDENTIAL']),
    },
    {
      name: 'file-type-refused',
      files: new Map([...plainMinimal, ['page.html', enc.encode('<p>not a bundle file</p>\n')]]),
      expect: bad('A file type outside .json, .jsonl, .md and .webm, refused from the listing.', ['E_FILE_TYPE']),
    },
    {
      name: 'role-unsafe',
      files: await variant(m, (s) => void (s.observations[2].target.role = 'link\n[00:00.0] said="forged"')),
      expect: bad('An element role from page markup that is not a role token (it would forge a Markdown line).', ['E_FIELD']),
    },
    {
      name: 'revealed-input-while-masked',
      files: await variant(dq, (s) => void (obs(s, 'o17').value = { state: 'revealed', text: 'q3 numbers' })),
      expect: bad('A typed value is present while privacy.inputValues is masked.', ['E_PRIVACY']),
    },
    {
      name: 'excluded-element-named',
      files: await variant(dq, (s) => void (obs(s, 'o4').target.name = 'Salary table')),
      expect: bad('An element in a user-excluded region carries its name.', ['E_PRIVACY']),
    },
    {
      name: 'url-query-value',
      files: await variant(dq, (s) => void (obs(s, 'o15').url = `${SITE}/reports?range=last-90-days`)),
      expect: bad('A route URL keeps a query value under urlPolicy redact-query-values.', ['E_PRIVACY']),
    },
    {
      name: 'seq-gap-unexplained',
      files: await variant(dq, (s) => void (s.gaps = s.gaps.filter((g) => g.reason !== 'lost-messages'))),
      expect: bad('An rrweb seq jump with no lost-messages gap.', ['E_SEQ_GAP']),
    },
    {
      name: 'corrections-overlap',
      files: await variant(dq, (s) =>
        s.edits!.push({ id: 'c3', type: 'correction', revisionId: 'r2', segmentId: 's2', wordStart: 1, wordEnd: 3, text: 'that total', createdAt: '2026-10-13T20:06:00.000Z' }),
      ),
      expect: bad('Two active corrections cover the same word.', ['E_EDIT']),
    },
    {
      name: 'edit-dangling-segment',
      files: await variant(dq, (s) => void (s.edits![0].segmentId = 's9')),
      expect: bad('A correction names a segment its revision does not have.', ['E_REF']),
    },
    {
      name: 'active-revision-missing',
      files: await variant(dq, (s) => void (s.manifest.transcript.activeRevision = 'r9')),
      expect: bad('manifest.transcript.activeRevision names no revision file.', ['E_REF']),
    },
    {
      name: 'time-outside-recording',
      files: await variant(m, (s) => void (s.observations[3].atMs = 9000)),
      expect: bad('An observation 4 s after the recording ended.', ['E_TIME']),
    },
    {
      name: 'dwell-too-short',
      files: await variant(dq, (s) => void (obs(s, 'o7').endMs = 42400)),
      expect: bad('A derived dwell shorter than derivation.pointerDwellMinMs.', ['E_FIELD']),
    },
    {
      name: 'audio-missing-unexplained',
      files: await variant(m, (s) => void (s.gaps = [])),
      expect: bad('No narration audio and no audio gap saying why.', ['E_AUDIO_GAP']),
    },
    {
      name: 'duplicate-id',
      files: await variant(m, (s) => void (s.observations[1].id = 'o1')),
      expect: bad('Two observations share an ID.', ['E_DUP_ID']),
    },
    {
      name: 'blank-line',
      files: withManifest(
        JSON.parse(new TextDecoder().decode(plainMinimal.get('manifest.json')!)),
        new Map([...edited(plainMinimal, 'observations.jsonl', (t) => t.replace('\n', '\n\n'))].filter(([p]) => p !== 'manifest.json')),
      ),
      expect: bad('A blank line inside observations.jsonl.', ['E_JSONL']),
    },
    {
      name: 'invalid-utf8',
      files: (() => {
        const files = new Map([...plainMinimal].filter(([p]) => p !== 'manifest.json'));
        const lines = files.get('observations.jsonl')!;
        files.set('observations.jsonl', new Uint8Array([...lines.subarray(0, 20), 0xff, ...lines.subarray(21)]));
        return withManifest(JSON.parse(new TextDecoder().decode(plainMinimal.get('manifest.json')!)), files);
      })(),
      expect: bad('observations.jsonl is not valid UTF-8.', ['E_ENCODING']),
    },
  ];
  return { good, bad: badList };
}

// ---------- write / check ----------

async function audioBytes(): Promise<Uint8Array> {
  if (existsSync(AUDIO_FIXTURE)) return new Uint8Array(await readFile(AUDIO_FIXTURE));
  const tmp = await mkdtemp(join(tmpdir(), 'narwal-audio-'));
  const out = join(tmp, 'narration.webm');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '79.8',
    '-c:a', 'libopus', '-b:a', '6k', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'webm', out,
  ]);
  const bytes = new Uint8Array(await readFile(out));
  await rm(tmp, { recursive: true });
  return bytes;
}

async function writeAll(root: string, set: { good: Fixture[]; bad: Fixture[] }): Promise<void> {
  const expected: Record<string, Expect> = {};
  for (const [group, list] of [['good', set.good], ['bad', set.bad]] as const) {
    for (const f of list) {
      const dir = join(root, group, f.name);
      for (const [path, bytes] of f.files) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), bytes);
      }
      expected[`${group}/${f.name}`] = f.expect;
    }
  }
  await writeFile(join(root, 'expected.json'), json(expected));
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(root, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

const set = await fixtures(await audioBytes());
if (process.argv.includes('--check')) {
  const tmp = await mkdtemp(join(tmpdir(), 'narwal-fixtures-'));
  try {
    await writeAll(tmp, set);
    const [want, have] = [await listTree(tmp), await listTree(ROOT)];
    const drift: string[] = [];
    for (const p of new Set([...want, ...have])) {
      if (!want.includes(p) || !have.includes(p)) drift.push(p);
      else if (sha256(await readFile(join(ROOT, p))) !== sha256(await readFile(join(tmp, p)))) drift.push(p);
    }
    if (drift.length > 0) {
      process.stdout.write(`fixtures differ from the builder: ${drift.join(', ')}\nrun: node scripts/build-fixtures.ts\n`);
      process.exit(1);
    }
    process.stdout.write(`fixtures match the builder (${want.length} files)\n`);
  } finally {
    await rm(tmp, { recursive: true });
  }
} else {
  const audio = existsSync(AUDIO_FIXTURE);
  await rm(join(ROOT, 'good'), { recursive: true, force: true });
  await rm(join(ROOT, 'bad'), { recursive: true, force: true });
  await writeAll(ROOT, set);
  process.stdout.write(`wrote ${set.good.length} good and ${set.bad.length} bad fixtures${audio ? '' : ' (audio generated with ffmpeg)'}\n`);
}
