// @narwal/recorder-ui: the start surface and the recording strip.
// README.md describes the port the extension must supply.
export { mountStartView } from './start-view.js';
export { mountStrip } from './strip.js';
export { mountMicPanel, microphoneChoices, MIC_TEXT } from './mic-panel.js';
export { measureLevel, meterValue, createSilenceWatch, HEARD_RMS, HEARD_LEVEL, TEST_QUIET_MS, RECORDING_QUIET_MS } from './mic-level.js';
export { narwalLogo } from './logo.js';
export { createPrefs, memoryStorageArea, PREFS_KEY, DEFAULT_PREFS } from './prefs.js';
export { createFakePort, IDLE_STATUS } from './port.js';
export { readiness } from './readiness.js';
export { stripModel } from './strip-model.js';
export { startFlow } from './flow.js';
export { createTranscript, formatClock } from './transcript.js';
export { PROVIDERS, PRIVACY_NOTES, PURPOSE_FIELD, DEFAULT_TRANSCRIPTION, providerById } from './providers.js';
export { INSTRUCTION_STEPS, MIN_BOX_DRAG_PX, MARK_SHORTCUT } from './gestures.js';
export {
  UI_ATTR,
  UI_CLASS,
  UI_SELECTOR,
  markNarwalUi,
  RRWEB_RECORD_OPTIONS,
  isNarwalUiNode,
  isNarwalUiEvent,
  createCaptureFilter,
} from './capture-exclusion.js';
