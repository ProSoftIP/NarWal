// Turns the service worker's `ui-status` answer into the RecorderStatus the
// recorder UI shows (packages/recorder-ui/src/port.js). Pure: the popup and
// the in-page strip both use it, and the unit tests run it in Node.

// The transcript choices of the first release. Matt, Telegram 2026-10-13
// 22:23Z (q3549, #16545): "I meant open ai or on this computer"; Deepgram and
// AssemblyAI are not offered for now.
export const TRANSCRIPTION_IDS = ['offline', 'openai'];
// Providers whose key the user saves. The offline choice has none.
export const KEY_PROVIDERS = ['openai'];

const AFTER_RECORDING = new Set(['openai']);
const LIVE_TRANSCRIPT_STATES = new Set(['connecting', 'live', 'behind', 'reconnecting', 'disconnected']);

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

/** Plain words for a recording that stopped because saving failed; '' when it ended normally. */
export function failureText(result) {
  const err = result && result.storageError;
  if (!err) return '';
  const when = clockTime(err.at || result.at);
  return err.quota
    ? `Storage is full. Recording stopped at ${when}. Everything saved before that is kept`
    : `Saving failed at ${when} (${err.message}). Recording stopped. Everything saved before that is kept`;
}

// Plain words for why the OpenAI transcript failed (offscreen/openai-job.js).
const AFTER_FAILURE_TEXT = {
  auth: 'OpenAI did not accept the key',
  quota: 'the OpenAI account is out of credit or over its limit',
  'rate-limit': 'OpenAI is busy',
  network: 'there is no connection to OpenAI',
  timeout: 'OpenAI did not answer in time',
  input: 'OpenAI could not use the audio',
  provider: 'OpenAI had a problem',
  interrupted: 'the browser stopped the upload before it finished',
};

// Plain words for why the transcript on this computer was not improved (offscreen/local-job.js).
const LOCAL_FAILURE_TEXT = {
  model: 'the transcript model is not installed or is damaged; open the model page to install it',
  engine: 'the transcript model stopped working',
  interrupted: 'the browser stopped it before it finished',
};

function afterFailureText(error, local = false) {
  if (!error) return 'something went wrong';
  if (error.code === 'no-audio') return 'no narration audio was saved';
  return (local ? LOCAL_FAILURE_TEXT : AFTER_FAILURE_TEXT)[error.kind] || error.message || 'something went wrong';
}

// Failures the user can put right before they ask again: another key, more
// credit, the transcript model installed.
const USER_FIX_KINDS = new Set(['auth', 'quota', 'model']);

/**
 * What the saved state of an OpenAI job allows next (openai-job.js):
 * 'retry' the same upload can work now (Try again); 'after-fix' only once the
 * user has changed the key or the account; 'never' asking again cannot help,
 * or nothing failed. Each upload is paid for, so only 'retry' starts one from
 * the in-page controls.
 * @param {object|null} job  the recording's `afterTranscript`
 */
export function afterTranscriptNext(job) {
  if (!job || !job.state) return 'never';
  if (job.state === 'no-key') return 'after-fix';
  if (job.state === 'done') return job.partial ? 'retry' : 'never';
  if (job.state !== 'failed') return 'never';
  const error = job.error || {};
  if (error.retryable !== false) return 'retry';
  return USER_FIX_KINDS.has(error.kind) ? 'after-fix' : 'never';
}

/**
 * The transcript made after Stop, for the controls and the recordings page:
 * OpenAI's (board #16588), or the improved one made on this computer (board
 * #16603, `provider: 'browser-local'`). State plus plain words, never the
 * transcript or a key.
 * @param {object|null} job  the recording's `afterTranscript`
 * @returns {{state:'uploading'|'improving'|'done'|'partial'|'failed'|'no-key', done?:number, total?:number, progress?:number, detail?:string, activated?:boolean, next?:'retry'|'after-fix'|'never'}|null}
 */
export function afterTranscriptStatus(job) {
  if (!job || !job.state) return null;
  const local = job.provider === 'browser-local';
  switch (job.state) {
    case 'uploading':
      return { state: 'uploading', done: job.done || 0, total: job.total || 1 };
    case 'improving':
      return { state: 'improving', progress: Math.max(0, Math.min(1, Number(job.progress) || 0)) };
    case 'done':
      if (job.partial) return { state: 'partial', detail: afterFailureText(job.error, local), activated: Boolean(job.activated) };
      return { state: 'done', activated: Boolean(job.activated) };
    case 'no-key':
      return { state: 'no-key' };
    default:
      return { state: 'failed', detail: afterFailureText(job.error, local), next: afterTranscriptNext({ ...job, state: 'failed' }) };
  }
}

/** True while a transcript is being made after Stop: export waits for it. */
export function afterTranscriptBusy(job) {
  return Boolean(job && (job.state === 'uploading' || job.state === 'improving'));
}

/**
 * What the strip says about the transcript. OpenAI Whisper is made after the
 * recording. A live choice shows what the recorder reports; with no report
 * the strip only says "Recording." (no engine answered yet).
 */
export function transcriptState(choice, reported) {
  if (AFTER_RECORDING.has(choice)) return { state: 'after-recording' };
  if (reported && LIVE_TRANSCRIPT_STATES.has(reported.state)) {
    return reported.detail ? { state: reported.state, detail: String(reported.detail) } : { state: reported.state };
  }
  return { state: 'off' };
}

/**
 * @param {object} sw  the service worker's ui-status answer: {live, stopping, recorder, lastResult, afterTranscript, now}
 * @param {object} [context]
 * @param {number} [context.tabId]  the tab this view belongs to (popup); undefined in the page
 * @param {object} [context.tab]  {ok, title?, reason?} for the tab Start would record
 * @param {string} [context.mic]  granted | prompt | denied | unavailable
 * @param {boolean} [context.online]
 * @param {object} [context.model]  {state, bytesDone?, bytesTotal?, error?}
 * @param {object} [context.keys]  {deepgram?: boolean, ...}; never the key
 * @param {number} [context.hidden]  areas of the tab's page the user hid before recording (that the page still has)
 * @param {number} [context.hiddenLost]  hidden areas the page no longer has: Start is blocked
 * @returns {import('../../../recorder-ui/src/port.js').RecorderStatus & {elsewhere?: boolean}}
 */
export function toRecorderStatus(sw, context = {}) {
  const now = Number.isFinite(sw && sw.now) ? sw.now : Date.now();
  const base = {
    tab: context.tab || { ok: true },
    mic: context.mic || 'granted',
    online: context.online !== false,
    model: context.model || { state: 'missing' },
    keys: context.keys || {},
    hidden: context.hidden || 0,
    hiddenLost: context.hiddenLost || 0,
  };
  const live = sw && sw.live;
  if (live) {
    const rec = (sw && sw.recorder) || {};
    const audio = rec.audio && rec.audio.state;
    return {
      ...base,
      phase: 'recording',
      transcription: live.transcription,
      elapsedMs: Math.max(0, now - live.startedAt),
      micLive: audio !== 'unavailable' && audio !== 'lost',
      // Board #16785: nothing heard in the first 10 s; the chosen microphone was not connected.
      micSilent: rec.micSilent === true,
      micFallback: Boolean(rec.audio && rec.audio.deviceFallback),
      recordingId: live.id,
      transcript: transcriptState(live.transcription, rec.transcript),
      elsewhere: context.tabId !== undefined && live.tabId !== context.tabId,
    };
  }
  const stopping = sw && sw.stopping;
  if (stopping) {
    return {
      ...base,
      phase: 'stopping',
      transcription: stopping.transcription,
      elapsedMs: Math.max(0, (stopping.at || now) - stopping.startedAt),
      recordingId: stopping.id,
    };
  }
  const last = sw && sw.lastResult;
  if (last && !last.dismissed) {
    const error = failureText(last);
    const afterTranscript = afterTranscriptStatus(sw.afterTranscript);
    return {
      ...base,
      phase: error ? 'failed' : 'saved',
      transcription: last.transcription,
      elapsedMs: Number.isFinite(last.startedAt) ? Math.max(0, last.at - last.startedAt) : 0,
      recordingId: last.id,
      ...(error ? { error } : {}),
      ...(afterTranscript ? { afterTranscript } : {}),
    };
  }
  return { ...base, phase: 'idle' };
}
