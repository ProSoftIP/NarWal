// Turns the recorder's status into the three checks the setup view shows
// (tab, microphone, transcript), plus a fourth when an area hidden before
// recording is lost, and decides whether Start may be pressed.
// Pure: no DOM, no chrome APIs.

import { providerById, formatDownloadSize } from './providers.js';

/**
 * @typedef {'ok'|'todo'|'busy'|'blocked'|'note'} CheckState
 *   ok: ready. todo: the user has one action to take. busy: NarWal is
 *   working on it. blocked: cannot record like this. note: recording can
 *   start, but the user should know something.
 * @typedef {Object} Check
 * @property {'tab'|'mic'|'transcript'|'hidden'} id
 * @property {CheckState} state
 * @property {string} title
 * @property {string} [detail]
 * @property {{id:string,label:string}} [action]
 * @property {number} [progress] 0..1 while busy
 */

const MIC = {
  granted: { state: 'ok', title: 'Microphone is ready' },
  prompt: {
    state: 'todo',
    title: 'Microphone needs your permission',
    detail: 'NarWal records your voice. The browser asks you one time.',
    action: { id: 'request-mic', label: 'Allow microphone' },
  },
  denied: {
    state: 'blocked',
    title: 'Microphone is blocked',
    detail:
      'The browser is set to block the microphone for NarWal, so no narration can be recorded. Open the microphone page and choose Allow.',
    action: { id: 'request-mic', label: 'Open microphone page' },
  },
  unavailable: {
    state: 'blocked',
    title: 'No microphone found',
    detail: 'Connect a microphone, then check again.',
    action: { id: 'refresh', label: 'Check again' },
  },
};

function tabCheck(tab) {
  if (tab && tab.ok) {
    return { id: 'tab', state: 'ok', title: 'This tab can be recorded', detail: tab.title || undefined };
  }
  return {
    id: 'tab',
    state: 'blocked',
    title: 'This tab cannot be recorded',
    detail: (tab && tab.reason) || 'Open a website in this tab, then start again.',
  };
}

function micCheck(mic) {
  return { id: 'mic', ...(MIC[mic] || MIC.prompt) };
}

// The models that improve the transcript after Stop (board #16603). Start
// needs only the live model; without these the live transcript is kept.
function finalNote(final) {
  if (!final || final.state === 'ready') return null;
  if (final.state === 'downloading') {
    const known = Number.isFinite(final.bytesTotal) && final.bytesTotal > 0;
    return {
      state: 'note',
      title: known ? `Live text is ready. Downloading the model for a better transcript: ${Math.floor(Math.min(1, (final.bytesDone || 0) / final.bytesTotal) * 100)}%` : 'Live text is ready. Downloading the model for a better transcript',
      detail: 'You can record now. After Stop, the transcript is improved once the download ends.',
    };
  }
  const size = formatDownloadSize(Math.max(0, (final.bytesTotal || 0) - (final.bytesDone || 0)));
  return {
    state: 'note',
    title: 'Live text is ready',
    detail: `You can record now. For a better transcript after Stop, download one more model${size ? ` (${size})` : ''}.`,
    action: { id: 'download-model', label: size ? `Download it (${size})` : 'Download it' },
  };
}

function offlineCheck(model) {
  const m = model || { state: 'missing' };
  const size = formatDownloadSize(m.bytesTotal);
  switch (m.state) {
    case 'ready':
      return finalNote(m.final) || { state: 'ok', title: 'Speech model is on this computer' };
    case 'downloading': {
      const known = Number.isFinite(m.bytesTotal) && m.bytesTotal > 0;
      const progress = known ? Math.min(1, Math.max(0, (m.bytesDone || 0) / m.bytesTotal)) : undefined;
      return {
        state: 'busy',
        title: known ? `Downloading the speech model: ${Math.floor(progress * 100)}%` : 'Downloading the speech model',
        detail: 'You can leave this open. Recording can start when the download ends.',
        progress,
      };
    }
    case 'failed':
      return {
        state: 'todo',
        title: 'The speech model did not download',
        detail: m.error || 'Check your internet connection, then try again.',
        action: { id: 'download-model', label: 'Try the download again' },
      };
    default:
      return {
        state: 'todo',
        title: 'Speech model is not downloaded yet',
        detail: size
          ? `One download of ${size}. After that, transcription works with no internet.`
          : 'One download. After that, transcription works with no internet.',
        action: { id: 'download-model', label: size ? `Download speech model (${size})` : 'Download speech model' },
      };
  }
}

function keyCheck(provider, hasKey, online) {
  if (provider.timing === 'after-recording') {
    return hasKey
      ? { state: 'ok', title: `${provider.label} key is saved`, detail: 'The transcript is made after you stop, when you ask for it.' }
      : {
          state: 'note',
          title: `No ${provider.label} key yet`,
          detail: 'You can record now. Add the key before you ask for the transcript.',
          action: { id: 'focus-key', label: 'Add key' },
        };
  }
  if (!hasKey) {
    return {
      state: 'todo',
      title: `${provider.label} needs your key`,
      detail: `Paste your ${provider.keyLabel} below, or pick another choice.`,
      action: { id: 'focus-key', label: 'Add key' },
    };
  }
  if (online === false) {
    return {
      state: 'blocked',
      title: 'This computer is offline',
      detail: `${provider.label} needs internet. Connect again, or pick "On this computer".`,
      action: { id: 'refresh', label: 'Check again' },
    };
  }
  return { state: 'ok', title: `${provider.label} key is saved` };
}

function transcriptCheck(status, transcription) {
  const provider = providerById(transcription);
  if (!provider) return { id: 'transcript', state: 'blocked', title: 'Pick how to make the transcript' };
  const body =
    provider.needs === 'model'
      ? offlineCheck(status.model)
      : keyCheck(provider, Boolean(status.keys && status.keys[provider.id]), status.online);
  return { id: 'transcript', ...body };
}

// A hidden area the page no longer has (board #16592): recording now would
// record what the user meant to hide, so Start waits for a new pick.
function hiddenCheck(lost) {
  return {
    id: 'hidden',
    state: 'todo',
    title: lost === 1 ? '1 hidden area could not be found' : `${lost} hidden areas could not be found`,
    detail: 'The page changed since you hid it. Pick the areas to hide again.',
    action: { id: 'pick-regions', label: 'Pick again' },
  };
}

/**
 * @param {import('./port.js').RecorderStatus} status
 * @param {string} transcription the selected transcript choice
 * @returns {{checks: Check[], canStart: boolean, firstBlocker: Check|null}}
 */
export function readiness(status, transcription) {
  const s = status || {};
  const checks = [tabCheck(s.tab), micCheck(s.mic), transcriptCheck(s, transcription)];
  if (s.hiddenLost > 0) checks.push(hiddenCheck(s.hiddenLost));
  const firstBlocker = checks.find((c) => c.state !== 'ok' && c.state !== 'note') || null;
  const idle = !s.phase || s.phase === 'idle' || s.phase === 'saved' || s.phase === 'failed';
  return { checks, canStart: idle && !firstBlocker, firstBlocker };
}
