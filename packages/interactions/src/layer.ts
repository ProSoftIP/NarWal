// Highlight overlay for markers and the region picker (board #16543).
//
// A zero-size `div.narwal-ui` host carrying `data-narwal-ui`, with a CLOSED shadow root made
// through the attachShadow found at module load, before rrweb patches it.
// rrweb therefore records only an empty 0x0 placeholder for the host and
// never sees the overlay's contents; the capture code ignores events on it.

import { UI_ATTR } from './dom.ts';
import type { Box } from './types.ts';

const attachShadow = Element.prototype.attachShadow;

const STYLE = `
:host { all: initial; }
.box { position: fixed; box-sizing: border-box; pointer-events: none; border-radius: 3px; }
.drag { border: 2px dashed #e8590c; background: rgba(232, 89, 12, 0.08); }
.mark { border: 3px solid #e8590c; background: rgba(232, 89, 12, 0.12); transition: opacity 0.4s ease-out; }
.pick { border: 2px solid #1971c2; background: rgba(25, 113, 194, 0.10); }
.excluded { border: 2px solid #495057; background: repeating-linear-gradient(45deg, rgba(73, 80, 87, 0.35) 0 6px, rgba(73, 80, 87, 0.15) 6px 12px); }
.fade { opacity: 0; }
.sr { position: fixed; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export type BoxStyle = 'drag' | 'mark' | 'pick' | 'excluded';

export class HighlightLayer {
  readonly host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #live: HTMLElement;

  constructor(doc: Document = document) {
    // rrweb keeps only the tag, class and size of a blocked element: a plain
    // div with the shared `narwal-ui` class (#16551's capture filter drops it).
    this.host = doc.createElement('div');
    this.host.className = 'narwal-ui';
    this.host.setAttribute(UI_ATTR, 'highlights');
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; z-index: 2147483647; pointer-events: none;';
    this.#root = attachShadow.call(this.host, { mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    this.#live = doc.createElement('div');
    this.#live.className = 'sr';
    this.#live.setAttribute('role', 'status');
    this.#live.setAttribute('aria-live', 'polite');
    this.#root.append(style, this.#live);
    (doc.documentElement ?? doc).appendChild(this.host);
  }

  /** Draws a box at a viewport rectangle; returns it so the caller can move or remove it. */
  box(rect: Box, kind: BoxStyle): HTMLElement {
    const el = document.createElement('div');
    el.className = `box ${kind}`;
    this.move(el, rect);
    this.#root.appendChild(el);
    return el;
  }

  move(el: HTMLElement, rect: Box): void {
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${Math.max(rect.w, 1)}px`;
    el.style.height = `${Math.max(rect.h, 1)}px`;
  }

  /** Shows a box briefly as confirmation, then removes it. */
  flash(rect: Box, ms = 900): void {
    const el = this.box(rect, 'mark');
    setTimeout(() => el.classList.add('fade'), ms);
    setTimeout(() => el.remove(), ms + 450);
  }

  /** Screen-reader announcement (the overlay's polite live region). */
  announce(text: string): void {
    this.#live.textContent = '';
    // A separate task makes repeated identical messages announce again.
    setTimeout(() => {
      this.#live.textContent = text;
    }, 30);
  }

  /** The announced text, for tests and the bottom strip. */
  get announcement(): string {
    return this.#live.textContent ?? '';
  }

  /** Re-attaches the host if the page replaced the document element's children. */
  ensureAttached(): void {
    if (!this.host.isConnected) (document.documentElement ?? document).appendChild(this.host);
  }

  remove(): void {
    this.host.remove();
  }
}
