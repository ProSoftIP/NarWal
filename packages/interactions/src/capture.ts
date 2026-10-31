// Interaction capture for one document (board #16543).
//
// Records hover/dwell, clicks, scrolling, selections, form edits, same-
// document route changes, viewport changes, excluded regions and explicit
// right-button markers as bundle observations (docs/bundle-schema.md §6).
//
// Privacy rules, enforced here and tested in real Chromium:
// - no typed value, value length or selected field text is ever read into an
//   observation;
// - an element inside a user-excluded region is reported as the excluded root
//   with no name, and excluded text never reaches a name or a selection;
// - events on the recorder UI ([data-narwal-ui]) are ignored.
//
// Every observation is measured when it happens, in the document that emits
// it: `box`/`rect` are viewport coordinates and `scroll` the document scroll
// offset at that instant.

import {
  PrivacyPolicy,
  TYPED_SELECTOR,
  boxOf,
  describe,
  elementOf,
  isRecorderUi,
  isTextField,
  meaningfulTarget,
  pageElementAt,
  rangeText,
  roundBox,
  roundPoint,
  scrollOf,
} from './dom.ts';
import type { NodeIdOf } from './dom.ts';
import { HighlightLayer } from './layer.ts';
import { RightButtonMarkers, deepActiveElement, viewportRectBetween } from './markers.ts';
import { regionContents } from './region.ts';
import type { Box, ElementRef, Observation, Point, RouteObservation } from './types.ts';

export interface CaptureOptions {
  /** Receives each observation as it completes. */
  emit(observation: Observation): void;
  /** Document key the writer uses for this document (schema `doc`). */
  doc: string;
  /** rrweb node ID of a node, e.g. `(n) => { const id = record.mirror.getId(n); return id > 0 ? id : null; }`. */
  nodeIdOf?: NodeIdOf;
  /** Selectors for the regions the user hid before recording (also passed to rrwebPrivacyOptions). */
  exclusions?: readonly string[];
  /**
   * Clock for `atMs`/`endMs`. Bundles want session ms (docs/bundle-schema.md §2), so the
   * content script passes one. Default: epoch ms on the performance clock.
   */
  now?: () => number;
  /** Shortest pointer rest reported as `pointer-dwell` (schema `derivation.pointerDwellMinMs`). */
  minDwellMs?: number;
  /** Edits to one field closer together than this form one `input` record. */
  editBurstMs?: number;
  /** A scroll is settled after this long without scroll events. */
  scrollSettleMs?: number;
  /** A selection is recorded after it stops changing for this long. */
  selectionSettleMs?: number;
  /** Right-button markers and the highlight overlay (default on). */
  markers?: boolean;
  /** Alt+Shift+M keyboard marker (default on). */
  keyboardShortcut?: boolean;
}

export interface InteractionCapture {
  /** Marks the focused element (or the element under the pointer); for a chrome.commands binding. */
  markFocused(): boolean;
  /** Emits everything still open (dwell, edit bursts, scrolls, selection) and removes all listeners and the overlay. */
  stop(): void;
}

const POLL_MS = 250;

interface Hover {
  el: Element;
  atMs: number;
  box: Box;
  scroll: Point;
  ref: ElementRef | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface ScrollRun {
  el: Element | null;
  atMs: number;
  lastMs: number;
  from: Point;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Burst {
  atMs: number;
  lastMs: number;
  count: number;
  inputType: string;
  target: ElementRef;
  scroll: Point;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Transition = RouteObservation['transition'];

const NAVIGATION_TYPES: Record<string, Transition> = {
  push: 'history-push',
  replace: 'history-replace',
  traverse: 'popstate',
  reload: 'other',
};

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function onlyHashDiffers(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, '');
  return strip(a) === strip(b) && a !== b;
}

export function startInteractionCapture(opts: CaptureOptions): InteractionCapture {
  const now = opts.now ?? (() => performance.timeOrigin + performance.now());
  const nodeIdOf: NodeIdOf = opts.nodeIdOf ?? (() => null);
  const minDwellMs = opts.minDwellMs ?? 300;
  const editBurstMs = opts.editBurstMs ?? 1500;
  const scrollSettleMs = opts.scrollSettleMs ?? 250;
  const selectionSettleMs = opts.selectionSettleMs ?? 300;
  const policy = new PrivacyPolicy(opts.exclusions);
  const doc = opts.doc;
  const emit = opts.emit;
  const ref = (el: Element) => describe(el, policy, nodeIdOf);

  const cleanups: Array<() => void> = [];
  function on<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void): void {
    const listener = fn as unknown as EventListener;
    const options = { capture: true, passive: true };
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  /** What a pointer at `hit` refers to: the meaningful element, or the excluded root that contains it. */
  function subjectOf(hit: Element): Element | null {
    if (isRecorderUi(hit)) return null;
    const meaningful = meaningfulTarget(hit);
    return policy.excludedRoot(meaningful) ?? meaningful;
  }

  function firstElement(e: Event): Element | null {
    const first = e.composedPath()[0];
    return first instanceof Element ? first : elementOf(first instanceof Node ? first : null);
  }

  // ---- hover / dwell (derived) ----
  let hover: Hover | null = null;
  let pointer: Point | null = null;
  let gestureActive = false;

  function endHover(t: number): void {
    const h = hover;
    hover = null;
    if (!h) return;
    clearTimeout(h.timer);
    if (t - h.atMs < minDwellMs) return;
    const target = h.ref ?? { ...ref(h.el), box: h.box };
    emit({ doc, kind: 'pointer-dwell', basis: 'derived', atMs: h.atMs, endMs: t, target, scroll: h.scroll });
  }

  function hoverTo(el: Element | null, t: number): void {
    if (hover && el === hover.el) return;
    endHover(t);
    if (!el) return;
    // Geometry when the pointer arrives; the name once the rest qualifies as a dwell.
    const h: Hover = { el, atMs: t, box: boxOf(el), scroll: scrollOf(), ref: null, timer: undefined };
    h.timer = setTimeout(() => {
      if (hover === h) h.ref = { ...ref(h.el), box: h.box };
    }, minDwellMs);
    hover = h;
  }

  /** The page can move under a still pointer (scroll, reflow): look again. */
  function rehit(): void {
    if (!pointer || gestureActive) return;
    const hit = pageElementAt(pointer.x, pointer.y);
    hoverTo(hit ? subjectOf(hit) : null, now());
  }

  on<PointerEvent>(window, 'pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer = { x: e.clientX, y: e.clientY };
    if (gestureActive) return;
    const hit = firstElement(e);
    hoverTo(hit ? subjectOf(hit) : null, now());
  });
  on<PointerEvent>(document, 'pointerout', (e) => {
    // Leaving the window (or into a child frame, which records itself).
    if (e.relatedTarget) return;
    endHover(now());
    pointer = null;
  });
  on(window, 'blur', () => endHover(now()));

  // ---- clicks (observed) ----
  function click(e: MouseEvent, button: 'left' | 'middle'): void {
    if (!e.isTrusted) return;
    const hit = firstElement(e);
    const subject = hit && subjectOf(hit);
    if (!subject) return;
    emit({
      doc,
      kind: 'click',
      basis: 'observed',
      atMs: now(),
      target: ref(subject),
      button,
      count: e.detail >= 2 ? 2 : 1,
      scroll: scrollOf(),
      // detail 0: activated from the keyboard, no pointer position.
      ...(e.detail > 0 ? { point: roundPoint({ x: e.clientX, y: e.clientY }) } : {}),
    });
  }
  on<MouseEvent>(window, 'click', (e) => {
    if (e.button === 0) click(e, 'left');
  });
  on<MouseEvent>(window, 'auxclick', (e) => {
    if (e.button === 1) click(e, 'middle');
  });

  // ---- scrolling (observed): one record per settled scroll ----
  const runs = new Map<EventTarget, ScrollRun>();
  const settled = new WeakMap<Element, Point>();
  let documentScroll = scrollOf();
  const elementScroll = (el: Element): Point => ({ x: el.scrollLeft, y: el.scrollTop });
  // Scroll positions at start, so a later scroll knows where it began.
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollTop || el.scrollLeft) settled.set(el, elementScroll(el));
  }

  function endScroll(key: EventTarget): void {
    const run = runs.get(key);
    if (!run) return;
    runs.delete(key);
    clearTimeout(run.timer);
    const to = run.el ? elementScroll(run.el) : scrollOf();
    if (run.el) settled.set(run.el, to);
    else documentScroll = to;
    if (samePoint(run.from, to)) return;
    emit({ doc, kind: 'scroll', basis: 'observed', atMs: run.atMs, endMs: run.lastMs, target: run.el ? ref(run.el) : null, from: run.from, to });
  }

  on<Event>(window, 'scroll', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el && isRecorderUi(el)) return;
    const key: EventTarget = el ?? document;
    const t = now();
    let run = runs.get(key);
    if (!run) {
      run = { el, atMs: t, lastMs: t, from: el ? (settled.get(el) ?? { x: 0, y: 0 }) : documentScroll, timer: undefined };
      runs.set(key, run);
    }
    run.lastMs = t;
    clearTimeout(run.timer);
    run.timer = setTimeout(() => endScroll(key), scrollSettleMs);
    rehit();
  });

  // ---- selection (observed) ----
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionAt = 0;
  let lastSelection: string | null = null;

  function readSelection(): void {
    selectionTimer = undefined;
    const active = deepActiveElement();
    if (active && isTextField(active) && !isRecorderUi(active)) {
      let start: number | null = null;
      let end: number | null = null;
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch {
        // Field type without a selection API.
      }
      if (start !== null && end !== null && start !== end) {
        // The selected text is a typed value: record where, never what (or how long).
        const key = `field:${nodeIdOf(active)}:${start}:${end}`;
        if (key !== lastSelection) {
          lastSelection = key;
          emit({ doc, kind: 'selection', basis: 'observed', atMs: selectionAt, target: ref(active), scroll: scrollOf() });
        }
        return;
      }
    }
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      lastSelection = null;
      return;
    }
    const range = selection.getRangeAt(0);
    const anchor = elementOf(selection.anchorNode);
    if (!anchor || isRecorderUi(anchor)) return;
    const text = rangeText(range, policy);
    const key = `${nodeIdOf(range.startContainer)}:${range.startOffset}:${nodeIdOf(range.endContainer)}:${range.endOffset}:${text}`;
    if (key === lastSelection) return;
    lastSelection = key;
    emit({ doc, kind: 'selection', basis: 'observed', atMs: selectionAt, target: ref(anchor), scroll: scrollOf(), ...(text ? { text } : {}) });
  }

  on(document, 'selectionchange', () => {
    selectionAt = now();
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(readSelection, selectionSettleMs);
  });

  // ---- form edits (observed); values are never read ----
  const bursts = new Map<Element, Burst>();

  function fieldOf(e: Event): Element | null {
    const el = firstElement(e);
    if (!el || isRecorderUi(el)) return null;
    return el.closest(TYPED_SELECTOR);
  }

  function flushBurst(field: Element): void {
    const b = bursts.get(field);
    if (!b) return;
    bursts.delete(field);
    clearTimeout(b.timer);
    const input = field as HTMLInputElement;
    const checkable = field.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio');
    emit({
      doc,
      kind: 'input',
      basis: 'observed',
      atMs: b.atMs,
      endMs: b.lastMs,
      target: b.target,
      scroll: b.scroll,
      inputType: b.inputType,
      count: b.count,
      value: { state: 'masked' },
      ...(checkable ? { checked: input.checked } : {}),
    });
  }

  function edit(field: Element, inputType: string): void {
    const t = now();
    let b = bursts.get(field);
    if (b && t - b.lastMs > editBurstMs) {
      flushBurst(field);
      b = undefined;
    }
    if (!b) {
      b = { atMs: t, lastMs: t, count: 0, inputType, target: ref(field), scroll: scrollOf(), timer: undefined };
      bursts.set(field, b);
    }
    b.count += 1;
    b.lastMs = t;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => flushBurst(field), editBurstMs);
  }

  // Only user edits are evidence: a page-dispatched input/change is not one.
  on<InputEvent>(window, 'input', (e) => {
    if (!e.isTrusted) return;
    const field = fieldOf(e);
    if (field) edit(field, e.inputType || 'change');
  });
  on<Event>(window, 'change', (e) => {
    if (!e.isTrusted) return;
    const field = fieldOf(e);
    if (!field) return;
    if (!bursts.has(field)) edit(field, 'change');
    flushBurst(field);
  });
  on<FocusEvent>(window, 'focusout', (e) => {
    const field = fieldOf(e);
    if (field) flushBurst(field);
  });

  // ---- same-document route changes (observed) ----
  let href = location.href;
  let pending: { url: string; transition: Transition } | null = null;

  function checkRoute(): void {
    const url = location.href;
    if (url === href) return;
    const previous = href;
    href = url;
    const transition: Transition = onlyHashDiffers(previous, url) ? 'hash' : pending && pending.url === url ? pending.transition : 'other';
    pending = null;
    emit({ doc, kind: 'route', basis: 'observed', atMs: now(), url, title: document.title, transition });
  }

  const navigation = (globalThis as { navigation?: EventTarget }).navigation;
  if (navigation && typeof navigation.addEventListener === 'function') {
    on<Event & { navigationType?: string; destination?: { url: string } }>(navigation, 'navigate', (e) => {
      if (e.destination) pending = { url: e.destination.url, transition: NAVIGATION_TYPES[e.navigationType ?? ''] ?? 'other' };
    });
    on(navigation, 'navigatesuccess', checkRoute);
  }
  on(window, 'popstate', () => {
    if (!pending || pending.url !== location.href) pending = { url: location.href, transition: 'popstate' };
    checkRoute();
  });
  on(window, 'hashchange', checkRoute);

  // ---- viewport (observed) ----
  let viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
  emit({ doc, kind: 'viewport', basis: 'observed', atMs: now(), ...viewport });
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  on(window, 'resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
      if (next.w === viewport.w && next.h === viewport.h && next.dpr === viewport.dpr) return;
      viewport = next;
      emit({ doc, kind: 'viewport', basis: 'observed', atMs: now(), ...viewport });
      rehit();
    }, 200);
  });

  // ---- excluded regions (observed): existence only, never content ----
  const reported = new Map<Element, ElementRef>();

  function scanExclusions(root: ParentNode): void {
    const found: Element[] = [];
    if (root instanceof Element && root.matches(policy.excludeSelector)) found.push(root);
    found.push(...root.querySelectorAll(policy.excludeSelector));
    for (const el of found) {
      if (reported.has(el) || policy.excludedRoot(el) !== el) continue;
      const target = ref(el);
      reported.set(el, target);
      emit({ doc, kind: 'exclusion', basis: 'observed', atMs: now(), state: 'added', target, scroll: scrollOf() });
    }
  }

  scanExclusions(document);
  const observer = new MutationObserver((mutations) => {
    let removed = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) if (node instanceof Element) scanExclusions(node);
      if (m.removedNodes.length) removed = true;
    }
    if (!removed) return;
    for (const [el, target] of reported) {
      if (el.isConnected) continue;
      reported.delete(el);
      emit({ doc, kind: 'exclusion', basis: 'observed', atMs: now(), state: 'removed', target, scroll: scrollOf() });
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // ---- explicit markers (user-marked) ----
  let layer: HighlightLayer | null = null;
  let markers: RightButtonMarkers | null = null;

  function speakable(target: ElementRef): string {
    if (target.excluded) return 'an excluded region';
    return target.name ? `"${target.name}" ${target.role ?? target.tag}` : `unnamed ${target.role ?? target.tag}`;
  }

  if (opts.markers !== false) {
    const highlights = new HighlightLayer();
    layer = highlights;
    markers = new RightButtonMarkers({
      layer: highlights,
      now,
      keyboardShortcut: opts.keyboardShortcut !== false,
      callbacks: {
        gesture(active) {
          // A marking gesture is drawing, not pointing: no dwell while it lasts.
          gestureActive = active;
          if (active) endHover(now());
        },
        element(el, via, point, t) {
          const subject = via === 'keyboard-focus' ? (policy.excludedRoot(el) ?? el) : subjectOf(el);
          if (!subject) return;
          const target = ref(subject);
          emit({ doc, kind: 'marker-element', basis: 'user-marked', atMs: t, target, via, scroll: scrollOf(), ...(point ? { point: roundPoint(point) } : {}) });
          highlights.flash(target.box);
          highlights.announce(`Marked ${speakable(target)}.`);
        },
        area(startDoc, endDoc, t0, t1) {
          const rect = roundBox(viewportRectBetween(startDoc, endDoc));
          const { contains, text } = regionContents(rect, policy, ref);
          emit({ doc, kind: 'marker-region', basis: 'user-marked', atMs: t0, endMs: t1, rect, scroll: scrollOf(), contains, ...(text ? { text } : {}) });
          highlights.announce(`Marked a box containing ${contains.length} element${contains.length === 1 ? '' : 's'}.`);
        },
      },
    });
    markers.attach();
  }

  const poll = setInterval(() => {
    checkRoute();
    rehit();
    layer?.ensureAttached();
  }, POLL_MS);

  let stopped = false;
  return {
    markFocused: () => (markers ? markers.markFocused() : false),
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      clearTimeout(resizeTimer);
      observer.disconnect();
      for (const cleanup of cleanups) cleanup();
      markers?.detach();
      layer?.remove();
      endHover(now());
      for (const field of [...bursts.keys()]) flushBurst(field);
      for (const key of [...runs.keys()]) endScroll(key);
      if (selectionTimer !== undefined) {
        clearTimeout(selectionTimer);
        readSelection();
      }
      checkRoute();
    },
  };
}
