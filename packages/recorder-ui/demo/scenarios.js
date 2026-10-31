// Named recorder states for the demo pages and the e2e run. Each one is a
// fake port's first status, the stored choices, and (for the strip) the
// transcript events to replay.

const MODEL_BYTES = 43_500_000; // Vosk small English, measured in board #16539
const READY = { tab: { ok: true, title: 'Dashboard · Acme Payroll' }, mic: 'granted', online: true, model: { state: 'ready', bytesTotal: MODEL_BYTES }, keys: {} };

const WORDS = [
  ['s1', 'final', 2100, 6400, 'So this is the payroll dashboard, and the first thing I notice is the revenue card.'],
  ['s2', 'final', 7000, 11800, 'This should collapse when I click the heading, but nothing happens.'],
  ['s3', 'final', 12500, 17900, 'Down here the table scrolls sideways, which hides the totals column.'],
  ['s4', 'interim', 18400, 20900, 'and I would expect this button to'],
];
const SEGMENTS = WORDS.map(([segmentKey, kind, startMs, endMs, text]) => ({ type: 'segment', segment: { segmentKey, kind, startMs, endMs, text } }));
const GAP = { type: 'gap', gap: { startMs: 21000, endMs: 34000, reason: 'disconnected' } };

const recording = (extra = {}) => ({ ...READY, phase: 'recording', transcription: 'offline', elapsedMs: 134_000, micLive: true, transcript: { state: 'live' }, ...extra });

export const START_SCENARIOS = {
  'first-use': { status: { ...READY, phase: 'idle' } },
  skipped: { status: { ...READY, phase: 'idle' }, prefs: { skipInstructions: true } },
  'mic-prompt': { status: { ...READY, phase: 'idle', mic: 'prompt' } },
  'mic-denied': { status: { ...READY, phase: 'idle', mic: 'denied' }, behaviour: { micResult: 'denied' } },
  'model-missing': { status: { ...READY, phase: 'idle', model: { state: 'missing', bytesTotal: MODEL_BYTES } } },
  'model-downloading': { status: { ...READY, phase: 'idle', model: { state: 'downloading', bytesDone: 18_700_000, bytesTotal: MODEL_BYTES } } },
  'model-failed': { status: { ...READY, phase: 'idle', model: { state: 'failed', bytesTotal: MODEL_BYTES, error: 'The download stopped at 43%. Check your internet connection, then try again.' } } },
  // The model picker's choice (board #16611): name and measured bars in the offline choice.
  'model-chosen': {
    status: { ...READY, phase: 'idle', model: { state: 'ready', bytesTotal: 297_000_000, choice: { id: 'whisper-small.en-q8', name: 'Whisper small.en', accuracySteps: 4, speedSteps: 3, recommended: false } } },
  },
  'key-missing': { status: { ...READY, phase: 'idle' }, prefs: { transcription: 'deepgram' } },
  'key-saved': { status: { ...READY, phase: 'idle', keys: { deepgram: true } }, prefs: { transcription: 'deepgram' } },
  'provider-offline': { status: { ...READY, phase: 'idle', online: false, keys: { assemblyai: true } }, prefs: { transcription: 'assemblyai' } },
  'openai-no-key': { status: { ...READY, phase: 'idle' }, prefs: { transcription: 'openai' } },
  'restricted-tab': { status: { ...READY, phase: 'idle', tab: { ok: false, reason: 'Browser and extension pages cannot be recorded. Open a website first.' } } },
  'hidden-lost': { status: { ...READY, phase: 'idle', hidden: 1, hiddenLost: 1 }, prefs: { skipInstructions: true } },
  recording: { status: recording() },
  saved: { status: { ...READY, phase: 'saved', transcription: 'offline', elapsedMs: 134_000, recordingId: 'rec-demo-1' } },
  // Export waits for the OpenAI transcript (board #16602, #16588).
  'saved-openai-uploading': {
    status: { ...READY, phase: 'saved', transcription: 'openai', elapsedMs: 134_000, recordingId: 'rec-demo-1', afterTranscript: { state: 'uploading', done: 0, total: 1 } },
  },
};

export const STRIP_SCENARIOS = {
  recording: { status: recording(), events: SEGMENTS },
  listening: { status: recording({ elapsedMs: 1200 }) },
  connecting: { status: recording({ transcription: 'deepgram', elapsedMs: 800, transcript: { state: 'connecting' } }) },
  reconnecting: { status: recording({ transcription: 'deepgram', transcript: { state: 'reconnecting' } }), events: SEGMENTS },
  disconnected: {
    status: recording({ transcription: 'deepgram', transcript: { state: 'disconnected', detail: 'Deepgram closed the connection' } }),
    events: [...SEGMENTS.slice(0, 3), GAP],
  },
  behind: { status: recording({ transcript: { state: 'behind' } }), events: SEGMENTS },
  'after-recording': { status: recording({ transcription: 'openai', transcript: { state: 'after-recording' } }) },
  'mic-lost': { status: recording({ micLive: false }), events: SEGMENTS },
  stopping: { status: recording({ phase: 'stopping' }), events: SEGMENTS },
  saved: { status: recording({ phase: 'saved', recordingId: 'rec-demo-1' }), events: SEGMENTS },
  failed: { status: recording({ phase: 'failed', recordingId: 'rec-demo-1', error: 'this browser is out of storage space' }) },
  // OpenAI makes the transcript after Stop (board #16588).
  'openai-uploading': { status: recording({ phase: 'saved', transcription: 'openai', recordingId: 'rec-demo-1', afterTranscript: { state: 'uploading', done: 0, total: 1 } }) },
  'openai-ready': { status: recording({ phase: 'saved', transcription: 'openai', recordingId: 'rec-demo-1', afterTranscript: { state: 'done', activated: true } }) },
  'openai-failed': { status: recording({ phase: 'saved', transcription: 'openai', recordingId: 'rec-demo-1', afterTranscript: { state: 'failed', detail: 'there is no connection to OpenAI' } }) },
  idle: { status: { ...READY, phase: 'idle' } },
};
