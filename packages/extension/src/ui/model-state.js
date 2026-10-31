// The offline speech models' state for the start view. The files are in the
// Cache API (packages/offline-transcription, board #16544); a download runs
// on model.html and reports its progress in storage.session, because the
// popup that asked for it closes.
//
// Which models: the live model and the model chosen in the picker (board
// #16611), or with no choice the final-pass chain of this computer's tier
// (board #16603).
import { ModelStore, cacheBlobStore } from '../../../offline-transcription/src/model-store.ts';
import { modelsToDownload, pickerRows, shownModel } from '../../../offline-transcription/src/picker.ts';
import { uiOfflineModel } from '../../../offline-transcription/src/status.ts';
import { detectFinalTier, readyLiveModel } from '../../../offline-transcription/src/tier.ts';
import { createPrefs } from '../../../recorder-ui/src/prefs.js';
import { DOWNLOAD_KEY, combineModelState, toViewModel } from '../shared/model-view.js';

export { DOWNLOAD_HEARTBEAT_MS, DOWNLOAD_KEY } from '../shared/model-view.js';

let store = null;
export function modelStore() {
  if (!store) store = new ModelStore({ blobs: cacheBlobStore() });
  return store;
}

// Asked once per page; the GPU does not change under it.
let tier = null;
export function thisComputerTier() {
  if (!tier) tier = detectFinalTier();
  return tier;
}

export const prefs = () => createPrefs(chrome.storage.local);

/** The picker's choice as stored (a model id or null). */
export async function storedChoice() {
  return (await prefs().get()).offlineModel;
}

/** The models the download installs for the stored choice. */
export async function modelsForThisComputer() {
  return modelsToDownload(await storedChoice(), await thisComputerTier());
}

let lastStored = null;
let lastKey = '';
let lastReadAt = 0;

export async function readModel() {
  const [{ [DOWNLOAD_KEY]: report }, choice, machine] = await Promise.all([chrome.storage.session.get(DOWNLOAD_KEY), storedChoice(), thisComputerTier()]);
  const ids = modelsToDownload(choice, machine);
  // Reading the files is not free: on every poll only while a download runs,
  // or when the choice changed.
  const downloading = report && report.state === 'downloading';
  const key = ids.join(',');
  if (!lastStored || downloading || key !== lastKey || Date.now() - lastReadAt > 10_000) {
    // Start needs one live model, Parakeet or Vosk (#16617); Vosk is first in the list,
    // so Start works once its 41 MB are stored. The rest improve the text, live and
    // after Stop; one that is missing is passed over (#16603). The live model picked:
    // no final model (#16611).
    // The sizes stay those of the whole download: the model page fetches every model.
    const statuses = await modelStore().statusAll(ids);
    const [first, ...rest] = statuses;
    const live = readyLiveModel(statuses) || first;
    const all = uiOfflineModel(statuses);
    lastStored = { ...uiOfflineModel([live]), bytesDone: all.bytesDone, bytesTotal: all.bytesTotal, ...(rest.length ? { final: uiOfflineModel(rest) } : {}) };
    lastKey = key;
    lastReadAt = Date.now();
  }
  const shown = shownModel(choice, machine);
  const row = pickerRows(machine).find((r) => r.id === shown) || null;
  return toViewModel(combineModelState(lastStored, report || null, Date.now()), row);
}
