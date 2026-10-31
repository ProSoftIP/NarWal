// Right-button highlighting (board #16543).
//
// Matt: "we should be able to highlight something with a right click and also
// draw a box to highlight with right button".
//
// While recording:
// - right press and release without moving `dragThreshold` CSS px marks the
//   element under the pointer;
// - right press, drag and release draws a box (area marker);
// - Escape during a drag cancels it;
// - Shift + right-click is left alone, so the native context menu opens;
//   a keyboard-invoked context menu (menu key, Shift+F10) is also left alone;
// - Alt+Shift+M marks the focused element, or the element under the pointer
//   when nothing is focused (keyboard alternative to right-click).
//
// The page never sees a marking gesture: pointerdown/up, the compatibility
// mouse events, contextmenu and auxclick are stopped in the capture phase
// at the window, which runs before page listeners because the content script
// registers at document_start.
//
// Only trusted (user-agent) events count: a page that dispatches its own
// PointerEvent or KeyboardEvent must not create a user-marked highlight,
// open a gesture, or cancel the user's.

import { isRecorderUi, pageElementAt, scrollOf } from './dom.ts';
import type { HighlightLayer } from './layer.ts';
import type { Box, Point } from './types.ts';

export interface MarkerCallbacks {
  /** Right-click or keyboard marker on one element. */
  element(el: Element, via: 'right-click' | 'keyboard-focus' | 'keyboard-pointer', point: Point | null, t: number): void;
  /** Right-button drag; corners in document coordinates (CSS px, this document). */
  area(startDoc: Point, endDoc: Point, t0: number, t1: number): void;
  /** Gesture state changes; hover inference pauses while a gesture is active. */
  gesture?(active: boolean): void;
}

export interface MarkerOptions {
  layer: HighlightLayer;
  now: () => number;
  callbacks: MarkerCallbacks;
  /** Minimum pointer travel, in CSS px, for a box instead of an element marker. */
  dragThreshold?: number;
  /** Install the Alt+Shift+M keyboard marker. */
  keyboardShortcut?: boolean;
}

interface Gesture {
  pointerId: number;
  startClient: Point;
  startDoc: Point;
  lastClient: Point;
  t0: number;
  dragging: boolean;
  box: HTMLElement | null;
}

const CONTEXT_MENU_GRACE_MS = 1000;

function swallow(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Deepest focused element, looking into open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Viewport rectangle spanning two document points, at the current scroll. */
export function viewportRectBetween(a: Point, b: Point): Box {
  const scroll = scrollOf();
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x: x - scroll.x, y: y - scroll.y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export class RightButtonMarkers {
  readonly #opts: Required<Omit<MarkerOptions, 'layer' | 'now' | 'callbacks'>> & MarkerOptions;
  #gesture: Gesture | null = null;
  /** Until this time, a right-button auxclick/mouseup belongs to our gesture. */
  #swallowUntil = 0;
  /** Our gesture's contextmenu has not arrived yet (it fires at press on Linux/macOS, after release on Windows). */
  #menuPending = false;
  #lastPointer: Point | null = null;
  readonly #listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(opts: MarkerOptions) {
    this.#opts = { dragThreshold: 6, keyboardShortcut: true, ...opts };
  }

  get active(): boolean {
    return this.#gesture !== null;
  }

  attach(win: Window = window): void {
    const on = (type: string, fn: (e: never) => void) => {
      const listener = fn as unknown as EventListener;
      win.addEventListener(type, listener, { capture: true });
      this.#listeners.push([win, type, listener]);
    };
    on('pointerdown', (e: PointerEvent) => this.#down(e));
    on('pointermove', (e: PointerEvent) => this.#move(e));
    on('pointerup', (e: PointerEvent) => this.#up(e));
    on('pointercancel', (e: PointerEvent) => this.#cancel(e));
    on('mousedown', (e: MouseEvent) => this.#mouse(e));
    on('mouseup', (e: MouseEvent) => this.#mouse(e));
    on('auxclick', (e: MouseEvent) => this.#mouse(e));
    on('contextmenu', (e: MouseEvent) => this.#contextMenu(e));
    on('keydown', (e: KeyboardEvent) => this.#key(e));
    on('scroll', () => this.#redraw());
    on('blur', (e: FocusEvent) => {
      if (e.isTrusted) this.#abort();
    });
  }

  detach(): void {
    for (const [target, type, listener] of this.#listeners) target.removeEventListener(type, listener, { capture: true });
    this.#listeners.length = 0;
    this.#abort();
  }

  /** Marks the focused element, or the element under the pointer when nothing is focused. */
  markFocused(): boolean {
    const t = this.#opts.now();
    const active = deepActiveElement();
    if (active && active !== document.body && active !== document.documentElement && !isRecorderUi(active)) {
      this.#opts.callbacks.element(active, 'keyboard-focus', null, t);
      return true;
    }
    if (this.#lastPointer) {
      const el = pageElementAt(this.#lastPointer.x, this.#lastPointer.y);
      if (el) {
        this.#opts.callbacks.element(el, 'keyboard-pointer', { ...this.#lastPointer }, t);
        return true;
      }
    }
    this.#opts.layer.announce('Nothing to mark: focus an element or point at it first.');
    return false;
  }

  #down(e: PointerEvent): void {
    if (!e.isTrusted || e.button !== 2) return;
    if (e.shiftKey || isRecorderUi(e.target as Node)) {
      this.#menuPending = false;
      return;
    }
    swallow(e);
    if (this.#gesture) return;
    const scroll = scrollOf();
    const start = { x: e.clientX, y: e.clientY };
    this.#gesture = {
      pointerId: e.pointerId,
      startClient: start,
      startDoc: { x: start.x + scroll.x, y: start.y + scroll.y },
      lastClient: start,
      t0: this.#opts.now(),
      dragging: false,
      box: null,
    };
    this.#swallowUntil = Number.POSITIVE_INFINITY;
    this.#menuPending = true;
    this.#opts.callbacks.gesture?.(true);
  }

  #move(e: PointerEvent): void {
    if (!e.isTrusted) return;
    if (!isRecorderUi(e.target as Node)) this.#lastPointer = { x: e.clientX, y: e.clientY };
    const g = this.#gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    swallow(e);
    if ((e.buttons & 2) === 0) {
      // The release happened outside the window: finish where we last saw it.
      this.#finish();
      return;
    }
    g.lastClient = { x: e.clientX, y: e.clientY };
    if (!g.dragging && Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) >= this.#opts.dragThreshold) {
      g.dragging = true;
    }
    this.#redraw();
  }

  #redraw(): void {
    const g = this.#gesture;
    if (!g || !g.dragging) return;
    const scroll = scrollOf();
    const rect = viewportRectBetween(g.startDoc, { x: g.lastClient.x + scroll.x, y: g.lastClient.y + scroll.y });
    if (g.box) this.#opts.layer.move(g.box, rect);
    else g.box = this.#opts.layer.box(rect, 'drag');
  }

  #up(e: PointerEvent): void {
    const g = this.#gesture;
    if (!e.isTrusted || e.button !== 2) return;
    if (!g) {
      // The release after an Escape-cancelled drag is still ours.
      if (!e.shiftKey && this.#opts.now() <= this.#swallowUntil) swallow(e);
      return;
    }
    swallow(e);
    g.lastClient = { x: e.clientX, y: e.clientY };
    this.#finish();
  }

  #finish(): void {
    const g = this.#gesture;
    if (!g) return;
    this.#gesture = null;
    g.box?.remove();
    this.#swallowUntil = this.#opts.now() + CONTEXT_MENU_GRACE_MS;
    this.#opts.callbacks.gesture?.(false);
    const t1 = this.#opts.now();
    if (g.dragging) {
      const scroll = scrollOf();
      const endDoc = { x: g.lastClient.x + scroll.x, y: g.lastClient.y + scroll.y };
      this.#opts.layer.flash(viewportRectBetween(g.startDoc, endDoc));
      this.#opts.callbacks.area(g.startDoc, endDoc, g.t0, t1);
      return;
    }
    const el = pageElementAt(g.startClient.x, g.startClient.y);
    if (el) this.#opts.callbacks.element(el, 'right-click', g.startClient, t1);
  }

  #cancel(e: PointerEvent): void {
    if (e.isTrusted && this.#gesture && e.pointerId === this.#gesture.pointerId) this.#abort();
  }

  #abort(): void {
    if (!this.#gesture) return;
    this.#gesture.box?.remove();
    this.#gesture = null;
    this.#swallowUntil = this.#opts.now() + CONTEXT_MENU_GRACE_MS;
    this.#opts.callbacks.gesture?.(false);
  }

  #mouse(e: MouseEvent): void {
    if (!e.isTrusted || e.button !== 2) return;
    if (this.#gesture || (!e.shiftKey && this.#opts.now() <= this.#swallowUntil)) swallow(e);
  }

  #contextMenu(e: MouseEvent): void {
    if (!e.isTrusted) return;
    // Only the one menu our right-button gesture would open is suppressed;
    // Shift + right-click and keyboard menus never start a gesture.
    if (this.#menuPending && (this.#gesture || this.#opts.now() <= this.#swallowUntil)) {
      swallow(e);
      this.#menuPending = false;
    }
  }

  #key(e: KeyboardEvent): void {
    if (!e.isTrusted) return;
    if (e.key === 'Escape' && this.#gesture) {
      swallow(e);
      this.#abort();
      this.#opts.layer.announce('Highlight cancelled.');
      return;
    }
    if (this.#opts.keyboardShortcut && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM' && !e.repeat) {
      swallow(e);
      this.markFocused();
    }
  }
}
