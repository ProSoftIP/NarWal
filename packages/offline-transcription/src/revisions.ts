// Transcript revisions (board #16544, docs/bundle-schema.md §8.1).
//
// A revision is immutable. A new engine run adds a revision; it never edits an
// old one. Choosing the active revision is the only change, and it leaves every
// revision intact.

import { LIVE_MODEL, LOCAL_PROVIDER } from './contract.ts';
import type { AdapterEvent, GapReason, RevisionTiming, TimingQuality, TranscriptGap, TranscriptRevision, TranscriptSegment } from './contract.ts';

export const MAX_REVISIONS = 32;

/** Where the word times of each live model come from (#16617). */
const LIVE_TIMING: Record<string, RevisionTiming> = {
  [LIVE_MODEL]: { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 },
  // SHERPA_TIMING: the TDT token frames, moved 30 ms earlier.
  'parakeet-tdt-0.6b-v2-int8': { quality: 'approximate', method: 'tdt-token-times', correctionMs: -30 },
};

/** The models of a live revision and where its times come from. A recording can switch engine mid-way (a fallback). */
export function liveRevisionModel(segments: readonly TranscriptSegment[]): { model: string; timing: RevisionTiming } {
  // A segment saved before #16617 names no model: only Vosk ran live then.
  const models = [...new Set(segments.map((segment) => segment.model || LIVE_MODEL))];
  if (models.length === 0) models.push(LIVE_MODEL);
  if (models.length === 1) {
    const known = LIVE_TIMING[models[0]];
    return { model: models[0], timing: known ?? { quality: 'aligned', method: 'vosk-alignment', correctionMs: 0 } };
  }
  const timings = models.map((model) => LIVE_TIMING[model]).filter(Boolean);
  return {
    model: models.join('+'),
    // As in a final-pass retry over a live revision: the correction is the approximate segments' one.
    timing: {
      quality: 'mixed',
      method: [...new Set(timings.map((timing) => timing.method))].join('+'),
      correctionMs: timings.find((timing) => timing.quality === 'approximate')?.correctionMs ?? 0,
    },
  };
}

/** Builds the live revision from a session's events. Interim text never enters it. */
export class LiveRevisionCollector {
  private readonly head: { revisionId: string; model?: string; createdAtMs: number };
  private readonly segments: TranscriptSegment[] = [];
  private readonly gaps: TranscriptGap[] = [];

  /** Without `model`, the revision names the models of its segments. */
  constructor(head: { revisionId: string; createdAtMs: number; model?: string }) {
    this.head = head;
  }

  onEvent = (event: AdapterEvent): void => {
    if (event.type === 'segment' && event.segment.kind === 'final' && event.segment.text) this.segments.push(event.segment);
    if (event.type === 'gap') this.gaps.push(event.gap);
  };

  revision(): TranscriptRevision {
    const derived = liveRevisionModel(this.segments);
    return {
      revisionId: this.head.revisionId,
      provider: LOCAL_PROVIDER,
      model: this.head.model ?? derived.model,
      createdAtMs: this.head.createdAtMs,
      source: 'live',
      segments: [...this.segments].sort((a, b) => a.startMs - b.startMs),
      gaps: [...this.gaps].sort((a, b) => a.startMs - b.startMs),
      timing: derived.timing,
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The revisions of one recording. Append-only. */
export class RevisionSet {
  private readonly revisions: TranscriptRevision[] = [];
  private active: string | null = null;

  constructor(existing: TranscriptRevision[] = [], activeRevision: string | null = null) {
    for (const revision of existing) this.add(revision, { activate: false });
    if (activeRevision !== null) this.setActive(activeRevision);
  }

  get activeRevision(): string | null {
    return this.active;
  }

  nextId(): string {
    let n = this.revisions.length + 1;
    while (this.revisions.some((revision) => revision.revisionId === `r${n}`)) n += 1;
    return `r${n}`;
  }

  add(revision: TranscriptRevision, options: { activate?: boolean } = {}): void {
    if (this.revisions.some((existing) => existing.revisionId === revision.revisionId)) {
      throw new Error(`revision ${revision.revisionId} exists; a revision is never rewritten`);
    }
    if (this.revisions.length >= MAX_REVISIONS) throw new Error(`a recording holds at most ${MAX_REVISIONS} transcript revisions`);
    this.revisions.push(deepFreeze(structuredClone(revision)));
    if (options.activate ?? true) this.active = revision.revisionId;
  }

  setActive(revisionId: string): void {
    if (!this.get(revisionId)) throw new Error(`no revision ${revisionId}`);
    this.active = revisionId;
  }

  get(revisionId: string): TranscriptRevision | undefined {
    return this.revisions.find((revision) => revision.revisionId === revisionId);
  }

  /** A copy: the set itself changes only through `add`. */
  list(): readonly TranscriptRevision[] {
    return [...this.revisions];
  }
}

const CLOUD_GAP_REASONS = new Set<string>(['connect-failed', 'disconnected', 'provider-error', 'rate-limited', 'auth-failed', 'user-stopped-provider']);

/** `transcript/<revisionId>.json` as docs/bundle-schema.md §8.1 defines it. */
export interface BundleRevisionFile {
  revisionId: string;
  source: 'live' | 'after-recording';
  provider: string;
  model: string;
  language: 'en';
  createdAt: string;
  segments: {
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    words: { text: string; startMs: number; endMs: number; confidence?: number }[];
    /** Absent means `aligned`. */
    timing?: TimingQuality;
  }[];
  gaps: { startMs: number; endMs: number; reason: string; detail?: string }[];
  timing?: { quality: TimingQuality | 'mixed'; method: string; correctionMs: number };
  supersedes?: string;
}

/**
 * Converts a revision to the bundle file. Only final segments with text are
 * written. Segment and revision `timing`, `supersedes` and gap `detail` are
 * the fields #16541 accepted for schema 1.0; `extensions: false` leaves them
 * out. The shared history (`addRevision` in packages/transcription) writes the
 * same file.
 */
export function toBundleRevision(revision: TranscriptRevision, options: { extensions?: boolean } = {}): BundleRevisionFile {
  const extensions = options.extensions ?? true;
  const finals = revision.segments.filter((segment) => segment.kind === 'final' && segment.text);
  return {
    revisionId: revision.revisionId,
    source: revision.source,
    provider: revision.provider,
    model: revision.model,
    language: 'en',
    createdAt: new Date(revision.createdAtMs).toISOString(),
    segments: finals.map((segment, index) => ({
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
      ...(extensions ? { timing: segment.timing ?? 'aligned' } : {}),
    })),
    gaps: revision.gaps.map((gap) => {
      const cloud = CLOUD_GAP_REASONS.has(gap.reason);
      const detail = cloud ? gap.detail : [gap.reason === 'not-transcribed' ? '' : gap.reason, gap.detail ?? ''].filter(Boolean).join(': ');
      return {
        startMs: gap.startMs,
        endMs: gap.endMs,
        reason: cloud ? gap.reason : ('not-transcribed' satisfies GapReason),
        ...(extensions && detail ? { detail: detail.slice(0, 500) } : {}),
      };
    }),
    ...(extensions && revision.timing ? { timing: revision.timing } : {}),
    ...(extensions && revision.supersedes ? { supersedes: revision.supersedes } : {}),
  };
}
