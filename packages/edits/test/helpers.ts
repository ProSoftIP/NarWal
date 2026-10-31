// Test helpers: the schema 1.0 good fixture as a tree, a library around it,
// and provider revisions shaped like an adapter's.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAgentFiles } from '../../bundle/src/derived.ts';
import { bundleValidator } from '../../bundle/src/validate.ts';
import { RecordingLibrary } from '../../library/src/library.ts';
import { MemoryLibraryStorage } from '../../library/src/storage-memory.ts';
import type { TranscriptRevision } from '../../transcription/src/contract.ts';

const FIXTURE = fileURLToPath(new URL('../../bundle/fixtures/good/dashboard-walkthrough/', import.meta.url));

/** The fixture as stored: active revision r2, c1 on r1 carried to r2 as c2 ("toll" → "total" in s2). */
export async function fixtureFiles(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(FIXTURE, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(FIXTURE, path).split(sep).join('/'), new Uint8Array(await readFile(path)));
  }
  return files;
}

export async function openLibrary(): Promise<RecordingLibrary> {
  return RecordingLibrary.open({ storage: new MemoryLibraryStorage(), productVersion: 'test', validate: bundleValidator, derive: deriveAgentFiles });
}

export const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** Paths the user layers never touch. */
export const isCaptured = (path: string): boolean =>
  path !== 'manifest.json' &&
  path !== 'edits.jsonl' &&
  path !== 'README.md' &&
  path !== 'AGENTS.md' &&
  !path.startsWith('transcript/') &&
  !path.startsWith('agent/');

export const clockAt = (iso: string) => () => new Date(iso);

type Words = Array<[text: string, startMs: number, endMs: number]>;

/**
 * An OpenAI-style after-recording revision with the fixture's five segments
 * at the fixture's times. `change` swaps the words of segments by index.
 */
export function providerRevision(change: Record<number, Words> = {}, extra: Partial<TranscriptRevision> = {}): TranscriptRevision {
  const base: Words[] = [
    [['This', 42100, 43000], ['should', 43000, 43900], ['collapse', 43900, 44800]],
    [['and', 45000, 45580], ['this', 45580, 46160], ['toll', 46160, 46740], ['is', 46740, 47320], ['wrong', 47320, 47900]],
    [['These', 50000, 51000], ['four', 51000, 52000], ['numbers', 52000, 53000], ['should', 53000, 54000], ['line', 54000, 55000], ['up', 55000, 56000]],
    [['The', 61000, 61700], ['export', 61700, 62400], ['button', 62400, 63100], ['does', 63100, 63800], ['nothing', 63800, 64500]],
    [['This', 66000, 66500], ['table', 66500, 67000], ['needs', 67000, 67500], ['a', 67500, 68000], ['total', 68000, 68500], ['row', 68500, 69000]],
  ];
  const segments = base.map((original, index) => {
    const words = change[index] ?? original;
    return {
      provider: 'openai' as const,
      model: 'gpt-4o-transcribe',
      connectionId: 'upload-1',
      segmentKey: `k${index + 1}`,
      kind: 'final' as const,
      startMs: original[0]![1],
      endMs: original[original.length - 1]![2],
      text: words.map(([text]) => text).join(' '),
      words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
      endOfUtterance: true,
    };
  });
  return {
    revisionId: 'provider-job-1',
    provider: 'openai',
    model: 'gpt-4o-transcribe',
    createdAtMs: Date.parse('2026-10-13T20:10:00.000Z'),
    source: 'after-recording',
    segments,
    gaps: [],
    supersedes: 'r2',
    ...extra,
  };
}
