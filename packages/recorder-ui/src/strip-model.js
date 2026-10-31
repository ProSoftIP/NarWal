// What the one-line strip shows for a recorder status. Pure: the strip
// renders exactly this. One message at a time, the most urgent first:
// microphone lost, then transcript trouble, then the newest words.

import { providerById } from './providers.js';
import { formatClock } from './transcript.js';

/**
 * @typedef {Object} StripModel
 * @property {'recording'|'warn'|'busy'|'done'|'error'} tone
 * @property {string} badge  short state word next to the dot
 * @property {string} time  recording clock
 * @property {string} message
 * @property {'transcript'|'status'} messageKind  transcript: the newest words; status: a sentence
 * @property {string} announce  what a screen reader hears when it changes; never the transcript words
 * @property {boolean} showRetry
 * @property {boolean} showToggle
 * @property {boolean} showStop
 * @property {boolean} stopBusy
 * @property {boolean} showExport  Export the recording just saved (board #16602)
 * @property {boolean} exportWaiting  Export is held until the transcript after Stop is ready (#16588, #16603)
 * @property {boolean} showOpen
 * @property {boolean} showClose
 * @property {boolean} showMeter  the microphone level meter (board #16785)
 */

function providerName(status) {
  const provider = providerById(status.transcription);
  if (!provider) return 'the transcript';
  return provider.id === 'offline' ? 'the speech model' : provider.label;
}

function recordingMessage(status, tail) {
  if (status.micLive === false) {
    return {
      tone: 'warn',
      messageKind: 'status',
      message: 'Microphone stopped. Your voice is not recorded now. The page is still recorded.',
      showRetry: false,
    };
  }
  if (status.micSilent) {
    // Nothing heard in the first 10 s (board #16785): a dead or muted microphone shows at once.
    return {
      tone: 'warn',
      messageKind: 'status',
      message: 'No microphone sound. Check the microphone is on and not muted. The page is still recorded.',
      showRetry: false,
    };
  }
  const transcript = status.transcript || { state: 'off' };
  const name = providerName(status);
  switch (transcript.state) {
    case 'connecting':
      return {
        tone: 'recording',
        messageKind: 'status',
        message: status.transcription === 'offline' ? 'Recording. Starting the speech model…' : `Recording. Connecting to ${name}…`,
        showRetry: false,
      };
    case 'reconnecting':
      return {
        tone: 'warn',
        messageKind: 'status',
        message: `Transcript paused: connecting to ${name} again. Recording continues.`,
        showRetry: false,
      };
    case 'disconnected':
      return {
        tone: 'warn',
        messageKind: 'status',
        message: `Transcript stopped: ${transcript.detail || `${name} is not connected`}. Recording continues.`,
        showRetry: true,
      };
    case 'after-recording':
      return {
        tone: 'recording',
        messageKind: 'status',
        message: 'Recording. The transcript is made after you stop.',
        showRetry: false,
      };
    case 'behind':
      return {
        tone: 'recording',
        messageKind: tail ? 'transcript' : 'status',
        message: tail || 'Recording. The transcript is behind and will catch up.',
        note: 'Transcript is behind',
        showRetry: false,
      };
    case 'live':
      return {
        tone: 'recording',
        messageKind: tail ? 'transcript' : 'status',
        message: tail || 'Recording. Listening…',
        showRetry: false,
      };
    default:
      return { tone: 'recording', messageKind: 'status', message: 'Recording.', showRetry: false };
  }
}

/**
 * True while the transcript of the recording just saved is still being made:
 * by OpenAI (#16588) or improved on this computer (#16603). An export made
 * now would leave without it, so Export waits.
 * @param {import('./port.js').RecorderStatus} status
 */
export function exportWaiting(status) {
  const state = status.afterTranscript?.state;
  return (status.transcription === 'openai' && state === 'uploading') || (status.transcription === 'offline' && state === 'improving');
}

/** The saved message for OpenAI, which makes the transcript after Stop (board #16588). */
function afterTranscriptMessage(job) {
  const saved = 'Saved on this computer.';
  if (!job) return { tone: 'done', message: `${saved} Open the recording to get the transcript.`, announce: 'Recording saved on this computer', showRetry: false };
  switch (job.state) {
    case 'uploading': {
      const part = job.total > 1 ? ` (part ${Math.min(job.done + 1, job.total)} of ${job.total})` : '';
      return { tone: 'busy', message: `${saved} Getting the transcript from OpenAI${part}…`, announce: 'Getting the transcript from OpenAI', showRetry: false };
    }
    case 'done':
      return job.activated
        ? { tone: 'done', message: `${saved} The OpenAI transcript is ready.`, announce: 'The OpenAI transcript is ready', showRetry: false }
        : { tone: 'done', message: `${saved} A new OpenAI transcript is saved. Open the recording to use it.`, announce: 'A new OpenAI transcript is saved', showRetry: false };
    case 'partial':
      return { tone: 'warn', message: `${saved} OpenAI made only part of the transcript: ${job.detail}.`, announce: 'OpenAI made only part of the transcript', showRetry: true };
    case 'no-key':
      return { tone: 'warn', message: `${saved} Save your OpenAI key, then open the recording to get the transcript.`, announce: 'No OpenAI key is saved', showRetry: false };
    default:
      // Try again only when the same upload can work now: not for a refused key, an empty account or no audio.
      return { tone: 'error', message: `${saved} No transcript: ${job.detail || 'something went wrong'}.`, announce: `No transcript: ${job.detail || 'something went wrong'}`, showRetry: job.next === undefined || job.next === 'retry' };
  }
}

/** Whole percent of an after-recording pass, for the strip and the popup. */
export function improvingPercent(job) {
  return Math.max(0, Math.min(99, Math.floor((Number(job && job.progress) || 0) * 100)));
}

/**
 * The saved message for the offline choice: the final pass on this computer
 * improves the live transcript after Stop (board #16603). The live transcript
 * stays until the improved one is ready.
 */
function improvedTranscriptMessage(job) {
  const saved = 'Saved on this computer.';
  switch (job.state) {
    case 'improving':
      return { tone: 'busy', message: `${saved} Improving the transcript on this computer (${improvingPercent(job)}%)…`, announce: 'Improving the transcript on this computer', showRetry: false };
    case 'done':
      return job.activated
        ? { tone: 'done', message: `${saved} The improved transcript is ready.`, announce: 'The improved transcript is ready', showRetry: false }
        : { tone: 'done', message: `${saved} An improved transcript is saved. Open the recording to use it.`, announce: 'An improved transcript is saved', showRetry: false };
    case 'partial':
      return { tone: 'warn', message: `${saved} Only part of the transcript was improved: ${job.detail}.`, announce: 'Only part of the transcript was improved', showRetry: true };
    case 'failed':
      return {
        tone: 'warn',
        message: `${saved} The transcript was not improved: ${job.detail || 'something went wrong'}. The live transcript is kept.`,
        announce: `The transcript was not improved: ${job.detail || 'something went wrong'}`,
        showRetry: job.next === undefined || job.next === 'retry',
      };
    default:
      return {};
  }
}

/**
 * @param {import('./port.js').RecorderStatus} status
 * @param {{tail?: string, elapsedMs?: number}} [live]
 * @returns {StripModel & {note?: string}}
 */
export function stripModel(status, live = {}) {
  const time = formatClock(live.elapsedMs ?? status.elapsedMs ?? 0);
  const base = {
    time,
    note: undefined,
    showRetry: false,
    showToggle: false,
    showStop: false,
    stopBusy: false,
    showExport: false,
    exportWaiting: false,
    showOpen: false,
    showClose: false,
    showMeter: false,
  };
  switch (status.phase) {
    case 'starting':
      return { ...base, tone: 'busy', badge: 'Starting', message: 'Starting the recording…', messageKind: 'status', announce: 'Starting the recording' };
    case 'recording': {
      const body = recordingMessage(status, live.tail || '');
      // The chosen microphone was not connected (board #16785).
      const note = body.note || (status.micFallback ? 'Default microphone' : undefined);
      return {
        ...base,
        ...body,
        note,
        badge: 'Rec',
        announce: body.messageKind === 'status' ? body.message : body.note || '',
        showToggle: (status.transcript?.state || 'off') !== 'off' && status.transcript?.state !== 'after-recording',
        showStop: true,
        showMeter: status.micLive !== false,
      };
    }
    case 'stopping':
      return {
        ...base,
        tone: 'busy',
        badge: 'Saving',
        message: 'Saving the recording on this computer…',
        messageKind: 'status',
        announce: 'Saving the recording',
        showStop: true,
        stopBusy: true,
      };
    case 'saved':
      return {
        ...base,
        tone: 'done',
        badge: 'Saved',
        message: 'Saved on this computer.',
        announce: 'Recording saved on this computer',
        ...(status.transcription === 'openai' ? afterTranscriptMessage(status.afterTranscript) : {}),
        ...(status.transcription === 'offline' && status.afterTranscript ? improvedTranscriptMessage(status.afterTranscript) : {}),
        messageKind: 'status',
        showExport: Boolean(status.recordingId),
        exportWaiting: exportWaiting(status),
        showOpen: Boolean(status.recordingId),
        showClose: true,
      };
    case 'failed':
      return {
        ...base,
        tone: 'error',
        badge: 'Stopped',
        message: `Recording stopped: ${status.error || 'something went wrong'}.${status.recordingId ? ' The part before this is saved.' : ''}`,
        messageKind: 'status',
        announce: `Recording stopped: ${status.error || 'something went wrong'}`,
        showOpen: Boolean(status.recordingId),
        showClose: true,
      };
    default:
      return null;
  }
}
