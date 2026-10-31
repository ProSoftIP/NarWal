// The choices this UI remembers: skip the instructions, which transcript
// choice was last picked, and the speech model for the "On this computer"
// choice (board #16611; null: the computer's own pick), and the microphone
// to record with (board #16785; null: the browser's default). Stored under one key in the storage
// area it is given (chrome.storage.local in the extension). Other code keeps
// its own fields in the same object (deepgramAuth, board #16545): update()
// keeps every field it does not own. No key material is ever stored here:
// provider keys belong to the transcription key store.

import { DEFAULT_TRANSCRIPTION, normaliseTranscription } from './providers.js';

export const PREFS_KEY = 'narwal.prefs.v1';

export const DEFAULT_PREFS = Object.freeze({ skipInstructions: false, transcription: DEFAULT_TRANSCRIPTION, offlineModel: null, microphone: null });

/** {id, label} of a chosen audio input, or null. The label names it when it is not connected. */
function cleanMicrophone(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null;
  return { id: value.id, label: typeof value.label === 'string' ? value.label.slice(0, 200) : '' };
}

function clean(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...value,
    skipInstructions: value.skipInstructions === true,
    transcription: normaliseTranscription(value.transcription),
    // A model id; the extension checks it against its model list.
    offlineModel: typeof value.offlineModel === 'string' && value.offlineModel ? value.offlineModel : null,
    microphone: cleanMicrophone(value.microphone),
  };
}

/**
 * @param {{get:(key:string)=>Promise<Record<string,unknown>>, set:(items:Record<string,unknown>)=>Promise<void>}} area
 *   chrome.storage.local, or memoryStorageArea() in tests
 */
export function createPrefs(area) {
  return {
    async get() {
      const stored = await area.get(PREFS_KEY);
      return clean(stored && stored[PREFS_KEY]);
    },
    /** @param {Partial<typeof DEFAULT_PREFS>} patch */
    async update(patch) {
      const next = clean({ ...(await this.get()), ...patch });
      await area.set({ [PREFS_KEY]: next });
      return next;
    },
  };
}

/** A storage area with the chrome.storage.local promise shape. */
export function memoryStorageArea(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
  };
}
