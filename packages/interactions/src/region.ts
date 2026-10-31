// What a right-drag box covers (board #16543, #16604): the elements in it and
// the visible page text inside it, clipped to the box.
//
// A box drawn over part of a long paragraph must still say what it covers:
// an element whose text the box crosses counts even when most of the element
// is outside the box, and the text is cut to the words inside the box.
// Excluded regions, typed values and the recorder UI never contribute text.

import { MEANINGFUL_SELECTOR, PrivacyPolicy, SKIP_TEXT_TAGS, TYPED_SELECTOR, UI_ATTR, elementOf, isBlockLike, isRecorderUi } from './dom.ts';
import type { Box, ElementRef } from './types.ts';

/** schema §6.2: `contains` holds at most 10 elements. */
export const CONTAINS_MAX = 10;
/** Same limit as selected text (schema §6.2). */
export const REGION_TEXT_MAX = 500;

export interface RegionContents {
  /** ≤ 10 elements, outermost only, largest overlap first. */
  contains: ElementRef[];
  /** Visible page text inside the box, clipped to it; absent when the box holds none. */
  text?: string;
}

export function overlapArea(a: DOMRect, b: Box): number {
  const w = Math.min(a.right, b.x + b.w) - Math.max(a.left, b.x);
  const h = Math.min(a.bottom, b.y + b.h) - Math.max(a.top, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function centerInside(r: DOMRect, box: Box): boolean {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/** The element a run of text belongs to: its nearest meaningful or block ancestor. */
function holderOf(node: Node): Element | null {
  for (let el = elementOf(node); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.matches(MEANINGFUL_SELECTOR) || isBlockLike(el)) return el;
  }
  return elementOf(node);
}

interface TextInBox {
  text: string;
  holders: Element[];
}

/**
 * Visible page text inside a viewport box, word by word: a word counts when
 * the centre of one of its line boxes is inside the box. Words keep document
 * order; blocks and gaps become one space. Also returns the elements that
 * hold that text.
 */
function textInBox(box: Box, policy: PrivacyPolicy, limit: number): TextInBox {
  const root = document.body ?? document.documentElement;
  const holders = new Set<Element>();
  // The walk filters only the elements below the root: a hidden body or html
  // (the whole page hidden, e.g. after the hidden areas were lost) gives no text.
  if (!root || policy.isExcluded(root)) return { text: '', holders: [] };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.hasAttribute(UI_ATTR) || el.matches(policy.excludeSelector) || SKIP_TEXT_TAGS.has(el.tagName) || el.matches(TYPED_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        // display:none or content-visibility:hidden hides the whole subtree.
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return /\S/.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const range = document.createRange();
  let out = '';
  let last: { node: Node; end: number; block: Element | null } | null = null;
  for (let node = walker.nextNode(); node && out.length <= limit; node = walker.nextNode()) {
    range.selectNodeContents(node);
    const whole = range.getBoundingClientRect();
    if (overlapArea(whole, box) === 0) continue;
    const parent = node.parentElement;
    if (parent && typeof parent.checkVisibility === 'function' && !parent.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const value = node.nodeValue ?? '';
    const block = holderOf(node);
    for (const word of value.matchAll(/\S+/g)) {
      const start = word.index;
      const end = start + word[0].length;
      range.setStart(node, start);
      range.setEnd(node, end);
      if (![...range.getClientRects()].some((r) => centerInside(r, box))) continue;
      // No space only between two pieces of one word split across inline elements.
      const joined = last !== null && last.block === block && (last.node === node ? last.end === start : last.end === (last.node.nodeValue ?? '').length && start === 0);
      if (out && !joined) out += ' ';
      out += word[0];
      last = { node, end, block };
      if (block) holders.add(block);
      if (out.length > limit) break;
    }
  }
  const text = out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
  return { text, holders: [...holders] };
}

/**
 * What a viewport box covers. `contains` lists the meaningful elements at
 * least half inside the box, plus every element whose visible text the box
 * crosses; outermost only, largest overlap first. An element inside an
 * excluded region is reported as the excluded root. A box that touches an
 * excluded region lists that root first, even inside an element it also
 * lists, and records no text: the bundle refuses text next to a hidden region.
 */
export function regionContents(box: Box, policy: PrivacyPolicy, describe: (el: Element) => ElementRef): RegionContents {
  const hits = new Map<Element, number>();
  const hidden = new Set<Element>();
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll(`${MEANINGFUL_SELECTOR},${policy.excludeSelector}`)) {
    if (isRecorderUi(el)) continue;
    const root = policy.excludedRoot(el);
    const subject = root ?? el;
    if (seen.has(subject)) continue;
    seen.add(subject);
    const r = subject.getBoundingClientRect();
    const area = r.width * r.height;
    if (area === 0) continue;
    const overlap = overlapArea(r, box);
    if (root && overlap > 0) hidden.add(root);
    if (overlap >= area / 2 || (root && overlap > 0)) hits.set(subject, overlap);
  }
  const { text, holders } = hidden.size > 0 ? { text: '', holders: [] } : textInBox(box, policy, REGION_TEXT_MAX);
  for (const el of holders) if (!hits.has(el)) hits.set(el, overlapArea(el.getBoundingClientRect(), box));
  const all = [...hits.keys()];
  const contains = all
    .filter((el) => hidden.has(el) || !all.some((o) => o !== el && o.contains(el)))
    .sort((a, b) => Number(hidden.has(b)) - Number(hidden.has(a)) || hits.get(b)! - hits.get(a)!)
    .slice(0, CONTAINS_MAX)
    .map(describe);
  return text ? { contains, text } : { contains };
}
