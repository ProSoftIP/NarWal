// Bounded import validation for schema 1.1 (docs/bundle-schema.md §11).
// Runs in Node and in the extension: no Node APIs, only Web Crypto and TextDecoder.

import { LIMITS, SUPPORTED_MAJOR, SUPPORTED_MINOR } from './limits.ts';
import { README_PATHS, buildAgentView, renderMarkdown, renderReadme, stableJson } from './agent-view.ts';
import { memorySource } from './memory-source.ts';
import { ALLOWED_EXTENSIONS, extensionOf, holdsCredentialText, isCredentialKey, isCredentialValue, unsafePathReason } from './rules.ts';
import type {
  Bundle,
  BundleSource,
  ClockPair,
  DocumentRecord,
  Edit,
  Gap,
  Issue,
  Manifest,
  Observation,
  TranscriptRevision,
  UnknownObservation,
  ValidationResult,
  WindowRecord,
} from './types.ts';

const MAX_ISSUES = 200;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// ARIA role tokens are letters, digits and hyphens ("doc-abstract"). Roles come from page
// markup, so anything else is refused rather than carried into the agent export.
const ROLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const REQUIRED_FILES = ['documents.json', 'observations.jsonl', 'gaps.jsonl'];
const AGENT_MD = 'agent/walkthrough.md';
const AGENT_JSON = 'agent/walkthrough.json';

const KIND_BASIS: Record<string, string> = {
  recording: 'observed',
  route: 'observed',
  'pointer-dwell': 'derived',
  click: 'observed',
  scroll: 'observed',
  selection: 'observed',
  input: 'observed',
  'marker-element': 'user-marked',
  'marker-region': 'user-marked',
  exclusion: 'observed',
  visibility: 'observed',
  viewport: 'observed',
  window: 'observed',
};
const TAB_LEVEL_KINDS = new Set(['recording', 'visibility', 'viewport', 'window']);

const GAP_REASONS: Record<string, string[]> = {
  page: ['restricted-page', 'navigation-blind-window', 'lost-messages', 'injection-failed', 'recorder-paused', 'tab-hidden'],
  frame: ['cross-origin-frame', 'closed-shadow-root', 'canvas-not-recorded'],
  audio: ['mic-denied', 'mic-track-ended', 'mic-device-lost', 'recorder-error', 'recorder-paused'],
  any: ['recovery-truncated'],
};
const TRANSCRIPT_GAP_REASONS = [
  'connect-failed',
  'disconnected',
  'provider-error',
  'rate-limited',
  'auth-failed',
  'user-stopped-provider',
  'not-transcribed',
];
const ROUTE_TRANSITIONS = [
  'load',
  'link',
  'typed',
  'reload',
  'back-forward',
  'form-submit',
  'history-push',
  'history-replace',
  'popstate',
  'hash',
  'other',
];
const NAME_SOURCES = ['aria-label', 'aria-labelledby', 'label', 'alt', 'title', 'placeholder', 'text', 'none'];

interface Where {
  file: string;
  line?: number;
}

type Obj = Record<string, unknown>;

class Ctx {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  /** True when the bundle declares a newer minor version than this reader. */
  newerMinor = false;
  durationMs = LIMITS.durationMs;

  error(code: string, message: string, where?: Where): void {
    push(this.errors, 'error', code, message, where);
  }

  warn(code: string, message: string, where?: Where): void {
    push(this.warnings, 'warning', code, message, where);
  }

  /** Same-version unknown values are writer bugs; newer-minor ones are expected (§10). */
  unknown(code: string, message: string, where?: Where): void {
    if (this.newerMinor) this.warn(`W_${code}`, message, where);
    else this.error(`E_${code}`, message, where);
  }
}

function push(list: Issue[], severity: Issue['severity'], code: string, message: string, where?: Where): void {
  if (list.length === MAX_ISSUES) list.push({ severity, code: 'TOO_MANY', message: `more than ${MAX_ISSUES} issues; rest omitted` });
  if (list.length > MAX_ISSUES) return;
  const issue: Issue = { severity, code, message };
  if (where) {
    issue.file = where.file;
    if (where.line !== undefined) issue.line = where.line;
  }
  list.push(issue);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function label(where: Where): string {
  return where.line === undefined ? where.file : `${where.file}:${where.line}`;
}

// ---------- field checks ----------

interface StrOpts {
  max: number;
  optional?: boolean;
  nullable?: boolean;
  min?: number;
  oneOf?: readonly string[];
  pattern?: RegExp;
}

function str(ctx: Ctx, o: Obj, key: string, w: Where, opts: StrOpts): string | null | undefined {
  const v = o[key];
  if (v === undefined) {
    if (!opts.optional) ctx.error('E_FIELD', `missing "${key}"`, w);
    return undefined;
  }
  if (v === null) {
    if (!opts.nullable) ctx.error('E_FIELD', `"${key}" must not be null`, w);
    return null;
  }
  if (typeof v !== 'string') {
    ctx.error('E_FIELD', `"${key}" must be a string`, w);
    return undefined;
  }
  if (v.length > opts.max) ctx.error('E_LIMIT', `"${key}" is longer than ${opts.max} characters`, w);
  if (v.length < (opts.min ?? 0)) ctx.error('E_FIELD', `"${key}" is shorter than ${opts.min} characters`, w);
  if (opts.pattern && !opts.pattern.test(v)) ctx.error('E_FIELD', `"${key}" has an invalid format`, w);
  if (opts.oneOf && !opts.oneOf.includes(v)) ctx.unknown('UNKNOWN_VALUE', `"${key}" value "${v}" is not defined`, w);
  return v;
}

interface NumOpts {
  min?: number;
  max?: number;
  int?: boolean;
  optional?: boolean;
  nullable?: boolean;
}

function num(ctx: Ctx, o: Obj, key: string, w: Where, opts: NumOpts = {}): number | null | undefined {
  const v = o[key];
  if (v === undefined) {
    if (!opts.optional) ctx.error('E_FIELD', `missing "${key}"`, w);
    return undefined;
  }
  if (v === null) {
    if (!opts.nullable) ctx.error('E_FIELD', `"${key}" must not be null`, w);
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    ctx.error('E_FIELD', `"${key}" must be a finite number`, w);
    return undefined;
  }
  if (opts.int && !Number.isInteger(v)) ctx.error('E_FIELD', `"${key}" must be an integer`, w);
  if (opts.min !== undefined && v < opts.min) ctx.error('E_FIELD', `"${key}" must be at least ${opts.min}`, w);
  if (opts.max !== undefined && v > opts.max) ctx.error('E_LIMIT', `"${key}" must be at most ${opts.max}`, w);
  return v;
}

function bool(ctx: Ctx, o: Obj, key: string, w: Where): void {
  const v = o[key];
  if (v !== undefined && typeof v !== 'boolean') ctx.error('E_FIELD', `"${key}" must be a boolean`, w);
}

/** A session time: 0 ≤ t ≤ durationMs + tolerance. */
function time(ctx: Ctx, o: Obj, key: string, w: Where, opts: { optional?: boolean; nullable?: boolean } = {}): number | null | undefined {
  const v = num(ctx, o, key, w, opts);
  if (typeof v === 'number' && (v < 0 || v > ctx.durationMs + LIMITS.endToleranceMs)) {
    ctx.error('E_TIME', `"${key}" ${v} is outside the recording (0..${ctx.durationMs} ms)`, w);
  }
  return v;
}

function span(ctx: Ctx, o: Obj, startKey: string, endKey: string, w: Where, endOptional = false): void {
  const start = time(ctx, o, startKey, w);
  const end = time(ctx, o, endKey, w, { optional: endOptional, nullable: endOptional });
  if (typeof start === 'number' && typeof end === 'number' && end < start) {
    ctx.error('E_TIME', `"${endKey}" is before "${startKey}"`, w);
  }
}

function id(ctx: Ctx, o: Obj, key: string, w: Where, seen?: Set<string>): string | undefined {
  const v = str(ctx, o, key, w, { max: 64, pattern: ID });
  if (typeof v !== 'string') return undefined;
  if (seen) {
    if (seen.has(v)) ctx.error('E_DUP_ID', `duplicate id "${v}"`, w);
    seen.add(v);
  }
  return v;
}

function fields(ctx: Ctx, o: Obj, allowed: readonly string[], w: Where, what: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) ctx.warn('W_UNKNOWN_FIELD', `${what}: unknown field "${key}"`, w);
  }
}

function point(ctx: Ctx, v: unknown, key: string, w: Where): void {
  if (!isObj(v)) return ctx.error('E_FIELD', `"${key}" must be {x, y}`, w);
  num(ctx, v, 'x', w);
  num(ctx, v, 'y', w);
}

function rect(ctx: Ctx, v: unknown, key: string, w: Where): void {
  if (!isObj(v)) return ctx.error('E_FIELD', `"${key}" must be {x, y, w, h}`, w);
  num(ctx, v, 'x', w);
  num(ctx, v, 'y', w);
  num(ctx, v, 'w', w, { min: 0 });
  num(ctx, v, 'h', w, { min: 0 });
}

function elementRef(ctx: Ctx, v: unknown, key: string, w: Where): void {
  if (!isObj(v)) return ctx.error('E_FIELD', `"${key}" must be an element reference`, w);
  fields(ctx, v, ['node', 'tag', 'role', 'name', 'nameSource', 'box', 'excluded'], w, key);
  num(ctx, v, 'node', w, { int: true, min: 0, nullable: true });
  str(ctx, v, 'tag', w, { max: 64, min: 1 });
  str(ctx, v, 'role', w, { max: 64, nullable: true, pattern: ROLE });
  str(ctx, v, 'name', w, { max: LIMITS.strings.elementName, optional: true });
  str(ctx, v, 'nameSource', w, { max: 32, oneOf: NAME_SOURCES });
  if (v.box !== undefined) rect(ctx, v.box, `${key}.box`, w);
  bool(ctx, v, 'excluded', w);
  if (v.excluded === true && (v.name !== undefined || v.nameSource !== 'none')) {
    ctx.error('E_PRIVACY', `"${key}" is in an excluded region but carries a name`, w);
  }
}

// ---------- bytes and JSON ----------

const decoder = new TextDecoder('utf-8', { fatal: true });

function decode(ctx: Ctx, bytes: Uint8Array, w: Where): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    ctx.error('E_ENCODING', 'not valid UTF-8', w);
    return undefined;
  }
}

function depthOf(value: unknown, limit: number): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (d > max) max = d;
    if (max > limit) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return max;
}

function parseJson(ctx: Ctx, bytes: Uint8Array, w: Where, depthLimit: number): unknown {
  const text = decode(ctx, bytes, w);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    ctx.error('E_JSON', `invalid JSON: ${(e as Error).message}`, w);
    return undefined;
  }
  if (depthOf(value, depthLimit) > depthLimit) {
    ctx.error('E_LIMIT', `JSON nesting deeper than ${depthLimit}`, w);
    return undefined;
  }
  return value;
}

/** Parses JSONL with a per-line byte limit; returns objects with their 1-based line numbers. */
function parseJsonl(
  ctx: Ctx,
  bytes: Uint8Array,
  file: string,
  lineLimit: number,
  depthLimit: number,
  maxRecords: number,
): { value: Obj; line: number }[] {
  const out: { value: Obj; line: number }[] = [];
  let start = 0;
  let line = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end === -1) end = bytes.length;
    line += 1;
    const w = { file, line };
    if (end - start > lineLimit) {
      ctx.error('E_LIMIT', `line longer than ${lineLimit} bytes`, w);
      return out;
    }
    if (end === start) {
      ctx.error('E_JSONL', 'blank line', w);
    } else {
      const value = parseJson(ctx, bytes.subarray(start, end), w, depthLimit);
      if (value !== undefined) {
        if (!isObj(value)) ctx.error('E_JSONL', 'each line must be a JSON object', w);
        else out.push({ value, line });
      }
    }
    if (out.length > maxRecords) {
      ctx.error('E_LIMIT', `more than ${maxRecords} records`, w);
      return out;
    }
    start = end + 1;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The path rule packages/library applies to archive entries (rules.ts). */
function validPath(path: string): boolean {
  return unsafePathReason(path) === null;
}

/** Refuses credential-shaped keys and strings (§11). In rrweb streams string hits are warnings. */
function scanCredentials(ctx: Ctx, value: unknown, w: Where, rrweb: boolean): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (isCredentialValue(v)) {
        if (rrweb) ctx.warn('W_CREDENTIAL', 'page text looks like a credential', w);
        else ctx.error('E_CREDENTIAL', 'a string looks like a credential', w);
      }
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (isObj(v)) {
      for (const [key, child] of Object.entries(v)) {
        if (!rrweb && isCredentialKey(key)) ctx.error('E_CREDENTIAL', `credential-shaped field "${key}"`, w);
        stack.push(child);
      }
    }
  }
}

// ---------- URL policy ----------

function urlField(ctx: Ctx, o: Obj, key: string, w: Where, policy: string): void {
  const url = str(ctx, o, key, w, { max: LIMITS.strings.url, min: 1 });
  if (typeof url !== 'string') return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return ctx.error('E_FIELD', `"${key}" is not an absolute URL`, w);
  }
  if (policy === 'path-only' && (parsed.search !== '' || parsed.hash !== '')) {
    ctx.error('E_PRIVACY', `"${key}" has a query or fragment under urlPolicy path-only`, w);
  }
  if (policy === 'redact-query-values') {
    const leaks = [...parsed.searchParams.values()].some((value) => value !== '' && value !== '_');
    const fragment = parsed.hash.includes('=') ? new URLSearchParams(parsed.hash.slice(parsed.hash.indexOf('?') + 1)) : null;
    const fragmentLeaks = fragment ? [...fragment.values()].some((value) => value !== '' && value !== '_') : false;
    if (leaks || fragmentLeaks) ctx.error('E_PRIVACY', `"${key}" keeps query values under urlPolicy redact-query-values`, w);
  }
}

// ---------- records ----------

function checkManifest(ctx: Ctx, m: unknown, w: Where): Manifest | undefined {
  if (!isObj(m)) {
    ctx.error('E_FORMAT', 'manifest.json must be a JSON object', w);
    return undefined;
  }
  if (m.format !== 'narwal.bundle') {
    ctx.error('E_FORMAT', 'manifest "format" must be "narwal.bundle"', w);
    return undefined;
  }
  const version = typeof m.schemaVersion === 'string' ? /^(\d+)\.(\d+)$/.exec(m.schemaVersion) : null;
  if (!version) {
    ctx.error('E_VERSION', 'manifest "schemaVersion" must be MAJOR.MINOR', w);
    return undefined;
  }
  if (Number(version[1]) !== SUPPORTED_MAJOR) {
    ctx.error('E_VERSION', `schema major version ${version[1]} is not supported (reader: ${SUPPORTED_MAJOR})`, w);
    return undefined;
  }
  if (Number(version[2]) > SUPPORTED_MINOR) {
    ctx.newerMinor = true;
    ctx.warn('W_NEWER_MINOR', `bundle is ${m.schemaVersion}; this reader knows ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}`, w);
  }
  fields(
    ctx,
    m,
    ['format', 'schemaVersion', 'recordingId', 'title', 'purpose', 'createdAt', 'producer', 'environment', 'clock', 'durationMs', 'state', 'privacy', 'derivation', 'audio', 'transcript', 'files'],
    w,
    'manifest',
  );
  str(ctx, m, 'recordingId', w, { max: 64, pattern: ID });
  str(ctx, m, 'title', w, { max: LIMITS.strings.title, min: 1 });
  str(ctx, m, 'purpose', w, { max: LIMITS.strings.purpose, min: 1, optional: true });
  str(ctx, m, 'createdAt', w, { max: 40, pattern: ISO });
  for (const [key, subkeys] of [
    ['producer', ['name', 'version']],
    ['environment', ['browser', 'browserVersion', 'platform']],
  ] as const) {
    const sub = m[key];
    if (!isObj(sub)) ctx.error('E_FIELD', `"${key}" must be an object`, w);
    else for (const k of subkeys) str(ctx, sub, k, w, { max: LIMITS.strings.short });
  }
  if (!isObj(m.clock)) ctx.error('E_FIELD', '"clock" must be an object', w);
  else num(ctx, m.clock, 'originEpochMs', w, { min: 0 });
  const duration = num(ctx, m, 'durationMs', w, { min: 0, max: LIMITS.durationMs });
  if (typeof duration === 'number') ctx.durationMs = duration;
  str(ctx, m, 'state', w, { max: 16, oneOf: ['complete', 'recovered'] });

  if (!isObj(m.privacy)) ctx.error('E_FIELD', '"privacy" must be an object', w);
  else {
    str(ctx, m.privacy, 'inputValues', w, { max: 32, oneOf: ['masked', 'revealed-by-user'] });
    num(ctx, m.privacy, 'excludedRegions', w, { int: true, min: 0 });
    str(ctx, m.privacy, 'urlPolicy', w, { max: 32, oneOf: ['redact-query-values', 'path-only', 'full'] });
    str(ctx, m.privacy, 'audio', w, { max: 32, oneOf: ['not-redacted'] });
  }
  if (!isObj(m.derivation)) ctx.error('E_FIELD', '"derivation" must be an object', w);
  else num(ctx, m.derivation, 'pointerDwellMinMs', w, { min: 0 });

  if (m.audio === undefined) ctx.error('E_FIELD', 'missing "audio" (use null when there is no narration)', w);
  else if (m.audio !== null) {
    if (!isObj(m.audio)) ctx.error('E_FIELD', '"audio" must be an object or null', w);
    else {
      str(ctx, m.audio, 'file', w, { max: LIMITS.pathChars });
      str(ctx, m.audio, 'mediaType', w, { max: LIMITS.strings.short });
      str(ctx, m.audio, 'clock', w, { max: LIMITS.pathChars });
      time(ctx, m.audio, 'startMs', w);
      num(ctx, m.audio, 'decodedMs', w, { min: 0 });
    }
  }
  if (!isObj(m.transcript)) ctx.error('E_FIELD', '"transcript" must be an object', w);
  else str(ctx, m.transcript, 'activeRevision', w, { max: 64, pattern: ID, nullable: true });

  if (!Array.isArray(m.files)) {
    ctx.error('E_FIELD', '"files" must be an array', w);
    return undefined;
  }
  if (m.files.length > LIMITS.files) ctx.error('E_LIMIT', `more than ${LIMITS.files} files`, w);
  const paths = new Set<string>();
  for (const [i, f] of m.files.entries()) {
    const fw = { file: w.file, line: undefined };
    if (!isObj(f)) {
      ctx.error('E_FIELD', `files[${i}] must be an object`, fw);
      continue;
    }
    const path = str(ctx, f, 'path', fw, { max: LIMITS.pathChars });
    if (typeof path === 'string') {
      if (!validPath(path) || path === 'manifest.json') ctx.error('E_PATH', `files[${i}] path "${path}" is not allowed`, fw);
      if (paths.has(path)) ctx.error('E_DUP_ID', `files lists "${path}" twice`, fw);
      paths.add(path);
    }
    num(ctx, f, 'bytes', fw, { int: true, min: 0 });
    str(ctx, f, 'sha256', fw, { max: 64, pattern: SHA256 });
    str(ctx, f, 'mediaType', fw, { max: LIMITS.strings.short });
  }
  return m as unknown as Manifest;
}

// The windows a recording followed (schema 1.1, board #16754): w1 is the tab
// it started in, each later one was opened by a recorded window.
function checkWindows(ctx: Ctx, value: unknown, w: Where): WindowRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 2) {
    ctx.error('E_FIELD', '"windows" must list at least two windows, or be left out', w);
    return [];
  }
  if (value.length > LIMITS.windows) ctx.error('E_LIMIT', `more than ${LIMITS.windows} windows`, w);
  const keys = new Set<string>();
  value.forEach((win, i) => {
    if (!isObj(win)) {
      ctx.error('E_FIELD', 'each window must be an object', w);
      return;
    }
    fields(ctx, win, ['key', 'opener', 'type', 'openedMs', 'closedMs'], w, 'window');
    id(ctx, win, 'key', w, keys);
    str(ctx, win, 'opener', w, { max: 64, nullable: true });
    str(ctx, win, 'type', w, { max: 16, oneOf: ['tab', 'popup'] });
    span(ctx, win, 'openedMs', 'closedMs', w, true);
    if (i === 0 && win.opener !== null) ctx.error('E_FIELD', `the first window "${win.key}" is where recording started and has no opener`, w);
    if (i > 0 && typeof win.opener === 'string' && !keys.has(win.opener)) {
      ctx.error('E_REF', `window "${win.key}" opener "${win.opener}" is not an earlier window`, w);
    }
    if (i > 0 && win.opener === null) ctx.error('E_FIELD', `window "${win.key}" needs the window that opened it`, w);
  });
  return value as WindowRecord[];
}

function checkDocuments(ctx: Ctx, value: unknown, w: Where, policy: string): { documents: DocumentRecord[]; windows: WindowRecord[] } {
  if (!isObj(value) || !Array.isArray(value.documents)) {
    ctx.error('E_FIELD', 'documents.json must be {"documents": [...]}', w);
    return { documents: [], windows: [] };
  }
  fields(ctx, value, ['documents', 'windows'], w, 'documents.json');
  const windows = checkWindows(ctx, value.windows, w);
  const windowKeys = new Set(windows.map((win) => win.key));
  const docs = value.documents;
  if (docs.length > LIMITS.documents) ctx.error('E_LIMIT', `more than ${LIMITS.documents} documents`, w);
  const keys = new Set<string>();
  for (const d of docs) {
    if (!isObj(d)) {
      ctx.error('E_FIELD', 'each document must be an object', w);
      continue;
    }
    const dw = { file: w.file, line: undefined };
    fields(
      ctx,
      d,
      ['key', 'browserDocumentId', 'frameId', 'parentKey', 'frameNode', 'url', 'title', 'navigationType', 'transition', 'attachedMs', 'detachedMs', 'attachments', 'capture', 'rrweb', 'window'],
      dw,
      'document',
    );
    const win = str(ctx, d, 'window', dw, { max: 64, optional: true });
    if (windows.length && win === undefined) ctx.error('E_FIELD', `document "${d.key}" needs "window": documents.json lists windows`, dw);
    if (typeof win === 'string' && !windowKeys.has(win)) ctx.error('E_REF', `document "${d.key}" window "${win}" does not exist`, dw);
    id(ctx, d, 'key', dw, keys);
    str(ctx, d, 'browserDocumentId', dw, { max: LIMITS.strings.short, optional: true });
    num(ctx, d, 'frameId', dw, { int: true, min: 0 });
    str(ctx, d, 'parentKey', dw, { max: 64, nullable: true });
    num(ctx, d, 'frameNode', dw, { int: true, min: 0, nullable: true });
    urlField(ctx, d, 'url', dw, policy);
    str(ctx, d, 'title', dw, { max: LIMITS.strings.title });
    str(ctx, d, 'navigationType', dw, { max: 32 });
    str(ctx, d, 'transition', dw, { max: 32 });
    span(ctx, d, 'attachedMs', 'detachedMs', dw, true);
    str(ctx, d, 'capture', dw, { max: 16, oneOf: ['full', 'partial', 'none'] });
    const rr = str(ctx, d, 'rrweb', dw, { max: LIMITS.pathChars, nullable: true });
    if (d.capture === 'none' && rr !== null) ctx.error('E_FIELD', `document "${d.key}" has capture none but an rrweb stream`, dw);
    if (d.frameId === 0 && d.parentKey !== null) ctx.error('E_FIELD', `top-frame document "${d.key}" has a parentKey`, dw);
    if (!Array.isArray(d.attachments)) ctx.error('E_FIELD', '"attachments" must be an array', dw);
    else
      for (const a of d.attachments) {
        if (!isObj(a)) {
          ctx.error('E_FIELD', 'each attachment must be an object', dw);
          continue;
        }
        time(ctx, a, 'atMs', dw);
        str(ctx, a, 'reason', dw, { max: 32, oneOf: ['boot', 'bfcache-restore', 'reconnect'] });
      }
  }
  for (const d of docs) {
    if (isObj(d) && typeof d.parentKey === 'string' && !keys.has(d.parentKey)) {
      ctx.error('E_REF', `document "${d.key}" parentKey "${d.parentKey}" does not exist`, w);
    }
    const parent = isObj(d) && typeof d.parentKey === 'string' ? docs.find((p) => isObj(p) && p.key === d.parentKey) : undefined;
    if (isObj(d) && isObj(parent) && d.window !== parent.window) {
      ctx.error('E_FIELD', `document "${d.key}" is a frame of "${d.parentKey}" but in another window`, w);
    }
  }
  return { documents: docs as DocumentRecord[], windows };
}

const OBSERVATION_FIELDS: Record<string, string[]> = {
  recording: ['state'],
  route: ['url', 'title', 'transition'],
  'pointer-dwell': ['target', 'scroll'],
  click: ['target', 'button', 'count', 'point', 'scroll'],
  scroll: ['target', 'from', 'to'],
  selection: ['target', 'text', 'scroll'],
  input: ['target', 'inputType', 'value', 'checked', 'count', 'scroll'],
  'marker-element': ['target', 'via', 'point', 'scroll'],
  'marker-region': ['rect', 'scroll', 'contains', 'text'],
  exclusion: ['state', 'target', 'rect', 'scroll'],
  visibility: ['state'],
  viewport: ['w', 'h', 'dpr'],
  window: ['window', 'state', 'opener', 'url', 'title'],
};

function checkObservation(ctx: Ctx, o: Obj, w: Where, manifest: Manifest, ids: Set<string>, docKeys: Set<string>, windowKeys: Set<string>): void {
  id(ctx, o, 'id', w, ids);
  const kind = str(ctx, o, 'kind', w, { max: 64, min: 1 });
  str(ctx, o, 'basis', w, { max: 16, oneOf: ['observed', 'derived', 'user-marked'] });
  const endRequired = kind === 'pointer-dwell' || kind === 'scroll' || kind === 'marker-region';
  span(ctx, o, 'atMs', 'endMs', w, !endRequired);
  const doc = str(ctx, o, 'doc', w, { max: 64, optional: true });
  if (typeof doc === 'string' && !docKeys.has(doc)) ctx.error('E_REF', `doc "${doc}" does not exist`, w);
  if (typeof kind !== 'string') return;

  const extra = OBSERVATION_FIELDS[kind];
  if (!extra) {
    ctx.unknown('UNKNOWN_KIND', `observation kind "${kind}" is not defined in ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}`, w);
    return;
  }
  fields(ctx, o, ['id', 'kind', 'basis', 'atMs', 'endMs', 'doc', ...extra], w, kind);
  if (kind !== 'scroll' && kind !== 'marker-region' && o.scroll !== undefined) point(ctx, o.scroll, 'scroll', w);
  if (o.basis !== KIND_BASIS[kind]) ctx.error('E_FIELD', `${kind} must have basis "${KIND_BASIS[kind]}"`, w);
  if (doc === undefined && !TAB_LEVEL_KINDS.has(kind)) ctx.error('E_FIELD', `${kind} needs "doc"`, w);

  switch (kind) {
    case 'recording':
      str(ctx, o, 'state', w, { max: 16, oneOf: ['started', 'paused', 'resumed', 'stopped'] });
      break;
    case 'route':
      urlField(ctx, o, 'url', w, manifest.privacy?.urlPolicy);
      str(ctx, o, 'title', w, { max: LIMITS.strings.title, optional: true });
      str(ctx, o, 'transition', w, { max: 32, oneOf: ROUTE_TRANSITIONS });
      break;
    case 'pointer-dwell': {
      elementRef(ctx, o.target, 'target', w);
      const min = manifest.derivation?.pointerDwellMinMs ?? 0;
      if (typeof o.atMs === 'number' && typeof o.endMs === 'number' && o.endMs - o.atMs < min) {
        ctx.error('E_FIELD', `pointer-dwell shorter than derivation.pointerDwellMinMs (${min} ms)`, w);
      }
      break;
    }
    case 'click':
      elementRef(ctx, o.target, 'target', w);
      str(ctx, o, 'button', w, { max: 16, oneOf: ['left', 'middle'] });
      if (o.count !== 1 && o.count !== 2) ctx.error('E_FIELD', '"count" must be 1 or 2', w);
      point(ctx, o.point, 'point', w);
      break;
    case 'scroll':
      if (o.target !== null) elementRef(ctx, o.target, 'target', w);
      point(ctx, o.from, 'from', w);
      point(ctx, o.to, 'to', w);
      break;
    case 'selection':
      elementRef(ctx, o.target, 'target', w);
      str(ctx, o, 'text', w, { max: LIMITS.strings.selection, optional: true });
      if (isObj(o.target) && o.target.excluded === true && o.text !== undefined) {
        ctx.error('E_PRIVACY', 'selection inside an excluded region carries text', w);
      }
      break;
    case 'input': {
      elementRef(ctx, o.target, 'target', w);
      str(ctx, o, 'inputType', w, { max: 32 });
      bool(ctx, o, 'checked', w);
      num(ctx, o, 'count', w, { int: true, min: 1, optional: true });
      const value = o.value;
      if (!isObj(value)) ctx.error('E_FIELD', '"value" must be {state}', w);
      else if (value.state === 'masked') {
        if (Object.keys(value).length !== 1) ctx.error('E_PRIVACY', 'a masked input value carries more than its state', w);
      } else if (value.state === 'revealed') {
        str(ctx, value, 'text', w, { max: LIMITS.strings.selection });
        if (manifest.privacy?.inputValues !== 'revealed-by-user') {
          ctx.error('E_PRIVACY', 'revealed input value but privacy.inputValues is not revealed-by-user', w);
        }
      } else ctx.error('E_FIELD', 'value.state must be masked or revealed', w);
      break;
    }
    case 'marker-element': {
      elementRef(ctx, o.target, 'target', w);
      const via = str(ctx, o, 'via', w, { max: 32, optional: true, oneOf: ['right-click', 'keyboard-focus', 'keyboard-pointer'] });
      if (via === 'keyboard-focus') {
        if (o.point !== undefined) ctx.error('E_FIELD', 'a keyboard-focus marker has no point', w);
      } else point(ctx, o.point, 'point', w);
      break;
    }
    case 'marker-region':
      rect(ctx, o.rect, 'rect', w);
      point(ctx, o.scroll, 'scroll', w);
      if (!Array.isArray(o.contains) || o.contains.length > 10) ctx.error('E_FIELD', '"contains" must be an array of at most 10', w);
      else for (const el of o.contains) elementRef(ctx, el, 'contains[]', w);
      str(ctx, o, 'text', w, { max: LIMITS.strings.selection, optional: true });
      if (Array.isArray(o.contains) && o.contains.some((el) => isObj(el) && el.excluded === true) && o.text !== undefined) {
        ctx.error('E_PRIVACY', 'a box over an excluded region carries text', w);
      }
      break;
    case 'exclusion':
      str(ctx, o, 'state', w, { max: 16, oneOf: ['added', 'removed'] });
      if (o.target === undefined && o.rect === undefined) ctx.error('E_FIELD', 'exclusion needs "target" or "rect"', w);
      if (o.target !== undefined) {
        elementRef(ctx, o.target, 'target', w);
        if (isObj(o.target) && o.target.excluded !== true) ctx.error('E_PRIVACY', 'exclusion target must have excluded: true', w);
      }
      if (o.rect !== undefined) rect(ctx, o.rect, 'rect', w);
      break;
    case 'visibility':
      str(ctx, o, 'state', w, { max: 16, oneOf: ['visible', 'hidden'] });
      break;
    case 'viewport':
      num(ctx, o, 'w', w, { min: 0 });
      num(ctx, o, 'h', w, { min: 0 });
      num(ctx, o, 'dpr', w, { min: 0 });
      break;
    case 'window': {
      const win = str(ctx, o, 'window', w, { max: 64 });
      if (typeof win === 'string' && !windowKeys.has(win)) ctx.error('E_REF', `window "${win}" does not exist`, w);
      const state = str(ctx, o, 'state', w, { max: 16, oneOf: ['opened', 'focused', 'closed'] });
      const opener = str(ctx, o, 'opener', w, { max: 64, optional: true });
      if (typeof opener === 'string' && !windowKeys.has(opener)) ctx.error('E_REF', `opener window "${opener}" does not exist`, w);
      if (state !== 'opened' && (o.opener !== undefined || o.url !== undefined || o.title !== undefined)) {
        ctx.error('E_FIELD', 'only an opened window carries opener, url and title', w);
      }
      if (o.url !== undefined) urlField(ctx, o, 'url', w, manifest.privacy?.urlPolicy);
      str(ctx, o, 'title', w, { max: LIMITS.strings.title, optional: true });
      break;
    }
  }
}

function checkGap(ctx: Ctx, g: Obj, w: Where, ids: Set<string>, docKeys: Set<string>, windowKeys: Set<string>): void {
  fields(ctx, g, ['id', 'scope', 'startMs', 'endMs', 'reason', 'doc', 'window', 'detail'], w, 'gap');
  id(ctx, g, 'id', w, ids);
  const scope = str(ctx, g, 'scope', w, { max: 16, oneOf: Object.keys(GAP_REASONS) });
  span(ctx, g, 'startMs', 'endMs', w);
  const reason = str(ctx, g, 'reason', w, { max: 64, min: 1 });
  if (typeof scope === 'string' && typeof reason === 'string' && GAP_REASONS[scope] && !GAP_REASONS[scope].includes(reason)) {
    ctx.unknown('UNKNOWN_REASON', `gap reason "${reason}" is not defined for scope "${scope}"`, w);
  }
  const doc = str(ctx, g, 'doc', w, { max: 64, optional: true });
  if (typeof doc === 'string' && !docKeys.has(doc)) ctx.error('E_REF', `doc "${doc}" does not exist`, w);
  const window = str(ctx, g, 'window', w, { max: 64, optional: true });
  if (typeof window === 'string' && !windowKeys.has(window)) ctx.error('E_REF', `window "${window}" does not exist`, w);
  if (typeof window === 'string' && typeof doc === 'string') ctx.error('E_FIELD', 'a gap names its doc or its window, not both', w);
  str(ctx, g, 'detail', w, { max: LIMITS.strings.detail, optional: true });
}

function checkRevision(ctx: Ctx, r: unknown, w: Where, expectedId: string): TranscriptRevision | undefined {
  if (!isObj(r)) {
    ctx.error('E_FIELD', 'a transcript revision must be a JSON object', w);
    return undefined;
  }
  fields(ctx, r, ['revisionId', 'source', 'provider', 'model', 'language', 'createdAt', 'timing', 'supersedes', 'measured', 'segments', 'gaps'], w, 'revision');
  const rid = id(ctx, r, 'revisionId', w);
  if (rid !== undefined && rid !== expectedId) ctx.error('E_REF', `revisionId "${rid}" does not match file name "${expectedId}"`, w);
  str(ctx, r, 'source', w, { max: 32, oneOf: ['live', 'after-recording'] });
  str(ctx, r, 'provider', w, { max: 32, oneOf: ['browser-local', 'deepgram', 'assemblyai', 'openai'] });
  str(ctx, r, 'model', w, { max: LIMITS.strings.short, min: 1 });
  str(ctx, r, 'language', w, { max: 16, min: 2 });
  str(ctx, r, 'createdAt', w, { max: 40, pattern: ISO });
  if (r.timing !== undefined) {
    if (!isObj(r.timing)) ctx.error('E_FIELD', '"timing" must be {quality, method, correctionMs}', w);
    else {
      fields(ctx, r.timing, ['quality', 'method', 'correctionMs'], w, 'timing');
      str(ctx, r.timing, 'quality', w, { max: 16, oneOf: ['aligned', 'approximate', 'mixed'] });
      str(ctx, r.timing, 'method', w, { max: LIMITS.strings.short, min: 1 });
      num(ctx, r.timing, 'correctionMs', w);
    }
  }
  str(ctx, r, 'supersedes', w, { max: 64, pattern: ID, optional: true });
  if (r.measured !== undefined) {
    if (!isObj(r.measured)) ctx.error('E_FIELD', '"measured" must be {werPct, basis}', w);
    else {
      fields(ctx, r.measured, ['werPct', 'basis'], w, 'measured');
      num(ctx, r.measured, 'werPct', w, { min: 0, max: 100 });
      str(ctx, r.measured, 'basis', w, { max: LIMITS.strings.short, min: 1 });
    }
  }
  if (!Array.isArray(r.segments)) {
    ctx.error('E_FIELD', '"segments" must be an array', w);
    return undefined;
  }
  if (r.segments.length > LIMITS.segmentsPerRevision) ctx.error('E_LIMIT', `more than ${LIMITS.segmentsPerRevision} segments`, w);
  const segIds = new Set<string>();
  let last = -Infinity;
  for (const s of r.segments) {
    if (!isObj(s)) {
      ctx.error('E_FIELD', 'each segment must be an object', w);
      continue;
    }
    fields(ctx, s, ['id', 'startMs', 'endMs', 'text', 'words', 'timing'], w, 'segment');
    str(ctx, s, 'timing', w, { max: 16, optional: true, oneOf: ['aligned', 'approximate'] });
    id(ctx, s, 'id', w, segIds);
    span(ctx, s, 'startMs', 'endMs', w);
    str(ctx, s, 'text', w, { max: LIMITS.strings.segmentText });
    if (typeof s.startMs === 'number') {
      if (s.startMs < last) ctx.warn('W_ORDER', `segment "${s.id}" is out of time order`, w);
      last = s.startMs;
    }
    if (!Array.isArray(s.words)) {
      ctx.error('E_FIELD', '"words" must be an array (empty when the engine gives no word timing)', w);
      continue;
    }
    if (s.words.length > LIMITS.wordsPerSegment) ctx.error('E_LIMIT', `more than ${LIMITS.wordsPerSegment} words in a segment`, w);
    for (const word of s.words) {
      if (!isObj(word)) {
        ctx.error('E_FIELD', 'each word must be an object', w);
        continue;
      }
      fields(ctx, word, ['text', 'startMs', 'endMs', 'confidence'], w, 'word');
      str(ctx, word, 'text', w, { max: LIMITS.strings.short });
      span(ctx, word, 'startMs', 'endMs', w);
      num(ctx, word, 'confidence', w, { min: 0, max: 1, optional: true });
    }
  }
  if (!Array.isArray(r.gaps)) ctx.error('E_FIELD', '"gaps" must be an array', w);
  else
    for (const g of r.gaps) {
      if (!isObj(g)) {
        ctx.error('E_FIELD', 'each transcript gap must be an object', w);
        continue;
      }
      fields(ctx, g, ['startMs', 'endMs', 'reason', 'detail'], w, 'transcript gap');
      span(ctx, g, 'startMs', 'endMs', w);
      const reason = str(ctx, g, 'reason', w, { max: 64, min: 1 });
      if (typeof reason === 'string' && !TRANSCRIPT_GAP_REASONS.includes(reason)) {
        ctx.unknown('UNKNOWN_REASON', `transcript gap reason "${reason}" is not defined`, w);
      }
      str(ctx, g, 'detail', w, { max: LIMITS.strings.detail, optional: true });
    }
  return r as unknown as TranscriptRevision;
}

function checkEdits(ctx: Ctx, lines: { value: Obj; line: number }[], file: string, revisions: Map<string, TranscriptRevision>): void {
  const byId = new Map<string, Obj>();
  const replaced = new Set<string>();
  for (const { value: e, line } of lines) {
    const w = { file, line };
    const eid = id(ctx, e, 'id', w);
    if (eid !== undefined && byId.has(eid)) ctx.error('E_DUP_ID', `duplicate id "${eid}"`, w);
    const type = str(ctx, e, 'type', w, { max: 16, min: 1 });
    str(ctx, e, 'createdAt', w, { max: 40, pattern: ISO });
    const earlier = (key: string, sameType?: string): void => {
      const target = e[key];
      if (target === undefined) return;
      if (typeof target !== 'string' || !byId.has(target)) return ctx.error('E_REF', `"${key}" must name an earlier edit`, w);
      const ref = byId.get(target)!;
      if (ref.type === 'retract') return ctx.error('E_EDIT', `"${key}" cannot name a retract`, w);
      if (sameType && ref.type !== sameType) return ctx.error('E_EDIT', `"${key}" must name a ${sameType}`, w);
      if (key === 'carriedFrom') return;
      if (replaced.has(target)) ctx.error('E_EDIT', `edit "${target}" is superseded or retracted twice`, w);
      replaced.add(target);
    };
    if (type === 'correction') {
      fields(ctx, e, ['id', 'type', 'revisionId', 'segmentId', 'wordStart', 'wordEnd', 'text', 'createdAt', 'supersedes', 'carriedFrom'], w, 'correction');
      const rid = str(ctx, e, 'revisionId', w, { max: 64 });
      const sid = str(ctx, e, 'segmentId', w, { max: 64 });
      str(ctx, e, 'text', w, { max: LIMITS.strings.correction });
      const revision = typeof rid === 'string' ? revisions.get(rid) : undefined;
      const segment = revision?.segments.find((s) => s.id === sid);
      if (typeof rid === 'string' && !revision) ctx.error('E_REF', `revision "${rid}" does not exist`, w);
      else if (revision && !segment) ctx.error('E_REF', `segment "${sid}" is not in revision "${rid}"`, w);
      const hasStart = e.wordStart !== undefined;
      if (hasStart !== (e.wordEnd !== undefined)) ctx.error('E_FIELD', 'wordStart and wordEnd go together', w);
      else if (hasStart) {
        const ws = num(ctx, e, 'wordStart', w, { int: true, min: 0 });
        const we = num(ctx, e, 'wordEnd', w, { int: true, min: 0 });
        if (typeof ws === 'number' && typeof we === 'number' && (we <= ws || (segment && we > segment.words.length))) {
          ctx.error('E_REF', `word range [${ws}, ${we}) is empty or outside segment "${sid}"`, w);
        }
      }
      earlier('supersedes', 'correction');
      earlier('carriedFrom', 'correction');
    } else if (type === 'note') {
      fields(ctx, e, ['id', 'type', 'atMs', 'endMs', 'text', 'createdAt', 'supersedes'], w, 'note');
      span(ctx, e, 'atMs', 'endMs', w, true);
      str(ctx, e, 'text', w, { max: LIMITS.strings.note, min: 1 });
      earlier('supersedes', 'note');
    } else if (type === 'retract') {
      fields(ctx, e, ['id', 'type', 'target', 'createdAt'], w, 'retract');
      if (e.target === undefined) ctx.error('E_FIELD', 'missing "target"', w);
      earlier('target');
    } else if (typeof type === 'string') {
      ctx.unknown('UNKNOWN_KIND', `edit type "${type}" is not defined`, w);
    }
    if (eid !== undefined) byId.set(eid, e);
  }

  // Active corrections on one segment must not overlap (§8.2).
  const active = [...byId.values()].filter((e) => e.type === 'correction' && !replaced.has(e.id as string));
  const bySegment = new Map<string, Obj[]>();
  for (const c of active) {
    const key = `${c.revisionId}/${c.segmentId}`;
    bySegment.set(key, [...(bySegment.get(key) ?? []), c]);
  }
  for (const [key, list] of bySegment) {
    const ranges = list
      .map((c) => [c.wordStart ?? 0, c.wordEnd ?? Number.MAX_SAFE_INTEGER] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < ranges[i - 1][1]) {
        ctx.error('E_EDIT', `active corrections overlap on segment ${key}`, { file });
        break;
      }
    }
  }
}

function checkRrweb(ctx: Ctx, bytes: Uint8Array, file: string, doc: DocumentRecord, gaps: Gap[]): void {
  const lines = parseJsonl(ctx, bytes, file, LIMITS.rrwebLineBytes, LIMITS.rrwebDepth + 2, Number.MAX_SAFE_INTEGER);
  let expected = 0;
  for (const { value: l, line } of lines) {
    const w = { file, line };
    fields(ctx, l, ['seq', 'sentMs', 'receivedMs', 'event'], w, 'rrweb line');
    const seq = num(ctx, l, 'seq', w, { int: true, min: 0 });
    time(ctx, l, 'sentMs', w);
    time(ctx, l, 'receivedMs', w);
    if (!isObj(l.event)) ctx.error('E_FIELD', '"event" must be an rrweb event object', w);
    else {
      num(ctx, l.event, 'type', w, { int: true, min: 0 });
      num(ctx, l.event, 'timestamp', w);
      scanCredentials(ctx, l.event, w, true);
    }
    if (typeof seq === 'number') {
      if (seq < expected) ctx.error('E_SEQ', `seq ${seq} repeats or goes backwards`, w);
      else if (seq > expected) {
        const covered = gaps.some((g) => g.reason === 'lost-messages' && g.doc === doc.key);
        if (!covered) ctx.error('E_SEQ_GAP', `seq jumps from ${expected - 1} to ${seq} with no lost-messages gap for "${doc.key}"`, w);
      }
      expected = seq + 1;
    }
  }
}

function checkClock(ctx: Ctx, lines: { value: Obj; line: number }[], file: string): ClockPair[] {
  let lastFrames = -1;
  for (const { value: p, line } of lines) {
    const w = { file, line };
    fields(ctx, p, ['frames', 'sampleRate', 'atMs'], w, 'clock pair');
    const frames = num(ctx, p, 'frames', w, { int: true, min: 0 });
    num(ctx, p, 'sampleRate', w, { int: true, min: 1 });
    time(ctx, p, 'atMs', w);
    if (typeof frames === 'number') {
      if (frames <= lastFrames) ctx.error('E_FIELD', 'clock pair frames must increase', w);
      lastFrames = frames;
    }
  }
  if (lines.length === 0) ctx.error('E_FIELD', 'audio clock has no pairs', { file });
  return lines.map((l) => l.value as unknown as ClockPair);
}

// ---------- entry point ----------

/**
 * Validates a whole bundle before anything is stored (§11). Returns the parsed bundle only
 * when there are no errors. Never throws for bad input.
 */
export async function validateBundle(source: BundleSource): Promise<ValidationResult> {
  const ctx = new Ctx();
  const done = (bundle?: Bundle): ValidationResult => {
    const ok = ctx.errors.length === 0;
    return ok && bundle ? { ok, errors: [], warnings: ctx.warnings, bundle } : { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  };

  // 1. Listing: paths, types, counts, total size.
  const entries = await source.list();
  if (entries.length > LIMITS.files + 1) {
    ctx.error('E_LIMIT', `more than ${LIMITS.files} files`);
    return done();
  }
  const present = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'file') ctx.error('E_PATH', `"${entry.path}" is not a regular file`);
    else if (!validPath(entry.path)) ctx.error('E_PATH', `path "${entry.path}" is not allowed`);
    else if (present.has(entry.path)) ctx.error('E_PATH', `"${entry.path}" appears twice`);
    else if (!ALLOWED_EXTENSIONS.has(extensionOf(entry.path))) ctx.error('E_FILE_TYPE', `"${entry.path}" is not a .json, .jsonl, .md or .webm file`);
    else present.set(entry.path, entry.bytes);
    total += entry.bytes;
  }
  if (total > LIMITS.totalBytes) ctx.error('E_LIMIT', `bundle is larger than ${LIMITS.totalBytes} bytes`);
  if (ctx.errors.length > 0) return done();

  // 2. Manifest.
  const mw = { file: 'manifest.json' };
  if (!present.has('manifest.json')) {
    ctx.error('E_MANIFEST_MISSING', 'manifest.json is missing', mw);
    return done();
  }
  if (present.get('manifest.json')! > LIMITS.manifestBytes) {
    ctx.error('E_LIMIT', `manifest.json is larger than ${LIMITS.manifestBytes} bytes`, mw);
    return done();
  }
  const manifestValue = parseJson(ctx, await source.read('manifest.json'), mw, LIMITS.jsonDepth);
  if (manifestValue === undefined) return done();
  const manifest = checkManifest(ctx, manifestValue, mw);
  if (!manifest) return done();
  scanCredentials(ctx, manifestValue, mw, false);

  // 3. Listed files against present files, sizes and hashes.
  const listed = new Map(manifest.files.filter((f) => isObj(f) && typeof f.path === 'string').map((f) => [f.path, f]));
  for (const path of present.keys()) {
    if (path !== 'manifest.json' && !listed.has(path)) ctx.error('E_FILE_UNLISTED', `"${path}" is not listed in manifest.files`, { file: path });
  }
  for (const path of REQUIRED_FILES) {
    if (!listed.has(path)) ctx.error('E_FILE_MISSING', `required file "${path}" is not listed`, { file: path });
  }
  const contents = new Map<string, Uint8Array>();
  for (const [path, entry] of listed) {
    const w = { file: path };
    if (!present.has(path)) {
      ctx.error('E_FILE_MISSING', `listed file "${path}" is missing`, w);
      continue;
    }
    const bytes = present.get(path)!;
    if (bytes !== entry.bytes) {
      ctx.error('E_SIZE', `"${path}" is ${bytes} bytes; manifest says ${entry.bytes}`, w);
      continue;
    }
    if (path.endsWith('.json') && bytes > LIMITS.jsonBytes) {
      ctx.error('E_LIMIT', `"${path}" is larger than ${LIMITS.jsonBytes} bytes`, w);
      continue;
    }
    const data = await source.read(path);
    if (data.length !== bytes) {
      ctx.error('E_SIZE', `"${path}" read ${data.length} bytes; listing said ${bytes}`, w);
      continue;
    }
    if ((await sha256Hex(data)) !== entry.sha256) {
      ctx.error('E_HASH', `"${path}" does not match its sha256`, w);
      continue;
    }
    if (path.endsWith('.json') || path.endsWith('.jsonl') || path.endsWith('.md')) contents.set(path, data);
  }
  // Markdown is free text: valid UTF-8 and no key-shaped strings (§11).
  for (const [path, data] of contents) {
    if (!path.endsWith('.md')) continue;
    const text = decode(ctx, data, { file: path });
    if (text !== undefined && holdsCredentialText(text)) ctx.error('E_CREDENTIAL', 'text looks like an API key', { file: path });
  }
  if (ctx.errors.length > 0) return done();

  // 4. Documents, observations, gaps.
  const policy = manifest.privacy?.urlPolicy ?? 'redact-query-values';
  const dw = { file: 'documents.json' };
  const docsValue = parseJson(ctx, contents.get('documents.json')!, dw, LIMITS.jsonDepth);
  const { documents, windows } = docsValue === undefined ? { documents: [], windows: [] } : checkDocuments(ctx, docsValue, dw, policy);
  if (docsValue !== undefined) scanCredentials(ctx, docsValue, dw, false);
  const docKeys = new Set(documents.map((d) => d.key));
  const windowKeys = new Set(windows.map((win) => win.key));

  const observationLines = parseJsonl(ctx, contents.get('observations.jsonl')!, 'observations.jsonl', LIMITS.jsonlLineBytes, LIMITS.jsonDepth, LIMITS.observations);
  const observationIds = new Set<string>();
  let lastAt = -Infinity;
  for (const { value, line } of observationLines) {
    const w = { file: 'observations.jsonl', line };
    checkObservation(ctx, value, w, manifest, observationIds, docKeys, windowKeys);
    scanCredentials(ctx, value, w, false);
    if (typeof value.atMs === 'number') {
      if (value.atMs < lastAt) ctx.warn('W_ORDER', 'observation is out of time order', w);
      lastAt = value.atMs;
    }
  }

  const gapLines = parseJsonl(ctx, contents.get('gaps.jsonl')!, 'gaps.jsonl', LIMITS.jsonlLineBytes, LIMITS.jsonDepth, LIMITS.gaps);
  const gapIds = new Set<string>();
  let lastStart = -Infinity;
  for (const { value, line } of gapLines) {
    const w = { file: 'gaps.jsonl', line };
    checkGap(ctx, value, w, gapIds, docKeys, windowKeys);
    scanCredentials(ctx, value, w, false);
    if (typeof value.startMs === 'number') {
      if (value.startMs < lastStart) ctx.warn('W_ORDER', 'gap is out of time order', w);
      lastStart = value.startMs;
    }
  }
  const gaps = gapLines.map((l) => l.value as unknown as Gap);

  // 5. Transcript revisions and user edits.
  const revisions = new Map<string, TranscriptRevision>();
  const revisionFiles = [...listed.keys()].filter((p) => /^transcript\/[^/]+\.json$/.test(p));
  if (revisionFiles.length > LIMITS.revisions) ctx.error('E_LIMIT', `more than ${LIMITS.revisions} transcript revisions`);
  for (const path of revisionFiles) {
    const w = { file: path };
    const value = parseJson(ctx, contents.get(path)!, w, LIMITS.jsonDepth);
    if (value === undefined) continue;
    scanCredentials(ctx, value, w, false);
    const revision = checkRevision(ctx, value, w, path.slice('transcript/'.length, -'.json'.length));
    if (revision) revisions.set(revision.revisionId, revision);
  }
  for (const revision of revisions.values()) {
    const target = revision.supersedes;
    if (target === undefined) continue;
    const earlier = revisions.get(target);
    if (target === revision.revisionId || !earlier || earlier.createdAt > revision.createdAt) {
      ctx.error('E_REF', `revision "${revision.revisionId}" supersedes "${target}", which is not an earlier revision`, { file: `transcript/${revision.revisionId}.json` });
    }
  }
  const active = manifest.transcript?.activeRevision;
  if (typeof active === 'string' && !revisions.has(active)) ctx.error('E_REF', `activeRevision "${active}" does not exist`, mw);

  let edits: Edit[] = [];
  if (contents.has('edits.jsonl')) {
    const lines = parseJsonl(ctx, contents.get('edits.jsonl')!, 'edits.jsonl', LIMITS.jsonlLineBytes, LIMITS.jsonDepth, LIMITS.edits);
    for (const { value, line } of lines) scanCredentials(ctx, value, { file: 'edits.jsonl', line }, false);
    checkEdits(ctx, lines, 'edits.jsonl', revisions);
    edits = lines.map((l) => l.value as unknown as Edit);
  }

  // 6. Audio.
  let clockPairs: ClockPair[] = [];
  if (manifest.audio) {
    for (const key of ['file', 'clock'] as const) {
      const path = manifest.audio[key];
      if (typeof path === 'string' && !listed.has(path)) ctx.error('E_REF', `audio ${key} "${path}" is not listed`, mw);
    }
    const clockPath = manifest.audio.clock;
    if (typeof clockPath === 'string' && contents.has(clockPath)) {
      const lines = parseJsonl(ctx, contents.get(clockPath)!, clockPath, LIMITS.jsonlLineBytes, LIMITS.jsonDepth, LIMITS.observations);
      clockPairs = checkClock(ctx, lines, clockPath);
    }
  } else if (manifest.audio === null && !gaps.some((g) => g.scope === 'audio')) {
    ctx.error('E_AUDIO_GAP', 'no narration audio and no audio gap explains why', mw);
  }

  // 7. rrweb streams.
  const referenced = new Set<string>(['documents.json', 'observations.jsonl', 'gaps.jsonl', 'edits.jsonl', AGENT_MD, AGENT_JSON, ...README_PATHS, ...revisionFiles]);
  if (manifest.audio) referenced.add(manifest.audio.file).add(manifest.audio.clock);
  for (const doc of documents) {
    if (typeof doc.rrweb !== 'string') continue;
    referenced.add(doc.rrweb);
    if (!listed.has(doc.rrweb)) {
      ctx.error('E_REF', `document "${doc.key}" rrweb stream "${doc.rrweb}" is not listed`, dw);
      continue;
    }
    checkRrweb(ctx, contents.get(doc.rrweb)!, doc.rrweb, doc, gaps);
  }
  for (const path of listed.keys()) {
    if (!referenced.has(path)) ctx.warn('W_UNKNOWN_FILE', `"${path}" is not part of schema ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}; ignored`, { file: path });
  }

  // 8. Derived agent exports: must parse; a stale copy is a warning (they are regenerable).
  if (contents.has(AGENT_JSON)) {
    const value = parseJson(ctx, contents.get(AGENT_JSON)!, { file: AGENT_JSON }, LIMITS.jsonDepth + 8);
    if (isObj(value) && value.format !== 'narwal.agent-view') ctx.error('E_FORMAT', 'agent view "format" must be "narwal.agent-view"', { file: AGENT_JSON });
    if (value !== undefined) scanCredentials(ctx, value, { file: AGENT_JSON }, false);
  }
  if (ctx.errors.length > 0) return done();

  const bundle: Bundle = {
    manifest,
    documents,
    windows,
    observations: observationLines.map((l) => l.value as unknown as Observation | UnknownObservation),
    gaps,
    revisions,
    edits,
    clockPairs,
  };
  if (contents.has(AGENT_JSON) || contents.has(AGENT_MD) || README_PATHS.some((path) => contents.has(path))) {
    const view = buildAgentView(bundle);
    const loose = new TextDecoder();
    const text = (bytes: Uint8Array): string => loose.decode(bytes);
    if (contents.has(AGENT_JSON) && text(contents.get(AGENT_JSON)!) !== stableJson(view)) {
      ctx.warn('W_AGENT_STALE', 'agent/walkthrough.json differs from a fresh export; regenerate it', { file: AGENT_JSON });
    }
    if (contents.has(AGENT_MD) && text(contents.get(AGENT_MD)!) !== renderMarkdown(view)) {
      ctx.warn('W_AGENT_STALE', 'agent/walkthrough.md differs from a fresh export; regenerate it', { file: AGENT_MD });
    }
    for (const path of README_PATHS) {
      if (contents.has(path) && text(contents.get(path)!) !== renderReadme(view)) {
        ctx.warn('W_AGENT_STALE', `${path} differs from a fresh export; regenerate it`, { file: path });
      }
    }
  }
  return done(bundle);
}

/**
 * packages/library's `BundleValidator` hook: every issue of `validateBundle` over an
 * in-memory bundle tree, errors first. The library refuses the bundle on any error.
 */
export async function bundleValidator(files: ReadonlyMap<string, Uint8Array>): Promise<Issue[]> {
  const result = await validateBundle(memorySource(files));
  return [...result.errors, ...result.warnings];
}
