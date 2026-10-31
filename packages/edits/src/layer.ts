// The user layers of one bundle tree (docs/bundle-schema.md §8): transcript
// revisions, `edits.jsonl` and the recording's purpose. Reads them, and writes a plan back as a new
// tree that only adds to them, so `RecordingLibrary.update` accepts it
// (packages/library/src/update-rules.ts). Captured files are never parsed for
// writing and never rewritten: their bytes pass through as they are.

import { deriveAgentFiles } from '../../bundle/src/derived.ts';
import { LIMITS } from '../../bundle/src/limits.ts';
import { memorySource } from '../../bundle/src/memory-source.ts';
import type { Edit, TranscriptRevision } from '../../bundle/src/types.ts';
import { validateBundle } from '../../bundle/src/validate.ts';
import { MANIFEST_PATH, sha256Hex } from '../../library/src/bundle.ts';
import type { BundleFiles, ManifestFile } from '../../library/src/bundle.ts';
import { EditError } from './errors.ts';

export const EDITS_PATH = 'edits.jsonl';
const REVISION_PATH = /^transcript\/([^/]+)\.json$/;

const MEDIA_TYPES: Record<string, string> = { json: 'application/json', jsonl: 'application/x-ndjson', md: 'text/markdown' };

export type Correction = Extract<Edit, { type: 'correction' }>;
export type Note = Extract<Edit, { type: 'note' }>;

/** What an edit reads. Built from a stored tree, which passed the library checks. */
export interface EditLayer {
  recordingId: string;
  durationMs: number;
  activeRevision: string | null;
  /** Oldest first (by `createdAt`, then ID). */
  revisions: TranscriptRevision[];
  /** As stored, append-only, oldest first. */
  edits: Edit[];
  /** `manifest.purpose`: what the person recorded this for; null when none was given. */
  purpose: string | null;
}

/**
 * What one change adds. `edits` are appended to `edits.jsonl`; `revision` is
 * written as a new `transcript/<id>.json`; `activeRevision` changes which
 * revision the agent view and replay read; `purpose` replaces
 * `manifest.purpose` (null removes it). Nothing else can change.
 */
export interface EditPlan {
  edits: Edit[];
  revision?: TranscriptRevision;
  activeRevision?: string | null;
  purpose?: string | null;
}

export const EMPTY_PLAN: EditPlan = Object.freeze({ edits: [] }) as EditPlan;

export function isEmptyPlan(plan: EditPlan): boolean {
  return plan.edits.length === 0 && plan.revision === undefined && plan.activeRevision === undefined && plan.purpose === undefined;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parse(files: BundleFiles, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new EditError('invalid-bundle', `The recording has no "${path}"`, { path });
  return JSON.parse(decoder.decode(bytes));
}

export function readLayer(files: BundleFiles): EditLayer {
  const manifest = parse(files, MANIFEST_PATH) as {
    recordingId: string;
    durationMs: number;
    transcript?: { activeRevision?: string | null };
    purpose?: string;
  };
  const revisions: TranscriptRevision[] = [];
  for (const path of files.keys()) {
    if (REVISION_PATH.test(path)) revisions.push(parse(files, path) as TranscriptRevision);
  }
  revisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.revisionId.localeCompare(b.revisionId));
  const bytes = files.get(EDITS_PATH);
  const edits = bytes
    ? decoder
        .decode(bytes)
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Edit)
    : [];
  return {
    recordingId: manifest.recordingId,
    durationMs: manifest.durationMs,
    activeRevision: manifest.transcript?.activeRevision ?? null,
    revisions,
    edits,
    purpose: manifest.purpose ?? null,
  };
}

/** IDs of edits that a later edit superseded or retracted. */
export function replacedIds(edits: readonly Edit[]): Set<string> {
  const gone = new Set<string>();
  for (const edit of edits) {
    if (edit.type === 'retract') gone.add(edit.target);
    else if (edit.supersedes !== undefined) gone.add(edit.supersedes);
  }
  return gone;
}

/** Corrections and notes the user still sees: not superseded, not retracted. */
export function activeEdits(edits: readonly Edit[]): Array<Correction | Note> {
  const gone = replacedIds(edits);
  return edits.filter((edit): edit is Correction | Note => edit.type !== 'retract' && !gone.has(edit.id));
}

export function findRevision(layer: EditLayer, revisionId: string): TranscriptRevision {
  const revision = layer.revisions.find((candidate) => candidate.revisionId === revisionId);
  if (!revision) throw new EditError('unknown-revision', `This recording has no transcript revision "${revisionId}"`, { revisionId });
  return revision;
}

/** The next free ID with a prefix (`c3`, `n2`). Readers never parse IDs; writers only keep them unique. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let number = 1;
  while (used.has(`${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

/** Hands out unused edit IDs for one plan. */
export function idSource(layer: EditLayer): (prefix: 'c' | 'n' | 'x') => string {
  const taken = new Set(layer.edits.map((edit) => edit.id));
  return (prefix) => {
    const id = nextId(prefix, taken);
    taken.add(id);
    return id;
  };
}

function mediaType(path: string): string {
  return MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

async function listed(path: string, bytes: Uint8Array): Promise<ManifestFile> {
  return { path, bytes: bytes.length, sha256: await sha256Hex(bytes), mediaType: mediaType(path) };
}

function setListed(manifest: { files: ManifestFile[] }, entry: ManifestFile): void {
  const index = manifest.files.findIndex((file) => file.path === entry.path);
  if (index === -1) manifest.files.push(entry);
  else manifest.files[index] = { ...entry, mediaType: manifest.files[index]!.mediaType };
}

function manifestBytes(manifest: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Writes `plan` onto `files` and returns the new tree. Old bytes of
 * `edits.jsonl` stay as its first bytes; existing revisions and captured
 * files are passed through unchanged. The derived files (agent/*, README.md,
 * AGENTS.md) are always written fresh from the new layers, never kept from the
 * input. The new tree is validated in
 * full: any error throws `invalid-bundle` and nothing is returned.
 */
export async function applyPlan(files: BundleFiles, plan: EditPlan): Promise<Map<string, Uint8Array>> {
  const next = new Map(files);
  const manifest = parse(files, MANIFEST_PATH) as { files: ManifestFile[]; transcript: { activeRevision: string | null }; purpose?: string };

  if (plan.edits.length > 0) {
    const old = files.get(EDITS_PATH) ?? new Uint8Array();
    const separator = old.length > 0 && old[old.length - 1] !== 0x0a ? '\n' : '';
    const added = encoder.encode(separator + plan.edits.map((edit) => `${JSON.stringify(edit)}\n`).join(''));
    const bytes = new Uint8Array(old.length + added.length);
    bytes.set(old, 0);
    bytes.set(added, old.length);
    next.set(EDITS_PATH, bytes);
    setListed(manifest, await listed(EDITS_PATH, bytes));
  }
  if (plan.revision) {
    const path = `transcript/${plan.revision.revisionId}.json`;
    if (files.has(path)) throw new EditError('invalid-bundle', `Revision "${plan.revision.revisionId}" already exists`, { path });
    const bytes = encoder.encode(`${JSON.stringify(plan.revision, null, 2)}\n`);
    next.set(path, bytes);
    setListed(manifest, await listed(path, bytes));
  }
  if (plan.activeRevision !== undefined) manifest.transcript = { ...manifest.transcript, activeRevision: plan.activeRevision };
  if (plan.purpose === null) delete manifest.purpose;
  else if (plan.purpose !== undefined) manifest.purpose = plan.purpose;
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  next.set(MANIFEST_PATH, manifestBytes(manifest));

  // Derived files are always written fresh: one that came in with an imported zip is never kept.
  const derived = await deriveAgentFiles(next);
  const result = await validateBundle(memorySource(derived));
  if (!result.ok) {
    const first = result.errors[0];
    throw new EditError('invalid-bundle', `The edited recording does not validate: ${first?.message ?? 'unknown error'}`, {
      issues: result.errors.slice(0, 20),
    });
  }
  return derived;
}

export const TEXT_LIMITS = { correction: LIMITS.strings.correction, note: LIMITS.strings.note, purpose: LIMITS.strings.purpose } as const;
export const MAX_REVISIONS = LIMITS.revisions;
