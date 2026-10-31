// The after-recording transcript on this computer (board #16603). After Stop,
// a recording made with the offline choice runs the final pass (Parakeet,
// Whisper or Moonshine) over its saved narration audio and saves the result as a
// transcript revision (source 'after-recording', provider 'browser-local')
// that replaces the live Vosk text. Nothing leaves the computer. Runs in the offscreen document: the
// audio is decoded with OfflineAudioContext, which a service worker does not
// have, and the engine runs in a worker the document owns.
//
// Which model runs is the machine's tier (offline-transcription/src/tier.ts):
// large-v3-turbo on a real WebGPU adapter, Parakeet on WebAssembly,
// each with a fallback when a model cannot load or would be too slow. A model
// picked in the picker (board #16611, meta.offlineModel) runs first, then the
// tier's models. Only installed models run; with none installed the job fails
// at once and the live transcript stays. The live model picked means no pass
// after Stop: the live text is the transcript. A text that fails the sanity
// check (offline-transcription/src/plausible.ts) is stored but not made active.
//
// The job's state is in the recording's meta as `afterTranscript`, the same
// field as the OpenAI job, so the strip and the recordings page read it after
// a worker restart:
// Every state has `provider: 'browser-local'`:
//   { state: 'improving', jobId, startedAt, at, progress (0..1), model }
//   { state: 'done', jobId, at, revisionId, activated, notActivated?, partial, model, error? }
//   { state: 'failed', jobId, at, error: { kind, code, message, retryable }, revisionId? }
// Progress is checkpointed after each speech span. A job cut short (tab or
// browser closed, the document crashed) is resumed from its checkpoint when
// the recorder opens again, with the next model of the chain: the one that
// was running may be what stopped it.
import { chainAfterCutShort, finalizeWithChain } from '../../../offline-transcription/src/final-chain.ts';
import { implausibleFinal } from '../../../offline-transcription/src/plausible.ts';
import { detectFinalTier } from '../../../offline-transcription/src/tier.ts';
import { chainFor, installedChain } from '../../../offline-transcription/src/picker.ts';
import { decodeToEnginePcm, fitAudioClock } from '../../../offline-transcription/src/audio.ts';
import { pcmSource } from '../../../offline-transcription/src/vad.ts';
import { LOCAL_PROVIDER } from '../../../offline-transcription/src/contract.ts';
import { addImprovedRevision, addRevision, assertTranscriptRevision } from '../../../transcription/src/revisions.ts';
import { audioSegmentsOf, flattenEntries } from '../shared/analyze.js';
import { deadlineFor } from './openai-job.js';

export const CHECKPOINT_VERSION = 1;
// A job that was resumed this many times without finishing is given up: the
// audio or the machine stops it each time.
export const MAX_RESUMES = 3;

/** What is saved about a failure: plain fields, short text. */
export function failureOf(err) {
  const message = String((err && err.message) || err || 'unknown error').slice(0, 300);
  // The user installs the model first (the model page); trying again before that cannot help.
  if (err && err.name === 'ModelError') return { kind: 'model', code: err.code || 'model-missing', message, retryable: false };
  if (err && err.name === 'RevisionConflict') return { kind: 'conflict', code: err.reason, message, retryable: false };
  if (err && err.name === 'FinalPassStopped') return { kind: 'engine', code: 'engine-failed', message, retryable: true };
  return { kind: 'error', code: 'error', message, retryable: true };
}

/** The audio parts with saved bytes, each with its clock pairs on the session clock. */
export function narrationParts(meta, audioChunks, entries) {
  const origin = meta.startedAt;
  return audioSegmentsOf(audioChunks)
    .filter((part) => part.bytes > 0)
    .map((part) => ({
      ...part,
      audioOriginMs: Math.max(0, Math.round(part.startAt - origin)),
      clock: entries
        .filter((e) => e.k === 'audio' && e.type === 'clock' && e.segment === part.segment)
        .filter((e, i, all) => i === 0 || e.frames > all[i - 1].frames)
        .map((e) => ({ frames: e.frames, sampleRate: e.sampleRate, atMs: Math.max(0, e.t - origin) })),
    }));
}

/** One revision from the passes over each part. Segments are rekeyed so keys stay unique across parts. */
export function mergeParts({ revisionId, parts, supersedes, now }) {
  const models = [...new Set(parts.map((part) => part.model))];
  const segments = [];
  const gaps = [];
  for (const [index, part] of parts.entries()) {
    for (const segment of part.segments) segments.push({ ...segment, connectionId: revisionId, segmentKey: `${revisionId}:${index}:${segment.segmentKey}` });
    gaps.push(...part.gaps);
  }
  segments.sort((a, b) => a.startMs - b.startMs);
  gaps.sort((a, b) => a.startMs - b.startMs);
  const timing = parts.find((part) => part.timing)?.timing;
  const revision = {
    revisionId,
    provider: LOCAL_PROVIDER,
    model: models.join('+'),
    createdAtMs: now(),
    source: 'after-recording',
    segments,
    gaps,
    ...(timing ? { timing } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
  assertTranscriptRevision(revision);
  return revision;
}

/** The newest live revision: the one the final pass replaces. */
export function liveRevisionOf(history) {
  const live = history.revisions.filter((r) => r.source === 'live' && r.provider === LOCAL_PROVIDER);
  return live.length ? live[live.length - 1].revisionId : null;
}

const textOf = (revision) => revision.segments.map((segment) => segment.text).join(' ');

/**
 * @param {object} options
 * @param {object} options.store  getRecording, updateRecording, readAudio, readEvents,
 *   readCheckpoint, writeCheckpoint, clearCheckpoint, readHistory, updateHistory (all by recording ID)
 * @param {() => Promise<{finalize: Function}>} options.openOffline  the offline transcriber
 * @param {() => number} options.now  wall clock (shared/clock.js)
 * @param {(meta: object) => Promise<string[]>} [options.chain]  the models to try for a recording, best first; none: no pass
 * @param {(models: string[]) => Promise<string[]>} [options.installed]  the ones of `models` that are installed, in order
 * @param {() => void} [options.release]  no job runs any more: the final engine may be stopped
 * @param {(data: ArrayBuffer) => Promise<Float32Array>} [options.decode]  narration file -> 16 kHz mono
 * @param {() => void} [options.onEnd]  a job ended (the recorder may close)
 * @param {(audioMs: number) => number} [options.deadlineMs]  the time a model may take before the next one runs
 */
export function createLocalJobs({
  store,
  openOffline,
  now,
  chain = async (meta) => chainFor(meta.offlineModel ?? null, await detectFinalTier()),
  installed = async (models) => models,
  release = () => {},
  decode = decodeToEnginePcm,
  onEnd = () => {},
  deadlineMs = deadlineFor,
}) {
  const running = new Map(); // recordingId -> jobId

  async function setState(id, afterTranscript) {
    await store.updateRecording(id, { afterTranscript: { ...afterTranscript, provider: LOCAL_PROVIDER, at: now() } });
  }

  /**
   * Starts (or resumes) the job for a stopped recording. Resolves once it is
   * marked improving (or refused); the pass goes on after that.
   */
  async function run(recordingId, { resume = false } = {}) {
    if (running.has(recordingId)) return { ok: true, state: 'improving', already: true };
    const meta = await store.getRecording(recordingId);
    if (!meta) return { ok: false, error: 'unknown-recording', message: 'that recording is not saved on this computer' };
    if (meta.status === 'recording') return { ok: false, error: 'recording', message: 'stop the recording first' };
    if (meta.transcription !== 'offline') return { ok: false, error: 'not-offline', message: 'this recording does not use the on-this-computer choice' };
    const wanted = await chain(meta);
    if (!wanted.length) return { ok: false, error: 'live-only', message: 'the live model was picked for this recording: its live text is the transcript' };
    const saved = await store.readCheckpoint(recordingId).catch(() => null);
    const usable = saved && saved.version === CHECKPOINT_VERSION && (saved.resumes || 0) < MAX_RESUMES ? saved : null;
    if (resume && !usable) {
      // Nothing to go on with: the job is over as far as anyone can tell.
      if (saved) await store.clearCheckpoint(recordingId).catch(() => {});
      return { ok: false, error: 'no-checkpoint', message: 'no unfinished transcript job' };
    }
    // A job the browser cut short goes on from its checkpoint; so does Try
    // again after a failure that kept one. A resume the user did not ask for
    // counts towards MAX_RESUMES, and the model it cut short is not run again.
    const cutShort = (usable && usable.cutShort) || [];
    const checkpoint = usable
      ? { ...usable, startedAt: now(), resumes: resume ? (usable.resumes || 0) + 1 : 0, cutShort: resume && usable.model && !cutShort.includes(usable.model) ? [...cutShort, usable.model] : cutShort }
      : { version: CHECKPOINT_VERSION, jobId: crypto.randomUUID(), startedAt: now(), revisionId: `local-${crypto.randomUUID()}`, parts: {}, current: null, resumes: 0, cutShort: [] };
    const { jobId, startedAt } = checkpoint;
    running.set(recordingId, jobId);
    try {
      const [audioChunks, eventChunks] = await Promise.all([store.readAudio(recordingId), store.readEvents(recordingId)]);
      const parts = narrationParts(meta, audioChunks, flattenEntries(eventChunks));
      if (!parts.length) {
        await store.clearCheckpoint(recordingId).catch(() => {});
        await setState(recordingId, { state: 'failed', jobId, error: { kind: 'input', code: 'no-audio', message: 'no narration audio was saved', retryable: false } });
        throw Object.assign(new Error('no narration audio was saved'), { code: 'no-audio' });
      }
      // A model that is not installed is passed over. With none, the job ends
      // now, before anything waits for it (Export, the strip). A retired model
      // runs last, and only where its replacement is not installed (#16609),
      // unless it is the pick (#16611).
      const models = chainAfterCutShort(installedChain(meta.offlineModel ?? null, await installed(wanted)), checkpoint.cutShort);
      if (!models.length) {
        const picked = meta.offlineModel && wanted[0] === meta.offlineModel ? `; the picked model ${meta.offlineModel} is not downloaded` : '';
        throw Object.assign(new Error(`no transcript model for after Stop is installed on this computer${picked}`), { name: 'ModelError', code: 'model-missing' });
      }
      await store.writeCheckpoint(recordingId, checkpoint);
      const progress = partsProgress(parts.length, checkpoint);
      await setState(recordingId, { state: 'improving', jobId, startedAt, progress, model: checkpoint.current?.pass?.model || models[0] });
      transcribe({ recordingId, meta, parts, models, checkpoint });
      return { ok: true, state: 'improving' };
    } catch (err) {
      running.delete(recordingId);
      onEnd();
      if (err.code === 'no-audio') return { ok: false, error: err.code, message: err.message };
      const error = failureOf(err);
      if (!error.retryable) await store.clearCheckpoint(recordingId).catch(() => {});
      await setState(recordingId, { state: 'failed', jobId, error }).catch(() => {});
      return { ok: false, error: error.code, message: error.message };
    }
  }

  async function transcribe({ recordingId, parts, models, checkpoint }) {
    const { jobId, startedAt } = checkpoint;
    let model = models[0];
    let writes = Promise.resolve();
    const report = (fraction) => {
      writes = writes.then(() => setState(recordingId, { state: 'improving', jobId, startedAt, progress: fraction, model })).catch(() => {});
    };
    const save = () => {
      writes = writes.then(() => store.writeCheckpoint(recordingId, checkpoint)).catch(() => {});
      return writes;
    };
    try {
      const transcriber = await openOffline();
      const finalize = (request, name) => transcriber.finalize(request, name);
      const history = await store.readHistory(recordingId);
      const supersedes = liveRevisionOf(history) || undefined;
      const audioMs = parts.reduce((ms, part) => ms + Math.max(0, part.endAt - part.startAt), 0);
      const limitMs = deadlineMs(audioMs);
      for (const [index, part] of parts.entries()) {
        if (checkpoint.parts[index]) continue;
        const pcm = await decode(await new Blob(part.chunks.map((c) => c.data)).arrayBuffer());
        const resumeFrom = checkpoint.current && checkpoint.current.part === index ? checkpoint.current.pass : undefined;
        const result = await finalizeWithChain(
          finalize,
          {
            recordingId,
            revisionId: `${checkpoint.revisionId}-p${index}`,
            audio: pcmSource(pcm),
            ...(part.clock.length ? { timeMap: fitAudioClock(part.clock) } : { audioOriginMs: part.audioOriginMs }),
            ...(resumeFrom ? { resumeFrom } : {}),
            onCheckpoint: (pass) => {
              checkpoint.current = { part: index, pass };
              return save();
            },
            onProgress: ({ doneSpans, totalSpans }) => report((index + (totalSpans ? doneSpans / totalSpans : 1)) / parts.length),
          },
          {
            chain: models,
            // Each model has what is left of the job's time; the last one always finishes.
            deadlineMs: Math.max(0, limitMs - (now() - startedAt)),
            now,
            onModel: (name) => {
              model = name;
              // A job cut short while this model runs goes on with the next one.
              checkpoint.model = name;
              save();
              report(partsProgress(parts.length, checkpoint));
            },
          },
        );
        checkpoint.parts[index] = { model: result.model, segments: result.revision.segments, gaps: result.revision.gaps, timing: result.revision.timing, attempts: result.attempts };
        checkpoint.current = null;
        await save();
      }
      const revision = mergeParts({ revisionId: checkpoint.revisionId, parts: parts.map((_, index) => checkpoint.parts[index]), supersedes, now });
      let outcome = null;
      let implausible = null;
      await store.updateHistory(recordingId, (h) => {
        // `supersedes` names a stored revision; if the live one is gone, the revision stands alone.
        const live = revision.supersedes ? h.revisions.find((r) => r.revisionId === revision.supersedes) : undefined;
        const fit = revision.supersedes && !live ? { ...revision, supersedes: undefined } : revision;
        if (fit.supersedes === undefined) delete fit.supersedes;
        // Text a model wrote that cannot be right is kept for a look, never shown in place of the live text.
        // A revision with gaps is partial (Try again redoes them) and addImprovedRevision keeps it inactive.
        implausible = fit.gaps.length > 0 ? null : implausibleFinal(textOf(fit), live ? textOf(live) : null);
        if (implausible) {
          const stored = addRevision(h, fit, { activate: false });
          outcome = { history: stored, revisionId: stored.revisions[stored.revisions.length - 1].revisionId, activated: false };
          return stored;
        }
        outcome = addImprovedRevision(h, fit);
        return outcome.history;
      });
      await store.clearCheckpoint(recordingId).catch(() => {});
      await writes;
      if (implausible) {
        await setState(recordingId, {
          state: 'failed',
          jobId,
          revisionId: outcome.revisionId,
          model: revision.model,
          error: { kind: 'implausible', code: implausible.code, message: implausible.message, retryable: false },
        });
        return;
      }
      const partial = revision.gaps.length > 0;
      await setState(recordingId, {
        state: 'done',
        jobId,
        revisionId: outcome.revisionId,
        activated: outcome.activated,
        ...(outcome.notActivated ? { notActivated: outcome.notActivated } : {}),
        partial,
        model: revision.model,
        ...(partial ? { error: { kind: 'partial', code: 'partial', message: revision.gaps.map((g) => g.detail || g.reason).join('; ').slice(0, 300), retryable: true } } : {}),
      });
    } catch (err) {
      await writes;
      await setState(recordingId, { state: 'failed', jobId, error: failureOf(err) }).catch(() => {});
      // A model that is not installed or a bad revision is not fixed by resuming.
      if (!failureOf(err).retryable) await store.clearCheckpoint(recordingId).catch(() => {});
    } finally {
      running.delete(recordingId);
      // The engine holds the model in memory (up to a few GB on the GPU tier).
      if (!running.size) release();
      onEnd();
    }
  }

  /** Resumes every job that a closed document cut short. */
  async function resumeAll(recordingIds) {
    const started = [];
    for (const id of recordingIds) {
      const reply = await run(id, { resume: true }).catch(() => null);
      // `already`: this document runs it now. Not started here, but not cut off either.
      if (reply && reply.ok) started.push(id);
    }
    return started;
  }

  return {
    run,
    resumeAll,
    /** Recording IDs with a job running in this document. */
    running: () => [...running.keys()],
  };
}

function partsProgress(count, checkpoint) {
  return Object.keys(checkpoint.parts).length / count;
}
