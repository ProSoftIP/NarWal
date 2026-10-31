// The transcript choices and the words that explain them. Copy lives here,
// in one place, so the setup view and the strip say the same thing.
//
// `timing: 'live'` shows text while the user talks. `'after-recording'`
// produces text only when the user asks for it after Stop.
// `needs: 'model'` is the one-time speech model download; `'key'` is the
// user's own provider API key (board #16531: no NarWal server or billing).

/** @typedef {'offline'|'deepgram'|'assemblyai'|'openai'} TranscriptionId */

export const DEFAULT_TRANSCRIPTION = 'offline';

export const PROVIDERS = [
  {
    id: 'offline',
    label: 'On this computer',
    tag: 'No internet needed',
    timing: 'live',
    needs: 'model',
    explain:
      'Your voice is turned into text on this computer. The audio does not leave it.',
    setup:
      'It needs a speech model first. That is a one-time download, saved in this browser. After the download this choice works with no internet.',
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    tag: 'Your own key',
    timing: 'live',
    needs: 'key',
    keyLabel: 'Deepgram API key',
    explain:
      'While you record, your microphone audio is sent to Deepgram and the text comes back as you talk.',
    setup: 'It uses your own Deepgram key. Deepgram charges your Deepgram account for the audio.',
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    tag: 'Your own key',
    timing: 'live',
    needs: 'key',
    keyLabel: 'AssemblyAI API key',
    explain:
      'While you record, your microphone audio is sent to AssemblyAI and the text comes back as you talk.',
    setup: 'It uses your own AssemblyAI key. AssemblyAI charges your AssemblyAI account for the time connected.',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    tag: 'After recording',
    timing: 'after-recording',
    needs: 'key',
    keyLabel: 'OpenAI API key',
    explain:
      'No text appears while you record. After you stop, the narration audio is sent to OpenAI for a transcript.',
    setup: 'It uses your own OpenAI key. OpenAI charges your OpenAI account for each transcript, and again for each Try again.',
  },
];

/** The optional purpose field at Start (board #16594): it becomes manifest.purpose. */
export const PURPOSE_FIELD = Object.freeze({
  label: 'What is this recording for?',
  hint: 'Optional. It goes at the top of the exported recording, so whoever reads it knows what you want done.',
  placeholder: "Review of yesterday's dashboard changes; each thing I point at is a change request",
  maxLength: 1000,
});

// Shown under the choices, whatever is selected.
export const PRIVACY_NOTES = [
  'Only your voice goes to a provider, and only the provider you pick. What you do on the page stays on this computer.',
  'Keys are kept in this browser. They are never put in a recording or an export.',
  'NarWal never changes to another provider on its own.',
];

/** @param {string} id */
export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** @param {unknown} id @returns {TranscriptionId} */
export function normaliseTranscription(id) {
  return providerById(/** @type {string} */ (id)) ? /** @type {TranscriptionId} */ (id) : DEFAULT_TRANSCRIPTION;
}

/** 45_600_000 -> "about 46 MB", 1_900_000_000 -> "about 1.9 GB". Empty when the size is not known yet. */
export function formatDownloadSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / 1_000_000;
  if (mb < 1) return 'less than 1 MB';
  // The WebGPU models are over a gigabyte (board #16603).
  if (mb >= 1000) return `about ${(mb / 1000).toFixed(1)} GB`;
  return `about ${mb >= 100 ? Math.round(mb / 10) * 10 : Math.round(mb)} MB`;
}
