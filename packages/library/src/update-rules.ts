// What `RecordingLibrary.update` may change in a stored bundle tree
// (docs/bundle-schema.md §1.4 and §8): capture is immutable, and transcript
// revisions and user edits are append-only layers on top of it.
//
//   captured files      byte for byte the same; none added or removed
//   transcript/*.json   existing revisions unchanged and kept; new ones added
//   edits.jsonl         the new file starts with the old one (append only)
//   agent/*, README.md, AGENTS.md
//                       derived (§9): may be regenerated, added or dropped
//   manifest.json       only `files`, `transcript`, `title` and `purpose` may change

import { MANIFEST_PATH } from './bundle.ts';
import type { BundleFiles } from './bundle.ts';
import { NarwalError } from './errors.ts';

type Layer = 'capture' | 'transcript' | 'edits' | 'derived';

const TRANSCRIPT_REVISION = /^transcript\/[^/]+\.json$/;
const EDITS_PATH = 'edits.jsonl';

// `files` follows the files, a new revision may become active, and the user may rename
// or say what the recording is for.
const UPDATABLE_MANIFEST_FIELDS = new Set(['files', 'transcript', 'title', 'purpose']);
const DERIVED_ROOT_FILES = new Set(['README.md', 'AGENTS.md']);

const RULE =
  'An update may add transcript revisions, notes and corrections, and regenerate agent files. It cannot change what was captured.';

function layerOf(path: string): Layer {
  if (TRANSCRIPT_REVISION.test(path)) return 'transcript';
  if (path === EDITS_PATH) return 'edits';
  if (path.startsWith('agent/') || DERIVED_ROOT_FILES.has(path)) return 'derived';
  return 'capture';
}

function refuse(path: string, reason: string): NarwalError {
  return new NarwalError('update-refused', `${RULE} Refused: ${reason} "${path}".`, { path, reason });
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && startsWith(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON equality ignoring key order. An explicit stack: an imported manifest chooses its own nesting. */
function sameJson(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [unknown, unknown];
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      x.forEach((item, index) => stack.push([item, y[index]]));
    } else if (isObject(x) || isObject(y)) {
      if (!isObject(x) || !isObject(y)) return false;
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(y, key)) return false;
        stack.push([x[key], y[key]]);
      }
    } else if (x !== y) {
      return false;
    }
  }
  return true;
}

function lockedManifest(bytes: Uint8Array): Record<string, unknown> {
  // Both manifests passed checkBundleFiles, so they parse to objects.
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  for (const field of UPDATABLE_MANIFEST_FIELDS) delete manifest[field];
  return manifest;
}

/**
 * Throws `update-refused` unless `after` only adds layers to `before`. Both
 * trees are whole (manifest included) and have passed checkBundleFiles.
 */
export function checkLayersOnly(before: BundleFiles, after: BundleFiles): void {
  const paths = new Set([...before.keys(), ...after.keys()]);
  paths.delete(MANIFEST_PATH);
  for (const path of [...paths].sort()) {
    const old = before.get(path);
    const next = after.get(path);
    switch (layerOf(path)) {
      case 'derived':
        break;
      case 'capture':
        if (!old) throw refuse(path, 'adds captured file');
        if (!next) throw refuse(path, 'removes captured file');
        if (!sameBytes(old, next)) throw refuse(path, 'changes captured file');
        break;
      case 'transcript':
        if (!old) break;
        if (!next) throw refuse(path, 'removes transcript revision');
        if (!sameBytes(old, next)) throw refuse(path, 'changes transcript revision');
        break;
      case 'edits':
        if (!old) break;
        if (!next) throw refuse(path, 'removes');
        if (!startsWith(next, old)) throw refuse(path, 'rewrites earlier lines of');
        break;
    }
  }
  const oldManifest = before.get(MANIFEST_PATH);
  const newManifest = after.get(MANIFEST_PATH);
  if (!oldManifest || !newManifest || !sameJson(lockedManifest(oldManifest), lockedManifest(newManifest))) {
    throw refuse(MANIFEST_PATH, 'changes captured fields of');
  }
}
