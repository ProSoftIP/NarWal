// Turns one probe session dump into measurements (board #16538).
// Pure functions with no Node imports: the extension's report page bundles
// this file too. All times are performance.timeOrigin + performance.now() ms.

const RR_FULL_SNAPSHOT = 2;

function quantiles(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

// Least-squares slope of y on x; returns slope and residual spread.
function fit(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const slope = sxy / sxx;
  const residuals = points.map((p) => p.y - (my + slope * (p.x - mx)));
  return { slope, residual: quantiles(residuals.map(Math.abs)), spanMs: points[n - 1].x - points[0].x };
}

// Documents keyed by content-script instance (one per document per frame).
export function documents(session) {
  const ports = new Map();
  const docs = new Map();
  for (const entry of session.log) {
    if (entry.k === 'conn') ports.set(entry.port || entry.key, entry);
    if (entry.k === 'hello') {
      const conn = ports.get(entry.port) || {};
      const inst = entry.boot.inst;
      if (!docs.has(inst)) {
        docs.set(inst, {
          inst,
          url: entry.boot.url,
          isTop: entry.boot.isTop,
          frameId: conn.frameId,
          documentId: conn.documentId,
          navType: entry.boot.navType,
          readyStateAtInject: entry.boot.readyState,
          injectedAt: entry.boot.injectedAt,
          hellos: [],
          ports: [],
          firstFullSnapshotAt: null,
          firstFullSnapshotSentAt: null,
          lastRecv: null,
          rrEvents: 0,
          rrBytes: 0,
          seqs: [],
          queued: 0,
          probes: [],
        });
      }
      const doc = docs.get(inst);
      doc.hellos.push({ reason: entry.reason, recv: entry.recv, pendingCount: entry.pendingCount, dropped: entry.dropped });
      doc.ports.push(entry.port);
    }
  }
  const portToInst = new Map();
  for (const doc of docs.values()) for (const p of doc.ports) portToInst.set(p, doc.inst);
  for (const entry of session.log) {
    const inst = portToInst.get(entry.port);
    if (!inst || entry.k === 'hello' || entry.k === 'conn') continue;
    const doc = docs.get(inst);
    if (entry.k === 'disc') {
      doc.disconnectedAt = entry.recv;
      continue;
    }
    doc.lastRecv = entry.recv;
    if (typeof entry.seq === 'number') doc.seqs.push(entry.seq);
    if (entry.queued) doc.queued += 1;
    if (entry.k === 'rr') {
      doc.rrEvents += 1;
      doc.rrBytes += JSON.stringify(entry.e).length;
      if (entry.e.type === RR_FULL_SNAPSHOT && doc.firstFullSnapshotAt === null) {
        doc.firstFullSnapshotAt = entry.recv;
        doc.firstFullSnapshotSentAt = entry.sent;
      }
    }
    if (entry.k === 'probe') doc.probes.push({ type: entry.type, recv: entry.recv, ...pick(entry, ['persisted', 'state', 'reason', 'shadow', 'frames', 'canvases', 'url', 'err']) });
  }
  for (const doc of docs.values()) {
    const s = [...new Set(doc.seqs)].sort((a, b) => a - b);
    let missing = 0;
    for (let i = 1; i < s.length; i += 1) missing += s[i] - s[i - 1] - 1;
    doc.seqMissing = missing;
    doc.seqMax = s.length ? s[s.length - 1] : 0;
    delete doc.seqs;
  }
  return [...docs.values()].sort((a, b) => a.injectedAt - b.injectedAt);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Which ground-truth markers reached the recording, and in which document.
export function markers(session, expected) {
  const found = {};
  const docOfPort = new Map();
  for (const entry of session.log) if (entry.k === 'hello') docOfPort.set(entry.port, entry.boot.url);
  for (const entry of session.log) {
    if (entry.k !== 'rr') continue;
    const text = JSON.stringify(entry.e);
    for (const m of expected) {
      if (found[m.label]) continue;
      if (text.includes(`marker:${m.label}`)) found[m.label] = { recv: entry.recv, latencyMs: m.at ? Math.round(entry.recv - m.at) : null, url: docOfPort.get(entry.port) };
    }
  }
  return expected.map((m) => ({ label: m.label, note: m.note || null, captured: Boolean(found[m.label]), ...(found[m.label] || {}) }));
}

export function textCaptured(session, needle) {
  return session.log.some((e) => e.k === 'rr' && JSON.stringify(e.e).includes(needle));
}

// Top-frame continuity. Each attachment is one port lifetime of a top-frame
// document (a new document, or a back/forward-cache restore of an old one).
// The blind window is from the last message of one attachment to the first
// full snapshot of the next: page changes in between are not recorded.
export function topFrameGaps(session) {
  const tops = new Map();
  for (const e of session.log) {
    if (e.k === 'hello' && e.boot.isTop) tops.set(e.port, { port: e.port, url: e.boot.url, reason: e.reason, navType: e.boot.navType, hello: e.recv, firstSnapshot: null, last: e.recv, lostSeqs: [] , recent: e.recent || [], seqs: [] });
  }
  const conns = new Map(session.log.filter((e) => e.k === 'conn').map((e) => [e.key, e]));
  for (const e of session.log) {
    const a = tops.get(e.port);
    if (!a || e.k === 'hello' || e.k === 'disc') continue;
    a.last = e.recv;
    if (typeof e.seq === 'number') a.seqs.push(e.seq);
    if (e.k === 'rr' && e.e.type === RR_FULL_SNAPSHOT && a.firstSnapshot === null) a.firstSnapshot = e.recv;
  }
  const list = [...tops.values()].sort((x, y) => x.hello - y.hello);
  const navs = session.log.filter((e) => e.k === 'nav' && e.frameId === 0 && e.type === 'committed');
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const next = list[i];
    const conn = conns.get(next.port) || {};
    const commit = [...navs].reverse().find((n) => n.documentId && n.documentId === conn.documentId && n.at <= next.hello + 1);
    gaps.push({
      from: prev.url,
      to: next.url,
      attach: next.reason,
      navType: next.navType,
      transitionType: commit ? commit.transitionType : null,
      blindMs: next.firstSnapshot ? Math.round(next.firstSnapshot - prev.last) : null,
      commitToSnapshotMs: commit && next.firstSnapshot ? Math.round(next.firstSnapshot - commit.at) : null,
    });
  }
  return gaps;
}

// Messages a document sent that never arrived, named from its own send log.
export function lostMessages(session) {
  const byInst = new Map();
  const portInst = new Map();
  for (const e of session.log) {
    if (e.k !== 'hello') continue;
    portInst.set(e.port, e.boot.inst);
    const d = byInst.get(e.boot.inst) || { url: e.boot.url, recent: new Map(), got: new Set() };
    for (const r of e.recent || []) d.recent.set(r.seq, r);
    byInst.set(e.boot.inst, d);
  }
  for (const e of session.log) {
    const inst = portInst.get(e.port);
    if (inst && typeof e.seq === 'number' && e.k !== 'hello') byInst.get(inst).got.add(e.seq);
  }
  const out = [];
  for (const d of byInst.values()) {
    const max = Math.max(0, ...d.got);
    for (let s = 1; s < max; s += 1) {
      if (d.got.has(s)) continue;
      const r = d.recent.get(s);
      out.push({ url: d.url, seq: s, what: r ? `${r.k}${r.type !== null && r.type !== undefined ? `:${r.type}` : ''}` : 'unknown (not in send log)' });
    }
  }
  return out;
}

export function clock(session) {
  const latency = [];
  const rrLag = [];
  const dateVsPerf = [];
  for (const e of session.log) {
    if (typeof e.sent === 'number' && typeof e.recv === 'number' && e.k !== 'hello' && !e.queued) latency.push(e.recv - e.sent);
    if (e.k === 'rr' && typeof e.e.timestamp === 'number') rrLag.push(e.sent - e.e.timestamp);
    if (e.k === 'sync') dateVsPerf.push({ x: e.sent, y: e.dnow - e.sent });
  }
  const audioPoints = session.log.filter((e) => e.k === 'audio-clock');
  const sr = session.audio && session.audio.sampleRate;
  let audio = null;
  if (sr && audioPoints.length >= 3) {
    const f = fit(audioPoints.map((p) => ({ x: p.at, y: (p.frames / sr) * 1000 })));
    audio = { points: audioPoints.length, ppm: Math.round((f.slope - 1) * 1e6 * 10) / 10, residualMs: f.residual, spanMs: Math.round(f.spanMs) };
  }
  const chunks = session.log.filter((e) => e.k === 'audio-chunk').map((e) => e.recv);
  const chunkGaps = chunks.slice(1).map((t, i) => t - chunks[i]);
  const rec = session.audio || {};
  const recorderStart = rec.recorderStartedAt;
  const stopEntry = session.log.find((e) => e.k === 'session-stop');
  const wallSeconds = recorderStart && stopEntry ? (stopEntry.recv - recorderStart) / 1000 : null;
  const dvp = fit(dateVsPerf);
  return {
    contentToOffscreenLatencyMs: quantiles(latency),
    rrwebTimestampToSendMs: quantiles(rrLag),
    dateNowMinusPerfClock: dvp ? { driftPpm: Math.round(dvp.slope * 1e6 * 10) / 10, residualMs: dvp.residual, spanMs: Math.round(dvp.spanMs) } : null,
    audioRenderClock: audio,
    audioChunks: { count: chunks.length, intervalMs: quantiles(chunkGaps) },
    audioRecorded: {
      decodedSeconds: rec.decodedSeconds ?? null,
      wallSeconds: wallSeconds === null ? null : Math.round(wallSeconds * 1000) / 1000,
      lossSeconds: wallSeconds !== null && rec.decodedSeconds != null ? Math.round((wallSeconds - rec.decodedSeconds) * 1000) / 1000 : null,
      bytes: rec.bytes ?? null,
      error: rec.error ?? null,
      trackEvents: rec.trackEvents ?? [],
    },
  };
}

export function summarise(session, expectedMarkers = []) {
  const all = documents(session);
  // rrweb creates and removes a hidden about:blank iframe on start; the
  // all-frames content script attaches to it. Counted, not listed.
  const transient = all.filter((d) => !d.isTop && d.url === 'about:blank' && d.rrEvents === 0);
  const docs = all.filter((d) => !transient.includes(d));
  return {
    transientBlankFrames: transient.length,
    sessionSeconds: session.stoppedAt ? Math.round(session.stoppedAt - session.startedAt) / 1000 : null,
    documents: docs.map((d) => ({
      url: d.url,
      isTop: d.isTop,
      frameId: d.frameId,
      navType: d.navType,
      readyStateAtInject: d.readyStateAtInject,
      attachments: d.hellos.map((h) => h.reason),
      rrEvents: d.rrEvents,
      rrBytes: d.rrBytes,
      queuedDelivered: d.queued,
      seqMissing: d.seqMissing,
      injectToSnapshotMs: d.firstFullSnapshotAt ? Math.round(d.firstFullSnapshotAt - d.injectedAt) : null,
      probes: d.probes.filter((p) => p.type !== 'route').map((p) => p.type + (p.persisted !== undefined ? `(persisted=${p.persisted})` : '') + (p.state ? `(${p.state})` : '')),
    })),
    topFrameGaps: topFrameGaps(session),
    lostMessages: lostMessages(session),
    navigation: session.log.filter((e) => e.k === 'nav' && e.frameId === 0 && ['committed', 'historyStateUpdated', 'referenceFragmentUpdated', 'errorOccurred', 'tabActivated'].includes(e.type)).map((e) => `${e.type} ${e.transitionType || ''} ${e.url || ''}`.trim()),
    tabEvents: session.log.filter((e) => e.k === 'nav' && ['tabActivated', 'tabRemoved', 'tabReplaced', 'start-inject'].includes(e.type)).map((e) => ({ type: e.type, recordedTabActive: e.recordedTabActive, injected: e.injected })),
    refusedPorts: session.log.filter((e) => e.k === 'refused').length,
    markers: markers(session, expectedMarkers),
    clock: clock(session),
  };
}
