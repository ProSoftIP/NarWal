// Page resources a replay will not load. Replay never fetches from the recorded
// site (the replay page's content security policy blocks it, sandbox.ts), so
// every image, stylesheet, font or frame the page pulled from the network is
// missing in replay. This scan counts them so the gap is shown, not silent.

/** Attributes that name a resource the browser would fetch. */
const URL_ATTRIBUTES = new Set(['src', 'srcset', 'href', 'xlink:href', 'poster', 'data', 'background', 'action', 'formaction', 'rr_src']);
const CSS_URL = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi;
const ABSOLUTE = /^(?:https?:)?\/\//i;

export interface MissingResources {
  /** Distinct network URLs the recorded page referenced. */
  count: number;
  /** Their origins, sorted; at most 20. */
  origins: string[];
}

interface SerializedNode {
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  /** rrweb marks the text of a <style> element. */
  isStyle?: boolean;
  childNodes?: SerializedNode[];
}

function urlsOfAttribute(name: string, value: unknown, out: Set<string>): void {
  if (typeof value !== 'string') return;
  const lower = name.toLowerCase();
  if (lower === 'style' || lower === '_csstext') {
    for (const m of value.matchAll(CSS_URL)) {
      const url = m[2] ?? m[4];
      if (url && ABSOLUTE.test(url)) out.add(url);
    }
    return;
  }
  if (!URL_ATTRIBUTES.has(lower)) return;
  // srcset: "url 1x, url 2x"
  const candidates = lower === 'srcset' ? value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : [value.trim()];
  for (const url of candidates) if (ABSOLUTE.test(url)) out.add(url);
}

function walk(node: SerializedNode | undefined, out: Set<string>, depth: number): void {
  if (!node || typeof node !== 'object' || depth > 1000) return;
  if (node.attributes && typeof node.attributes === 'object') {
    // rrweb inlines a readable stylesheet as `_cssText` and replays that text, not the link.
    const inlined = node.tagName === 'link' && typeof node.attributes._cssText === 'string';
    for (const [name, value] of Object.entries(node.attributes)) {
      if (!(inlined && name === 'href')) urlsOfAttribute(name, value, out);
    }
  }
  if (node.type === 3 && node.isStyle && typeof node.textContent === 'string') urlsOfAttribute('_cssText', node.textContent, out);
  if (Array.isArray(node.childNodes)) for (const child of node.childNodes) walk(child, out, depth + 1);
}

/** Scans rrweb events (full snapshots and DOM mutations) for network resources. */
export function missingResources(events: readonly { type: number; data?: unknown }[]): MissingResources {
  const urls = new Set<string>();
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') continue;
    if (event.type === 2) walk(data.node as SerializedNode, urls, 0);
    if (event.type === 3 && data.source === 0) {
      for (const add of (data.adds as { node?: SerializedNode }[] | undefined) ?? []) walk(add.node, urls, 0);
      for (const change of (data.attributes as { attributes?: Record<string, unknown> }[] | undefined) ?? []) {
        for (const [name, value] of Object.entries(change.attributes ?? {})) {
          if (value && typeof value === 'object') {
            // Style attribute changes arrive as { property: value }.
            for (const v of Object.values(value)) urlsOfAttribute('style', v, urls);
          } else urlsOfAttribute(name, value, urls);
        }
      }
    }
  }
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      origins.add(new URL(url, 'https://invalid.invalid').origin);
    } catch {
      // Not a parseable URL; still counted.
    }
  }
  return { count: urls.size, origins: [...origins].sort().slice(0, 20) };
}
