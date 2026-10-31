// Checks the e2e harness drives inside the proof extension (board #16544).
// Each one exercises the product module the way the capture layer will, and
// returns plain data; e2e/run.mjs scores it against the fixture.

import { createBrowserOfflineTranscriber } from '../src/browser.ts';
import type { BrowserOfflineTranscriber } from '../src/browser.ts';
import { ENGINE_SAMPLE_RATE, decodeToEnginePcm, floatToPcm16 } from '../src/audio.ts';
import type { AdapterEvent, TranscriptRevision } from '../src/contract.ts';
import type { FinalPassCheckpoint, TimeRange } from '../src/final-pass.ts';
import type { LiveSessionConfig } from '../src/live-session.ts';
import { MODEL_CACHE_NAME, ModelError } from '../src/model-store.ts';
import { MODELS, storageKey } from '../src/models.ts';
import type { ModelId } from '../src/models.ts';
import { LiveRevisionCollector, RevisionSet, toBundleRevision } from '../src/revisions.ts';
import { UiTranscriptTracker } from '../src/status.ts';
import { pcmSource } from '../src/vad.ts';

declare const chrome: { runtime: { getURL(path: string): string } };

// An offscreen document cannot use the extension storage API, so the proof
// keeps its small state in localStorage, which the setup page and the
// offscreen document share.
const stored = {
  get<T>(key: string): T | undefined {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as T);
  },
  set(key: string, value: unknown): void {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

/** The pair this proof measures (#16544). The extension picks its final model by tier (tier.ts, #16603). */
export const PROOF_MODELS: ModelId[] = ['vosk-small-en-us', 'whisper-base.en-q8'];

const REVISIONS_KEY = 'narwal.proof.revisions';
const CHECKPOINT_KEY = 'narwal.proof.checkpoint';
const RECORDING_ID = 'proof-fixture-31s';

let offline: BrowserOfflineTranscriber | null = null;
export function getOffline(): BrowserOfflineTranscriber {
  // `?threads=N` caps the final engine's threads, to stand in for a machine with N cores.
  const threads = Number(new URLSearchParams(location.search).get('threads')) || undefined;
  offline ??= createBrowserOfflineTranscriber(chrome.runtime.getURL('runtime/'), { maxThreads: threads });
  return offline;
}

let fixture: Promise<Float32Array> | null = null;
/** The fixture stands in for the captured narration: same bytes for live and for every retry. */
function capturedAudio(): Promise<Float32Array> {
  fixture ??= audioFile('fixtures/speech-en-31s.flac');
  return fixture;
}

/** A recording inside the extension, decoded as the engines hear it. */
function audioFile(path: string): Promise<Float32Array> {
  return fetch(chrome.runtime.getURL(path))
    .then((response) => response.arrayBuffer())
    .then(decodeToEnginePcm);
}

async function loadRevisions(): Promise<RevisionSet> {
  const saved = stored.get<{ revisions: TranscriptRevision[]; active: string | null }>(REVISIONS_KEY);
  return new RevisionSet(saved?.revisions ?? [], saved?.active ?? null);
}

async function saveRevisions(set: RevisionSet): Promise<void> {
  stored.set(REVISIONS_KEY, { revisions: set.list(), active: set.activeRevision });
}

function errorInfo(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof ModelError) return { name: error.name, code: error.code, message: error.message };
  const e = error as { name?: string; code?: string; message?: string };
  return { name: e?.name ?? 'Error', code: e?.code, message: e?.message ?? String(error) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const checks: Record<string, (args: any) => Promise<unknown>> = {
  async env() {
    const estimate = await navigator.storage.estimate();
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webgpu: 'gpu' in navigator,
      storage: { usage: estimate.usage, quota: estimate.quota, persisted: await navigator.storage.persisted() },
      context: location.pathname,
    };
  },

  async status(args: { deep?: boolean } = {}) {
    const { transcriber } = getOffline();
    const models = [];
    for (const id of PROOF_MODELS) models.push(args.deep ? await transcriber.models.verify(id) : await transcriber.models.status(id));
    return { models, ui: await transcriber.uiModel(PROOF_MODELS) };
  },

  async install(args: { models?: ModelId[] } = {}) {
    const { transcriber } = getOffline();
    const before = transcriber.models.downloads.length;
    const progress: Record<string, number> = {};
    const results = [];
    for (const id of args.models ?? PROOF_MODELS) {
      const started = performance.now();
      try {
        const status = await transcriber.models.install(id, {
          onProgress: () => {
            progress[id] = (progress[id] ?? 0) + 1;
          },
        });
        results.push({ id, ok: true, status, ms: Math.round(performance.now() - started) });
      } catch (error) {
        results.push({ id, ok: false, error: errorInfo(error), status: await transcriber.models.status(id) });
      }
    }
    return { results, progressEvents: progress, downloads: transcriber.models.downloads.slice(before), ui: await transcriber.uiModel(PROOF_MODELS) };
  },

  async repair(args: { model: ModelId }) {
    const { transcriber } = getOffline();
    const before = transcriber.models.downloads.length;
    try {
      const status = await transcriber.models.repair(args.model);
      return { ok: true, status, downloads: transcriber.models.downloads.slice(before), ui: await transcriber.uiModel(PROOF_MODELS) };
    } catch (error) {
      return { ok: false, error: errorInfo(error), status: await transcriber.models.status(args.model), downloads: transcriber.models.downloads.slice(before), ui: await transcriber.uiModel(PROOF_MODELS) };
    }
  },

  async remove(args: { model: ModelId }) {
    const offlineNow = getOffline();
    if (args.model === 'vosk-small-en-us') offlineNow.vosk.terminate();
    else offlineNow.whisper.terminate();
    await offlineNow.transcriber.models.remove(args.model);
    return { status: await offlineNow.transcriber.models.status(args.model) };
  },

  /** Test hook: damages a stored model file in place, keeping its size (what a bad disk block looks like). */
  async corrupt(args: { model: ModelId; path: string }) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const key = storageKey(args.model, args.path);
    const stored = await cache.match(key);
    if (!stored) return { ok: false, error: 'not stored' };
    const data = new Uint8Array(await stored.arrayBuffer());
    for (let i = Math.floor(data.length / 2); i < Math.min(data.length, Math.floor(data.length / 2) + 4096); i += 1) data[i] ^= 0xff;
    await cache.put(key, new Response(new Blob([data])));
    const offlineNow = getOffline();
    offlineNow.vosk.terminate();
    offlineNow.whisper.terminate();
    return { ok: true, bytes: data.length, pinned: MODELS[args.model].files.find((file) => file.path === args.path)?.bytes };
  },

  /**
   * Feeds the captured audio to a live session in 100 ms chunks, `speed` times
   * real time. A separate counter stands in for the durable capture path: it
   * must see every chunk, on time, whatever the engine does. `audio` (a file
   * in the extension) replaces the fixture, for e2e/measure-live.mjs.
   */
  async live(args: { speed?: number; seconds?: number; config?: Partial<LiveSessionConfig>; revision?: boolean; audio?: string } = {}) {
    const offlineNow = getOffline();
    const { transcriber } = offlineNow;
    const pcm = args.audio ? await audioFile(args.audio) : await capturedAudio();
    const total = Math.min(pcm.length, Math.round((args.seconds ?? 1e9) * ENGINE_SAMPLE_RATE));
    const speed = args.speed ?? 1;
    const frame = ENGINE_SAMPLE_RATE / 10;
    const revisions = await loadRevisions();
    const revisionId = revisions.nextId();
    const collector = new LiveRevisionCollector({ revisionId, createdAtMs: Date.now() });
    const ui = new UiTranscriptTracker();
    const uiStates: { atMs: number; state: string; reasonCode: string }[] = [];
    const events: { atMs: number; event: AdapterEvent }[] = [];
    // Event times are on the audio clock: milliseconds since the first sample was spoken (negative while the engine starts).
    const startedAt = performance.now();
    let feedStartedAt: number | null = null;
    const audioClock = () => (feedStartedAt === null ? -1 : Math.round((performance.now() - feedStartedAt) * speed));
    let finalWords = 0;
    const visible: { atMs: number; words: number }[] = [];
    const onEvent = (event: AdapterEvent) => {
      const atMs = audioClock();
      events.push({ atMs, event });
      collector.onEvent(event);
      ui.onEvent(event);
      if (event.type === 'segment') {
        const words = event.segment.text.split(/\s+/).filter(Boolean).length;
        if (event.segment.kind === 'final') finalWords += words;
        visible.push({ atMs, words: event.segment.kind === 'final' ? finalWords : finalWords + words });
      }
      const now = ui.get();
      const last = uiStates[uiStates.length - 1];
      if (!last || last.state !== now.state || last.reasonCode !== now.reasonCode) uiStates.push({ atMs, state: now.state, reasonCode: now.reasonCode });
    };
    const session = await transcriber.startLive({ language: 'en', audioOriginMs: 0, connectionId: `live-${revisionId}` }, onEvent, args.config);
    const startMs = Math.round(performance.now() - startedAt);
    const feedStart = performance.now();
    feedStartedAt = feedStart;
    let capturedSamples = 0;
    let maxSendMs = 0;
    let lateChunks = 0;
    for (let offset = 0; offset < total; offset += frame) {
      const chunk = pcm.subarray(offset, Math.min(total, offset + frame));
      // A capture path delivers a chunk once its last sample has been spoken.
      const due = feedStart + (((offset + chunk.length) / ENGINE_SAMPLE_RATE) * 1000) / speed;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      else if (wait < -250) lateChunks += 1;
      capturedSamples += chunk.length; // the capture path: never waits for the engine
      const before = performance.now();
      session.sendAudio(floatToPcm16(chunk));
      maxSendMs = Math.max(maxSendMs, performance.now() - before);
    }
    const feedMs = Math.round(performance.now() - feedStart);
    const statsAtStop = session.stats();
    // The live worker stops with the session; read its heap first.
    const liveEngine = offlineNow.live.info ? { ...offlineNow.live.info } : null;
    await session.finish();
    const finishMs = Math.round(performance.now() - feedStart) - feedMs;
    const revision = collector.revision();
    if (args.revision ?? true) {
      revisions.add(revision);
      await saveRevisions(revisions);
    }
    const segments = events.filter((entry) => entry.event.type === 'segment');
    const interims = segments.filter((entry) => entry.event.type === 'segment' && entry.event.segment.kind === 'interim');
    return {
      revisionId,
      audioMs: Math.round((total / ENGINE_SAMPLE_RATE) * 1000),
      speed,
      startMs,
      feedMs,
      finishMs,
      capture: { samples: capturedSamples, expectedSamples: total, maxSendMs: Math.round(maxSendMs * 100) / 100, lateChunks },
      statsAtStop,
      stats: session.stats(),
      counts: {
        interim: interims.length,
        final: revision.segments.length,
        gaps: revision.gaps.length,
        errors: events.filter((entry) => entry.event.type === 'error').length,
        backlog: events.filter((entry) => entry.event.type === 'backlog').length,
      },
      // When each count of words first became visible (interim or final), for the visible-latency score.
      visible,
      // When each final arrived and when each of its words ended, both on the audio clock.
      finals: segments.map((entry) => (entry.event.type === 'segment' && entry.event.segment.kind === 'final' ? { atMs: entry.atMs, endMs: entry.event.segment.endMs, wordEndsMs: entry.event.segment.words.map((word) => word.endMs) } : null)).filter(Boolean),
      liveEngine,
      liveFallback: offlineNow.liveFallback,
      firstInterims: interims.slice(0, 5).map((entry) => (entry.event.type === 'segment' ? { atMs: entry.atMs, text: entry.event.segment.text, timing: entry.event.segment.timing } : null)),
      errors: events.filter((entry) => entry.event.type === 'error').map((entry) => (entry.event.type === 'error' ? entry.event.error : null)),
      backlog: events.filter((entry) => entry.event.type === 'backlog').map((entry) => ({ atMs: entry.atMs, ...(entry.event.type === 'backlog' ? { behind: entry.event.behind, lagMs: entry.event.lagMs } : {}) })),
      states: events.filter((entry) => entry.event.type === 'state').map((entry) => (entry.event.type === 'state' ? entry.event.state : '')),
      uiStates,
      revision,
      bundle: toBundleRevision(revision),
    };
  },

  /**
   * Final pass or retry over the captured audio. `stopAfter` cancels after that many spans; `resume` continues from the stored checkpoint.
   * `model` runs one final model instead of the default; `audio` (a file in the extension) replaces the fixture, for e2e/measure-final.mjs.
   */
  async finalize(args: { stopAfter?: number; resume?: boolean; ranges?: TimeRange[]; base?: string; supersedes?: string; model?: ModelId; audio?: string } = {}) {
    const offlineNow = getOffline();
    const pcm = args.audio ? await audioFile(args.audio) : await capturedAudio();
    const revisions = await loadRevisions();
    const revisionId = revisions.nextId();
    const controller = new AbortController();
    let checkpoints = 0;
    const resumeFrom = args.resume ? stored.get<FinalPassCheckpoint>(CHECKPOINT_KEY) : undefined;
    const started = performance.now();
    try {
      const { revision, stats } = await offlineNow.transcriber.finalize({
        recordingId: RECORDING_ID,
        revisionId,
        audio: pcmSource(pcm),
        audioOriginMs: 0,
        ranges: args.ranges,
        base: args.base ? revisions.get(args.base) : undefined,
        supersedes: args.supersedes,
        resumeFrom,
        signal: controller.signal,
        onCheckpoint: async (checkpoint) => {
          checkpoints += 1;
          stored.set(CHECKPOINT_KEY, checkpoint);
          if (args.stopAfter && checkpoints >= args.stopAfter) controller.abort();
        },
      }, args.model);
      revisions.add(revision);
      await saveRevisions(revisions);
      return { ok: true, revisionId, wallMs: Math.round(performance.now() - started), audioMs: Math.round((pcm.length / ENGINE_SAMPLE_RATE) * 1000), stats, checkpoints, resumed: Boolean(resumeFrom), engine: offlineNow.whisper.info, revision, bundle: toBundleRevision(revision) };
    } catch (error) {
      return { ok: false, error: errorInfo(error), checkpoints, wallMs: Math.round(performance.now() - started), revisionsAfter: (await loadRevisions()).list().map((revision) => revision.revisionId) };
    }
  },

  /**
   * One full final pass of `model` over an audio file packaged in the proof
   * extension (bench-final.mjs, board #16609). Load and transcription are
   * timed apart: the speed that decides the chain is the transcription's.
   */
  async benchFinal(args: { model: string; audio: string }) {
    const offlineNow = getOffline();
    const pcm = await fetch(chrome.runtime.getURL(args.audio))
      .then((response) => response.arrayBuffer())
      .then(decodeToEnginePcm);
    try {
      const loadStarted = performance.now();
      await offlineNow.whisper.getEngine(args.model);
      const loadMs = Math.round(performance.now() - loadStarted);
      const started = performance.now();
      const { revision, stats } = await offlineNow.transcriber.finalize({ recordingId: `bench-${args.audio}`, revisionId: `bench-${args.model}`, audio: pcmSource(pcm) }, args.model);
      return { ok: true, model: args.model, audioMs: Math.round((pcm.length / ENGINE_SAMPLE_RATE) * 1000), loadMs, transcribeMs: Math.round(performance.now() - started), engine: offlineNow.whisper.info, stats, revision };
    } catch (error) {
      return { ok: false, model: args.model, error: errorInfo(error) };
    } finally {
      offlineNow.whisper.terminate();
    }
  },

  async revisions() {
    const set = await loadRevisions();
    return {
      active: set.activeRevision,
      revisions: set.list().map((revision) => ({
        revisionId: revision.revisionId,
        source: revision.source,
        model: revision.model,
        timing: revision.timing,
        supersedes: revision.supersedes ?? null,
        segments: revision.segments.length,
        gaps: revision.gaps.length,
        text: revision.segments.map((segment) => segment.text).join(' '),
      })),
    };
  },

  /** Everything the engines and the model store touched on the network. */
  async ledger() {
    const offlineNow = getOffline();
    const engines = await offlineNow.engineNetworkLedger();
    return { engines, downloads: offlineNow.transcriber.models.downloads };
  },

  /** Negative control for the offline phases: a request the content security policy allows must still fail. */
  async probeNetwork() {
    try {
      const response = await fetch('https://huggingface.co/api/models?limit=1', { cache: 'no-store' });
      return { reachable: true, status: response.status };
    } catch (error) {
      return { reachable: false, error: String(error) };
    }
  },
};

export async function runSelftest(name: string, args?: unknown): Promise<unknown> {
  const check = checks[name];
  if (!check) throw new Error(`unknown check ${name}`);
  return check(args ?? {});
}
