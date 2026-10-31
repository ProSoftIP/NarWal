// Live offline transcription session (board #16544).
//
// Feeds captured audio to a live engine (Parakeet on speech spans, or Vosk
// streaming, #16617) and turns its answers into
// the same events the cloud adapters emit. The session never owns the only
// copy of the audio and never slows the caller: `sendAudio` returns at once,
// whatever the engine is doing. When the engine cannot keep up the session
// says so (`backlog`), and past a hard limit it skips ahead and records the
// skipped audio as a gap that the final pass fills from the captured audio.

import { pcm16ToFloat, ENGINE_SAMPLE_RATE } from './audio.ts';
import { LIVE_MODEL, LOCAL_PROVIDER, localError } from './contract.ts';
import type { AdapterEvent, AudioFormat, GapReason, LocalLiveAdapter, LocalLiveOptions, SessionMs, TimingQuality, TranscriptWord } from './contract.ts';
import { ModelError } from './model-store.ts';

export interface LiveEngineWord {
  word: string;
  /** Seconds of audio fed to this engine instance. */
  start: number;
  end: number;
  conf?: number;
}

export type LiveEngineMessage =
  | { type: 'partial'; text: string }
  | { type: 'result'; text: string; words: LiveEngineWord[] }
  | { type: 'error'; message: string };

/** One recognizer on a loaded model. */
export interface LiveEngine {
  /** The model name its segments carry; the session's `model` when absent. */
  readonly model?: string;
  /** How far to trust the word times of its results; `aligned` when absent. */
  readonly timing?: TimingQuality;
  /** Answered by exactly one `partial` or `result` message, in order. */
  feed(samples: Float32Array): void;
  /** Answered by one `result` message after every earlier feed. */
  flush(): void;
  /**
   * True when closing it as given up opens a different engine next (#16617).
   * The session then hands over at the first skip instead of skipping again.
   */
  readonly fallsBack?: boolean;
  /** `failed`: the session gave up on it (an error or no answer in time); `behind`: it could not keep up. */
  close(reason?: 'failed' | 'behind'): void;
}

/** Loads the verified model and opens a recognizer. Rejects with ModelError when the model is missing or corrupt. */
export type LiveEngineFactory = (onMessage: (message: LiveEngineMessage) => void) => Promise<LiveEngine>;

export interface LiveSessionConfig {
  createEngine: LiveEngineFactory;
  model?: string;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** Lag above this is reported as "catching up". */
  behindMs?: number;
  /** Lag below this ends "catching up". */
  recoveredMs?: number;
  /** Unsent audio above this is skipped (and becomes a gap). */
  maxBacklogMs?: number;
  /** Audio kept in front of the engine after a skip. */
  keepAfterSkipMs?: number;
  /** Largest chunk sent to the engine; queued audio is merged up to this. */
  maxChunkMs?: number;
  /** Chunks the engine may hold unanswered. */
  window?: number;
  /** An engine that holds audio this long without an answer is restarted. */
  stallMs?: number;
  maxRestarts?: number;
  /** `finish` waits this long for the engine to drain before it gives up. */
  finishWaitMs?: number;
}

export interface LiveSessionStats {
  receivedSamples: number;
  processedSamples: number;
  lagMs: number;
  maxLagMs: number;
  behind: boolean;
  skips: number;
  restarts: number;
  phase: string;
}

type Phase = 'idle' | 'starting' | 'open' | 'restarting' | 'unavailable' | 'closed';

interface InFlight {
  flush: boolean;
  /** Session sample index after this chunk. */
  sessionEnd: number;
  onAck?: () => void;
}

const DEFAULTS = {
  behindMs: 10_000,
  recoveredMs: 2_000,
  maxBacklogMs: 60_000,
  keepAfterSkipMs: 2_000,
  maxChunkMs: 500,
  window: 2,
  stallMs: 15_000,
  maxRestarts: 2,
  finishWaitMs: 5_000,
};

export class LocalLiveSession implements LocalLiveAdapter {
  readonly provider = LOCAL_PROVIDER;
  readonly audioFormat: AudioFormat = { kind: 'pcm_s16le', sampleRate: ENGINE_SAMPLE_RATE, channels: 1 };

  private readonly config: LiveSessionConfig;
  private readonly o: typeof DEFAULTS;
  private readonly model: string;
  private phase: Phase = 'idle';
  private options: LocalLiveOptions = { language: 'en', audioOriginMs: 0, connectionId: 'local' };
  private emit: (event: AdapterEvent) => void = () => {};
  private engine: LiveEngine | null = null;
  /** The model of the engine that is open, or was open last. */
  private engineModel: string;
  private generation = 0;
  private connection = 0;

  // All positions are sample indexes from the session's first sample.
  private received = 0;
  private queue: Float32Array[] = [];
  private queueStart = 0;
  private queued = 0;
  private inflight: InFlight[] = [];
  private processed = 0;
  /** Maps engine-fed samples onto session samples; a skip adds an entry. */
  private map: { fed: number; session: number }[] = [{ fed: 0, session: 0 }];
  private engineFed = 0;

  private utterance = 0;
  private utteranceStart = 0;
  private interimShown = false;
  private lastPartial = '';

  private unavailableFrom = 0;
  private unavailableReason: GapReason = 'engine-failed';
  private behind = false;
  private reportedLagMs = 0;
  private maxLagMs = 0;
  private waitingSince = 0;
  private skips = 0;
  private restarts = 0;
  private ready: Promise<void> = Promise.resolve();
  private drained: (() => void) | null = null;

  constructor(config: LiveSessionConfig) {
    this.config = config;
    this.model = config.model ?? LIVE_MODEL;
    this.engineModel = this.model;
    const overrides = Object.fromEntries(Object.entries(config).filter(([key, value]) => key in DEFAULTS && value !== undefined));
    this.o = { ...DEFAULTS, ...overrides };
  }

  private now(): number {
    return (this.config.now ?? (() => performance.now()))();
  }

  private ms(sample: number): SessionMs {
    return this.options.audioOriginMs + Math.round((sample / ENGINE_SAMPLE_RATE) * 1000);
  }

  private get connectionId(): string {
    return this.connection === 0 ? this.options.connectionId : `${this.options.connectionId}.${this.connection}`;
  }

  private get segmentKey(): string {
    return `${this.connectionId}:${this.utterance}`;
  }

  /**
   * Never rejects for a missing model or a broken engine: capture goes on, the
   * session reports the error and records the audio as a gap for a later retry.
   */
  async start(options: LocalLiveOptions, onEvent: (event: AdapterEvent) => void): Promise<void> {
    if (this.phase !== 'idle') throw new Error('LocalLiveSession.start called twice');
    this.options = options;
    this.emit = onEvent;
    this.phase = 'starting';
    this.emit({ type: 'state', state: 'connecting' });
    this.ready = this.openEngine();
    await this.ready;
  }

  private async openEngine(): Promise<void> {
    const generation = ++this.generation;
    try {
      const engine = await this.config.createEngine((message) => {
        if (generation === this.generation) this.onMessage(message);
      });
      if (generation !== this.generation || this.phase === 'closed') {
        engine.close();
        return;
      }
      this.engine = engine;
      this.engineModel = engine.model ?? this.model;
      this.engineFed = 0;
      this.map = [{ fed: 0, session: this.queueStart }];
      this.utteranceStart = this.queueStart;
      this.phase = 'open';
      this.emit({ type: 'state', state: 'open' });
      this.pump();
    } catch (error) {
      if (generation !== this.generation || this.phase === 'closed') return;
      if (error instanceof ModelError && (error.code === 'model-missing' || error.code === 'model-corrupt')) {
        this.emit({ type: 'error', error: localError(error.code, error.message, 'model') });
        this.becomeUnavailable(error.code);
        return;
      }
      this.engineFailed('engine-failed', error instanceof Error ? error.message : String(error));
    }
  }

  private becomeUnavailable(reason: GapReason): void {
    this.phase = 'unavailable';
    this.unavailableFrom = this.queueStart;
    this.unavailableReason = reason;
    this.queue = [];
    this.queued = 0;
    this.queueStart = this.received;
    this.emit({ type: 'state', state: 'closed' });
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.pushAudio(pcm16ToFloat(chunk));
  }

  /** Same as `sendAudio` for a caller that already has 16 kHz mono floats. The samples are copied. */
  pushAudio(samples: Float32Array): void {
    if (this.phase === 'idle' || this.phase === 'closed' || samples.length === 0) return;
    this.received += samples.length;
    if (this.phase === 'unavailable') {
      this.queueStart = this.received;
      return;
    }
    this.queue.push(samples.slice());
    this.queued += samples.length;
    if (this.phase === 'open' && this.inflight.length > 0 && this.now() - this.waitingSince > this.o.stallMs) {
      this.engineFailed('engine-stalled', `no answer from the engine for ${Math.round(this.o.stallMs / 1000)} s`);
    }
    if (this.queued > (this.o.maxBacklogMs / 1000) * ENGINE_SAMPLE_RATE) this.skipAhead();
    this.pump();
    this.updateBacklog();
  }

  private takeFromQueue(maxSamples: number): Float32Array {
    const parts: Float32Array[] = [];
    let total = 0;
    while (this.queue.length && total < maxSamples) {
      const head = this.queue[0];
      if (total + head.length <= maxSamples) {
        parts.push(head);
        total += head.length;
        this.queue.shift();
      } else if (total === 0) {
        parts.push(head.subarray(0, maxSamples));
        this.queue[0] = head.subarray(maxSamples);
        total = maxSamples;
      } else break;
    }
    this.queued -= total;
    this.queueStart += total;
    if (parts.length === 1) return parts[0];
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  private pump(): void {
    if (this.phase !== 'open' || !this.engine) return;
    const maxSamples = Math.round((this.o.maxChunkMs / 1000) * ENGINE_SAMPLE_RATE);
    while (this.queued > 0 && this.inflight.length < this.o.window) {
      const chunk = this.takeFromQueue(maxSamples);
      if (this.inflight.length === 0) this.waitingSince = this.now();
      this.inflight.push({ flush: false, sessionEnd: this.queueStart });
      this.engineFed += chunk.length;
      this.engine.feed(chunk);
    }
  }

  /** Drops the oldest unsent audio from the live path. The captured recording still has it. */
  private skipAhead(): void {
    const keep = Math.round((this.o.keepAfterSkipMs / 1000) * ENGINE_SAMPLE_RATE);
    const drop = this.queued - keep;
    if (drop <= 0) return;
    const from = this.queueStart;
    let left = drop;
    while (left > 0 && this.queue.length) {
      const head = this.queue[0];
      if (head.length <= left) {
        left -= head.length;
        this.queue.shift();
      } else {
        this.queue[0] = head.subarray(left);
        left = 0;
      }
    }
    this.queued -= drop;
    this.queueStart += drop;
    const to = this.queueStart;
    this.skips += 1;
    if (this.phase === 'open' && this.engine?.fallsBack) {
      // An engine that fell this far behind once falls behind again on the same
      // machine, leaving a hole every minute: hand over to the next engine now.
      this.engineFailed('engine-behind', `the live engine fell ${Math.round(this.o.maxBacklogMs / 1000)} s behind the recording`, 'engine-behind');
      return;
    }
    const announce = () => {
      this.emit({
        type: 'gap',
        gap: { provider: LOCAL_PROVIDER, startMs: this.ms(from), endMs: this.ms(to), reason: 'engine-behind', detail: 'live recognition skipped ahead; retry from the captured audio' },
      });
      this.connection += 1;
      this.utterance = 0;
      this.utteranceStart = to;
    };
    if (this.phase === 'open' && this.engine) {
      // Finish the utterance the engine is in, then continue after the skip.
      this.map.push({ fed: this.engineFed, session: to });
      if (this.inflight.length === 0) this.waitingSince = this.now();
      this.inflight.push({ flush: true, sessionEnd: from, onAck: announce });
      this.engine.flush();
    } else {
      announce();
    }
  }

  private engineSecondsToMs(seconds: number): SessionMs {
    const fed = seconds * ENGINE_SAMPLE_RATE;
    let entry = this.map[0];
    for (const candidate of this.map) {
      if (candidate.fed <= fed) entry = candidate;
      else break;
    }
    return this.ms(entry.session + (fed - entry.fed));
  }

  private onMessage(message: LiveEngineMessage): void {
    if (this.phase !== 'open') return;
    if (message.type === 'error') {
      this.engineFailed('engine-error', message.message);
      return;
    }
    const entry = this.inflight.shift();
    if (!entry) return;
    this.waitingSince = this.now();
    if (!entry.flush) this.processed = entry.sessionEnd;
    if (message.type === 'partial') {
      const text = message.text.trim();
      if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.interimShown = true;
        this.emit({
          type: 'segment',
          segment: {
            provider: LOCAL_PROVIDER,
            model: this.engineModel,
            connectionId: this.connectionId,
            segmentKey: this.segmentKey,
            kind: 'interim',
            startMs: this.ms(this.utteranceStart),
            endMs: this.ms(this.processed),
            text,
            words: [],
            endOfUtterance: false,
            timing: 'approximate',
          },
        });
      }
    } else {
      this.finalizeUtterance(message.text.trim(), message.words);
    }
    entry.onAck?.();
    this.pump();
    this.updateBacklog();
    if (this.drained && this.inflight.length === 0 && this.queued === 0) this.drained();
  }

  private finalizeUtterance(text: string, engineWords: LiveEngineWord[]): void {
    const words: TranscriptWord[] = engineWords.map((word) => {
      const startMs = this.engineSecondsToMs(word.start);
      const endMs = Math.max(startMs, this.engineSecondsToMs(word.end));
      return { text: word.word, startMs, endMs, ...(typeof word.conf === 'number' ? { confidence: word.conf } : {}) };
    });
    if (text || this.interimShown) {
      const startMs = words.length ? words[0].startMs : this.ms(this.utteranceStart);
      const endMs = words.length ? words[words.length - 1].endMs : this.ms(this.processed);
      this.emit({
        type: 'segment',
        segment: {
          provider: LOCAL_PROVIDER,
          model: this.engineModel,
          connectionId: this.connectionId,
          segmentKey: this.segmentKey,
          kind: 'final',
          startMs,
          endMs: Math.max(startMs, endMs),
          text,
          words,
          endOfUtterance: true,
          timing: text && words.length ? (this.engine?.timing ?? 'aligned') : 'approximate',
        },
      });
    }
    this.utterance += 1;
    this.utteranceStart = this.processed;
    this.interimShown = false;
    this.lastPartial = '';
  }

  private retractInterim(): void {
    if (this.interimShown) this.finalizeUtterance('', []);
  }

  private engineFailed(code: string, message: string, gapReason: GapReason = 'engine-failed'): void {
    const retry = this.restarts < this.o.maxRestarts;
    this.emit({ type: 'error', error: localError(code, message, 'provider', retry) });
    this.generation += 1;
    try {
      this.engine?.close(gapReason === 'engine-behind' ? 'behind' : 'failed');
    } catch {
      // The engine is already gone.
    }
    this.engine = null;
    this.inflight = [];
    const lostFrom = this.utteranceStart;
    this.retractInterim();
    if (this.queueStart > lostFrom) {
      this.emit({
        type: 'gap',
        gap: { provider: LOCAL_PROVIDER, startMs: this.ms(lostFrom), endMs: this.ms(this.queueStart), reason: gapReason, detail: code },
      });
    }
    this.processed = this.queueStart;
    this.connection += 1;
    this.utterance = 0;
    if (!retry) {
      this.becomeUnavailable('engine-failed');
      return;
    }
    this.restarts += 1;
    this.phase = 'restarting';
    this.emit({ type: 'state', state: 'connecting' });
    this.ready = this.openEngine();
  }

  private updateBacklog(): void {
    const lagMs = Math.round(((this.received - this.processed) / ENGINE_SAMPLE_RATE) * 1000);
    this.maxLagMs = Math.max(this.maxLagMs, lagMs);
    if (!this.behind && lagMs > this.o.behindMs) {
      this.behind = true;
    } else if (this.behind && lagMs < this.o.recoveredMs) {
      this.behind = false;
    } else if (!this.behind || Math.abs(lagMs - this.reportedLagMs) < 1000) {
      return;
    }
    this.reportedLagMs = lagMs;
    this.emit({ type: 'backlog', behind: this.behind, lagMs });
  }

  stats(): LiveSessionStats {
    return {
      receivedSamples: this.received,
      processedSamples: this.processed,
      lagMs: Math.round(((this.received - this.processed) / ENGINE_SAMPLE_RATE) * 1000),
      maxLagMs: this.maxLagMs,
      behind: this.behind,
      skips: this.skips,
      restarts: this.restarts,
      phase: this.phase,
    };
  }

  private wait(ms: number, until: (resolve: () => void) => void): Promise<boolean> {
    const timers = this.config.timers ?? { set: (fn, delay) => setTimeout(fn, delay), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    return new Promise((resolve) => {
      const handle = timers.set(() => resolve(false), ms);
      until(() => {
        timers.clear(handle);
        resolve(true);
      });
    });
  }

  async finish(): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'closed') return;
    if (this.phase === 'starting' || this.phase === 'restarting') {
      await this.wait(this.o.finishWaitMs, (done) => void this.ready.then(done));
    }
    if (this.phase === 'open' && this.engine) {
      this.emit({ type: 'state', state: 'closing' });
      const drainedInTime = await this.wait(this.o.finishWaitMs, (done) => {
        const flushed = () => {
          this.drained = null;
          if (this.phase !== 'open' || !this.engine) return done();
          this.inflight.push({ flush: true, sessionEnd: this.processed, onAck: done });
          this.waitingSince = this.now();
          this.engine.flush();
        };
        if (this.inflight.length === 0 && this.queued === 0) flushed();
        else this.drained = flushed;
      });
      this.drained = null;
      if (!drainedInTime && this.phase === 'open') {
        // Stop does not wait for a slow engine: the rest is a gap for the final pass.
        const lostFrom = this.utteranceStart;
        this.retractInterim();
        if (this.received > lostFrom) {
          this.emit({
            type: 'gap',
            gap: { provider: LOCAL_PROVIDER, startMs: this.ms(lostFrom), endMs: this.ms(this.received), reason: 'engine-behind', detail: 'recording stopped before live recognition caught up' },
          });
        }
      }
    }
    if (this.phase === 'unavailable' && this.received > this.unavailableFrom) {
      this.emit({
        type: 'gap',
        gap: { provider: LOCAL_PROVIDER, startMs: this.ms(this.unavailableFrom), endMs: this.ms(this.received), reason: this.unavailableReason },
      });
    } else if ((this.phase === 'starting' || this.phase === 'restarting') && this.received > this.queueStart) {
      this.emit({
        type: 'gap',
        gap: { provider: LOCAL_PROVIDER, startMs: this.ms(this.queueStart), endMs: this.ms(this.received), reason: 'engine-failed', detail: 'engine was not ready when the recording stopped' },
      });
    }
    const wasUnavailable = this.phase === 'unavailable';
    this.close();
    if (!wasUnavailable) this.emit({ type: 'state', state: 'closed' });
  }

  abort(): void {
    if (this.phase === 'idle' || this.phase === 'closed') return;
    const wasUnavailable = this.phase === 'unavailable';
    this.close();
    if (!wasUnavailable) this.emit({ type: 'state', state: 'closed' });
  }

  private close(): void {
    this.generation += 1;
    this.phase = 'closed';
    try {
      this.engine?.close();
    } catch {
      // The engine is already gone.
    }
    this.engine = null;
    this.queue = [];
    this.queued = 0;
    this.inflight = [];
  }
}
