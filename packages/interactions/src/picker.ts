// Pre-capture region picker (board #16543: "keep visible text by default,
// and let the user hide regions before capture").
//
// While the picker runs, the page is inert to the pointer: clicks choose
// regions instead of activating anything.
// - Pointer: hover outlines the element under the pointer; click toggles it.
// - Keyboard: Tab moves through the page as usual and the focused element
//   becomes the candidate; Space toggles it.
// - Arrow Up widens the candidate to its parent; Arrow Down narrows it back.
// - Enter finishes. Escape cancels: the page goes back to the areas hidden
//   when the picker opened.
// Only trusted (user) events count: a page script cannot pick or show areas.
//
// Each excluded element gets `data-narwal-exclude` (so this document keeps
// excluding it while the page changes around it) and a structural selector
// (pathOf: tag names and :nth-of-type only, never ids, classes or text) that
// the caller passes to rrwebPrivacyOptions() and startInteractionCapture(),
// and may reuse after a reload. Elements inside a shadow root are picked as
// their light-DOM host, because rrweb's blockSelector cannot cross a shadow
// boundary. A frame is picked as the element around it: rrweb still records
// the inside of a same-origin <iframe> that is itself blocked (board #16592).
//
// Elements the site marks with `data-narwal-exclude` are always excluded
// (dom.ts PrivacyPolicy): the picker shows them as hidden, a click on one
// says it is hidden by the site, and they are never in `selectors()`. That
// includes a mark the site adds while the picker is open. The attribute alone
// cannot tell the site's marks from the user's: the picker remembers every
// element it marked (for the life of the document), so the user's areas from
// an earlier picker on the same page stay the user's when it opens again.

import { EXCLUDE_ATTR, boxOf, isRecorderUi, pathOf } from './dom.ts';
import { HighlightLayer } from './layer.ts';

export interface RegionPicker {
  /** Resolves with the user's excluded selectors when picking ends (Enter, Escape, `finish()` or `cancel()`). */
  readonly done: Promise<string[]>;
  /** The user's current selection (never the areas the site marks). */
  selectors(): string[];
  /** Ends picking now and keeps the selection (e.g. the recorder's Start button). */
  finish(): void;
  /** Ends picking now and goes back to the areas hidden when the picker opened (Escape). */
  cancel(): void;
}

export interface RegionPickerOptions {
  /** Called after each toggle with the current selectors. */
  onChange?(selectors: string[]): void;
  /** Areas the user hid earlier on this page: hidden again and part of the selection. */
  initial?: readonly Element[];
}

const isFrame = (el: Element) => el.tagName === 'IFRAME' || el.tagName === 'FRAME';

function swallow(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Light-DOM element for an event target (shadow content is retargeted to its host at the window). */
function lightElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target === document.documentElement || target === document.body) return null;
  return isRecorderUi(target) ? null : target;
}

// Elements a picker marked, in any picker run on this document.
const userMarked = new WeakSet<Element>();

/** True when the site marks the element itself (never the user, through a picker). */
const isSiteMarked = (el: Element) => el.hasAttribute(EXCLUDE_ATTR) && !userMarked.has(el);

function siteMarkedElements(): Element[] {
  return [...document.querySelectorAll(`[${EXCLUDE_ATTR}]`)].filter(isSiteMarked);
}

/** The element the site marks that holds `el` (or is it), if any. */
function siteOwnerOf(el: Element): Element | null {
  for (let x: Element | null = el.closest(`[${EXCLUDE_ATTR}]`); x; x = x.parentElement?.closest(`[${EXCLUDE_ATTR}]`) ?? null) {
    if (isSiteMarked(x)) return x;
  }
  return null;
}

export function pickExcludedRegions(opts: RegionPickerOptions = {}): RegionPicker {
  const layer = new HighlightLayer();
  const excluded = new Set<Element>();
  // The user's own areas: marked by this picker; the site's marks stay the site's.
  function mark(el: Element): void {
    excluded.add(el);
    if (!el.hasAttribute(EXCLUDE_ATTR)) {
      el.setAttribute(EXCLUDE_ATTR, '');
      userMarked.add(el);
    }
  }
  function unmark(el: Element): void {
    excluded.delete(el);
    if (userMarked.has(el)) {
      el.removeAttribute(EXCLUDE_ATTR);
      userMarked.delete(el);
    }
  }
  // Hidden by the user when the picker opens: the areas passed in, and the
  // ones an earlier picker marked that this document still has.
  const earlier = [...document.querySelectorAll(`[${EXCLUDE_ATTR}]`)].filter((el) => userMarked.has(el));
  const atOpen = new Set<Element>([...(opts.initial ?? []), ...earlier].filter((el) => el.isConnected && !isSiteMarked(el)));
  for (const el of atOpen) mark(el);
  const boxes = new Map<Element, HTMLElement>();
  let candidate: Element | null = null;
  let narrower: Element[] = [];
  let pickBox: HTMLElement | null = null;
  let finished = false;
  let resolve!: (selectors: string[]) => void;
  const done = new Promise<string[]>((r) => {
    resolve = r;
  });

  const selectors = () => [...excluded].filter((el) => el.isConnected).map(pathOf);

  function redraw(): void {
    if (candidate && candidate.isConnected) {
      if (pickBox) layer.move(pickBox, boxOf(candidate));
      else pickBox = layer.box(boxOf(candidate), 'pick');
    } else {
      pickBox?.remove();
      pickBox = null;
    }
    const hidden = new Set<Element>([...siteMarkedElements(), ...[...excluded].filter((el) => el.isConnected)]);
    for (const [el, box] of boxes) {
      if (hidden.has(el)) layer.move(box, boxOf(el));
      else {
        box.remove();
        boxes.delete(el);
      }
    }
    for (const el of hidden) if (!boxes.has(el)) boxes.set(el, layer.box(boxOf(el), 'excluded'));
  }

  function setCandidate(el: Element | null, keepNarrower = false): void {
    if (!keepNarrower) narrower = [];
    candidate = el;
    redraw();
  }

  function describeForSpeech(el: Element): string {
    const label = el.getAttribute('aria-label') || el.getAttribute('role') || el.tagName.toLowerCase();
    return label.slice(0, 60);
  }

  function toggle(picked: Element): void {
    // A frame is hidden as the element around it (not the page body).
    const parent = picked.parentElement;
    const el = isFrame(picked) && parent && parent !== document.body && parent !== document.documentElement ? parent : picked;
    const site = siteOwnerOf(el);
    if (site) {
      layer.announce(`${describeForSpeech(site)} is hidden by the site. It stays hidden.`);
      return;
    }
    const owner = [...excluded].find((x) => x.contains(el));
    if (owner) {
      unmark(owner);
      layer.announce(`Showing ${describeForSpeech(owner)} again. ${excluded.size} hidden.`);
    } else {
      // A wider region replaces the narrower ones inside it.
      for (const inner of [...excluded]) {
        if (el.contains(inner)) unmark(inner);
      }
      mark(el);
      layer.announce(`Hiding ${describeForSpeech(el)}. ${excluded.size} hidden.`);
    }
    redraw();
    opts.onChange?.(selectors());
  }

  const listeners: Array<[string, EventListener]> = [];
  function on<E extends Event>(type: string, fn: (e: E) => void): void {
    const listener = fn as unknown as EventListener;
    window.addEventListener(type, listener, { capture: true });
    listeners.push([type, listener]);
  }

  // The page must not react to the picking pointer. Events a page script
  // dispatches are its own: they pass, and they never pick.
  const inert = (e: MouseEvent) => {
    if (e.isTrusted && !isRecorderUi(e.target as Node)) swallow(e);
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick', 'contextmenu']) on(type, inert);
  on<MouseEvent>('click', (e) => {
    if (!e.isTrusted) return;
    const el = lightElement(e.target);
    if (!el && isRecorderUi(e.target as Node)) return;
    swallow(e);
    if (el) {
      setCandidate(el);
      toggle(el);
    }
  });
  on<PointerEvent>('pointermove', (e) => {
    if (!e.isTrusted) return;
    const el = lightElement(e.target);
    if (el && (el === candidate || narrower.includes(el))) return;
    setCandidate(el);
  });
  on<FocusEvent>('focusin', (e) => {
    if (!e.isTrusted) return;
    const el = lightElement(e.target);
    if (el) setCandidate(el);
  });
  on<KeyboardEvent>('keydown', (e) => {
    if (!e.isTrusted || isRecorderUi(e.target as Node)) return;
    switch (e.key) {
      case 'ArrowUp': {
        swallow(e);
        const parent = candidate?.parentElement;
        if (candidate && parent && parent !== document.body && parent !== document.documentElement) {
          narrower.push(candidate);
          setCandidate(parent, true);
        }
        return;
      }
      case 'ArrowDown': {
        swallow(e);
        const child = narrower.pop();
        if (child) setCandidate(child, true);
        return;
      }
      case ' ':
        swallow(e);
        if (candidate && !e.repeat) toggle(candidate);
        return;
      case 'Enter':
        swallow(e);
        finish();
        return;
      case 'Escape':
        swallow(e);
        cancel();
        return;
    }
  });
  // Space and Enter activate buttons on keyup.
  on<KeyboardEvent>('keyup', (e) => {
    if (e.isTrusted && (e.key === ' ' || e.key === 'Enter') && !isRecorderUi(e.target as Node)) swallow(e);
  });
  on('scroll', redraw);
  on('resize', redraw);

  function finish(): void {
    if (finished) return;
    finished = true;
    for (const [type, listener] of listeners) window.removeEventListener(type, listener, { capture: true });
    layer.remove();
    resolve(selectors());
  }

  function cancel(): void {
    if (finished) return;
    for (const el of [...excluded]) if (!atOpen.has(el)) unmark(el);
    for (const el of atOpen) mark(el);
    opts.onChange?.(selectors());
    finish();
  }

  layer.announce('Choose regions to hide. Click or press Space to hide or show; Arrow Up widens; Enter when done; Escape cancels.');
  redraw();
  return { done, selectors, finish, cancel };
}
