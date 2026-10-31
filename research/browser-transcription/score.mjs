#!/usr/bin/env node
// Board #16539: score raw harness runs against the forced-aligned reference.
//
//   node score.mjs results/raw/<run>.json [...]   -> results/<run>.summary.json + a table on stdout
//
// Accuracy: WER of committed (final) words after light normalisation (case, punctuation,
// hyphens, integers to words). Whisper writes "Mr." and some spellings LibriSpeech does not,
// so its WER carries a small normalisation penalty; that bias is the same across Whisper runs.
// Timing: start/end error of every word aligned as an exact match (MFA reference).
// Latency: stream time from the end of a spoken word until it appeared (partial) or was
// committed (final). Resources: memory samples from the page, CPU from Chrome's process info.

import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = process.env.NARWAL_FIXTURES;
if (!FIXTURES) { console.error('set NARWAL_FIXTURES to the fixtures directory'); process.exit(2); }
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'x x twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
function numWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numWords(n % 100) : [])];
  if (n < 10000) return [...numWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? numWords(n % 1000) : [])];
  return [String(n)];
}
const ABBR = { mr: ['mister'], mrs: ['missus'], dr: ['doctor'], st: ['saint'] };
export function norm(text) {
  const out = [];
  for (let t of String(text).toLowerCase().replace(/[‘’]/g, "'").split(/[\s\-–—]+/)) {
    t = t.replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
    if (!t) continue;
    if (/^\d+$/.test(t)) out.push(...numWords(Number(t)));
    else out.push(...(ABBR[t] || [t]));
  }
  return out;
}

// Levenshtein alignment; returns pairs [i|null, j|null] (ref index, hyp index).
export function align(ref, hyp) {
  const n = ref.length, m = hyp.length, W = m + 1;
  const d = new Uint32Array((n + 1) * W);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * W] = i;
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      d[i * W + j] = Math.min(sub, d[(i - 1) * W + j] + 1, d[i * W + j - 1] + 1);
    }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * W + j] === d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && d[i * W + j] === d[(i - 1) * W + j] + 1) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return pairs.reverse();
}

const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export function score(raw) {
  const res = raw.result;
  const refAll = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${res.cfg.fixture}.json`), 'utf8')).words;
  const fedS = res.live?.fedS ?? 0;
  const ref = refAll.filter((w) => w.e <= fedS);
  const refTok = ref.map((w) => norm(w.w)[0] ?? w.w);
  const events = res.live?.events || [];
  const finals = events.filter((e) => e.kind === 'final');
  const partials = events.filter((e) => e.kind === 'partial');

  // Final words in timeline order, each normalised token keeps its source word's timing.
  const hyp = [];
  for (const ev of finals) for (const w of ev.words) {
    const toks = norm(w.w);
    for (const t of toks) hyp.push({ t, s: w.s, e: w.e, dtw: w.dtw, at: ev.at, split: toks.length > 1 });
  }
  hyp.sort((a, b) => a.s - b.s || 0);
  const pairs = align(refTok, hyp.map((h) => h.t));
  let S = 0, D = 0, I = 0;
  const dS = [], dE = [], finalLat = [], lateByMinute = {};
  const matched = new Map();
  for (const [i, j] of pairs) {
    if (i == null) { I++; continue; }
    if (j == null) { D++; continue; }
    if (refTok[i] !== hyp[j].t) { S++; continue; }
    matched.set(i, j);
    const h = hyp[j], r = ref[i];
    if (!h.split) { dS.push(h.s - r.s); dE.push(h.e - r.e); }
    finalLat.push(h.at - r.e);
    const min = Math.floor(r.e / 60);
    (lateByMinute[min] ||= []).push(h.at - r.e);
  }

  // Insertions inside long reference silences (hallucinated text while the narrator is quiet).
  const gaps = [];
  for (let k = 1; k < ref.length; k++) if (ref[k].s - ref[k - 1].e >= 3) gaps.push([ref[k - 1].e + 0.3, ref[k].s - 0.3]);
  const silentWords = hyp.filter((h) => gaps.some(([a, b]) => h.s >= a && h.s <= b)).length;

  // Visible latency: first partial (or final) in which an aligned word appeared.
  const firstSeen = new Array(ref.length).fill(Infinity);
  let lastFinalFed = 0;
  for (const ev of events) {
    if (ev.kind === 'final') { lastFinalFed = ev.fedS ?? ev.segE ?? lastFinalFed; continue; }
    const winS = ev.segS ?? lastFinalFed, winE = ev.segE ?? ev.fedS ?? ev.at;
    const toks = ev.words ? ev.words.flatMap((w) => norm(w.w)) : norm(ev.text || '');
    const idx = []; for (let k = 0; k < ref.length; k++) if (ref[k].s >= winS - 0.5 && ref[k].e <= winE + 0.5) idx.push(k);
    if (!idx.length || !toks.length) continue;
    for (const [a, b] of align(idx.map((k) => refTok[k]), toks)) if (a != null && b != null && refTok[idx[a]] === toks[b]) firstSeen[idx[a]] = Math.min(firstSeen[idx[a]], ev.at);
  }
  const visLat = [];
  for (let k = 0; k < ref.length; k++) {
    const fin = matched.has(k) ? hyp[matched.get(k)].at : Infinity;
    const seen = Math.min(firstSeen[k], fin);
    if (Number.isFinite(seen)) visLat.push(seen - ref[k].e);
  }

  // Memory and CPU.
  const mem = (res.live?.mem || []).filter((m) => m.uaBytes);
  const memMB = mem.map((m) => m.uaBytes / 1e6);
  let memSlopeMBper10m = null;
  if (mem.length >= 3) {
    const xs = mem.map((m) => m.at), ys = memMB, mx = mean(xs), my = mean(ys);
    const num = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    memSlopeMBper10m = den ? (num / den) * 600 : null;
  }
  const cores = [];
  const cpu = raw.cpu || [];
  for (let k = 1; k < cpu.length; k++) {
    const a = new Map(cpu[k - 1].procs.map((p) => [p.id, p.cpu]));
    const used = cpu[k].procs.reduce((s, p) => s + Math.max(0, p.cpu - (a.get(p.id) ?? p.cpu)), 0);
    const dt = (cpu[k].wall - cpu[k - 1].wall) / 1000;
    if (dt > 5) cores.push(used / dt);
  }
  const L = res.load || {};
  const fileBytes = Object.values(L.files || {}).reduce((a, b) => a + (b || 0), 0);
  const netBytes = Object.values(raw.net || {}).reduce((a, b) => a + b, 0);
  const minutes = Object.keys(lateByMinute).map(Number).sort((a, b) => a - b);
  const firstMin = minutes.slice(0, 5).flatMap((m) => lateByMinute[m]);
  const lastMin = minutes.slice(-5).flatMap((m) => lateByMinute[m]);
  return {
    name: raw.name, engine: res.cfg.engine, model: res.cfg.model || res.cfg.modelUrl, fixture: res.cfg.fixture, sessionUrl: raw.sessionUrl,
    env: res.env, status: raw.status,
    audioS: r3(fedS), wallS: r3(res.live?.wallS), refWords: ref.length,
    wer: r3((S + D + I) / Math.max(1, ref.length)), sub: S, del: D, ins: I, silentInsertions: silentWords,
    timing: {
      n: dS.length,
      startAbsMedianS: r3(q(dS.map(Math.abs), 0.5)), startAbsP90S: r3(q(dS.map(Math.abs), 0.9)), startBiasS: r3(mean(dS)),
      endAbsMedianS: r3(q(dE.map(Math.abs), 0.5)), endAbsP90S: r3(q(dE.map(Math.abs), 0.9)),
      startWithin100ms: r3(dS.filter((x) => Math.abs(x) <= 0.1).length / Math.max(1, dS.length)),
      // Spread around the run's own median offset: what a fixed per-model correction could reach
      // at best (optimistic, because the offset is fitted on the same words it is scored on).
      startSignedP10S: r3(q(dS, 0.1)), startSignedP90S: r3(q(dS, 0.9)),
      startAbsP90DebiasedS: r3(q(dS.map((x) => Math.abs(x - q(dS, 0.5))), 0.9)),
      startWithin250ms: r3(dS.filter((x) => Math.abs(x) <= 0.25).length / Math.max(1, dS.length)),
      startWithin500ms: r3(dS.filter((x) => Math.abs(x) <= 0.5).length / Math.max(1, dS.length)),
    },
    // Batch runs have no stream clock ('at' is wall time), so stream latencies do not apply;
    // the figure that matters is how long finalizing the whole recording took.
    finalize: res.cfg.mode === 'batch' ? { wallS: r3(res.live?.wallS), realTimeFactor: r3(res.live?.wallS / Math.max(1, fedS)) } : null,
    latency: res.cfg.mode === 'batch' ? {} : {
      finalMedianS: r3(q(finalLat, 0.5)), finalP90S: r3(q(finalLat, 0.9)), finalMaxS: r3(q(finalLat, 1)),
      visibleMedianS: r3(q(visLat, 0.5)), visibleP90S: r3(q(visLat, 0.9)),
      finalP90FirstFiveMinS: r3(q(firstMin, 0.9)), finalP90LastFiveMinS: r3(q(lastMin, 0.9)),
      maxBacklogS: r3(Math.max(0, ...(res.live?.lag || []).map((l) => l.backlogS))),
      partialEvents: partials.length, finalEvents: finals.length,
    },
    compute: {
      dutyCycle: res.live?.busyMs ? r3(res.live.busyMs / 1000 / Math.max(1, res.live.wallS)) : null,
      coresMean: r3(mean(cores)), coresP90: r3(q(cores, 0.9)), coresMax: r3(q(cores, 1)),
    },
    memory: { firstMB: r3(memMB[0]), maxMB: r3(Math.max(...memMB)), lastMB: r3(memMB[memMB.length - 1]), slopeMBper10min: r3(memSlopeMBper10m), samples: memMB.length, afterLoadMB: r3((L.memAfterLoad?.uaBytes || 0) / 1e6) },
    load: {
      modelFileMB: r3(fileBytes / 1e6), networkMB: r3(netBytes / 1e6), netByHostMB: Object.fromEntries(Object.entries(raw.net || {}).map(([k, v]) => [k, r3(v / 1e6)])),
      coldLoadS: r3(L.coldMs / 1000), firstInferS: r3(L.firstInferMs / 1000), secondInferS: r3(L.secondInferMs / 1000),
      cachedLoadS: r3(L.cachedLoadMs / 1000), cachedFirstInferS: r3(L.cachedFirstInferMs / 1000),
    },
    offline: raw.offline ? { ok: raw.offline.ok, loadS: r3(raw.offline.loadMs / 1000), inferS: r3(raw.offline.inferMs / 1000), error: raw.offline.error?.slice(0, 300) || null, words: raw.offline.words?.slice(0, 160) } : null,
    error: raw.error || null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  for (const f of process.argv.slice(2)) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!raw.result?.live) { console.error(`${f}: no live result (${raw.status}) ${raw.error?.slice(0, 200) || ''}`); continue; }
    const s = score(raw);
    const out = path.join(path.dirname(f), '..', `${raw.name}.summary.json`);
    fs.writeFileSync(out, JSON.stringify(s, null, 1) + '\n');
    rows.push(s);
  }
  const cols = [
    ['run', (s) => s.name], ['WER', (s) => s.wer], ['silIns', (s) => s.silentInsertions],
    ['start|med|', (s) => s.timing.startAbsMedianS], ['start|p90|', (s) => s.timing.startAbsP90S], ['≤250ms', (s) => s.timing.startWithin250ms], ['bias', (s) => s.timing.startBiasS], ['p90 debiased', (s) => s.timing.startAbsP90DebiasedS],
    ['vis p50', (s) => s.latency.visibleMedianS], ['vis p90', (s) => s.latency.visibleP90S], ['fin p50', (s) => s.latency.finalMedianS], ['fin p90', (s) => s.latency.finalP90S],
    ['fin p90 last5m', (s) => s.latency.finalP90LastFiveMinS], ['duty', (s) => s.compute.dutyCycle], ['cores', (s) => s.compute.coresMean],
    ['memMB max', (s) => s.memory.maxMB], ['mem/10m', (s) => s.memory.slopeMBper10min], ['modelMB', (s) => s.load.modelFileMB], ['netMB', (s) => s.load.networkMB],
    ['cold s', (s) => s.load.coldLoadS], ['1st inf s', (s) => s.load.firstInferS], ['cached s', (s) => s.load.cachedLoadS], ['finalize s', (s) => s.finalize?.wallS], ['offline', (s) => s.offline?.ok],
  ];
  console.log(`| ${cols.map((c) => c[0]).join(' | ')} |`);
  console.log(`|${cols.map(() => '---').join('|')}|`);
  for (const s of rows) console.log(`| ${cols.map((c) => c[1](s) ?? '–').join(' | ')} |`);
}
