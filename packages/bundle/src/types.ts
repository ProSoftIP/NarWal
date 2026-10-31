// NarWal recording bundle, schema 1.1. Specification: docs/bundle-schema.md (board #16541).
// Erasable TypeScript only, so Node runs it without a build step.

/** Milliseconds from recording start. */
export type SessionMs = number;

export type Basis = 'observed' | 'derived' | 'user-marked';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label'
  | 'alt'
  | 'title'
  | 'placeholder'
  | 'text'
  | 'none';

export interface ElementRef {
  node: number | null;
  tag: string;
  role: string | null;
  /** Absent when `excluded` is true. */
  name?: string;
  nameSource: NameSource;
  box?: Rect;
  excluded?: boolean;
}

export interface Manifest {
  format: 'narwal.bundle';
  schemaVersion: string;
  recordingId: string;
  title: string;
  /** What the person recorded this for, in their words (#16594). Absent when they gave none. */
  purpose?: string;
  createdAt: string;
  producer: { name: string; version: string };
  environment: { browser: string; browserVersion: string; platform: string };
  clock: { originEpochMs: number };
  durationMs: SessionMs;
  state: 'complete' | 'recovered';
  privacy: {
    inputValues: 'masked' | 'revealed-by-user';
    excludedRegions: number;
    urlPolicy: 'redact-query-values' | 'path-only' | 'full';
    audio: 'not-redacted';
  };
  derivation: { pointerDwellMinMs: number };
  audio: AudioInfo | null;
  transcript: { activeRevision: string | null };
  files: FileEntry[];
}

export interface AudioInfo {
  file: string;
  mediaType: string;
  clock: string;
  startMs: SessionMs;
  decodedMs: number;
}

export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}

export interface DocumentRecord {
  key: string;
  browserDocumentId?: string;
  frameId: number;
  parentKey: string | null;
  frameNode: number | null;
  url: string;
  title: string;
  navigationType: string;
  transition: string;
  attachedMs: SessionMs;
  detachedMs: SessionMs | null;
  attachments: { atMs: SessionMs; reason: 'boot' | 'bfcache-restore' | 'reconnect' }[];
  capture: 'full' | 'partial' | 'none';
  rrweb: string | null;
  /** The window (browser tab) the document was in; schema 1.1, present when documents.json lists windows. */
  window?: string;
}

/**
 * One browser tab or popup window the recording followed (schema 1.1, board
 * #16754). w1 is the tab the recording started in; a later one was opened by
 * a recorded window and recorded from the moment the person switched to it.
 */
export interface WindowRecord {
  key: string;
  opener: string | null;
  type: 'tab' | 'popup';
  openedMs: SessionMs;
  closedMs: SessionMs | null;
}

interface ObservationBase {
  id: string;
  basis: Basis;
  atMs: SessionMs;
  endMs?: SessionMs;
  doc?: string;
  /** Document scroll offset at event time, for observations with a target or rect. */
  scroll?: Point;
}

export type Observation =
  | (ObservationBase & { kind: 'recording'; state: 'started' | 'paused' | 'resumed' | 'stopped' })
  | (ObservationBase & { kind: 'route'; url: string; title?: string; transition: string })
  | (ObservationBase & { kind: 'pointer-dwell'; target: ElementRef; endMs: SessionMs })
  | (ObservationBase & { kind: 'click'; target: ElementRef; button: 'left' | 'middle'; count: 1 | 2; point: Point })
  | (ObservationBase & { kind: 'scroll'; target: ElementRef | null; endMs: SessionMs; from: Point; to: Point })
  | (ObservationBase & { kind: 'selection'; target: ElementRef; text?: string })
  | (ObservationBase & {
      kind: 'input';
      target: ElementRef;
      inputType: string;
      value: { state: 'masked' } | { state: 'revealed'; text: string };
      checked?: boolean;
      /** Edits coalesced into this record. */
      count?: number;
    })
  | (ObservationBase & {
      kind: 'marker-element';
      target: ElementRef;
      via?: 'right-click' | 'keyboard-focus' | 'keyboard-pointer';
      /** Absent for keyboard-focus. */
      point?: Point;
    })
  | (ObservationBase & {
      kind: 'marker-region';
      endMs: SessionMs;
      rect: Rect;
      scroll: Point;
      contains: ElementRef[];
      /** Visible page text inside the box, clipped to it (#16604). */
      text?: string;
    })
  | (ObservationBase & { kind: 'exclusion'; state: 'added' | 'removed'; target?: ElementRef; rect?: Rect })
  | (ObservationBase & { kind: 'visibility'; state: 'visible' | 'hidden' })
  | (ObservationBase & { kind: 'window'; window: string; state: 'opened' | 'focused' | 'closed'; opener?: string; url?: string; title?: string })
  | (ObservationBase & { kind: 'viewport'; w: number; h: number; dpr: number });

/** An observation kind added by a later minor version; kept and reported, never dropped. */
export interface UnknownObservation extends ObservationBase {
  kind: string;
  [field: string]: unknown;
}

export type GapScope = 'page' | 'frame' | 'audio' | 'any';

export interface Gap {
  id: string;
  scope: GapScope;
  startMs: SessionMs;
  endMs: SessionMs;
  reason: string;
  doc?: string;
  /** Schema 1.1: the window a page gap with no document was in (a restricted page in a followed popup). */
  window?: string;
  detail?: string;
}

export interface TranscriptWord {
  text: string;
  startMs: SessionMs;
  endMs: SessionMs;
  confidence?: number;
}

export interface TranscriptSegment {
  id: string;
  startMs: SessionMs;
  endMs: SessionMs;
  text: string;
  words: TranscriptWord[];
  /** Absent means aligned. */
  timing?: 'aligned' | 'approximate';
}

export interface TranscriptGap {
  startMs: SessionMs;
  endMs: SessionMs;
  reason: string;
  detail?: string;
}

export interface TranscriptRevision {
  revisionId: string;
  source: 'live' | 'after-recording';
  provider: 'browser-local' | 'deepgram' | 'assemblyai' | 'openai';
  model: string;
  language: string;
  createdAt: string;
  /** How word and segment times were obtained; absent means aligned. */
  timing?: { quality: 'aligned' | 'approximate' | 'mixed'; method: string; correctionMs: number };
  /** An earlier revision this one retries or finalizes. */
  supersedes?: string;
  /** The model's measured word error rate, so a reader knows the quality to expect (board #16611). */
  measured?: { werPct: number; basis: string };
  segments: TranscriptSegment[];
  gaps: TranscriptGap[];
}

export type Edit =
  | {
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
  | { id: string; type: 'note'; atMs: SessionMs; endMs?: SessionMs | null; text: string; createdAt: string; supersedes?: string }
  | { id: string; type: 'retract'; target: string; createdAt: string };

export interface ClockPair {
  frames: number;
  sampleRate: number;
  atMs: SessionMs;
}

export interface RrwebLine {
  seq: number;
  sentMs: SessionMs;
  receivedMs: SessionMs;
  event: { type: number; timestamp: number; [field: string]: unknown };
}

/** A bundle after validation; rrweb streams and audio stay in the source. */
export interface Bundle {
  manifest: Manifest;
  documents: DocumentRecord[];
  /** Schema 1.1: the recorded windows; empty when the recording had one. */
  windows: WindowRecord[];
  observations: (Observation | UnknownObservation)[];
  gaps: Gap[];
  revisions: Map<string, TranscriptRevision>;
  edits: Edit[];
  clockPairs: ClockPair[];
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Present only when `ok`. */
  bundle?: Bundle;
}

/** Where bundle bytes come from: a directory (Node), a zip or extension storage. */
export interface BundleSource {
  list(): Promise<SourceEntry[]>;
  read(path: string): Promise<Uint8Array>;
}

export interface SourceEntry {
  path: string;
  bytes: number;
  /** Anything other than a regular file (link, device, directory marker) is refused. */
  type: 'file' | 'other';
}
