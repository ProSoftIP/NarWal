#!/usr/bin/env node
// Board #16539: run one harness configuration in a Browserbase cloud browser.
//
//   node run-browserbase.mjs <config-name> [--fixtures DIR] [--out FILE]
//
// The harness, vendored engine files and fixtures are served from this checkout through
// Playwright request interception on https://narwal.test (cross-origin isolated, so WASM
// threads work). Models download from their public hosts inside the cloud browser, as an
// installed extension would. Nothing runs on this machine except the file server and the
// CDP client, so the measured CPU/memory is the cloud browser's alone.
//
// Writes results/raw/<config>.json: config, Browserbase session URL, the page's raw events,
// network bytes per host, per-process CPU samples and the offline-after-download check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGS } from './configs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const name = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fixturesDir = opt('--fixtures', process.env.NARWAL_FIXTURES);
const cfg = CONFIGS[name];
if (!cfg) { console.error(`unknown config ${name}; known: ${Object.keys(CONFIGS).join(', ')}`); process.exit(2); }
const outFile = opt('--out', path.join(here, 'results/raw', `${name}.json`));
if (!fixturesDir) { console.error('set --fixtures <dir> or NARWAL_FIXTURES'); process.exit(2); }
// BB_BROWSER: a module that exports launchBrowser() for a Browserbase session.
const bbHelper = process.env.BB_BROWSER;
if (!bbHelper) { console.error('set BB_BROWSER to a module that exports launchBrowser()'); process.exit(2); }
const { launchBrowser } = await import(bbHelper);

const nm = path.join(here, 'node_modules');
const MOUNTS = [
  ['/harness/', path.join(here, 'harness')],
  ['/vendor/transformers/', path.join(nm, '@huggingface/transformers/dist')],
  ['/vendor/ort/', path.join(nm, 'onnxruntime-web/dist')],
  ['/vendor/shout/', path.join(nm, '@transcribe/shout/src/shout')],
  ['/vendor/transcriber/', path.join(nm, '@transcribe/transcriber/src')],
  ['/vendor/vosk/', path.join(nm, 'vosk-browser/dist')],
  ['/fixtures/', fixturesDir],
];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.flac': 'audio/flac' };
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'same-origin' };

const fixtureS = cfg.fixture === 'narration-30m' ? 1800 : 120;
const timeoutSeconds = Math.ceil(Math.min(cfg.limitS || fixtureS, fixtureS) / (cfg.speed || 1)) + 1200;
const { browser, context, page, sessionUrl, close } = await launchBrowser({ label: `narwal-16539-${name}`, timeoutSeconds });
const out = { name, cfg, sessionUrl, startedAt: new Date().toISOString(), net: {}, cpu: [], console: [] };
const TIMEOUT = Symbol('timeout');
let reported = null;
const save = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(out)); };

try {
  await context.route('https://narwal.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__report') {
      reported = JSON.parse(route.request().postData() || '{}');
      if (reported.progress) { out.progress = reported.progress; console.log(`${name}: ${new Date().toISOString()} ${JSON.stringify(reported.progress)}`); }
      return route.fulfill({ status: 204, headers: ISOLATION, body: '' });
    }
    let p = url.pathname === '/' ? '/harness/index.html' : url.pathname;
    const m = MOUNTS.find(([prefix]) => p.startsWith(prefix));
    const file = m && path.join(m[1], p.slice(m[0].length));
    if (!file || !file.startsWith(m[1]) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    route.fulfill({ status: 200, headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...ISOLATION }, body: fs.readFileSync(file) });
  });
  context.on('requestfinished', async (req) => {
    const host = new URL(req.url()).host;
    if (host === 'narwal.test') return;
    try { const s = await req.sizes(); out.net[host] = (out.net[host] || 0) + s.responseBodySize; } catch {}
  });
  page.on('console', (m) => { if (out.console.length < 400) out.console.push(`${m.type()}: ${m.text()}`.slice(0, 500)); });
  page.on('pageerror', (e) => out.console.push(`pageerror: ${String(e).slice(0, 1000)}`));

  const cdp = await browser.newBrowserCDPSession();
  const cpuSample = async () => {
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      out.cpu.push({ wall: Date.now(), procs: processInfo.map((p) => ({ type: p.type, id: p.id, cpu: p.cpuTime })) });
    } catch (e) { out.cpuErr = String(e); }
  };
  await page.goto('https://narwal.test/', { waitUntil: "load", timeout: 180000 });
  await page.waitForFunction(() => window.BENCH, null, { timeout: 60000 });
  await cpuSample();
  await page.evaluate((c) => { window.BENCH.run(c); }, cfg);
  const cpuTimer = setInterval(cpuSample, 15000);
  // The page pushes progress and its final result as POST /__report (see report() in the
  // harness); evaluate() is only a fallback, always with a timeout, so a hung page cannot
  // hang the runner.
  const evalT = (fn, arg, ms = 30000) => Promise.race([page.evaluate(fn, arg), new Promise((r) => setTimeout(() => r(TIMEOUT), ms))]);
  let status = 'running';
  while (status === 'running') {
    await new Promise((r) => setTimeout(r, 10000));
    if (reported?.status && reported.status !== 'running') { status = reported.status; break; }
    const st = await evalT(() => window.BENCH.status);
    if (st !== TIMEOUT && st !== 'running') status = st;
  }
  clearInterval(cpuTimer);
  await cpuSample();
  out.status = status;
  if (reported?.status === status) { out.error = reported.error || null; out.result = reported.result; }
  else { out.error = await evalT(() => window.BENCH.error || null); if (out.error === TIMEOUT) out.error = 'page did not answer'; out.result = await evalT(() => window.BENCH.result, undefined, 120000); }
  if (out.result === TIMEOUT) { out.result = null; out.status = status = 'result-unreachable'; }
  save();
  if (status === 'done' && cfg.offline !== false) {
    await context.setOffline(true);
    out.offline = await evalT((c) => window.BENCH.offlineCheck(c), cfg, 120000);
    if (out.offline === TIMEOUT) out.offline = { ok: false, error: 'offline check: page did not answer in 120 s' };
    await context.setOffline(false);
  }
  out.finishedAt = new Date().toISOString();
  save();
  console.log(`${name}: ${status} ${out.error ? out.error.slice(0, 300) : ''} offline=${JSON.stringify(out.offline)?.slice(0, 200)} ${sessionUrl}`);
} catch (e) {
  out.status = 'runner-error'; out.error = String(e?.stack || e); save();
  console.error(`${name}: runner error ${e?.message} ${sessionUrl}`);
  process.exitCode = 1;
} finally {
  // close() has hung on a dead session; do not let it keep the process alive.
  await Promise.race([close(), new Promise((r) => setTimeout(r, 30000))]);
  process.exit();
}
