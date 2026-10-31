// Reopens a saved recording: turns stored chunks into documents, navigations,
// audio segments and labelled gaps. Pure: the recordings page and the tests
// use the same code. Times are wall-clock milliseconds.

// Saved event chunks arrive about once a second (the recorder writes a
// heartbeat), so a longer silence between chunks is missing data.
export const EVENTS_GAP_MS = 5000;
// Audio chunks are one second long.
export const AUDIO_GAP_MS = 2500;

export function flattenEntries(eventChunks) {
  return [...eventChunks].sort((a, b) => a.seq - b.seq).flatMap((c) => c.entries);
}

export function documentsOf(entries) {
  const docs = new Map();
  for (const e of entries) {
    if (e.k === 'attach') {
      let d = docs.get(e.doc);
      if (!d) {
        d = {
          doc: e.doc,
          documentId: e.documentId,
          // The tab it was in; an older recording has one tab and no tabId.
          tabId: e.tabId ?? null,
          frameId: e.frameId,
          url: e.url,
          isTop: e.boot ? e.boot.isTop : e.frameId === 0,
          instance: e.boot ? e.boot.inst : null,
          navType: e.boot ? e.boot.navType : null,
          attachments: [],
          rrEvents: 0,
          firstSnapshotAt: null,
          lastEventAt: null,
        };
        docs.set(e.doc, d);
      }
      d.attachments.push({ reason: e.reason, at: e.t });
    } else if (e.k === 'rr' && docs.has(e.doc)) {
      const d = docs.get(e.doc);
      d.rrEvents += 1;
      if (e.e && e.e.type === 2 && d.firstSnapshotAt === null) d.firstSnapshotAt = e.t;
      d.lastEventAt = e.t;
    }
  }
  // One browser document can attach more than once (each attach is a new
  // port): back/forward restore, recorder restart. Group by documentId.
  const byDocumentId = new Map();
  for (const d of docs.values()) {
    const key = d.documentId || d.doc;
    const g = byDocumentId.get(key);
    if (!g) byDocumentId.set(key, { ...d, ports: [d.doc] });
    else {
      g.ports.push(d.doc);
      g.attachments.push(...d.attachments);
      g.rrEvents += d.rrEvents;
      g.lastEventAt = Math.max(g.lastEventAt ?? 0, d.lastEventAt ?? 0) || null;
    }
  }
  return [...byDocumentId.values()];
}

/** rrweb events of one browser document (all its ports), in order. */
export function rrwebEventsOf(entries, documentKey) {
  const ports = new Set(
    entries.filter((e) => e.k === 'attach' && (e.documentId || e.doc) === documentKey).map((e) => e.doc),
  );
  return entries.filter((e) => e.k === 'rr' && ports.has(e.doc)).map((e) => e.e);
}

/**
 * Interaction observations (packages/interactions) in arrival order, each
 * with the port it came on (`doc`) and its browser document (`documentKey`).
 * Times inside `o` are session ms (the content script's clock).
 */
export function observationsOf(entries) {
  const documentOf = new Map(entries.filter((e) => e.k === 'attach').map((e) => [e.doc, e.documentId || e.doc]));
  return entries
    .filter((e) => e.k === 'obs' && e.o && documentOf.has(e.doc))
    .map((e) => ({ doc: e.doc, documentKey: documentOf.get(e.doc), at: e.t, o: e.o }));
}

export function navigationsOf(entries) {
  return entries
    .filter((e) => e.k === 'nav' && ['committed', 'historyStateUpdated', 'referenceFragmentUpdated', 'errorOccurred'].includes(e.type))
    .map((e) => ({ type: e.type, at: e.t, tabId: e.tabId ?? null, frameId: e.frameId, url: e.url, documentId: e.documentId, transitionType: e.transitionType, error: e.error }));
}

export function audioSegmentsOf(audioChunks) {
  const segments = new Map();
  for (const c of [...audioChunks].sort((a, b) => a.seq - b.seq)) {
    let s = segments.get(c.segment);
    if (!s) {
      s = { segment: c.segment, mime: c.mime, chunks: [], bytes: 0, startAt: c.startAt, endAt: c.endAt };
      segments.set(c.segment, s);
    }
    s.chunks.push(c);
    s.bytes += c.bytes;
    s.endAt = c.endAt;
  }
  return [...segments.values()];
}

/**
 * Every interval the recording is known to be missing, with a reason:
 * gaps the recorder wrote, plus gaps found from the saved data itself.
 * `scope` and `reason` use the bundle schema names (docs/bundle-schema.md §7).
 */
export function gapsOf({ meta, entries, eventChunks, audioChunks }) {
  const end = meta.stoppedAt ?? null;
  const gaps = entries.filter((e) => e.k === 'gap').map((g) => ({ scope: g.scope, reason: g.reason, from: g.from, to: g.to ?? end, detail: g.detail ?? null, source: 'recorder' }));
  const covered = (from, to, scope) => gaps.some((g) => (g.scope === scope || g.scope === 'any') && g.from <= from + 1 && (g.to ?? Infinity) >= to - 1);

  const chunks = [...eventChunks].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < chunks.length; i += 1) {
    const from = chunks[i - 1].endAt;
    const to = chunks[i].startAt;
    if (to - from > EVENTS_GAP_MS && !covered(from, to, 'any')) gaps.push({ scope: 'any', reason: 'recovery-truncated', from, to, detail: 'nothing was saved in this interval', source: 'analysis' });
  }

  const bySegment = new Map();
  for (const c of [...audioChunks].sort((a, b) => a.seq - b.seq)) {
    const prev = bySegment.get(c.segment);
    if (prev && c.startAt - prev.endAt > AUDIO_GAP_MS && !covered(prev.endAt, c.startAt, 'audio')) {
      gaps.push({ scope: 'audio', reason: 'recorder-error', from: prev.endAt, to: c.startAt, detail: `no audio was saved in this interval (part ${c.segment + 1})`, source: 'analysis' });
    }
    bySegment.set(c.segment, c);
  }

  if (meta.status === 'interrupted') {
    const from = meta.interruption ? meta.interruption.lastSavedAt ?? meta.startedAt : meta.stoppedAt;
    gaps.push({ scope: 'any', reason: 'recovery-truncated', from, to: meta.interruption ? meta.interruption.detectedAt : null, detail: 'the recorder ended without Stop; nothing after this point was saved', source: 'analysis' });
  }

  // A failed write stops the recording. On a full disk the final flush fails
  // too, so the recorder's own gap may never be saved: the meta record says.
  const failed = meta.storageError && meta.storageError.lost;
  if (failed && !covered(failed.from, end ?? failed.from, 'any')) {
    gaps.push({ scope: 'any', reason: 'recovery-truncated', from: failed.from, to: end, detail: meta.storageError.quota ? 'storage-full' : `storage-error: ${meta.storageError.message}`, source: 'analysis' });
  }

  // Top-frame documents the browser committed but no recorder attached to:
  // restricted pages (chrome://, Web Store, PDF viewers) or failed injection.
  // Each tab has its own pages (board #16754): a page lasts until the next
  // commit in the same tab, or until a followed tab closed.
  const attached = new Set(entries.filter((e) => e.k === 'attach').map((e) => e.documentId).filter(Boolean));
  const tabOf = tabAliases(entries);
  const commits = entries.filter((e) => e.k === 'nav' && e.type === 'committed' && e.frameId === 0);
  const closedAt = new Map(entries.filter((e) => e.k === 'nav' && e.type === 'tabClosed').map((e) => [tabOf(e.tabId), e.t]));
  commits.forEach((c, i) => {
    if (!c.documentId || attached.has(c.documentId)) return;
    const tab = tabOf(c.tabId);
    const next = commits.slice(i + 1).find((n) => tabOf(n.tabId) === tab);
    const gap = { scope: 'page', reason: 'restricted-page', from: c.t, to: next ? next.t : (closedAt.get(tab) ?? end), detail: c.url, source: 'analysis' };
    if (tab !== null) gap.tabId = tab;
    gaps.push(gap);
  });

  gaps.push(...lostMessages(entries));
  return gaps.sort((a, b) => a.from - b.from);
}

/**
 * A tab the browser replaced (prerender, back/forward cache) keeps the ID it
 * had when it was first recorded: tabId -> that first ID. Null stays null.
 */
export function tabAliases(entries) {
  const first = new Map();
  for (const e of entries) {
    if (e.k === 'nav' && e.type === 'tabReplaced') first.set(e.tabId, first.get(e.replacedTabId) ?? e.replacedTabId);
  }
  return (tabId) => (tabId === null || tabId === undefined ? null : (first.get(tabId) ?? tabId));
}

// Each content-script instance numbers its messages 1, 2, 3... across every
// port it opens in one recording. A missing number is a message that never
// arrived (queue full, a port closed under it).
function lostMessages(entries) {
  const instanceOf = new Map();
  const seen = new Map();
  for (const e of entries) {
    if (e.k === 'attach') {
      const inst = e.boot ? e.boot.inst : e.doc;
      instanceOf.set(e.doc, { inst, documentId: e.documentId || e.doc });
    } else if (typeof e.seq === 'number' && instanceOf.has(e.doc)) {
      const { inst, documentId } = instanceOf.get(e.doc);
      if (!seen.has(inst)) seen.set(inst, []);
      seen.get(inst).push({ seq: e.seq, t: e.t, documentId });
    }
  }
  const gaps = [];
  for (const list of seen.values()) {
    list.sort((a, b) => a.seq - b.seq);
    let prev = null;
    for (const m of list) {
      const expected = prev ? prev.seq + 1 : 1;
      if (m.seq > expected) {
        gaps.push({ scope: 'page', reason: 'lost-messages', from: prev ? prev.t : m.t, to: m.t, detail: `${m.seq - expected} message(s) lost`, documentId: m.documentId, source: 'analysis' });
      }
      prev = m;
    }
  }
  return gaps;
}

export function analyze({ meta, eventChunks, audioChunks }) {
  const entries = flattenEntries(eventChunks);
  return {
    meta,
    entries,
    documents: documentsOf(entries),
    navigations: navigationsOf(entries),
    observations: observationsOf(entries),
    audio: audioSegmentsOf(audioChunks),
    gaps: gapsOf({ meta, entries, eventChunks, audioChunks }),
    refusedPorts: entries.filter((e) => e.k === 'refused').length,
    consumerErrors: entries.filter((e) => e.k === 'consumer-error').length,
  };
}
