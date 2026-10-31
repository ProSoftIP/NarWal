// Transcript revisions and retranscription (board #16547).
// Stored shapes follow docs/bundle-schema.md §8 (DRAFT, board #16541): a revision is immutable
// once written, a new provider run appends a new revision, `activeRevision` picks the one the
// agent view uses, and user corrections stay bound to the revision they were made on. The
// recording itself is not referenced here: nothing in this file can change captured audio or
// page events. Every function is pure and returns a new history; `retranscribe` alone waits.

import type {
  BatchTranscriptionAdapter,
  BatchTranscriptionRequest,
  ProviderId,
  SessionMs,
  TimingQuality,
  TranscriptRevision,
  UploadConsent,
} from './contract.ts';

/** A revision as the bundle stores it (bundle schema §8.1). */
export interface StoredRevision {
  revisionId: string;
  source: 'live' | 'after-recording';
  provider: string;
  model: string;
  language: string;
  /** Wall time, ISO 8601. Never used to place anything on the timeline. */
  createdAt: string;
  segments: Array<{
    id: string;
    startMs: SessionMs;
    endMs: SessionMs;
    text: string;
    words: Array<{ text: string; startMs: SessionMs; endMs: SessionMs; confidence?: number }>;
    /** Absent means `aligned`. */
    timing?: TimingQuality;
  }>;
  gaps: Array<{ startMs: SessionMs; endMs: SessionMs; reason: string; detail?: string }>;
  timing?: { quality: TimingQuality | 'mixed'; method: string; correctionMs: number };
  /** ID of an earlier revision of this recording. */
  supersedes?: string;
}

/** A user correction (bundle schema §8.2). Without a word range it replaces the whole segment text. */
export interface CorrectionEdit {
  id: string;
  type: 'correction';
  revisionId: string;
  segmentId: string;
  wordStart?: number;
  wordEnd?: number;
  text: string;
  createdAt: string;
  supersedes?: string;
  carriedFrom?: string;
}

/** Any other line of `edits.jsonl` (notes, retractions). Kept as read; only `retract` is interpreted here. */
export interface OtherEdit {
  id: string;
  type: string;
  target?: string;
  supersedes?: string;
  [field: string]: unknown;
}

export type StoredEdit = CorrectionEdit | OtherEdit;

export interface PendingRetranscription {
  jobId: string;
  provider: ProviderId;
  startedAtMs: number;
  /** The consent this job uploads under; one consent covers one upload job. */
  consentGrantedAtMs: number;
}

export interface TranscriptHistory {
  recordingId: string;
  /** Incremented by every change; writers pass the version they read. */
  version: number;
  /** Append-only, oldest first. */
  revisions: StoredRevision[];
  activeRevision: string | null;
  /** Append-only. */
  edits: StoredEdit[];
  /** Extension state, not part of the bundle. */
  pending: PendingRetranscription | null;
  /** `grantedAtMs` of each consent already spent on an upload job. Extension state, not part of the bundle. */
  usedConsents: Array<{ provider: ProviderId; grantedAtMs: number }>;
}

/** Bundle schema §8.1: "Up to 32 revisions." */
export const MAX_REVISIONS = 32;

export type RevisionConflictReason =
  | 'stale-version' // another writer changed the history first
  | 'revision-limit'
  | 'retranscription-in-progress'
  | 'consent-already-used'
  | 'wrong-recording'
  | 'unknown-revision';

export class RevisionConflict extends Error {
  reason: RevisionConflictReason;

  constructor(reason: RevisionConflictReason, message: string) {
    super(message);
    this.name = 'RevisionConflict';
    this.reason = reason;
  }
}

export class InvalidRevision extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`Transcript revision does not match the contract: ${issues.join('; ')}`);
    this.name = 'InvalidRevision';
    this.issues = issues;
  }
}

const PROVIDERS: readonly string[] = ['deepgram', 'assemblyai', 'openai', 'browser-local'];
/** Offline gap reasons. The bundle stores `not-transcribed` and keeps the reason in `detail`. */
const LOCAL_GAP_REASONS: readonly string[] = ['model-missing', 'model-corrupt', 'engine-failed', 'engine-behind', 'not-transcribed'];
const TIMING: readonly unknown[] = ['aligned', 'approximate'];
const isMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Lists every way `value` differs from a stored-form TranscriptRevision. Empty means valid. */
export function validateTranscriptRevision(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['revision is not an object'];
  const revision = value as Partial<TranscriptRevision>;
  const issues: string[] = [];
  if (!isText(revision.revisionId)) issues.push('revisionId is empty');
  if (!PROVIDERS.includes(revision.provider as string)) issues.push('provider is unknown');
  if (!isText(revision.model)) issues.push('model is empty');
  if (!isMs(revision.createdAtMs)) issues.push('createdAtMs is not a time');
  if (revision.source !== 'live' && revision.source !== 'after-recording') issues.push('source is unknown');

  const keys = new Set<string>();
  let previousStart = 0;
  if (!Array.isArray(revision.segments)) issues.push('segments is not an array');
  else {
    revision.segments.forEach((segment, index) => {
      const at = `segments[${index}]`;
      if (!isText(segment.segmentKey) || !isText(segment.connectionId)) issues.push(`${at} has no key`);
      else if (keys.has(segment.segmentKey)) issues.push(`${at} repeats segmentKey ${segment.segmentKey}`);
      keys.add(segment.segmentKey);
      if (segment.provider !== revision.provider) issues.push(`${at} is from another provider`);
      // A stored revision holds settled text only; interim segments exist only on the live event stream.
      if (segment.kind !== 'final') issues.push(`${at} is not final`);
      if (typeof segment.text !== 'string') issues.push(`${at} has no text`);
      if (typeof segment.endOfUtterance !== 'boolean') issues.push(`${at} has no endOfUtterance`);
      if (segment.timing !== undefined && !TIMING.includes(segment.timing)) issues.push(`${at} timing is unknown`);
      if (!isMs(segment.startMs) || !isMs(segment.endMs) || segment.endMs < segment.startMs) {
        issues.push(`${at} has an invalid time range`);
      } else {
        if (segment.startMs < previousStart) issues.push(`${at} starts before the segment ahead of it`);
        previousStart = segment.startMs;
      }
      if (!Array.isArray(segment.words)) {
        issues.push(`${at} words is not an array`);
        return;
      }
      let previousWordStart = 0;
      segment.words.forEach((word, wordIndex) => {
        const wordAt = `${at}.words[${wordIndex}]`;
        if (typeof word.text !== 'string') issues.push(`${wordAt} has no text`);
        if (!isMs(word.startMs) || !isMs(word.endMs) || word.endMs < word.startMs) {
          issues.push(`${wordAt} has an invalid time range`);
        } else {
          if (word.startMs < previousWordStart) issues.push(`${wordAt} starts before the word ahead of it`);
          previousWordStart = word.startMs;
        }
        if (word.confidence !== undefined && !(word.confidence >= 0 && word.confidence <= 1)) {
          issues.push(`${wordAt} confidence is outside 0..1`);
        }
      });
    });
  }
  if (revision.timing !== undefined) {
    const { quality, method, correctionMs } = revision.timing;
    if (!TIMING.includes(quality) && quality !== 'mixed') issues.push('timing.quality is unknown');
    if (!isText(method) || method.length > 200) issues.push('timing.method is empty or longer than 200 characters');
    if (typeof correctionMs !== 'number' || !Number.isFinite(correctionMs)) issues.push('timing.correctionMs is not a number');
  }
  if (revision.supersedes !== undefined && !isText(revision.supersedes)) issues.push('supersedes is empty');
  if (!Array.isArray(revision.gaps)) issues.push('gaps is not an array');
  else {
    revision.gaps.forEach((gap, index) => {
      if (!isMs(gap.startMs) || !isMs(gap.endMs) || gap.endMs <= gap.startMs) issues.push(`gaps[${index}] has an invalid time range`);
      if (!isText(gap.reason)) issues.push(`gaps[${index}] has no reason`);
    });
  }
  return issues;
}

export function assertTranscriptRevision(value: unknown): asserts value is TranscriptRevision {
  const issues = validateTranscriptRevision(value);
  if (issues.length > 0) throw new InvalidRevision(issues);
}

export function createTranscriptHistory(recordingId: string): TranscriptHistory {
  return { recordingId, version: 0, revisions: [], activeRevision: null, edits: [], pending: null, usedConsents: [] };
}

function assertVersion(history: TranscriptHistory, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== history.version) {
    throw new RevisionConflict('stale-version', `History is at version ${history.version}; the change was made against ${expectedVersion}`);
  }
}

function findRevision(history: TranscriptHistory, revisionId: string): StoredRevision {
  const revision = history.revisions.find((candidate) => candidate.revisionId === revisionId);
  if (!revision) throw new RevisionConflict('unknown-revision', `No revision ${revisionId} in this recording`);
  return revision;
}

/** The next free ID with a prefix (`r1`, `c4`). Readers never parse IDs; writers only keep them unique. */
function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let number = used.size + 1;
  while (used.has(`${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

/** Converts an adapter's revision to the stored shape. Provider-side IDs are replaced by bundle IDs. */
export function toStoredRevision(revision: TranscriptRevision, revisionId: string, language = 'en'): StoredRevision {
  assertTranscriptRevision(revision);
  return {
    revisionId,
    source: revision.source,
    provider: revision.provider,
    model: revision.model,
    language,
    createdAt: new Date(revision.createdAtMs).toISOString(),
    segments: revision.segments.map((segment, index) => ({
      id: `s${index + 1}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      })),
      ...(revision.provider === 'browser-local' ? { timing: segment.timing ?? 'aligned' } : segment.timing ? { timing: segment.timing } : {}),
    })),
    gaps: revision.gaps.map((gap) => {
      const local = LOCAL_GAP_REASONS.includes(gap.reason);
      const detail = local ? [gap.reason === 'not-transcribed' ? '' : gap.reason, gap.detail ?? ''].filter(Boolean).join(': ') : gap.detail;
      return {
        startMs: gap.startMs,
        endMs: gap.endMs,
        reason: local ? 'not-transcribed' : gap.reason,
        ...(detail ? { detail: detail.slice(0, 500) } : {}),
      };
    }),
    ...(revision.timing ? { timing: revision.timing } : {}),
    ...(revision.supersedes ? { supersedes: revision.supersedes } : {}),
  };
}

export interface WriteOptions {
  /** The version the caller read. A mismatch is refused, so two writers cannot overwrite each other. */
  expectedVersion?: number;
}

/**
 * Appends a revision under a new ID. Earlier revisions and all edits stay as
 * they are. `activate: false` stores it without changing what the user reads.
 */
export function addRevision(
  history: TranscriptHistory,
  revision: TranscriptRevision,
  options: WriteOptions & { activate?: boolean } = {},
): TranscriptHistory {
  assertVersion(history, options.expectedVersion);
  if (history.revisions.length >= MAX_REVISIONS) {
    throw new RevisionConflict('revision-limit', `A recording holds at most ${MAX_REVISIONS} transcript revisions`);
  }
  // Bundle schema §8.1: `supersedes` names a revision that is already stored.
  if (revision.supersedes !== undefined) findRevision(history, revision.supersedes);
  const stored = toStoredRevision(revision, nextId('r', history.revisions.map((existing) => existing.revisionId)));
  return {
    ...history,
    version: history.version + 1,
    revisions: [...history.revisions, stored],
    activeRevision: options.activate === false ? history.activeRevision : stored.revisionId,
  };
}

/** Changes which stored revision the user reads. Nothing is removed. */
export function activateRevision(history: TranscriptHistory, revisionId: string, options: WriteOptions = {}): TranscriptHistory {
  assertVersion(history, options.expectedVersion);
  findRevision(history, revisionId);
  return { ...history, version: history.version + 1, activeRevision: revisionId };
}

/** A job older than this is treated as abandoned, e.g. the service worker was stopped mid-upload. */
export const PENDING_STALE_AFTER_MS = 30 * 60_000;

/**
 * Marks an upload job as running. Refuses a second job for the same recording
 * and refuses a consent that already covered a job: each upload costs the
 * user money, so each one needs its own explicit consent.
 */
export function beginRetranscription(
  history: TranscriptHistory,
  job: { jobId: string; startedAtMs: number; consent: UploadConsent },
  options: WriteOptions = {},
): TranscriptHistory {
  assertVersion(history, options.expectedVersion);
  const { consent } = job;
  if (history.pending && job.startedAtMs - history.pending.startedAtMs < PENDING_STALE_AFTER_MS) {
    throw new RevisionConflict('retranscription-in-progress', `Job ${history.pending.jobId} is still transcribing this recording`);
  }
  if (consent.recordingId !== history.recordingId) {
    throw new RevisionConflict('wrong-recording', 'The consent is for another recording');
  }
  if (history.usedConsents.some((used) => used.provider === consent.provider && used.grantedAtMs === consent.grantedAtMs)) {
    throw new RevisionConflict('consent-already-used', 'This consent already covered an upload; ask the user again');
  }
  if (history.revisions.length >= MAX_REVISIONS) {
    // Refused before the upload, so the user is not charged for a transcript that cannot be stored.
    throw new RevisionConflict('revision-limit', `A recording holds at most ${MAX_REVISIONS} transcript revisions`);
  }
  return {
    ...history,
    version: history.version + 1,
    pending: { jobId: job.jobId, provider: consent.provider, startedAtMs: job.startedAtMs, consentGrantedAtMs: consent.grantedAtMs },
    usedConsents: [...history.usedConsents, { provider: consent.provider, grantedAtMs: consent.grantedAtMs }],
  };
}

/**
 * Ends a job with no revision. `refundConsent` is for a job that uploaded
 * nothing, so the same consent can start the next try.
 */
export function cancelRetranscription(
  history: TranscriptHistory,
  jobId: string,
  options: WriteOptions & { refundConsent?: boolean } = {},
): TranscriptHistory {
  assertVersion(history, options.expectedVersion);
  const { pending } = history;
  if (pending?.jobId !== jobId) return history;
  return {
    ...history,
    version: history.version + 1,
    pending: null,
    usedConsents: options.refundConsent
      ? history.usedConsents.filter((used) => !(used.provider === pending.provider && used.grantedAtMs === pending.consentGrantedAtMs))
      : history.usedConsents,
  };
}

const isCorrection = (edit: StoredEdit): edit is CorrectionEdit => edit.type === 'correction';

/** Corrections on one revision that are neither superseded nor retracted. */
export function activeCorrections(history: TranscriptHistory, revisionId: string): CorrectionEdit[] {
  const inactive = new Set<string>();
  for (const edit of history.edits) {
    if (typeof edit.supersedes === 'string') inactive.add(edit.supersedes);
    if (edit.type === 'retract' && typeof edit.target === 'string') inactive.add(edit.target);
  }
  return history.edits.filter(isCorrection).filter((edit) => edit.revisionId === revisionId && !inactive.has(edit.id));
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** More than half of the item lies in the range. Two runs time the same word a little differently. */
function mostlyInside(item: { startMs: SessionMs; endMs: SessionMs }, startMs: SessionMs, endMs: SessionMs): boolean {
  const length = item.endMs - item.startMs;
  if (length <= 0) return item.startMs >= startMs && item.startMs <= endMs;
  return (Math.min(item.endMs, endMs) - Math.max(item.startMs, startMs)) * 2 > length;
}

export type CarryOutcome =
  | 'carried' // the new revision has the same words there; a new correction now applies to it
  | 'redundant' // the new revision already says what the user wrote
  | 'conflict'; // the new revision differs there; the user decides

export type CarryConflictReason =
  | 'text-changed' // the provider heard other words in that range
  | 'no-words' // the new revision has nothing there (silence or a gap)
  | 'spans-segments' // the words now sit in more than one segment
  | 'already-corrected' // an active correction on the new revision covers the same words
  | 'source-invalid'; // the old correction does not resolve in its own revision

export interface CarryItem {
  correction: CorrectionEdit;
  outcome: CarryOutcome;
  reason?: CarryConflictReason;
  /** What the correction replaced, and what the new revision says in the same time range. */
  originalText: string;
  revisionText: string;
  /** Where the correction would go in the new revision, when it maps to one segment. */
  target?: { segmentId: string; wordStart?: number; wordEnd?: number };
}

/**
 * Compares the active corrections of one revision with another revision, by
 * session time. A correction is carried only to the words it was written for.
 * Where the new revision differs, the result is a conflict for the user: the
 * correction is never applied to other words and never dropped.
 */
export function planCarryForward(history: TranscriptHistory, fromRevisionId: string, toRevisionId: string): CarryItem[] {
  const from = findRevision(history, fromRevisionId);
  const to = findRevision(history, toRevisionId);
  const onTarget = activeCorrections(history, toRevisionId);

  return activeCorrections(history, fromRevisionId).flatMap((correction): CarryItem[] => {
    // Carried earlier, e.g. the job finished twice or the user switched back and forth.
    if (history.edits.some((edit) => isCorrection(edit) && edit.revisionId === toRevisionId && edit.carriedFrom === correction.id)) return [];

    const segment = from.segments.find((candidate) => candidate.id === correction.segmentId);
    const whole = correction.wordStart === undefined || correction.wordEnd === undefined;
    const words = whole ? [] : (segment?.words.slice(correction.wordStart, correction.wordEnd) ?? []);
    if (!segment || (!whole && words.length === 0)) {
      return [{ correction, outcome: 'conflict', reason: 'source-invalid', originalText: '', revisionText: '' }];
    }
    const startMs = whole ? segment.startMs : words[0].startMs;
    const endMs = whole ? segment.endMs : words[words.length - 1].endMs;
    const originalText = whole ? segment.text : words.map((word) => word.text).join(' ');

    let revisionText: string;
    let target: CarryItem['target'];
    let spansSegments = false;
    if (whole) {
      const matches = to.segments.filter((candidate) => mostlyInside(candidate, startMs, endMs));
      revisionText = matches.map((candidate) => candidate.text).join(' ');
      spansSegments = matches.length > 1;
      if (matches.length === 1) target = { segmentId: matches[0].id };
    } else {
      const matches = to.segments.flatMap((candidate) =>
        candidate.words.flatMap((word, index) => (mostlyInside(word, startMs, endMs) ? [{ segmentId: candidate.id, index, word }] : [])),
      );
      revisionText = matches.map((match) => match.word.text).join(' ');
      spansSegments = new Set(matches.map((match) => match.segmentId)).size > 1;
      if (matches.length > 0 && !spansSegments) {
        target = { segmentId: matches[0].segmentId, wordStart: matches[0].index, wordEnd: matches[matches.length - 1].index + 1 };
      }
    }

    const item = { correction, originalText, revisionText };
    if (normalize(revisionText) === normalize(correction.text) && normalize(revisionText) !== '') {
      return [{ ...item, outcome: 'redundant' }];
    }
    if (revisionText === '') return [{ ...item, outcome: 'conflict', reason: 'no-words' }];
    if (normalize(revisionText) !== normalize(originalText)) {
      return [{ ...item, outcome: 'conflict', reason: 'text-changed', ...(target ? { target } : {}) }];
    }
    if (!target) return [{ ...item, outcome: 'conflict', reason: 'spans-segments' }];
    const taken = onTarget.some(
      (existing) =>
        existing.segmentId === target.segmentId &&
        (existing.wordStart === undefined ||
          existing.wordEnd === undefined ||
          target.wordStart === undefined ||
          target.wordEnd === undefined ||
          (existing.wordStart < target.wordEnd && existing.wordEnd > target.wordStart)),
    );
    if (taken) return [{ ...item, outcome: 'conflict', reason: 'already-corrected', target }];
    return [{ ...item, outcome: 'carried', target }];
  });
}

/**
 * Writes a new correction, with `carriedFrom`, for each correction the plan
 * can carry. The old corrections stay in place on their own revision.
 */
export function carryCorrections(
  history: TranscriptHistory,
  fromRevisionId: string,
  toRevisionId: string,
  createdAt: string,
  options: WriteOptions = {},
): { history: TranscriptHistory; items: CarryItem[] } {
  assertVersion(history, options.expectedVersion);
  const items = planCarryForward(history, fromRevisionId, toRevisionId);
  const ids = history.edits.map((edit) => edit.id);
  const carried: CorrectionEdit[] = [];
  for (const item of items) {
    if (item.outcome !== 'carried' || !item.target) continue;
    const id = nextId('c', ids);
    ids.push(id);
    carried.push({ id, type: 'correction', revisionId: toRevisionId, ...item.target, text: item.correction.text, createdAt, carriedFrom: item.correction.id });
  }
  if (carried.length === 0) return { history, items };
  return { history: { ...history, version: history.version + 1, edits: [...history.edits, ...carried] }, items };
}

/**
 * Stores the job's revision, makes it the one the user reads and carries the
 * corrections of the revision the user was reading. `items` lists every
 * correction that was carried, is redundant or needs the user's decision.
 *
 * A job that was replaced as abandoned can still finish. The user's key was
 * charged for its transcript, so it is stored, but it does not become the
 * active revision and does not end the job that replaced it.
 *
 * A revision with a gap is what a job returns when a later upload failed. It
 * is stored too, but it does not replace a transcript the user already reads:
 * the user would lose the text after the failure. The user can switch to it
 * with `activateRevision`. With no transcript yet, it becomes the active one.
 *
 * A revision whose words differ where the user corrected (a `conflict` item)
 * is stored, with the corrections that match carried onto it, but does not
 * replace the corrected transcript: the user decides each conflict first
 * (docs/editing.md). This is the rule of the edits package too.
 */
export function completeRetranscription(
  history: TranscriptHistory,
  jobId: string,
  revision: TranscriptRevision,
  options: WriteOptions = {},
): RetranscriptionResult {
  const storedId = (stored: TranscriptHistory) => stored.revisions[stored.revisions.length - 1].revisionId;
  if (history.pending?.jobId !== jobId) {
    const stored = addRevision(history, revision, { ...options, activate: false });
    return { history: stored, revisionId: storedId(stored), activated: false, notActivated: 'job-replaced', items: [] };
  }
  const done = addImprovedRevision(history, revision, options);
  return { ...done, history: { ...done.history, pending: null } };
}

/**
 * Stores a revision made after recording and makes it the one the user reads,
 * under the rules of `completeRetranscription`: a revision with a gap does not
 * replace a transcript the user already reads, and one that conflicts with a
 * correction waits for the user. For a pass with no upload and no job record,
 * such as the offline final pass (board #16603); `pending` is not changed.
 */
export function addImprovedRevision(history: TranscriptHistory, revision: TranscriptRevision, options: WriteOptions = {}): RetranscriptionResult {
  const storedId = (stored: TranscriptHistory) => stored.revisions[stored.revisions.length - 1].revisionId;
  const previous = history.activeRevision;
  if (previous !== null && revision.gaps.length > 0) {
    const stored = addRevision(history, revision, { ...options, activate: false });
    return { history: stored, revisionId: storedId(stored), activated: false, notActivated: 'incomplete', items: [] };
  }
  const added = addRevision(history, revision, { ...options, activate: previous === null });
  const revisionId = storedId(added);
  if (previous === null) return { history: added, revisionId, activated: true, items: [] };
  const carried = carryCorrections(added, previous, revisionId, new Date(revision.createdAtMs).toISOString());
  const activated = !carried.items.some((item) => item.outcome === 'conflict');
  // One change for the caller: one version step, however many corrections were carried.
  const next = { ...carried.history, version: added.version, ...(activated ? { activeRevision: revisionId } : {}) };
  return { history: next, revisionId, activated, ...(activated ? {} : { notActivated: 'conflicts' as const }), items: carried.items };
}

/** Where the history is kept. `write` must refuse with RevisionConflict('stale-version') when the stored version is not `expectedVersion`. */
export interface TranscriptHistoryStore {
  read(): Promise<TranscriptHistory>;
  write(next: TranscriptHistory, expectedVersion: number): Promise<void>;
}

/** Applies a change to the newest stored history, again if another writer got there first. */
async function update<Result>(
  store: TranscriptHistoryStore,
  change: (history: TranscriptHistory) => { history: TranscriptHistory; result: Result },
): Promise<Result> {
  for (let attempt = 1; ; attempt += 1) {
    const current = await store.read();
    const { history, result } = change(current);
    if (history === current) return result;
    try {
      await store.write(history, current.version);
      return result;
    } catch (cause) {
      if (!(cause instanceof RevisionConflict && cause.reason === 'stale-version') || attempt >= 5) throw cause;
    }
  }
}

export interface RetranscriptionResult {
  history: TranscriptHistory;
  revisionId: string;
  /** False when the revision is stored but the user still reads the one from before. */
  activated: boolean;
  /**
   * Why not: another job replaced this one, this revision has a gap where an
   * upload failed, or its words differ where the user corrected.
   */
  notActivated?: 'job-replaced' | 'incomplete' | 'conflicts';
  items: CarryItem[];
}

/**
 * Transcribes a recording again and stores the result as a new revision,
 * active unless it conflicts with a correction or has a gap (see
 * `completeRetranscription`). The user can keep correcting while the upload
 * runs: the result is merged into the newest history, not the one read at the
 * start. A job that fails leaves revisions and edits as they were. A job that
 * fails after one or more uploads stores what it has.
 */
export async function retranscribe(
  store: TranscriptHistoryStore,
  adapter: BatchTranscriptionAdapter,
  request: BatchTranscriptionRequest,
  credential: { kind: 'api-key'; key: string },
  signal: AbortSignal,
  job: { jobId: string; startedAtMs: number },
): Promise<RetranscriptionResult> {
  await update(store, (history) => ({ history: beginRetranscription(history, { ...job, consent: request.consent }), result: null }));
  let revision: TranscriptRevision;
  try {
    revision = await adapter.transcribe(request, credential, signal);
  } catch (cause) {
    // Refused before any byte was sent, as opposed to failed or cancelled during an upload.
    const nothingSent = cause instanceof Error && cause.name === 'UploadRefused';
    await update(store, (history) => ({ history: cancelRetranscription(history, job.jobId, { refundConsent: nothingSent }), result: null }));
    throw cause;
  }
  return update(store, (history) => {
    const done = completeRetranscription(history, job.jobId, revision);
    return { history: done.history, result: done };
  });
}
