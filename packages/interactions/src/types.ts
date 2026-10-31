// Interaction observations emitted by the NarWal content script (board #16543).
//
// Shapes follow docs/bundle-schema.md §6 (owned by board #16541; DRAFT 1.0).
// The content script emits them without `id`; the bundle writer assigns
// observation IDs, converts the clock if needed and sorts by `atMs`.
//
// Each observation belongs to ONE document (`doc`, the key the caller
// supplies). Coordinates are that document's CSS pixels: `box` and `rect` are
// viewport coordinates at the time of the observation and `scroll` is the
// document scroll offset at the same instant, so `box + scroll` is the
// document position even when the page scrolls or reflows later.

export interface Point {
  x: number;
  y: number;
}

/** Schema rectangle: viewport CSS px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NameSource = 'aria-label' | 'aria-labelledby' | 'label' | 'alt' | 'title' | 'placeholder' | 'text' | 'none';

/** schema §6.1 */
export interface ElementRef {
  /** rrweb node ID in this document's stream; null if unknown (not serialized yet). */
  node: number | null;
  tag: string;
  role: string | null;
  /** Accessible name or visible text, ≤ 120 chars; never a typed value; absent when excluded or unnamed. */
  name?: string;
  nameSource: NameSource;
  /** Viewport box at the time of the observation. */
  box: Box;
  /** Present (true) when the element is inside a user-excluded region; it is then the excluded root. */
  excluded?: true;
}

export type Basis = 'observed' | 'derived' | 'user-marked';

interface Base {
  /** Caller-supplied document key (schema `doc`). */
  doc: string;
  basis: Basis;
  /** Start time on the caller's clock (session ms when the writer passes session time). */
  atMs: number;
}

/** Document scroll offset when the observation's `box`/`rect` was measured. */
interface Scrolled {
  scroll: Point;
}

export interface DwellObservation extends Base, Scrolled {
  kind: 'pointer-dwell';
  basis: 'derived';
  endMs: number;
  /** The element as it was when the pointer arrived. */
  target: ElementRef;
}

export interface ClickObservation extends Base, Scrolled {
  kind: 'click';
  basis: 'observed';
  target: ElementRef;
  button: 'left' | 'middle';
  count: 1 | 2;
  /** Viewport point; absent for a keyboard-activated click. */
  point?: Point;
}

export interface ScrollObservation extends Base {
  kind: 'scroll';
  basis: 'observed';
  /** Null for the document; otherwise the scrolled element. */
  target: ElementRef | null;
  endMs: number;
  from: Point;
  to: Point;
}

export interface SelectionObservation extends Base, Scrolled {
  kind: 'selection';
  basis: 'observed';
  /** Anchor element (or the form field selected in). */
  target: ElementRef;
  /** Selected page text ≤ 500 chars. Absent inside a form field or when only excluded text was selected; excluded parts are always left out. */
  text?: string;
}

export interface InputObservation extends Base, Scrolled {
  kind: 'input';
  basis: 'observed';
  /** One record per burst of edits to one field: `atMs` first edit, `endMs` last. */
  endMs: number;
  target: ElementRef;
  /** InputEvent.inputType of the burst's first edit (`change` for a change-only edit). */
  inputType: string;
  /** Edits in the burst. */
  count: number;
  /** A masked value has no text and no length. */
  value: { state: 'masked' };
  checked?: boolean;
}

export interface RouteObservation extends Base {
  kind: 'route';
  basis: 'observed';
  url: string;
  title: string;
  transition: 'history-push' | 'history-replace' | 'popstate' | 'hash' | 'other';
}

export interface ElementMarkerObservation extends Base, Scrolled {
  kind: 'marker-element';
  basis: 'user-marked';
  target: ElementRef;
  via: 'right-click' | 'keyboard-focus' | 'keyboard-pointer';
  /** Viewport point for right-click and keyboard-pointer. */
  point?: Point;
}

export interface RegionMarkerObservation extends Base, Scrolled {
  kind: 'marker-region';
  basis: 'user-marked';
  /** Release time; `atMs` is the press. */
  endMs: number;
  /** The box at release, viewport coordinates; `scroll` is the offset at release. */
  rect: Box;
  /** ≤ 10 elements, outermost only, largest overlap first: meaningful elements at least half inside the box, and every element whose visible text the box crosses. An excluded root the box touches comes first, even inside a listed element. */
  contains: ElementRef[];
  /** Visible page text inside the box, clipped to it, ≤ 500 chars. Absent when the box holds no text or touches an excluded region; excluded and typed text are always left out. */
  text?: string;
}

export interface ExclusionObservation extends Base, Scrolled {
  kind: 'exclusion';
  basis: 'observed';
  state: 'added' | 'removed';
  /** The excluded root (`excluded: true`, no name). */
  target: ElementRef;
}

export interface ViewportObservation extends Base {
  kind: 'viewport';
  basis: 'observed';
  w: number;
  h: number;
  dpr: number;
}

export type Observation =
  | DwellObservation
  | ClickObservation
  | ScrollObservation
  | SelectionObservation
  | InputObservation
  | RouteObservation
  | ElementMarkerObservation
  | RegionMarkerObservation
  | ExclusionObservation
  | ViewportObservation;
