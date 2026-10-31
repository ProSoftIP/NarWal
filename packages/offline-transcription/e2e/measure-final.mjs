// Speed and memory of one final model inside the MV3 extension (board #16608).
//
//   node build.mjs && node e2e/measure-final.mjs
//
// Installs the model, then runs the final pass in the offscreen document over
// one recording and reports wall time, the real-time factor, the deadline the
// final chain gives that recording (10 min + audio/4, final-chain.ts), the
// engine's WebAssembly heap and the peak resident memory of the browser.
//
//   NARWAL_MEASURE_MODEL=<id>      final model to run (parakeet-tdt-0.6b-v2-int8)
//   NARWAL_MEASURE_AUDIO=<file>    recording to transcribe (the 31 s fixture);
//                                  copied into the built demo extension only
//   NARWAL_MEASURE_REFERENCE=<txt> reference text for a word error rate
//   NARWAL_MODEL_MIRROR=<dir>      as in run.mjs: model files from
//                                  <dir>/<modelId>/<path> (the store still
//                                  checks size and SHA-256)
//   NARWAL_E2E_DIR=<dir>           profile and report directory
//
// With `taskset -c <cpu>` in front of node the browser has one core, as on a
// one-thread page.

import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/models.ts';
import { align, scoreRevision } from './score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'dist/demo-extension');
const WORK = process.env.NARWAL_E2E_DIR ?? join(ROOT, '.e2e-measure');
const PROFILE = join(WORK, 'profile');
const MIRROR = process.env.NARWAL_MODEL_MIRROR ?? '';
const MODEL = process.env.NARWAL_MEASURE_MODEL ?? 'parakeet-tdt-0.6b-v2-int8';
const AUDIO = process.env.NARWAL_MEASURE_AUDIO ?? '';
const REFERENCE_TEXT = process.env.NARWAL_MEASURE_REFERENCE ?? '';

if (!MODELS[MODEL]) throw new Error(`unknown model ${MODEL}`);
if (!existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('dist/demo-extension is missing: run node build.mjs first');

/** The extension's job deadline: 10 minutes plus a quarter of the audio. */
const deadlineFor = (audioMs) => 10 * 60_000 + Math.round(Math.max(0, audioMs) / 4);

const words = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Resident set size, in bytes, of every process below this one (the browser and its children). */
function browserRss() {
  const parent = new Map();
  const rss = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(Number(entry), Number(fields[1]));
      rss.set(Number(entry), Number(fields[21]) * 4096);
    } catch {
      // The process ended while we read it.
    }
  }
  const below = (pid) => {
    for (let p = parent.get(pid); p; p = parent.get(p)) if (p === process.pid) return true;
    return false;
  };
  let total = 0;
  let largest = 0;
  for (const [pid, bytes] of rss) {
    if (!below(pid)) continue;
    total += bytes;
    largest = Math.max(largest, bytes);
  }
  return { total, largest };
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

  const install = await call('install', { models: [MODEL] });
  if (!install.results.every((result) => result.ok)) throw new Error(`install failed: ${JSON.stringify(install.results)}`);
  const env = await call('env', {});

  let peak = { total: 0, largest: 0 };
  const sampler = setInterval(() => {
    const now = browserRss();
    peak = { total: Math.max(peak.total, now.total), largest: Math.max(peak.largest, now.largest) };
  }, 250);
  const before = browserRss();
  const final = await call('finalize', { model: MODEL, ...(audio ? { audio } : {}) });
  clearInterval(sampler);
  await context.close();
  if (!final.ok) throw new Error(`final pass failed: ${JSON.stringify(final.error)}`);

  const text = final.revision.segments.map((segment) => segment.text).join(' ');
  const deadlineMs = deadlineFor(final.audioMs);
  const result = {
    model: MODEL,
    audio: AUDIO || 'fixtures/speech-en-31s.flac',
    hardwareConcurrency: env.hardwareConcurrency,
    engine: final.engine,
    audioMs: final.audioMs,
    wallMs: final.wallMs,
    realTimeFactor: Number((final.wallMs / final.audioMs).toFixed(3)),
    deadlineMs,
    meetsDeadline: final.wallMs <= deadlineMs,
    // At this speed a recording longer than this misses 10 min + audio/4 (none does below a factor of 0.25).
    longestAudioWithinDeadlineMin: final.wallMs / final.audioMs > 0.25 ? Math.floor(10 / (final.wallMs / final.audioMs - 0.25)) : null,
    stats: final.stats,
    timing: final.revision.timing,
    gaps: final.revision.gaps,
    rssBeforeBytes: before.total,
    peakRssBytes: peak.total,
    peakLargestProcessRssBytes: peak.largest,
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
    result.fixtureScore = scoreRevision(reference.words, final.revision);
  }
  writeFileSync(join(WORK, 'measure.json'), `${JSON.stringify({ ...result, revision: final.revision }, null, 2)}\n`);
  const { text: _text, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`MEASURE=${result.meetsDeadline ? 'MEETS' : 'MISSES'}_DEADLINE`);
}

await main();
