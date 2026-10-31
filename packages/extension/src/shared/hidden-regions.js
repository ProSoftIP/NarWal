// Areas the user hides before recording (board #16592). Pure: the service
// worker, the content scripts, the replay pages and the unit tests share it.
//
// The picker (src/content/picker.js) reports one area per picked element: a
// structural selector (tag names and :nth-of-type only, packages/interactions
// pathOf) and a fingerprint of the element (tag, size, a hash of its text
// and, when it has any, a hash of its identity attributes; never the text or
// the attribute values). A selector alone fails open: when the page loads another
// element first, `section:nth-of-type(1)` matches it and the picked one is
// recorded. So each area counts as hidden only while its selector matches
// exactly one element with the same fingerprint (resolveAreas): Start checks
// it, and every top-frame document of the page checks it before it records.
// The areas apply to the top-frame documents of that page only: same origin
// and path, any query. Another page in the recording keeps only the areas its
// own site marks with data-narwal-exclude.

export const MAX_AREAS = 50;
const MAX_SELECTOR_LENGTH = 2000;
// Size changes up to this much (px or share of the size) still count as the
// same element: a window resize between picking and Start reflows the page.
const SIZE_SLACK_PX = 16;
const SIZE_SLACK_SHARE = 0.25;

/** Origin and path of a URL (no query, no fragment); null when it is not a URL. */
export function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** FNV-1a (32 bits, hex) of the text with its white space collapsed. */
export function textHash(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Attributes that name an element rather than describe its state: a live
// panel keeps them while its text changes.
const IDENTITY_ATTRS = ['id', 'name', 'aria-label', 'aria-labelledby', 'data-testid'];

/** Hash of the element's identity attributes; undefined when it has none. */
function identityKey(el) {
  const parts = [];
  for (const name of IDENTITY_ATTRS) {
    const value = el.getAttribute(name);
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.length ? textHash(parts.join('\n')) : undefined;
}

/** Fingerprint of a picked element: tag, rounded size, text hash and (when it has identity attributes) their hash. */
export function fingerprintOf(el) {
  const r = el.getBoundingClientRect();
  const fp = { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), text: textHash(el.textContent) };
  const key = identityKey(el);
  if (key) fp.key = key;
  return fp;
}

const near = (a, b) => Math.abs(a - b) <= Math.max(SIZE_SLACK_PX, SIZE_SLACK_SHARE * Math.max(a, b));

/**
 * True when two fingerprints are the same element: same tag, about the same
 * size, and the same text or the same identity attributes (so an area whose
 * text changes, such as a live panel, is still found when it has an id).
 */
export function sameFingerprint(a, b) {
  if (!a || !b || a.tag !== b.tag || !near(a.w, b.w) || !near(a.h, b.h)) return false;
  return a.text === b.text || (Boolean(a.key) && a.key === b.key);
}

const isFingerprint = (fp) =>
  Boolean(fp) &&
  typeof fp.tag === 'string' &&
  /^[a-z][a-z0-9-]*$/.test(fp.tag) &&
  Number.isFinite(fp.w) &&
  Number.isFinite(fp.h) &&
  typeof fp.text === 'string' &&
  /^[0-9a-f]{8}$/.test(fp.text) &&
  (fp.key === undefined || (typeof fp.key === 'string' && /^[0-9a-f]{8}$/.test(fp.key)));

/** The areas a message may carry: {selector, fp}, bounded in count and length; null when it is not a list. */
export function cleanAreas(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const a of list) {
    const selector = a && a.selector;
    if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_LENGTH || !isFingerprint(a.fp)) continue;
    if (out.some((o) => o.selector === selector)) continue;
    const fp = { tag: a.fp.tag, w: a.fp.w, h: a.fp.h, text: a.fp.text };
    if (a.fp.key) fp.key = a.fp.key;
    out.push({ selector, fp });
    if (out.length === MAX_AREAS) break;
  }
  return out;
}

/**
 * Finds each area in a document.
 * @param {ParentNode} root  the document
 * @param {{selector: string, fp: object}[]} areas
 * @returns {{found: {selector: string, element: Element}[], lost: number}}  lost: no match, more than one, or another element
 */
export function resolveAreas(root, areas) {
  const found = [];
  let lost = 0;
  for (const area of areas || []) {
    let matches = [];
    try {
      matches = [...root.querySelectorAll(area.selector)];
    } catch {
      // A selector this document cannot parse finds nothing.
    }
    if (matches.length === 1 && sameFingerprint(fingerprintOf(matches[0]), area.fp)) found.push({ selector: area.selector, element: matches[0] });
    else lost += 1;
  }
  return { found, lost };
}

/** "1 hidden area could not be found", for the popup and the refused Start. */
export function lostText(n) {
  return n === 1
    ? '1 hidden area could not be found. The page changed since you hid it: pick the areas to hide again.'
    : `${n} hidden areas could not be found. The page changed since you hid them: pick the areas to hide again.`;
}

/**
 * Areas a document records as hidden.
 * @param {{page: string, areas: {selector: string, fp: object}[]} | null | undefined} hidden  what Start passed
 * @param {{href: string, isTop: boolean}} doc
 */
export function areasForDocument(hidden, { href, isTop }) {
  if (!hidden || !isTop || !Array.isArray(hidden.areas)) return [];
  return pageKey(href) === hidden.page ? hidden.areas : [];
}

// ---- replay -----------------------------------------------------------
// rrweb records a blocked element as an empty element of the same size: only
// its class and the rr_width/rr_height of its box are kept. Replay marks it
// with HIDDEN_CLASS so the area shows as hidden instead of as blank page.

export const HIDDEN_CLASS = 'narwal-hidden-area';
/** For rrweb Replayer's insertStyleRules. The stripes match the picker's hidden outline. */
export const HIDDEN_STYLE_RULES = [
  `.${HIDDEN_CLASS} { background: repeating-linear-gradient(45deg, rgba(73, 80, 87, 0.45) 0 6px, rgba(73, 80, 87, 0.2) 6px 12px) !important; outline: 1px solid #495057 !important; }`,
];

// rrweb 2 numbers (EventType, IncrementalSource, NodeType).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const MUTATION = 0;
const ELEMENT = 2;

function markNode(node) {
  if (!node) return;
  if (node.type === ELEMENT && node.attributes && 'rr_width' in node.attributes) {
    const cls = typeof node.attributes.class === 'string' ? node.attributes.class : '';
    if (!cls.split(/\s+/).includes(HIDDEN_CLASS)) node.attributes.class = cls ? `${cls} ${HIDDEN_CLASS}` : HIDDEN_CLASS;
  }
  if (Array.isArray(node.childNodes)) for (const child of node.childNodes) markNode(child);
}

/** Adds HIDDEN_CLASS to every blocked element in the events (in place; a second call changes nothing). */
export function markHiddenAreas(events) {
  for (const e of events) {
    if (!e || !e.data) continue;
    if (e.type === FULL_SNAPSHOT) markNode(e.data.node);
    else if (e.type === INCREMENTAL && e.data.source === MUTATION && Array.isArray(e.data.adds)) {
      for (const add of e.data.adds) markNode(add && add.node);
    }
  }
  return events;
}
