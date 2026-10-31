// AssemblyAI live adapter for one provider connection (board #16546).
// Runs in the offscreen document next to the microphone. It receives a
// temporary token, never the user's key; the service worker mints the token
// with mintAssemblyAiToken() and the live session asks for a new one per connection.
//
// What this adapter owns:
// - framing PCM into the 50..1000 ms binary messages AssemblyAI requires;
// - pacing, because AssemblyAI closes a session (3007) that receives audio
//   faster than real time, which a reconnect replay would otherwise do;
// - finish(): send the tail, ForceEndpoint and Terminate, then promote any
//   end-of-turn still waiting for its formatted copy so no words are lost;
// - classifying closes into contract errors.
// Reconnect, replay, gaps and keepalive policy belong to the live session.

import type {
  AdapterEvent,
  AudioFormat,
  LiveSessionOptions,
  LiveTranscriptionAdapter,
  ProviderError,
  ProviderId,
} from '../contract.ts';
import { AssemblyAiNormalizer } from './normalizer.ts';
import {
  ASSEMBLYAI_DEFAULT_MODEL,
  ASSEMBLYAI_MIN_CHUNK_MS,
  ASSEMBLYAI_SAMPLE_RATE,
  type AssemblyAiEnglishModel,
  assemblyAiChunkBytes,
  buildAssemblyAiStreamUrl,
  classifyAssemblyAiError,
  resolveFormatTurns,
} from './stream.ts';
import { ASSEMBLYAI_TOKEN_EXPIRY_MARGIN_MS, isAssemblyAiTokenUsable } from './token.ts';

/** The subset of the browser WebSocket this adapter uses; tests pass a fake. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

const OPEN = 1;

type TimerHandle = unknown;

export interface AssemblyAiAdapterOptions {
  speechModel?: AssemblyAiEnglishModel;
  /** Defaults to true where the model supports it (Universal Streaming). */
  formatTurns?: boolean;
  inactivityTimeoutSeconds?: number;
  /** Binary message length, 50..1000 ms. Default 100 ms. */
  chunkMs?: number;
  /**
   * Ceiling on audio sent per wall-clock second. AssemblyAI tolerates about
   * 1.25x before closing with 3007, so replayed backlog drains at 1.2x.
   */
  maxRealtimeFactor?: number;
  /** Give up waiting for Begin after this long. */
  connectTimeoutMs?: number;
  /** Give up waiting for Termination after Terminate. */
  finishTimeoutMs?: number;
  createSocket?: (url: string) => WebSocketLike;
  /**
   * Clock for tests. When set, it drives both the token-expiry check and pacing.
   * Default: Date.now for token expiry (tokens carry wall-clock deadlines) and
   * performance.now for pacing, so a system clock jump cannot burst or stall audio.
   */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** start() rejects with this; `error` is the classified reason (the live session reads `.error`). */
export class AssemblyAiConnectError extends Error {
  readonly error: ProviderError;
  constructor(error: ProviderError) {
    super(error.message || `AssemblyAI connection failed (${error.code})`);
    this.name = 'AssemblyAiConnectError';
    this.error = error;
  }
}

type Phase = 'idle' | 'connecting' | 'open' | 'finishing' | 'closed';

export class AssemblyAiLiveAdapter implements LiveTranscriptionAdapter {
  readonly provider: ProviderId = 'assemblyai';
  readonly audioFormat: AudioFormat = { kind: 'pcm_s16le', sampleRate: ASSEMBLYAI_SAMPLE_RATE, channels: 1 };

  private readonly speechModel: AssemblyAiEnglishModel;
  private readonly formatTurns: boolean;
  private readonly inactivityTimeoutSeconds: number | undefined;
  private readonly chunkMs: number;
  private readonly frameBytes: number;
  private readonly minFrameBytes: number;
  private readonly maxRealtimeFactor: number;
  private readonly connectTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  private phase: Phase = 'idle';
  private socket: WebSocketLike | null = null;
  private normalizer: AssemblyAiNormalizer | null = null;
  private emit: (event: AdapterEvent) => void = () => {};
  /** Bytes not yet a whole frame. */
  private partial = new Uint8Array(0);
  /** Whole frames waiting for the pacer. */
  private readonly frames: ArrayBuffer[] = [];
  private sentAudioMs = 0;
  private pacingStartMs = 0;
  private pacerTimer: TimerHandle | null = null;
  private connectTimer: TimerHandle | null = null;
  private finishTimer: TimerHandle | null = null;
  private terminateSent = false;
  private terminationReceived = false;
  /** Last Error frame; the close that follows carries the same code with a truncated reason. */
  private lastErrorFrame: ProviderError | null = null;
  private errorEmitted = false;
  private startSettle: { resolve: () => void; reject: (error: AssemblyAiConnectError) => void } | null = null;
  private finishResolve: (() => void) | null = null;
  private finishPromise: Promise<void> | null = null;

  constructor(options: AssemblyAiAdapterOptions = {}) {
    this.speechModel = options.speechModel ?? ASSEMBLYAI_DEFAULT_MODEL;
    this.formatTurns = resolveFormatTurns({ speechModel: this.speechModel, formatTurns: options.formatTurns });
    this.inactivityTimeoutSeconds = options.inactivityTimeoutSeconds;
    this.chunkMs = options.chunkMs ?? 100;
    this.frameBytes = assemblyAiChunkBytes(this.chunkMs);
    this.minFrameBytes = assemblyAiChunkBytes(ASSEMBLYAI_MIN_CHUNK_MS);
    this.maxRealtimeFactor = options.maxRealtimeFactor ?? 1.2;
    if (!(this.maxRealtimeFactor >= 1 && this.maxRealtimeFactor <= 1.25)) {
      throw new RangeError('maxRealtimeFactor must be from 1 to 1.25');
    }
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 10000;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Model AssemblyAI applied, from Begin; the requested one before that. */
  get reportedModel(): string {
    return this.normalizer?.reportedModel ?? this.speechModel;
  }

  /** Session-clock end of the last final segment on this connection. */
  get lastFinalEndMs(): number | undefined {
    return this.normalizer?.lastFinalEndMs;
  }

  start(options: LiveSessionOptions, onEvent: (event: AdapterEvent) => void): Promise<void> {
    if (this.phase !== 'idle') return Promise.reject(new Error('AssemblyAiLiveAdapter.start() runs once per connection'));
    // A listener that throws must not strand start() or finish(): settling and
    // timers run after emits, so a fault here would leave them pending forever.
    this.emit = (event) => {
      try {
        onEvent(event);
      } catch {
        // The listener's fault is its own; the connection carries on.
      }
    };
    this.normalizer = new AssemblyAiNormalizer(options.audioOriginMs, options.connectionId, {
      formatTurns: this.formatTurns,
      requestedModel: this.speechModel,
    });
    this.phase = 'connecting';
    this.emit({ type: 'state', state: 'connecting' });

    const credential = options.credential;
    if (credential.kind !== 'temporary-token') {
      return this.failBeforeOpen({
        provider: 'assemblyai',
        kind: 'auth',
        retryable: false,
        code: 'api-key-refused',
        message: 'AssemblyAI browser sockets need a temporary token; the API key stays in the service worker',
      });
    }
    if (!isAssemblyAiTokenUsable(credential, this.now(), ASSEMBLYAI_TOKEN_EXPIRY_MARGIN_MS)) {
      // Expiry is fixed by minting again, so the session may retry.
      return this.failBeforeOpen({
        provider: 'assemblyai',
        kind: 'auth',
        retryable: true,
        code: 'token-expired',
        message: 'AssemblyAI temporary token expired before the socket opened',
      });
    }

    const url = buildAssemblyAiStreamUrl(credential, {
      speechModel: this.speechModel,
      formatTurns: this.formatTurns,
      ...(this.inactivityTimeoutSeconds === undefined ? {} : { inactivityTimeoutSeconds: this.inactivityTimeoutSeconds }),
    });

    return new Promise<void>((resolve, reject) => {
      this.startSettle = { resolve, reject };
      let socket: WebSocketLike;
      try {
        socket = this.createSocket(url);
      } catch (cause) {
        // Never echo the URL: it carries the token.
        this.settleStartFailure({
          provider: 'assemblyai',
          kind: 'network',
          retryable: true,
          code: 'socket-create-failed',
          message: `Could not open the AssemblyAI socket: ${(cause as Error)?.name ?? 'Error'}`,
        });
        return;
      }
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (event) => this.onMessage(event.data);
      socket.onclose = (event) => this.onClose(event.code, event.reason ?? '');
      socket.onerror = () => {
        // Browsers give no detail here; the close event that follows carries the code.
      };
      this.connectTimer = this.setTimer(() => {
        this.connectTimer = null;
        if (this.phase !== 'connecting') return;
        this.closeSocket(1000, 'connect timeout');
        this.settleStartFailure({
          provider: 'assemblyai',
          kind: 'network',
          retryable: true,
          code: 'connect-timeout',
          message: `AssemblyAI did not start a session within ${this.connectTimeoutMs} ms`,
        });
      }, this.connectTimeoutMs);
    });
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.phase !== 'connecting' && this.phase !== 'open') return;
    const bytes = new Uint8Array(chunk);
    if (bytes.byteLength === 0) return;
    const joined = new Uint8Array(this.partial.byteLength + bytes.byteLength);
    joined.set(this.partial, 0);
    joined.set(bytes, this.partial.byteLength);
    let offset = 0;
    while (joined.byteLength - offset >= this.frameBytes) {
      this.frames.push(joined.slice(offset, offset + this.frameBytes).buffer);
      offset += this.frameBytes;
    }
    this.partial = joined.slice(offset);
    this.pump();
  }

  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.phase === 'connecting') {
      this.abort();
      return Promise.resolve();
    }
    if (this.phase !== 'open') return Promise.resolve();
    this.phase = 'finishing';
    this.emit({ type: 'state', state: 'closing' });
    if (this.partial.byteLength > 0) {
      // The tail is shorter than a frame. AssemblyAI refuses messages under
      // 50 ms, so pad with silence; words before it keep their timing.
      const size = Math.max(this.partial.byteLength + (this.partial.byteLength % 2), this.minFrameBytes);
      const tail = new Uint8Array(size);
      tail.set(this.partial, 0);
      this.frames.push(tail.buffer);
      this.partial = new Uint8Array(0);
    }
    this.finishPromise = new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });
    this.finishTimer = this.setTimer(() => {
      this.finishTimer = null;
      if (this.phase === 'closed') return;
      this.closeSocket(1000, 'finish timeout');
      this.completeClose();
    }, this.finishTimeoutMs + this.pendingAudioMs() / this.maxRealtimeFactor);
    this.pump();
    return this.finishPromise;
  }

  abort(): void {
    if (this.phase === 'idle' || this.phase === 'closed') {
      this.phase = 'closed';
      return;
    }
    const wasConnecting = this.phase === 'connecting';
    this.frames.length = 0;
    this.partial = new Uint8Array(0);
    if (this.socket?.readyState === OPEN && !this.terminateSent) {
      // Close the provider session at once: AssemblyAI bills open time.
      this.trySend(JSON.stringify({ type: 'Terminate' }));
      this.terminateSent = true;
    }
    this.closeSocket(1000, 'aborted');
    if (wasConnecting) {
      this.settleStartFailure({ provider: 'assemblyai', kind: 'network', retryable: false, code: 'aborted', message: 'Connection aborted' });
      return;
    }
    // Pending interim segments are dropped, not promoted.
    this.phase = 'closed';
    this.clearTimers();
    this.emit({ type: 'state', state: 'closed' });
    this.finishResolve?.();
  }

  private pendingAudioMs(): number {
    return (this.frames.reduce((total, frame) => total + frame.byteLength, 0) / 2 / ASSEMBLYAI_SAMPLE_RATE) * 1000;
  }

  /** Sends whole frames no faster than maxRealtimeFactor; schedules itself for the rest. */
  private pump(): void {
    if (this.phase !== 'open' && this.phase !== 'finishing') return;
    if (this.pacerTimer !== null) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const elapsed = this.monotonicNow() - this.pacingStartMs;
    // One frame of headroom so steady real-time audio is never delayed.
    const allowedMs = elapsed * this.maxRealtimeFactor + this.chunkMs;
    while (this.frames.length > 0) {
      const frame = this.frames[0];
      const frameMs = (frame.byteLength / 2 / ASSEMBLYAI_SAMPLE_RATE) * 1000;
      if (this.sentAudioMs + frameMs > allowedMs) {
        const waitMs = Math.max(1, Math.ceil((this.sentAudioMs + frameMs - this.chunkMs) / this.maxRealtimeFactor - elapsed));
        this.pacerTimer = this.setTimer(() => {
          this.pacerTimer = null;
          this.pump();
        }, waitMs);
        return;
      }
      this.frames.shift();
      if (!this.trySend(frame)) return;
      this.sentAudioMs += frameMs;
    }
    if (this.phase === 'finishing' && !this.terminateSent) {
      // ForceEndpoint ends the current turn so its words come back final;
      // Terminate then flushes and returns Termination before the close.
      this.trySend(JSON.stringify({ type: 'ForceEndpoint' }));
      this.trySend(JSON.stringify({ type: 'Terminate' }));
      this.terminateSent = true;
    }
  }

  private trySend(data: ArrayBuffer | string): boolean {
    try {
      this.socket?.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(data: unknown): void {
    if (this.phase === 'closed' || typeof data !== 'string' || !this.normalizer) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'Termination') this.terminationReceived = true;
    const events = this.normalizer.handle(message);
    for (const event of events) {
      if (event.type === 'error') {
        this.lastErrorFrame = event.error;
        // While start() is pending, failures surface only as its rejection.
        if (this.phase === 'connecting') continue;
        this.errorEmitted = true;
      }
      if (event.type === 'state' && event.state === 'open') {
        if (this.phase !== 'connecting') continue;
        this.phase = 'open';
        this.pacingStartMs = this.monotonicNow();
        if (this.connectTimer !== null) {
          this.clearTimer(this.connectTimer);
          this.connectTimer = null;
        }
        this.emit(event);
        const settle = this.startSettle;
        this.startSettle = null;
        settle?.resolve();
        this.pump();
        continue;
      }
      this.emit(event);
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'connecting') {
      this.settleStartFailure(this.lastErrorFrame ?? classifyAssemblyAiError(code, reason));
      return;
    }
    const clean = this.terminateSent && (this.terminationReceived || code === 1000);
    if (!clean && !this.errorEmitted) {
      this.emit({ type: 'error', error: this.lastErrorFrame ?? classifyAssemblyAiError(code, reason) });
    }
    this.completeClose();
  }

  private completeClose(): void {
    if (this.phase === 'closed') return;
    const finishing = this.phase === 'finishing';
    this.phase = 'closed';
    this.clearTimers();
    this.frames.length = 0;
    // finish() promised finals: promote turns still waiting for their formatted copy.
    if (finishing && this.normalizer) {
      for (const event of this.normalizer.flushPendingTurns()) this.emit(event);
    }
    this.emit({ type: 'state', state: 'closed' });
    this.finishResolve?.();
  }

  private failBeforeOpen(error: ProviderError): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.startSettle = { resolve, reject };
      this.settleStartFailure(error);
    });
  }

  private settleStartFailure(error: ProviderError): void {
    this.phase = 'closed';
    this.clearTimers();
    this.emit({ type: 'state', state: 'closed' });
    const settle = this.startSettle;
    this.startSettle = null;
    settle?.reject(new AssemblyAiConnectError(error));
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private clearTimers(): void {
    for (const handle of [this.pacerTimer, this.connectTimer, this.finishTimer]) {
      if (handle !== null) this.clearTimer(handle);
    }
    this.pacerTimer = null;
    this.connectTimer = null;
    this.finishTimer = null;
  }
}
