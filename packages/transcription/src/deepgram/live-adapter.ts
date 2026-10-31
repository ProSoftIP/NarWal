// One Deepgram live connection: socket, keepalive, clean finish. Runs in the
// offscreen document next to the microphone. It receives a credential from the
// service worker and never reads a stored key itself.

import type {
  AdapterEvent,
  AudioFormat,
  LiveCredential,
  LiveSessionOptions,
  LiveTranscriptionAdapter,
} from '../contract.ts';
import { ProviderErrorException, redactSecrets } from '../provider-error.ts';
import type { ProviderServiceRecord } from '../provider-identity.ts';
import type { Timers, WebSocketFactory, WebSocketLike } from '../socket.ts';
import { WS_OPEN, browserWebSocketFactory, realTimers } from '../socket.ts';
import {
  DEEPGRAM_DEFAULT_MODEL,
  DEEPGRAM_KEEPALIVE_MS,
  DEEPGRAM_LISTEN_URL,
  DeepgramControl,
  DeepgramNormalizer,
  buildDeepgramListenUrl,
  classifyDeepgramClose,
  deepgramSubprotocols,
} from './protocol.ts';

export interface DeepgramLiveAdapterOptions {
  createSocket?: WebSocketFactory;
  timers?: Timers;
  /** PCM s16le mono sample rate of the chunks passed to sendAudio. */
  sampleRate?: number;
  model?: string;
  keepAliveMs?: number;
  /** A socket that has not opened by then counts as a network failure. */
  connectTimeoutMs?: number;
  /** How long finish() waits for Deepgram to flush finals and close. */
  finishTimeoutMs?: number;
}

type AdapterState = 'new' | 'connecting' | 'open' | 'closing' | 'closed';

export class DeepgramLiveAdapter implements LiveTranscriptionAdapter {
  readonly provider = 'deepgram' as const;
  readonly audioFormat: AudioFormat;

  private readonly createSocket: WebSocketFactory;
  private readonly timers: Timers;
  private readonly model: string;
  private readonly keepAliveMs: number;
  private readonly connectTimeoutMs: number;
  private readonly finishTimeoutMs: number;

  private state: AdapterState = 'new';
  private socket: WebSocketLike | null = null;
  private normalizer: DeepgramNormalizer | null = null;
  private onEvent: (event: AdapterEvent) => void = () => {};
  private credential: LiveCredential | null = null;
  private queue: ArrayBuffer[] = [];
  private lastSentAt = 0;
  private keepAliveTimer: unknown = null;
  private closeWaiters: Array<() => void> = [];
  /** Rejects the pending start() promise; set only while connecting. */
  private rejectStart: ((reason: unknown) => void) | null = null;

  constructor(options: DeepgramLiveAdapterOptions = {}) {
    this.createSocket = options.createSocket ?? browserWebSocketFactory;
    this.timers = options.timers ?? realTimers;
    this.model = options.model ?? DEEPGRAM_DEFAULT_MODEL;
    this.keepAliveMs = options.keepAliveMs ?? DEEPGRAM_KEEPALIVE_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 10_000;
    this.audioFormat = { kind: 'pcm_s16le', sampleRate: options.sampleRate ?? 16_000, channels: 1 };
  }

  start(options: LiveSessionOptions, onEvent: (event: AdapterEvent) => void): Promise<void> {
    if (this.state !== 'new') throw new Error('A Deepgram adapter serves one connection; create a new one');
    this.onEvent = onEvent;
    this.credential = options.credential;
    this.normalizer = new DeepgramNormalizer(options.audioOriginMs, options.connectionId, this.model);
    this.setState('connecting');

    const url = buildDeepgramListenUrl({ model: this.model, pcmSampleRate: this.audioFormat.kind === 'pcm_s16le' ? this.audioFormat.sampleRate : undefined });
    const socket = this.createSocket(url, deepgramSubprotocols(options.credential));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      const connectTimer = this.timers.setTimeout(() => {
        if (this.state !== 'connecting') return;
        socket.onclose = null;
        socket.close(1000, 'connect timeout');
        this.markClosed();
        reject(new ProviderErrorException({ provider: 'deepgram', kind: 'network', retryable: true, code: 'connect-timeout', message: 'Deepgram did not accept the connection in time' }));
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (this.state !== 'connecting') return;
        this.timers.clearTimeout(connectTimer);
        this.rejectStart = null;
        this.setState('open');
        this.lastSentAt = this.timers.now();
        for (const chunk of this.queue) socket.send(chunk);
        this.queue = [];
        this.keepAliveTimer = this.timers.setInterval(() => this.keepAlive(), 1000);
        resolve();
      };

      socket.onmessage = (event) => {
        if (this.state === 'closed' || typeof event.data !== 'string' || !this.normalizer) return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message === null || typeof message !== 'object') return;
        for (const adapterEvent of this.normalizer.handle(message as Record<string, unknown>)) this.emit(adapterEvent);
      };

      socket.onerror = () => {
        // The browser follows every error with a close event; handled there.
      };

      socket.onclose = (event) => {
        const wasConnecting = this.state === 'connecting';
        const wasClosing = this.state === 'closing';
        if (this.state === 'closed') return;
        this.timers.clearTimeout(connectTimer);
        const error = classifyDeepgramClose(event.code, this.redact(event.reason));
        if (wasConnecting) {
          this.markClosed();
          // A refused handshake arrives as 1006 with no reason; the session
          // re-mints the credential to learn whether the key was the cause.
          reject(new ProviderErrorException(error));
          return;
        }
        if (!wasClosing) this.emit({ type: 'error', error });
        this.markClosed();
      };
    });
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.state === 'connecting') {
      this.queue.push(chunk);
    } else if (this.state === 'open' && this.socket?.readyState === WS_OPEN) {
      this.socket.send(chunk);
      this.lastSentAt = this.timers.now();
    }
    // After finish or abort, audio is ignored: the recorder keeps the local copy.
  }

  async finish(): Promise<void> {
    if (this.state === 'closed' || this.state === 'new') return;
    if (this.state === 'connecting') {
      this.abort();
      return;
    }
    if (this.state === 'open') {
      this.setState('closing');
      // CloseStream makes Deepgram flush every pending word as a final result,
      // send Metadata, then close the socket itself.
      this.socket?.send(DeepgramControl.closeStream);
    }
    await new Promise<void>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (this.state === 'closed') return;
        this.socket?.close(1000, 'finish timeout');
        this.markClosed();
      }, this.finishTimeoutMs);
      this.closeWaiters.push(() => {
        this.timers.clearTimeout(timer);
        resolve();
      });
    });
  }

  abort(): void {
    if (this.state === 'closed') return;
    const rejectStart = this.state === 'connecting' ? this.rejectStart : null;
    const socket = this.socket;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.close(1000, 'aborted');
    }
    this.markClosed();
    // Same contract as AssemblyAI: an abort before open settles start().
    rejectStart?.(new ProviderErrorException({ provider: 'deepgram', kind: 'network', retryable: false, code: 'aborted', message: 'Connection aborted' }));
  }

  /** What served this connection, as reported by Deepgram. Never holds the credential. */
  serviceRecord(): ProviderServiceRecord {
    const observed = this.normalizer?.observed ?? {};
    return {
      provider: 'deepgram',
      api: DEEPGRAM_LISTEN_URL,
      requestedModel: this.model,
      ...(observed.reportedModel ? { reportedModel: observed.reportedModel } : {}),
      ...(observed.modelVersion ? { modelVersion: observed.modelVersion } : {}),
      requestIds: observed.requestId ? [observed.requestId] : [],
      auth: this.credential?.kind ?? 'temporary-token',
    };
  }

  private keepAlive(): void {
    if (this.state !== 'open' || this.socket?.readyState !== WS_OPEN) return;
    if (this.timers.now() - this.lastSentAt < this.keepAliveMs) return;
    this.socket.send(DeepgramControl.keepAlive);
    this.lastSentAt = this.timers.now();
  }

  private markClosed(): void {
    this.rejectStart = null;
    if (this.keepAliveTimer !== null) this.timers.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.queue = [];
    this.setState('closed');
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private setState(state: AdapterState): void {
    this.state = state;
    if (state !== 'new') this.onEvent({ type: 'state', state });
  }

  private emit(event: AdapterEvent): void {
    if (event.type === 'error') {
      event = { type: 'error', error: { ...event.error, message: this.redact(event.error.message) } };
    }
    this.onEvent(event);
  }

  private redact(text: string): string {
    const credential = this.credential;
    if (!credential) return text;
    return redactSecrets(text, [credential.kind === 'api-key' ? credential.key : credential.token]);
  }
}
