// Provider-neutral driver for one recording's live transcription. It owns the
// provider connections, reconnects, keeps a bounded PCM ring buffer for replay,
// reconciles interim and final segments, records gaps, and builds the final
// TranscriptRevision.
//
// Rules from research/cloud-transcription (board #16540):
// - Never switch provider on failure. A failed provider produces a gap; capture
//   continues; the user can retry the same provider explicitly.
// - Mint a credential before every connection: a refused WebSocket handshake
//   hides its HTTP status, the credential call does not.
// - Every connection restarts the provider clock at 0, so each connection gets
//   the session time of its first sample (audioOriginMs).

import type {
  AdapterEvent,
  GapReason,
  LiveCredential,
  LiveTranscriptionAdapter,
  ProviderError,
  ProviderId,
  SessionMs,
  TranscriptGap,
  TranscriptRevision,
  TranscriptSegment,
} from './contract.ts';
import { dropReplayedWords } from './contract.ts';
import { ProviderErrorException, needsUserAction } from './provider-error.ts';
import type { ProviderServiceRecord } from './provider-identity.ts';
import type { Timers } from './socket.ts';
import { realTimers } from './socket.ts';

export { ProviderErrorException } from './provider-error.ts';

/** PCM s16le mono audio starting at `startMs` on the session clock. */
export interface PcmChunk {
  data: ArrayBuffer;
  startMs: SessionMs;
}

export type ServiceReportingAdapter = LiveTranscriptionAdapter & { serviceRecord?(): ProviderServiceRecord };

export interface ReconnectPolicy {
  /** Consecutive failed attempts before the session stops and asks the user. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Longest backlog replayed on reconnect. Providers process at most about
   * 1.25x real time, so a long replay lags far behind; past this the session
   * resumes at live audio and records the gap instead.
   */
  maxReplayMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
  maxReplayMs: 15_000,
};

export type LiveSessionPhase =
  | 'idle' // no audio yet
  | 'connecting' // first connection opening
  | 'live'
  | 'reconnecting'
  | 'stopped' // provider stopped: user action needed or user stopped it; capture continues
  | 'finishing'
  | 'finished';

export interface LiveSessionStatus {
  phase: LiveSessionPhase;
  provider: ProviderId;
  /** Failed attempts since the last successful open. */
  attempt: number;
  /** The error that caused the current reconnect or stop. */
  error?: ProviderError;
  /** Session-independent wall time of the next reconnect attempt. */
  retryAtMs?: number;
}

export interface LiveSessionSnapshot {
  status: LiveSessionStatus;
  finals: TranscriptSegment[];
  /** Latest interim per audio window; replaced by its final. */
  interim: TranscriptSegment[];
  gaps: TranscriptGap[];
}

export interface LiveTranscriptResult {
  revision: TranscriptRevision;
  service: ProviderServiceRecord | null;
  /** Provider-reported usage, summed over connections. */
  usage: { audioSeconds: number; basis: string } | null;
}

export interface LiveTranscriptionSessionOptions {
  provider: ProviderId;
  createAdapter(connectionId: string): ServiceReportingAdapter;
  /** Mints the credential for one connection; throws ProviderErrorException. */
  getCredential(): Promise<LiveCredential>;
  sampleRate?: number;
  reconnect?: Partial<ReconnectPolicy>;
  timers?: Timers;
  onUpdate?(snapshot: LiveSessionSnapshot): void;
  createId?(): string;
  /** Untranscribed audio shorter than this at the end of a recording is not a gap. */
  finishToleranceMs?: number;
  /** Larger jumps between consecutive chunks start a new connection (pause/resume). */
  discontinuityToleranceMs?: number;
}

interface Connection {
  id: string;
  adapter: ServiceReportingAdapter;
  originMs: SessionMs;
  /** Words ending at or before this were finalized by an earlier connection. */
  replayFloorMs: SessionMs | null;
  opened: boolean;
  retired: boolean;
  lastError: ProviderError | null;
  /** End of the last final segment this connection produced. */
  finalEndMs: SessionMs;
  usage: { audioSeconds: number; basis: string } | null;
  closing: Promise<void> | null;
  /** Session clock when the socket opened; null until then. */
  openedAtMs: number | null;
  /** Delivered a result, so the provider accepted it; resets the attempt count. */
  healthy: boolean;
}

/** A connection open this long counts as healthy even with no speech. */
const HEALTHY_OPEN_MS = 10_000;

export class LiveTranscriptionSession {
  private readonly options: LiveTranscriptionSessionOptions;
  private readonly policy: ReconnectPolicy;
  private readonly timers: Timers;
  private readonly bytesPerMs: number;
  private readonly createId: () => string;

  private status: LiveSessionStatus;
  private ring: PcmChunk[] = [];
  private audioEndMs: SessionMs | null = null;
  private lastFinalEndMs: SessionMs = 0;
  private finals: TranscriptSegment[] = [];
  private interims = new Map<string, TranscriptSegment>();
  private gaps: TranscriptGap[] = [];
  private connections: Connection[] = [];
  private current: Connection | null = null;
  private retryTimer: unknown = null;
  /** Set while the provider is stopped; closes into a gap when it restarts or the recording ends. */
  private stoppedReason: GapReason | null = null;
  private connectSeq = 0;

  constructor(options: LiveTranscriptionSessionOptions) {
    this.options = options;
    this.policy = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnect };
    this.timers = options.timers ?? realTimers;
    this.bytesPerMs = ((options.sampleRate ?? 16_000) * 2) / 1000;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.status = { phase: 'idle', provider: options.provider, attempt: 0 };
  }

  snapshot(): LiveSessionSnapshot {
    return {
      status: { ...this.status },
      finals: [...this.finals],
      interim: [...this.interims.values()].sort((a, b) => a.startMs - b.startMs),
      gaps: [...this.gaps],
    };
  }

  /** Feed narration PCM in order. Never throws: capture must not stop for transcription. */
  pushAudio(chunk: PcmChunk): void {
    const phase = this.status.phase;
    if (phase === 'finishing' || phase === 'finished') return;
    const expected = this.audioEndMs;
    if (expected === null) this.lastFinalEndMs = chunk.startMs;
    this.ring.push(chunk);
    this.audioEndMs = chunk.startMs + chunk.data.byteLength / this.bytesPerMs;
    this.trimRing();

    if (phase === 'idle') {
      void this.connect('connecting');
      return;
    }
    const tolerance = this.options.discontinuityToleranceMs ?? 20;
    if (expected !== null && Math.abs(chunk.startMs - expected) > tolerance) {
      this.onDiscontinuity(expected, chunk);
      return;
    }
    if (this.current && !this.current.retired) this.current.adapter.sendAudio(chunk.data);
  }

  /**
   * The recorder paused and resumed. Provider time counts audio, not wall time,
   * so a connection cannot place words after the jump: flush it and start a new
   * one whose origin is the resumed chunk. The pause itself had no audio and is
   * not a gap; audio before it that never became final is.
   */
  private onDiscontinuity(pauseStartMs: SessionMs, chunk: PcmChunk): void {
    const floorBefore = this.lastFinalEndMs;
    this.lastFinalEndMs = chunk.startMs;
    this.ring = [chunk];
    const old = this.current;
    if (!old) {
      // Reconnecting or stopped: the pending attempt plans from the new ring.
      if (pauseStartMs > floorBefore) {
        this.addGap(floorBefore, pauseStartMs, this.stoppedReason ?? this.reasonFor(this.status.error));
      }
      return;
    }
    this.current = null;
    const tolerance = this.options.finishToleranceMs ?? 500;
    old.closing = this.retire(old, old.opened ? 'finish' : 'abort').then(() => {
      const covered = Math.max(floorBefore, old.finalEndMs);
      if (pauseStartMs - covered > tolerance) {
        this.addGap(covered, pauseStartMs, this.reasonFor(old.lastError ?? undefined), 'not finalized before the pause');
      }
    });
    void this.connect(this.everOpened() ? 'reconnecting' : 'connecting');
  }

  /** The user stops transcription mid-recording; capture continues. */
  async stopTranscribing(): Promise<void> {
    if (this.status.phase === 'finishing' || this.status.phase === 'finished' || this.status.phase === 'stopped') return;
    this.cancelRetry();
    const connection = this.current;
    this.current = null;
    if (connection) await this.retire(connection, 'finish');
    this.stop('user-stopped-provider');
  }

  /** Explicit retry with the same provider after a stop. Never another provider. */
  retry(): void {
    if (this.status.phase !== 'stopped') return;
    this.status = { phase: 'reconnecting', provider: this.options.provider, attempt: 0 };
    void this.connect('reconnecting');
  }

  /** Flushes the provider, closes every connection and returns the transcript. */
  async finish(): Promise<LiveTranscriptResult> {
    if (this.status.phase !== 'finishing' && this.status.phase !== 'finished') {
      const reasonIfShort = this.stoppedReason ?? this.reasonFor(this.status.error);
      this.status = { ...this.status, phase: 'finishing', retryAtMs: undefined };
      this.cancelRetry();
      const connection = this.current;
      this.current = null;
      if (connection) this.retire(connection, connection.opened ? 'finish' : 'abort');
      await Promise.all(this.connections.map((c) => c.closing));
      this.closeTrailingGap(reasonIfShort);
      this.interims.clear();
      this.status = { phase: 'finished', provider: this.options.provider, attempt: 0 };
      this.notify();
    }
    return this.result();
  }

  /** Discards the session: connections close, nothing is flushed. */
  abort(): void {
    this.cancelRetry();
    for (const connection of this.connections) this.retire(connection, 'abort');
    this.current = null;
    this.interims.clear();
    this.status = { phase: 'finished', provider: this.options.provider, attempt: 0 };
    this.notify();
  }

  private async connect(phase: 'connecting' | 'reconnecting'): Promise<void> {
    const seq = ++this.connectSeq;
    this.status = { ...this.status, phase, retryAtMs: undefined };
    this.notify();
    let credential: LiveCredential;
    try {
      credential = await this.options.getCredential();
    } catch (thrown) {
      if (seq !== this.connectSeq || !this.isConnectingPhase()) return;
      this.onConnectFailure(toProviderError(thrown, this.options.provider));
      return;
    }
    if (seq !== this.connectSeq || !this.isConnectingPhase()) return;

    const { origin, sendFrom, replayFloorMs } = this.planConnection();
    const id = this.createId();
    let connection: Connection | null = null;
    try {
      const adapter = this.options.createAdapter(id);
      connection = {
        id,
        adapter,
        originMs: origin,
        replayFloorMs,
        opened: false,
        retired: false,
        lastError: null,
        finalEndMs: origin,
        usage: null,
        closing: null,
        openedAtMs: null,
        healthy: false,
      };
      this.connections.push(connection);
      this.current = connection;
      const opening = connection;
      // A synchronous throw here (e.g. the socket constructor) is a failed
      // connect like any other, never an unhandled rejection.
      const started = adapter.start(
        { credential, language: 'en', audioOriginMs: origin, connectionId: id },
        (event) => this.onAdapterEvent(opening, event),
      );
      // The adapter queues audio until its socket opens.
      for (let index = sendFrom; index < this.ring.length; index += 1) adapter.sendAudio(this.ring[index].data);
      await started;
    } catch (thrown) {
      if (connection) {
        if (connection.retired) return;
        if (this.current === connection) this.current = null;
        this.retire(connection, 'abort');
      }
      this.onConnectFailure(toProviderError(thrown, this.options.provider));
      return;
    }
    if (connection.retired) return;
    connection.opened = true;
    connection.openedAtMs = this.timers.now();
    // The attempt count survives the open: a provider that accepts the socket
    // and then refuses the token must still run out of attempts.
    this.status = { phase: 'live', provider: this.options.provider, attempt: this.status.attempt };
    this.notify();
  }

  /**
   * Chooses where a new connection starts. Replay from the end of the last
   * final segment when the ring buffer still holds it and the backlog is short;
   * otherwise resume at the oldest buffered audio and record what was lost.
   */
  private planConnection(): { origin: SessionMs; sendFrom: number; replayFloorMs: SessionMs | null } {
    const floor = this.lastFinalEndMs;
    const containing = this.ring.findIndex((chunk) => this.chunkEndMs(chunk) > floor);
    const backlogMs = (this.audioEndMs ?? floor) - floor;
    if (containing !== -1 && this.ring[containing].startMs <= floor && backlogMs <= this.policy.maxReplayMs) {
      const origin = this.ring[containing].startMs;
      this.closeStoppedGap(floor);
      // Words the earlier connection finalized come back on replay; drop them.
      return { origin, sendFrom: containing, replayFloorMs: origin < floor ? floor : null };
    }
    // Resume at live audio: the next pushed chunk starts the connection.
    const origin = this.audioEndMs ?? floor;
    this.closeStoppedGap(origin);
    if (origin > this.lastFinalEndMs) {
      this.addGap(this.lastFinalEndMs, origin, this.reasonFor(this.status.error));
      this.lastFinalEndMs = origin;
    }
    this.ring = [];
    return { origin, sendFrom: 0, replayFloorMs: null };
  }

  private onConnectFailure(error: ProviderError): void {
    this.status = { ...this.status, error };
    if (needsUserAction(error)) this.stop(this.reasonFor(error));
    else this.scheduleReconnect(error);
  }

  private onAdapterEvent(connection: Connection, event: AdapterEvent): void {
    if (this.status.phase === 'finished') return;
    switch (event.type) {
      case 'segment':
        this.onSegment(connection, event.segment);
        break;
      case 'usage':
        connection.usage = { audioSeconds: event.audioSeconds, basis: event.basis };
        break;
      case 'error':
        connection.lastError = event.error;
        break;
      case 'state':
        if (event.state === 'closed' && connection.opened && !connection.retired && this.current === connection) {
          connection.retired = true;
          this.current = null;
          this.dropInterims(connection.id);
          const error = connection.lastError ?? {
            provider: this.options.provider,
            kind: 'network' as const,
            retryable: true,
            code: 'closed',
            message: 'Connection closed',
          };
          const healthy =
            connection.healthy ||
            (connection.openedAtMs !== null && this.timers.now() - connection.openedAtMs >= HEALTHY_OPEN_MS);
          this.status = { ...this.status, error, attempt: healthy ? 0 : this.status.attempt };
          if (needsUserAction(error) || !error.retryable) this.stop(this.reasonFor(error));
          else this.scheduleReconnect(error);
        }
        return;
    }
    this.notify();
  }

  private onSegment(connection: Connection, incoming: TranscriptSegment): void {
    connection.healthy = true;
    let segment = incoming;
    if (connection.replayFloorMs !== null) {
      const words = dropReplayedWords(segment.words, connection.replayFloorMs);
      if (words.length !== segment.words.length) {
        segment = { ...segment, words, text: words.map((word) => word.text).join(' ') };
      }
      if (segment.endMs <= connection.replayFloorMs) {
        this.interims.delete(segment.segmentKey);
        return;
      }
    }
    if (segment.kind === 'interim') {
      this.interims.set(segment.segmentKey, segment);
      return;
    }
    this.interims.delete(segment.segmentKey);
    if (segment.text.trim().length > 0) this.finals.push(segment);
    this.finals.sort((a, b) => a.startMs - b.startMs);
    if (segment.endMs > connection.finalEndMs) connection.finalEndMs = segment.endMs;
    if (segment.endMs > this.lastFinalEndMs) this.lastFinalEndMs = segment.endMs;
    this.trimRing();
  }

  private scheduleReconnect(error: ProviderError): void {
    const attempt = this.status.attempt + 1;
    if (attempt > this.policy.maxAttempts) {
      this.stop(this.reasonFor(error));
      return;
    }
    const backoff = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    const delay = error.retryAfterMs ?? backoff;
    this.status = {
      phase: 'reconnecting',
      provider: this.options.provider,
      attempt,
      error,
      retryAtMs: this.timers.now() + delay,
    };
    this.notify();
    this.cancelRetry();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.status.phase === 'reconnecting') void this.connect('reconnecting');
    }, delay);
  }

  private stop(reason: GapReason): void {
    this.cancelRetry();
    this.connectSeq += 1;
    this.stoppedReason = reason;
    this.status = { ...this.status, phase: 'stopped', retryAtMs: undefined };
    this.notify();
  }

  private retire(connection: Connection, how: 'finish' | 'abort'): Promise<void> {
    if (connection.closing) return connection.closing;
    connection.retired = true;
    if (how === 'abort') {
      connection.adapter.abort();
      this.dropInterims(connection.id);
      connection.closing = Promise.resolve();
    } else {
      connection.closing = connection.adapter.finish().catch(() => {}).then(() => this.dropInterims(connection.id));
    }
    return connection.closing;
  }

  /** A stop that ends because the provider restarts becomes a gap up to `endMs`. */
  private closeStoppedGap(endMs: SessionMs): void {
    if (this.stoppedReason === null) return;
    if (endMs > this.lastFinalEndMs) {
      this.addGap(this.lastFinalEndMs, endMs, this.stoppedReason);
      this.lastFinalEndMs = endMs;
    }
    this.stoppedReason = null;
  }

  private closeTrailingGap(reason: GapReason): void {
    const end = this.audioEndMs;
    if (end === null) return;
    const tolerance = this.stoppedReason === null ? (this.options.finishToleranceMs ?? 500) : 0;
    if (end - this.lastFinalEndMs > tolerance) {
      this.addGap(this.lastFinalEndMs, end, reason, this.stoppedReason === null ? 'not finalized before the connection closed' : undefined);
      this.lastFinalEndMs = end;
    }
    this.stoppedReason = null;
  }

  private addGap(startMs: SessionMs, endMs: SessionMs, reason: GapReason, detail?: string): void {
    const previous = this.gaps.at(-1);
    if (previous && previous.reason === reason && previous.endMs >= startMs) {
      previous.endMs = Math.max(previous.endMs, endMs);
      return;
    }
    this.gaps.push({ provider: this.options.provider, startMs, endMs, reason, ...(detail ? { detail } : {}) });
  }

  private reasonFor(error: ProviderError | undefined): GapReason {
    if (!error) return 'disconnected';
    if (error.kind === 'auth') return 'auth-failed';
    if (error.kind === 'rate-limit') return 'rate-limited';
    if (error.kind === 'network' || error.kind === 'timeout') return this.everOpened() ? 'disconnected' : 'connect-failed';
    return 'provider-error';
  }

  private everOpened(): boolean {
    return this.connections.some((connection) => connection.opened);
  }

  private isConnectingPhase(): boolean {
    return this.status.phase === 'connecting' || this.status.phase === 'reconnecting';
  }

  private dropInterims(connectionId: string): void {
    for (const [key, segment] of this.interims) if (segment.connectionId === connectionId) this.interims.delete(key);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private chunkEndMs(chunk: PcmChunk): SessionMs {
    return chunk.startMs + chunk.data.byteLength / this.bytesPerMs;
  }

  /** Keeps audio not yet finalized, bounded to the replay window. */
  private trimRing(): void {
    const end = this.audioEndMs ?? 0;
    const keepFrom = Math.max(this.lastFinalEndMs, end - this.policy.maxReplayMs);
    let drop = 0;
    while (drop < this.ring.length - 1 && this.chunkEndMs(this.ring[drop]) <= keepFrom) drop += 1;
    if (drop > 0) this.ring.splice(0, drop);
  }

  private notify(): void {
    this.options.onUpdate?.(this.snapshot());
  }

  private result(): LiveTranscriptResult {
    const records = this.connections
      .map((connection) => connection.adapter.serviceRecord?.())
      .filter((record): record is ProviderServiceRecord => record !== undefined);
    const service: ProviderServiceRecord | null = records.length
      ? records.slice(1).reduce<ProviderServiceRecord>(
          (merged, record) => ({
            ...merged,
            reportedModel: record.reportedModel ?? merged.reportedModel,
            modelVersion: record.modelVersion ?? merged.modelVersion,
            requestIds: [...merged.requestIds, ...record.requestIds],
            auth: record.auth,
          }),
          { ...records[0], requestIds: [...records[0].requestIds] },
        )
      : null;
    const usages = this.connections.map((connection) => connection.usage).filter((usage) => usage !== null);
    const usage = usages.length
      ? { audioSeconds: usages.reduce((sum, item) => sum + item.audioSeconds, 0), basis: usages[0].basis }
      : null;
    return {
      revision: {
        revisionId: this.createId(),
        provider: this.options.provider,
        model: service?.reportedModel ?? service?.requestedModel ?? 'unknown',
        createdAtMs: this.timers.now(),
        source: 'live',
        segments: [...this.finals],
        gaps: [...this.gaps].sort((a, b) => a.startMs - b.startMs),
      },
      service,
      usage,
    };
  }
}

/** Reads ProviderErrorException, or any thrown object carrying a ProviderError as `error` or `providerError`. */
function toProviderError(thrown: unknown, provider: ProviderId): ProviderError {
  if (thrown instanceof ProviderErrorException) return thrown.error;
  const carried = (thrown as { error?: unknown; providerError?: unknown } | null) ?? {};
  for (const candidate of [carried.error, carried.providerError]) {
    const error = candidate as Partial<ProviderError> | undefined;
    if (error && typeof error.kind === 'string' && typeof error.retryable === 'boolean' && error.provider === provider) {
      return error as ProviderError;
    }
  }
  return {
    provider,
    kind: 'network',
    retryable: true,
    code: 'unknown',
    message: thrown instanceof Error ? thrown.message : String(thrown),
  };
}
