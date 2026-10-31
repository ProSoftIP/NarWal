// End-to-end checks for the NarWal recorder extension (boards #16542, #16552).
// Loads app/ (built with --test) into Playwright's Chromium with a fake
// microphone, drives the local fixture site, and reopens each recording from
// its saved chunks in the extension's own recordings page.
// Usage: node test/e2e/run.mjs [scenario ...]   (default: all but transcript
// and transcriptParakeet, which download the speech models; they need
// ffmpeg). HEADED=1 to watch. NARWAL_MODEL_MIRROR=<dir> serves model files
// from <dir>/<modelId>/<path> when present there (the store still checks
// every size and SHA-256). NARWAL_BUNDLE=<file.narwal.zip> with scenario
// realPopupBundle checks a bundle recorded by hand with a real sign-in popup
// (board #16790); it runs only when named.
// Writes test/e2e/results/<date>.json and prints one line per check.
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './server.mjs';
import { LIMITS, garbageIsBounded, inspectRecorder, liveLevelsOff, liveMemory, mappings, ownMB, trend } from './memory.mjs';
import { openZip } from '../../../library/src/zip.ts';
import { DERIVED_PATHS, buildAgentView, memorySource, validateBundle } from '../../../bundle/src/index.ts';
import { bundleRecordingId } from '../../src/export/bundle.js';
import { toRecorderStatus } from '../../src/shared/ui-status.js';
import { stripModel } from '../../../recorder-ui/src/strip-model.js';
import { MODEL_CACHE_NAME } from '../../../offline-transcription/src/model-store.ts';
import { MODELS, storageKey } from '../../../offline-transcription/src/models.ts';

const APP = fileURLToPath(new URL('../../app', import.meta.url));
const MIRROR = process.env.NARWAL_MODEL_MIRROR || '';
const RESULTS = fileURLToPath(new URL('./results', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ userDataDir = null, fakeUi = true, args = [], app = APP } = {}) {
  const dir = userDataDir || (await mkdtemp(join(tmpdir(), 'narwal-e2e-')));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${app}`,
      `--load-extension=${app}`,
      '--use-fake-device-for-media-stream',
      ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : ['--deny-permission-prompts']),
      ...args,
    ],
    // Playwright disables the back/forward cache by default; real browsers do not.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  if (MIRROR) {
    for (const manifest of Object.values(MODELS)) {
      for (const file of manifest.files) {
        const path = join(MIRROR, manifest.id, file.path);
        if (!existsSync(path)) continue;
        await context.route(file.url, (route) => route.fulfill({ path, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }));
      }
    }
  }
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = new URL(sw.url()).host;
  const b = {
    context,
    dir,
    extensionId,
    url: (path) => `chrome-extension://${extensionId}/${path}`,
    // The worker may have been stopped: an extension page message wakes it.
    async worker() {
      const live = context.serviceWorkers().filter((w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
      if (live.length) return live[live.length - 1];
      const waiting = context.waitForEvent('serviceworker', { timeout: 10000 });
      await b.viewer.evaluate(() => chrome.runtime.sendMessage({ to: 'sw', cmd: 'status' })).catch(() => {});
      return waiting;
    },
    async sw(fn, arg) {
      return (await b.worker()).evaluate(fn, arg);
    },
    async close({ keepProfile = false } = {}) {
      await context.close();
      if (!keepProfile) await rm(dir, { recursive: true, force: true });
    },
  };
  // The saved-recordings page: reopens recordings from IndexedDB.
  b.viewer = await context.newPage();
  await b.viewer.goto(b.url('recordings.html'));
  return b;
}

async function tabIdOf(b, page) {
  const url = page.url();
  return b.sw((u) => chrome.tabs.query({}).then((tabs) => (tabs.find((t) => t.url === u) || {}).id ?? null), url);
}

async function startRec(b, page) {
  await page.bringToFront();
  const tabId = await tabIdOf(b, page);
  const reply = await b.sw((id) => globalThis.narwal.start(id), tabId);
  if (!reply || !reply.ok) throw new Error(`start failed: ${JSON.stringify(reply)}`);
  return reply;
}

// Sends a runtime message from the extension's content script in `page`
// (its isolated world, through CDP), as a content script would.
async function contentScriptSend(page, msg) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    const world = contexts.find((ctx) => ctx.auxData && ctx.auxData.type === 'isolated' && ctx.origin.startsWith('chrome-extension://'));
    if (!world) throw new Error('no content script world in the page');
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage(${JSON.stringify(msg)})`,
      contextId: world.id,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text);
    return result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// The strip's message line as the page shows it. The strip's shadow root is
// closed, so it is read through CDP, which goes into closed shadow roots.
async function stripMessage(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const isMessage = (n) => (n.attributes || []).some((v, i, a) => i % 2 === 0 && v === 'class' && a[i + 1] === 'message-text');
    const find = (n) => {
      if (isMessage(n)) return n;
      for (const child of [...(n.shadowRoots || []), ...(n.children || [])]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    return node ? (node.children || []).map((t) => t.nodeValue || '').join('') : null;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Presses one of the strip's buttons (by class) with a real mouse click. The
// strip's shadow root is closed, so the button is found through CDP. False
// when the strip shows no such button.
async function pressStripButton(page, cls) {
  const cdp = await page.context().newCDPSession(page);
  let box = null;
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const hasClass = (n) => (n.attributes || []).some((v, i, a) => i % 2 === 0 && v === 'class' && a[i + 1].split(' ').includes(cls));
    const find = (n) => {
      if (n.nodeName === 'BUTTON' && hasClass(n)) return n;
      for (const child of [...(n.shadowRoots || []), ...(n.children || [])]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    if (node) box = (await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId })).model.border;
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (!box || box[4] - box[0] <= 0) return false;
  await page.mouse.click((box[0] + box[4]) / 2, (box[1] + box[5]) / 2);
  return true;
}

// Each new message the strip shows until one matches `until` (board #16598).
async function stripUntil(page, until, timeoutMs = 30000) {
  const seen = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const text = await stripMessage(page).catch(() => null);
    if (text !== null && text !== seen.at(-1)) seen.push(text);
    if (text && until.test(text)) break;
    await sleep(150);
  }
  return seen;
}

const stopRec = (b) => b.sw(() => globalThis.narwal.stop());
const status = (b) => b.viewer.evaluate(() => chrome.runtime.sendMessage({ to: 'sw', cmd: 'status' }));
const mark = (page, label) => page.evaluate((l) => window.narwalFixture.mark(l), label);

// Reopen a recording from its saved chunks, the way the recordings page does,
// and reduce it to JSON the checks can read.
async function reopen(b, id, { needles = [], replay = false } = {}) {
  return b.viewer.evaluate(
    async ([recId, words, doReplay]) => {
      const rec = await globalThis.narwalViewer.load(recId);
      if (!rec) return null;
      const rr = rec.entries.filter((e) => e.k === 'rr');
      const text = JSON.stringify(rr.map((e) => e.e));
      const found = Object.fromEntries(words.map((w) => [w, text.includes(w)]));
      const audio = [];
      for (const s of rec.audio) {
        let decodedMs = null;
        try {
          const ctx = new OfflineAudioContext(1, 1, 48000);
          const buf = await ctx.decodeAudioData(await new Blob(s.chunks.map((c) => c.data), { type: s.mime }).arrayBuffer());
          decodedMs = Math.round(buf.duration * 1000);
        } catch (err) {
          decodedMs = `error: ${err.message}`;
        }
        audio.push({ segment: s.segment, chunks: s.chunks.length, bytes: s.bytes, spanMs: Math.round(s.endAt - s.startAt), decodedMs });
      }
      let replayed = null;
      if (doReplay) {
        const top = rec.documents.find((d) => d.isTop && d.firstSnapshotAt);
        const events = top ? globalThis.narwalViewer.replay(rec, top.documentId || top.doc) : 0;
        await new Promise((r) => setTimeout(r, 300));
        const frame = document.querySelector('#replay iframe');
        replayed = { events, iframe: Boolean(frame), bodyText: frame && frame.contentDocument && frame.contentDocument.body ? frame.contentDocument.body.textContent.slice(0, 200) : null };
      }
      return {
        meta: { status: rec.meta.status, stopReason: rec.meta.stopReason, restarts: rec.meta.restarts || 0, storageError: rec.meta.storageError ? { quota: rec.meta.storageError.quota } : null, interruption: rec.meta.interruption || null },
        eventChunks: rec.eventChunks.length,
        audioChunks: rec.audioChunks.length,
        documents: rec.documents.map((d) => ({ documentId: d.documentId, url: d.url, isTop: d.isTop, navType: d.navType, attachments: d.attachments.map((a) => a.reason), rrEvents: d.rrEvents, snapshot: d.firstSnapshotAt !== null })),
        topCommits: rec.navigations.filter((n) => n.type === 'committed' && n.frameId === 0).map((n) => ({ documentId: n.documentId, url: n.url, transition: n.transitionType })),
        historyUpdates: rec.navigations.filter((n) => n.type === 'historyStateUpdated' || n.type === 'referenceFragmentUpdated').length,
        routes: rec.entries.filter((e) => e.k === 'page' && e.type === 'route').map((e) => e.url),
        gaps: rec.gaps.map((g) => ({ scope: g.scope, reason: g.reason, detail: g.detail, source: g.source, ms: g.to == null ? null : Math.round(g.to - g.from) })),
        audio,
        refusedPorts: rec.refusedPorts,
        consumerErrors: rec.consumerErrors,
        attachUrls: rec.entries.filter((e) => e.k === 'attach').map((e) => e.url),
        // Around each lost-messages gap: what the document sent, for diagnosis.
        lostContext: rec.gaps
          .filter((g) => g.reason === 'lost-messages')
          .map((g) => {
            const ports = new Set(rec.entries.filter((e) => e.k === 'attach' && (e.documentId || e.doc) === g.documentId).map((e) => e.doc));
            return rec.entries
              .filter((e) => (ports.has(e.doc) || e.k === 'nav') && e.t >= g.from - 1500 && e.t <= g.to + 500)
              .map((e) => ({ k: e.k, type: e.type || (e.e && e.e.type), seq: e.seq, reason: e.reason, dt: Math.round(e.t - g.from), url: e.url, persisted: e.persisted }));
          }),
        found,
        replayed,
      };
    },
    [id, needles, replay],
  );
}


// The offscreen document's status with the transcript fields (board #16570),
// as the service worker asks for it.
const offscreenStatus = (b, cursor) => b.viewer.evaluate((c) => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'status', transcriptCursor: c }), cursor);

// Polls the transcript seam like the strip does until `until(state, events)`.
async function watchTranscript(b, until, timeoutMs) {
  const seen = { states: [], events: [], cursor: undefined };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await offscreenStatus(b, seen.cursor);
    if (s && s.transcript) {
      if (seen.states.at(-1)?.state !== s.transcript.state) seen.states.push(s.transcript);
      seen.events.push(...s.transcriptEvents);
      if (!seen.firstFinalAt && finals(seen.events).length) seen.firstFinalAt = Date.now();
      seen.cursor = s.transcriptCursor;
      seen.last = s.transcript;
      if (until(s.transcript, seen.events)) return { ...seen, done: true };
    }
    await sleep(250);
  }
  return { ...seen, done: false };
}

const finals = (events) => events.filter((e) => e.type === 'segment' && e.segment.kind === 'final' && e.segment.text);

// The saved transcript history of one recording, read from IndexedDB.
const savedTranscript = (b, id) =>
  b.viewer.evaluate(async (recId) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('narwal');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const get = (store, query) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store)[query ? 'getAll' : 'get'](query || recId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const meta = await get('recordings');
    const [record] = await get('chunks', IDBKeyRange.only([recId, 'history', 0]));
    const history = record ? record.history : { activeRevision: null, revisions: [] };
    const entries = await get('chunks', IDBKeyRange.bound([recId, 'transcript'], [recId, 'transcript', []]));
    db.close();
    return {
      activeRevision: history.activeRevision,
      transcription: meta.transcription,
      entries: entries.length,
      revisions: history.revisions.map((r) => ({ revisionId: r.revisionId, source: r.source, provider: r.provider, model: r.model, timing: r.timing, supersedes: r.supersedes, text: r.segments.map((x) => x.text).join(' '), gaps: r.gaps.map((g) => g.detail || g.reason) })),
    };
  }, id);

// The strip's microphone meter (board #16785), read through CDP like the
// message: null when the strip has no meter.
async function stripMeter(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const attrs = (n) => Object.fromEntries((n.attributes || []).flatMap((v, i, a) => (i % 2 === 0 ? [[v, a[i + 1]]] : [])));
    const find = (n) => {
      if (attrs(n).class === 'meter') return n;
      for (const child of [...(n.shadowRoots || []), ...(n.children || [])]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    if (!node) return null;
    const a = attrs(node);
    return { shown: !('hidden' in a), level: Number(a['data-level'] || 0), heard: a['data-heard'] === 'true' };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// A silent microphone for Chromium's fake capture: 20 s of 48 kHz mono zeros.
async function silentWav(dir) {
  const rate = 48000;
  const bytes = rate * 20 * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  const path = join(dir, 'silence.wav');
  await writeFile(path, wav);
  return path;
}

// The Options page's microphone panel (board #16785): what it shows.
const micPanel = (page, root = '.nw-options .nw-mic') =>
  page.$eval(root, (el) => {
    const select = el.querySelector('select');
    const meter = el.querySelector('.nw-meter');
    const status = el.querySelector('.nw-mic-status');
    const problem = el.querySelector('.nw-mic-problem');
    return {
      access: el.dataset.access,
      testing: el.dataset.testing === 'true',
      shown: !el.hidden,
      rowShown: !el.querySelector('.nw-mic-row').hidden,
      options: select ? [...select.options].map((o) => ({ value: o.value, label: o.textContent })) : [],
      value: select ? select.value : null,
      level: meter ? Number(meter.dataset.level) : 0,
      heard: meter ? meter.dataset.heard === 'true' : false,
      status: status && !status.hidden ? status.textContent : '',
      problem: problem && !problem.hidden ? problem.textContent : '',
      test: (el.querySelector('[data-key="mic-test"]') || {}).textContent || '',
    };
  });

async function micPanelUntil(page, until, timeoutMs = 8000, root) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await micPanel(page, root).catch(() => null);
    if (last && until(last)) return last;
    await sleep(100);
  }
  return last;
}

async function openOptions(b) {
  const page = await b.context.newPage();
  await page.goto(b.url('options.html'));
  await page.waitForFunction(() => globalThis.narwalOptions && globalThis.narwalOptions.microphone);
  await page.evaluate(() => globalThis.narwalOptions.microphone.loaded);
  return page;
}

const savedMicrophone = (b) => b.viewer.evaluate(() => chrome.storage.local.get('narwal.prefs.v1').then((r) => (r['narwal.prefs.v1'] || {}).microphone ?? null));
const audioEntries = (b, id) => b.viewer.evaluate(async (recId) => (await globalThis.narwalViewer.load(recId)).entries.filter((e) => e.k === 'audio').map((e) => ({ type: e.type, label: e.label, deviceId: e.settings && e.settings.deviceId })), id);

// Speech for the fake microphone: the offline-transcription fixture as WAV.
const SPEECH = fileURLToPath(new URL('../../../offline-transcription/fixtures/speech-en-31s', import.meta.url));
async function speechWav(dir) {
  const wav = join(dir, 'speech.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', `${SPEECH}.flac`, '-ac', '1', '-ar', '48000', wav]);
  const words = JSON.parse(await readFile(`${SPEECH}.json`, 'utf8')).words.map((w) => w.w.toLowerCase());
  return { wav, words: new Set(words) };
}
// Whisper writes punctuation and capitals; Vosk writes neither.
const known = (text, words) => text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, '').split(/\s+/).filter((w) => words.has(w)).length;

// The final pass after Stop on this computer (board #16603): waits until the
// job is no longer running and returns its last state.
async function afterJobEnd(b, id, ms) {
  const until = Date.now() + ms;
  let state = null;
  while (Date.now() < until) {
    const reply = await b.viewer.evaluate((recId) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcript-state', id: recId }), id);
    state = reply && reply.afterTranscript;
    if (state && state.state !== 'improving') return state;
    await sleep(500);
  }
  return state;
}

// --- 30-minute soak helpers (board #16552) ---

// The ID Chrome gives an unpacked extension: SHA-256 of the manifest `key`
// (DER public key) or, with no key, of the folder path; first 32 hex digits
// written with the letters a-p.
const extensionIdOf = (bytes) =>
  [...createHash('sha256').update(bytes).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
async function keyIdOf(app) {
  const { key } = JSON.parse(await readFile(join(app, 'manifest.json'), 'utf8'));
  return key ? extensionIdOf(Buffer.from(key, 'base64')) : null;
}

// A copy of app/ as a user's install folder, with manifest changes.
async function installCopy(dir, change = (m) => m) {
  await cp(APP, dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  await writeFile(file, `${JSON.stringify(change(JSON.parse(await readFile(file, 'utf8'))), null, 2)}\n`);
  return dir;
}

// Memory (PSS) and CPU time of the browser's whole process tree, from /proc.
// Linux only; each process is classed by its --type flag. `recorder` is the
// extension's processes by kind of mapping (#16591).
async function processTree(profileDir) {
  const procs = new Map();
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), { pid: Number(name), ppid: Number(f[1]), cpuTicks: Number(f[11]) + Number(f[12]) });
    } catch {}
  }
  let root = null;
  for (const p of procs.values()) {
    const cmd = await readFile(`/proc/${p.pid}/cmdline`, 'utf8').catch(() => '');
    // Chrome rewrites its process title: arguments may be joined by spaces.
    const words = cmd.split(/[\0 ]/);
    if (words.includes(`--user-data-dir=${profileDir}`) && !words.some((w) => w.startsWith('--type='))) root = p.pid;
  }
  if (root === null) return null;
  const tree = [];
  const walk = (pid) => {
    tree.push(procs.get(pid));
    for (const p of procs.values()) if (p.ppid === pid) walk(p.pid);
  };
  walk(root);
  const out = { processes: 0, pssMB: 0, cpuS: 0, byType: {}, recorder: {} };
  for (const p of tree) {
    const cmd = await readFile(`/proc/${p.pid}/cmdline`, 'utf8').catch(() => '');
    const rollup = await readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8').catch(() => '');
    const pssMB = Number((rollup.match(/^Pss:\s+(\d+)/m) || [0, 0])[1]) / 1024;
    const type = (cmd.match(/--type=([a-z-]+)/) || [0, 'browser'])[1] + (cmd.includes('--extension-process') ? ':extension' : '');
    out.processes += 1;
    out.pssMB += pssMB;
    out.cpuS += p.cpuTicks / 100;
    out.byType[type] = Math.round((out.byType[type] || 0) + pssMB);
    if (type.endsWith(':extension')) {
      for (const [kind, mb] of Object.entries(await mappings(p.pid))) out.recorder[kind] = Math.round(((out.recorder[kind] || 0) + mb) * 10) / 10;
    }
  }
  out.pssMB = Math.round(out.pssMB);
  out.cpuS = Math.round(out.cpuS);
  return out;
}

// What the extension origin uses on disk, as the browser counts it.
const storageUse = (b) =>
  b.viewer.evaluate(async () => {
    const e = await navigator.storage.estimate();
    const mb = (n) => Math.round(((n || 0) / 1048576) * 10) / 10;
    return { usageMB: mb(e.usage), indexedDbMB: mb(e.usageDetails && e.usageDetails.indexedDB), cachesMB: mb(e.usageDetails && e.usageDetails.caches) };
  });

// Waits until a needle is in a saved events chunk at or after `fromSeq`.
// Returns the newest saved seq, so the next wait reads only new chunks.
const savedNeedle = (b, id, fromSeq, needle) =>
  b.viewer.evaluate(
    async ([recId, from, n]) => {
      globalThis.soakDb ||= await new Promise((resolve, reject) => {
        const req = indexedDB.open('narwal');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const chunks = await new Promise((resolve, reject) => {
        const req = globalThis.soakDb.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([recId, 'events', from], [recId, 'events', Infinity]));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const hit = chunks.find((c) => JSON.stringify(c.entries).includes(n));
      return { found: Boolean(hit), seq: hit ? hit.seq : chunks.length ? chunks[chunks.length - 1].seq : from };
    },
    [id, fromSeq, needle],
  );

// Content script to recorder, per minute: receive time minus send time (both
// performance.timeOrigin + performance.now(), each in its own process). Its
// median is the latency, its trend the clock drift between the two.
const clockByMinute = (b, id) =>
  b.viewer.evaluate(async (recId) => {
    const rec = await globalThis.narwalViewer.load(recId);
    const start = rec.meta.startedAt;
    const minutes = [];
    for (const c of rec.eventChunks) {
      for (const e of c.entries) {
        if (e.k !== 'rr' || typeof e.sent !== 'number') continue;
        const m = Math.floor((e.t - start) / 60000);
        (minutes[m] ||= []).push(e.t - e.sent);
      }
    }
    const pct = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
    const bytes = { events: rec.eventChunks.reduce((n, c) => n + (c.bytes || 0), 0), audio: rec.audioChunks.reduce((n, c) => n + (c.bytes || 0), 0) };
    return {
      bytes,
      minutes: minutes.map((xs, m) => {
        if (!xs) return { minute: m, events: 0 };
        xs.sort((x, y) => x - y);
        return { minute: m, events: xs.length, p50: Math.round(pct(xs, 0.5) * 10) / 10, p95: Math.round(pct(xs, 0.95) * 10) / 10, max: Math.round(xs[xs.length - 1] * 10) / 10 };
      }),
    };
  }, id);

const quantiles = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1]) };
};

// A downloaded .narwal.zip as an agent reads it: unzipped with the library's
// bounded reader, validated and turned into the agent view by @narwal/bundle.
async function readBundle(path) {
  const bytes = new Uint8Array(await readFile(path));
  const zip = openZip(bytes);
  const files = new Map();
  for (const e of zip.entries) files.set(e.path, await zip.read(e.path));
  const result = await validateBundle(memorySource(files));
  const dec = new TextDecoder();
  const text = (p) => (files.has(p) ? dec.decode(files.get(p)) : null);
  const lines = (p) => (text(p) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { bytes: bytes.length, files, text, lines, result, view: result.bundle ? buildAgentView(result.bundle) : null };
}

// The purpose the e2e answers when Export asks for one (board #17002).
const E2E_PURPOSE = 'e2e check: each mark is something to look at';

/**
 * Waits until the recordings page either asks for the purpose (board #17002)
 * or starts the export, and answers the question when asked. True when it was asked.
 */
async function answerPurposeIfAsked(page, text = E2E_PURPOSE) {
  await page.waitForFunction(() => document.getElementById('purpose-ask')?.open || /^(Exporting|Saved|Could not|The transcript is still)/.test(document.getElementById('export-status')?.textContent || ''), null, { timeout: 60000 });
  if (!(await page.evaluate(() => document.getElementById('purpose-ask').open))) return false;
  await page.fill('#purpose-ask-text', text);
  await page.click('#purpose-ask-ok');
  return true;
}

// Clicks Export bundle on one row of the recordings page and keeps the download.
async function exportFromList(listPage, rowText, path) {
  const row = listPage.locator('#list tbody tr', { hasText: rowText });
  await row.first().waitFor();
  const rows = await row.count();
  const started = Date.now();
  const [download] = await Promise.all([
    listPage.waitForEvent('download', { timeout: 300000 }),
    row.getByRole('button', { name: 'Export bundle' }).click().then(() => answerPurposeIfAsked(listPage)),
  ]);
  await download.saveAs(path);
  return { rows, fileName: download.suggestedFilename(), ms: Date.now() - started };
}

class Checks {
  constructor(name) {
    this.name = name;
    this.list = [];
  }
  ok(label, cond, got) {
    this.list.push({ label, pass: Boolean(cond), got });
  }
}

const SECRETS = ['typed-before-start', 'typed-while-recording', 'prefilled-secret-value', 'editable-secret-text', 'pw-secret', 'form-typed-value', 'narwal-ui-must-not-be-captured'];

const scenarios = {
  // Record, navigate every supported way, stop, reopen and replay.
  async journey(fx) {
    const c = new Checks('journey');
    const b = await launch();
    try {
      const other = await b.context.newPage();
      await other.goto(`${fx.A}/page2.html?other=1`);
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      await page.fill('#secret', 'typed-before-start');
      const rec = await startRec(b, page);
      await sleep(800);
      await page.fill('#secret', 'typed-while-recording');
      await page.fill('#pw', 'pw-secret');
      await mark(page, 'index-1');
      // The other tab loads a new document while recording: it must be refused.
      await other.reload();
      await page.bringToFront();
      await sleep(2500);
      const midway = await reopen(b, rec.id);
      c.ok('chunks are saved while recording, before Stop', midway.eventChunks >= 2 && midway.audioChunks >= 2, { eventChunks: midway.eventChunks, audioChunks: midway.audioChunks });

      await Promise.all([page.waitForURL(`${fx.A}/page2.html`), page.click('#to-page2')]);
      await mark(page, 'page2-1');
      await sleep(300);
      await page.goBack({ waitUntil: 'commit' });
      await sleep(600);
      await mark(page, 'after-back');
      await page.goForward({ waitUntil: 'commit' });
      await sleep(600);
      await mark(page, 'after-forward');
      await page.reload();
      await mark(page, 'after-reload');
      await page.goto(`${fx.B}/page2.html`);
      await mark(page, 'cross-origin-1');
      await page.goto(`${fx.A}/form.html`);
      await page.fill('#name', 'form-typed-value');
      await Promise.all([page.waitForURL(`${fx.A}/result.html`), page.click('#submit')]);
      await mark(page, 'after-post-redirect');
      await page.goto(`${fx.A}/spa.html`);
      await page.click('#route-1');
      await mark(page, 'spa-route-1');
      await page.click('#route-2');
      await mark(page, 'spa-route-2');
      await page.click('#hash');
      await page.goBack({ waitUntil: 'commit' });
      await sleep(300);
      await mark(page, 'spa-popstate');
      await sleep(1200);
      const stopped = await stopRec(b);
      c.ok('stop succeeds', stopped.ok && stopped.stopReason === 'user', stopped);

      const labels = ['index-1', 'page2-1', 'after-back', 'after-forward', 'after-reload', 'cross-origin-1', 'after-post-redirect', 'spa-route-1', 'spa-route-2', 'spa-popstate'];
      const r = await reopen(b, rec.id, { needles: [...labels.map((l) => `marker:${l}`), ...SECRETS], replay: true });
      c.ok('reopened recording is stopped', r.meta.status === 'stopped', r.meta);
      for (const l of labels) c.ok(`marker ${l} captured`, r.found[`marker:${l}`]);
      for (const s of SECRETS) c.ok(`"${s}" is not in the recording`, !r.found[s]);
      const tops = r.documents.filter((d) => d.isTop);
      const committed = [...new Set(r.topCommits.map((n) => n.documentId))];
      c.ok('every committed top document has an attached recorder with a full snapshot', committed.every((id) => tops.some((d) => d.documentId === id && d.snapshot)), { committed: committed.length, tops: tops.length });
      c.ok('documents keep browser identity: one entry per documentId', new Set(tops.map((d) => d.documentId)).size === tops.length, tops.length);
      const restored = tops.filter((d) => d.attachments.includes('bfcache-restore'));
      c.ok('back/forward re-attaches the same document (bfcache-restore)', restored.length >= 1, tops.map((d) => [d.url, d.attachments]));
      c.ok('SPA routes are recorded (pushState, hash, popstate)', r.routes.length >= 4 && r.historyUpdates >= 3, { routes: r.routes, historyUpdates: r.historyUpdates });
      c.ok('the other tab is refused and never attached', r.refusedPorts >= 1 && !r.attachUrls.some((u) => u.includes('other=1')), { refused: r.refusedPorts });
      c.ok('no gaps on a clean run', r.gaps.length === 0, { gaps: r.gaps, lostContext: r.lostContext });
      const a = r.audio[0] || {};
      c.ok('microphone audio saved in about 1 s chunks and decodes to its full length', r.audio.length === 1 && a.chunks >= Math.floor(a.spanMs / 1000) - 1 && typeof a.decodedMs === 'number' && Math.abs(a.decodedMs - a.spanMs) < 1500, r.audio);
      c.ok('replay of the first page shows the recorded page', r.replayed && r.replayed.iframe && r.replayed.events > 0, r.replayed);
      return { checks: c.list, summary: { documents: r.documents, topCommits: r.topCommits.length, audio: r.audio, eventChunks: r.eventChunks } };
    } finally {
      await b.close();
    }
  },

  // The service worker is stopped mid-recording; capture continues.
  async workerRestart(fx) {
    const c = new Checks('workerRestart');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(800);
      await mark(page, 'before-stop');
      const cdp = await b.context.newCDPSession(b.viewer);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await sleep(1500);
      await mark(page, 'while-stopped');
      await Promise.all([page.waitForURL(`${fx.A}/page2.html`), page.click('#to-page2')]);
      await mark(page, 'after-nav');
      await sleep(1200);
      const st = await status(b);
      c.ok('recording is still live after the worker restarted', st.live && st.live.id === rec.id && st.recorder && st.recorder.recording, st.live);
      await stopRec(b);
      const r = await reopen(b, rec.id, { needles: ['marker:before-stop', 'marker:while-stopped', 'marker:after-nav'] });
      for (const [k, v] of Object.entries(r.found)) c.ok(`${k} captured`, v);
      c.ok('navigation after the restart was recorded', r.topCommits.some((n) => n.url.endsWith('/page2.html')), r.topCommits);
      c.ok('no gaps', r.gaps.length === 0, r.gaps);
      c.ok('one audio part (the recorder never stopped)', r.audio.length === 1, r.audio);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // The recorder (offscreen document) dies mid-recording and comes back.
  async recorderCrash(fx) {
    const c = new Checks('recorderCrash');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(2000);
      await mark(page, 'before-crash');
      await sleep(1200);
      await b.sw(() => globalThis.narwal.killRecorder());
      await sleep(3000);
      await mark(page, 'after-crash');
      await sleep(1500);
      const st = await status(b);
      c.ok('recorder is back and recording', st.recorder && st.recorder.recording, st.recorder && st.recorder.state);
      await stopRec(b);
      const r = await reopen(b, rec.id, { needles: ['marker:before-crash', 'marker:after-crash'] });
      for (const [k, v] of Object.entries(r.found)) c.ok(`${k} captured`, v);
      c.ok('restart labelled recovery-truncated', r.gaps.some((g) => g.reason === 'recovery-truncated' && g.scope === 'any' && /recorder restarted/.test(g.detail)), r.gaps);
      c.ok('the page re-attached on reconnect', r.documents.some((d) => d.attachments.includes('reconnect')), r.documents.map((d) => d.attachments));
      c.ok('audio continues in a second part', r.audio.length === 2 && r.audio.every((a) => a.chunks >= 1), r.audio);
      c.ok('meta counts the restart', r.meta.restarts === 1, r.meta);
      return { checks: c.list, summary: { gaps: r.gaps } };
    } finally {
      await b.close();
    }
  },

  // The browser exits mid-recording. Reopening keeps everything saved.
  async interruption(fx) {
    const c = new Checks('interruption');
    let b = await launch();
    const dir = b.dir;
    let id;
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      id = (await startRec(b, page)).id;
      await sleep(1500);
      await mark(page, 'before-exit');
      await sleep(2000);
    } finally {
      await b.close({ keepProfile: true });
    }
    b = await launch({ userDataDir: dir });
    try {
      await sleep(500);
      const st = await status(b);
      c.ok('no live recording after the browser restart', !st.live, st.live);
      const r = await reopen(b, id, { needles: ['marker:before-exit'] });
      c.ok('recording reopens as interrupted', r && r.meta.status === 'interrupted', r && r.meta);
      c.ok('chunks saved before the exit are kept', r.eventChunks >= 3 && r.audioChunks >= 2, { eventChunks: r.eventChunks, audioChunks: r.audioChunks });
      c.ok('marker before the exit captured', r.found['marker:before-exit']);
      c.ok('the lost tail is labelled recovery-truncated', r.gaps.some((g) => g.reason === 'recovery-truncated' && g.source === 'analysis'), r.gaps);
      c.ok('saved audio decodes', r.audio.length === 1 && typeof r.audio[0].decodedMs === 'number' && r.audio[0].decodedMs > 1000, r.audio);
      return { checks: c.list, summary: { gaps: r.gaps, meta: r.meta } };
    } finally {
      await b.close();
    }
  },

  // Microphone permission refused: the page is still recorded and the gap is labelled.
  async micDenied(fx) {
    const c = new Checks('micDenied');
    const b = await launch({ fakeUi: false });
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      c.ok('start reports the microphone unavailable', rec.audio && rec.audio.state === 'unavailable', rec.audio);
      await sleep(1000);
      await mark(page, 'no-mic');
      await sleep(1200);
      const popup = await b.context.newPage();
      await popup.goto(b.url('popup.html'));
      await popup.waitForFunction(() => /microphone/.test((document.querySelector('.nw-active:not([hidden]) p') || {}).textContent || ''));
      const text = await popup.textContent('.nw-active p');
      c.ok('popup says the microphone is not recorded', /microphone is not being recorded; the page still is/.test(text), text);
      // Board #16601, #16960: the popup and the recordings page link to the
      // public ProSoft IP site in a new tab (the GitHub repository is private).
      for (const [where, p] of [['popup', popup], ['recordings page', b.viewer]]) {
        const site = await p.$eval('#website', (a) => ({ href: a.href, target: a.target, text: a.textContent, shown: a.offsetParent !== null }));
        c.ok(`${where} links to prosoftip.com in a new tab`, site.href === 'https://prosoftip.com/' && site.target === '_blank' && site.text === 'ProSoft IP' && site.shown, site);
      }
      // Board #16785: the popup's microphone line waits for the microphone;
      // Options says what is wrong in one sentence with the fix.
      const line = await popup.$eval('.nw-mic-compact', (el) => el.hidden);
      c.ok('the popup hides the microphone line while the microphone cannot be used', line === true, line);
      await popup.close();
      const options = await openOptions(b);
      let panel = await micPanel(options);
      if (panel.access === 'prompt') {
        await options.click('.nw-mic-problem [data-key="mic-fix"]');
        panel = await micPanelUntil(options, (p) => p.access === 'denied', 3000);
      }
      c.ok('Options: blocked is one sentence and Open microphone settings', panel.access === 'denied' && /The microphone is blocked for NarWal\./.test(panel.problem) && /Open microphone settings/.test(panel.problem) && !panel.rowShown, panel);
      await options.close();
      await stopRec(b);
      const r = await reopen(b, rec.id, { needles: ['marker:no-mic'] });
      c.ok('page still captured', r.found['marker:no-mic']);
      c.ok('mic-denied audio gap covers the recording', r.gaps.length === 1 && r.gaps[0].reason === 'mic-denied' && r.gaps[0].scope === 'audio' && r.gaps[0].ms > 2000, r.gaps);
      c.ok('no audio chunks', r.audioChunks === 0, r.audioChunks);
      // A restricted page cannot be recorded at all.
      const restricted = await b.context.newPage();
      await restricted.goto('chrome://version/');
      const tabId = await b.sw(() => chrome.tabs.query({ url: 'chrome://version/' }).then((t) => t[0].id));
      const refused = await b.sw((t) => globalThis.narwal.start(t), tabId);
      c.ok('start on chrome:// is refused with a reason', !refused.ok && refused.error === 'not-recordable', refused);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Board #16785: the microphone picker and test bar on the Options page and
  // in the popup, the meter in the strip, and the saved choice used by the
  // recording (or the default one, with a note, when it is gone).
  async microphone(fx) {
    const c = new Checks('microphone');
    const b = await launch();
    try {
      const options = await openOptions(b);
      let panel = await micPanel(options);
      if (panel.access === 'prompt') {
        c.ok('not asked yet: one sentence and Allow microphone', /has not asked to use your microphone yet/.test(panel.problem) && /Allow microphone/.test(panel.problem) && !panel.rowShown, panel);
        await options.click('.nw-mic-problem [data-key="mic-fix"]');
        panel = await micPanelUntil(options, (p) => p.access === 'granted');
      }
      c.ok('the microphone can be used after Allow', panel.access === 'granted' && panel.rowShown, panel);
      const real = panel.options.filter((o) => o.value);
      c.ok('the list names the microphones; the first is the default, by its device', panel.options[0].value === '' && /^Default: \S/.test(panel.options[0].label) && real.length >= 1 && real.every((o) => o.label && o.value !== 'default'), panel.options);
      c.ok('nothing chosen yet: the default is selected', panel.value === '', panel.value);
      const chosen = real[real.length - 1];
      await options.selectOption('.nw-options .nw-mic select', chosen.value);
      let saved = null;
      for (let i = 0; i < 20 && !(saved && saved.id === chosen.value); i += 1) {
        await sleep(100);
        saved = await savedMicrophone(b);
      }
      c.ok('the choice is saved with its name', saved && saved.id === chosen.value && saved.label === chosen.label, saved);
      await options.reload();
      await options.waitForFunction(() => globalThis.narwalOptions && globalThis.narwalOptions.microphone);
      await options.evaluate(() => globalThis.narwalOptions.microphone.loaded);
      panel = await micPanel(options);
      c.ok('the saved choice is shown again after a reload', panel.value === chosen.value, panel.value);

      // Test: the fake microphone beeps, so the meter moves and turns green.
      await options.click('.nw-options [data-key="mic-test"]');
      panel = await micPanelUntil(options, (p) => p.heard);
      c.ok('Test runs the meter on the fake microphone and it hears sound', panel.testing && panel.level > 0 && panel.heard && panel.test === 'Stop test', panel);
      c.ok('the status line says NarWal hears you', panel.status === 'NarWal hears you.', panel.status);
      await options.click('.nw-options [data-key="mic-test"]');
      panel = await micPanelUntil(options, (p) => !p.testing);
      c.ok('Stop test stops the meter', !panel.testing && panel.level === 0 && panel.test === 'Test', panel);

      // No microphone at all: one sentence and Check again.
      const none = await options.evaluate(async () => {
        const p = globalThis.narwalOptions.mountWith({ devices: [], permission: 'granted' });
        p.element.classList.add('nw-e2e-none');
        await p.loaded;
        return true;
      });
      panel = await micPanelUntil(options, (p) => p.access === 'none', 3000, '.nw-e2e-none');
      c.ok('no microphone: one sentence and Check again', none && /No microphone is connected/.test(panel.problem) && /Check again/.test(panel.problem) && !panel.rowShown, panel);

      // The popup's one line shows the saved choice under Start.
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const tabId = await tabIdOf(b, page);
      const popup = await b.context.newPage();
      await popup.goto(b.url(`popup.html?tab=${tabId}`));
      await popup.waitForFunction(() => globalThis.narwalPopup && globalThis.narwalPopup.view.microphone);
      await popup.evaluate(() => globalThis.narwalPopup.view.microphone.loaded);
      const line = await micPanel(popup, '.nw-mic-compact');
      c.ok('the popup shows device, meter and Test on one line with the saved choice', line.shown && line.rowShown && line.value === chosen.value && line.test === 'Test', line);
      const order = await popup.evaluate(() => {
        const go = document.querySelector('.nw-setup > .nw-go');
        const slot = document.querySelector('.nw-setup > .nw-mic-slot');
        return Boolean(go && slot && go.nextElementSibling === slot);
      });
      c.ok('the line sits right under Start', order, order);
      await popup.click('.nw-mic-compact [data-key="mic-test"]');
      const popupTest = await micPanelUntil(popup, (p) => p.heard, 8000, '.nw-mic-compact');
      c.ok('Test in the popup runs the meter', popupTest && popupTest.testing && popupTest.heard, popupTest);
      const footer = await popup.$eval('#options', (a) => ({ href: a.href, target: a.target, text: a.textContent }));
      c.ok('the popup links to Options', footer.href.endsWith('/options.html') && footer.target === '_blank' && footer.text === 'Options', footer);
      // Board #17006: Saved recordings is a secondary button at the top, not in the footer.
      const library = await popup.$eval('#library', (a) => ({ href: a.href, target: a.target, text: a.textContent, head: !!a.closest('.nw-head'), primary: a.classList.contains('nw-primary'), button: a.classList.contains('nw-btn'), footer: !!a.closest('.library') }));
      c.ok('the popup has Saved recordings as a secondary button at the top', library.href.endsWith('/recordings.html') && library.target === '_blank' && library.text === 'Saved recordings' && library.head && library.button && !library.primary && !library.footer, library);
      await popup.close();

      // The recording uses the chosen microphone; the strip shows its meter.
      const rec = await startRec(b, page);
      c.ok('the recording opens the chosen microphone', rec.audio && rec.audio.state !== 'unavailable' && rec.audio.settings && rec.audio.settings.deviceId === chosen.value && !rec.audio.deviceFallback, rec.audio);
      await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
      let meter = null;
      for (let i = 0; i < 40 && !(meter && meter.shown && meter.heard); i += 1) {
        await sleep(150);
        meter = await stripMeter(page);
      }
      c.ok('the strip shows the meter moving while recording', meter && meter.shown && meter.level > 0 && meter.heard, meter);
      const strip = await stripMessage(page);
      c.ok('a microphone that hears sound gets no warning', !/No microphone sound/.test(strip || ''), strip);
      await sleep(1500);
      await stopRec(b);
      const entries = await audioEntries(b, rec.id);
      const device = entries.find((e) => e.type === 'device');
      c.ok('the saved recording names the chosen microphone', device && device.deviceId === chosen.value && device.label === chosen.label, device);

      // The chosen microphone is gone: Options says so, the recording uses the default.
      await b.viewer.evaluate(() =>
        chrome.storage.local.get('narwal.prefs.v1').then((r) => chrome.storage.local.set({ 'narwal.prefs.v1': { ...(r['narwal.prefs.v1'] || {}), microphone: { id: 'gone-device', label: 'Blue Yeti' } } })),
      );
      await options.reload();
      await options.waitForFunction(() => globalThis.narwalOptions && globalThis.narwalOptions.microphone);
      await options.evaluate(() => globalThis.narwalOptions.microphone.loaded);
      panel = await micPanel(options);
      c.ok('a gone microphone is named with a note and the default is selected', panel.value === '' && /^Blue Yeti is not connected\. NarWal records with the default microphone until it is back\.$/.test(panel.status), panel);
      const fallback = await startRec(b, page);
      c.ok('the recording falls back to the default microphone', fallback.audio && fallback.audio.state !== 'unavailable' && fallback.audio.deviceFallback === true, fallback.audio);
      let ui = null;
      for (let i = 0; i < 20 && !(ui && ui.live); i += 1) {
        await sleep(150);
        ui = await b.viewer.evaluate((t) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'ui-status', tabId: t }), tabId);
      }
      const shown = toRecorderStatus(ui, { tabId });
      c.ok('the strip is told the default microphone is in use', shown.micFallback === true, { micFallback: shown.micFallback });
      await sleep(1500);
      await stopRec(b);
      const fell = await audioEntries(b, fallback.id);
      const r = await reopen(b, fallback.id);
      c.ok('the fallback is in the saved recording and the voice is still recorded', fell.some((e) => e.type === 'device-missing') && r.audioChunks > 0, { types: fell.map((e) => e.type), audioChunks: r.audioChunks });
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Board #16785: a microphone that hears nothing. The test bar says "No
  // sound from …" after 3 s, the strip "No microphone sound" after 10 s.
  async microphoneSilent(fx) {
    const c = new Checks('microphoneSilent');
    const dir = await mkdtemp(join(tmpdir(), 'narwal-silence-'));
    const b = await launch({ args: [`--use-file-for-fake-audio-capture=${await silentWav(dir)}`] });
    try {
      const options = await openOptions(b);
      let panel = await micPanel(options);
      if (panel.access === 'prompt') {
        await options.click('.nw-mic-problem [data-key="mic-fix"]');
        panel = await micPanelUntil(options, (p) => p.access === 'granted');
      }
      const started = Date.now();
      await options.click('.nw-options [data-key="mic-test"]');
      const early = await micPanelUntil(options, (p) => p.testing, 2000);
      c.ok('a silent microphone first says it is listening', early && early.testing && early.status === 'Listening… say something.' && !early.heard, early);
      panel = await micPanelUntil(options, (p) => /^No sound from /.test(p.status), 8000);
      const after = Date.now() - started;
      c.ok('after 3 s of silence: No sound from the device, in one plain line', panel && /^No sound from \S.+\. Check it is switched on and not muted, or choose another microphone\.$/.test(panel.status) && after >= 2900, { status: panel && panel.status, after });
      c.ok('the meter stays empty and grey', panel && panel.level === 0 && !panel.heard, panel);
      await options.click('.nw-options [data-key="mic-test"]');
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      c.ok('recording starts on the silent microphone', rec.audio && rec.audio.state !== 'unavailable' && !rec.audio.error, rec.audio);
      const before = await stripUntil(page, /No microphone sound/, 5000);
      c.ok('no warning in the first seconds', !before.some((t) => /No microphone sound/.test(t)), before);
      const seen = await stripUntil(page, /No microphone sound/, 15000);
      c.ok('after 10 s with no sound the strip says No microphone sound', seen.some((t) => /^No microphone sound\. Check the microphone is on and not muted\. The page is still recorded\.$/.test(t)), seen);
      const meter = await stripMeter(page);
      c.ok('the strip meter is shown and flat', meter && meter.shown && meter.level === 0 && !meter.heard, meter);
      await stopRec(b);
      return { checks: c.list };
    } finally {
      await b.close();
      await rm(dir, { recursive: true, force: true });
    }
  },

  // A page that cannot be recorded, visited mid-recording, is a labelled gap.
  async restrictedPage(fx) {
    const c = new Checks('restrictedPage');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(800);
      await page.goto('chrome://version/');
      await sleep(1000);
      await page.goto(`${fx.A}/page2.html`);
      await mark(page, 'after-restricted');
      await sleep(1200);
      await stopRec(b);
      const r = await reopen(b, rec.id, { needles: ['marker:after-restricted'] });
      c.ok('recording continues after the restricted page', r.found['marker:after-restricted']);
      c.ok('restricted page labelled restricted-page', r.gaps.length === 1 && r.gaps[0].reason === 'restricted-page' && r.gaps[0].detail === 'chrome://version/', r.gaps);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Board #16754: windows the recorded tab opens. A popup and a new tab the
  // user switches to are recorded in the same session, each its own window;
  // a tab opened in the background and never switched to is not. Closing a
  // followed window ends its stream, not the recording. The exported bundle
  // has both streams, the walkthrough has the window lines, and replay shows
  // the window in front. SHOT_DIR=<dir> saves screenshots of the replay.
  async popupFollow(fx) {
    const c = new Checks('popupFollow');
    const b = await launch();
    const work = await mkdtemp(join(tmpdir(), 'narwal-popup-'));
    const recorded = () => b.sw(() => chrome.storage.session.get('recording').then((r) => r.recording && { followed: (r.recording.followed || []).map((f) => f.tabId), candidates: (r.recording.candidates || []).map((x) => x.tabId) }));
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/companies.html`);
      const rec = await startRec(b, page);
      await sleep(1000);
      await mark(page, 'companies-1');

      // Opened in the background and never switched to: never recorded.
      const [background] = await Promise.all([b.context.waitForEvent('page'), page.click('#open-background', { modifiers: ['ControlOrMeta'] })]);
      await background.waitForLoadState();
      await sleep(1000);
      const backgroundId = await tabIdOf(b, background);
      const backgroundActive = await b.sw((id) => chrome.tabs.get(id).then((t) => t.active), backgroundId);
      let state = await recorded();
      c.ok('a tab opened in the background is a candidate, not recorded', !backgroundActive && state.candidates.includes(backgroundId) && !state.followed.includes(backgroundId), { backgroundActive, state });

      // The popup opens in front: recorded from its first page.
      const [popup] = await Promise.all([b.context.waitForEvent('page'), page.click('#open-popup')]);
      await popup.waitForLoadState();
      await popup.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 }).catch(() => {});
      const popupId = await tabIdOf(b, popup);
      state = await recorded();
      c.ok('the popup is followed', state.followed.includes(popupId), { popupId, state });
      c.ok('the followed popup shows the recording strip', (await popup.locator('[data-narwal-ui="strip"]').count()) === 1);
      await sleep(1200);
      await mark(popup, 'popup-1');
      await popup.focus('#allow');
      await b.sw(([id]) => globalThis.narwal.command('mark-focused', { id }), [popupId]);
      await sleep(1000);

      // The popup closes itself, as a sign-in popup does.
      await Promise.all([popup.waitForEvent('close'), popup.click('#done')]);
      await sleep(800);
      state = await recorded();
      c.ok('closing the popup ends its stream, not the recording', state && !state.followed.includes(popupId), state);

      // A link with target=_blank opens a tab in front. Switching tabs moves
      // the window in front (headless Chromium switches tabs, but never moves
      // focus between windows: windows.onFocusChanged does not fire). Closing
      // the tab ends its stream, not the recording.
      const [report] = await Promise.all([b.context.waitForEvent('page'), page.click('#open-tab')]);
      await report.waitForLoadState();
      await sleep(1200);
      await mark(report, 'report-tab');
      await page.bringToFront();
      await sleep(1000);
      await mark(page, 'after-switch-back');
      await report.bringToFront();
      await sleep(1000);
      await report.close();
      await sleep(800);
      await mark(page, 'after-report');
      await sleep(1200);
      const stopped = await stopRec(b);
      c.ok('stop is normal', stopped.ok && stopped.stopReason === 'user', stopped);

      const zip = join(work, 'popup.narwal.zip');
      // The list was drawn before this recording existed.
      await b.viewer.reload();
      await exportFromList(b.viewer, 'Fixture companies', zip);
      const x = await readBundle(zip);
      c.ok('the bundle is valid', x.result.ok, x.result.errors.slice(0, 5));
      const man = JSON.parse(x.text('manifest.json'));
      const docs = JSON.parse(x.text('documents.json'));
      c.ok('the bundle is schema 1.1', man.schemaVersion === '1.1', man.schemaVersion);
      const windows = (docs.windows || []).map((w) => [w.key, w.type, w.opener, w.closedMs !== null]);
      c.ok('three windows: the recorded tab, the popup and the report tab, both closed', JSON.stringify(windows) === JSON.stringify([['w1', 'tab', null, false], ['w2', 'popup', 'w1', true], ['w3', 'tab', 'w1', true]]), docs.windows);
      const tops = docs.documents.filter((d) => d.frameId === 0).map((d) => [d.window, new URL(d.url).pathname]);
      c.ok('each window has its own page stream', JSON.stringify(tops) === JSON.stringify([['w1', '/companies.html'], ['w2', '/popup.html'], ['w3', '/page2.html']]), tops);
      c.ok('every page has an rrweb stream', docs.documents.filter((d) => d.frameId === 0).every((d) => d.rrweb && x.files.has(d.rrweb)), docs.documents.map((d) => d.rrweb));
      const rr = (w) => docs.documents.filter((d) => d.window === w && d.rrweb).map((d) => x.text(d.rrweb)).join('\n');
      c.ok('the popup stream holds what happened in the popup', rr('w2').includes('marker:popup-1') && !rr('w1').includes('marker:popup-1'));
      c.ok('the report tab stream holds what happened in it', rr('w3').includes('marker:report-tab'));
      const all = [...x.files.keys()].filter((p) => !p.endsWith('.webm')).map((p) => x.text(p)).join('\n');
      c.ok('the tab never switched to is not in the bundle', !all.includes('background=1'));
      c.ok('the popup URL query value is not in the bundle', !all.includes('POPUPSECRET5'), [...x.files.keys()].filter((p) => !p.endsWith('.webm') && x.text(p).includes('POPUPSECRET5')).map((p) => [p, x.text(p).slice(Math.max(0, x.text(p).indexOf('POPUPSECRET5') - 200), x.text(p).indexOf('POPUPSECRET5') + 40)]));
      const obs = x.lines('observations.jsonl');
      const lines = obs.filter((o) => o.kind === 'window').map((o) => `${o.state} ${o.window}`);
      c.ok('window lines: opened, switched to and closed', lines.join(',') === 'opened w2,closed w2,opened w3,focused w1,focused w3,focused w1,closed w3', lines);
      const popupDoc = docs.documents.find((d) => d.window === 'w2' && d.frameId === 0);
      const popupMark = obs.find((o) => o.kind === 'marker-element' && o.doc === popupDoc?.key);
      c.ok('the mark in the popup is in the bundle', popupMark && popupMark.target?.name === 'Allow', popupMark);
      const md = x.text('agent/walkthrough.md');
      const want = [/opened window w2 from w1 "Fixture sign-in"/, /closed window w2/, /opened window w3 from w1 "Fixture page 2"/, /switched to window w1/, /switched to window w3/, /marked element "Allow" button \(keyboard\) \| window=w2/];
      c.ok('the walkthrough has the window lines and the popup mark', want.every((re) => re.test(md)), { missing: want.filter((re) => !re.test(md)).map(String), md: md.split('\n').filter((l) => /window|marked/.test(l)) });
      const view = x.view;
      c.ok('the agent view lists the popup mark in window w2', view.entries.some((e) => e.window === 'w2' && e.evidence?.some((v) => v.kind === 'marker-element')), view.entries.filter((e) => e.window === 'w2').map((e) => e.kind));

      // Replay: the window in front is the one shown.
      const at = (state, w) => obs.find((o) => o.kind === 'window' && o.state === state && o.window === w)?.atMs ?? 0;
      const replay = await b.context.newPage();
      await replay.setViewportSize({ width: 1400, height: 900 });
      await replay.goto(b.url('replay.html'));
      await replay.setInputFiles('#file', zip);
      await replay.waitForFunction(() => globalThis.__narwalReplay?.player);
      const seek = (t) =>
        replay.evaluate((ms) => {
          const { player } = globalThis.__narwalReplay;
          player.seek(ms);
          const s = player.state();
          const doc = player.frame?.contentDocument ?? null;
          return { window: s.window, doc: s.page?.docKey ?? null, text: doc?.body?.textContent?.slice(0, 120) ?? null, label: document.getElementById('window').textContent, bands: document.querySelectorAll('#windows .band').length };
        }, t);
      const inPopup = await seek((at('opened', 'w2') + at('closed', 'w2')) / 2 + 500);
      await sleep(300);
      if (process.env.SHOT_DIR) await replay.screenshot({ path: join(process.env.SHOT_DIR, 'replay-two-windows-popup-in-front-light.png'), fullPage: true });
      c.ok('replay shows the popup while it is in front', inPopup.window === 'w2' && inPopup.doc === popupDoc.key && /Fixture sign-in/.test(inPopup.text || '') && /popup opened from window 1/.test(inPopup.label), inPopup);
      const afterPopup = await seek((at('closed', 'w2') + at('opened', 'w3')) / 2);
      c.ok('replay shows the companies page once the popup closed', afterPopup.window === 'w1' && /Fixture companies/.test(afterPopup.text || ''), afterPopup);
      const inReport = await seek((at('opened', 'w3') + at('focused', 'w1')) / 2);
      c.ok('replay shows the report tab while it is in front', inReport.window === 'w3' && /Fixture page 2/.test(inReport.text || '') && /tab opened from window 1/.test(inReport.label), inReport);
      const back = await seek((at('focused', 'w1') + at('focused', 'w3')) / 2);
      await sleep(300);
      if (process.env.SHOT_DIR) await replay.screenshot({ path: join(process.env.SHOT_DIR, 'replay-two-windows-recorded-tab-in-front-light.png'), fullPage: true });
      c.ok('replay shows the companies page after the switch back to its tab', back.window === 'w1' && /Fixture companies/.test(back.text || '') && /the tab the recording started in/.test(back.label) && back.bands >= 4, back);
      const after = await seek(man.durationMs - 200);
      c.ok('replay shows the companies page after both windows closed', after.window === 'w1' && /Fixture companies/.test(after.text || ''), after);
      // For docs/research/16754-follow-windows.md: from the click that opened
      // a window to its opened line, and on to its first full snapshot.
      const firstSnapshot = (w) => {
        const d = docs.documents.find((x) => x.window === w && x.frameId === 0);
        const snap = x.lines(d.rrweb).find((l) => l.event.type === 2);
        return snap ? snap.event.timestamp - man.clock.originEpochMs : null;
      };
      const clickOn = (name) => obs.find((o) => o.kind === 'click' && o.target?.name === name)?.atMs ?? null;
      const measured = Object.fromEntries(
        [['popup', 'w2', 'Connect account'], ['newTab', 'w3', 'Report in a new tab']].map(([label, w, name]) => [
          label,
          { clickToOpenedMs: Math.round(at('opened', w) - clickOn(name)), openedToFirstSnapshotMs: Math.round(firstSnapshot(w) - at('opened', w)) },
        ]),
      );
      return { checks: c.list, measured };
    } finally {
      await b.close();
      await rm(work, { recursive: true, force: true });
    }
  },

  // Storage full: recording stops visibly and earlier chunks stay readable.
  async storageFull(fx) {
    const c = new Checks('storageFull');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(2000);
      await mark(page, 'before-full');
      await sleep(1500);
      await b.sw(() => {
        globalThis.__recorderFailed = 0;
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.cmd === 'recorder-failed') globalThis.__recorderFailed += 1;
        });
        return globalThis.narwal.failWrites();
      });
      await sleep(3000);
      const st = await status(b);
      c.ok('recording stopped by itself', !st.live && st.lastResult && st.lastResult.stopReason === 'storage-full', st.lastResult);
      const reported = await b.sw(() => globalThis.__recorderFailed);
      c.ok('the recorder reports the failure once, not once per failed write', reported === 1, reported);
      const badge = await b.sw(() => chrome.action.getBadgeText({}));
      c.ok('toolbar badge says FULL', badge === 'FULL', badge);
      const popup = await b.context.newPage();
      await popup.goto(b.url('popup.html'));
      await popup.waitForSelector('.nw-banner-text');
      const text = await popup.textContent('.nw-banner-text');
      c.ok('popup shows the storage error and that earlier data is kept', /Storage is full/.test(text) && /Everything saved before that is kept/.test(text), text);
      await popup.close();
      const r = await reopen(b, rec.id, { needles: ['marker:before-full'] });
      c.ok('reopens as stopped (storage-full)', r.meta.status === 'stopped' && r.meta.stopReason === 'storage-full' && r.meta.storageError && r.meta.storageError.quota, r.meta);
      c.ok('chunks saved before the error are readable', r.eventChunks >= 2 && r.audioChunks >= 2 && r.found['marker:before-full'], { eventChunks: r.eventChunks, audioChunks: r.audioChunks });
      c.ok('the unsaved tail is labelled recovery-truncated (storage-full)', r.gaps.some((g) => g.reason === 'recovery-truncated' && g.detail === 'storage-full'), r.gaps);
      c.ok('saved audio decodes', typeof (r.audio[0] || {}).decodedMs === 'number', r.audio);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Two stops at once (two recorder failures; Stop as the tab closes): the
  // second waits, so it cannot close the recorder during the first one's final
  // save (board #16568).
  async concurrentStops(fx) {
    const c = new Checks('concurrentStops');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(2000);
      await mark(page, 'before-double-failure');
      await sleep(1200);
      const error = { name: 'UnknownError', message: 'simulated write failure', quota: false, at: Date.now(), lost: { stream: 'events', from: Date.now(), to: Date.now() } };
      const replies = await b.viewer.evaluate(
        (err) => Promise.all([0, 1].map(() => chrome.runtime.sendMessage({ to: 'sw', cmd: 'recorder-failed', reason: 'storage-error', error: err }))),
        error,
      );
      c.ok('one failure stops the recording, the other finds it stopped', replies.filter((r) => r.ok).length === 1 && replies.some((r) => r.error === 'not-recording'), replies);
      const r = await reopen(b, rec.id, { needles: ['marker:before-double-failure'] });
      c.ok('final save completed: stopped (storage-error), not interrupted', r.meta.status === 'stopped' && r.meta.stopReason === 'storage-error' && !r.meta.interruption, r.meta);
      c.ok('page evidence before the failure is kept', r.found['marker:before-double-failure']);
      c.ok('saved audio decodes', r.audio.length === 1 && typeof r.audio[0].decodedMs === 'number', r.audio);

      // Stop from the popup at the moment the recorded tab closes.
      await page.close(); // tabIdOf finds a tab by URL: leave one tab on it.
      const page2 = await b.context.newPage();
      await page2.goto(`${fx.A}/index.html`);
      const rec2 = await startRec(b, page2);
      await sleep(2000);
      await mark(page2, 'before-close');
      await sleep(1200);
      const [, stopped] = await Promise.all([page2.close(), stopRec(b)]);
      await sleep(1000);
      const st = await status(b);
      c.ok('nothing left recording', !st.live && st.lastResult && st.lastResult.id === rec2.id, { live: st.live, lastResult: st.lastResult });
      const r2 = await reopen(b, rec2.id, { needles: ['marker:before-close'] });
      c.ok('stop and tab close: stopped, not interrupted', r2.meta.status === 'stopped' && ['user', 'tab-closed'].includes(r2.meta.stopReason) && !r2.meta.interruption, { meta: r2.meta, stopped });
      c.ok('page evidence before the close is kept', r2.found['marker:before-close'], { documents: r2.documents, attachUrls: r2.attachUrls, eventChunks: r2.eventChunks, refusedPorts: r2.refusedPorts });
      c.ok('saved audio decodes (stop + close)', r2.audio.length === 1 && typeof r2.audio[0].decodedMs === 'number', r2.audio);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // The in-page controls (board #16551): the strip appears in the recorded
  // page, stays out of the recording, and Stop works from the keyboard after
  // the focus-controls shortcut.
  async controls(fx) {
    const c = new Checks('controls');
    const b = await launch();
    try {
      const popup = await b.context.newPage();
      await popup.goto(b.url('popup.html'));
      await popup.waitForSelector('input[name="nw-transcription"]');
      const offered = await popup.$$eval('input[name="nw-transcription"]', (els) => els.map((e) => e.value));
      c.ok('the popup offers on this computer and OpenAI only (q3549)', JSON.stringify(offered) === '["offline","openai"]', offered);
      await popup.close();
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      const tabId = await tabIdOf(b, page);
      await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
      await sleep(500);
      const hosts = await page.evaluate(() => document.querySelectorAll('[data-narwal-ui="strip"]').length);
      c.ok('one strip in the recorded page', hosts === 1, hosts);
      await sleep(1500);
      await mark(page, 'with-strip');
      await sleep(1200);
      await b.sw((t) => chrome.tabs.sendMessage(t, { to: 'strip', cmd: 'focus' }, { frameId: 0 }), tabId);
      const focused = await page.evaluate(() => Boolean(document.activeElement && document.activeElement.matches('[data-narwal-ui]')));
      c.ok('the focus-controls shortcut moves the keyboard into the strip', focused, focused);
      await page.keyboard.press('Enter');
      let st = null;
      for (let i = 0; i < 40; i += 1) {
        st = await status(b);
        if (!st.live && st.lastResult) break;
        await sleep(250);
      }
      c.ok('Enter on the focused Stop stops the recording', !st.live && st.lastResult && st.lastResult.id === rec.id && st.lastResult.stopReason === 'user', st.lastResult);
      const ui = await b.viewer.evaluate(() => chrome.runtime.sendMessage({ to: 'sw', cmd: 'ui-status' }));
      c.ok('ui-status reports the saved recording for the strip', ui.ok && !ui.live && ui.lastResult && ui.lastResult.id === rec.id, ui.lastResult);
      const r = await reopen(b, rec.id, { needles: ['marker:with-strip', 'NarWal recording controls', 'Transcript so far'] });
      c.ok('page captured', r.found['marker:with-strip']);
      c.ok('the strip is not in the recording', !r.found['NarWal recording controls'] && !r.found['Transcript so far'], r.found);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // The Saved recordings list (board #16839): a click anywhere on a row
  // selects it and the tiles show it; up and down move the selection, Enter
  // opens it; a search keeps the selected row selected while it is listed.
  // SHOTS_DIR=<dir> also saves a screenshot after each selection.
  async listSelect(fx) {
    const c = new Checks('listSelect');
    const b = await launch();
    try {
      for (const path of ['index.html', 'page2.html', 'companies.html']) {
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/${path}`);
        await startRec(b, page);
        await sleep(1500);
        await stopRec(b);
        await sleep(500);
        await page.close();
      }
      const v = b.viewer;
      await v.setViewportSize({ width: 1440, height: 1100 });
      await v.goto(b.url('recordings.html'));
      await v.locator('#list tbody tr[data-id]').nth(2).waitFor();
      const state = () =>
        v.evaluate(() => {
          const marked = [...document.querySelectorAll('#list tbody tr[aria-current="true"]')];
          return {
            panel: document.querySelector('#detail-title .tt')?.textContent || null,
            marked: marked.map((tr) => tr.querySelector('td.t').textContent),
            focused: document.activeElement?.closest('tr')?.querySelector('td.t')?.textContent || null,
            tabStops: [...document.querySelectorAll('#list tbody tr[tabindex="0"]')].map((tr) => tr.querySelector('td.t').textContent),
          };
        });
      // The panel has loaded the row that is marked.
      const settled = async () => {
        await v.waitForFunction(() => {
          const tr = document.querySelector('#list tbody tr[aria-current="true"]');
          return tr && document.querySelector('#detail-title .tt')?.textContent === tr.querySelector('td.t').textContent;
        }, null, { timeout: 10000 }).catch(() => {});
        return state();
      };
      const titles = await v.$$eval('#list tbody tr[data-id] td.t', (tds) => tds.map((td) => td.textContent));
      c.ok('three recordings listed, newest first', JSON.stringify(titles) === '["Fixture companies","Fixture page 2","Fixture index"]', titles);
      const first = await settled();
      c.ok('on open, the marked row is the recording the panel shows', first.marked.length === 1 && first.marked[0] === first.panel && first.panel === 'Fixture companies', first);
      let n = 0;
      for (const at of [2, 1, 0]) {
        // The middle of the row, away from Open and Export.
        await v.locator('#list tbody tr[data-id]').nth(at).locator('td.site').click();
        const got = await settled();
        c.ok(`a click on row ${at + 1} selects it and the panel shows it`, got.marked.length === 1 && got.marked[0] === titles[at] && got.panel === titles[at], got);
        if (process.env.SHOTS_DIR) await v.screenshot({ path: join(process.env.SHOTS_DIR, `list-select-${(n += 1)}-click-row-${at + 1}.png`), fullPage: true });
      }
      await v.keyboard.press('ArrowDown');
      let got = await settled();
      c.ok('ArrowDown selects the next row and the panel follows', got.marked[0] === titles[1] && got.panel === titles[1] && got.focused === titles[1], got);
      await v.keyboard.press('ArrowDown');
      got = await settled();
      c.ok('ArrowDown again', got.marked[0] === titles[2] && got.panel === titles[2], got);
      await v.keyboard.press('ArrowDown');
      got = await settled();
      c.ok('ArrowDown on the last row stays there', got.marked[0] === titles[2] && got.panel === titles[2] && got.focused === titles[2], got);
      await v.keyboard.press('ArrowUp');
      got = await settled();
      c.ok('ArrowUp selects the row before', got.marked[0] === titles[1] && got.panel === titles[1] && got.focused === titles[1], got);
      c.ok('one row takes Tab into the list: the selected one', got.tabStops.length === 1 && got.tabStops[0] === titles[1], got.tabStops);
      if (process.env.SHOTS_DIR) await v.screenshot({ path: join(process.env.SHOTS_DIR, `list-select-${(n += 1)}-arrow-up.png`), fullPage: true });

      await v.fill('#search', 'page 2');
      got = await state();
      const hidden = await v.$$eval('#list tbody tr[data-id]', (trs) => trs.filter((tr) => tr.hidden).length);
      c.ok('a search that still lists the selected row keeps it selected', hidden === 2 && got.marked[0] === titles[1] && got.panel === titles[1], { hidden, got });
      await v.fill('#search', 'companies');
      got = await state();
      c.ok('a search that hides it: the panel keeps it and Tab lands on a listed row', got.panel === titles[1] && got.tabStops.length === 1 && got.tabStops[0] === titles[0], got);
      await v.fill('#search', '');
      got = await state();
      c.ok('clearing the search shows it selected again', got.marked[0] === titles[1] && got.tabStops[0] === titles[1], got);

      await v.evaluate(() => scrollTo({ top: document.body.scrollHeight }));
      await v.locator('#list tbody tr[aria-current="true"]').focus();
      await v.keyboard.press('Enter');
      await v.waitForFunction(() => document.activeElement === document.getElementById('detail-title'), null, { timeout: 10000 }).catch(() => {});
      const opened = await v.evaluate(() => ({ focusTitle: document.activeElement === document.getElementById('detail-title'), scrollY: scrollY }));
      c.ok('Enter opens the row: the panel takes the focus, scrolled into view', opened.focusTitle && opened.scrollY === 0, opened);

      const before = await state();
      await v.locator('#list tbody tr[data-id]').nth(0).getByRole('button', { name: 'Open' }).click();
      got = await settled();
      c.ok('the Open button still opens its row', got.marked[0] === titles[0] && got.panel === titles[0], { before, got });
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Delete on Saved recordings (board #17003): one row's trash button asks
  // once, naming the recording and its length; Cancel deletes nothing; Delete
  // removes it from the list without a reload, it cannot be opened again, and
  // the popup shows less space used. Ticked rows go with one Delete selected.
  // SHOTS_DIR=<dir> also saves the confirm and the popup before and after.
  async deleteRecordings(fx) {
    const c = new Checks('deleteRecordings');
    const b = await launch();
    try {
      for (const path of ['index.html', 'page2.html', 'companies.html', 'index.html']) {
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/${path}`);
        await startRec(b, page);
        await sleep(1500);
        await stopRec(b);
        await sleep(500);
        await page.close();
      }
      const shot = (page, name) => (process.env.SHOTS_DIR ? page.screenshot({ path: join(process.env.SHOTS_DIR, `delete-${name}.png`) }) : null);
      const used = async (name) => {
        const popup = await b.context.newPage();
        await popup.goto(b.url('popup.html'));
        await popup.waitForFunction(() => document.getElementById('storage-used')?.textContent, null, { timeout: 10000 }).catch(() => {});
        const text = await popup.$eval('#storage-used', (s) => s.textContent);
        // The popup's width; the size sits on the bottom line.
        await popup.setViewportSize({ width: 400, height: 600 });
        if (process.env.SHOTS_DIR) await popup.screenshot({ path: join(process.env.SHOTS_DIR, `delete-${name}.png`), fullPage: true });
        await popup.close();
        return { text };
      };
      const v = b.viewer;
      await v.setViewportSize({ width: 1440, height: 1100 });
      await v.goto(b.url('recordings.html'));
      await v.locator('#list tbody tr[data-id]').nth(3).waitFor();
      const rows = () => v.$$eval('#list tbody tr[data-id]', (trs) => trs.map((tr) => ({ id: tr.dataset.id, title: tr.querySelector('td.t').textContent, cells: [...tr.cells].map((td) => td.textContent) })));
      const bytesNow = () => v.evaluate(() => window.narwalViewer.usedBytes());
      const before = await rows();
      c.ok('four recordings listed', before.length === 4, before.map((r) => r.title));
      const sizeBefore = await used('1-popup-before');
      const bytesBefore = await bytesNow();
      c.ok('the popup shows the space the recordings use', /^ \(\d[\d.]* (bytes|KB|MB|GB)\)$/.test(sizeBefore.text) && bytesBefore > 0, { sizeBefore, bytesBefore });

      const target = before[1];
      const row = v.locator(`#list tbody tr[data-id="${target.id}"]`);
      await row.getByRole('button', { name: 'Delete' }).click();
      await v.locator('#confirm-delete[open]').waitFor({ timeout: 5000 });
      const ask = await v.evaluate(() => ({
        title: document.getElementById('confirm-title').textContent,
        items: [...document.querySelectorAll('#confirm-list li')].map((li) => ({ t: li.querySelector('.t').textContent, m: li.querySelector('.m').textContent })),
        focus: document.activeElement?.id,
        go: document.getElementById('confirm-go').textContent,
      }));
      c.ok('one click asks first: the confirm names the recording and its length', ask.title === 'Delete this recording?' && ask.items.length === 1 && ask.items[0].t === target.title && target.cells.includes(ask.items[0].m) && /\d/.test(ask.items[0].m), { ask, target });
      c.ok('Cancel has the focus, so Enter alone does not delete', ask.focus === 'confirm-cancel', ask);
      await shot(v, '2-confirm-one');

      // The twin: Cancel, Escape and the backdrop delete nothing.
      await v.click('#confirm-cancel');
      await row.getByRole('button', { name: 'Delete' }).click();
      await v.locator('#confirm-delete[open]').waitFor({ timeout: 5000 });
      await v.keyboard.press('Escape');
      await row.getByRole('button', { name: 'Delete' }).click();
      await v.locator('#confirm-delete[open]').waitFor({ timeout: 5000 });
      await v.mouse.click(5, 5);
      await sleep(300);
      const kept = await rows();
      const bytesKept = await bytesNow();
      c.ok('Cancel, Escape and a click outside delete nothing', kept.length === 4 && kept.some((r) => r.id === target.id) && bytesKept === bytesBefore, { kept: kept.length, bytesKept, bytesBefore });
      const open = await v.evaluate(() => document.querySelector('#confirm-delete').open);
      c.ok('the confirm is closed after each', open === false);

      await row.getByRole('button', { name: 'Delete' }).click();
      await v.locator('#confirm-delete[open]').waitFor({ timeout: 5000 });
      const navigations = [];
      v.on('framenavigated', (f) => f === v.mainFrame() && navigations.push(f.url()));
      await v.click('#confirm-go');
      await v.waitForFunction((id) => !document.querySelector(`#list tbody tr[data-id="${id}"]`), target.id, { timeout: 10000 }).catch(() => {});
      await v.waitForFunction(() => /^Deleted /.test(document.getElementById('export-status').textContent), null, { timeout: 10000 }).catch(() => {});
      const after1 = await rows();
      const note1 = await v.$eval('#export-status', (e) => e.textContent);
      const bytesAfter1 = await bytesNow();
      c.ok('Delete takes the row out of the list without a reload', after1.length === 3 && !after1.some((r) => r.id === target.id) && navigations.length === 0, { after: after1.map((r) => r.title), navigations });
      c.ok('the note says what was deleted and the space freed', note1.startsWith(`Deleted ${target.title}.`) && /freed\.$/.test(note1), note1);
      c.ok('the space used goes down', bytesAfter1 < bytesBefore, { bytesBefore, bytesAfter1 });
      const leftover = await b.sw(async (id) => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('narwal'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const count = (store, q) => new Promise((res) => { const r = db.transaction(store).objectStore(store).count(q); r.onsuccess = () => res(r.result); });
        const range = IDBKeyRange.bound([id], [id, []]);
        return { meta: await count('recordings', id), chunks: await count('chunks', range) };
      }, target.id);
      c.ok('its entry and every chunk are gone from storage', leftover.meta === 0 && leftover.chunks === 0, leftover);

      const again = await b.context.newPage();
      await again.goto(b.url(`recordings.html?id=${encodeURIComponent(target.id)}`));
      await again.locator('#list tbody tr[data-id]').nth(2).waitFor();
      await sleep(500);
      const reopened = await again.evaluate((id) => ({ row: Boolean(document.querySelector(`#list tbody tr[data-id="${id}"]`)), panel: document.querySelector('#detail-title .tt')?.textContent || null }), target.id);
      c.ok('a deleted recording cannot be opened again', !reopened.row && reopened.panel !== target.title, reopened);
      await again.close();

      // Bulk: tick two rows, Delete selected once.
      const pick = after1.slice(0, 2);
      for (const r of pick) await v.locator(`#list tbody tr[data-id="${r.id}"] td.pick input`).check();
      const bar = await v.evaluate(() => ({ shown: !document.getElementById('picked-bar').hidden, count: document.getElementById('picked-count').textContent, all: document.getElementById('pick-all').indeterminate }));
      c.ok('ticking two rows shows Delete selected', bar.shown && /2/.test(bar.count) && bar.all, bar);
      await v.click('#delete-picked');
      await v.locator('#confirm-delete[open]').waitFor({ timeout: 5000 });
      const ask2 = await v.evaluate(() => ({ title: document.getElementById('confirm-title').textContent, items: [...document.querySelectorAll('#confirm-list li .t')].map((s) => s.textContent) }));
      c.ok('one confirm names both recordings', /^Delete 2 recordings/.test(ask2.title) && JSON.stringify(ask2.items) === JSON.stringify(pick.map((r) => r.title)), ask2);
      await shot(v, '3-confirm-two');
      await v.click('#confirm-go');
      await v.waitForFunction(() => document.querySelectorAll('#list tbody tr[data-id]').length === 1, null, { timeout: 10000 }).catch(() => {});
      const after2 = await rows();
      const bar2 = await v.evaluate(() => document.getElementById('picked-bar').hidden);
      c.ok('both are deleted at once; the one left stays', after2.length === 1 && after2[0].id === after1[2].id && bar2 === true, { after: after2.map((r) => r.title), barHidden: bar2 });
      await shot(v, '4-list-after');
      const bytesAfter2 = await bytesNow();
      const sizeAfter = await used('5-popup-after');
      c.ok('the popup shows less space used after', bytesAfter2 < bytesAfter1 && sizeAfter.text !== sizeBefore.text, { before: sizeBefore.text, after: sizeAfter.text, bytesBefore, bytesAfter2 });
      return { checks: c.list, measured: { before: sizeBefore.text, after: sizeAfter.text, bytesBefore, bytesAfter1, bytesAfter2 } };
    } finally {
      await b.close();
    }
  },

  // A new build in the folder of the unpacked install starts by itself
  // (board #17009): the worker reloads on its one-minute alarm once nothing
  // would be lost, and only once for each folder build.
  async selfUpdate(fx) {
    const c = new Checks('selfUpdate');
    const app = await mkdtemp(join(tmpdir(), 'narwal-e2e-app-'));
    await cp(APP, app, { recursive: true });
    const b = await launch({ app });
    try {
      // An unpacked install needs Developer mode, which Edge has on for one;
      // with it off, a reload leaves the extension disabled
      // (unsupportedDeveloperExtension), so the test profile turns it on.
      const dev = await b.context.newPage();
      await dev.goto('chrome://extensions');
      await dev.evaluate(() => new Promise((done) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, done)));
      await dev.close();
      const prefix = `chrome-extension://${b.extensionId}/`;
      const before = await b.sw(() => chrome.runtime.getManifest().version);
      c.ok('the same build in the folder: no reload', (await b.sw(() => globalThis.narwal.checkBuild('test'))) === 'same');
      // The maintainers' release job, in place: a new version and build in the folder.
      const next = before.replace(/\d+$/, (n) => String(Number(n) + 1));
      const manifest = JSON.parse(await readFile(join(app, 'manifest.json'), 'utf8'));
      await writeFile(join(app, 'manifest.json'), JSON.stringify({ ...manifest, version: next }));
      const build = JSON.parse(await readFile(join(app, 'dist/build.json'), 'utf8'));
      await writeFile(join(app, 'dist/build.json'), `${JSON.stringify({ ...build, version: next, commit: 'e2e17009'.padEnd(40, '0'), short: 'e2e1700' })}\n`);
      c.ok('a Saved recordings tab in use holds the reload', (await b.sw(() => globalThis.narwal.checkBuild('test'))) === 'busy:page-in-use');
      // A replay tab next to it. Both are then left in the background: open
      // NarWal tabs nobody used held every build for twelve days (board #17009).
      const replayTab = await b.context.newPage();
      await replayTab.goto(b.url('replay.html'));
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(800);
      c.ok('a recording holds the reload', (await b.sw(() => globalThis.narwal.checkBuild('test'))) === 'busy:recording');
      for (const p of [b.viewer, replayTab]) await p.evaluate(() => globalThis.narwalPageGuard.force({ visible: false, idle: true }));
      const reloaded = b.context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(prefix), timeout: 150000 });
      const stopped = await stopRec(b);
      c.ok('the recording stopped and was saved', stopped && stopped.ok, stopped);
      const started = Date.now();
      const sw = await reloaded.catch(() => null);
      c.ok('after Stop, with the NarWal tabs open but idle, the alarm reloaded the extension with no click (within 2.5 minutes)', Boolean(sw), { seconds: Math.round((Date.now() - started) / 1000) });
      if (!sw) return { checks: c.list };
      const after = await sw.evaluate(async () => ({
        version: chrome.runtime.getManifest().version,
        selfUpdate: (await chrome.storage.local.get('selfUpdate')).selfUpdate,
      }));
      c.ok('the extension runs the version now in the folder', after.version === next, after);
      c.ok('the reload is recorded with the folder build and the alarm', after.selfUpdate && after.selfUpdate.short === 'e2e1700' && after.selfUpdate.trigger === 'alarm', after.selfUpdate);
      // The scripts are still the old build's (only build.json changed): a
      // folder that never matches is reloaded for once, never in a loop.
      c.ok('a folder build it already reloaded for: no second reload', (await sw.evaluate(() => globalThis.narwal.checkBuild('test'))) === 'tried');
      // The Saved recordings and replay tabs are open again.
      let tabs = [];
      for (let i = 0; i < 20; i++) {
        tabs = await sw.evaluate(async (p) => (await chrome.tabs.query({})).map((t) => t.url).filter((u) => u.startsWith(p)), prefix);
        if (tabs.includes(b.url('recordings.html')) && tabs.includes(b.url('replay.html'))) break;
        await sleep(500);
      }
      const left = await sw.evaluate(async () => (await chrome.storage.local.get('selfUpdateTabs')).selfUpdateTabs ?? null);
      c.ok('the Saved recordings and replay tabs open again after the reload, once', tabs.filter((u) => u === b.url('recordings.html')).length === 1 && tabs.filter((u) => u === b.url('replay.html')).length === 1 && left === null, {
        tabs,
        left,
        closedByReload: b.viewer.isClosed(),
      });
      const viewer = b.context.pages().find((p) => !p.isClosed() && p.url() === b.url('recordings.html'));
      c.ok('the Saved recordings tab is there to use', Boolean(viewer));
      if (!viewer) return { checks: c.list };
      await viewer.waitForLoadState();
      await viewer.waitForFunction(() => Boolean(globalThis.narwalViewer), null, { timeout: 10000 });
      const answered = await viewer.evaluate(async () => {
        const reply = await chrome.runtime.sendMessage({ to: 'sw', cmd: 'status' });
        return Boolean(reply && reply.ok);
      });
      c.ok('the reloaded worker answers the pages', answered);
      b.viewer = viewer;
      const r = await reopen(b, rec.id);
      c.ok('the recording saved before the reload is still in Saved recordings', r.meta && r.meta.status === 'stopped', r.meta && r.meta.status);
      return { checks: c.list };
    } finally {
      await b.close();
      await rm(app, { recursive: true, force: true });
    }
  },

  // After Stop, Export on the strip and on the popup downloads the bundle of
  // the recording just saved (board #16602). Both open the recordings page,
  // which exports with the same code as its own Export bundle button.
  async exportAfterStop(fx) {
    const c = new Checks('exportAfterStop');
    const b = await launch();
    const work = await mkdtemp(join(tmpdir(), 'narwal-export-'));
    // The next page the extension opens, and the download it starts.
    const nextDownload = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no export page download in 120 s')), 120000);
        b.context.once('page', (p) =>
          p.once('download', (download) => {
            clearTimeout(timer);
            resolve({ page: p, download });
          }),
        );
      });
    // The next page the extension opens, before any download.
    const nextPage = () => b.context.waitForEvent('page', { timeout: 120000 });
    const check = async (from, got, recId, purpose) => {
      const path = join(work, `${from}.narwal.zip`);
      await got.download.saveAs(path);
      const x = await readBundle(path);
      const man = JSON.parse(x.text('manifest.json') || 'null');
      c.ok(`Export on the ${from} downloads a valid .narwal.zip`, got.download.suggestedFilename().endsWith('.narwal.zip') && x.result.ok, { file: got.download.suggestedFilename(), errors: x.result.errors.slice(0, 5) });
      c.ok(`the ${from} bundle is the recording just stopped`, man && man.recordingId === bundleRecordingId(recId) && man.state === 'complete', man && { recordingId: man.recordingId, state: man.state });
      const readme = x.text('README.md') || '';
      c.ok(`the ${from} bundle carries the purpose in manifest.purpose and README.md (#17002)`, man && man.purpose === purpose && readme.includes(`purpose="${purpose}"`) && !/No purpose was given/.test(readme), man && { purpose: man.purpose });
      // The note is written just after the download starts.
      const status = got.page.locator('#export-status');
      await got.page.waitForFunction(() => /^Saved /.test(document.getElementById('export-status').textContent), null, { timeout: 10000 }).catch(() => {});
      const shown = await status.textContent();
      c.ok(`the page the ${from} opened says the bundle was exported, and a reload does not export again`, /narwal\.zip/.test(shown) && !new URL(got.page.url()).searchParams.has('export'), { shown, url: got.page.url() });
      await got.page.close();
    };
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      const tabId = await tabIdOf(b, page);
      await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
      await sleep(2500);
      await mark(page, 'export-after-stop');
      await sleep(1500);
      const stopped = await stopRec(b);
      c.ok('Stop saves the recording', stopped && stopped.ok, stopped);
      // This profile has no model for after Stop (#16603): the job fails at
      // once, the strip says so after "Saved", and Export is not held back.
      const savedText = /^Saved on this computer\.(?! Improving)/;
      const saved = await stripUntil(page, savedText);
      c.ok('the strip says the recording is saved, and no transcript job holds it', savedText.test(saved.at(-1) || ''), saved);

      // The strip, with a real mouse click. The recording has no purpose
      // (board #17002): the page it opens asks first and downloads nothing
      // until the person answers. Escape stops the export.
      const PURPOSE = 'Each mark is a bug to fix';
      const cancelPage = nextPage();
      cancelPage.catch(() => {});
      const pressed = await pressStripButton(page, 'export');
      c.ok('the saved strip has an Export button', pressed);
      if (pressed) {
        const asked = await cancelPage;
        let downloads = 0;
        asked.on('download', () => (downloads += 1));
        const shown = await asked.waitForSelector('#purpose-ask[open]', { timeout: 30000 }).then(() => true, () => false);
        const modal = await asked.evaluate(() => ({
          question: document.getElementById('purpose-ask-title').textContent,
          focused: document.activeElement && document.activeElement.id,
          saveDisabled: document.getElementById('purpose-ask-ok').disabled,
        }));
        c.ok('Export with no purpose asks the question in a modal, focus in the field, Save disabled (#17002)', shown && modal.question === 'What is this recording for, and what should happen with each thing you pointed at?' && modal.focused === 'purpose-ask-text' && modal.saveDisabled, modal);
        if (process.env.SHOT_DIR) await asked.screenshot({ path: join(process.env.SHOT_DIR, 'export-purpose-modal-light.png') });
        await asked.fill('#purpose-ask-text', '   ');
        c.ok('a blank answer keeps Save disabled', await asked.locator('#purpose-ask-ok').isDisabled());
        await asked.keyboard.press('Escape');
        await asked.waitForFunction(() => /^Not exported\./.test(document.getElementById('export-status').textContent), null, { timeout: 10000 }).catch(() => {});
        await sleep(1500);
        const after = await asked.evaluate(() => ({ open: document.getElementById('purpose-ask').open, status: document.getElementById('export-status').textContent }));
        c.ok('must say NO: Escape closes the modal and downloads nothing', downloads === 0 && !after.open && /^Not exported\./.test(after.status), { downloads, ...after });
        await asked.close();

        const fromStrip = nextDownload();
        fromStrip.catch(() => {});
        const answered = nextPage();
        await pressStripButton(page, 'export');
        const again = await answered;
        await again.waitForSelector('#purpose-ask[open]', { timeout: 30000 });
        await again.fill('#purpose-ask-text', `  ${PURPOSE}  `);
        await again.click('#purpose-ask-ok');
        await check('strip', await fromStrip, rec.id, PURPOSE);
      }

      // The popup's saved view.
      const popup = await b.context.newPage();
      await popup.goto(b.url(`popup.html?tab=${tabId}`));
      const exportButton = popup.locator('.nw-banner [data-key="export"]');
      await exportButton.waitFor({ timeout: 10000 });
      const labels = await popup.locator('.nw-banner button').allTextContents();
      c.ok('the popup offers Export first, then Open recording', JSON.stringify(labels) === '["Export","Open recording"]', labels);
      // The purpose is saved now: the popup's Export downloads with no question.
      const got = nextDownload();
      await exportButton.click();
      const popupGot = await got;
      c.ok('a recording with a purpose exports with no modal (#17002)', !(await popupGot.page.evaluate(() => document.getElementById('purpose-ask').open)));
      await check('popup', popupGot, rec.id, PURPOSE);
      await popup.close().catch(() => {});
      return { checks: c.list };
    } finally {
      await b.close();
      await rm(work, { recursive: true, force: true });
    }
  },

  // Export after Stop while the improved transcript is still being made on
  // this computer (board #16622). Export on the strip is not refused: the
  // recordings page it opens says it waits, with how far the transcript is,
  // and downloads the bundle with the improved transcript once it is ready.
  // Export in the popup, pressed when the transcript has just arrived, also
  // downloads. Downloads Moonshine base (67 MB), so it runs only when named.
  async exportWhileImproving(fx) {
    const c = new Checks('exportWhileImproving');
    const work = await mkdtemp(join(tmpdir(), 'narwal-export-improving-'));
    const speech = await speechWav(work);
    const b = await launch({ args: [`--use-file-for-fake-audio-capture=${speech.wav}`] });
    // Every note the recordings page writes, in order: the wait is short.
    await b.context.addInitScript(() => {
      if (!location.pathname.endsWith('/recordings.html')) return;
      globalThis.narwalNotes = [];
      addEventListener('DOMContentLoaded', () => {
        const note = document.getElementById('export-status');
        new MutationObserver(() => globalThis.narwalNotes.push(note.textContent)).observe(note, { childList: true, characterData: true, subtree: true });
      });
    });
    const nextDownload = (ms) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no export page download in ${ms / 1000} s`)), ms);
        b.context.once('page', (p) =>
          p.once('download', (download) => {
            clearTimeout(timer);
            resolve({ page: p, download });
          }),
        );
      });
    const bundleOf = async (from, got, recId) => {
      const path = join(work, `${from}.narwal.zip`);
      await got.download.saveAs(path);
      const x = await readBundle(path);
      const man = JSON.parse(x.text('manifest.json') || 'null');
      const active = man && man.transcript && man.transcript.activeRevision;
      const revision = JSON.parse((active && x.text(`transcript/${active}.json`)) || 'null');
      c.ok(`Export on the ${from} downloads a valid bundle of the recording just stopped`, x.result.ok && man.recordingId === bundleRecordingId(recId), { file: got.download.suggestedFilename(), errors: x.result.errors.slice(0, 5) });
      c.ok(`the ${from} bundle carries the improved transcript as the active one`, revision && revision.source === 'after-recording' && revision.provider === 'browser-local' && known(revision.segments.map((g) => g.text).join(' '), speech.words) >= 8, revision && { source: revision.source, provider: revision.provider, model: revision.model });
      await got.page.waitForFunction(() => /^Saved /.test(document.getElementById('export-status').textContent), null, { timeout: 10000 }).catch(() => {});
      return got.page.evaluate(() => globalThis.narwalNotes || []);
    };
    try {
      const installed = await b.sw((model) => globalThis.narwal.installModel(model), 'moonshine-base-q8');
      c.ok('the final model downloads', installed && installed.ok, installed);
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      const tabId = await tabIdOf(b, page);
      await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
      // The whole spoken passage, so the final pass takes a while.
      await sleep(30000);
      const stopped = await stopRec(b);
      c.ok('Stop saves the recording', stopped && stopped.ok, stopped);
      const improving = await stripUntil(page, /Improving the transcript on this computer/);
      c.ok('the strip says the transcript is being improved', /Improving the transcript on this computer/.test(improving.at(-1) || ''), improving);

      const fromStrip = nextDownload(300000);
      fromStrip.catch(() => {});
      // No purpose was given (board #17002): the page asks first, then waits for the transcript.
      const askedPage = b.context.waitForEvent('page', { timeout: 60000 });
      askedPage.catch(() => {});
      const pressed = await pressStripButton(page, 'export');
      if (pressed) await answerPurposeIfAsked(await askedPage);
      const atPress = await b.viewer.evaluate((id) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcript-state', id }), rec.id);
      c.ok('Export on the strip can be pressed while the transcript is improved', pressed && atPress.afterTranscript && atPress.afterTranscript.state === 'improving', atPress);
      if (pressed) {
        const notes = await bundleOf('strip', await fromStrip, rec.id);
        const waited = notes.find((n) => /^The transcript is still being improved on this computer \(\d+%\)\. The bundle downloads when it is ready\.$/.test(n));
        c.ok('the page the strip opened said it waits for the improved transcript, then that the bundle was saved', Boolean(waited) && /^Saved .*\.narwal\.zip\.$/.test(notes.at(-1) || ''), notes);
      }
      const job = await afterJobEnd(b, rec.id, 300000);
      c.ok('the improved transcript is ready', job && job.state === 'done' && job.activated, job);

      // The popup, just after the transcript arrived.
      const popup = await b.context.newPage();
      await popup.goto(b.url(`popup.html?tab=${tabId}`));
      const exportButton = popup.locator('.nw-banner [data-key="export"]');
      await popup.waitForFunction(() => document.querySelector('.nw-banner [data-key="export"]')?.textContent === 'Export', null, { timeout: 10000 }).catch(() => {});
      c.ok('the popup offers Export', (await exportButton.textContent()) === 'Export');
      const fromPopup = nextDownload(120000);
      await exportButton.click();
      const notes = await bundleOf('popup', await fromPopup, rec.id);
      c.ok('the page the popup opened says the bundle was saved', /^Saved .*\.narwal\.zip\.$/.test(notes.at(-1) || ''), notes);
      await popup.close().catch(() => {});
      return { checks: c.list };
    } finally {
      await b.close();
      await rm(work, { recursive: true, force: true });
    }
  },

  // The OpenAI transcript after Stop (board #16588), against the fixture
  // server's stand-in for OpenAI and a fake key. An "On this computer"
  // recording sends nothing. For the OpenAI recording the first upload is
  // refused (no Try again: the key must change), the second finds OpenAI busy
  // (Try again on the strip), the third makes the transcript. Export waits
  // while an upload runs, and an export made before the transcript arrived
  // does not keep later exports from it (review of NarWal#29). The key is in
  // no recording, status or export.
  async openaiAfter(fx) {
    const c = new Checks('openaiAfter');
    const b = await launch();
    const work = await mkdtemp(join(tmpdir(), 'narwal-openai-'));
    const key = `sk-test-fixture-16588-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 24)}Zq9X`;
    try {
      fx.openai.reset({ key, fail: [401, 429], delayMs: 1500 });
      const saved = await b.viewer.evaluate((k) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'save-key', provider: 'openai', key: k }), key);
      c.ok('the fake OpenAI key is saved', saved && saved.ok, saved);
      await b.sw((u) => globalThis.narwal.openAiEndpoint(u), `${fx.A}/openai/v1/audio/transcriptions`);

      // "On this computer", with the OpenAI key saved: nothing goes to OpenAI.
      const local = await b.context.newPage();
      await local.goto(`${fx.A}/page2.html`);
      await local.bringToFront();
      const localRec = await b.sw(([t]) => globalThis.narwal.start(t, 'offline'), [await tabIdOf(b, local)]);
      c.ok('a recording starts with the "On this computer" choice', localRec && localRec.ok, localRec);
      await sleep(3000);
      const localStopped = await stopRec(b);
      // Stop starts the final pass on this computer (#16603). This profile has
      // no Whisper model, so it ends at once as a model failure, with no
      // download and no Try again until a model is installed. Asking again
      // answers the same failure at once (the recordings page shows it).
      const localEnded = async () => {
        let state = null;
        for (let i = 0; i < 40; i += 1) {
          state = await b.viewer.evaluate((id) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcript-state', id }), localRec.id);
          if (state && state.afterTranscript && state.afterTranscript.state !== 'improving') break;
          await sleep(250);
        }
        return state;
      };
      const localJob = await localEnded();
      const localAsk = await b.viewer.evaluate((id) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcribe', id }), localRec.id);
      const localAgain = await localEnded();
      const modelFailure = (s) => s && s.afterTranscript && s.afterTranscript.provider === 'browser-local' && s.afterTranscript.state === 'failed' && s.afterTranscript.error.kind === 'model';
      c.ok(
        'an "On this computer" recording makes zero uploads, after Stop and when asked',
        localStopped && localStopped.ok && fx.openai.uploads.length === 0 && localAsk && localAsk.ok === false && localAsk.error === 'model-missing' && modelFailure(localJob) && modelFailure(localAgain),
        { uploads: fx.openai.uploads.length, localJob, localAsk, localAgain },
      );
      await local.close();

      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      await page.bringToFront();
      const tabId = await tabIdOf(b, page);
      const rec = await b.sw(([t]) => globalThis.narwal.start(t, 'openai'), [tabId]);
      c.ok('a recording starts with the OpenAI choice', rec && rec.ok, rec);
      await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
      await sleep(3000);
      await mark(page, 'openai-after');
      await sleep(5000);
      const stopped = await stopRec(b);
      c.ok('Stop saves the recording and starts the OpenAI job', stopped && stopped.ok, stopped);
      const statuses = [];
      // What the strip reads: ui-status from the recorded tab's content script.
      const job = async (until) => {
        for (let i = 0; i < 120; i += 1) {
          const ui = await contentScriptSend(page, { to: 'sw', cmd: 'ui-status' });
          statuses.push(ui);
          if (ui && until(ui.afterTranscript)) return ui;
          await sleep(250);
        }
        return statuses.at(-1);
      };
      const ended = (j) => j && j.state !== 'uploading';
      const failed = await job(ended);
      c.ok('the refused key ends the job as failed (auth)', failed.afterTranscript && failed.afterTranscript.state === 'failed' && failed.afterTranscript.error.kind === 'auth', failed.afterTranscript);
      const refusedText = JSON.stringify(failed.afterTranscript || null);
      c.ok("OpenAI's starred-out key is not in the saved failure, last characters included", refusedText.includes('[redacted]') && !refusedText.includes(key.slice(-4)), refusedText);
      const failedStrip = stripModel(toRecorderStatus(failed, { tabId }));
      c.ok('the strip shows the refused key with no Try again', !failedStrip.showRetry && failedStrip.showOpen && /No transcript: OpenAI did not accept the key/.test(failedStrip.message), failedStrip);
      const uploading = statuses.find((ui) => ui.afterTranscript && ui.afterTranscript.state === 'uploading');
      const uploadingStrip = uploading && stripModel(toRecorderStatus(uploading, { tabId }));
      c.ok('the strip showed progress while uploading', uploadingStrip && /Saved on this computer\. Getting the transcript from OpenAI…/.test(uploadingStrip.message) && uploadingStrip.tone === 'busy', statuses.map((ui) => ui.afterTranscript && ui.afterTranscript.state));
      c.ok('the strip holds Export while uploading: "Export when the transcript is ready" (#16602)', uploadingStrip && uploadingStrip.showExport && uploadingStrip.exportWaiting, uploadingStrip && { showExport: uploadingStrip.showExport, exportWaiting: uploadingStrip.exportWaiting });
      const refusedRetry = await contentScriptSend(page, { to: 'sw', cmd: 'retry-transcript' });
      await sleep(500);
      c.ok('the page cannot start an upload after a refused key', refusedRetry && !refusedRetry.ok && refusedRetry.error === 'not-retryable' && fx.openai.uploads.length === 1, { refusedRetry, uploads: fx.openai.uploads.length });

      const shownNow = () =>
        b.viewer.evaluate(() => ({
          status: document.getElementById('transcript-status').textContent,
          button: document.getElementById('transcript-get').hidden ? null : document.getElementById('transcript-get').textContent,
          lines: [...document.getElementById('transcript').querySelectorAll('li, p')].map((el) => el.textContent),
        }));
      const openShown = async () => {
        await b.viewer.reload();
        await b.viewer.locator('#list tbody tr', { hasText: 'Fixture index' }).getByRole('button', { name: 'Open' }).click();
        await b.viewer.waitForFunction(() => document.getElementById('transcript-status').textContent.length > 0, null, { timeout: 10000 });
        return shownNow();
      };
      const exportButton = b.viewer.locator('#list tbody tr', { hasText: 'Fixture index' }).getByRole('button', { name: 'Export bundle' });
      const failedPage = await openShown();
      c.ok(
        'the recordings page shows the refused key and asks again only on the user’s press',
        /OpenAI did not accept the key\. Put that right/.test(failedPage.status) && failedPage.button === 'Get the transcript from OpenAI',
        failedPage,
      );

      // Exported before any transcript arrived: later exports must still get it.
      const early = join(work, 'early.narwal.zip');
      await exportFromList(b.viewer, 'Fixture index', early);
      const e = await readBundle(early);
      c.ok('an export before the transcript arrives is valid and has no transcript', e.result.ok && ![...e.files.keys()].some((p) => p.startsWith('transcript/')), [...e.files.keys()]);

      // The purpose is changed on the library copy only (replay page, #16594): the transcript refresh keeps it.
      const PURPOSE = 'Each mark is a change request';
      const rp = await b.context.newPage();
      await rp.goto(b.url('replay.html'));
      await rp.waitForFunction(() => globalThis.__narwalReplayReady === true);
      const copyId = await rp.evaluate(async () => (await globalThis.__narwalLibrary.list()).find((r) => r.origin.kind === 'recorded').id);
      await rp.goto(b.url(`replay.html?id=${encodeURIComponent(copyId)}`));
      await rp.waitForFunction(() => globalThis.__narwalReplay?.player, null, { timeout: 60000 });
      await rp.fill('#purpose-input', PURPOSE);
      await rp.click('#save-purpose');
      await rp.waitForFunction((text) => document.querySelector('#purpose-text')?.textContent.includes(text), PURPOSE);
      await rp.close();

      // The user asks again on the recordings page; OpenAI is busy this time.
      fx.openai.delayMs = 5000;
      statuses.length = 0;
      const stripBefore = await stripMessage(page);
      const busyShown = stripUntil(page, /OpenAI is busy/);
      await b.viewer.locator('#transcript-get').click();
      await exportButton.and(b.viewer.locator(':disabled')).waitFor({ timeout: 4000 }).catch(() => {});
      const held = {
        disabled: await exportButton.isDisabled(),
        title: await exportButton.getAttribute('title'),
        refused: await b.viewer.evaluate((id) => globalThis.narwalViewer.exportRecording(id).then(() => 'exported', (err) => String(err && err.message)), rec.id),
      };
      c.ok('Export waits while the transcript is coming', held.disabled && /still coming from OpenAI/.test(held.title || '') && /still coming from OpenAI/.test(held.refused), held);
      const busy = await job(ended);
      c.ok('a busy OpenAI ends the job as failed (rate limit)', busy.afterTranscript && busy.afterTranscript.state === 'failed' && busy.afterTranscript.error.kind === 'rate-limit', busy.afterTranscript);
      const busyStrip = stripModel(toRecorderStatus(busy, { tabId }));
      c.ok('the strip shows the failure with Try again', busyStrip.showRetry && /No transcript: OpenAI is busy/.test(busyStrip.message), busyStrip);
      const busySeen = await busyShown;
      const progressAt = busySeen.findIndex((t) => /Getting the transcript from OpenAI…/.test(t));
      c.ok(
        'an open strip shows a job asked for on the recordings page: progress, then how it ended (#16598)',
        /OpenAI did not accept the key/.test(stripBefore || '') && progressAt >= 0 && /No transcript: OpenAI is busy/.test(busySeen.at(-1) || '') && busySeen.length - 1 > progressAt,
        { stripBefore, busySeen },
      );
      await b.viewer.waitForFunction(() => !document.getElementById('transcript-get').hidden && document.getElementById('transcript-get').textContent === 'Try again', null, { timeout: 10000 }).catch(() => {});
      const busyPage = await shownNow();
      c.ok('the recordings page shows the failure with Try again, and Export is back', /OpenAI is busy/.test(busyPage.status) && busyPage.button === 'Try again' && !(await exportButton.isDisabled()), busyPage);

      statuses.length = 0;
      // Sent past the strip's own port: only the service worker can tell the strip.
      const readyShown = stripUntil(page, /The OpenAI transcript is ready/);
      const retried = await contentScriptSend(page, { to: 'sw', cmd: 'retry-transcript' });
      c.ok('Try again on the strip starts a new upload', retried && retried.ok, retried);
      // A recordings page opened during the upload: Export waits, then comes back by itself.
      await b.viewer.reload();
      await exportButton.waitFor({ timeout: 10000 });
      const heldOnLoad = await exportButton.isDisabled();
      const ready = await job(ended);
      const readyStrip = stripModel(toRecorderStatus(ready, { tabId }));
      c.ok('the third upload makes the transcript', ready.afterTranscript && ready.afterTranscript.state === 'done' && ready.afterTranscript.activated, ready.afterTranscript);
      c.ok('the strip says the OpenAI transcript is ready', /The OpenAI transcript is ready/.test(readyStrip.message) && !readyStrip.showRetry, readyStrip);
      c.ok('the strip offers Export once the transcript is ready (#16602)', readyStrip.showExport && !readyStrip.exportWaiting, { showExport: readyStrip.showExport, exportWaiting: readyStrip.exportWaiting });
      const readySeen = await readyShown;
      c.ok(
        'the open strip shows a job it did not start: progress, then ready (#16598)',
        readySeen.some((t) => /Getting the transcript from OpenAI…/.test(t)) && /The OpenAI transcript is ready/.test(readySeen.at(-1) || ''),
        readySeen,
      );
      const released = await exportButton.and(b.viewer.locator(':enabled')).waitFor({ timeout: 10000 }).then(() => true, () => false);
      c.ok('a page opened during the upload holds Export until the transcript is ready', heldOnLoad && released, { heldOnLoad, released });
      const again = await contentScriptSend(page, { to: 'sw', cmd: 'retry-transcript' });
      await sleep(500);
      c.ok('the page cannot start a paid upload once the transcript is ready', again && !again.ok && again.error === 'not-retryable' && fx.openai.uploads.length === 3, { again, uploads: fx.openai.uploads.length });
      c.ok(
        'three uploads, all with the saved key, the whisper-1 form and the narration file',
        fx.openai.uploads.length === 3 && fx.openai.uploads.every((u) => u.keyMatched && u.model === 'whisper-1' && /^narration\./.test(u.file || '') && u.bytes > 1000),
        fx.openai.uploads,
      );

      const readyPage = await openShown();
      c.ok('the recordings page shows the transcript text', readyPage.lines.some((l) => l.includes('Revenue heading.')) && readyPage.button === null, readyPage);

      const zip = join(work, 'openai.narwal.zip');
      await exportFromList(b.viewer, 'Fixture index', zip);
      const note = await b.viewer.locator('#export-status').textContent();
      const x = await readBundle(zip);
      c.ok('the bundle is valid', x.result.ok, x.result.errors.slice(0, 5));
      const active = x.view && x.view.transcript;
      c.ok('the export after the transcript arrived carries the OpenAI revision as the active transcript', active && active.provider === 'openai' && active.model === 'whisper-1' && active.source === 'after-recording' && /^Saved [^ ]+\.$/.test(note || ''), { active, note });
      const transcriptFile = active && x.text(`transcript/${active.revisionId}.json`);
      c.ok('the transcript file holds the words', Boolean(transcriptFile) && transcriptFile.includes('Revenue heading.'), transcriptFile && transcriptFile.slice(0, 200));
      const walkthrough = x.text('agent/walkthrough.md') || '';
      c.ok('the agent walkthrough carries the transcript', walkthrough.includes('Revenue heading.') && walkthrough.includes('after-recording'), walkthrough.slice(0, 600));
      const readme = x.text('README.md') || '';
      c.ok(
        'the refreshed copy keeps the purpose set in the replay page, and its README is regenerated',
        JSON.parse(x.text('manifest.json')).purpose === PURPOSE && readme.includes(PURPOSE) && x.text('AGENTS.md') === readme,
        readme.slice(0, 400),
      );
      const stored = await b.viewer.evaluate(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('narwal');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const all = (name) =>
          new Promise((res, rej) => {
            const r = db.transaction(name).objectStore(name).getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
        const [recs, chunks] = [await all('recordings'), await all('chunks')];
        const blobs = [];
        for (const ch of chunks) if (ch.data instanceof Blob) blobs.push(await ch.data.text());
        db.close();
        return JSON.stringify(recs) + JSON.stringify(chunks) + blobs.join('');
      });
      const zips = [await readFile(early), await readFile(zip)];
      const leaks = {};
      for (const [name, secret] of [['key', key], ['suffix', key.slice(-4)]]) {
        leaks[name] = {
          recording: stored.includes(secret),
          status: JSON.stringify(statuses).includes(secret),
          export: zips.some((bytes) => bytes.includes(Buffer.from(secret))) || [...e.files.values(), ...x.files.values()].some((f) => Buffer.from(f).includes(Buffer.from(secret))),
        };
      }
      c.ok('the key is in no recording, status or export, and neither are its last characters', !Object.values(leaks).some((l) => l.recording || l.status || l.export), leaks);
      return { checks: c.list };
    } finally {
      await b.close();
      await rm(work, { recursive: true, force: true });
    }
  },

  // Two recordings in one tab (board #16551 review): the strip of the first
  // recording is replaced, so the second has a working Stop. A content script
  // in another tab gets no ui-status (it carries transcript text).
  async controlsTwice(fx) {
    const c = new Checks('controlsTwice');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const other = await b.context.newPage();
      const tabId = await tabIdOf(b, page);
      const focusAndEnter = async () => {
        await page.bringToFront();
        await b.sw((t) => chrome.tabs.sendMessage(t, { to: 'strip', cmd: 'focus' }, { frameId: 0 }), tabId);
        await page.keyboard.press('Enter');
        let st = null;
        for (let i = 0; i < 40; i += 1) {
          st = await status(b);
          if (!st.live && st.lastResult) break;
          await sleep(250);
        }
        return st;
      };
      const ids = [];
      for (const round of [1, 2]) {
        const rec = await startRec(b, page);
        ids.push(rec.id);
        await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
        await sleep(2000);
        const hosts = await page.evaluate(() => document.querySelectorAll('[data-narwal-ui="strip"]').length);
        c.ok(`recording ${round}: one strip in the page`, hosts === 1, hosts);
        if (round === 1) {
          // A document loaded while recording gets the content script, in any tab.
          await other.goto(`${fx.B}/index.html`);
          await sleep(500);
          // That tab's content script (its isolated world) asks for the strip status.
          const answer = await contentScriptSend(other, { to: 'sw', cmd: 'ui-status' });
          c.ok('another tab gets no ui-status while recording', answer && answer.ok === false && answer.error === 'not-allowed' && !answer.live, answer);
        }
        const st = await focusAndEnter();
        c.ok(`recording ${round}: focus shortcut then Enter stops it`, !st.live && st.lastResult && st.lastResult.id === rec.id && st.lastResult.stopReason === 'user', st.lastResult);
      }
      c.ok('two different recordings', ids[0] !== ids[1], ids);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Two starts at once (popup and permission page): one records, the other is
  // refused, and the first recording is not killed (board #16568).
  async concurrentStarts(fx) {
    const c = new Checks('concurrentStarts');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      await page.bringToFront();
      const tabId = await tabIdOf(b, page);
      const replies = await b.viewer.evaluate((t) => Promise.all([0, 1].map(() => chrome.runtime.sendMessage({ to: 'sw', cmd: 'start', tabId: t }))), tabId);
      const won = replies.filter((r) => r.ok);
      c.ok('one start wins, the other is refused as already-recording', won.length === 1 && replies.some((r) => !r.ok && r.error === 'already-recording'), replies);
      const id = won[0] && won[0].id;
      await sleep(2000);
      await mark(page, 'after-double-start');
      await sleep(1200);
      const st = await status(b);
      c.ok('the winning recording is live and its recorder is recording', st.live && st.live.id === id && st.recorder && st.recorder.recording && st.recorder.id === id, { live: st.live, recorder: st.recorder && { id: st.recorder.id, state: st.recorder.state } });
      const stopped = await stopRec(b);
      c.ok('stop is normal', stopped.ok && stopped.id === id && stopped.stopReason === 'user', stopped);
      const r = await reopen(b, id, { needles: ['marker:after-double-start'] });
      c.ok('reopens as stopped (user) with no restarts', r.meta.status === 'stopped' && r.meta.stopReason === 'user' && r.meta.restarts === 0, r.meta);
      c.ok('page captured', r.found['marker:after-double-start']);
      c.ok('one audio part that decodes', r.audio.length === 1 && typeof r.audio[0].decodedMs === 'number', r.audio);
      c.ok('no gaps', r.gaps.length === 0, r.gaps);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Markers and interactions (board #16571): right-click marks with no page
  // menu, Shift+right-click passes through, a right-drag of 6 px or more
  // draws a box, Esc cancels it, Alt+Shift+M marks the focused item in the
  // focused frame, and the exported bundle holds all of it, masked. Query
  // values in page, frame, link and pushState URLs are not in any exported
  // file (urlPolicy redact-query-values).
  async markers(fx) {
    const c = new Checks('markers');
    const b = await launch();
    try {
      const commands = await b.sw(() => chrome.commands.getAll());
      const cmd = commands.find((x) => x.name === 'mark-focused');
      c.ok('Alt+Shift+M is bound to mark-focused', cmd && cmd.shortcut === 'Alt+Shift+M', commands);

      const page = await b.context.newPage();
      await page.goto(`${fx.A}/markers.html?token=SECRETTOKEN42`);
      const rec = await startRec(b, page);
      const tabId = await tabIdOf(b, page);
      await sleep(1000);
      const right = { button: 'right' };

      await page.mouse.click(140, 70, right);
      await sleep(300);
      let seen = await page.evaluate(() => ({ menus: window.pageMenus.length, presses: window.pagePresses }));
      c.ok('right-click: the page gets no press and no menu', seen.menus === 0 && seen.presses === 0, seen);

      await page.keyboard.down('Shift');
      await page.mouse.click(100, 190, right);
      await page.keyboard.up('Shift');
      await sleep(300);
      seen = await page.evaluate(() => window.pageMenus);
      c.ok('Shift+right-click: the page menu opens', seen.length === 1 && seen[0].shift && !seen[0].prevented, seen);

      await page.mouse.move(30, 150);
      await page.mouse.down(right);
      await page.mouse.move(200, 260, { steps: 6 });
      await page.mouse.move(450, 370, { steps: 6 });
      await page.mouse.up(right);
      await sleep(300);

      await page.mouse.move(60, 520);
      await page.mouse.down(right);
      await page.mouse.move(200, 600, { steps: 5 });
      await page.keyboard.press('Escape');
      await page.mouse.up(right);
      await sleep(300);

      // Under the 6 px threshold a drag is a click mark, not a box.
      await page.mouse.move(140, 70);
      await page.mouse.down(right);
      await page.mouse.move(144, 72, { steps: 2 });
      await page.mouse.up(right);
      await sleep(300);
      seen = await page.evaluate(() => ({ menus: window.pageMenus.length, presses: window.pagePresses }));
      c.ok('drags and Esc: still no page menu or press', seen.menus === 1 && seen.presses === 1, seen);

      await page.evaluate(() => history.pushState({}, '', '?step=PUSHSECRET3'));
      await page.evaluate(() => document.getElementById('next').setAttribute('href', '/frame.html?key=MUTSECRET1'));
      await page.fill('#secret', 'typed-while-recording');
      await page.focus('#focus-me');
      await page.keyboard.press('Alt+Shift+KeyM');
      await sleep(700);
      await page.focus('#target');
      await b.sw(([id]) => globalThis.narwal.command('mark-focused', { id }), [tabId]);
      await sleep(700);
      await page.frameLocator('#inner').locator('#in-frame').focus();
      await b.sw(([id]) => globalThis.narwal.command('mark-focused', { id }), [tabId]);
      await sleep(700);
      // Another tab's command is not this recording's.
      await b.sw(() => globalThis.narwal.command('mark-focused', { id: -1 }));
      await sleep(1200);
      const uiHosts = await page.evaluate(() => [...document.querySelectorAll('[data-narwal-ui]')].map((el) => el.getAttribute('data-narwal-ui')));
      c.ok('the page holds NarWal UI while recording (strip, marker layer)', uiHosts.includes('strip') && uiHosts.length >= 2, uiHosts);
      const stopped = await stopRec(b);
      c.ok('stop is normal', stopped.ok && stopped.stopReason === 'user', stopped.stopReason);
      // Board #16603 review item 1: with no model for after Stop installed, the
      // improved-transcript job fails at once and Export is not held back.
      const job = await afterJobEnd(b, rec.id, 10000);
      c.ok('no final model installed: the job after Stop fails at once and keeps the live transcript', job && job.state === 'failed' && job.error && job.error.kind === 'model' && job.error.code === 'model-missing', job);

      const out = await b.viewer.evaluate(async ([id, secrets]) => {
        const r = await globalThis.narwalViewer.exportRecording(id);
        const dec = new TextDecoder();
        const read = (p) => dec.decode(r.files.get(p));
        const text = [...r.files.keys()].filter((p) => !p.endsWith('.webm')).map(read).join('\n');
        return {
          fileName: r.fileName,
          size: r.bytes.length,
          obs: read('observations.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
          docs: JSON.parse(read('documents.json')).documents.map((d) => ({ key: d.key, frameId: d.frameId, url: d.url })),
          md: read('agent/walkthrough.md'),
          leaked: secrets.filter((s) => text.includes(s)),
          rrwebFiles: [...r.files.keys()].filter((p) => p.startsWith('rrweb/')),
          uiInRrweb: [...r.files.keys()]
            .filter((p) => p.startsWith('rrweb/'))
            .flatMap((p) => read(p).split('\n').filter((l) => l.includes('narwal-ui')).map((l) => `${p}: ${l.slice(Math.max(0, l.indexOf('narwal-ui') - 300), l.indexOf('narwal-ui') + 200)}`)),
        };
      }, [rec.id, ['typed-while-recording', 'SECRETTOKEN42', 'FRAMESECRET9', 'LINKSECRET7', 'PUSHSECRET3', 'MUTSECRET1']]);
      c.ok('the export is a bundle archive', out.fileName.endsWith('.narwal.zip') && out.size > 1000, { fileName: out.fileName, size: out.size });
      const top = out.docs.find((d) => d.frameId === 0);
      const frame = out.docs.find((d) => d.frameId !== 0);
      const marks = out.obs.filter((o) => o.kind === 'marker-element');
      const named = (o) => o.target && o.target.name;
      const clicks = marks.filter((o) => o.via === 'right-click');
      c.ok('right-click marks are in the bundle', clicks.length === 2 && clicks.every((o) => named(o) === 'Mark target' && o.doc === top.key && typeof o.target.node === 'number'), clicks);
      const regions = out.obs.filter((o) => o.kind === 'marker-region');
      const contains = regions[0] ? regions[0].contains.map((e) => e.name) : [];
      c.ok('one box: the drag, not the cancelled one', regions.length === 1 && contains.includes('Alpha') && contains.includes('Beta') && regions[0].rect.w >= 400, regions);
      c.ok('the box carries the text inside it', regions[0] && /Alpha/.test(regions[0].text) && /Beta/.test(regions[0].text), regions[0] && regions[0].text);
      const keys = marks.filter((o) => o.via === 'keyboard-focus').map((o) => [named(o), o.doc === top.key ? 'top' : o.doc === (frame && frame.key) ? 'frame' : o.doc]);
      c.ok('Alt+Shift+M marks the focused item, once, in the focused frame', JSON.stringify(keys) === JSON.stringify([['Focus me', 'top'], ['Mark target', 'top'], ['Frame button', 'frame']]), keys);
      const input = out.obs.find((o) => o.kind === 'input');
      c.ok('the edit is in the bundle, masked', input && named(input) === 'Secret' && input.value.state === 'masked', input);
      c.ok('typed text and URL query values are not in the bundle', out.leaked.length === 0, out.leaked);
      c.ok('no NarWal UI placeholder (strip, marker layer) is in the exported rrweb', out.rrwebFiles.length > 0 && out.uiInRrweb.length === 0, { rrwebFiles: out.rrwebFiles, uiInRrweb: out.uiInRrweb });
      c.ok('the walkthrough lists the markers', /marked element "Mark target"/.test(out.md) && /marked box/.test(out.md), out.md.slice(0, 600));
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Page titles (board #16590): every document in the exported bundle has
  // its page title, not only the page open at Start: after a link, a typed
  // URL, in a child frame, and when a script sets the title after load. A
  // title set after an in-page route change belongs to that route, not to
  // the document.
  async pageTitles(fx) {
    const c = new Checks('pageTitles');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await sleep(800);
      await Promise.all([page.waitForURL(`${fx.A}/page2.html`), page.click('#to-page2')]);
      await sleep(500);
      await page.goto(`${fx.A}/markers.html`);
      await sleep(800);
      await page.goto(`${fx.A}/spa.html`);
      await sleep(500);
      await page.evaluate(() => { document.title = 'SPA home'; });
      await sleep(400);
      await page.click('#route-1');
      await sleep(200);
      await page.evaluate(() => { document.title = 'SPA route 1'; });
      await sleep(1200);
      const stopped = await stopRec(b);
      c.ok('stop is normal', stopped.ok && stopped.stopReason === 'user', stopped.stopReason);
      // Export waits for the job after Stop (board #16603): let it end first.
      await afterJobEnd(b, rec.id, 10000);

      const out = await b.viewer.evaluate(async (id) => {
        const r = await globalThis.narwalViewer.exportRecording(id);
        const dec = new TextDecoder();
        const read = (p) => dec.decode(r.files.get(p));
        return {
          docs: JSON.parse(read('documents.json')).documents.map((d) => ({ key: d.key, frameId: d.frameId, url: d.url, rrweb: d.rrweb, title: d.title })),
          routes: read('observations.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.kind === 'route').map((o) => ({ doc: o.doc, transition: o.transition, title: o.title })),
          view: JSON.parse(read('agent/walkthrough.json')).documents.map((d) => ({ key: d.key, title: d.title })),
          pages: read('agent/walkthrough.md').split('\n').find((l) => l.startsWith('- Pages: ')) || '',
        };
      }, rec.id);
      // A frame that was removed before it had content (rrweb opens an empty
      // one for a moment) has no rrweb stream and no page, so no title.
      const captured = out.docs.filter((d) => d.rrweb !== null);
      const titles = ['Fixture index', 'Fixture page 2', 'Fixture markers', 'Fixture frame', 'SPA home'];
      c.ok('every captured document in documents.json has its page title', JSON.stringify(captured.map((d) => d.title)) === JSON.stringify(titles), out.docs);
      const top = out.docs.filter((d) => d.frameId === 0);
      c.ok('the pages after the first one are among them', JSON.stringify(top.map((d) => [new URL(d.url).pathname, d.title])) === JSON.stringify([['/index.html', titles[0]], ['/page2.html', titles[1]], ['/markers.html', titles[2]], ['/spa.html', titles[4]]]), top);
      c.ok('the child frame has its own title', captured.some((d) => d.frameId !== 0 && d.title === 'Fixture frame'), captured);
      c.ok('the walkthrough Pages line names every page', top.length === 4 && top.every((d) => d.title !== '' && out.pages.includes(`${d.key} "${d.title}" ${d.url}`)), out.pages);
      c.ok('walkthrough.json has the same titles', JSON.stringify(out.view) === JSON.stringify(out.docs.map((d) => ({ key: d.key, title: d.title }))), out.view);
      const loads = out.routes.filter((r) => r.transition !== 'history-push');
      c.ok('each page load route has its page title', loads.length === 4 && loads.every((r) => r.title !== '' && r.title === top.find((d) => d.key === r.doc).title), out.routes);
      const pushed = out.routes.filter((r) => r.transition === 'history-push');
      c.ok('the in-page route has the title set for it', pushed.length === 1 && pushed[0].title === 'SPA route 1', out.routes);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Hide areas before recording (board #16592): picked in the page from the
  // popup, kept for that page across a reload, blocked in rrweb, excluded in
  // the observations, counted in the bundle and striped in replay. A frame in
  // an area, text added to it later and an area the site marks stay out; an
  // area the page lost blocks Start, and a page that loses one while recording
  // records no body.
  async hiddenRegions(fx) {
    const c = new Checks('hiddenRegions');
    const b = await launch();
    const HIDDEN = ['HIDDEN-AREA-SECRET-5', 'HIDDEN-BTN-SECRET-6', 'FRAME-SECRET-9', 'FRAME-BTN-SECRET-12', 'SITE-MARKED-SECRET-10'];
    const hiddenCount = (tabId) => b.viewer.evaluate((t) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'hidden-regions', tabId: t }).then((r) => r.count), tabId);
    // Export waits for the job after Stop (board #16603): let it end first.
    const exportText = (id) =>
      afterJobEnd(b, id, 10000).then(() => b.viewer.evaluate(async (rid) => {
        const r = await globalThis.narwalViewer.exportRecording(rid);
        const dec = new TextDecoder();
        const read = (p) => dec.decode(r.files.get(p));
        return {
          text: [...r.files.keys()].filter((p) => !p.endsWith('.webm')).map(read).join('\n'),
          obs: read('observations.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
          privacy: r.manifest.privacy,
          md: read('agent/walkthrough.md'),
          docs: JSON.parse(read('documents.json')).documents.map((d) => ({ url: d.url, frameId: d.frameId })),
        };
      }, id));
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/hide.html`);
      const tabId = await tabIdOf(b, page);

      const popup = await b.context.newPage();
      await popup.goto(b.url(`popup.html?tab=${tabId}`));
      const hide = popup.locator('[data-key="hide-areas"]');
      await hide.waitFor();
      c.ok('the popup offers Hide areas and says nothing is hidden yet', (await popup.locator('.nw-hide-text').textContent()).startsWith('Nothing hidden.'), await popup.locator('.nw-hide-text').textContent());
      await hide.click();
      await page.waitForSelector('[data-narwal-ui="picker"]', { state: 'attached', timeout: 10000 });
      await popup.close().catch(() => {});

      await page.mouse.move(60, 130);
      await page.mouse.click(60, 130);
      await sleep(300);
      let seen = await page.evaluate(() => ({ marked: document.getElementById('account').hasAttribute('data-narwal-exclude'), clicks: window.pageClicks.length }));
      c.ok('a click picks the area; the page gets no click', seen.marked && seen.clicks === 0, seen);
      // The area the site marks: a click does not show it.
      await page.mouse.move(660, 160);
      await page.mouse.click(660, 160);
      await sleep(300);
      seen = await page.evaluate(() => ({ site: document.getElementById('site').hasAttribute('data-narwal-exclude'), said: document.querySelector('[data-narwal-ui="highlights"]')?.textContent || '' }));
      c.ok('a click in the area the site marks keeps it hidden and says so', seen.site, seen);
      await mkdir(RESULTS, { recursive: true });
      await page.screenshot({ path: join(RESULTS, 'hide-areas-picker.png') });
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-narwal-ui="picker"]', { state: 'detached', timeout: 5000 });
      let count = 0;
      for (let i = 0; i < 20 && count !== 1; i += 1) {
        count = await hiddenCount(tabId);
        if (count !== 1) await sleep(150);
      }
      c.ok('Enter ends picking; the service worker holds one area for the tab, not the one the site marks', count === 1, count);

      const again = await b.context.newPage();
      await again.goto(b.url(`popup.html?tab=${tabId}`));
      await again.waitForFunction(() => /1 area of this page/.test(document.querySelector('.nw-hide-text')?.textContent || ''));
      c.ok('the popup then says 1 area is left out and offers a change', (await again.locator('[data-key="hide-areas"]').textContent()) === 'Change hidden areas');
      await again.close();

      // A reload drops the attribute: the stored selector alone hides the area.
      await page.reload();
      const marked = await page.evaluate(() => document.getElementById('account').hasAttribute('data-narwal-exclude'));
      c.ok('after a reload the page itself marks nothing', !marked, marked);
      const rec1 = await startRec(b, page);
      await sleep(1000);
      const refused = await b.viewer.evaluate((t) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'pick-regions', tabId: t }), tabId);
      c.ok('Hide areas is refused while recording', refused && refused.ok === false && refused.error === 'already-recording', refused);
      await page.click('#inside');
      // Text the page adds to the area after Start.
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.textContent = 'Late LATE-AREA-SECRET-11';
        document.getElementById('account').appendChild(p);
      });
      await sleep(1200);
      seen = await page.evaluate(() => window.pageClicks);
      c.ok('the hidden area still works in the page', seen.includes('inside'), seen);
      const stopped1 = await stopRec(b);
      c.ok('stop is normal', stopped1.ok && stopped1.stopReason === 'user', stopped1.stopReason);

      const out1 = await exportText(rec1.id);
      const leaked1 = [...HIDDEN, 'LATE-AREA-SECRET-11'].filter((s) => out1.text.includes(s));
      c.ok('the hidden text, the frame in the area, later text and the site area are in no exported file', leaked1.length === 0, leaked1);
      c.ok('the frame in the area is no exported document', out1.docs.length >= 1 && !out1.docs.some((d) => /hide-frame/.test(d.url)), out1.docs);
      c.ok('page text outside the area is kept', out1.text.includes('VISIBLE-CONTEXT-TEXT') && out1.text.includes('OTHER-AREA-SECRET-8'));
      const click = out1.obs.find((o) => o.kind === 'click' && o.target && o.target.excluded);
      c.ok('the click inside is excluded: true with no name', click && !click.target.name && click.target.excluded === true, click && click.target);
      const exclusions = out1.obs.filter((o) => o.kind === 'exclusion' && o.state === 'added');
      c.ok('the bundle counts the picked area and the two the site marks', out1.privacy.excludedRegions === 3 && exclusions.length === 3 && /\b3 excluded regions\b/.test(out1.md), { privacy: out1.privacy, exclusions: exclusions.length });

      const rp = await b.context.newPage();
      const replayErrors = [];
      rp.on('pageerror', (err) => replayErrors.push(String(err)));
      await rp.goto(b.url('replay.html'));
      await rp.waitForFunction(() => globalThis.__narwalReplayReady === true);
      await rp.click('#list tbody button');
      await rp.waitForURL(/\?id=/);
      await rp.waitForFunction(() => globalThis.__narwalReplay?.player, null, { timeout: 60000 });
      await rp.evaluate(() => globalThis.__narwalReplay.player.seek(1500));
      await rp.waitForFunction(() => globalThis.__narwalReplay.player.frame?.contentDocument?.querySelector('.narwal-hidden-area'), null, { timeout: 20000 }).catch(() => {});
      const shown = await rp.evaluate(() => {
        const doc = globalThis.__narwalReplay.player.frame.contentDocument;
        const area = doc.querySelector('.narwal-hidden-area');
        if (!area) return { missing: true };
        const box = area.getBoundingClientRect();
        return { w: box.width, h: box.height, text: area.textContent, background: doc.defaultView.getComputedStyle(area).backgroundImage, page: doc.body.textContent };
      });
      c.ok('replay shows the area as a striped box of its size, without its text', shown.w > 400 && shown.h > 100 && shown.text === '' && /repeating-linear-gradient/.test(shown.background) && shown.page.includes('VISIBLE-CONTEXT-TEXT'), shown);
      c.ok('replay has no page errors', replayErrors.length === 0, replayErrors);
      await rp.close();

      // The text added to the area changed it, but its id is the same: a
      // live area is still found, so the popup still counts it.
      c.ok('an area whose text changed is still found by its id', (await hiddenCount(tabId)) === 1);
      // Start while the picker is still open: the open picker's selection counts.
      await page.reload();
      await page.bringToFront();
      const opened = await b.viewer.evaluate((t) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'pick-regions', tabId: t }), tabId);
      await page.waitForSelector('[data-narwal-ui="picker"]', { state: 'attached', timeout: 10000 });
      const remarked = await page.evaluate(() => document.getElementById('account').hasAttribute('data-narwal-exclude'));
      c.ok('the picker opens with the area picked before', opened.ok && remarked, { opened, remarked });
      await page.mouse.move(60, 370);
      await page.mouse.click(60, 370);
      await sleep(300);
      const rec2 = await startRec(b, page);
      await sleep(1000);
      const left = await page.evaluate(() => document.querySelectorAll('[data-narwal-ui="picker"]').length);
      c.ok('Start ends the picker', left === 0, left);
      c.ok('both areas are held for the tab', (await hiddenCount(tabId)) === 2);
      await stopRec(b);
      const out2 = await exportText(rec2.id);
      const leaked2 = [...HIDDEN, 'OTHER-AREA-SECRET-8'].filter((s) => out2.text.includes(s));
      c.ok('the second recording hides both areas', leaked2.length === 0 && out2.text.includes('VISIBLE-CONTEXT-TEXT') && out2.privacy.excludedRegions === 4, { leaked2, privacy: out2.privacy });

      // The picker opened twice without a reload: the areas the user hid the
      // first time still carry the attribute, and stay the user's (not the site's).
      const waitCount = async (n) => {
        let got = -1;
        for (let i = 0; i < 20 && got !== n; i += 1) {
          got = await hiddenCount(tabId);
          if (got !== n) await sleep(150);
        }
        return got;
      };
      const pickOnce = async (x, y) => {
        await b.viewer.evaluate((t) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'pick-regions', tabId: t }), tabId);
        await page.waitForSelector('[data-narwal-ui="picker"]', { state: 'attached', timeout: 10000 });
        await page.mouse.move(x, y);
        await page.mouse.click(x, y);
        await sleep(300);
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-narwal-ui="picker"]', { state: 'detached', timeout: 5000 });
      };
      await page.reload();
      await page.bringToFront();
      await pickOnce(60, 370); // shows the other area again: only the account is left
      c.ok('a picker can show an area again', (await waitCount(1)) === 1);
      await pickOnce(60, 370); // same document, no reload: hides it again
      const twice = await waitCount(2);
      c.ok('a second picker without a reload keeps the first picker\'s area', twice === 2, twice);
      await page.reload();
      const rec4 = await startRec(b, page);
      await sleep(1000);
      await stopRec(b);
      const out4 = await exportText(rec4.id);
      const leaked4 = [...HIDDEN, 'OTHER-AREA-SECRET-8'].filter((s) => out4.text.includes(s));
      c.ok('after a reload both areas from the two pickers are hidden', leaked4.length === 0 && out4.text.includes('VISIBLE-CONTEXT-TEXT') && out4.privacy.excludedRegions === 4, { leaked4, privacy: out4.privacy });

      // The page loads another section first: the selectors find other
      // elements, so Start is refused and the popup asks for a new pick.
      await page.goto(`${fx.A}/hide.html?shift=1`);
      const stale = await b.sw((id) => globalThis.narwal.start(id), tabId);
      c.ok('Start is refused when the hidden areas are not found', stale && stale.ok === false && stale.error === 'hidden-areas-lost' && stale.lost === 2 && /^2 hidden areas could not be found/.test(stale.message), stale);
      c.ok('a lost area is not counted as hidden', (await hiddenCount(tabId)) === 0);
      const blocker = await b.context.newPage();
      await blocker.goto(b.url(`popup.html?tab=${tabId}`));
      await blocker.locator('[data-check="hidden"]').waitFor({ timeout: 10000 });
      const blockerText = await blocker.locator('[data-check="hidden"]').innerText();
      c.ok('the popup shows the lost areas with Pick again', /2 hidden areas could not be found/.test(blockerText) && /Pick again/.test(blockerText), blockerText);
      c.ok('the popup Start is blocked', (await blocker.getByRole('button', { name: 'Start recording' }).first().getAttribute('aria-disabled')) === 'true');
      await mkdir(RESULTS, { recursive: true });
      await blocker.screenshot({ path: join(RESULTS, 'hide-areas-lost-popup.png'), fullPage: true });
      await blocker.close();

      // The page changes after Start: that document records no body at all.
      await page.goto(`${fx.A}/hide.html`);
      const rec3 = await startRec(b, page);
      await sleep(800);
      await page.goto(`${fx.A}/hide.html?shift=1`);
      await sleep(2000);
      await stopRec(b);
      const out3 = await exportText(rec3.id);
      const leaked3 = [...HIDDEN, 'OTHER-AREA-SECRET-8', 'SHIFTED-PAGE-TEXT'].filter((s) => out3.text.includes(s));
      c.ok('a page that lost an area after Start records no body', leaked3.length === 0 && out3.text.includes('VISIBLE-CONTEXT-TEXT') && out3.docs.filter((d) => d.frameId === 0).length === 2, { leaked3, docs: out3.docs });
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // A transcription consumer that throws on every chunk does not stop capture.
  // The speech model picker (board #16611): every model is a row with its
  // measured bars; one this machine cannot run (no WebGPU in headless) is
  // greyed with the reason; nothing downloads until a click. The pick is
  // saved by Use this model (Back leaves it, board #16623), the start view
  // names it, and the recording keeps it.
  async modelPicker(fx) {
    const c = new Checks('modelPicker');
    const b = await launch();
    try {
      const picker = await b.context.newPage();
      await picker.goto(b.url('model.html'));
      await picker.evaluate(() => globalThis.narwalModelPage);
      const rows = await picker.$$eval('.model', (els) =>
        els.map((el) => ({
          id: el.dataset.model,
          name: el.querySelector('.model-name').textContent,
          state: el.dataset.state,
          cannot: el.classList.contains('cannot'),
          disabled: el.querySelector('input').disabled,
          why: el.querySelector('.model-why').hidden ? '' : el.querySelector('.model-why').textContent,
          bars: [...el.querySelectorAll('.nw-rating')].map((bar) => bar.getAttribute('aria-label')),
          action: el.querySelector('button[data-action]').dataset.action,
        })),
      );
      c.ok(
        'every model is a row, most accurate first, each with an accuracy and a speed bar and a Download button',
        rows.length >= 5 && rows.every((r) => r.bars.length === 2 && /^Accuracy: [1-5] of 5$/.test(r.bars[0]) && /^Speed: [1-5] of 5$/.test(r.bars[1]) && r.action === 'download'),
        rows,
      );
      const turbo = rows.find((r) => r.id === 'whisper-large-v3-turbo');
      c.ok('no WebGPU here: large-v3-turbo is listed greyed with the reason, and cannot be picked', turbo && turbo.cannot && turbo.disabled && /Needs WebGPU/.test(turbo.why), turbo);
      c.ok('opening the page downloads nothing', rows.every((r) => r.state === 'missing'), rows.map((r) => r.state));
      const measured = await picker.$eval('[data-model="whisper-small.en-q8"] .nw-rating', (bar) => bar.title);
      c.ok('the numbers are on hover: accuracy and word error rate measured in the extension', measured === '91% of words right (word error rate 9%, in the extension, browser wasm)', measured);
      const where = await picker.$eval('#measured-where', (el) => el.textContent);
      c.ok(
        'one line says every number is from this extension, all but turbo on the same passage, turbo on a different take (#16621)',
        /measured in this extension\. All but Whisper large-v3-turbo ran on the same 113-second reading passage\. Turbo's come from a different take/.test(where),
        where,
      );
      const turboMeasured = await picker.$eval('[data-model="whisper-large-v3-turbo"] .nw-rating', (bar) => bar.title);
      c.ok("turbo's number is Matt's WebGPU run in the extension (#16621)", turboMeasured === "90.6% of words right (word error rate 9.4%, in the extension, WebGPU, Matt's Mac)", turboMeasured);
      const takes = await picker.$$eval('[data-take="other"]', (els) => els.map((el) => [el.closest('[data-model]').dataset.model, el.textContent]));
      c.ok('only turbo is marked "measured on a different take" (#16621)', JSON.stringify(takes) === JSON.stringify([['whisper-large-v3-turbo', '(measured on a different take)']]), takes);
      const turboDetail = await picker.$eval('[data-model="whisper-large-v3-turbo"] .model-more dd', (dd) => dd.textContent);
      c.ok("turbo's Measured detail names the other take, not the 113-second passage (#16621)", /on a different take: Matt's separate 120-second recording/.test(turboDetail) && !/113-second/.test(turboDetail), turboDetail);
      const parakeet = rows.find((r) => r.id === 'parakeet-tdt-0.6b-v2-int8');
      const tiers = await picker.$$eval('.model', (els) => Object.fromEntries(els.map((el) => [el.dataset.model, el.querySelector('[data-tier]')?.dataset.tier || null])));
      c.ok('Parakeet is a row, and each row names the tier it needs', parakeet && !parakeet.cannot && tiers['whisper-large-v3-turbo'] === 'webgpu' && tiers['parakeet-tdt-0.6b-v2-int8'] === 'wasm', tiers);
      c.ok('the Parakeet row says it also makes the live text once downloaded (#16617)', /also makes the live text/.test(parakeet?.why || ''), parakeet?.why);

      // Open "Measured" on one row for the screenshots, in light and dark.
      await picker.click('[data-model="whisper-small.en-q8"] summary');
      await mkdir(RESULTS, { recursive: true });
      for (const scheme of ['light', 'dark']) {
        await picker.emulateMedia({ colorScheme: scheme });
        await picker.screenshot({ path: join(RESULTS, `model-picker-${scheme}.png`), fullPage: true });
      }
      await picker.emulateMedia({ colorScheme: 'light' });

      // Parakeet is this machine's first model with no pick; base.en is a real change.
      const before = await picker.$eval('.model.picked', (el) => el.dataset.model);
      c.ok('with no pick, the row of the model this computer runs first is marked', before === 'parakeet-tdt-0.6b-v2-int8', before);
      const prefsBecome = async (id) => {
        let prefs = {};
        for (let i = 0; i < 20 && prefs.offlineModel !== id; i += 1) {
          prefs = await b.sw(() => chrome.storage.local.get('narwal.prefs.v1').then((all) => all['narwal.prefs.v1'] || {}));
          await sleep(100);
        }
        return prefs;
      };
      const savedPick = () => b.sw(() => chrome.storage.local.get('narwal.prefs.v1').then((all) => (all['narwal.prefs.v1'] || {}).offlineModel ?? null));

      // A click only marks the row (board #16623); Back on a page opened
      // directly goes to the recordings page and saves nothing.
      await picker.click('label[for="model-whisper-base.en-q8"]');
      const marked = await picker.$eval('.model.picked', (el) => el.dataset.model);
      const bar = await picker.locator('.choose').innerText();
      c.ok('a click marks the row and the bar names it, with Back and Use this model', marked === 'whisper-base.en-q8' && /Picked: Whisper base\.en/.test(bar) && /Back/.test(bar) && /Use this model/.test(bar), { marked, bar });
      for (const scheme of ['light', 'dark']) {
        await picker.emulateMedia({ colorScheme: scheme });
        await picker.screenshot({ path: join(RESULTS, `model-picker-choose-${scheme}.png`) });
      }
      await picker.emulateMedia({ colorScheme: 'light' });
      await sleep(300);
      c.ok('a click alone saves nothing', (await savedPick()) === null, await savedPick());
      await picker.getByRole('button', { name: 'Back', exact: true }).click();
      await picker.waitForURL(/\/recordings\.html$/, { timeout: 10000 });
      c.ok('Back with no tab to go back to opens the recordings page and leaves the pick as it was', (await savedPick()) === null, picker.url());

      // From the popup: Use this model saves the pick, closes the picker and
      // returns to the tab the popup was on, whose popup names the model.
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const tabId = await tabIdOf(b, page);
      const fromPopup = async () => {
        const popup = await b.context.newPage();
        await popup.goto(b.url(`popup.html?tab=${tabId}`));
        await popup.locator('[data-key="choose-model"]').waitFor();
        const opened = b.context.waitForEvent('page', { timeout: 10000 });
        await popup.click('[data-key="choose-model"]');
        const opener = await opened;
        await opener.waitForLoadState();
        await opener.evaluate(() => globalThis.narwalModelPage);
        return opener;
      };
      const chooser = await fromPopup();
      c.ok('Choose model opens the picker for this tab and downloads nothing', chooser.url().endsWith(`/model.html?from=${tabId}`) && (await chooser.$$eval('.model', (els) => els.every((el) => el.dataset.state === 'missing'))), chooser.url());
      await chooser.click('label[for="model-whisper-base.en-q8"]');
      const closed = chooser.waitForEvent('close', { timeout: 10000 });
      await chooser.getByRole('button', { name: 'Use this model' }).click();
      await closed;
      let prefs = await prefsBecome('whisper-base.en-q8');
      const active = await b.sw((id) => chrome.tabs.get(id).then((t) => t.active), tabId);
      c.ok('Use this model saves the pick, closes the picker and returns to the tab', prefs.offlineModel === 'whisper-base.en-q8' && active === true, { prefs, active });

      const popup = await b.context.newPage();
      await popup.goto(b.url(`popup.html?tab=${tabId}`));
      const pick = popup.locator('.nw-model-pick');
      await pick.waitFor();
      const named = { model: await pick.getAttribute('data-model'), text: await pick.textContent() };
      c.ok('the start view names the picked model with its bars', named.model === 'whisper-base.en-q8' && /Model: Whisper base\.en/.test(named.text) && !/recommended/.test(named.text) && /Accuracy/.test(named.text), named);
      await popup.screenshot({ path: join(RESULTS, 'model-picker-start-view.png'), fullPage: true });
      await popup.close();

      // Back from the popup's picker: closed, the tab again, the pick unchanged.
      const backer = await fromPopup();
      await backer.click('label[for="model-vosk-small-en-us"]');
      const gone = backer.waitForEvent('close', { timeout: 10000 });
      await backer.getByRole('button', { name: 'Back', exact: true }).click();
      await gone;
      await sleep(300);
      const kept = await savedPick();
      const activeAgain = await b.sw((id) => chrome.tabs.get(id).then((t) => t.active), tabId);
      c.ok('Back closes the picker, returns to the tab and leaves the previous pick', kept === 'whisper-base.en-q8' && activeAgain === true, { kept, activeAgain });

      // The recording keeps the pick: base.en is not downloaded and no other
      // model is, so the job after Stop fails as a model failure naming it.
      const rec = await startRec(b, page);
      await sleep(1500);
      await stopRec(b);
      const job = await afterJobEnd(b, rec.id, 30000);
      c.ok('the job after Stop runs the picked model', job && job.state === 'failed' && job.error.kind === 'model' && /whisper-base\.en-q8/.test(job.error.message), job);

      // The live model picked: no pass after Stop, the live text stays.
      const liver = await fromPopup();
      await liver.click('label[for="model-vosk-small-en-us"]');
      const shut = liver.waitForEvent('close', { timeout: 10000 });
      await liver.getByRole('button', { name: 'Use this model' }).click();
      await shut;
      prefs = await prefsBecome('vosk-small-en-us');
      const live = await startRec(b, page);
      await sleep(1500);
      await stopRec(b);
      await sleep(1500);
      const none = await b.viewer.evaluate((id) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcript-state', id }), live.id);
      c.ok('the live model picked: nothing runs after Stop', prefs.offlineModel === 'vosk-small-en-us' && none && !none.afterTranscript, { prefs, none });
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },
  async transcriptionFailure(fx) {
    const c = new Checks('transcriptionFailure');
    const b = await launch();
    try {
      const page = await b.context.newPage();
      await page.goto(`${fx.A}/index.html`);
      const rec = await startRec(b, page);
      await b.sw(() => globalThis.narwal.throwingConsumer());
      await sleep(4000);
      await mark(page, 'during-failures');
      await sleep(1200);
      const stopped = await stopRec(b);
      c.ok('stop is normal', stopped.ok && stopped.stopReason === 'user', stopped.stopReason);
      const r = await reopen(b, rec.id, { needles: ['marker:during-failures'] });
      c.ok('consumer failures are recorded', r.consumerErrors >= 3, r.consumerErrors);
      c.ok('audio keeps saving', r.audioChunks >= 4 && r.audio.length === 1, r.audio);
      c.ok('page keeps recording', r.found['marker:during-failures']);
      c.ok('no gaps', r.gaps.length === 0, r.gaps);
      return { checks: c.list };
    } finally {
      await b.close();
    }
  },

  // Offline transcription in the recorder (board #16570): a missing model
  // shows on the strip; after the download "Try again" brings text on the same
  // engine; with no network a new recording transcribes live. Each Stop saves
  // a live revision.
  async transcript(fx) {
    const c = new Checks('transcript');
    const work = await mkdtemp(join(tmpdir(), 'narwal-e2e-transcript-'));
    const profile = join(work, 'profile');
    const speech = await speechWav(work);
    const audioArgs = [`--use-file-for-fake-audio-capture=${speech.wav}`];
    try {
      let b = await launch({ userDataDir: profile, args: audioArgs });
      try {
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/index.html`);
        const rec = await startRec(b, page);
        const missing = await watchTranscript(b, (t) => t.state === 'disconnected', 20000);
        c.ok('no model: the strip shows disconnected with the reason', missing.done && /not downloaded/.test(missing.last.detail || ''), missing.states);
        const install = await b.viewer.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'test:model-install' }));
        c.ok('the live model downloads', install && install.ok, install);
        const retry = await b.viewer.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'transcript-retry' }));
        c.ok('Try again is accepted', retry && retry.ok && retry.transcript.state === 'reconnecting', retry);
        const back = await watchTranscript(b, (t, events) => t.state === 'live' && finals(events).length >= 2, 60000);
        const text = finals(back.events).map((e) => e.segment.text).join(' ');
        c.ok('after Try again the same engine is live and final text arrives', back.done, back.states);
        c.ok('the text is the speech', known(text, speech.words) >= 8, text);
        const stopped = await stopRec(b);
        c.ok('stop is normal', stopped.ok, stopped.stopReason);
        const saved = await savedTranscript(b, rec.id);
        const [live] = saved.revisions;
        c.ok('Stop saved one live revision and made it active', saved.activeRevision === 'r1' && saved.revisions.length === 1 && live.source === 'live' && live.provider === 'browser-local', saved);
        c.ok('the revision keeps the text and the model-missing gap', known(live.text, speech.words) >= 8 && live.gaps.some((g) => g.startsWith('model-missing')), live);

        // The final pass after Stop (#16603). No Whisper model yet: the job
        // ends as a model failure and the live transcript stays.
        const noWhisper = await afterJobEnd(b, rec.id, 30000);
        c.ok('no Whisper model: the job after Stop fails as a model failure, nothing is downloaded', noWhisper && noWhisper.state === 'failed' && noWhisper.provider === 'browser-local' && noWhisper.error.kind === 'model', noWhisper);
        // Installed on purpose, as the model page does. Only Moonshine base:
        // the WebAssembly chain (Parakeet #16608, small.en, then Moonshine base
        // #16609) falls to it, the last model.
        const whisper = await b.sw((model) => globalThis.narwal.installModel(model), 'moonshine-base-q8');
        c.ok('the final model downloads', whisper && whisper.ok, whisper);
        const ask = await b.viewer.evaluate((id) => chrome.runtime.sendMessage({ to: 'sw', cmd: 'transcribe', id }), rec.id);
        const improved = await afterJobEnd(b, rec.id, 300000);
        const after = await savedTranscript(b, rec.id);
        const final = after.revisions[1] || {};
        c.ok(
          'Improve the transcript: the final pass stores an after-recording revision that replaces the live one',
          ask && ask.ok && improved && improved.state === 'done' && improved.activated && after.revisions.length === 2 && after.activeRevision === final.revisionId && final.source === 'after-recording' && final.provider === 'browser-local' && final.model === 'moonshine-base-q8' && final.supersedes === 'r1',
          { ask, improved, after },
        );
        c.ok('the improved text is the speech, at least as close as the live text', known(final.text || '', speech.words) >= Math.max(8, known(live.text, speech.words)), { live: live.text, final: final.text });
      } finally {
        await b.close({ keepProfile: true });
      }

      // No network: every host name fails to resolve except the fixture site.
      b = await launch({ userDataDir: profile, args: [...audioArgs, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
      try {
        const blocked = await b.viewer.evaluate(() => fetch('https://ccoreilly.github.io/vosk-browser/', { cache: 'no-store' }).then(() => 'reached', (err) => `failed: ${err.message}`));
        c.ok('negative control: the model host is unreachable', blocked.startsWith('failed'), blocked);
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/index.html`);
        const rec = await startRec(b, page);
        const live = await watchTranscript(b, (t, events) => finals(events).length >= 2, 60000);
        const text = finals(live.events).map((e) => e.segment.text).join(' ');
        c.ok('offline: live text arrives with no network', live.done && known(text, speech.words) >= 8, { states: live.states, text });
        c.ok('offline: the strip went connecting then live', live.states[0].state === 'connecting' && live.states.some((s) => s.state === 'live'), live.states);
        await stopRec(b);
        const saved = await savedTranscript(b, rec.id);
        c.ok('offline: the live revision is saved', saved.revisions[0].revisionId === 'r1' && saved.revisions[0].source === 'live' && known(saved.revisions[0].text, speech.words) >= 8 && saved.entries > 0, saved);
        // Stop alone starts the final pass, with no network (#16603).
        const job = await afterJobEnd(b, rec.id, 300000);
        const after = await savedTranscript(b, rec.id);
        c.ok(
          'offline: Stop runs the final pass with no network and the improved transcript becomes active',
          job && job.state === 'done' && job.activated && after.revisions.length === 2 && after.activeRevision === after.revisions[1].revisionId && after.revisions[1].model === 'moonshine-base-q8' && known((after.revisions[1] || {}).text || '', speech.words) >= 8,
          { job, after },
        );
      } finally {
        await b.close({ keepProfile: true });
      }
      return { checks: c.list };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
  // Parakeet as the live engine (board #16617). With Parakeet and Vosk on the
  // computer, live text comes from Parakeet, a span at a time, a few seconds
  // after the words; the live revision names it. A stored Parakeet file that
  // no longer matches its checksum makes the next recording fall back to Vosk.
  async transcriptParakeet(fx) {
    const c = new Checks('transcriptParakeet');
    const work = await mkdtemp(join(tmpdir(), 'narwal-e2e-parakeet-'));
    const profile = join(work, 'profile');
    const speech = await speechWav(work);
    const audioArgs = [`--use-file-for-fake-audio-capture=${speech.wav}`];
    try {
      const b = await launch({ userDataDir: profile, args: audioArgs });
      try {
        for (const model of ['vosk-small-en-us', 'parakeet-tdt-0.6b-v2-int8']) {
          const install = await b.sw((id) => globalThis.narwal.installModel(id), model);
          c.ok(`${model} downloads`, install && install.ok, install);
        }
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/index.html`);
        const startedAt = Date.now();
        const rec = await startRec(b, page);
        const live = await watchTranscript(b, (t, events) => finals(events).length >= 3, 90000);
        const got = finals(live.events);
        const text = got.map((e) => e.segment.text).join(' ');
        // The strip's events carry text only (transcript.js); the saved revision below names the model of every segment.
        c.ok('live text arrives', live.done && got.length >= 3, got.length);
        c.ok('the text is the speech', known(text, speech.words) >= 12, text);
        // The fixture speaks from 0.3 s; the first span closes at its first pause (about 5 s).
        const firstMs = live.firstFinalAt ? live.firstFinalAt - startedAt : null;
        c.ok('the first text is on the strip within 15 s of Start (model load included)', firstMs !== null && firstMs <= 15000, firstMs);
        c.ok('the strip went live with no restart', live.states.some((s) => s.state === 'live') && !live.states.some((s) => s.state === 'reconnecting'), live.states);
        await stopRec(b);
        const saved = await savedTranscript(b, rec.id);
        const [revision] = saved.revisions;
        // One model name: every segment came from Parakeet (a mix names both, revisions.ts).
        c.ok('the live revision names Parakeet and its timing', revision && revision.model === 'parakeet-tdt-0.6b-v2-int8' && revision.timing && revision.timing.quality === 'approximate' && revision.timing.method === 'tdt-token-times', revision);
        c.ok('the live revision keeps the text and has no gap', revision && known(revision.text, speech.words) >= 12 && revision.gaps.length === 0, revision);
        await afterJobEnd(b, rec.id, 300000);

        // A damaged Parakeet file (same size, so only the checksum sees it).
        const key = storageKey('parakeet-tdt-0.6b-v2-int8', 'tokens.txt');
        const damaged = await b.viewer.evaluate(
          async ([cacheName, url]) => {
            const cache = await caches.open(cacheName);
            const stored = await cache.match(url);
            if (!stored) return { ok: false };
            const data = new Uint8Array(await stored.arrayBuffer());
            for (let i = 0; i < Math.min(64, data.length); i += 1) data[i] ^= 0xff;
            await cache.put(url, new Response(new Blob([data])));
            return { ok: true, bytes: data.length };
          },
          [MODEL_CACHE_NAME, key],
        );
        c.ok('test setup: a Parakeet file is damaged in place', damaged.ok, damaged);
        const rec2 = await startRec(b, page);
        const fallback = await watchTranscript(b, (t, events) => finals(events).length >= 2, 90000);
        const fellBack = finals(fallback.events);
        c.ok('Parakeet does not load: live text still arrives', fallback.done && known(fellBack.map((e) => e.segment.text).join(' '), speech.words) >= 8, { states: fallback.states, finals: fellBack.map((e) => e.segment.text) });
        await stopRec(b);
        const saved2 = await savedTranscript(b, rec2.id);
        // One model name: every segment came from Vosk (a mix names both, revisions.ts).
        c.ok('the fallback revision names Vosk alone and has no gap', saved2.revisions[0] && saved2.revisions[0].model === 'vosk-small-en-us' && saved2.revisions[0].timing?.method === 'vosk-alignment' && saved2.revisions[0].gaps.length === 0, saved2.revisions[0]);
        await afterJobEnd(b, rec2.id, 300000);
      } finally {
        await b.close();
      }
      return { checks: c.list };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },

  // One continuous recording of NARWAL_SOAK_MINUTES (default 30) with no
  // network (board #16552): navigation of every kind, markers, masked inputs,
  // hidden regions, live offline transcript, a service worker stop, Stop,
  // reopen and replay; then a manual update into a new folder keeps it.
  // Samples memory, CPU, storage and latency every 30 seconds. Memory is the
  // curve of #16591: the process tree, the recorder by kind of mapping and
  // each recorder heap. At minutes 12 and 21 and at the end it collects the
  // recorder's garbage: what is left must be level (test/e2e/memory.mjs).
  async soak(fx) {
    const c = new Checks('soak');
    const minutes = Number(process.env.NARWAL_SOAK_MINUTES || 30);
    const work = await mkdtemp(join(tmpdir(), 'narwal-soak-'));
    const profile = join(work, 'profile');
    const speech = await speechWav(work);
    const audioArgs = [`--use-file-for-fake-audio-capture=${speech.wav}`];
    const offline = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
    const v1 = await installCopy(join(work, 'narwal-0.1.0'));
    const expectedId = await keyIdOf(v1);
    const summary = { minutes, samples: [], live: [], saveLatencyMs: [], transcriptLatencyMs: [] };
    try {
      // Setup with network: the live model, as a user installs it once.
      let b = await launch({ userDataDir: profile, args: audioArgs, app: v1 });
      try {
        c.ok('the extension ID comes from the manifest key', b.extensionId === expectedId, { got: b.extensionId, expectedId });
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/page2.html`);
        await startRec(b, page);
        const install = await b.viewer.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'test:model-install' }));
        c.ok('setup: the live model downloads', install && install.ok, install);
        await stopRec(b);
      } finally {
        await b.close({ keepProfile: true });
      }

      b = await launch({ userDataDir: profile, args: [...audioArgs, offline, '--remote-debugging-port=0'], app: v1 });
      let id;
      let before;
      let inspector = null;
      try {
        const blocked = await b.viewer.evaluate(() => fetch('https://ccoreilly.github.io/vosk-browser/', { cache: 'no-store' }).then(() => 'reached', (err) => `failed: ${err.message}`));
        c.ok('negative control: no network for the whole recording', blocked.startsWith('failed'), blocked);
        const page = await b.context.newPage();
        await page.goto(`${fx.A}/index.html`);
        await page.fill('#secret', 'typed-before-start');
        const rec = await startRec(b, page);
        id = rec.id;
        // The in-page strip (#16551) is on the page the whole time.
        await page.waitForSelector('[data-narwal-ui="strip"]', { state: 'attached', timeout: 10000 });
        const startedAt = (await status(b)).live.startedAt;
        const endAt = startedAt + minutes * 60000;
        inspector = await inspectRecorder(profile, b.extensionId);
        const atMin = () => Math.round((Date.now() - startedAt) / 6000) / 10;
        const sample = async (at) => ({ atMin: at, tree: await processTree(profile), heaps: await inspector.heaps(), storage: await storageUse(b) });
        // The recorder's memory before and after a garbage collection in each of its heaps.
        const liveReading = async () => {
          const at = atMin();
          const beforeMB = ownMB((await processTree(profile)).recorder);
          const collected = await inspector.collect();
          await sleep(4000); // the freed pages go back to the system
          const recorder = (await processTree(profile)).recorder;
          return { atMin: at, collected, beforeMB, liveMB: ownMB(recorder), recorder, heaps: await inspector.heaps() };
        };
        const liveAt = LIMITS.liveAtMin.filter((min) => min < minutes - 1);

        // The transcript seam, polled once a second like the strip.
        let cursor;
        let polling = true;
        const finalTexts = [];
        const transcriptStates = [];
        const poller = (async () => {
          while (polling) {
            const s = await offscreenStatus(b, cursor).catch(() => null);
            if (s && s.transcript) {
              if (transcriptStates.at(-1) !== s.transcript.state) transcriptStates.push(s.transcript.state);
              const seenAt = Date.now();
              for (const f of finals(s.transcriptEvents)) {
                finalTexts.push(f.segment.text);
                summary.transcriptLatencyMs.push(seenAt - (startedAt + f.segment.endMs));
              }
              cursor = s.transcriptCursor;
            }
            await sleep(1000);
          }
        })();

        const secrets = ['typed-before-start'];
        const markers = [];
        const userMarks = [];
        let seq = 0;
        let nextSample = Date.now();
        let workerStopped = false;
        const steps = [
          async () => {
            await page.goto(`${fx.A}/index.html`);
          },
          async () => {
            await Promise.all([page.waitForURL(`${fx.A}/page2.html`), page.click('#to-page2')]);
          },
          async () => {
            await page.goBack({ waitUntil: 'commit' });
            await sleep(500);
            await page.goForward({ waitUntil: 'commit' });
            await sleep(500);
          },
          async () => {
            await page.reload();
          },
          async () => {
            await page.goto(`${fx.B}/page2.html`);
          },
          async (i) => {
            await page.goto(`${fx.A}/form.html`);
            const s = `soak-form-${i}`;
            secrets.push(s);
            await page.fill('#name', s);
            await Promise.all([page.waitForURL(`${fx.A}/result.html`), page.click('#submit')]);
          },
          async () => {
            await page.goto(`${fx.A}/spa.html`);
            await page.click('#route-1');
            await page.click('#route-2');
            await page.click('#hash');
            await page.goBack({ waitUntil: 'commit' });
            await sleep(300);
          },
        ];
        for (let i = 0; Date.now() < endAt - 15000; i += 1) {
          await steps[i % steps.length](i);
          // Masked input and a hidden region on every page.
          const secret = `soak-secret-${i}`;
          const hidden = `soak-hidden-${i}`;
          secrets.push(secret, hidden);
          await page.evaluate(
            ([s, h]) => {
              const input = document.createElement('input');
              input.value = s;
              document.body.append(input);
              const ui = document.createElement('div');
              ui.dataset.narwalUi = '';
              ui.textContent = h;
              document.body.append(ui);
            },
            [secret, hidden],
          );
          if (await page.$('#secret')) {
            secrets.push(`soak-typed-${i}`);
            await page.fill('#secret', `soak-typed-${i}`);
          }
          for (let k = 0; k < 20; k += 1) await page.mouse.move(40 + ((k * 37 + i * 11) % 600), 40 + ((k * 23 + i * 7) % 400));
          // A right-click mark and an Alt+Shift+M mark (#21), each on its own new button.
          const [clickName, keyName] = [`soak-click-${i}`, `soak-key-${i}`];
          await page.evaluate((names) => {
            names.forEach((name, n) => {
              const el = document.createElement('button');
              el.type = 'button';
              el.id = name;
              el.textContent = name;
              el.style.cssText = `position:fixed;left:700px;top:${200 + n * 60}px;z-index:2147483000`;
              document.body.append(el);
            });
          }, [clickName, keyName]);
          const box = await page.locator(`#${clickName}`).boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
          await page.focus(`#${keyName}`);
          await page.keyboard.press('Alt+Shift+KeyM');
          userMarks.push([clickName, keyName]);
          const label = `soak-${i}`;
          const markedAt = await mark(page, label);
          markers.push(label);
          for (;;) {
            const r = await savedNeedle(b, id, seq, `marker:${label}`);
            seq = r.seq;
            if (r.found) {
              summary.saveLatencyMs.push(Date.now() - markedAt);
              break;
            }
            if (Date.now() - markedAt > 15000) {
              summary.saveLatencyMs.push(Infinity);
              break;
            }
            await sleep(100);
          }
          // A third of the way in, the browser stops the service worker.
          if (!workerStopped && Date.now() > startedAt + (minutes * 60000) / 3) {
            const cdp = await b.context.newCDPSession(b.viewer);
            await cdp.send('ServiceWorker.enable');
            await cdp.send('ServiceWorker.stopAllWorkers');
            workerStopped = Date.now() - startedAt;
            await sleep(1500);
          }
          if (Date.now() >= nextSample) {
            summary.samples.push(await sample(atMin()));
            nextSample += 30000;
          }
          if (liveAt.length && Date.now() >= startedAt + liveAt[0] * 60000) {
            liveAt.shift();
            summary.live.push(await liveReading());
          }
          await sleep(Math.max(0, Math.min(12000, endAt - Date.now() - 15000)));
        }
        summary.live.push(await liveReading());
        await sleep(Math.max(0, endAt - Date.now()));
        const live = await status(b);
        c.ok('still recording at the end, after the service worker stop', live.live && live.live.id === id && live.recorder && live.recorder.recording, { workerStoppedAtMs: workerStopped });
        polling = false;
        await poller;
        const stopStarted = Date.now();
        const stopped = await stopRec(b);
        summary.stopMs = Date.now() - stopStarted;
        c.ok('stop succeeds', stopped.ok && stopped.stopReason === 'user', stopped);
        summary.samples.push(await sample('after-stop'));
        inspector.close();
        inspector = null;

        // #16591: the curve, and what is left of it after a garbage collection.
        const curve = (pick) => summary.samples.filter((x) => typeof x.atMin === 'number').map((x) => [x.atMin, pick(x)]);
        const memory = liveMemory(summary.live);
        summary.memory = {
          live: memory,
          own: trend(curve((x) => ownMB(x.tree.recorder)), 1),
          voskMemory: trend(curve((x) => x.tree.recorder.largestSandboxMB), 10),
          voskMemoryFill: trend(curve((x) => x.tree.recorder.largestSandboxMB), 1, 10),
          partitionAlloc: trend(curve((x) => x.tree.recorder.partitionAllocMB), 1),
          voskBuffers: trend(curve((x) => (x.heaps['vosk-worker'] || {}).buffersMB), 1),
        };
        if (minutes >= LIMITS.levelMinutes) {
          c.ok(`recorder memory levels off: after a garbage collection at minutes ${[...LIMITS.liveAtMin, minutes].join(', ')} it rises at most ${LIMITS.liveRiseMB} MB`, liveLevelsOff(memory), memory);
          c.ok(`recorder garbage does not pile up: no collection frees more than ${LIMITS.freedMB} MB`, garbageIsBounded(memory), memory);
        }

        const reopenStarted = Date.now();
        const stripText = ['NarWal recording controls', 'Transcript so far'];
        const r = await reopen(b, id, { needles: [...markers.map((l) => `marker:${l}`), ...SECRETS, ...secrets, ...stripText], replay: true });
        summary.reopenMs = Date.now() - reopenStarted;
        const spanMin = (r.audio[0] || {}).spanMs / 60000;
        c.ok(`the recording is ${minutes} minutes long and stopped`, r.meta.status === 'stopped' && spanMin >= minutes - 0.2, { meta: r.meta, spanMin });
        c.ok('no automatic cutoff: stopped by the user', r.meta.stopReason === 'user', r.meta.stopReason);
        const missing = markers.filter((l) => !r.found[`marker:${l}`]);
        c.ok(`all ${markers.length} markers captured`, missing.length === 0, missing);
        const leaked = [...SECRETS, ...secrets].filter((s) => r.found[s]);
        c.ok(`none of ${SECRETS.length + secrets.length} masked or hidden strings is in the recording`, leaked.length === 0, leaked);
        c.ok('the recording strip is not in the recording', stripText.every((t) => !r.found[t]), r.found);
        const committed = [...new Set(r.topCommits.map((n) => n.documentId))];
        const tops = r.documents.filter((d) => d.isTop);
        c.ok('every committed top document has a full snapshot', committed.every((d) => tops.some((t) => t.documentId === d && t.snapshot)), { committed: committed.length, tops: tops.length });
        c.ok('back/forward restored documents from the cache', tops.some((d) => d.attachments.includes('bfcache-restore')));
        // Every step ran once the markers outnumber the steps.
        if (markers.length >= 7) c.ok('SPA routes recorded', r.routes.length >= 4 && r.historyUpdates >= 3, { routes: r.routes.length, historyUpdates: r.historyUpdates });
        c.ok('no gaps and no restarts', r.gaps.length === 0 && r.meta.restarts === 0, { gaps: r.gaps, lostContext: r.lostContext });
        const a = r.audio[0] || {};
        c.ok('one audio part that decodes to its full length (within 1.5 s)', r.audio.length === 1 && typeof a.decodedMs === 'number' && Math.abs(a.decodedMs - a.spanMs) < 1500, r.audio);
        summary.audio = { ...a, driftPpm: typeof a.decodedMs === 'number' ? Math.round(((a.decodedMs - a.spanMs) / a.spanMs) * 1e6) : null };
        const saved = await savedTranscript(b, id);
        const [liveRev] = saved.revisions;
        const words = liveRev ? liveRev.text.split(/\s+/).filter(Boolean) : [];
        summary.transcript = { states: transcriptStates, finals: finalTexts.length, revisionWords: words.length, knownWords: known(liveRev ? liveRev.text : '', speech.words), gaps: liveRev ? liveRev.gaps : null };
        c.ok('live transcript ran the whole time with no network', transcriptStates.includes('live') && finalTexts.length >= minutes * 2, { finals: finalTexts.length, states: transcriptStates });
        c.ok('Stop saved one live revision, active, with no gaps', saved.activeRevision === 'r1' && saved.revisions.length === 1 && liveRev.source === 'live' && liveRev.gaps.length === 0, { active: saved.activeRevision, revisions: saved.revisions.length, gaps: liveRev && liveRev.gaps });
        c.ok('the transcript is the speech (80% of words known)', words.length > 0 && summary.transcript.knownWords / words.length >= 0.8, summary.transcript);
        const lost = summary.saveLatencyMs.filter((x) => x === Infinity).length;
        c.ok('every marker was saved within 15 s', lost === 0, lost);
        c.ok('replay of the first page shows the recorded page', r.replayed && r.replayed.iframe && r.replayed.events > 0, r.replayed);
        summary.clock = await clockByMinute(b, id);
        summary.counts = { markers: markers.length, documents: r.documents.length, topCommits: r.topCommits.length, eventChunks: r.eventChunks, audioChunks: r.audioChunks, secrets: secrets.length };
        before = { eventChunks: r.eventChunks, audioChunks: r.audioChunks, audio: r.audio.map((x) => x.bytes), revisions: saved.revisions.length, text: liveRev && liveRev.text };

        // Export bundle on the recordings page, as the user does (#21), then
        // read it as an agent would.
        const listPage = await b.context.newPage();
        await listPage.goto(b.url('recordings.html'));
        const first = await exportFromList(listPage, 'Fixture index', join(work, 'export-1.narwal.zip'));
        const x = await readBundle(join(work, 'export-1.narwal.zip'));
        summary.export = { ms: first.ms, bytes: x.bytes, files: x.files.size, fileName: first.fileName };
        c.ok('Export bundle on the recordings page downloads a .narwal.zip', first.rows === 1 && first.fileName.endsWith('.narwal.zip'), first);
        c.ok('@narwal/bundle: the export is valid', x.result.ok && x.result.errors.length === 0, { errors: x.result.errors.slice(0, 5), warnings: x.result.warnings.length });
        const man = JSON.parse(x.text('manifest.json'));
        c.ok(`the bundle is the whole recording: complete, ${minutes} minutes, narration, active transcript`, man.state === 'complete' && man.durationMs >= (minutes - 0.2) * 60000 && man.audio && x.files.get(man.audio.file).length >= 0.95 * a.bytes && man.transcript.activeRevision === 'r1', { state: man.state, durationMs: man.durationMs, audio: man.audio, audioBytes: man.audio && x.files.get(man.audio.file).length, recorded: a.bytes, transcript: man.transcript });
        const obs = x.lines('observations.jsonl');
        const marked = (via) => new Set(obs.filter((o) => o.kind === 'marker-element' && o.via === via).map((o) => o.target && o.target.name));
        const clickMissing = userMarks.filter(([n]) => !marked('right-click').has(n));
        const keyMissing = userMarks.filter(([, n]) => !marked('keyboard-focus').has(n));
        c.ok(`all ${userMarks.length} right-click marks and ${userMarks.length} Alt+Shift+M marks are in the bundle`, userMarks.length > 0 && clickMissing.length === 0 && keyMissing.length === 0, { clickMissing, keyMissing });
        const kinds = {};
        for (const o of obs) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
        const entries = {};
        for (const e of x.view.entries) entries[e.kind] = (entries[e.kind] || 0) + 1;
        const md = x.text('agent/walkthrough.md') || '';
        summary.bundle = { files: [...x.files.keys()].filter((p) => !p.startsWith('rrweb/')).concat(`rrweb/ (${[...x.files.keys()].filter((p) => p.startsWith('rrweb/')).length} files)`), observations: kinds, agentEntries: entries, walkthroughMdBytes: md.length };
        c.ok('the agent view has the narration, the routes and the marks', x.view.transcript && x.view.transcript.revisionId === 'r1' && entries.utterance >= minutes * 2 && kinds.route >= markers.length && userMarks.every(([n, k]) => md.includes(n) && md.includes(k)), { transcript: x.view.transcript, entries, kinds });
        const bundleText = [...x.files.keys()].filter((p) => !p.endsWith('.webm')).map((p) => x.text(p)).join('\n');
        const bundleLeaks = [...SECRETS, ...secrets].filter((s) => bundleText.includes(s));
        c.ok('no masked or hidden string is in the bundle', bundleLeaks.length === 0, bundleLeaks);

        // A correction and a note on the exported recording in replay (#23).
        const rp = await b.context.newPage();
        const replayErrors = [];
        rp.on('pageerror', (err) => replayErrors.push(String(err)));
        await rp.goto(b.url('replay.html'));
        await rp.waitForFunction(() => globalThis.__narwalReplayReady === true);
        await rp.click('#list tbody button');
        await rp.waitForURL(/\?id=/);
        await rp.waitForFunction(() => globalThis.__narwalReplay?.player, null, { timeout: 120000 });
        const heard = await rp.evaluate(() => globalThis.__narwalReplay.model.utterances[0].text);
        const CORRECTION = 'corrected in the soak replay';
        const NOTE = 'note written in the soak replay';
        await rp.click('#transcript li:nth-child(1) button[aria-label^="Edit"]');
        await rp.fill('#transcript li:nth-child(1) input', CORRECTION);
        await rp.press('#transcript li:nth-child(1) input', 'Enter');
        await rp.waitForFunction((t) => globalThis.__narwalReplay.model.utterances[0].text === t, CORRECTION);
        await rp.evaluate(() => globalThis.__narwalReplay.player.seek(60000));
        await rp.fill('#note-text', NOTE);
        await rp.click('#add-note');
        await rp.waitForFunction((t) => globalThis.__narwalReplay.model.notes.some((n) => n.text === t), NOTE);
        const u0 = await rp.evaluate(() => globalThis.__narwalReplay.model.utterances[0]);
        c.ok('replay: a correction and a note are saved on the exported recording', u0.text === CORRECTION && u0.heard === heard && u0.corrected && replayErrors.length === 0, { u0, replayErrors });
        await rp.close();

        // Export again: the bundle an agent gets, with the user's layer.
        const second = await exportFromList(listPage, 'Fixture index', join(work, 'export-2.narwal.zip'));
        const y = await readBundle(join(work, 'export-2.narwal.zip'));
        const edits = y.lines('edits.jsonl');
        const note = y.view && y.view.entries.find((e) => e.kind === 'note');
        const said = y.view && y.view.entries.find((e) => e.kind === 'utterance');
        c.ok('the second export is valid and carries the correction and the note', y.result.ok && edits.length === 2 && edits.some((e) => e.type === 'correction' && e.text === CORRECTION) && edits.some((e) => e.type === 'note' && e.text === NOTE && e.atMs === 60000) && y.view.transcript.correctionsApplied === 1 && note && note.note.text === NOTE && said.said.corrected && said.said.text === CORRECTION, { errors: y.result.errors.slice(0, 5), edits, note, said: said && said.said });
        const same = (p) => Buffer.compare(Buffer.from(x.files.get(p)), Buffer.from(y.files.get(p))) === 0;
        // Derived files (README.md, AGENTS.md, agent/*) are rewritten on every edit by design (#16594).
        const capture = [...x.files.keys()].filter((p) => !DERIVED_PATHS.includes(p) && p !== 'manifest.json');
        c.ok('edits change no captured file (observations, rrweb, audio, transcript)', capture.every((p) => y.files.has(p) && same(p)), capture.filter((p) => !y.files.has(p) || !same(p)));
        summary.export2 = { ms: second.ms, bytes: y.bytes, files: y.files.size };
        await mkdir(RESULTS, { recursive: true });
        summary.bundleFile = join(RESULTS, `soak-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.narwal.zip`);
        await cp(join(work, 'export-2.narwal.zip'), summary.bundleFile);
        await listPage.close();
      } finally {
        if (inspector) inspector.close();
        await b.close({ keepProfile: true });
      }

      // Manual update: the new version in a new folder, same browser profile.
      const v2 = await installCopy(join(work, 'narwal-0.1.1'), (m) => ({ ...m, version: '0.1.1' }));
      b = await launch({ userDataDir: profile, args: [offline], app: v2 });
      try {
        c.ok('update: same extension ID from a different folder', b.extensionId === expectedId, b.extensionId);
        const version = await b.viewer.evaluate(() => chrome.runtime.getManifest().version);
        c.ok('update: the new version is running', version === '0.1.1', version);
        const r = await reopen(b, id);
        const saved = await savedTranscript(b, id);
        const after = r && { eventChunks: r.eventChunks, audioChunks: r.audioChunks, audio: r.audio.map((x) => x.bytes), revisions: saved.revisions.length, text: saved.revisions[0] && saved.revisions[0].text };
        c.ok('update: the recording and its transcript are unchanged', JSON.stringify(after) === JSON.stringify(before), { before: { ...before, text: undefined }, after: after && { ...after, text: undefined } });
      } finally {
        await b.close({ keepProfile: true });
      }
      // Negative control: without the key, the folder path decides the ID.
      const nokey = await installCopy(join(work, 'narwal-nokey'), ({ key, ...m }) => m);
      b = await launch({ userDataDir: profile, args: [offline], app: nokey });
      try {
        const listed = await b.viewer.evaluate(() => globalThis.narwalViewer.list().then((l) => l.length));
        c.ok('negative control: with no key the ID changes and no recording is visible', b.extensionId !== expectedId && listed === 0, { id: b.extensionId, listed });
      } finally {
        await b.close({ keepProfile: true });
      }

      summary.saveLatencyMs = quantiles(summary.saveLatencyMs.filter(Number.isFinite));
      summary.transcriptLatencyMs = quantiles(summary.transcriptLatencyMs);
      summary.machine = { cpu: cpus()[0].model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30) };
      return { checks: c.list, summary };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },

  // Board #16790: checks a bundle recorded by hand in a real browser (Edge on
  // a Mac) with a real provider's sign-in popup, in place of the fixture.
  // Run only when named: NARWAL_BUNDLE=<file.narwal.zip> node test/e2e/run.mjs
  // realPopupBundle. Asks the bundle what the protocol in
  // docs/research/16754-follow-windows.md did: open the popup from w1, switch
  // between the windows, mark in the popup, close it, stop, export.
  async realPopupBundle() {
    const c = new Checks('realPopupBundle');
    const zip = process.env.NARWAL_BUNDLE;
    if (!zip || !existsSync(zip)) throw new Error('set NARWAL_BUNDLE to a .narwal.zip');
    const x = await readBundle(zip);
    c.ok('the bundle is valid', x.result.ok, x.result.errors.slice(0, 5));
    const man = JSON.parse(x.text('manifest.json'));
    const docs = JSON.parse(x.text('documents.json'));
    c.ok('the bundle is schema 1.1', man.schemaVersion === '1.1', man.schemaVersion);
    const windows = docs.windows || [];
    const popups = windows.filter((w) => w.type === 'popup');
    c.ok('a popup window opened by a recorded window, closed before stop', popups.length >= 1 && popups.every((w) => w.opener && w.closedMs !== null), windows);
    const origin = (u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    const tops = docs.documents.filter((d) => d.frameId === 0);
    const first = tops.find((d) => d.window === 'w1');
    const popupKeys = new Set(popups.map((w) => w.key));
    const popupTops = tops.filter((d) => popupKeys.has(d.window));
    c.ok('a popup holds a page on another site than the recorded tab', popupTops.some((d) => origin(d.url) !== origin(first?.url)), popupTops.map((d) => [d.window, origin(d.url)]));
    c.ok('each popup page that was not restricted has its own rrweb stream', popupTops.every((d) => d.capture === 'none' || (d.rrweb && x.files.has(d.rrweb) && x.text(d.rrweb).length > 0)), popupTops.map((d) => [d.key, d.capture, d.rrweb]));
    const obs = x.lines('observations.jsonl');
    const lines = obs.filter((o) => o.kind === 'window').map((o) => `${o.state} ${o.window}`);
    c.ok('window lines: each popup opened and closed', [...popupKeys].every((w) => lines.includes(`opened ${w}`) && lines.includes(`closed ${w}`)), lines);
    // A switch while a popup is open moves focus between separate windows:
    // windows.onFocusChanged, which headless Chromium never fires.
    const at = (state, w) => obs.find((o) => o.kind === 'window' && o.state === state && o.window === w)?.atMs ?? null;
    const popupOpen = (t) => popups.some((w) => at('opened', w.key) <= t && t < (at('closed', w.key) ?? Infinity));
    const switches = obs.filter((o) => o.kind === 'window' && o.state === 'focused' && popupOpen(o.atMs)).map((o) => o.window);
    c.ok('focus moved from the popup to the recorded tab and back while the popup was open', switches.includes('w1') && switches.some((w) => popupKeys.has(w)), lines);
    const popupDocKeys = new Set(docs.documents.filter((d) => popupKeys.has(d.window)).map((d) => d.key));
    const popupMarks = obs.filter((o) => o.kind?.startsWith('marker-') && popupDocKeys.has(o.doc));
    c.ok('a mark made in the popup', popupMarks.length >= 1, obs.filter((o) => o.kind?.startsWith('marker-')).map((o) => [o.kind, o.doc]));
    const md = x.text('agent/walkthrough.md');
    const want = [...popupKeys].flatMap((w) => [new RegExp(`opened window ${w} from w\\d`), new RegExp(`closed window ${w}`)]).concat([/switched to window w1/, /marked .*\| window=w(?!1\b)\d/]);
    c.ok('the walkthrough has the window lines and the popup mark', want.every((re) => re.test(md)), { missing: want.filter((re) => !re.test(md)).map(String), md: md.split('\n').filter((l) => /window|marked/.test(l)) });
    c.ok('the agent view lists the popup mark in its window', x.view.entries.some((e) => popupKeys.has(e.window) && e.evidence?.some((v) => v.kind.startsWith('marker-'))), x.view.entries.filter((e) => popupKeys.has(e.window)).map((e) => e.kind));
    // Sign-in URLs carry client IDs, redirect URIs and state: with the default
    // policy every query and fragment value is `_`.
    const valuesKept = docs.documents
      .map((d) => d.url)
      .filter((u) => {
        const p = new URL(u);
        const hash = p.hash.slice(p.hash.indexOf('?') + 1 || 1);
        return [...p.searchParams.values(), ...new URLSearchParams(hash).values()].some((v) => v !== '_' && v !== '');
      });
    c.ok('no URL query or fragment value is kept', man.privacy.urlPolicy !== 'redact-query-values' || valuesKept.length === 0, valuesKept);

    const measured = {
      environment: man.environment ?? null,
      durationMs: man.durationMs,
      windows: windows.map((w) => ({ key: w.key, type: w.type, opener: w.opener, openedMs: w.openedMs, closedMs: w.closedMs })),
      windowLines: lines,
      pages: tops.map((d) => ({ window: d.window ?? 'w1', origin: origin(d.url), capture: d.capture })),
      popupMarks: popupMarks.map((o) => ({ kind: o.kind, window: docs.documents.find((d) => d.key === o.doc)?.window, target: o.target?.name ?? null })),
      // From each popup's opened line to its first full snapshot.
      openedToFirstSnapshotMs: Object.fromEntries(
        popups.map((w) => {
          const d = tops.find((t) => t.window === w.key && t.rrweb);
          const snap = d && x.lines(d.rrweb).find((l) => l.event.type === 2);
          return [w.key, snap ? Math.round(snap.event.timestamp - man.clock.originEpochMs - at('opened', w.key)) : null];
        }),
      ),
    };

    // Replay: the window in front is the one shown.
    const b = await launch();
    try {
      const replay = await b.context.newPage();
      await replay.setViewportSize({ width: 1400, height: 900 });
      await replay.goto(b.url('replay.html'));
      await replay.setInputFiles('#file', zip);
      await replay.waitForFunction(() => globalThis.__narwalReplay?.player);
      const seek = (t) =>
        replay.evaluate((ms) => {
          const { player } = globalThis.__narwalReplay;
          player.seek(ms);
          const s = player.state();
          return { window: s.window, doc: s.page?.docKey ?? null, label: document.getElementById('window').textContent };
        }, t);
      // The middle of each stretch a popup was in front, from the window lines.
      const fronts = obs.filter((o) => o.kind === 'window').map((o, i, all) => ({ w: o.state === 'closed' ? null : o.window, from: o.atMs, to: all[i + 1]?.atMs ?? man.durationMs }));
      const shown = [];
      for (const f of fronts.filter((f) => popupKeys.has(f.w) && f.to - f.from > 400)) {
        const s = await seek((f.from + f.to) / 2);
        shown.push({ want: f.w, ...s });
        if (process.env.SHOT_DIR && shown.length === 1) {
          await sleep(300);
          await replay.screenshot({ path: join(process.env.SHOT_DIR, 'replay-real-popup-in-front-light.png'), fullPage: true });
        }
      }
      c.ok('replay shows the popup while it is in front', shown.length >= 1 && shown.every((s) => s.window === s.want && /popup opened from window \d/.test(s.label)), shown);
      const after = await seek(man.durationMs - 200);
      c.ok('replay shows the recorded tab at the end', after.window === 'w1', after);
    } finally {
      await b.close();
    }
    return { checks: c.list, measured };
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  // `transcript` downloads the 41 MB live model, `transcriptParakeet` 661 MB
  // more, `exportWhileImproving` the 67 MB Moonshine base, and `soak` runs for
  // 30 minutes: they run only when named.
  const names = wanted.length ? wanted : Object.keys(scenarios).filter((name) => !['transcript', 'transcriptParakeet', 'exportWhileImproving', 'soak', 'realPopupBundle'].includes(name));
  const fx = await startFixtures();
  const results = { ticket: names.includes('soak') ? 16552 : 16542, ranAt: new Date().toISOString(), node: process.version, headless: !process.env.HEADED, chromium: chromium.executablePath().match(/chromium[^/]*-(\d+)/)?.[1] || null, scenarios: {} };
  let failed = 0;
  try {
    for (const name of names) {
      const fn = scenarios[name];
      if (!fn) throw new Error(`unknown scenario ${name}`);
      const started = Date.now();
      try {
        const r = await fn(fx);
        results.scenarios[name] = { ms: Date.now() - started, ...r };
      } catch (err) {
        results.scenarios[name] = { ms: Date.now() - started, error: String(err && err.stack), checks: [] };
        failed += 1;
        console.log(`ERROR ${name}: ${err.message}`);
      }
      for (const ch of results.scenarios[name].checks) {
        if (!ch.pass) failed += 1;
        console.log(`${ch.pass ? 'PASS' : 'FAIL'} ${name}: ${ch.label}${ch.pass ? '' : ` got=${JSON.stringify(ch.got)}`}`);
      }
    }
  } finally {
    await fx.close();
  }
  await mkdir(RESULTS, { recursive: true });
  const file = join(RESULTS, `${results.ranAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  const total = Object.values(results.scenarios).reduce((n, s) => n + s.checks.length, 0);
  console.log(`wrote ${file}`);
  console.log(failed ? `E2E FAILED: ${failed} failing of ${total} checks` : `E2E PASSED: ${total} checks`);
  process.exitCode = failed ? 1 : 0;
}

await main();
