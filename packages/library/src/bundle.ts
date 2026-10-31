// Portable bundles: the bundle tree of docs/bundle-schema.md packed into one
// zip file, and the checks that make a zip from anyone safe to store.
//
// The schema (board #16541) owns the meaning of the files. This module owns
// the container: packing, limits, names, the file list and its hashes, the
// schema major version, and applying the file-type allowlist and credential rule
// (both defined once in packages/bundle/src/rules.ts). Field-level validation
// plugs in through `BundleValidator`; @narwal/bundle exports one as `bundleValidator`.
//
// Nothing here evaluates, renders or fetches bundle content. A bundle is bytes
// and parsed JSON; page markup inside rrweb streams stays an inert string.

import { NarwalError } from './errors.ts';
import { ALLOWED_EXTENSIONS, extensionOf, holdsCredentialText, isCredentialKey, isCredentialValue } from '../../bundle/src/rules.ts';
import { assertSafePath } from './paths.ts';
import { DEFAULT_ARCHIVE_LIMITS, openZip, writeZip } from './zip.ts';
import type { ArchiveLimits } from './zip.ts';

export const BUNDLE_FORMAT = 'narwal.bundle';
export const SUPPORTED_SCHEMA_MAJOR = 1;
export const MANIFEST_PATH = 'manifest.json';
export const BUNDLE_FILE_SUFFIX = '.narwal.zip';

const MIB = 1024 * 1024;

export interface BundleLimits extends ArchiveLimits {
  maxManifestBytes: number;
  /** Largest `.json` file other than the manifest. */
  maxJsonBytes: number;
  /** Longest `.jsonl` line outside `rrweb/`. */
  maxJsonlLineBytes: number;
}

// docs/bundle-schema.md §11.
export const DEFAULT_BUNDLE_LIMITS: BundleLimits = Object.freeze({
  ...DEFAULT_ARCHIVE_LIMITS,
  maxManifestBytes: 1 * MIB,
  maxJsonBytes: 16 * MIB,
  maxJsonlLineBytes: 1 * MIB,
});

/** A bundle tree: every file by path, `manifest.json` included. */
export type BundleFiles = ReadonlyMap<string, Uint8Array>;

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}

/** The manifest fields the library reads. Every other field passes through untouched. */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  schemaVersion: string;
  recordingId: string;
  title: string;
  createdAt: string;
  durationMs: number;
  state: 'complete' | 'recovered';
  files: ManifestFile[];
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
}

/** Field-level validator from the schema package (board #16541). */
export type BundleValidator = (files: BundleFiles) => ValidationIssue[] | Promise<ValidationIssue[]>;

/**
 * Writes a tree's derived files (agent/*, README.md, AGENTS.md) fresh from its other
 * files; @narwal/bundle exports one as `deriveAgentFiles`. Export runs it so a derived
 * file that came in with an imported zip never leaves the device as it was.
 */
export type BundleDeriver = (files: BundleFiles) => BundleFiles | Promise<BundleFiles>;

export interface CheckedBundle {
  manifest: BundleManifest;
  files: BundleFiles;
  /** SHA-256 of `manifest.json`. The manifest hashes every other file, so this names the whole content. */
  contentSha256: string;
  /** Sum of all file sizes, manifest included. */
  bytes: number;
  warnings: ValidationIssue[];
}

// Already-compressed media is stored, not deflated.
const STORED_EXTENSIONS = new Set(['webm']);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCHEMA_VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidManifest(why: string, detail: Record<string, unknown> = {}): NarwalError {
  return new NarwalError('manifest-invalid', `Bundle manifest is invalid: ${why}`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new NarwalError('file-invalid-json', `Bundle file "${path}" is not UTF-8 text`, { path });
  }
}

function parseJson(text: string, path: string, line?: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Covers bad syntax and a parser that gives up on very deep nesting.
    throw new NarwalError('file-invalid-json', `Bundle file "${path}" is not valid JSON`, {
      path,
      ...(line === undefined ? {} : { line }),
    });
  }
}

/** Refuses credential-shaped keys and values anywhere in a parsed JSON value. */
function refuseCredentials(root: unknown, path: string, line?: number): void {
  const where = { path, ...(line === undefined ? {} : { line }) };
  // An explicit stack: recursion depth would follow attacker-chosen nesting.
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (isCredentialValue(value)) {
        throw new NarwalError('credential-refused', `"${path}" holds text shaped like an API key or token`, where);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (isCredentialKey(key)) {
          throw new NarwalError('credential-refused', `"${path}" has a credential field "${key.slice(0, 40)}"`, {
            ...where,
            key: key.slice(0, 40),
          });
        }
        stack.push(item);
      }
    }
  }
}

function checkManifest(bytes: Uint8Array, limits: BundleLimits): BundleManifest {
  if (bytes.length > limits.maxManifestBytes) {
    throw invalidManifest('it is too large', { bytes: bytes.length, limit: limits.maxManifestBytes });
  }
  const manifest = parseJson(decodeUtf8(bytes, MANIFEST_PATH), MANIFEST_PATH);
  if (!isRecord(manifest)) throw invalidManifest('it is not an object');
  if (manifest.format !== BUNDLE_FORMAT) throw invalidManifest(`"format" must be "${BUNDLE_FORMAT}"`);

  const version = manifest.schemaVersion;
  const parsed = typeof version === 'string' ? SCHEMA_VERSION.exec(version) : null;
  if (!parsed) throw invalidManifest('"schemaVersion" must be MAJOR.MINOR');
  if (Number(parsed[1]) !== SUPPORTED_SCHEMA_MAJOR) {
    throw new NarwalError(
      'schema-unsupported',
      `This bundle uses schema ${version as string}; this NarWal reads schema ${SUPPORTED_SCHEMA_MAJOR}.x`,
      { schemaVersion: version, supportedMajor: SUPPORTED_SCHEMA_MAJOR },
    );
  }

  if (typeof manifest.recordingId !== 'string' || !IDENTIFIER.test(manifest.recordingId)) {
    throw invalidManifest('"recordingId" is not a valid identifier');
  }
  if (typeof manifest.title !== 'string' || manifest.title.length < 1 || manifest.title.length > 200) {
    throw invalidManifest('"title" must be 1 to 200 characters');
  }
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw invalidManifest('"createdAt" is not a date');
  }
  if (typeof manifest.durationMs !== 'number' || !Number.isFinite(manifest.durationMs) || manifest.durationMs < 0) {
    throw invalidManifest('"durationMs" must be a number of milliseconds');
  }
  if (manifest.state !== 'complete' && manifest.state !== 'recovered') {
    throw invalidManifest('"state" must be "complete" or "recovered"');
  }
  if (!Array.isArray(manifest.files)) throw invalidManifest('"files" must be a list');
  if (manifest.files.length > limits.maxEntries) throw invalidManifest('"files" lists too many files');
  for (const file of manifest.files) {
    if (!isRecord(file)) throw invalidManifest('a "files" item is not an object');
    if (typeof file.path !== 'string') throw invalidManifest('a "files" item has no path');
    assertSafePath(file.path);
    if (file.path === MANIFEST_PATH) throw invalidManifest('"files" must not list manifest.json');
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw invalidManifest('a "files" item has no size', { path: file.path });
    }
    if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) {
      throw invalidManifest('a "files" item has no SHA-256', { path: file.path });
    }
    if (typeof file.mediaType !== 'string' || file.mediaType.length < 1 || file.mediaType.length > 100) {
      throw invalidManifest('a "files" item has no media type', { path: file.path });
    }
  }
  return manifest as unknown as BundleManifest;
}

function checkTextFile(path: string, bytes: Uint8Array, limits: BundleLimits): void {
  const extension = extensionOf(path);
  // rrweb streams hold page text, where a key-shaped string proves nothing;
  // the schema validator reports those as warnings. Replay treats them as data.
  if (path.startsWith('rrweb/')) return;
  if (extension === 'json') {
    if (bytes.length > limits.maxJsonBytes) {
      throw new NarwalError('entry-too-large', `Bundle file "${path}" is larger than NarWal imports`, {
        path,
        bytes: bytes.length,
        limit: limits.maxJsonBytes,
      });
    }
    refuseCredentials(parseJson(decodeUtf8(bytes, path), path), path);
  } else if (extension === 'jsonl') {
    const lines = decodeUtf8(bytes, path).split('\n');
    lines.forEach((text, index) => {
      const line = index + 1;
      if (text === '') {
        // One trailing newline is allowed; any other blank line is not.
        if (index === lines.length - 1) return;
        throw new NarwalError('file-invalid-json', `Bundle file "${path}" has a blank line`, { path, line });
      }
      if (text.length > limits.maxJsonlLineBytes) {
        throw new NarwalError('entry-too-large', `A line in "${path}" is longer than NarWal imports`, { path, line });
      }
      refuseCredentials(parseJson(text, path, line), path, line);
    });
  } else if (extension === 'md') {
    if (holdsCredentialText(decodeUtf8(bytes, path))) {
      throw new NarwalError('credential-refused', `"${path}" holds text shaped like an API key`, { path });
    }
  }
}

/**
 * Checks one bundle tree. Used for a tree the recorder saves, a tree unpacked
 * from an archive and a tree about to be exported, so all three meet one rule.
 */
export async function checkBundleFiles(
  files: BundleFiles,
  options: { limits?: BundleLimits; validate?: BundleValidator } = {},
): Promise<CheckedBundle> {
  const limits = options.limits ?? DEFAULT_BUNDLE_LIMITS;
  const manifestBytes = files.get(MANIFEST_PATH);
  if (!manifestBytes) {
    throw new NarwalError('manifest-missing', 'This file is not a NarWal bundle: it has no manifest.json');
  }
  if (files.size > limits.maxEntries) {
    throw new NarwalError('archive-too-many-entries', 'Bundle holds more files than NarWal accepts', {
      entries: files.size,
      limit: limits.maxEntries,
    });
  }
  const manifest = checkManifest(manifestBytes, limits);
  refuseCredentials(JSON.parse(decodeUtf8(manifestBytes, MANIFEST_PATH)), MANIFEST_PATH);

  const listed = new Map<string, ManifestFile>();
  for (const file of manifest.files) {
    if (listed.has(file.path)) throw invalidManifest('"files" lists a file twice', { path: file.path });
    listed.set(file.path, file);
  }
  let total = manifestBytes.length;
  for (const [path, bytes] of files) {
    if (path === MANIFEST_PATH) continue;
    assertSafePath(path);
    if (!listed.has(path)) {
      throw new NarwalError('file-unlisted', `Bundle holds a file its manifest does not list: "${path}"`, { path });
    }
    if (!ALLOWED_EXTENSIONS.has(extensionOf(path))) {
      throw new NarwalError('file-type-refused', `Bundle holds a file type NarWal does not accept: "${path}"`, {
        path,
      });
    }
    if (bytes.length > limits.maxEntryBytes) {
      throw new NarwalError('entry-too-large', `Bundle file "${path}" is larger than NarWal accepts`, { path });
    }
    total += bytes.length;
    if (total > limits.maxTotalBytes) {
      throw new NarwalError('total-too-large', 'Bundle contents are larger than NarWal accepts', {
        limit: limits.maxTotalBytes,
      });
    }
  }
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    if (!bytes) {
      throw new NarwalError('file-missing', `Bundle is missing a file its manifest lists: "${file.path}"`, {
        path: file.path,
      });
    }
    if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256) {
      throw new NarwalError('file-mismatch', `Bundle file "${file.path}" does not match its manifest`, {
        path: file.path,
      });
    }
    checkTextFile(file.path, bytes, limits);
  }

  const issues = options.validate ? await options.validate(files) : [];
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new NarwalError('validation-failed', `Bundle failed validation: ${(errors[0] as ValidationIssue).message}`, {
      issues: errors.slice(0, 50),
      count: errors.length,
    });
  }
  return {
    manifest,
    files,
    contentSha256: await sha256Hex(manifestBytes),
    bytes: total,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

/** Packs a checked bundle tree. The same tree always gives the same bytes. */
export async function packBundle(
  files: BundleFiles,
  options: { limits?: BundleLimits; validate?: BundleValidator } = {},
): Promise<Uint8Array> {
  const checked = await checkBundleFiles(files, options);
  const order = [MANIFEST_PATH, ...checked.manifest.files.map((file) => file.path)];
  return writeZip(
    order.map((path) => ({
      path,
      bytes: files.get(path) as Uint8Array,
      compress: !STORED_EXTENSIONS.has(extensionOf(path)),
    })),
  );
}

/** Opens an archive from an untrusted source. Throws before returning any content that failed a check. */
export async function unpackBundle(
  archive: Uint8Array,
  options: { limits?: BundleLimits; validate?: BundleValidator } = {},
): Promise<CheckedBundle> {
  const limits = options.limits ?? DEFAULT_BUNDLE_LIMITS;
  const zip = openZip(archive, limits);
  const manifestEntry = zip.entries.find((entry) => entry.path === MANIFEST_PATH);
  if (!manifestEntry) {
    throw new NarwalError('manifest-missing', 'This file is not a NarWal bundle: it has no manifest.json');
  }
  if (manifestEntry.size > limits.maxManifestBytes) {
    throw invalidManifest('it is too large', { bytes: manifestEntry.size, limit: limits.maxManifestBytes });
  }
  // Read and check the manifest before inflating anything else.
  const manifestBytes = await zip.read(MANIFEST_PATH);
  const manifest = checkManifest(manifestBytes, limits);
  const listed = new Map(manifest.files.map((file) => [file.path, file]));

  const files = new Map<string, Uint8Array>([[MANIFEST_PATH, manifestBytes]]);
  for (const entry of zip.entries) {
    if (entry.path === MANIFEST_PATH) continue;
    const file = listed.get(entry.path);
    if (!file) {
      throw new NarwalError('file-unlisted', `Bundle holds a file its manifest does not list: "${entry.path}"`, {
        path: entry.path,
      });
    }
    if (!ALLOWED_EXTENSIONS.has(extensionOf(entry.path))) {
      throw new NarwalError('file-type-refused', `Bundle holds a file type NarWal does not accept: "${entry.path}"`, {
        path: entry.path,
      });
    }
    if (entry.size !== file.bytes) {
      throw new NarwalError('file-mismatch', `Bundle file "${entry.path}" does not match its manifest`, {
        path: entry.path,
      });
    }
    files.set(entry.path, await zip.read(entry.path));
  }
  return checkBundleFiles(files, options);
}

/** A download name from the recording title: ASCII only, never a path. */
export function bundleFileName(manifest: Pick<BundleManifest, 'title' | 'recordingId'>): string {
  const slug = manifest.title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${slug === '' ? 'recording' : slug}-${manifest.recordingId}${BUNDLE_FILE_SUFFIX}`;
}
