// The after-recording transcript with OpenAI whisper-1 (board #16588). After
// Stop, a recording made with the OpenAI choice sends its narration audio, and
// nothing else, to OpenAI with the user's own key, and saves the answer as a
// transcript revision (transcription/src/revisions.ts). Runs in the offscreen
// document: it outlives the service worker, and a file over the upload limit
// is cut with OfflineAudioContext, which a service worker does not have.
//
// The job's state is in the recording's meta as `afterTranscript`, so the
// strip and the recordings page read it after a worker restart:
//   { state: 'uploading', jobId, startedAt, at, done, total }
//   { state: 'done', jobId, at, revisionId, activated, notActivated?, partial, error? }
//   { state: 'failed', jobId?, at, error: { kind, code, message, retryable } }
//   { state: 'no-key', at }
// A job has an overall time limit (deadlineFor): a hung upload ends as a
// failure the user can try again, it does not show "uploading" for 40 minutes.
// The key is asked from the service worker for each job and only goes into the
// request's Authorization header; it is never saved, logged or shown, and error
// text is redacted before it is saved.
import { OpenAiWhisperAdapter, OPENAI_TIMED_MODEL, stripOpenAiKeyText } from '../../../transcription/src/openai/index.ts';
import { assertTranscriptRevision, cancelRetranscription, retranscribe } from '../../../transcription/src/revisions.ts';
import { redactSecrets } from '../../../transcription/src/provider-error.ts';
import { audioSegmentsOf } from '../shared/analyze.js';

const GAP_REASONS = { auth: 'auth-failed', 'rate-limit': 'rate-limited', network: 'connect-failed' };

/**
 * The longest one job may take: ten minutes plus a quarter of the narration's
 * length. OpenAI answers many times faster than the audio plays; without a
 * limit, one hung upload is tried four times at ten minutes each.
 */
export function deadlineFor(audioMs) {
  return 10 * 60_000 + Math.round(Math.max(0, audioMs) / 4);
}

/** Error text as it is saved and shown: no key, and no part of one. */
function cleanText(text, key) {
  return stripOpenAiKeyText(redactSecrets(String(text || ''), [key])).slice(0, 300);
}

/** What is saved about a failure: plain fields, the key taken out of the text. */
export function failureOf(err, key) {
  const clean = (text) => cleanText(text, key);
  if (err && err.error && err.error.provider) {
    const { kind, code, message, retryable } = err.error;
    return { kind, code: String(code), message: clean(message), retryable: Boolean(retryable) };
  }
  if (err && err.name === 'UploadRefused') return { kind: 'refused', code: `refused-${err.reason}`, message: clean(err.message), retryable: false };
  if (err && err.name === 'RevisionConflict') return { kind: 'conflict', code: err.reason, message: clean(err.message), retryable: false };
  return { kind: 'error', code: 'error', message: clean((err && err.message) || err), retryable: true };
}

/**
 * One adapter over every audio part of a recording. A recorder restart starts
 * a new WebM file, so each part is its own upload and its words are placed at
 * the part's start on the session clock. A part that fails after an earlier
 * one worked becomes a gap, with every part after it.
 */
export function partsAdapter({ parts, origin, adapterFor, newRevisionId, now }) {
  return {
    provider: 'openai',
    async transcribe(request, credential, signal) {
      const revisionId = newRevisionId();
      const segments = [];
      const gaps = [];
      let failure = null;
      for (const [index, part] of parts.entries()) {
        const audioOriginMs = Math.max(0, Math.round(part.startAt - origin));
        if (failure) {
          gaps.push(partGap(part, audioOriginMs, failure));
          continue;
        }
        const audio = new Blob(
          part.chunks.map((c) => c.data),
          { type: part.mime || 'audio/webm;codecs=opus' },
        );
        let result;
        try {
          // Its own revision ID per part keeps segment keys unique across parts.
          result = await adapterFor(index).transcribeDetailed({ ...request, audio, audioOriginMs }, credential, signal);
        } catch (err) {
          // Nothing transcribed yet: the job fails as a whole (an UploadRefused gives the consent back).
          if (!segments.length || signal.aborted) throw err;
          failure = failureOf(err, credential.key);
          gaps.push(partGap(part, audioOriginMs, failure));
          continue;
        }
        segments.push(...result.revision.segments);
        gaps.push(...result.revision.gaps);
        if (result.error) failure = result.error;
      }
      const revision = {
        revisionId,
        provider: 'openai',
        model: OPENAI_TIMED_MODEL,
        createdAtMs: now(),
        source: 'after-recording',
        segments: segments.sort((a, b) => a.startMs - b.startMs),
        gaps,
      };
      assertTranscriptRevision(revision);
      return revision;
    },
  };
}

function partGap(part, audioOriginMs, failure) {
  return {
    provider: 'openai',
    startMs: audioOriginMs,
    endMs: audioOriginMs + Math.max(0, Math.round(part.endAt - part.startAt)),
    reason: GAP_REASONS[failure.kind] || 'provider-error',
    detail: `${failure.code}: ${failure.message}`.slice(0, 300),
  };
}

/**
 * @param {object} options
 * @param {object} options.store  getRecording, updateRecording, readAudio, historyStore, updateHistory (all by recording ID)
 * @param {() => Promise<{key: string|null, endpoint?: string}>} options.getKey  from the service worker
 * @param {() => number} options.now  wall clock (shared/clock.js)
 * @param {typeof fetch} [options.fetch]
 * @param {import('../../../transcription/src/openai/audio.ts').AudioSlicer} [options.slicer]
 * @param {() => void} [options.onEnd]  a job ended (the recorder may close)
 * @param {(audioMs: number) => number} [options.deadlineMs]  the longest one job may take
 */
export function createOpenAiJobs({ store, getKey, now, fetch = (input, init) => globalThis.fetch(input, init), slicer, onEnd = () => {}, deadlineMs = deadlineFor }) {
  const running = new Map(); // recordingId -> jobId

  async function setState(id, afterTranscript) {
    await store.updateRecording(id, { afterTranscript: { ...afterTranscript, at: now() } });
  }

  /**
   * Starts a job for a stopped recording. Resolves once the job is marked
   * uploading (or refused); the upload goes on after that.
   */
  async function run(recordingId) {
    if (running.has(recordingId)) return { ok: true, state: 'uploading', already: true };
    const meta = await store.getRecording(recordingId);
    if (!meta) return { ok: false, error: 'unknown-recording', message: 'that recording is not saved on this computer' };
    if (meta.status === 'recording') return { ok: false, error: 'recording', message: 'stop the recording first' };
    if (meta.transcription !== 'openai') return { ok: false, error: 'not-openai', message: 'this recording does not use OpenAI' };
    const jobId = crypto.randomUUID();
    running.set(recordingId, jobId);
    let key = null;
    try {
      const reply = await getKey();
      key = (reply && reply.key) || null;
      if (!key) {
        await setState(recordingId, { state: 'no-key' });
        throw Object.assign(new Error('no OpenAI key is saved'), { code: 'no-key' });
      }
      const parts = audioSegmentsOf(await store.readAudio(recordingId)).filter((p) => p.bytes > 0);
      if (!parts.length) {
        await setState(recordingId, { state: 'failed', jobId, error: { kind: 'input', code: 'no-audio', message: 'no narration audio was saved', retryable: false } });
        throw Object.assign(new Error('no narration audio was saved'), { code: 'no-audio' });
      }
      // A job that was running when the browser closed still holds the
      // history; only one job per recording runs, and it is not that one.
      // Each try is a new consent, so its time is after every used one.
      let startedAt = now();
      await store.updateHistory(recordingId, (h) => {
        for (const used of h.usedConsents) if (used.provider === 'openai' && used.grantedAtMs >= startedAt) startedAt = used.grantedAtMs + 1;
        return h.pending ? cancelRetranscription(h, h.pending.jobId) : h;
      });
      await setState(recordingId, { state: 'uploading', jobId, startedAt, done: 0, total: parts.length });
      upload({ recordingId, jobId, startedAt, meta, parts, key, endpoint: reply.endpoint });
      return { ok: true, state: 'uploading' };
    } catch (err) {
      running.delete(recordingId);
      onEnd();
      if (err.code === 'no-key' || err.code === 'no-audio') return { ok: false, error: err.code, message: err.message };
      const error = failureOf(err, key);
      await setState(recordingId, { state: 'failed', jobId, error }).catch(() => {});
      return { ok: false, error: error.code, message: error.message };
    }
  }

  async function upload({ recordingId, jobId, startedAt, meta, parts, key, endpoint }) {
    let done = 0;
    let total = parts.length;
    let progress = Promise.resolve();
    const report = () => {
      progress = progress.then(() => setState(recordingId, { state: 'uploading', jobId, startedAt, done, total })).catch(() => {});
    };
    // Test builds only: the e2e run answers from a fixture server (board #16588).
    const testEndpoint = typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST && endpoint;
    const send = testEndpoint ? (input, init) => fetch(testEndpoint, init) : fetch;
    const adapterFor = () => {
      let planned = false;
      return new OpenAiWhisperAdapter({
        fetch: send,
        slicer,
        newRevisionId: () => `openai-${crypto.randomUUID()}`,
        onProgress: (event) => {
          if (event.type === 'plan' && !planned) {
            // A part over the upload limit is cut into several uploads.
            planned = true;
            total += event.uploads - 1;
            report();
          }
          if (event.type === 'upload-done') {
            done += 1;
            report();
          }
        },
      });
    };
    const adapter = partsAdapter({ parts, origin: meta.startedAt, adapterFor, newRevisionId: () => `openai-${crypto.randomUUID()}`, now });
    // Choosing OpenAI for this recording and pressing Stop (or Try again) is
    // the consent for this one upload; each try is a new consent.
    const consent = { provider: 'openai', recordingId, grantedAtMs: startedAt, scope: 'narration-audio' };
    const request = { recordingId, consent, language: 'en' };
    const limitMs = deadlineMs(parts.reduce((ms, part) => ms + Math.max(0, part.endAt - part.startAt), 0));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('the job took too long')), limitMs);
    try {
      const result = await retranscribe(store.historyStore(recordingId), adapter, request, { kind: 'api-key', key }, deadline.signal, { jobId, startedAtMs: startedAt });
      const stored = result.history.revisions.find((r) => r.revisionId === result.revisionId);
      const partial = Boolean(stored && stored.gaps && stored.gaps.length);
      await progress;
      await setState(recordingId, {
        state: 'done',
        jobId,
        revisionId: result.revisionId,
        activated: result.activated,
        ...(result.notActivated ? { notActivated: result.notActivated } : {}),
        partial,
        ...(partial ? { error: { kind: 'partial', code: 'partial', message: cleanText(stored.gaps.map((g) => g.detail || g.reason).join('; '), key), retryable: true } } : {}),
      });
    } catch (err) {
      await progress;
      const error = deadline.signal.aborted
        ? { kind: 'timeout', code: 'deadline', message: `no transcript after ${Math.max(1, Math.round(limitMs / 60_000))} min`, retryable: true }
        : failureOf(err, key);
      await setState(recordingId, { state: 'failed', jobId, error }).catch(() => {});
    } finally {
      clearTimeout(timer);
      running.delete(recordingId);
      onEnd();
    }
  }

  return {
    run,
    /** Recording IDs with a job running in this document. */
    running: () => [...running.keys()],
  };
}
