// Test helpers: a schema 1.0 fixture bundle, and a zip writer that can lie.

import { deflateRawSync } from 'node:zlib';
import { MANIFEST_PATH, sha256Hex } from '../src/bundle.ts';
import { crc32 } from '../src/zip.ts';

const encoder = new TextEncoder();
export const text = (value: string): Uint8Array => encoder.encode(value);
export const json = (value: unknown): Uint8Array => text(JSON.stringify(value));
export const jsonl = (lines: unknown[]): Uint8Array => text(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Deterministic bytes that do not compress, standing in for Opus audio. */
export function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const MEDIA_TYPES: Record<string, string> = {
  json: 'application/json',
  jsonl: 'application/jsonl',
  md: 'text/markdown',
  webm: 'audio/webm;codecs=opus',
};

/** Builds `manifest.json` for the given content files. `manifest` overrides or adds fields. */
export async function withManifest(
  content: Map<string, Uint8Array>,
  manifest: Record<string, unknown> = {},
): Promise<Map<string, Uint8Array>> {
  const files = [];
  for (const [path, bytes] of content) {
    const extension = path.slice(path.lastIndexOf('.') + 1);
    files.push({
      path,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      mediaType: MEDIA_TYPES[extension] ?? 'application/octet-stream',
    });
  }
  const full = {
    format: 'narwal.bundle',
    schemaVersion: '1.0',
    recordingId: 'rec_2026-10-13_a1b2c3',
    title: 'Dashboard review',
    createdAt: '2026-10-13T20:00:00.000Z',
    producer: { name: 'narwal-extension', version: '0.1.0' },
    environment: { browser: 'Chrome', browserVersion: '153.0.8010.12', platform: 'linux' },
    clock: { originEpochMs: 1760385600000.25 },
    durationMs: 312400.5,
    state: 'complete',
    privacy: { inputValues: 'masked', excludedRegions: 1, urlPolicy: 'redact-query-values', audio: 'not-redacted' },
    derivation: { pointerDwellMinMs: 300 },
    audio: {
      file: 'audio/narration.webm',
      mediaType: 'audio/webm;codecs=opus',
      clock: 'audio/clock.jsonl',
      startMs: 102.3,
      decodedMs: 312100,
    },
    transcript: { activeRevision: 'r1' },
    files,
    ...manifest,
  };
  return new Map([[MANIFEST_PATH, json(full)], ...content]);
}

/** Every file kind of docs/bundle-schema.md §3, small. */
export function fixtureContent(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [
      'documents.json',
      json({
        documents: [
          {
            key: 'd1',
            browserDocumentId: '6C1F0A',
            frameId: 0,
            parentKey: null,
            frameNode: null,
            url: 'https://app.example.test/dashboard',
            title: 'Dashboard',
            navigationType: 'navigate',
            transition: 'typed',
            attachedMs: 0,
            detachedMs: null,
            attachments: [{ atMs: 0, reason: 'boot' }],
            capture: 'full',
            rrweb: 'rrweb/d1.jsonl',
          },
        ],
      }),
    ],
    [
      'observations.jsonl',
      jsonl([
        { id: 'o1', kind: 'recording', basis: 'observed', atMs: 0, state: 'started' },
        {
          id: 'o2',
          kind: 'pointer-dwell',
          basis: 'derived',
          atMs: 42100.4,
          endMs: 44200.9,
          doc: 'd1',
          target: { node: 42, tag: 'h2', role: 'heading', name: 'Revenue', nameSource: 'text', box: { x: 24, y: 310, w: 640, h: 32 } },
        },
      ]),
    ],
    ['gaps.jsonl', jsonl([{ id: 'g1', scope: 'audio', startMs: 72000, endMs: 75400, reason: 'mic-track-ended' }])],
    [
      'edits.jsonl',
      jsonl([{ id: 'n1', type: 'note', atMs: 70300, endMs: null, text: 'Same on mobile', createdAt: '2026-10-13T20:10:00.000Z' }]),
    ],
    ['audio/narration.webm', noise(40_000)],
    ['audio/clock.jsonl', jsonl([{ frames: 48000, sampleRate: 48000, atMs: 1102.4 }])],
    [
      'transcript/r1.json',
      json({
        revisionId: 'r1',
        source: 'live',
        provider: 'browser-local',
        model: 'vosk-small-en-us',
        language: 'en',
        createdAt: '2026-10-13T20:06:00.000Z',
        segments: [
          {
            id: 's1',
            startMs: 42100,
            endMs: 44800,
            text: 'This should collapse',
            words: [{ text: 'This', startMs: 42100, endMs: 42350, confidence: 0.98 }],
          },
        ],
        gaps: [],
      }),
    ],
    [
      'rrweb/d1.jsonl',
      jsonl([
        { seq: 0, sentMs: 5.1, receivedMs: 5.6, event: { type: 4, timestamp: 1760385600005, data: { href: 'https://app.example.test/dashboard' } } },
        {
          seq: 1,
          sentMs: 9.1,
          receivedMs: 9.4,
          event: {
            type: 2,
            timestamp: 1760385600009,
            // Hostile page content: it must stay inert text through import and export.
            data: { node: { tagName: 'script', textContent: 'globalThis.__narwalPwned = true; fetch("https://evil.example/")' }, href: 'javascript:alert(1)' },
          },
        },
      ]),
    ],
    [
      'agent/walkthrough.md',
      text('# Dashboard review\n\n```text\n[00:42.1-00:44.8] said="This should collapse" | observed pointer over "Revenue" heading 2.1s | route=/dashboard\n```\n'),
    ],
    ['agent/walkthrough.json', json({ format: 'narwal.agent-view', schemaVersion: '1.0', recordingId: 'rec_2026-10-13_a1b2c3', entries: [] })],
  ]);
}

export function fixtureBundle(manifest: Record<string, unknown> = {}): Promise<Map<string, Uint8Array>> {
  return withManifest(fixtureContent(), manifest);
}

export interface CraftedEntry {
  name: string | Uint8Array;
  data: Uint8Array;
  method?: number;
  /** Deflate `data` for real (method 8). */
  deflate?: boolean;
  declaredSize?: number;
  declaredCompressedSize?: number;
  flags?: number;
  madeBy?: number;
  externalAttributes?: number;
  crc?: number;
  /** Name written in the local header when it should differ from the directory. */
  localName?: string;
  /** Point this entry's directory record at an earlier entry's data. */
  shareDataOf?: number;
}

/** Writes a zip with whatever the test says, true or not. */
export function craftZip(
  entries: CraftedEntry[],
  options: { trailing?: Uint8Array; entryCountOverride?: number; zip64Marker?: boolean } = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = typeof entry.name === 'string' ? encoder.encode(entry.name) : entry.name;
    const stored = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const size = entry.declaredSize ?? entry.data.length;
    const compressedSize = entry.declaredCompressedSize ?? stored.length;
    const crc = entry.crc ?? crc32(entry.data);
    const flags = entry.flags ?? 0x0800;

    let localOffset = offset;
    if (entry.shareDataOf === undefined) {
      const localName = entry.localName === undefined ? name : encoder.encode(entry.localName);
      const local = new Uint8Array(30 + localName.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, method, true);
      lv.setUint16(12, 0x0021, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, compressedSize, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, localName.length, true);
      local.set(localName, 30);
      parts.push(local, stored);
      offset += local.length + stored.length;
    } else {
      localOffset = offsets[entry.shareDataOf] as number;
    }
    offsets[index] = localOffset;

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, entry.madeBy ?? 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, entry.externalAttributes ?? 0, true);
    cv.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
  });
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  const count = options.entryCountOverride ?? entries.length;
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, options.zip64Marker ? 0xffffffff : offset, true);
  const all = [...parts, ...centrals, eocd, ...(options.trailing ? [options.trailing] : [])];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of all) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

/** Packs a bundle tree with no checks at all, so a test can ship a tree `packBundle` would refuse. */
export function zipUnchecked(files: Map<string, Uint8Array>): Uint8Array {
  return craftZip([...files].map(([name, data]) => ({ name, data, deflate: !name.endsWith('.webm') })));
}
