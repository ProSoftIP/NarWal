// The replay timeline of one validated bundle: which page shows at a session
// time, where narration audio is, which transcript line is spoken, which
// markers are visible, and which evidence is missing. Pure data, no DOM, so
// every seek decision is testable in Node.

import { buildAgentView } from '../../bundle/src/agent-view.ts';
import type { Bundle, DocumentRecord, Point, Rect, RrwebLine } from '../../bundle/src/types.ts';
import { audioClock, type AudioClock } from './audio-clock.ts';
import { missingResources, type MissingResources } from './resources.ts';

/**
 * Page timing tolerance. #16538: content script to recorder latency max
 * 4.6 ms, so a page state is placed to within 5 ms of its session time.
 */
export const PAGE_TOLERANCE_MS = 5;
/**
 * Audio to page tolerance while playing. #16538: the audio clock fit has a
 * residual of up to 52 ms, so the line itself is only known to that; the
 * player corrects the audio only when it is further off than 60 ms.
 */
export const AUDIO_SYNC_TOLERANCE_MS = 60;
/** How long an instant marker (element, click) stays drawn. */
export const MARKER_HOLD_MS = 2000;
export const CLICK_HOLD_MS = 600;
/** A region marker drawn faster than this still stays this long. */
export const MIN_REGION_MS = MARKER_HOLD_MS;

/** Recorded page gaps after which nothing of the page is known. */
const NO_PAGE_REASONS = new Set([
  'restricted-page',
  'navigation-blind-window',
  'injection-failed',
  'recorder-paused',
  'recovery-truncated',
]);

export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
  [field: string]: unknown;
}

export interface ReplayPage {
  doc: DocumentRecord;
  /** Sorted by timestamp. */
  events: RrwebEvent[];
  /** Session ms of the first event: rrweb offsets count from here. */
  firstEventMs: number;
  lastEventMs: number;
  /** Session ms of every full snapshot. */
  snapshotMs: number[];
  /** Recorded viewport (latest meta event), if any. */
  viewport: { w: number; h: number } | null;
  missing: MissingResources;
}

/** One stretch of the session during which a top-level document was showing in its window. */
export interface PageSpan {
  docKey: string;
  fromMs: number;
  toMs: number;
  /** The window (schema 1.1) the document was in; null in a recording of one window. */
  window?: string | null;
}

/** A window the recording followed (schema 1.1, board #16754). */
export interface ReplayWindow {
  key: string;
  /** 1 for the tab the recording started in. */
  number: number;
  type: string;
  opener: string | null;
  openedMs: number;
  closedMs: number | null;
  /** The title of the page it opened with; empty when none is known. */
  title: string;
}

/** Which window was in front from fromMs to toMs. */
export interface FocusSpan {
  window: string;
  fromMs: number;
  toMs: number;
}

export type GapEffect = 'no-page' | 'partial-page' | 'no-audio' | 'no-transcript';

export interface ReplayGap {
  /** Bundle gap ID; null for a transcript gap or a gap replay derived. */
  id: string | null;
  scope: string;
  reason: string;
  detail?: string;
  doc?: string;
  /** The window of a gap with no document (schema 1.1). */
  window?: string;
  startMs: number;
  endMs: number;
  effect: GapEffect;
  /** True when no recorded gap explains it and replay found it from the evidence. */
  derived: boolean;
}

export interface Utterance {
  segmentId: string;
  revisionId: string;
  startMs: number;
  endMs: number;
  text: string;
  corrected: boolean;
  heard?: string;
  approximate: boolean;
}

export interface ReplayNote {
  id: string;
  atMs: number;
  endMs: number | null;
  text: string;
}

export type MarkerKind = 'click' | 'dwell' | 'element' | 'region';

export interface Marker {
  /** Observation ID. */
  id: string;
  kind: MarkerKind;
  doc: string;
  startMs: number;
  endMs: number;
  /** Viewport CSS pixels at the time of the event. */
  rect: Rect | null;
  point: Point | null;
}

export interface ReplayModel {
  recordingId: string;
  title: string;
  durationMs: number;
  originEpochMs: number;
  pages: Map<string, ReplayPage>;
  spans: PageSpan[];
  /** Empty in a recording of one window. */
  windows: ReplayWindow[];
  /** Which window was in front over time; empty in a recording of one window. */
  focus: FocusSpan[];
  gaps: ReplayGap[];
  audio: { file: string; mediaType: string; clock: AudioClock } | null;
  transcript: { revisionId: string; provider: string; model: string; source: string; approximate: boolean } | null;
  utterances: Utterance[];
  notes: ReplayNote[];
  markers: Marker[];
  /** Child frames: recorded in their own streams, not drawn inside the page. */
  frames: DocumentRecord[];
}

export interface ReplayState {
  t: number;
  /** The page to draw and the rrweb offset (ms from its first event); null when no page is known. */
  page: { docKey: string; offsetMs: number } | null;
  /** The window in front at `t` (schema 1.1); null in a recording of one window. */
  window: string | null;
  /** Gaps that cover `t`, any effect. */
  gaps: ReplayGap[];
  /** Media seconds to play; null when there is no narration at `t`. */
  audio: { mediaSec: number } | null;
  /** Index into `utterances`, or -1. */
  utterance: number;
  markers: Marker[];
  notes: ReplayNote[];
}

/** Parses one `rrweb/<doc>.jsonl` file. The bundle validator has already checked the envelope. */
export function parseRrwebStream(bytes: Uint8Array): RrwebLine[] {
  const text = new TextDecoder().decode(bytes);
  const lines: RrwebLine[] = [];
  for (const line of text.split('\n')) if (line) lines.push(JSON.parse(line) as RrwebLine);
  return lines;
}

function pageOf(doc: DocumentRecord, lines: readonly RrwebLine[], originEpochMs: number): ReplayPage {
  const events = lines.map((l) => l.event as RrwebEvent).sort((a, b) => a.timestamp - b.timestamp);
  const at = (e: RrwebEvent) => e.timestamp - originEpochMs;
  let viewport: ReplayPage['viewport'] = null;
  for (const e of events) {
    const data = e.data as { width?: unknown; height?: unknown } | undefined;
    if (e.type === 4 && typeof data?.width === 'number' && typeof data.height === 'number') {
      viewport = { w: data.width, h: data.height };
    }
  }
  return {
    doc,
    events,
    firstEventMs: events.length ? at(events[0]!) : doc.attachedMs,
    lastEventMs: events.length ? at(events[events.length - 1]!) : doc.attachedMs,
    snapshotMs: events.filter((e) => e.type === 2).map(at),
    viewport,
    missing: missingResources(events),
  };
}

// Each window has its own sequence of pages: a page shows until the next one
// in the same window attaches.
function windowSpans(topDocs: DocumentRecord[], durationMs: number): PageSpan[] {
  const byWindow = new Map<string | null, DocumentRecord[]>();
  for (const doc of topDocs) byWindow.set(doc.window ?? null, [...(byWindow.get(doc.window ?? null) ?? []), doc]);
  if (byWindow.size === 1 && byWindow.has(null)) return spansOf(topDocs, durationMs);
  return [...byWindow]
    .flatMap(([window, docs]) => spansOf(docs, durationMs).map((s) => ({ ...s, window })))
    .sort((a, b) => a.fromMs - b.fromMs);
}

// The window in front: the first until another opens or is switched to; a
// window that closes in front hands back to the one that opened it.
function focusOf(bundle: Bundle, durationMs: number): FocusSpan[] {
  const windows = bundle.windows ?? [];
  if (windows.length < 2) return [];
  const openerOf = new Map(windows.map((w) => [w.key, w.opener]));
  const changes: { atMs: number; window: string }[] = [{ atMs: 0, window: windows[0]!.key }];
  for (const o of bundle.observations) {
    if (o.kind !== 'window') continue;
    const w = o as { atMs: number; window: string; state: string };
    const current = changes[changes.length - 1]!.window;
    if (w.state !== 'closed') changes.push({ atMs: w.atMs, window: w.window });
    else if (current === w.window) changes.push({ atMs: w.atMs, window: openerOf.get(w.window) ?? windows[0]!.key });
  }
  const spans: FocusSpan[] = [];
  changes.forEach((c, i) => {
    const toMs = Math.min(changes[i + 1]?.atMs ?? durationMs, durationMs);
    if (toMs <= c.atMs) return;
    const last = spans[spans.length - 1];
    if (last && last.window === c.window) last.toMs = toMs;
    else spans.push({ window: c.window, fromMs: c.atMs, toMs });
  });
  return spans;
}

function windowsOf(bundle: Bundle): ReplayWindow[] {
  const windows = bundle.windows ?? [];
  if (windows.length < 2) return [];
  return windows.map((w, i) => {
    const opened = bundle.observations.find((o) => o.kind === 'window' && (o as { window?: string; state?: string }).window === w.key && (o as { state?: string }).state === 'opened') as
      | { title?: string }
      | undefined;
    const first = bundle.documents.filter((d) => d.frameId === 0 && d.window === w.key).sort((a, b) => a.attachedMs - b.attachedMs)[0];
    return { key: w.key, number: i + 1, type: w.type, opener: w.opener, openedMs: w.openedMs, closedMs: w.closedMs, title: opened?.title || first?.title || '' };
  });
}

function spansOf(topDocs: DocumentRecord[], durationMs: number): PageSpan[] {
  const starts = topDocs
    .flatMap((doc) => (doc.attachments.length ? doc.attachments : [{ atMs: doc.attachedMs }]).map((a) => ({ doc, atMs: a.atMs })))
    .sort((a, b) => a.atMs - b.atMs);
  const spans: PageSpan[] = [];
  starts.forEach(({ doc, atMs }, i) => {
    const next = starts[i + 1]?.atMs ?? durationMs;
    const detached = doc.detachedMs !== null && doc.detachedMs > atMs ? doc.detachedMs : durationMs;
    const toMs = Math.min(next, detached, durationMs);
    if (toMs > atMs) spans.push({ docKey: doc.key, fromMs: atMs, toMs });
  });
  return spans;
}

/** Where page content exists: from the first usable snapshot of each span to its end. */
function contentSpans(spans: PageSpan[], pages: Map<string, ReplayPage>): PageSpan[] {
  const out: PageSpan[] = [];
  for (const span of spans) {
    const page = pages.get(span.docKey);
    if (!page) continue;
    const before = page.snapshotMs.some((s) => s <= span.fromMs);
    const first = before ? span.fromMs : page.snapshotMs.find((s) => s > span.fromMs && s < span.toMs);
    if (first !== undefined) out.push({ docKey: span.docKey, fromMs: first, toMs: span.toMs });
  }
  return out;
}

/** Intervals of [0, duration) that `covered` leaves open. */
function uncovered(covered: { fromMs: number; toMs: number }[], durationMs: number): { fromMs: number; toMs: number }[] {
  const sorted = [...covered].sort((a, b) => a.fromMs - b.fromMs);
  const open: { fromMs: number; toMs: number }[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.fromMs > cursor) open.push({ fromMs: cursor, toMs: Math.min(c.fromMs, durationMs) });
    cursor = Math.max(cursor, c.toMs);
  }
  if (cursor < durationMs) open.push({ fromMs: cursor, toMs: durationMs });
  return open.filter((o) => o.toMs > o.fromMs);
}

function effectOf(scope: string, reason: string): GapEffect {
  if (scope === 'audio') return 'no-audio';
  if ((scope === 'page' || scope === 'any') && NO_PAGE_REASONS.has(reason)) return 'no-page';
  return 'partial-page';
}

function markersOf(bundle: Bundle): Marker[] {
  const markers: Marker[] = [];
  for (const o of bundle.observations) {
    if (!o.doc) continue;
    const base = { id: o.id, doc: o.doc, startMs: o.atMs };
    const target = (o as { target?: { box?: Rect } | null }).target;
    const box = target?.box ?? null;
    const point = ((o as { point?: Point }).point ?? null) as Point | null;
    switch (o.kind) {
      case 'click':
        markers.push({ ...base, kind: 'click', endMs: o.atMs + CLICK_HOLD_MS, rect: box, point });
        break;
      case 'pointer-dwell':
        if (box) markers.push({ ...base, kind: 'dwell', endMs: o.endMs ?? o.atMs, rect: box, point: null });
        break;
      case 'marker-element':
        markers.push({ ...base, kind: 'element', endMs: o.atMs + MARKER_HOLD_MS, rect: box, point });
        break;
      case 'marker-region': {
        const rect = (o as { rect: Rect }).rect;
        const end = Math.max(o.endMs ?? o.atMs, o.atMs + MIN_REGION_MS);
        markers.push({ ...base, kind: 'region', endMs: end, rect, point: null });
        break;
      }
      default:
        break;
    }
  }
  return markers.sort((a, b) => a.startMs - b.startMs);
}

/** Builds the timeline. `streams` holds the parsed rrweb file of each document that has one. */
export function buildReplayModel(bundle: Bundle, streams: ReadonlyMap<string, readonly RrwebLine[]>): ReplayModel {
  const { manifest } = bundle;
  const origin = manifest.clock.originEpochMs;
  const durationMs = manifest.durationMs;

  const pages = new Map<string, ReplayPage>();
  for (const doc of bundle.documents) {
    const lines = streams.get(doc.key);
    if (doc.rrweb && lines) pages.set(doc.key, pageOf(doc, lines, origin));
  }
  const topDocs = bundle.documents.filter((d) => d.frameId === 0);
  const spans = windowSpans(topDocs, durationMs);

  const gaps: ReplayGap[] = bundle.gaps.map((g) => ({
    id: g.id,
    scope: g.scope,
    reason: g.reason,
    ...(g.detail === undefined ? {} : { detail: g.detail }),
    ...(g.doc === undefined ? {} : { doc: g.doc }),
    ...(g.window === undefined ? {} : { window: g.window }),
    startMs: g.startMs,
    endMs: g.endMs,
    effect: effectOf(g.scope, g.reason),
    derived: false,
  }));
  // `any` gaps silence the narration too.
  for (const g of bundle.gaps) {
    if (g.scope === 'any') {
      gaps.push({ id: g.id, scope: g.scope, reason: g.reason, startMs: g.startMs, endMs: g.endMs, effect: 'no-audio', derived: false });
    }
  }

  // Page time with no snapshot and no recorded reason is still a gap, and says so.
  const recordedNoPage = gaps.filter((g) => g.effect === 'no-page').map((g) => ({ fromMs: g.startMs, toMs: g.endMs }));
  for (const open of uncovered(contentSpans(spans, pages), durationMs)) {
    for (const rest of uncovered(recordedNoPage.map((r) => ({ fromMs: r.fromMs - open.fromMs, toMs: r.toMs - open.fromMs })), open.toMs - open.fromMs)) {
      gaps.push({
        id: null,
        scope: 'page',
        reason: 'no-page-evidence',
        startMs: open.fromMs + rest.fromMs,
        endMs: open.fromMs + rest.toMs,
        effect: 'no-page',
        derived: true,
      });
    }
  }
  if (!manifest.audio) {
    const explained = gaps.filter((g) => g.effect === 'no-audio').map((g) => ({ fromMs: g.startMs, toMs: g.endMs }));
    for (const open of uncovered(explained, durationMs)) {
      gaps.push({ id: null, scope: 'audio', reason: 'no-narration', startMs: open.fromMs, endMs: open.toMs, effect: 'no-audio', derived: true });
    }
  }

  const view = buildAgentView(bundle);
  const revisionId = manifest.transcript.activeRevision;
  const revision = revisionId ? bundle.revisions.get(revisionId) : undefined;
  const approximateSegments = new Set(revision?.segments.filter((s) => s.timing === 'approximate').map((s) => s.id) ?? []);
  const utterances: Utterance[] = [];
  const notes: ReplayNote[] = [];
  for (const entry of view.entries) {
    if (entry.kind === 'utterance') {
      utterances.push({
        segmentId: entry.said.segmentId,
        revisionId: entry.said.revisionId,
        startMs: entry.startMs,
        endMs: entry.endMs,
        text: entry.said.text,
        corrected: entry.said.corrected,
        ...(entry.said.heard === undefined ? {} : { heard: entry.said.heard }),
        approximate: approximateSegments.has(entry.said.segmentId),
      });
    } else if (entry.kind === 'note') {
      notes.push({ id: entry.note.ref, atMs: entry.startMs, endMs: entry.endMs ?? null, text: entry.note.text });
    }
  }
  for (const g of revision?.gaps ?? []) {
    gaps.push({
      id: null,
      scope: 'transcript',
      reason: g.reason,
      ...(g.detail === undefined ? {} : { detail: g.detail }),
      startMs: g.startMs,
      endMs: g.endMs,
      effect: 'no-transcript',
      derived: false,
    });
  }
  gaps.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return {
    recordingId: manifest.recordingId,
    title: manifest.title,
    durationMs,
    originEpochMs: origin,
    pages,
    spans,
    windows: windowsOf(bundle),
    focus: focusOf(bundle, durationMs),
    gaps,
    audio: manifest.audio
      ? {
          file: manifest.audio.file,
          mediaType: manifest.audio.mediaType,
          clock: audioClock(bundle.clockPairs, manifest.audio.startMs, manifest.audio.decodedMs, bundle.gaps.filter((g) => g.scope === 'audio')),
        }
      : null,
    transcript:
      revision && revisionId
        ? {
            revisionId,
            provider: revision.provider,
            model: revision.model,
            source: revision.source,
            approximate: revision.timing?.quality === 'approximate' || revision.timing?.quality === 'mixed' || approximateSegments.size > 0,
          }
        : null,
    utterances,
    notes,
    markers: markersOf(bundle),
    frames: bundle.documents.filter((d) => d.frameId !== 0),
  };
}

const covers = (from: number, to: number, t: number) => from <= t && t < to;

/** A derived no-page gap shorter than this at a page boundary is a page loading, not lost evidence. */
export const SETTLE_GAP_MS = 1000;

/**
 * Board #27487: the gaps the "Missing evidence" list shows. A derived no-page
 * gap under SETTLE_GAP_MS at recording start, at the end, or where one page
 * hands over to the next is the browser loading, so it is left out; it stays
 * in `model.gaps` for the timeline and the stage. A recorded gap, a longer
 * gap, a gap mid-page, and a page that never had a snapshot are always listed.
 */
export function listedGaps(model: ReplayModel): ReplayGap[] {
  return model.gaps.filter((g) => !settling(model, g));
}

function settling(model: ReplayModel, g: ReplayGap): boolean {
  if (!g.derived || g.effect !== 'no-page' || g.endMs - g.startMs >= SETTLE_GAP_MS) return false;
  if (model.spans.some((s) => s.fromMs >= g.startMs && s.toMs <= g.endMs)) return false;
  const inside = (ms: number) => ms >= g.startMs && ms <= g.endMs;
  return g.startMs <= 0 || g.endMs >= model.durationMs || model.spans.some((s) => inside(s.fromMs) || inside(s.toMs));
}

/** Everything replay shows at session time `t` (clamped to the recording). */
export function stateAt(model: ReplayModel, time: number): ReplayState {
  const t = Math.min(Math.max(time, 0), model.durationMs);
  // The last instant still shows the final state, not an empty stage.
  const probe = t < model.durationMs ? t : Math.max(0, model.durationMs - 0.001);
  const gaps = model.gaps.filter((g) => covers(g.startMs, g.endMs, probe) || (g.startMs === g.endMs && g.startMs === t));

  let page: ReplayState['page'] = null;
  // With more than one window, the page of the window in front. When that
  // window has no page yet, any window that has one, unless a gap says why
  // the window in front shows none (a restricted page in a popup).
  const gapWindow = (g: ReplayGap) => (g.doc !== undefined ? (model.pages.get(g.doc)?.doc.window ?? null) : (g.window ?? null));
  const window = model.focus.find((f) => covers(f.fromMs, f.toMs, probe))?.window ?? null;
  const own = window !== null ? model.spans.find((s) => s.window === window && covers(s.fromMs, s.toMs, probe)) : undefined;
  const explained = window !== null && gaps.some((g) => g.effect === 'no-page' && gapWindow(g) === window);
  const span = own ?? (explained ? undefined : model.spans.find((s) => covers(s.fromMs, s.toMs, probe)));
  // A page gap of another window does not hide this one.
  const hidden = gaps.some((g) => g.effect === 'no-page' && (gapWindow(g) === null || !span || gapWindow(g) === (span.window ?? null)));
  const shown = span ? model.pages.get(span.docKey) : undefined;
  if (shown && !hidden && shown.snapshotMs.some((s) => s <= t)) {
    page = { docKey: shown.doc.key, offsetMs: Math.max(0, t - shown.firstEventMs) };
  }

  let audio: ReplayState['audio'] = null;
  if (model.audio && !gaps.some((g) => g.effect === 'no-audio')) {
    const mediaSec = model.audio.clock.mediaAt(probe);
    if (mediaSec !== null && mediaSec >= 0) audio = { mediaSec };
  }

  let utterance = -1;
  for (let i = 0; i < model.utterances.length; i++) {
    const u = model.utterances[i]!;
    if (u.startMs > t) break;
    if (covers(u.startMs, u.endMs, probe)) utterance = i;
  }

  return {
    t,
    page,
    window: span?.window ?? window,
    gaps,
    audio,
    utterance,
    markers: page ? model.markers.filter((m) => m.doc === page.docKey && covers(m.startMs, m.endMs, probe)) : [],
    notes: model.notes.filter((n) => covers(n.atMs, n.endMs ?? n.atMs + MARKER_HOLD_MS, probe)),
  };
}
