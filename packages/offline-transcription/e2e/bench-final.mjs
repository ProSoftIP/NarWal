// Final-model speed in the browser (board #16609): each final model of the
// WebAssembly chain runs a full final pass inside the proof extension, on the
// packaged ONNX Runtime WebAssembly build, over each audio file.
//
//   node build.mjs && node e2e/bench-final.mjs
//
// Audio: the package fixture (31.5 s, forced-aligned reference words, so word
// start error is scored too) and, when given, one more recording with a plain
// reference text:
//
//   NARWAL_BENCH_AUDIO=<file>      e.g. Matt's 113 s reading passage (#16603)
//   NARWAL_BENCH_REFERENCE=<file>  its reference text
//   NARWAL_BENCH_MODELS=a,b        default: the WebAssembly final models
//   NARWAL_MODEL_MIRROR=<dir>      as in run.mjs: pinned files from <dir>/<modelId>/<path>
//                                  (small.en's 157 MB decoder closed the page when served
//                                  this way; without a mirror the pinned hosts serve it)
//   NARWAL_E2E_THREADS=<n>         cap the final engine's threads, as in run.mjs
//
// The word error rate here uses the e2e scorer (lowercase, punctuation
// removed, no number rule), so a figure is comparable only with other rows of
// the same run. Writes results/bench-final.summary.json. The committed
// summaries (4 threads, and 1 thread as bench-final-1thread) have the
// passage's text removed.

import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/models.ts';
import { scoreRevision } from './score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'dist/demo-extension');
const PROFILE = join(process.env.NARWAL_E2E_DIR ?? join(ROOT, '.e2e-bench'), 'profile');
const MIRROR = process.env.NARWAL_MODEL_MIRROR ?? '';
const THREADS = Number(process.env.NARWAL_E2E_THREADS) || 0;
const WASM_FINAL = Object.values(MODELS)
  .filter((manifest) => manifest.role === 'final' && manifest.runtime?.device === 'wasm')
  .map((manifest) => manifest.id);
const MODEL_IDS = process.env.NARWAL_BENCH_MODELS ? process.env.NARWAL_BENCH_MODELS.split(',') : WASM_FINAL;

const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/speech-en-31s.json'), 'utf8'));
const audios = [{ name: 'fixture-31s', path: 'fixtures/speech-en-31s.flac', reference: fixture.words, timed: true }];
if (process.env.NARWAL_BENCH_AUDIO) {
  const source = process.env.NARWAL_BENCH_AUDIO;
  const packaged = `fixtures/bench${extname(source)}`;
  copyFileSync(source, join(EXTENSION, packaged));
  const text = readFileSync(process.env.NARWAL_BENCH_REFERENCE ?? '', 'utf8');
  audios.push({ name: basename(source), path: packaged, reference: text.split(/\s+/).filter(Boolean).map((w) => ({ w })), timed: false });
}

async function main() {
  if (!existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('dist/demo-extension is missing: run node build.mjs first');
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--no-first-run'],
  });
  if (MIRROR) {
    for (const id of MODEL_IDS) {
      for (const file of MODELS[id].files) {
        await context.route(file.url, (route) =>
          route.fulfill({ path: join(MIRROR, id, file.path), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }),
        );
      }
    }
  }
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30000 }));
  const page = await context.newPage();
  page.on('crash', () => console.error('the setup page crashed'));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/setup.html${THREADS ? `?threads=${THREADS}` : ''}`);
  await page.waitForFunction(() => Boolean(globalThis.NARWAL_SELFTEST), null, { timeout: 30000 });
  const run = (name, args) => page.evaluate(([n, a]) => globalThis.NARWAL_SELFTEST.run(n, a), [name, args]);

  const install = await run('install', { models: MODEL_IDS });
  const failed = install.results.filter((result) => !result.ok);
  if (failed.length) throw new Error(`install failed: ${JSON.stringify(failed)}`);
  const env = await run('env', {});

  const rows = [];
  for (const audio of audios) {
    for (const model of MODEL_IDS) {
      const result = await run('benchFinal', { model, audio: audio.path });
      if (!result.ok) {
        rows.push({ audio: audio.name, model, error: result.error });
        console.log(`FAIL ${audio.name} ${model}: ${JSON.stringify(result.error)}`);
        continue;
      }
      const score = scoreRevision(audio.reference, result.revision);
      const row = {
        audio: audio.name,
        model,
        audioS: result.audioMs / 1000,
        threads: result.engine?.threads,
        loadMs: result.loadMs,
        transcribeMs: result.transcribeMs,
        speed: Math.round((result.transcribeMs / result.audioMs) * 1000) / 1000,
        spans: result.stats.spans,
        failedSpans: result.stats.failedSpans,
        wer: score.wer,
        ...(audio.timed ? { startAbsMedianMs: score.startAbsMedianMs, startAbsP90Ms: score.startAbsP90Ms, startBiasMs: score.startBiasMs, startsWithin250Ms: score.startsWithin250Ms } : {}),
        wordsMonotonic: score.wordsMonotonic,
        wordsInsideSegments: score.wordsInsideSegments,
        timing: result.revision.timing,
        text: result.revision.segments.map((segment) => segment.text).join(' '),
      };
      rows.push(row);
      console.log(`${audio.name} ${model}: speed ${row.speed} x audio (${row.transcribeMs} ms for ${row.audioS} s, load ${row.loadMs} ms, ${row.threads} threads), WER ${row.wer}${audio.timed ? `, start p90 ${row.startAbsP90Ms} ms` : ''}`);
    }
  }
  await context.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    machine: { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), browser: env.userAgent, crossOriginIsolated: env.crossOriginIsolated, hardwareConcurrency: env.hardwareConcurrency },
    modelSource: MIRROR ? 'local mirror of the pinned files (size and SHA-256 checked by the store)' : 'pinned public hosts',
    threadCap: THREADS || null,
    rows,
  };
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results/bench-final.summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (rows.some((row) => row.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
