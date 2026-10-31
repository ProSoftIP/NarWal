// Board #16539 measurement harness. Runs inside one browser page; the Node runner drives it.
//
// window.BENCH.run(config) loads one engine, feeds a speech fixture at wall-clock pace (as a
// microphone would deliver it), records every partial/final transcript event with the stream
// time it appeared, samples memory, and returns raw events. Scoring happens in Node
// (score.mjs) so the page stays a thin, honest recorder.
//
// The feed bypasses getUserMedia/AudioWorklet: microphone capture and resampling belong to
// slice A/G. Everything after "16 kHz mono Float32 frames arrive every 100 ms" is measured.

import * as T from '@huggingface/transformers';
import createShout from '@transcribe/shout';
import { FileTranscriber } from '@transcribe/transcriber';

const SR = 16000;
const FRAME = SR / 10; // 100 ms, the cadence of a typical AudioWorklet batch
const logEl = document.getElementById('log');
const log = (msg) => { logEl.textContent += `\n${new Date().toISOString()} ${msg}`; console.log(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL_CACHE = 'narwal-bench-models';

async function loadFixture(name) {
  const [buf, ref] = await Promise.all([
    fetch(`/fixtures/${name}.flac`).then((r) => r.arrayBuffer()),
    fetch(`/fixtures/${name}.json`).then((r) => r.json()),
  ]);
  const ctx = new OfflineAudioContext(1, 1, SR);
  const ab = await ctx.decodeAudioData(buf);
  return { pcm: ab.getChannelData(0), ref };
}

// Fetch through the Cache API so a second load (and an offline load) never touches the network.
async function cachedBytes(url) {
  const cache = await caches.open(MODEL_CACHE);
  let res = await cache.match(url);
  let fromCache = true;
  if (!res) {
    fromCache = false;
    const net = await fetch(url);
    if (!net.ok) throw new Error(`fetch ${url}: ${net.status}`);
    await cache.put(url, net.clone());
    res = net;
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), fromCache };
}

// ---------------------------------------------------------------------------------------------
// Engines. Chunked engines expose transcribe(pcm) -> words relative to the chunk start.
// Streaming engines expose feed(frame) and emit events themselves.

class TfjsWhisper {
  kind = 'chunked';
  constructor(cfg) { this.cfg = cfg; }
  async load() {
    T.env.allowLocalModels = false;
    T.env.useBrowserCache = true;
    // The ORT worker script must be same-origin; its 27 MB wasm binary comes from jsDelivr here
    // only because the bench page is served over CDP. An MV3 extension bundles both files.
    T.env.backends.onnx.wasm.wasmPaths = {
      mjs: new URL('/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', location.href).href,
      wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${T.env.backends.onnx.versions?.web || '1.31.0-dev.20260914-8d85527a0'}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
    };
    T.env.backends.onnx.wasm.numThreads = this.cfg.threads || navigator.hardwareConcurrency;
    const files = {};
    this.asr = await T.pipeline('automatic-speech-recognition', this.cfg.model, {
      device: this.cfg.device || 'wasm',
      dtype: this.cfg.dtype,
      progress_callback: (p) => { if (p.status === 'done' || p.status === 'progress') files[p.file] = p.total || files[p.file] || 0; },
    });
    return { files };
  }
  async transcribe(pcm) {
    const out = await this.asr(pcm, { return_timestamps: 'word' });
    return (out.chunks || []).map((c) => ({ w: c.text.trim(), s: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] }));
  }
  async dispose() { await this.asr?.dispose(); this.asr = null; }
}

class ShoutWhisper {
  kind = 'chunked';
  constructor(cfg) { this.cfg = cfg; }
  async load() {
    const { bytes, fromCache } = await cachedBytes(this.cfg.modelUrl);
    const file = new File([bytes], this.cfg.modelUrl.split('/').pop());
    this.tr = new FileTranscriber({ createModule: createShout, model: file, dtwType: this.cfg.dtw || '', print: () => {}, printErr: () => {} });
    await this.tr.init();
    return { files: { [this.cfg.modelUrl]: bytes.length }, fromCache };
  }
  async transcribe(pcm) {
    const threads = this.cfg.threads || navigator.hardwareConcurrency;
    const res = await new Promise((resolve) => {
      this.tr._resolveComplete = resolve;
      this.tr.Module.transcribe(pcm, 'en', threads, false, 0, false, false, true);
    });
    this.rawSample ??= JSON.stringify(res.transcription?.[0]?.tokens?.slice(0, 4) ?? res).slice(0, 2000);
    // Tokens to words: a token whose text starts with a space begins a new word.
    const words = [];
    for (const seg of res.transcription || []) {
      for (const tok of seg.tokens || []) {
        if (/^\s*\[_?[A-Z_]+/.test(tok.text) || /^\s*<\|/.test(tok.text)) continue; // special tokens
        const s = (tok.offsets?.from ?? 0) / 1000;
        const e = (tok.offsets?.to ?? 0) / 1000;
        const dtw = tok.dtw ? tok.dtw.offset / 100 : null; // whisper.cpp t_dtw is in 10 ms units
        if (/^\s/.test(tok.text) || !words.length) words.push({ w: tok.text.trim(), s, e, dtw });
        else { const w = words[words.length - 1]; w.w += tok.text; w.e = e; }
      }
    }
    return words.filter((w) => w.w);
  }
  async dispose() { try { this.tr?.destroy(); } catch {} this.tr = null; }
}

class VoskStream {
  kind = 'stream';
  constructor(cfg) { this.cfg = cfg; }
  async load() {
    this.model = await window.Vosk.createModel(this.cfg.modelUrl);
    this.rec = new this.model.KaldiRecognizer(SR);
    this.rec.setWords(true);
    return { files: {} };
  }
  attach(onEvent) {
    this.rec.on('result', (m) => {
      const words = (m.result.result || []).map((r) => ({ w: r.word, s: r.start, e: r.end, p: r.conf }));
      onEvent({ kind: 'final', words, text: m.result.text });
    });
    this.rec.on('partialresult', (m) => { if (m.result.partial) onEvent({ kind: 'partial', text: m.result.partial }); });
  }
  feed(frame) { this.rec.acceptWaveformFloat(frame.slice(), SR); }
  flush() { this.rec.retrieveFinalResult(); }
  // Short one-off transcription for warm-up / offline checks, using a fresh recognizer. Vosk
  // answers asynchronously from its worker, so wait until results stop arriving.
  async transcribe(pcm) {
    const rec = new this.model.KaldiRecognizer(SR);
    rec.setWords(true);
    const words = [];
    let last = performance.now();
    rec.on('result', (m) => { last = performance.now(); for (const r of m.result.result || []) words.push({ w: r.word, s: r.start, e: r.end }); });
    for (let i = 0; i < pcm.length; i += FRAME) rec.acceptWaveformFloat(pcm.slice(i, i + FRAME), SR);
    rec.retrieveFinalResult();
    const t0 = performance.now();
    while (performance.now() - last < 800 || (!words.length && performance.now() - t0 < 20000)) await sleep(50);
    rec.remove();
    return words;
  }
  async dispose() { try { this.model?.terminate(); } catch {} this.model = null; }
}

const ENGINES = { tfjs: TfjsWhisper, shout: ShoutWhisper, vosk: VoskStream };

// ---------------------------------------------------------------------------------------------
// Live segmentation for chunked engines: energy VAD cuts at narration pauses, finals are
// committed per segment, and the open segment is re-transcribed for interim text when the
// engine is idle. Finals always win over interims, so a slow engine shows less interim text
// rather than falling further behind.

class LiveChunker {
  constructor(engine, pcm, opts, clock, record) {
    Object.assign(this, { engine, pcm, clock, record });
    this.o = { vadRms: 0.004, pauseS: 0.6, maxSegS: 20, interimS: 1.5, minInterimS: 1.0, tailS: 0.2, ...opts };
    this.segStart = 0; this.fed = 0; this.lastSpeech = -1; this.lastShortPause = -1; this.silRun = 0;
    this.hasSpeech = false; this.lastInterimWall = 0; this.busyMs = 0;
  }
  push(n) {
    // VAD over 20 ms windows of the newly arrived samples.
    const W = SR / 50;
    for (let i = this.fed; i + W <= this.fed + n; i += W) {
      let acc = 0;
      for (let j = i; j < i + W; j++) acc += this.pcm[j] * this.pcm[j];
      if (Math.sqrt(acc / W) > this.o.vadRms) { this.lastSpeech = i + W; this.hasSpeech = true; this.silRun = 0; }
      else { this.silRun += W; if (this.silRun >= 0.15 * SR && this.hasSpeech) this.lastShortPause = i + W - Math.floor(this.silRun / 2); }
    }
    this.fed += n;
  }
  async run(pcmEnd, kind) {
    const [a, b] = [this.segStart, pcmEnd];
    const t0 = performance.now();
    const words = await this.engine.transcribe(this.pcm.slice(a, b));
    const procMs = performance.now() - t0;
    this.busyMs += procMs;
    const off = a / SR;
    this.record({ kind, segS: off, segE: b / SR, procMs, words: words.map((w) => ({ ...w, s: w.s + off, e: w.e + off, dtw: w.dtw != null ? w.dtw + off : undefined })) });
  }
  async step(final = false) {
    const { o } = this;
    if (!this.hasSpeech) { this.segStart = Math.max(this.segStart, this.fed - Math.floor(o.tailS * SR)); return; }
    const silence = this.fed - this.lastSpeech;
    if (silence >= o.pauseS * SR || final) {
      const end = Math.min(this.fed, this.lastSpeech + Math.floor(o.tailS * SR));
      await this.run(end, 'final');
      this.segStart = end; this.hasSpeech = false; this.lastShortPause = -1; this.lastInterimWall = performance.now();
      return;
    }
    if (this.fed - this.segStart >= o.maxSegS * SR) {
      const cut = this.lastShortPause > this.segStart + SR ? this.lastShortPause : this.fed;
      await this.run(cut, 'final');
      this.segStart = cut; this.lastShortPause = -1;
      this.hasSpeech = this.lastSpeech > cut;
      return;
    }
    if (o.interimS > 0 && performance.now() - this.lastInterimWall >= o.interimS * 1000 && this.fed - this.segStart >= o.minInterimS * SR) {
      this.lastInterimWall = performance.now();
      await this.run(this.fed, 'partial');
    }
  }
}

// ---------------------------------------------------------------------------------------------

async function memorySample() {
  const out = { jsHeap: performance.memory?.usedJSHeapSize ?? null };
  try {
    if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
      const m = await Promise.race([performance.measureUserAgentSpecificMemory(), sleep(25000).then(() => null)]);
      if (m) out.uaBytes = m.bytes;
    }
  } catch (e) { out.err = String(e); }
  return out;
}

const WARM_S = 8;

async function run(cfg) {
  const B = window.BENCH;
  B.status = 'running';
  const result = { cfg, env: { ua: navigator.userAgent, hc: navigator.hardwareConcurrency, dm: navigator.deviceMemory, coi: crossOriginIsolated, webgpu: !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)) } };
  B.result = result;
  const { pcm, ref } = await loadFixture(cfg.fixture);
  result.fixture = { name: cfg.fixture, durationS: pcm.length / SR, words: ref.words.length };
  log(`fixture ${cfg.fixture} ${result.fixture.durationS.toFixed(1)}s`);

  // Cold load (network download + compile) then warm-up inferences.
  let engine = new ENGINES[cfg.engine](cfg);
  let t = performance.now();
  const loadInfo = await engine.load();
  result.load = { coldMs: performance.now() - t, ...loadInfo };
  log(`cold load ${result.load.coldMs.toFixed(0)} ms`);
  const warm = pcm.slice(0, WARM_S * SR);
  window.__warm = warm;
  t = performance.now(); const w1 = await engine.transcribe(warm); result.load.firstInferMs = performance.now() - t;
  t = performance.now(); await engine.transcribe(warm); result.load.secondInferMs = performance.now() - t;
  result.load.warmWords = w1.map((w) => w.w).join(' ');
  result.load.rawSample = engine.rawSample;
  result.load.memAfterLoad = await memorySample();
  log(`first infer ${result.load.firstInferMs.toFixed(0)} ms, second ${result.load.secondInferMs.toFixed(0)} ms`);

  // Cached reload: a fresh engine instance over the same cached files (what a new recording
  // session pays once the model is installed).
  if (cfg.cachedReload !== false) {
    await engine.dispose();
    engine = new ENGINES[cfg.engine](cfg);
    t = performance.now(); await engine.load(); result.load.cachedLoadMs = performance.now() - t;
    t = performance.now(); await engine.transcribe(warm); result.load.cachedFirstInferMs = performance.now() - t;
    log(`cached load ${result.load.cachedLoadMs.toFixed(0)} ms`);
  }

  if (cfg.skipLive) { B.status = 'done'; return result; }

  // Live, wall-clock-paced feed.
  const events = [];
  const mem = [];
  const t0 = performance.now();
  const streamNow = () => ((performance.now() - t0) / 1000) * (cfg.speed || 1);
  const record = (ev) => { ev.at = streamNow(); events.push(ev); };
  let memBusy = false;
  const memTimer = setInterval(async () => {
    if (memBusy) return; memBusy = true;
    const at = streamNow(); const m = await memorySample(); mem.push({ at, ...m }); memBusy = false;
  }, (cfg.memEveryS || 30) * 1000);
  const lag = [];
  let fed = 0;
  const end = Math.min(pcm.length, Math.floor((cfg.limitS || Infinity) * SR));
  // Progress beacon for the runner: a stalled long run then shows where and when it stopped.
  let lastReport = 0;
  const beacon = setInterval(() => {
    B.progress = { fedS: fed / SR, streamS: streamNow(), events: events.length, visibility: document.visibilityState };
    // Inference can block the main thread past any given second, so report by elapsed time.
    if (B.progress.streamS - lastReport >= 60) { lastReport = B.progress.streamS; report({ status: 'running', progress: B.progress }); }
  }, 1000);
  if (cfg.mode === 'batch') {
    // Finalize-after-stop: the whole recording is already captured; segment it with the same
    // VAD and transcribe as fast as the engine allows (no interims). 'at' is wall time here.
    const ch = new LiveChunker(engine, pcm, { ...cfg.live, interimS: 0 }, streamNow, record);
    while (fed < end) { const n = Math.min(FRAME, end - fed); ch.push(n); fed += n; await ch.step(); }
    await ch.step(true);
    result.live = { busyMs: ch.busyMs };
  } else if (engine.kind === 'stream') {
    engine.attach((ev) => { ev.fedS = fed / SR; record(ev); });
    while (fed < end) {
      const target = Math.min(end, Math.floor(streamNow() * SR));
      // Whole frames, plus the short last frame once the recording's end is reached (without
      // it, a fixture that does not end on a frame boundary never leaves this loop).
      while (fed + FRAME <= target || (target === end && fed < end)) { const n = Math.min(FRAME, end - fed); engine.feed(pcm.subarray(fed, fed + n)); fed += n; }
      await sleep(25);
    }
    engine.flush();
    await sleep(3000);
  } else {
    const ch = new LiveChunker(engine, pcm, cfg.live, streamNow, record);
    let lastLagAt = 0;
    while (fed < end) {
      const target = Math.min(end, Math.floor(streamNow() * SR));
      if (target - fed >= FRAME) { const n = Math.floor((target - fed) / FRAME) * FRAME; ch.push(n); fed += n; }
      else if (target === end && fed < end) { ch.push(end - fed); fed = end; }
      const before = performance.now();
      await ch.step();
      if (performance.now() - before < 5) await sleep(20);
      const now = streamNow();
      if (now - lastLagAt >= 5) { lag.push({ at: now, backlogS: now - ch.segStart / SR, openSegS: (fed - ch.segStart) / SR }); lastLagAt = now; }
    }
    await ch.step(true);
    result.live = { busyMs: ch.busyMs };
  }
  clearInterval(memTimer); clearInterval(beacon);
  mem.push({ at: streamNow(), ...(await memorySample()) });
  result.live = { ...(result.live || {}), wallS: (performance.now() - t0) / 1000, fedS: fed / SR, events, mem, lag };
  log(`live done: ${events.filter((e) => e.kind === 'final').length} finals, ${events.filter((e) => e.kind === 'partial').length} partials`);
  window.__engine = engine;
  B.status = 'done';
  await report({ status: 'done', result });
  return result;
}

// Push progress and the result to the runner (intercepted POST), so a long run that stalls
// shows where it stopped, and the result does not depend on one large evaluate() reply.
async function report(body) {
  try { await fetch('/__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {}
}

// Offline check: the runner switches the browser context offline, then this builds a fresh
// engine from the cached files only and transcribes the warm-up clip.
async function offlineCheck(cfg) {
  const out = { online: navigator.onLine };
  try {
    await window.__engine?.dispose();
    const engine = new ENGINES[cfg.engine](cfg);
    let t = performance.now(); await engine.load(); out.loadMs = performance.now() - t;
    t = performance.now(); const words = await engine.transcribe(window.__warm); out.inferMs = performance.now() - t;
    out.words = words.map((w) => w.w).join(' ');
    out.ok = words.length > 0;
    await engine.dispose();
  } catch (e) { out.ok = false; out.error = String(e?.stack || e); }
  return out;
}

window.BENCH = { status: 'idle', run: (cfg) => run(cfg).catch((e) => { window.BENCH.status = 'error'; window.BENCH.error = String(e?.stack || e); report({ status: 'error', error: window.BENCH.error }); throw e; }), offlineCheck };
log('harness ready');
