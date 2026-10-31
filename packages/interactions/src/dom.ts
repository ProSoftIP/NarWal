// DOM reading for interaction evidence (board #16543): which element a
// pointer means, what it is called, and where it is. Every reader here
// skips excluded regions, typed values and the recorder's own UI.

import type { Box, ElementRef, NameSource, Point } from './types.ts';

/** Why text was left out: a user-excluded region or a typed value. */
export type Redaction = 'excluded' | 'typed';

/** Attribute on the recorder's own UI host. Never captured or reported. */
export const UI_ATTR = 'data-narwal-ui';
/** Attribute the region picker sets on a region the user hid. */
export const EXCLUDE_ATTR = 'data-narwal-exclude';

export const UI_SELECTOR = `[${UI_ATTR}]`;

/** Elements whose text the user typed, not the page. */
export const TYPED_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Elements that mean something on their own when pointed at. */
export const MEANINGFUL_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  'img',
  'svg',
  'video',
  'audio',
  'canvas',
  'iframe',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'dt',
  'dd',
  'figcaption',
  'legend',
  'caption',
  '[role]',
  '[aria-label]',
  '[aria-labelledby]',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  summary: 'button',
  img: 'image',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  li: 'listitem',
  ul: 'list',
  ol: 'list',
  nav: 'navigation',
  main: 'main',
  form: 'form',
  table: 'table',
  td: 'cell',
  th: 'columnheader',
  tr: 'row',
  dialog: 'dialog',
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  search: 'searchbox',
  number: 'spinbutton',
};

export const LABEL_MAX = 120;

/**
 * Decides what is private on a page: the user's excluded regions, typed
 * values and the recorder UI.
 */
export class PrivacyPolicy {
  readonly excludeSelector: string;

  /**
   * @param exclusions CSS selectors for the regions the user hid before
   *   recording. Elements carrying `data-narwal-exclude` are always excluded.
   */
  constructor(exclusions: readonly string[] = []) {
    const valid = exclusions.filter((s) => isValidSelector(s));
    this.excludeSelector = [`[${EXCLUDE_ATTR}]`, ...valid].join(',');
  }

  /** Outermost excluded element containing `node`, or null. */
  excludedRoot(node: Node | null): Element | null {
    let found: Element | null = null;
    for (let el = elementOf(node); el; el = parentElementAcrossShadow(el)) {
      if (el.matches(this.excludeSelector)) found = el;
    }
    return found;
  }

  isExcluded(node: Node | null): boolean {
    for (let el = elementOf(node); el; el = parentElementAcrossShadow(el)) {
      if (el.matches(this.excludeSelector)) return true;
    }
    return false;
  }

  /** True inside a form field or editable content. */
  isTyped(node: Node | null): boolean {
    const el = elementOf(node);
    return Boolean(el && el.closest(TYPED_SELECTOR));
  }
}

/** True for the recorder's own UI and anything inside it. */
export function isRecorderUi(node: Node | null): boolean {
  for (let el = elementOf(node); el; el = parentElementAcrossShadow(el)) {
    if (el.hasAttribute(UI_ATTR)) return true;
  }
  return false;
}

export function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
}

function parentElementAcrossShadow(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** The element a pointer at `el` most plausibly means. */
export function meaningfulTarget(el: Element): Element {
  const meaningful = el.closest(MEANINGFUL_SELECTOR);
  if (meaningful && meaningful !== document.documentElement && meaningful !== document.body) return meaningful;
  return el;
}

// The bundle schema accepts only role-shaped tokens (packages/bundle, ElementRef.role):
// any other explicit role from page markup falls back to the implicit role.
const ROLE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit && ROLE_TOKEN.test(explicit)) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'input') return INPUT_ROLES[(el as HTMLInputElement).type] ?? 'textbox';
  if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'image';
  return IMPLICIT_ROLES[tag] ?? null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/**
 * Visible page text under `root`, skipping excluded regions, typed values,
 * the recorder UI, scripts and styles. Stops after `limit` characters.
 * Reports whether anything was skipped for privacy.
 */
export function safeText(root: Node, policy: PrivacyPolicy, limit = LABEL_MAX * 2): { text: string; skipped: Redaction | null } {
  let out = '';
  let skipped: Redaction | null = null;
  const walk = (node: Node): boolean => {
    if (out.length >= limit) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const el = node as Element;
    if (el.hasAttribute(UI_ATTR)) return true;
    if (el.matches(policy.excludeSelector)) {
      skipped = 'excluded';
      return true;
    }
    if (SKIP_TEXT_TAGS.has(el.tagName)) {
      if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'NOSCRIPT' && el.tagName !== 'TEMPLATE') {
        skipped = skipped ?? 'typed';
      }
      return true;
    }
    if (el.matches('[contenteditable]:not([contenteditable="false"])')) {
      skipped = skipped ?? 'typed';
      return true;
    }
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt) out += ` ${alt} `;
      return true;
    }
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (!walk(child)) return false;
    }
    if (isBlockLike(el)) out += ' ';
    return true;
  };
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (!walk(child)) break;
    }
  } else {
    walk(root);
  }
  return { text: collapse(out), skipped };
}

export function isBlockLike(el: Element): boolean {
  return /^(P|DIV|LI|TR|TD|TH|H[1-6]|BR|SECTION|ARTICLE|HEADER|FOOTER|NAV|UL|OL|DT|DD|TABLE|FIGCAPTION|BLOCKQUOTE)$/.test(el.tagName);
}

/** Text of the elements referenced by an idref list, privacy-filtered. */
function idrefText(el: Element, attr: string, policy: PrivacyPolicy): { text: string; skipped: Redaction | null } | null {
  const ids = el.getAttribute(attr);
  if (!ids) return null;
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  let skipped: Redaction | null = null;
  for (const id of ids.trim().split(/\s+/)) {
    const ref = root.getElementById ? root.getElementById(id) : null;
    if (!ref) continue;
    if (policy.isExcluded(ref)) {
      skipped = 'excluded';
      continue;
    }
    const part = safeText(ref, policy);
    if (part.skipped) skipped = skipped ?? part.skipped;
    if (part.text) parts.push(part.text);
  }
  return { text: collapse(parts.join(' ')), skipped };
}

export interface Name {
  name?: string;
  nameSource: NameSource;
}

function named(text: string | null | undefined, nameSource: NameSource): Name | null {
  const value = collapse(text ?? '');
  return value ? { name: truncate(value), nameSource } : null;
}

const UNNAMED: Name = { nameSource: 'none' };

/**
 * Accessible name (a reduced version of the accname algorithm), never a
 * typed value: for a form field it is the field's label, not its content.
 * Text inside excluded regions never contributes.
 */
export function nameOf(el: Element, policy: PrivacyPolicy): Name {
  if (policy.isExcluded(el)) return UNNAMED;
  const labelledBy = idrefText(el, 'aria-labelledby', policy);
  const fromIdrefs = labelledBy && named(labelledBy.text, 'aria-labelledby');
  if (fromIdrefs) return fromIdrefs;
  const aria = named(el.getAttribute('aria-label'), 'aria-label');
  if (aria) return aria;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const input = el as HTMLInputElement;
    const type = tag === 'INPUT' ? input.type : '';
    // A button-like input shows its value as a caption: page text, not typed text.
    if (type === 'submit' || type === 'reset' || type === 'button') {
      const caption = input.getAttribute('value') ?? (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      return named(caption, 'text') ?? UNNAMED;
    }
    if (type === 'image') return named(input.getAttribute('alt'), 'alt') ?? UNNAMED;
    const labels = input.labels ? [...input.labels].filter((l) => !policy.isExcluded(l)) : [];
    const fromLabels = named(labels.map((l) => safeText(l, policy).text).join(' '), 'label');
    if (fromLabels) return fromLabels;
    return named(el.getAttribute('placeholder'), 'placeholder') ?? named(el.getAttribute('title'), 'title') ?? UNNAMED;
  }
  if (policy.isTyped(el)) {
    // Inside editable content: what the editor is called, never what was typed.
    return named(el.getAttribute('title'), 'title') ?? UNNAMED;
  }
  if (tag === 'IMG') {
    const alt = named(el.getAttribute('alt'), 'alt');
    if (alt) return alt;
  }
  return named(safeText(el, policy).text, 'text') ?? named(el.getAttribute('title'), 'title') ?? UNNAMED;
}

/**
 * Structural path from the document element: tag names and :nth-of-type
 * only, so it cannot carry page data. ` >>> ` crosses into a shadow root.
 * Used to store excluded regions as selectors.
 */
export function pathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const tag = cur.tagName.toLowerCase();
    const parentNode: ParentNode | null = cur.parentElement ?? (cur.parentNode instanceof ShadowRoot ? cur.parentNode : null);
    if (!parentNode) {
      parts.unshift(tag);
      break;
    }
    let index = 0;
    let count = 0;
    for (const sibling of parentNode.children) {
      if (sibling.tagName === cur.tagName) {
        count += 1;
        if (sibling === cur) index = count;
      }
    }
    parts.unshift(count > 1 ? `${tag}:nth-of-type(${index})` : tag);
    if (parentNode instanceof ShadowRoot) {
      parts.unshift('>>>');
      cur = parentNode.host;
    } else {
      cur = parentNode as Element;
    }
  }
  return parts.join(' > ').replace(/ > >>> > /g, ' >>> ');
}

export function scrollOf(win: Window = window): Point {
  return roundPoint({ x: win.scrollX, y: win.scrollY });
}

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return roundBox({ x: r.x, y: r.y, w: r.width, h: r.height });
}

const q = (n: number) => Math.round(n * 100) / 100;

export function roundBox(b: Box): Box {
  return { x: q(b.x), y: q(b.y), w: q(b.w), h: q(b.h) };
}

export function roundPoint(p: Point): Point {
  return { x: q(p.x), y: q(p.y) };
}

export type NodeIdOf = (node: Node) => number | null;

/**
 * Describes `el` as it is now. Inside an excluded region the reference is the
 * excluded root itself (the only node the recording keeps), without a name.
 */
export function describe(el: Element, policy: PrivacyPolicy, nodeIdOf: NodeIdOf): ElementRef {
  const excluded = policy.excludedRoot(el);
  if (excluded) {
    return { node: nodeIdOf(excluded), tag: excluded.tagName.toLowerCase(), role: null, nameSource: 'none', box: boxOf(excluded), excluded: true };
  }
  return { node: nodeIdOf(el), tag: el.tagName.toLowerCase(), role: roleOf(el), ...nameOf(el, policy), box: boxOf(el) };
}

/**
 * Topmost page element at a viewport point, looking into open shadow roots.
 * Null over the recorder UI (the pointer is on our controls, not the page).
 */
export function pageElementAt(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  if (!el || isRecorderUi(el)) return null;
  while (el.shadowRoot) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** Nearest block-level ancestor, used to put spaces between blocks of selected text. */
function blockOf(node: Node): Element | null {
  for (let el = elementOf(node); el; el = el.parentElement) if (isBlockLike(el)) return el;
  return null;
}

/**
 * Text inside a DOM range, skipping excluded regions, typed values and the
 * recorder UI. Never uses Selection.toString(), which includes form values.
 */
export function rangeText(range: Range, policy: PrivacyPolicy, limit = 500): string {
  const root = range.commonAncestorContainer;
  if (isRecorderUi(root) || policy.isExcluded(root) || policy.isTyped(root)) return '';
  if (root.nodeType === Node.TEXT_NODE) {
    return truncateTo(collapse((root.nodeValue ?? '').slice(range.startOffset, range.endOffset)), limit);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.hasAttribute(UI_ATTR) || el.matches(policy.excludeSelector) || SKIP_TEXT_TAGS.has(el.tagName) || el.matches(TYPED_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let out = '';
  let lastBlock: Element | null | undefined;
  for (let node = walker.nextNode(); node && out.length < limit * 2; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : value.length;
    const block = blockOf(node);
    if (lastBlock !== undefined && block !== lastBlock) out += ' ';
    lastBlock = block;
    out += value.slice(start, end);
  }
  return truncateTo(collapse(out), limit);
}

function truncateTo(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** True for a text field whose selection is a typed value. */
export function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  try {
    return (el as HTMLInputElement).selectionStart !== null;
  } catch {
    return false;
  }
}
