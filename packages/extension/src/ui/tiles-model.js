// What the Tiles B pages show (board #16783), worked out without the DOM so
// the unit tests can read it: day groups for the library, the route changes
// and marks of a recording, the transcript flow that interleaves them, the
// word for a transcript, and the library search.

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", or the date ("Mon, Oct 13"), on this computer's calendar. */
export function dayLabel(ms, now = Date.now(), locale = undefined) {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Items (newest first) in runs of one calendar day: [{ label, items }]. */
export function groupByDay(items, atOf, now = Date.now(), locale = undefined) {
  const groups = [];
  for (const item of items) {
    const label = dayLabel(atOf(item), now, locale);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** The site of a URL ("app.example.com"), or '' when it is not one. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Where a route went, short: the path, and the fragment when it is a route
 * rather than parameters. Query values are left out (they can hold tokens).
 */
export function routeText(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url || '');
  }
  const hash = u.hash && !u.hash.includes('=') ? u.hash : '';
  return `${u.pathname}${hash}` || '/';
}

/**
 * Where the top page was during the recording, in recording time (ms after
 * Start): the page open at Start, each page load and each in-page route.
 * The same address twice in a row is one route.
 */
export function routesOf({ meta, documents, navigations, observations }) {
  const top = new Set(documents.filter((d) => d.isTop).map((d) => d.documentId || d.doc));
  const out = [];
  for (const n of navigations) {
    if (n.type === 'committed' && n.frameId === 0 && n.url) out.push({ atMs: Math.max(0, n.at - meta.startedAt), url: n.url });
  }
  for (const { documentKey, o } of observations) {
    if (o.kind === 'route' && typeof o.atMs === 'number' && o.url && top.has(documentKey)) out.push({ atMs: Math.max(0, o.atMs), url: o.url });
  }
  const first = documents.find((d) => d.isTop && d.url);
  if (first && !out.some((r) => r.atMs < 1000)) out.push({ atMs: 0, url: first.url });
  out.sort((a, b) => a.atMs - b.atMs);
  return out.filter((r, i) => i === 0 || r.url !== out[i - 1].url);
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** `284 × 66 px` for a box, or '' when it has no size. */
export function boxSize(rect) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return '';
  return `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
}

/**
 * One line for a mark the user made: what was marked. An area with no text
 * of its own says its size and the named elements in it (board #16844), so
 * no two of them read the same.
 */
export function markText(o) {
  if (o.kind === 'marker-region') {
    const text = oneLine(o.text);
    if (text) return `Marked an area: “${clip(text, 80)}”`;
    const size = boxSize(o.rect);
    const names = [...new Set((Array.isArray(o.contains) ? o.contains : []).map((c) => oneLine(c && c.name)).filter(Boolean))];
    const inside = names.length ? ` with “${clip(names.join(', '), 80)}”` : '';
    return `Marked an area${size ? ` ${size}` : ''}${inside}`;
  }
  const t = o.target || {};
  const what = t.excluded ? 'a hidden area' : t.name ? `“${clip(String(t.name).replace(/\s+/g, ' ').trim(), 80)}”` : t.role || t.tag || 'an element';
  return `Marked ${what}`;
}

/** The marks the user made, in recording time, with where they were drawn. */
export function marksOf(observations) {
  return observations
    .filter(({ o }) => (o.kind === 'marker-element' || o.kind === 'marker-region') && typeof o.atMs === 'number')
    .map(({ documentKey, o }) => ({
      atMs: Math.max(0, o.atMs),
      text: markText(o),
      documentKey,
      box: o.kind === 'marker-region' ? o.rect || null : (o.target && o.target.box) || null,
    }))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * The mark whose box is drawn over page `documentKey` at `t`: a mark shows
 * from just before it was made until 3 s after. `focus` (the mark hovered or
 * selected in the transcript) wins; otherwise the newest one, so a mark made
 * soon after another replaces it.
 */
export function markAt(marks, t, documentKey, focus = null) {
  const shows = (m) => Boolean(m && m.box) && m.documentKey === documentKey && t >= m.atMs - 250 && t <= m.atMs + 3000;
  if (focus && shows(focus)) return focus;
  let found = null;
  for (const m of marks) if (shows(m) && (!found || m.atMs >= found.atMs)) found = m;
  return found;
}

/**
 * How the recorded window fits the stage (board #16844): whole, never
 * cropped. As wide as the stage unless that makes it taller than
 * `maxHeight`; then as tall as that, centred.
 */
export function stageFit(viewport, width, maxHeight) {
  const scale = Math.max(0, Math.min(width / viewport.width, maxHeight / viewport.height));
  return { scale, left: Math.max(0, (width - viewport.width * scale) / 2), height: viewport.height * scale };
}

/**
 * The transcript with the route changes and marks in their places: rows of
 * { kind: 'route' | 'line' | 'mark', atMs, text } in time order. At the same
 * moment a route comes first, then a mark, then what was said.
 */
export function flowOf({ routes = [], segments = [], marks = [] }) {
  const order = { route: 0, mark: 1, line: 2 };
  const rows = [
    ...routes.map((r, i) => ({ kind: 'route', atMs: r.atMs, text: routeText(r.url), url: r.url, first: i === 0 })),
    ...marks.map((m) => ({ kind: 'mark', atMs: m.atMs, text: m.text, mark: m })),
    ...segments.filter((s) => s.text && s.text.trim()).map((s) => ({ kind: 'line', atMs: s.startMs, text: s.text })),
  ];
  return rows.sort((a, b) => a.atMs - b.atMs || order[a.kind] - order[b.kind]);
}

/** The active transcript revision of a history, or null. */
export function activeRevision(history) {
  if (!history || !Array.isArray(history.revisions)) return null;
  return history.revisions.find((r) => r.revisionId === history.activeRevision) || null;
}

/** One word for the transcript a recording has: improved, OpenAI, live, or null for none. */
export function transcriptWord(history) {
  const active = activeRevision(history);
  if (!active || !active.segments || !active.segments.some((s) => s.text && s.text.trim())) return null;
  if (active.source === 'after-recording') return active.provider === 'openai' ? 'OpenAI' : 'improved';
  return 'live';
}

/** The search text of a recording: its title, its site and every word said. */
export function searchText({ title = '', url = '', history = null }) {
  const active = activeRevision(history);
  const words = active && active.segments ? active.segments.map((s) => s.text).join(' ') : '';
  return `${title} ${hostOf(url)} ${words}`.toLowerCase();
}

/** True when every word of the query is in the text. An empty query matches everything. */
export function matches(query, text) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => text.includes(t));
}

/** `M:SS` from ms, for the replay clock and the transcript. */
export function mmss(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
