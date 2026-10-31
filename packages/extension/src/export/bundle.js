// Turns one saved recording (the local chunks of src/store/db.js) into a
// bundle tree of docs/bundle-schema.md: manifest, documents, observations,
// gaps, rrweb streams, narration and the transcript history. The library (packages/library) stores,
// packs and exports the tree; this module only writes it.
//
// Local times are epoch ms; the bundle uses session ms from the recording's
// start (`clock.originEpochMs`). Interaction observations already arrive in
// session ms from the content script. Manifest, document and gap fields are
// written from an allowlist; observations pass through as the capture wrote
// them, and a field the schema does not know fails the export, so nothing
// from the local store reaches the bundle by accident.
import { analyze, tabAliases } from '../shared/analyze.js';
import { README_PATHS, buildAgentView, isCredentialValue, memorySource, renderMarkdown, renderReadme, stableJson, validateBundle } from '../../../bundle/src/index.ts';
import { sha256Hex } from '../../../library/src/index.ts';
import { MODELS } from '../../../offline-transcription/src/models.ts';

export const SCHEMA_VERSION = '1.1';
export const POINTER_DWELL_MIN_MS = 300;
const AUDIO_PATH = 'audio/narration.webm';
const CLOCK_PATH = 'audio/clock.jsonl';
const MEDIA = { '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.md': 'text/markdown', '.webm': 'audio/webm' };
const LIMITS = { title: 200, purpose: 1000, url: 2048, detail: 500 };

const enc = new TextEncoder();
const json = (v) => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const jsonl = (lines) => enc.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const HTML_SPACE = /[\t\n\f\r ]+/g;
const round = (ms) => Math.round(ms * 10) / 10;

/** Bundle recording IDs follow the identifier rule; local IDs are UUIDs. */
export function bundleRecordingId(localId) {
  return `rec_${String(localId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`;
}

/**
 * `redact-query-values` (schema §4): every query and fragment parameter value
 * becomes `_`, and user name and password are removed. Null when the text is
 * not an absolute URL.
 */
export function redactUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  u.username = '';
  u.password = '';
  const redact = (params) => {
    const out = new URLSearchParams();
    for (const [key, value] of params) out.append(key, value === '' ? '' : '_');
    return out.toString();
  };
  if (u.search) u.search = redact(u.searchParams);
  if (u.hash.includes('=')) {
    const q = u.hash.indexOf('?');
    const prefix = q === -1 ? '' : u.hash.slice(1, q + 1);
    u.hash = prefix + redact(new URLSearchParams(u.hash.slice(q === -1 ? 1 : q + 1)));
  }
  const text = u.href;
  return text.length <= LIMITS.url ? text : `${u.origin}${u.pathname}`.slice(0, LIMITS.url);
}

// Attributes whose value is a URL (or a srcset list of them), relative or
// absolute. rrweb writes them in snapshot nodes, in mutation attribute
// changes and as the Meta event's `href`.
const URL_KEYS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'ping', 'longdesc', 'manifest', 'codebase', 'xlink:href', 'rr_src']);
const SRCSET_KEYS = new Set(['srcset', 'imagesrcset']);
const ABSOLUTE_URL = /\b(?:https?|wss?|ftp|file):\/\/[^\s"'<>()\\`]+/gi;

// The query and fragment of a relative or absolute URL text with each value
// replaced as redactUrl does, keeping the rest of the text as it was. A data:
// URL is content, not an address: its '?' and '#' (an SVG fill='#fff') stay.
function redactUrlText(text) {
  if (/^\s*data:/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim())) {
    const redacted = redactUrl(text.trim());
    if (redacted) return redacted;
  }
  const q = text.search(/[?#]/);
  if (q === -1) return text;
  const hashAt = text.indexOf('#', q);
  const values = (part) => {
    const out = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(part)) out.append(key, value === '' ? '' : '_');
    return out.toString();
  };
  let out = text.slice(0, q);
  if (text[q] === '?') out += `?${values(text.slice(q + 1, hashAt === -1 ? undefined : hashAt))}`;
  if (hashAt !== -1) {
    const hash = text.slice(hashAt + 1);
    if (!hash.includes('=')) out += `#${hash}`;
    else {
      const inner = hash.indexOf('?');
      out += `#${inner === -1 ? '' : hash.slice(0, inner + 1)}${values(inner === -1 ? hash : hash.slice(inner + 1))}`;
    }
  }
  return out;
}

function redactString(key, value) {
  const name = typeof key === 'string' ? key.toLowerCase() : '';
  if (URL_KEYS.has(name)) return redactUrlText(value);
  if (SRCSET_KEYS.has(name)) {
    return value
      .split(',')
      .map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [redactUrlText(url), ...descriptor].join(' ');
      })
      .join(', ');
  }
  // URLs inside any other text: inline styles, CSS text, page text.
  return /[?#@]/.test(value) ? value.replace(ABSOLUTE_URL, (url) => redactUrl(url) || url) : value;
}

/**
 * The manifest's `urlPolicy: redact-query-values` applied to one raw rrweb
 * event: every URL in it (the Meta `href`, snapshot and mutation attributes,
 * srcset lists, URLs in CSS and text) keeps no query or fragment value and no
 * user name or password. Returns a new event; the saved one is not changed.
 */
export function redactRrwebEvent(event) {
  const walk = (value, key) => {
    if (typeof value === 'string') return redactString(key, value);
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  return walk(event, null);
}

// webNavigation transition type and qualifiers -> schema route transition.
function routeTransition(nav) {
  if (nav.transitionQualifiers && nav.transitionQualifiers.includes('forward_back')) return 'back-forward';
  return { link: 'link', typed: 'typed', reload: 'reload', form_submit: 'form-submit' }[nav.transitionType] || 'other';
}

function mediaType(path) {
  return MEDIA[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream';
}

async function withManifest(manifest, files) {
  const listed = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    listed.push({ path, bytes: bytes.length, sha256: await sha256Hex(bytes), mediaType: mediaType(path) });
  }
  return new Map([['manifest.json', json({ ...manifest, files: listed })], ...files]);
}

/**
 * The page title, as `document.title` reads it, each time it changed in one
 * document's exported rrweb stream: the first `<title>` in the page's
 * `<head>`, from full snapshots and DOM mutations. The stream is already
 * redacted and holds no excluded region, so a title read from it follows the
 * privacy rules of the replay. Only the document's own `<head>` counts: a
 * same-origin child frame's page is in this stream too, with its own title.
 * A `<title>` added to the head later is taken as later in the head.
 */
export function titleChanges(lines) {
  const element = (n, tag) => Boolean(n) && n.type === 2 && n.tagName === tag;
  const child = (n, tag) => (n && Array.isArray(n.childNodes) ? n.childNodes.find((c) => element(c, tag)) : undefined);
  const textsOf = (n) => new Map((n.childNodes || []).filter((c) => c && c.type === 3).map((c) => [c.id, String(c.textContent ?? '')]));
  let head = null;
  const titles = new Map(); // <title> node ID -> its text nodes (node ID -> text)
  const changes = [];
  for (const { sentMs, event } of lines) {
    const data = event.data || {};
    if (event.type === 2) {
      const headNode = child(child(data.node, 'html'), 'head');
      head = headNode ? headNode.id : null;
      titles.clear();
      for (const n of (headNode && headNode.childNodes) || []) if (element(n, 'title')) titles.set(n.id, textsOf(n));
    } else if (event.type === 3 && data.source === 0 && head !== null) {
      for (const r of data.removes || []) {
        if (!titles.delete(r.id) && titles.has(r.parentId)) titles.get(r.parentId).delete(r.id);
      }
      const adds = data.adds || [];
      for (const a of adds) if (a.parentId === head && element(a.node, 'title')) titles.set(a.node.id, textsOf(a.node));
      for (const a of adds) if (titles.has(a.parentId) && a.node && a.node.type === 3) titles.get(a.parentId).set(a.node.id, String(a.node.textContent ?? ''));
      for (const t of data.texts || []) for (const texts of titles.values()) if (texts.has(t.id)) texts.set(t.id, String(t.value ?? ''));
    } else continue;
    const first = titles.values().next().value;
    const title = first ? [...first.values()].join('').replace(HTML_SPACE, ' ').trim() : '';
    if (title !== (changes.length ? changes[changes.length - 1].title : '')) changes.push({ atMs: sentMs, title });
  }
  return changes;
}

// A document's `title` is the title the page had at the URL it loaded with:
// the last one before its first in-document route change (an app often sets
// the title after it starts; later routes carry their own). When the page
// had none by then, the first one it had after.
function titleAtLoad(changes, firstRouteMs = Infinity) {
  const named = changes.filter((c) => c.title);
  const atLoad = named.filter((c) => c.atMs < firstRouteMs);
  const chosen = atLoad.length ? atLoad[atLoad.length - 1] : named[0];
  return chosen ? chosen.title : '';
}

// A route's title is the title the page settled on for that route: the last
// change at or after the route and before the next route in the same
// document (or the end). When the page did not change it there, the title in
// effect at the route's time. Empty when the document's stream holds none.
function titleForRoute(changes, atMs, nextMs = Infinity) {
  const named = changes.filter((c) => c.title);
  const during = named.filter((c) => c.atMs >= atMs && c.atMs < nextMs);
  const before = named.filter((c) => c.atMs < atMs);
  const chosen = during.length ? during[during.length - 1] : before[before.length - 1];
  return chosen ? chosen.title : '';
}

// A title shaped like a credential is left out: the bundle refuses one
// (schema §11) and the export would fail.
const pageTitle = (text) => (isCredentialValue(text) ? '' : cut(text, LIMITS.title));

// A marked box's text loses the words shaped like a credential (a `sk-` key,
// and "Bearer" with the word after it): the bundle refuses one (schema §11)
// and the export would fail. The rest of the text stays.
function regionText(text) {
  const words = String(text).split(' ');
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === 'Bearer') i += 1;
    else if (!isCredentialValue(words[i])) kept.push(words[i]);
  }
  const out = kept.join(' ').trim();
  return isCredentialValue(out) ? '' : out;
}

/** What the person said the recording is for; none when blank or shaped like a credential. */
function purposeOf(meta) {
  const text = cut(String(meta.purpose || '').trim(), LIMITS.purpose);
  return text && !isCredentialValue(text) ? { purpose: text } : {};
}

/**
 * The windows of the recording (schema §5, board #16754): w1 is the tab the
 * recording started in; each tab or popup it opened that the person switched
 * to is the next, in the order it was followed. `windowOf` maps a tab ID (any
 * ID the browser gave it) to its key; an unknown tab is w1.
 */
function windowsFor(rec, entries, sessionMs) {
  const tabOf = tabAliases(entries);
  const keys = new Map([[tabOf(rec.meta.tabId), 'w1']]);
  const windows = [{ key: 'w1', opener: null, type: 'tab', openedMs: 0, closedMs: null }];
  const follows = [];
  for (const e of entries) {
    if (e.k !== 'nav') continue;
    if (e.type === 'tabFollowed' && !keys.has(tabOf(e.tabId))) {
      const key = `w${windows.length + 1}`;
      keys.set(tabOf(e.tabId), key);
      windows.push({ key, opener: keys.get(tabOf(e.openerTabId)) ?? 'w1', type: e.windowType === 'popup' ? 'popup' : 'tab', openedMs: sessionMs(e.t), closedMs: null });
      follows.push({ key, e });
    } else if (e.type === 'tabClosed' && keys.has(tabOf(e.tabId))) {
      const w = windows.find((x) => x.key === keys.get(tabOf(e.tabId)));
      if (w.key !== 'w1' && w.closedMs === null) w.closedMs = Math.max(w.openedMs, sessionMs(e.t));
    }
  }
  const windowOf = (tabId) => keys.get(tabOf(tabId)) ?? 'w1';
  return { windows, follows, windowOf, multi: windows.length > 1 };
}

// opened, focused and closed lines (schema §6.2 `window`). Focus moves when
// the person switches to a recorded tab in another window; a window that
// closes in front hands back to the one that opened it.
function windowObservations(entries, sessionMs, win, documents) {
  if (!win.multi) return [];
  const out = [];
  const openerOf = new Map(win.windows.map((w) => [w.key, w.opener]));
  const followed = new Map(win.follows.map(({ key, e }) => [e, key]));
  let front = 'w1';
  for (const e of entries) {
    if (e.k !== 'nav') continue;
    if (followed.has(e)) {
      const key = followed.get(e);
      const o = { kind: 'window', basis: 'observed', atMs: sessionMs(e.t), window: key, state: 'opened', opener: openerOf.get(key) };
      const url = e.url ? redactUrl(e.url) : null;
      if (url) o.url = url;
      // A popup has no title yet when it opens: its first page names it.
      const title = (e.title ? pageTitle(String(e.title)) : '') || (documents.find((d) => d.frameId === 0 && d.window === key && d.title)?.title ?? '');
      if (title) o.title = title;
      out.push(o);
      front = key;
    } else if (e.type === 'tabClosed' && win.windows.some((w) => w.key === win.windowOf(e.tabId) && w.key !== 'w1')) {
      const key = win.windowOf(e.tabId);
      out.push({ kind: 'window', basis: 'observed', atMs: sessionMs(e.t), window: key, state: 'closed' });
      if (front === key) front = openerOf.get(key) ?? 'w1';
    } else if ((e.type === 'tabActivated' || e.type === 'windowFocused') && e.recorded) {
      const key = win.windowOf(e.activeTabId);
      if (key === front) continue;
      out.push({ kind: 'window', basis: 'observed', atMs: sessionMs(e.t), window: key, state: 'focused' });
      front = key;
    }
  }
  return out;
}

function documentsFor(rec, entries, sessionMs, win) {
  const navs = entries.filter((e) => e.k === 'nav');
  const ordered = [...rec.documents].sort((a, b) => a.attachments[0].at - b.attachments[0].at);
  const keyOf = new Map();
  ordered.forEach((d, i) => keyOf.set(d.documentId || d.doc, `d${i + 1}`));
  const portKey = new Map();
  for (const d of ordered) for (const p of d.ports) portKey.set(p, keyOf.get(d.documentId || d.doc));
  const firstRouteMs = new Map();
  for (const { doc, o } of rec.observations) {
    const key = portKey.get(doc);
    if (!key || o.kind !== 'route' || typeof o.atMs !== 'number') continue;
    firstRouteMs.set(key, Math.min(o.atMs, firstRouteMs.get(key) ?? Infinity));
  }

  const lost = new Set(rec.gaps.filter((g) => g.reason === 'lost-messages' && g.documentId).map((g) => g.documentId));
  const detachedAt = new Map(entries.filter((e) => e.k === 'detach').map((e) => [e.doc, e.t]));
  const streams = new Map();
  const titlesOf = new Map(); // document key -> its title changes
  const documents = ordered.map((d, i) => {
    const id = d.documentId || d.doc;
    const key = keyOf.get(id);
    const commit = navs.find((n) => n.type === 'committed' && n.documentId && n.documentId === d.documentId);
    const parentDocumentId = commit ? commit.parentDocumentId : null;
    const ports = new Set(d.ports);
    const lines = [];
    for (const e of entries) {
      if (e.k !== 'rr' || !ports.has(e.doc) || !e.e) continue;
      lines.push({ seq: lines.length, sentMs: sessionMs(e.sent ?? e.t), receivedMs: sessionMs(e.t), event: redactRrwebEvent(e.e) });
    }
    if (lines.length) streams.set(`rrweb/${key}.jsonl`, lines);
    titlesOf.set(key, titleChanges(lines));
    // Still attached at stop when any of its ports never detached.
    const detaches = d.ports.map((p) => detachedAt.get(p));
    const detachedMs = detaches.some((t) => t === undefined) ? null : sessionMs(Math.max(...detaches));
    const url = redactUrl(d.url) || 'about:blank';
    return {
      key,
      browserDocumentId: d.documentId ? String(d.documentId).slice(0, 200) : undefined,
      frameId: d.frameId ?? (d.isTop ? 0 : 1),
      parentKey: d.frameId === 0 ? null : (parentDocumentId && keyOf.get(parentDocumentId)) || null,
      frameNode: null,
      url,
      // The tab title at Start stands in for the first page when its content
      // holds no title (nothing captured, or no <title> in the page).
      title: pageTitle(titleAtLoad(titlesOf.get(key), firstRouteMs.get(key)) || (i === 0 && rec.meta.title && d.url === rec.meta.url ? String(rec.meta.title) : '')),
      navigationType: d.navType || '',
      transition: commit ? routeTransition(commit) : '',
      attachedMs: sessionMs(d.attachments[0].at),
      detachedMs,
      attachments: d.attachments.map((a) => ({ atMs: sessionMs(a.at), reason: ['boot', 'bfcache-restore', 'reconnect'].includes(a.reason) ? a.reason : 'reconnect' })),
      capture: d.firstSnapshotAt !== null && !lost.has(d.documentId) ? 'full' : 'partial',
      rrweb: lines.length ? `rrweb/${key}.jsonl` : null,
      // Only a recording of more than one window names them (board #16754).
      ...(win.multi ? { window: win.windowOf(d.tabId) } : {}),
    };
  });
  for (const d of documents) if (d.browserDocumentId === undefined) delete d.browserDocumentId;
  return { documents, keyOf, portKey, streams, titlesOf };
}

function observationsFor(rec, entries, sessionMs, { documents, keyOf, portKey, titlesOf }, win) {
  const out = windowObservations(entries, sessionMs, win, documents);
  // One route per top-frame document load (and back/forward restore); the
  // page already open at Start is a `load`. Same-document routes come from
  // the interaction capture below.
  const urlOf = new Map(documents.map((d) => [d.key, d.url]));
  const titleOf = new Map(documents.map((d) => [d.key, d.title]));
  const committed = new Set();
  for (const n of entries) {
    if (n.k !== 'nav' || n.type !== 'committed' || n.frameId !== 0 || !keyOf.has(n.documentId)) continue;
    const doc = keyOf.get(n.documentId);
    committed.add(doc);
    out.push({ kind: 'route', basis: 'observed', atMs: sessionMs(n.t), doc, url: redactUrl(n.url) || urlOf.get(doc), title: titleOf.get(doc), transition: routeTransition(n) });
  }
  for (const d of documents) {
    if (d.frameId !== 0 || committed.has(d.key)) continue;
    out.push({ kind: 'route', basis: 'observed', atMs: d.attachedMs, doc: d.key, url: d.url, title: d.title, transition: 'load' });
  }

  for (const { doc, o } of rec.observations) {
    const key = portKey.get(doc);
    if (!key || typeof o.kind !== 'string' || typeof o.atMs !== 'number') continue;
    const obs = { ...o, doc: key, atMs: round(Math.max(0, o.atMs)) };
    if (typeof o.endMs === 'number') obs.endMs = round(Math.max(obs.atMs, o.endMs));
    if (o.kind === 'route') {
      obs.url = redactUrl(o.url) || urlOf.get(key);
      obs.title = cut(String(o.title || ''), LIMITS.title);
    }
    if (o.kind === 'marker-region' && o.text !== undefined) {
      const text = regionText(o.text);
      if (text) obs.text = text;
      else delete obs.text;
    }
    out.push(obs);
  }
  out.sort((a, b) => a.atMs - b.atMs);
  // Each route gets the title in effect for it, read from its document's
  // stream; the title the page had when the route was observed is often the
  // previous route's (an app sets the new title after it pushes the URL).
  const routesOf = new Map();
  for (const o of out) if (o.kind === 'route') routesOf.set(o.doc, [...(routesOf.get(o.doc) || []), o]);
  for (const [doc, routes] of routesOf) {
    const changes = titlesOf.get(doc) || [];
    routes.forEach((r, i) => {
      const title = titleForRoute(changes, r.atMs, i + 1 < routes.length ? routes[i + 1].atMs : Infinity);
      if (title) r.title = pageTitle(title);
    });
  }
  return out.map((o, i) => ({ id: `o${i + 1}`, ...o }));
}

function gapsFor(rec, sessionMs, durationMs, keyOf, win) {
  return rec.gaps.map((g) => {
    const startMs = Math.min(sessionMs(g.from ?? rec.meta.startedAt), durationMs);
    const gap = { scope: g.scope, startMs, endMs: g.to == null ? durationMs : Math.max(startMs, Math.min(sessionMs(g.to), durationMs)), reason: g.reason };
    if (g.documentId && keyOf.has(g.documentId)) gap.doc = keyOf.get(g.documentId);
    // A restricted page in a followed window says which window (board #16754).
    else if (win.multi && g.tabId !== undefined) gap.window = win.windowOf(g.tabId);
    if (g.detail) gap.detail = cut(String(g.detail), LIMITS.detail);
    return gap;
  });
}

// One narration file per bundle: the first audio part with saved chunks and
// clock pairs. A recorder restart starts a new part (a new WebM file); later
// parts are labelled as gaps rather than joined into an invalid file.
async function narrationFor(rec, entries, sessionMs, durationMs) {
  const gaps = [];
  let chosen = null;
  for (const seg of rec.audio) {
    const clock = entries
      .filter((e) => e.k === 'audio' && e.type === 'clock' && e.segment === seg.segment)
      .filter((e, i, all) => i === 0 || e.frames > all[i - 1].frames);
    if (!chosen && seg.chunks.length && clock.length) {
      chosen = { seg, clock };
      continue;
    }
    gaps.push({
      scope: 'audio',
      startMs: Math.min(sessionMs(seg.startAt), durationMs),
      endMs: Math.min(sessionMs(seg.endAt), durationMs),
      reason: 'recorder-error',
      detail: clock.length ? `narration part ${seg.segment + 1} is not in this bundle (one narration file per bundle)` : `narration part ${seg.segment + 1} has no audio clock`,
    });
  }
  if (!chosen) return { audio: null, gaps };
  const { seg, clock } = chosen;
  const bytes = new Uint8Array(await new Blob(seg.chunks.map((c) => c.data)).arrayBuffer());
  return {
    gaps,
    bytes,
    clock: clock.map((c) => ({ frames: c.frames, sampleRate: c.sampleRate, atMs: sessionMs(c.t) })),
    audio: {
      file: AUDIO_PATH,
      mediaType: seg.mime || 'audio/webm;codecs=opus',
      clock: CLOCK_PATH,
      startMs: Math.min(sessionMs(seg.startAt), durationMs),
      decodedMs: round(Math.max(0, seg.endAt - seg.startAt)),
    },
  };
}

/**
 * A revision from a model in the registry carries that model's measured word
 * error rate (board #16611), so an agent reading the bundle knows the quality
 * to expect. A revision made by more than one model (one per audio part)
 * carries the worst. Any model not measured: nothing is added.
 */
const MEASURED_BASIS = 'word error rate on one 113 s English reading passage';
const OTHER_TAKE_BASIS = 'word error rate on one English reading passage';

export function withMeasured(revision) {
  if (revision.measured) return revision;
  const measured = String(revision.model || '')
    .split('+')
    .map((model) => MODELS[model]?.measured);
  if (!measured.length || measured.some((m) => !m)) return revision;
  const worst = measured.reduce((a, b) => (b.werPassagePct > a.werPassagePct ? b : a));
  return { ...revision, measured: { werPct: worst.werPassagePct, basis: worst.otherTake ? `${OTHER_TAKE_BASIS}, ${worst.otherTake}, ${worst.werSetup} (${worst.source})` : `${MEASURED_BASIS}, ${worst.werSetup} (${worst.source})` } };
}

// The recording's transcript history (store/db.js, transcription/src/
// revisions.ts) already holds revisions and edits in the bundle's §8 shape;
// its extension state (version, pending job, spent consents) stays local.
function transcriptFor(history) {
  if (!history) return { revisions: [], edits: [], activeRevision: null };
  const revisions = (history.revisions || []).map(withMeasured);
  const active = revisions.some((r) => r.revisionId === history.activeRevision) ? history.activeRevision : null;
  return { revisions, edits: history.edits || [], activeRevision: active };
}

/**
 * Writes the bundle tree of one stopped or interrupted recording. Validates
 * it (docs/bundle-schema.md §11) and adds the agent exports and README.md
 * and AGENTS.md (§9). Throws when
 * the recording is still running or the tree does not validate.
 *
 * @param {{ meta: object, eventChunks: object[], audioChunks: object[],
 *   history?: object,
 *   producer: { name: string, version: string },
 *   environment: { browser: string, browserVersion: string, platform: string } }} input
 * @returns {Promise<{ files: Map<string, Uint8Array>, manifest: object, warnings: object[] }>}
 */
export async function writeBundle({ meta, eventChunks, audioChunks, history, producer, environment }) {
  if (!meta || meta.status === 'recording') throw new Error('Stop the recording before exporting it.');
  const rec = analyze({ meta, eventChunks, audioChunks });
  const origin = meta.startedAt;
  const sessionMs = (t) => round(Math.max(0, t - origin));
  const lastAt = Math.max(meta.stoppedAt ?? 0, ...eventChunks.map((c) => c.endAt), ...audioChunks.map((c) => c.endAt));
  const durationMs = sessionMs(lastAt);

  const win = windowsFor(rec, rec.entries, sessionMs);
  const docs = documentsFor(rec, rec.entries, sessionMs, win);
  const observations = observationsFor(rec, rec.entries, sessionMs, docs, win);
  const narration = await narrationFor(rec, rec.entries, sessionMs, durationMs);
  const gaps = [...gapsFor(rec, sessionMs, durationMs, docs.keyOf, win), ...narration.gaps];
  if (!narration.audio && !gaps.some((g) => g.scope === 'audio')) {
    gaps.push({ scope: 'audio', startMs: 0, endMs: durationMs, reason: 'recorder-error', detail: 'no narration was saved' });
  }
  gaps.sort((a, b) => a.startMs - b.startMs);
  const transcript = transcriptFor(history);

  const manifest = {
    format: 'narwal.bundle',
    schemaVersion: SCHEMA_VERSION,
    recordingId: bundleRecordingId(meta.id),
    title: cut(String(meta.title || (redactUrl(meta.url) ? new URL(meta.url).host : '') || 'Recording').trim() || 'Recording', LIMITS.title),
    ...purposeOf(meta),
    createdAt: new Date(meta.startedAt).toISOString(),
    producer,
    environment,
    clock: { originEpochMs: origin },
    durationMs,
    state: meta.status === 'stopped' ? 'complete' : 'recovered',
    privacy: {
      inputValues: 'masked',
      excludedRegions: observations.filter((o) => o.kind === 'exclusion' && o.state === 'added').length,
      urlPolicy: 'redact-query-values',
      audio: 'not-redacted',
    },
    derivation: { pointerDwellMinMs: POINTER_DWELL_MIN_MS },
    audio: narration.audio,
    transcript: { activeRevision: transcript.activeRevision },
  };

  const files = new Map();
  for (const revision of transcript.revisions) files.set(`transcript/${revision.revisionId}.json`, json(revision));
  if (transcript.edits.length) files.set('edits.jsonl', jsonl(transcript.edits));
  files.set('documents.json', json(win.multi ? { documents: docs.documents, windows: win.windows } : { documents: docs.documents }));
  files.set('observations.jsonl', jsonl(observations));
  files.set('gaps.jsonl', jsonl(gaps.map((g, i) => ({ id: `g${i + 1}`, ...g }))));
  for (const [path, lines] of docs.streams) files.set(path, jsonl(lines));
  if (narration.audio) {
    files.set(AUDIO_PATH, narration.bytes);
    files.set(CLOCK_PATH, jsonl(narration.clock));
  }

  const result = await validateBundle(memorySource(await withManifest(manifest, files)));
  const refused = [...result.errors, ...result.warnings.filter((w) => w.code === 'W_UNKNOWN_FIELD')];
  if (!result.bundle || refused.length) {
    const first = refused[0];
    throw new Error(`The bundle did not validate: ${first ? `${first.code} ${first.message}${first.file ? ` (${first.file}${first.line ? `:${first.line}` : ''})` : ''}` : 'unknown error'}`);
  }
  const view = buildAgentView(result.bundle);
  files.set('agent/walkthrough.md', enc.encode(renderMarkdown(view)));
  files.set('agent/walkthrough.json', enc.encode(stableJson(view)));
  for (const path of README_PATHS) files.set(path, enc.encode(renderReadme(view)));
  return { files: await withManifest(manifest, files), manifest, warnings: result.warnings };
}
