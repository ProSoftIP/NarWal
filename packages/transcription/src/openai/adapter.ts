// OpenAI whisper-1 after-recording adapter (board #16547).
// Runs in an extension context with host permission for api.openai.com (service worker or
// offscreen document). It uploads only on an explicit UploadConsent, never falls back to
// another provider, and returns a new TranscriptRevision; it never edits a stored one.

import type {
  BatchTranscriptionAdapter,
  BatchTranscriptionRequest,
  GapReason,
  ProviderError,
  TranscriptGap,
  TranscriptRevision,
} from '../contract.ts';
import {
  InvalidProviderResponse,
  OPENAI_FILE_EXTENSIONS,
  OPENAI_MAX_UPLOAD_BYTES,
  OPENAI_TIMED_MODEL,
  OPENAI_TRANSCRIPTIONS_URL,
  UploadRefused,
  assertOpenAiUploadConsent,
  buildOpenAiTranscriptionForm,
  classifyOpenAiHttpError,
  parseOpenAiVerboseJson,
  parseRetryAfterMs,
} from './api.ts';
import type { OpenAiTimedTranscript } from './api.ts';
import type { AudioSlicer } from './audio.ts';
import type { ChunkTranscript, UploadChunk } from './chunking.ts';
import { dropUnspokenTail, mergeChunkTranscripts, planUploadChunks, toChunkTranscript } from './chunking.ts';
import { estimateOpenAiCostUsd } from './info.ts';
import { ProviderErrorException, redactSecrets } from '../provider-error.ts';
import { assertTranscriptRevision } from '../revisions.ts';

export type OpenAiProgress =
  | { type: 'plan'; uploads: number; uploadedAudioMs: number | null }
  | { type: 'upload-start'; index: number; attempt: number }
  | { type: 'retry'; index: number; attempt: number; delayMs: number; error: ProviderError }
  | { type: 'upload-done'; index: number };

export interface OpenAiWhisperOptions {
  fetch?: typeof fetch;
  /** Needed only for audio over the upload limit. Without it, such audio is refused. */
  slicer?: AudioSlicer;
  maxUploadBytes?: number;
  /** Audio shared by neighbouring uploads. */
  overlapMs?: number;
  /** Tries per upload, the first one included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A longer `Retry-After` than this ends the job instead of waiting. */
  maxRetryAfterMs?: number;
  /** Limit for one attempt, upload and answer together. An attempt over it counts as a timeout and is tried again. */
  requestTimeoutMs?: number;
  onProgress?: (event: OpenAiProgress) => void;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  newRevisionId?: () => string;
}

export interface OpenAiTranscriptionResult {
  revision: TranscriptRevision;
  uploads: number;
  completedUploads: number;
  /** Seconds OpenAI reported as billed, summed over completed uploads. */
  billedAudioSeconds: number;
  estimatedCostUsd: number;
  /** Set when a later upload failed and the revision carries a gap for the rest. */
  error?: ProviderError;
}

/** No upload produced a transcript. `error` says why and whether a retry can help. */
export class TranscriptionFailed extends ProviderErrorException {
  constructor(error: ProviderError) {
    super(error);
    this.name = 'TranscriptionFailed';
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const GAP_REASONS: Record<ProviderError['kind'], GapReason> = {
  auth: 'auth-failed',
  quota: 'provider-error',
  'rate-limit': 'rate-limited',
  input: 'provider-error',
  timeout: 'provider-error',
  network: 'connect-failed',
  provider: 'provider-error',
};

export class OpenAiWhisperAdapter implements BatchTranscriptionAdapter {
  readonly provider = 'openai' as const;
  #options: Required<Omit<OpenAiWhisperOptions, 'slicer' | 'onProgress'>> & Pick<OpenAiWhisperOptions, 'slicer' | 'onProgress'>;

  constructor(options: OpenAiWhisperOptions = {}) {
    this.#options = {
      // Called as a bare function: `fetch` throws when invoked with another `this`.
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      slicer: options.slicer,
      maxUploadBytes: options.maxUploadBytes ?? OPENAI_MAX_UPLOAD_BYTES,
      overlapMs: options.overlapMs ?? 4000,
      maxAttempts: options.maxAttempts ?? 4,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 120_000,
      // A 25 MB part on a slow uplink takes minutes; a shorter limit would fail an upload that is still moving.
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      onProgress: options.onProgress,
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
      newRevisionId: options.newRevisionId ?? (() => `openai-${crypto.randomUUID()}`),
    };
  }

  async transcribe(
    request: BatchTranscriptionRequest,
    credential: { kind: 'api-key'; key: string },
    signal: AbortSignal,
  ): Promise<TranscriptRevision> {
    return (await this.transcribeDetailed(request, credential, signal)).revision;
  }

  /**
   * Uploads one at a time, in order. A failed upload ends the job: with no
   * transcript yet it throws TranscriptionFailed; after one or more completed
   * uploads it returns what it has, with a gap from the failure to the end.
   */
  async transcribeDetailed(
    request: BatchTranscriptionRequest,
    credential: { kind: 'api-key'; key: string },
    signal: AbortSignal,
  ): Promise<OpenAiTranscriptionResult> {
    const options = this.#options;
    signal.throwIfAborted();
    assertOpenAiUploadConsent(request.recordingId, request.consent);
    if (credential?.kind !== 'api-key' || !credential.key.trim()) {
      throw new UploadRefused('no-key', 'No OpenAI API key is set');
    }
    if (request.audio.size === 0) throw new UploadRefused('empty', 'Audio is empty');

    const planned = await this.#plan(request.audio, signal);
    options.onProgress?.({ type: 'plan', uploads: planned.chunks.length, uploadedAudioMs: planned.uploadedAudioMs });

    const revisionId = options.newRevisionId();
    const done: ChunkTranscript[] = [];
    let billedAudioSeconds = 0;
    let failure: ProviderError | undefined;
    for (const chunk of planned.chunks) {
      let outcome: { transcript: OpenAiTimedTranscript } | { error: ProviderError };
      try {
        outcome = await this.#uploadWithRetry(request, planned.audioFor(chunk), chunk.index, credential.key, signal);
      } catch (cause) {
        // Refused with nothing sent yet: the caller can give the consent back.
        if (!(cause instanceof UploadRefused) || done.length === 0) throw cause;
        // Earlier parts were uploaded and charged, so their transcript is kept and this part becomes the gap.
        outcome = { error: { provider: 'openai', kind: 'input', retryable: false, code: `refused-${cause.reason}`, message: cause.message } };
      }
      if ('error' in outcome) {
        failure = outcome.error;
        break;
      }
      billedAudioSeconds += outcome.transcript.billedSeconds ?? 0;
      done.push(
        toChunkTranscript(dropUnspokenTail(outcome.transcript), {
          index: chunk.index,
          audioOriginMs: request.audioOriginMs,
          uploadStartMs: chunk.upload.startMs,
          uploadEndMs: planned.durationMs === null ? null : chunk.upload.endMs,
        }),
      );
      options.onProgress?.({ type: 'upload-done', index: chunk.index });
    }
    if (done.length === 0) {
      throw new TranscriptionFailed(failure ?? { provider: 'openai', kind: 'provider', retryable: false, code: 'no-upload', message: 'Nothing was uploaded' });
    }

    const gaps: TranscriptGap[] = [];
    if (failure && planned.durationMs !== null) {
      gaps.push({
        provider: 'openai',
        startMs: done[done.length - 1].range.endMs,
        endMs: request.audioOriginMs + planned.durationMs,
        reason: GAP_REASONS[failure.kind],
        detail: `${failure.code}: ${failure.message}`,
      });
    }
    const revision: TranscriptRevision = {
      revisionId,
      provider: 'openai',
      model: OPENAI_TIMED_MODEL,
      createdAtMs: options.now(),
      source: 'after-recording',
      segments: mergeChunkTranscripts(done, { provider: 'openai', model: OPENAI_TIMED_MODEL, revisionId }),
      gaps,
    };
    assertTranscriptRevision(revision);

    const uploadedMs = done.reduce((sum, chunk) => sum + (chunk.range.endMs - chunk.range.startMs), 0);
    return {
      revision,
      uploads: planned.chunks.length,
      completedUploads: done.length,
      billedAudioSeconds,
      estimatedCostUsd: estimateOpenAiCostUsd(billedAudioSeconds > 0 ? billedAudioSeconds * 1000 : uploadedMs),
      ...(failure ? { error: failure } : {}),
    };
  }

  /** One upload when the file fits; otherwise time ranges cut by the slicer. */
  async #plan(audio: Blob, signal: AbortSignal): Promise<{
    chunks: UploadChunk[];
    durationMs: number | null;
    uploadedAudioMs: number | null;
    audioFor(chunk: UploadChunk): Blob;
  }> {
    const { maxUploadBytes, slicer, overlapMs } = this.#options;
    if (audio.size <= maxUploadBytes) {
      if (!OPENAI_FILE_EXTENSIONS[audio.type.split(';')[0].trim().toLowerCase()]) {
        throw new UploadRefused('unsupported-type', `OpenAI does not accept ${audio.type || 'untyped audio'}`);
      }
      // The length of a compressed file is not known before the provider reports it.
      const whole = { startMs: 0, endMs: 0 };
      return { chunks: [{ index: 0, core: whole, upload: whole }], durationMs: null, uploadedAudioMs: null, audioFor: () => audio };
    }
    if (!slicer) {
      throw new UploadRefused(
        'oversized',
        `Audio is ${audio.size} bytes; OpenAI accepts at most ${maxUploadBytes} and this build cannot split it`,
      );
    }
    const prepared = await slicer(audio, signal);
    signal.throwIfAborted();
    const chunks = planUploadChunks({
      durationMs: prepared.durationMs,
      bytesPerSecond: prepared.bytesPerSecond,
      headerBytes: prepared.headerBytes,
      maxBytes: maxUploadBytes,
      overlapMs,
    });
    return {
      chunks,
      durationMs: prepared.durationMs,
      uploadedAudioMs: chunks.reduce((sum, chunk) => sum + (chunk.upload.endMs - chunk.upload.startMs), 0),
      audioFor: (chunk) => prepared.slice(chunk.upload.startMs, chunk.upload.endMs),
    };
  }

  async #uploadWithRetry(
    request: BatchTranscriptionRequest,
    audio: Blob,
    index: number,
    key: string,
    signal: AbortSignal,
  ): Promise<{ transcript: OpenAiTimedTranscript } | { error: ProviderError }> {
    const options = this.#options;
    // Checked once, before the first attempt: an oversized or mistyped slice is never sent.
    buildOpenAiTranscriptionForm({ ...request, audio }, options.maxUploadBytes);
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      options.onProgress?.({ type: 'upload-start', index, attempt });
      const outcome = await this.#uploadOnce(request, audio, key, signal);
      if ('transcript' in outcome) return outcome;

      const { error } = outcome;
      if (!error.retryable || attempt >= options.maxAttempts) return outcome;
      if (error.retryAfterMs !== undefined && error.retryAfterMs > options.maxRetryAfterMs) return outcome;
      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      // Jitter over the upper half, so a provider-stated delay is never undercut.
      const delayMs = Math.round(error.retryAfterMs ?? backoff * (0.5 + options.random() / 2));
      options.onProgress?.({ type: 'retry', index, attempt, delayMs, error });
      await options.sleep(delayMs, signal);
    }
  }

  async #uploadOnce(
    request: BatchTranscriptionRequest,
    audio: Blob,
    key: string,
    signal: AbortSignal,
  ): Promise<{ transcript: OpenAiTimedTranscript } | { error: ProviderError }> {
    const options = this.#options;
    // The key must not reach logs, stored gaps or the UI through an error message.
    const fail = (error: ProviderError) => ({ error: { ...error, message: redactSecrets(error.message, [key]) } });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options.requestTimeoutMs);
    const timedOut = (): { error: ProviderError } =>
      fail({
        provider: 'openai',
        kind: 'timeout',
        retryable: true,
        code: 'request-timeout',
        message: `No answer from OpenAI in ${Math.round(options.requestTimeoutMs / 1000)} s`,
      });

    try {
      let response: Response;
      try {
        response = await options.fetch(OPENAI_TRANSCRIPTIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: buildOpenAiTranscriptionForm({ ...request, audio }, options.maxUploadBytes),
          // Also ends the read of the answer, not only the upload.
          signal: AbortSignal.any([signal, timeout.signal]),
        });
      } catch (cause) {
        signal.throwIfAborted();
        if (timeout.signal.aborted) return timedOut();
        const message = cause instanceof Error ? cause.message : String(cause);
        return fail({ provider: 'openai', kind: 'network', retryable: true, code: 'network', message });
      }

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        signal.throwIfAborted();
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), options.now());
        return fail(classifyOpenAiHttpError(response.status, body, retryAfterMs));
      }
      try {
        return { transcript: parseOpenAiVerboseJson(await response.json()) };
      } catch (cause) {
        signal.throwIfAborted();
        if (timeout.signal.aborted) return timedOut();
        // A truncated body can succeed on a second try; a well-formed body in the wrong shape cannot.
        const invalid = cause instanceof InvalidProviderResponse;
        const message = invalid ? cause.message : 'OpenAI response was not valid JSON';
        return fail({ provider: 'openai', kind: 'provider', retryable: !invalid, code: 'invalid-response', message });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
