// Delay, CPU and memory of the live transcript inside the MV3 extension
// (board #16617).
//
//   node build.mjs && node e2e/measure-live.mjs
//
// Installs the live models, then feeds one recording to a live session in the
// offscreen document at real speed, in 100 ms chunks, as the capture path
// does. Reports when each word appeared against the end of that word (its
// live word time; on the fixture also against the forced alignment), the CPU time and peak resident memory of the browser, the engine's
// WebAssembly heap, and the word error rate.
//
//   NARWAL_MEASURE_LIVE=parakeet|vosk  parakeet installs Parakeet and Vosk (the
//                                  live chain picks Parakeet); vosk installs
//                                  Vosk only (default parakeet)
//   NARWAL_MEASURE_AUDIO=<file>    recording to feed (the 31 s fixture, which
//                                  also scores per-word delay against its
//                                  word times); copied into the built demo
//                                  extension only
//   NARWAL_MEASURE_REFERENCE=<txt> reference text for a word error rate
//   NARWAL_MODEL_MIRROR=<dir>      as in run.mjs: model files from
//                                  <dir>/<modelId>/<path> (the store still
//                                  checks size and SHA-256)
//   NARWAL_E2E_DIR=<dir>           profile and report directory
//
// With `taskset -c <cpus>` in front of node the browser has only those cores.

import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/models.ts';
import { align, scoreRevision, visibleLatency } from './score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'dist/demo-extension');
const WORK = process.env.NARWAL_E2E_DIR ?? join(ROOT, '.e2e-measure-live');
const PROFILE = join(WORK, 'profile');
const MIRROR = process.env.NARWAL_MODEL_MIRROR ?? '';
const LIVE = process.env.NARWAL_MEASURE_LIVE ?? 'parakeet';
const AUDIO = process.env.NARWAL_MEASURE_AUDIO ?? '';
const REFERENCE_TEXT = process.env.NARWAL_MEASURE_REFERENCE ?? '';
const INSTALL = { parakeet: ['vosk-small-en-us', 'parakeet-tdt-0.6b-v2-int8'], vosk: ['vosk-small-en-us'] }[LIVE];
const TICKS = 100; // USER_HZ: /proc CPU times are in hundredths of a second

if (!INSTALL) throw new Error(`NARWAL_MEASURE_LIVE must be parakeet or vosk, not ${LIVE}`);
if (!existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('dist/demo-extension is missing: run node build.mjs first');

const words = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

/**
 * Resident set size, in bytes, and CPU time, in seconds, of every process
 * below this one (the browser and its children). A child that ended takes
 * its CPU time with it, so compare readings taken while the browser runs.
 */
function browserUse() {
  const parent = new Map();
  const use = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(Number(entry), Number(fields[1]));
      use.set(Number(entry), { rss: Number(fields[21]) * 4096, cpuS: (Number(fields[11]) + Number(fields[12])) / TICKS });
    } catch {
      // The process ended while we read it.
    }
  }
  const below = (pid) => {
    for (let p = parent.get(pid); p; p = parent.get(p)) if (p === process.pid) return true;
    return false;
  };
  let rss = 0;
  let largest = 0;
  let cpuS = 0;
  for (const [pid, now] of use) {
    if (!below(pid)) continue;
    rss += now.rss;
    largest = Math.max(largest, now.rss);
    cpuS += now.cpuS;
  }
  return { rss, largest, cpuS };
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  let audio;
  if (AUDIO) {
    audio = `fixtures/measure-audio${extname(AUDIO)}`;
    copyFileSync(AUDIO, join(EXTENSION, audio));
  }

  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--disable-background-networking', '--disable-component-update', '--no-first-run'],
  });
  if (MIRROR) {
    for (const manifest of Object.values(MODELS)) {
      for (const file of manifest.files) {
        await context.route(file.url, (route) =>
          route.fulfill({ path: join(MIRROR, manifest.id, file.path), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }),
        );
      }
    }
  }
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30000 }));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/setup.html`);
  await page.waitForFunction(() => Boolean(globalThis.NARWAL_SELFTEST), null, { timeout: 30000 });
  const call = (name, args) => page.evaluate(([n, a]) => globalThis.NARWAL_SELFTEST.runInOffscreen(n, a), [name, args]);

  const install = await call('install', { models: INSTALL });
  if (!install.results.every((result) => result.ok)) throw new Error(`install failed: ${JSON.stringify(install.results)}`);
  const env = await call('env', {});

  // A reading every second: the curve of CPU cores busy and memory while recording.
  const samples = [];
  const first = browserUse();
  const startedAt = Date.now();
  let previous = first;
  const sampler = setInterval(() => {
    const now = browserUse();
    samples.push({ atS: Math.round((Date.now() - startedAt) / 100) / 10, cores: Number((now.cpuS - previous.cpuS).toFixed(2)), rssBytes: now.rss, largestBytes: now.largest });
    previous = now;
  }, 1000);
  const live = await call('live', { speed: 1, revision: false, ...(audio ? { audio } : {}) });
  clearInterval(sampler);
  const last = browserUse();
  const wallS = (Date.now() - startedAt) / 1000;
  await context.close();

  const delays = live.finals.filter((final) => final.wordEndsMs.length).map((final) => final.atMs - final.endMs).sort((a, b) => a - b);
  const wordDelays = live.finals.flatMap((final) => final.wordEndsMs.map((endMs) => final.atMs - endMs)).sort((a, b) => a - b);
  const text = live.revision.segments.map((segment) => segment.text).join(' ');
  const busy = samples.map((sample) => sample.cores).sort((a, b) => a - b);
  const result = {
    live: LIVE,
    audio: AUDIO || 'fixtures/speech-en-31s.flac',
    hardwareConcurrency: env.hardwareConcurrency,
    model: live.revision.model,
    timing: live.revision.timing,
    liveEngine: live.liveEngine,
    liveFallback: live.liveFallback,
    audioMs: live.audioMs,
    startMs: live.startMs,
    finishMs: live.finishMs,
    capture: live.capture,
    stats: live.stats,
    counts: live.counts,
    // Each final: when it appeared, after the end of its last word.
    finalDelayMs: { finals: delays.length, p50: quantile(delays, 0.5), p90: quantile(delays, 0.9), max: delays.length ? delays[delays.length - 1] : null },
    // Each word: when it appeared, after the end of that word.
    wordDelayMs: { words: wordDelays.length, p50: quantile(wordDelays, 0.5), p90: quantile(wordDelays, 0.9), max: wordDelays.length ? wordDelays[wordDelays.length - 1] : null },
    // CPU cores the whole browser kept busy, from start to finish (install excluded).
    cpu: { meanCores: Number(((last.cpuS - first.cpuS) / wallS).toFixed(2)), p90Cores: quantile(busy, 0.9), maxCores: busy.length ? busy[busy.length - 1] : null },
    rssBeforeBytes: first.rss,
    peakRssBytes: Math.max(first.rss, ...samples.map((sample) => sample.rssBytes)),
    peakLargestProcessRssBytes: Math.max(first.largest, ...samples.map((sample) => sample.largestBytes)),
    errors: live.errors,
    backlog: live.backlog,
    consoleErrors,
    text,
  };
  if (REFERENCE_TEXT) {
    const reference = words(readFileSync(REFERENCE_TEXT, 'utf8'));
    const counts = align(reference, words(text));
    result.wer = Number(((counts.substitutions + counts.deletions + counts.insertions) / reference.length).toFixed(4));
    result.werCounts = { referenceWords: reference.length, substitutions: counts.substitutions, deletions: counts.deletions, insertions: counts.insertions };
  } else if (!AUDIO) {
    const reference = JSON.parse(readFileSync(join(ROOT, 'fixtures/speech-en-31s.json'), 'utf8'));
    result.fixtureScore = scoreRevision(reference.words, live.revision);
    result.visibleLatency = visibleLatency(reference.words, live.revision, live.visible);
  }
  writeFileSync(join(WORK, 'measure-live.json'), `${JSON.stringify({ ...result, samples, finals: live.finals, visible: live.visible, revision: live.revision }, null, 2)}\n`);
  const { text: _text, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  const ok = live.counts.errors === 0 && live.capture.samples === live.capture.expectedSamples && result.model.startsWith(LIVE === 'parakeet' ? 'parakeet' : 'vosk');
  console.log(`MEASURE=${ok ? 'OK' : 'PROBLEM'}`);
}

await main();
