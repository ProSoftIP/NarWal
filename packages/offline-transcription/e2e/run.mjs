// End-to-end proof for board #16544: the offline option inside a real MV3
// extension, with the network disabled after model setup.
//
//   node build.mjs && node e2e/run.mjs
//
// Each phase is its own browser start on one profile, so model files, the
// extracted Vosk model, the checkpoint and the revisions survive restarts the
// way they do for a user. Offline phases start Chromium with DNS disabled and
// the context set offline; a request the extension policy allows must fail
// there (negative control). Every phase writes a Chromium NetLog, which sees
// all requests of the browser process (pages, workers, the service worker).
//
//   NARWAL_MODEL_MIRROR=<dir>  serve the pinned model files from
//       <dir>/<modelId>/<path> instead of the real hosts (development runs;
//       the store still checks size and SHA-256). Not for recorded evidence.
//   NARWAL_E2E_THREADS=<n>     cap the final engine's threads. With
//       `taskset -c <n cpus>` in front of node this stands in for an n-core
//       machine (the browser inherits the CPU set).
//   HEADED=1                   show the browser.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, MODEL_DOWNLOAD_HOSTS } from '../src/models.ts';
import { scoreRevision, visibleLatency } from './score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'dist/demo-extension');
const WORK = process.env.NARWAL_E2E_DIR ?? join(ROOT, '.e2e-profile');
const PROFILE = join(WORK, 'profile');
const MIRROR = process.env.NARWAL_MODEL_MIRROR ?? '';
const THREADS = Number(process.env.NARWAL_E2E_THREADS) || 0;
const REFERENCE = JSON.parse(readFileSync(join(ROOT, 'fixtures/speech-en-31s.json'), 'utf8'));
const AUDIO_MS = REFERENCE.durationS * 1000;

// Limits the run must meet. Accuracy limits sit above the #16539 research
// figures for this fixture's speaker (live 9.6 %, final 3.7 % WER on 30 min)
// because 69 words make one wrong word worth 1.4 points.
const LIMITS = {
  liveWer: 0.2,
  finalWer: 0.12,
  liveStartP90Ms: 300,
  finalStartP90Ms: 400,
  // Steady state is about 0.3 s; the first words of a session wait for the engine to warm up.
  visibleLatencyP50Ms: 1000,
  visibleLatencyP90Ms: 2500,
  maxSendMs: 50,
};

const checks = [];
const report = { phases: {} };
function check(phase, name, pass, detail) {
  checks.push({ phase, name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} [${phase}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const hostAllowed = (host) => MODEL_DOWNLOAD_HOSTS.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern));

// Hosts Chromium itself calls (updates, sign-in, push). These are not extension traffic.
const CHROMIUM_OWN = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com)$/;

/** Requests in a NetLog file, split into the extension's own and the browser's. */
function readNetLog(path, extensionId) {
  if (!existsSync(path)) return { available: false };
  let text = readFileSync(path, 'utf8');
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    // A browser that exits before it closes the log leaves the event array open.
    text = text.trimEnd().replace(/,$/, '');
    log = JSON.parse(`${text}]}`);
  }
  const startJob = log.constants.logEventTypes.URL_REQUEST_START_JOB;
  const begin = log.constants.logEventPhase.PHASE_BEGIN;
  const origin = `chrome-extension://${extensionId}`;
  const extension = [];
  const browser = [];
  for (const event of log.events) {
    if (event.type !== startJob || event.phase !== begin || !event.params?.url) continue;
    const url = event.params.url;
    if (!/^(https?|wss?):/.test(url)) continue;
    const entry = { url: url.length > 160 ? `${url.slice(0, 160)}…` : url, host: new URL(url).host, initiator: event.params.initiator ?? '' };
    if (entry.initiator.startsWith(origin)) extension.push(entry);
    else browser.push(entry);
  }
  return { available: true, bytes: statSync(path).size, extension, browser };
}

async function startPhase(name, { offline }) {
  const netLogPath = join(WORK, `netlog-${name}.json`);
  rmSync(netLogPath, { force: true });
  const args = [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    `--log-net-log=${netLogPath}`,
    '--net-log-capture-mode=Default',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
  ];
  if (offline) args.push('--host-resolver-rules=MAP * ~NOTFOUND');
  const context = await chromium.launchPersistentContext(PROFILE, { channel: 'chromium', headless: !process.env.HEADED, args });
  if (offline) await context.setOffline(true);
  if (MIRROR && !offline) {
    for (const manifest of Object.values(MODELS)) {
      for (const file of manifest.files) {
        await context.route(file.url, (route) =>
          route.fulfill({ path: join(MIRROR, manifest.id, file.path), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }),
        );
      }
    }
  }
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30000 }));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));
  await page.goto(`chrome-extension://${extensionId}/setup.html${THREADS ? `?threads=${THREADS}` : ''}`);
  await page.waitForFunction(() => Boolean(globalThis.NARWAL_SELFTEST), null, { timeout: 30000 });
  const started = Date.now();
  const phase = { name, offline, extensionId, steps: {} };
  report.phases[name] = phase;
  return {
    name,
    page,
    phase,
    async run(step, checkName, checkArgs) {
      const result = await page.evaluate(([n, a]) => globalThis.NARWAL_SELFTEST.run(n, a), [checkName, checkArgs ?? {}]);
      phase.steps[step] = result;
      return result;
    },
    async runInOffscreen(step, checkName, checkArgs) {
      const result = await page.evaluate(([n, a]) => globalThis.NARWAL_SELFTEST.runInOffscreen(n, a), [checkName, checkArgs ?? {}]);
      phase.steps[step] = result;
      return result;
    },
    async screenshot(file) {
      await page.evaluate(() => globalThis.NARWAL_SELFTEST.refresh());
      await page.screenshot({ path: join(WORK, file), fullPage: true });
    },
    async close() {
      await context.close();
      phase.wallMs = Date.now() - started;
      phase.consoleErrors = consoleErrors;
      phase.network = readNetLog(netLogPath, extensionId);
      return phase.network;
    },
  };
}

/** No request left the extension, apart from the expected negative-control probe. */
function checkNoCloudTraffic(name, network, { probeExpected }) {
  check(name, 'NetLog recorded', network.available, network.available ? `${network.bytes} bytes` : 'missing');
  if (!network.available) return;
  const fromExtension = network.extension.filter((entry) => !(probeExpected && entry.url.startsWith('https://huggingface.co/api/models')));
  check(name, 'extension made no network request', fromExtension.length === 0, fromExtension.slice(0, 5));
  if (probeExpected) check(name, 'the negative-control request is in the NetLog (the log does see extension requests)', network.extension.length - fromExtension.length >= 1);
  // Whatever the initiator: the only other requests in the log are Chromium's own service calls.
  const elsewhere = network.browser.filter((entry) => !CHROMIUM_OWN.test(entry.host));
  check(name, 'no request to any other host from anywhere in the browser', elsewhere.length === 0, elsewhere.slice(0, 5));
}

function checkEngineLedger(name, ledger) {
  const all = [...ledger.engines.vosk, ...ledger.engines.whisper, ...(ledger.engines.live ?? [])];
  const blocked = all.filter((attempt) => attempt.outcome === 'blocked');
  check(name, 'engines tried no outside request', blocked.length === 0, blocked.slice(0, 5));
  return { requests: all.length, localStore: all.filter((attempt) => attempt.outcome === 'local-store').length, blocked: blocked.length };
}

function checkLive(name, label, live, { expectInterims = true } = {}) {
  const score = scoreRevision(REFERENCE.words, live.revision);
  const latency = visibleLatency(REFERENCE.words, live.revision, live.visible);
  live.score = { ...score, visibleLatency: latency };
  check(name, `${label}: capture kept every sample`, live.capture.samples === live.capture.expectedSamples && live.stats.receivedSamples === live.capture.expectedSamples, live.capture);
  check(name, `${label}: handing audio over never blocked capture`, live.capture.maxSendMs <= LIMITS.maxSendMs, `${live.capture.maxSendMs} ms max`);
  if (expectInterims) check(name, `${label}: provisional text follows the spoken word (p50 ≤ ${LIMITS.visibleLatencyP50Ms} ms, p90 ≤ ${LIMITS.visibleLatencyP90Ms} ms)`, live.counts.interim >= 10 && latency.p90Ms !== null && latency.p50Ms <= LIMITS.visibleLatencyP50Ms && latency.p90Ms <= LIMITS.visibleLatencyP90Ms, { interims: live.counts.interim, ...latency });
  check(name, `${label}: word error rate ≤ ${LIMITS.liveWer}`, score.wer !== null && score.wer <= LIMITS.liveWer, score.wer);
  check(name, `${label}: word starts p90 ≤ ${LIMITS.liveStartP90Ms} ms`, score.startAbsP90Ms !== null && score.startAbsP90Ms <= LIMITS.liveStartP90Ms, { biasMs: score.startBiasMs, medianMs: score.startAbsMedianMs, p90Ms: score.startAbsP90Ms });
  check(name, `${label}: words ordered and inside their segment`, score.wordsMonotonic && score.wordsInsideSegments);
  check(name, `${label}: no errors, no gaps`, live.counts.errors === 0 && live.counts.gaps === 0, { errors: live.errors, gaps: live.revision.gaps });
  check(name, `${label}: revision marked aligned, provider browser-local`, live.revision.provider === 'browser-local' && live.revision.timing?.quality === 'aligned' && live.revision.segments.every((segment) => segment.timing === 'aligned'));
  return score;
}

function checkFinal(name, label, result, range) {
  const score = scoreRevision(REFERENCE.words, result.revision, range);
  result.score = score;
  check(name, `${label}: word error rate ≤ ${LIMITS.finalWer}`, score.wer !== null && score.wer <= LIMITS.finalWer, score.wer);
  check(name, `${label}: word starts p90 ≤ ${LIMITS.finalStartP90Ms} ms`, score.startAbsP90Ms !== null && score.startAbsP90Ms <= LIMITS.finalStartP90Ms, { biasMs: score.startBiasMs, medianMs: score.startAbsMedianMs, p90Ms: score.startAbsP90Ms });
  check(name, `${label}: words ordered and inside their segment`, score.wordsMonotonic && score.wordsInsideSegments);
  return score;
}

async function main() {
  if (!existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('dist/demo-extension is missing: run node build.mjs first');
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const allFiles = Object.values(MODELS).flatMap((manifest) => manifest.files.map((file) => `${manifest.id}/${file.path}`));

  // ── A: online, models never downloaded. Nothing may be fetched without the user asking. ──
  {
    const name = 'A-online-model-missing';
    const p = await startPhase(name, { offline: false });
    const env = await p.run('env', 'env');
    report.browser = env;
    check(name, 'page is cross-origin isolated (WebAssembly threads available)', env.crossOriginIsolated === true);
    const status = await p.run('status', 'status');
    check(name, 'both models report missing', status.models.every((model) => model.state === 'missing') && status.ui.state === 'missing', status.ui);
    const live = await p.run('live-missing', 'live', { seconds: 6, speed: 3, revision: false });
    check(name, 'live start without the model reports model-missing', live.errors.length === 1 && live.errors[0].code === 'model-missing' && live.errors[0].kind === 'model', live.errors);
    check(name, 'capture kept every sample', live.capture.samples === live.capture.expectedSamples && live.stats.receivedSamples === live.capture.expectedSamples, live.capture);
    check(name, 'the audio is recorded as one gap for a later retry', live.revision.gaps.length === 1 && live.revision.gaps[0].reason === 'model-missing' && live.revision.gaps[0].startMs === 0 && live.revision.gaps[0].endMs === live.audioMs, live.revision.gaps);
    check(name, 'bundle export keeps the schema reason and the local detail', live.bundle.gaps[0]?.reason === 'not-transcribed' && live.bundle.gaps[0]?.detail === 'model-missing', live.bundle.gaps);
    check(name, 'status for the recorder: disconnected, model-missing', live.uiStates.at(-1)?.state === 'disconnected' && live.uiStates.at(-1)?.reasonCode === 'model-missing', live.uiStates);
    const final = await p.run('final-missing', 'finalize');
    check(name, 'final pass without the model fails with model-missing, no revision', final.ok === false && final.error.code === 'model-missing' && final.revisionsAfter.length === 0, final.error);
    const ledger = await p.run('ledger', 'ledger');
    checkEngineLedger(name, ledger);
    check(name, 'nothing was downloaded', ledger.downloads.length === 0, ledger.downloads);
    await p.screenshot('setup-missing.png');
    const network = await p.close();
    // The network is up here: silence proves there is no automatic download and no cloud fallback.
    checkNoCloudTraffic(name, network, { probeExpected: false });
  }

  // ── B: online, the user asks for the download. ──
  {
    const name = 'B-online-install';
    const p = await startPhase(name, { offline: false });
    const install = await p.run('install', 'install');
    check(name, 'both models installed', install.results.every((result) => result.ok && result.status.state === 'ready' && result.status.verified), install.results.map((result) => ({ id: result.id, ok: result.ok, ms: result.ms, error: result.error })));
    check(name, 'download progress was reported', Object.values(install.progressEvents).every((count) => count >= 3) && Object.keys(install.progressEvents).length === 2, install.progressEvents);
    check(name, 'every pinned file was downloaded once', install.downloads.length === allFiles.length && install.downloads.every((download) => download.ok), install.downloads.length);
    check(name, 'downloads went only to the declared hosts', install.downloads.every((download) => hostAllowed(download.host)), [...new Set(install.downloads.map((download) => download.host))]);
    check(name, 'status for the recorder: ready', install.ui.state === 'ready' && install.ui.bytesDone === install.ui.bytesTotal, install.ui);
    const deep = await p.run('verify', 'status', { deep: true });
    check(name, 'integrity check passes for both models', deep.models.every((model) => model.state === 'ready' && model.verified && model.badFiles.length === 0));
    report.storage = (await p.run('env-after', 'env')).storage;
    await p.screenshot('setup-ready.png');
    const network = await p.close();
    check(name, 'NetLog recorded', network.available);
    if (network.available) {
      const hosts = [...new Set(network.extension.map((entry) => entry.host))];
      p.phase.downloadHosts = hosts;
      if (MIRROR) check(name, 'download hosts (mirror run: not evidence)', true, hosts);
      else check(name, 'NetLog: the extension contacted only the declared model hosts', hosts.length > 0 && hosts.every(hostAllowed), hosts);
    }
  }

  // ── C: offline. Live in the offscreen document, then a final pass that is cancelled part-way. ──
  let liveRevisionId;
  {
    const name = 'C-offline-live';
    const p = await startPhase(name, { offline: true });
    const probe = await p.run('probe', 'probeNetwork');
    check(name, 'network is disabled (an allowed request fails)', probe.reachable === false, probe);
    const deep = await p.run('verify', 'status', { deep: true });
    check(name, 'models ready after restart, offline', deep.models.every((model) => model.state === 'ready' && model.verified) && deep.ui.state === 'ready');
    const env = await p.runInOffscreen('env-offscreen', 'env');
    check(name, 'offscreen document is cross-origin isolated', env.crossOriginIsolated === true && env.context === '/offscreen.html', env.context);
    const live = await p.runInOffscreen('live', 'live', { speed: 1 });
    liveRevisionId = live.revisionId;
    checkLive(name, 'live at real time in the offscreen document', live);
    check(name, 'live session stayed live, never behind', live.statsAtStop.behind === false && live.stats.skips === 0 && live.stats.restarts === 0 && live.uiStates.some((state) => state.state === 'live'), { maxLagMs: live.stats.maxLagMs, startMs: live.startMs, finishMs: live.finishMs, uiStates: live.uiStates });
    const stopped = await p.run('final-cancelled', 'finalize', { stopAfter: 2 });
    check(name, 'final pass cancelled after 2 spans: no revision, checkpoint kept', stopped.ok === false && stopped.error.code === 'aborted' && stopped.checkpoints >= 2 && stopped.revisionsAfter.length === 1, { error: stopped.error, checkpoints: stopped.checkpoints, revisions: stopped.revisionsAfter });
    const offscreenLedger = await p.runInOffscreen('ledger-offscreen', 'ledger');
    p.phase.offscreenEngineRequests = checkEngineLedger(name, offscreenLedger);
    const ledger = await p.run('ledger', 'ledger');
    p.phase.pageEngineRequests = checkEngineLedger(name, ledger);
    check(name, 'nothing was downloaded', ledger.downloads.length === 0 && offscreenLedger.downloads.length === 0);
    const network = await p.close();
    checkNoCloudTraffic(name, network, { probeExpected: true });
  }

  // ── D: offline, after a restart. Resume the final pass, fall behind, damaged models. ──
  let finalRevisionId;
  {
    const name = 'D-offline-final-behind-corrupt';
    const p = await startPhase(name, { offline: true });
    const probe = await p.run('probe', 'probeNetwork');
    check(name, 'network is disabled (an allowed request fails)', probe.reachable === false, probe);

    const final = await p.run('final-resumed', 'finalize', { resume: true, supersedes: liveRevisionId });
    check(name, 'final pass resumed from the checkpoint after a restart', final.ok === true && final.resumed === true && final.stats.resumedSpans >= 2 && final.stats.failedSpans === 0, final.ok ? final.stats : final.error);
    if (final.ok) {
      finalRevisionId = final.revisionId;
      checkFinal(name, 'final text', final);
      check(name, 'final revision marked approximate, with the correction applied', final.revision.timing?.quality === 'approximate' && final.revision.timing.correctionMs < 0 && final.revision.segments.every((segment) => segment.timing === 'approximate'), final.revision.timing);
      check(name, 'final revision has no gaps and names the live revision it supersedes', final.revision.gaps.length === 0 && final.revision.supersedes === liveRevisionId);
      p.phase.finalEngine = final.engine;
      p.phase.finalRealTimeFactor = Math.round((final.wallMs / AUDIO_MS) * 1000) / 1000;
    }
    const revisions = await p.run('revisions', 'revisions');
    check(name, 'both revisions kept; the live one is unchanged', revisions.revisions.length === 2 && revisions.revisions[0].revisionId === liveRevisionId && revisions.revisions[0].model === 'vosk-small-en-us' && revisions.revisions[1].model === 'whisper-base.en-q8' && revisions.active === finalRevisionId, revisions.revisions.map((revision) => ({ id: revision.revisionId, model: revision.model, timing: revision.timing?.quality, segments: revision.segments })));

    // Audio arrives 12 times faster than real time, with low limits, so the engine cannot keep up.
    const behind = await p.run('live-behind', 'live', { speed: 12, revision: false, config: { behindMs: 1500, recoveredMs: 500, maxBacklogMs: 5000, keepAfterSkipMs: 1000 } });
    check(name, 'behind: capture kept every sample', behind.capture.samples === behind.capture.expectedSamples && behind.stats.receivedSamples === behind.capture.expectedSamples, behind.capture);
    check(name, 'behind: handing audio over never blocked capture', behind.capture.maxSendMs <= LIMITS.maxSendMs, `${behind.capture.maxSendMs} ms max`);
    check(name, 'behind: reported to the caller', behind.backlog.some((entry) => entry.behind === true) && behind.uiStates.some((state) => state.reasonCode === 'catching-up'), { events: behind.backlog.length, maxLagMs: behind.stats.maxLagMs, uiStates: behind.uiStates });
    check(name, 'behind: skipped audio is a gap marked engine-behind, not lost', behind.stats.skips >= 1 && behind.revision.gaps.some((gap) => gap.reason === 'engine-behind'), { skips: behind.stats.skips, gaps: behind.revision.gaps });
    check(name, 'behind: the session went on and produced text after the skip', behind.counts.final >= 1 && behind.counts.errors === 0, behind.counts);

    // A damaged final model.
    const whisperFile = 'onnx/encoder_model_quantized.onnx';
    await p.run('corrupt-whisper', 'corrupt', { model: 'whisper-base.en-q8', path: whisperFile });
    const badFinal = await p.run('final-corrupt', 'finalize');
    check(name, 'damaged final model: the final pass fails with model-corrupt, no revision added', badFinal.ok === false && badFinal.error.code === 'model-corrupt' && badFinal.revisionsAfter.length === 2, badFinal.error);

    // A damaged live model.
    await p.run('corrupt-vosk', 'corrupt', { model: 'vosk-small-en-us', path: 'model.tar.gz' });
    const badLive = await p.run('live-corrupt', 'live', { seconds: 6, speed: 3, revision: false });
    check(name, 'damaged live model: model-corrupt reported, capture complete, audio is a gap', badLive.errors[0]?.code === 'model-corrupt' && badLive.capture.samples === badLive.capture.expectedSamples && badLive.revision.gaps[0]?.reason === 'model-corrupt' && badLive.counts.final === 0, { errors: badLive.errors, gaps: badLive.revision.gaps });
    const status = await p.run('status-corrupt', 'status', { deep: true });
    check(name, 'status for the recorder: failed, model-corrupt; the bad files are named', status.ui.state === 'failed' && status.ui.reasonCode === 'model-corrupt' && status.models.every((model) => model.state === 'corrupt' && model.badFiles.length === 1), status.models.map((model) => ({ id: model.id, state: model.state, badFiles: model.badFiles })));
    await p.screenshot('setup-corrupt.png');

    // Repair needs the network; offline it fails and says so. Nothing else is tried.
    const repair = await p.run('repair-offline', 'repair', { model: 'whisper-base.en-q8' });
    check(name, 'repair while offline fails visibly', repair.ok === false && repair.error.code === 'download-failed' && repair.ui.state === 'failed', { error: repair.error, ui: repair.ui });
    const stillBad = await p.run('final-still-corrupt', 'finalize');
    check(name, 'still no transcript from anywhere else', stillBad.ok === false && ['model-corrupt', 'model-missing'].includes(stillBad.error.code), stillBad.error);
    const ledger = await p.run('ledger', 'ledger');
    p.phase.pageEngineRequests = checkEngineLedger(name, ledger);
    const network = await p.close();
    p.phase.repairAttempts = ledger.downloads;
    // The refused repair is the one request the extension may have tried here.
    const repairUrls = new Set(MODELS['whisper-base.en-q8'].files.map((file) => file.url));
    const other = (network.extension ?? []).filter((entry) => !entry.url.startsWith('https://huggingface.co/api/models') && !repairUrls.has(entry.url));
    check(name, 'NetLog: only the probe and the refused repair request', network.available && other.length === 0, other.slice(0, 5));
    const elsewhere = (network.browser ?? []).filter((entry) => !CHROMIUM_OWN.test(entry.host));
    check(name, 'no request to any other host from anywhere in the browser', elsewhere.length === 0, elsewhere.slice(0, 5));
  }

  // ── E: online. Repair downloads the damaged files only. ──
  {
    const name = 'E-online-repair';
    const p = await startPhase(name, { offline: false });
    const whisper = await p.run('repair-whisper', 'repair', { model: 'whisper-base.en-q8' });
    check(name, 'final model repaired; only the damaged file was downloaded', whisper.ok === true && whisper.status.state === 'ready' && whisper.downloads.length === 1 && whisper.downloads[0].path === 'onnx/encoder_model_quantized.onnx', whisper.ok ? whisper.downloads : whisper.error);
    const vosk = await p.run('repair-vosk', 'repair', { model: 'vosk-small-en-us' });
    check(name, 'live model repaired', vosk.ok === true && vosk.status.state === 'ready' && vosk.downloads.length === 1, vosk.ok ? vosk.downloads : vosk.error);
    const deep = await p.run('verify', 'status', { deep: true });
    check(name, 'integrity check passes again', deep.models.every((model) => model.state === 'ready' && model.verified) && deep.ui.state === 'ready');
    await p.close();
  }

  // ── F: offline again. Retry from the captured audio; every revision is still there. ──
  {
    const name = 'F-offline-retry';
    const p = await startPhase(name, { offline: true });
    const probe = await p.run('probe', 'probeNetwork');
    check(name, 'network is disabled (an allowed request fails)', probe.reachable === false, probe);
    const range = { startMs: 8000, endMs: 20000 };
    const retry = await p.run('retry-range', 'finalize', { ranges: [range], base: finalRevisionId, supersedes: finalRevisionId });
    check(name, 'retry of one time range from the captured audio', retry.ok === true && retry.stats.failedSpans === 0 && retry.stats.spans >= 1 && retry.stats.audioMs < AUDIO_MS, retry.ok ? retry.stats : retry.error);
    if (retry.ok) {
      checkFinal(name, 'retried revision, whole recording', retry);
      check(name, 'retried revision supersedes the final one and has no gaps', retry.revision.supersedes === finalRevisionId && retry.revision.gaps.length === 0);
    }
    const live = await p.run('live-after-repair', 'live', { speed: 1, seconds: 12, revision: false });
    check(name, 'live works again after the repair (repaired model, extracted copy rebuilt)', live.counts.errors === 0 && live.counts.final >= 1 && live.counts.interim >= 3 && live.capture.samples === live.capture.expectedSamples, live.counts);
    const revisions = await p.run('revisions', 'revisions');
    check(name, 'three revisions kept, in order; the newest is active', revisions.revisions.length === 3 && revisions.revisions.map((revision) => revision.model).join() === 'vosk-small-en-us,whisper-base.en-q8,whisper-base.en-q8' && revisions.active === revisions.revisions[2].revisionId, revisions.revisions.map((revision) => ({ id: revision.revisionId, model: revision.model, supersedes: revision.supersedes })));
    const ledger = await p.run('ledger', 'ledger');
    p.phase.pageEngineRequests = checkEngineLedger(name, ledger);
    check(name, 'nothing was downloaded', ledger.downloads.length === 0);
    const network = await p.close();
    checkNoCloudTraffic(name, network, { probeExpected: true });
  }
}

let crashed = null;
try {
  await main();
} catch (error) {
  crashed = error;
  check('harness', 'run completed', false, String(error?.stack ?? error).slice(0, 1500));
}

const failed = checks.filter((entry) => !entry.pass);
const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
// CPUs this run (and the browser it starts) may use; `taskset -c` narrows it to stand in for a small machine.
let cpusAllowed = null;
try {
  cpusAllowed = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? null;
} catch {
  // Not Linux.
}
const machine = { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, cpusAllowed, memoryGb: Math.round(totalmem() / 2 ** 30), platform: process.platform, node: process.version };
const pick = (phase, step) => report.phases[phase]?.steps?.[step];
const summary = {
  ticket: 16544,
  ranAt: new Date().toISOString(),
  verdict,
  modelSource: MIRROR ? 'local mirror of the pinned files (the download hosts were not contacted)' : 'pinned public hosts',
  machine: { ...machine, finalEngineThreadCap: THREADS || null },
  browser: report.browser,
  storage: report.storage,
  limits: LIMITS,
  checks: { total: checks.length, failed: failed.length, list: checks.map((entry) => ({ phase: entry.phase, name: entry.name, pass: entry.pass, ...(entry.pass ? {} : { detail: entry.detail }) })) },
  live: (() => {
    const live = pick('C-offline-live', 'live');
    return live && { context: 'offscreen document', audioMs: live.audioMs, engineStartMs: live.startMs, finishMs: live.finishMs, counts: live.counts, maxLagMs: live.stats.maxLagMs, score: live.score, firstInterims: live.firstInterims, text: live.revision.segments.map((segment) => segment.text).join(' ') };
  })(),
  final: (() => {
    const final = pick('D-offline-final-behind-corrupt', 'final-resumed');
    return final?.ok && { audioMs: final.audioMs, wallMs: final.wallMs, stats: final.stats, engine: final.engine, timing: final.revision.timing, score: final.score, text: final.revision.segments.map((segment) => segment.text).join(' ') };
  })(),
  behind: (() => {
    const behind = pick('D-offline-final-behind-corrupt', 'live-behind');
    return behind && { speed: behind.speed, capture: behind.capture, stats: behind.stats, backlogEvents: behind.backlog.length, gaps: behind.revision.gaps, uiStates: behind.uiStates, finalSegments: behind.counts.final };
  })(),
  retry: (() => {
    const retry = pick('F-offline-retry', 'retry-range');
    return retry?.ok && { wallMs: retry.wallMs, stats: retry.stats, score: retry.score };
  })(),
  network: Object.fromEntries(
    Object.values(report.phases).map((phase) => [
      phase.name,
      {
        offline: phase.offline,
        wallMs: phase.wallMs,
        netLogAvailable: phase.network?.available ?? false,
        extensionRequests: phase.network?.extension?.length ?? null,
        extensionHosts: [...new Set((phase.network?.extension ?? []).map((entry) => entry.host))],
        browserOwnHosts: [...new Set((phase.network?.browser ?? []).map((entry) => entry.host))],
        engineRequests: phase.pageEngineRequests,
        offscreenEngineRequests: phase.offscreenEngineRequests,
        consoleErrors: phase.consoleErrors,
      },
    ]),
  ),
};

const out = process.env.NARWAL_E2E_OUT ?? join(ROOT, 'results/e2e.summary.json');
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(WORK, 'e2e.raw.json'), JSON.stringify({ report, checks }, null, 1));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; summary: ${out}`);
if (crashed) console.log(`harness error: ${crashed.message}`);
console.log(`VERDICT=${verdict}`);
process.exit(failed.length === 0 ? 0 : 1);
