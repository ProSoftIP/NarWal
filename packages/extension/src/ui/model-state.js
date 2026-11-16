// The offline speech models' state for the start view. The files are in the
// Cache API (packages/offline-transcription, board #16544); a download runs
// on model.html and reports its progress in storage.session, because the
// popup that asked for it closes.
//
// Which models: the model chosen in the picker (board #16611), with a live
// model when it makes no live text itself; with no choice, the one model a
// first start downloads on this computer (#36101: Parakeet, which makes the
// live text and the text after Stop). Never the whole chain.
import { ModelStore, cacheBlobStore } from '../../../offline-transcription/src/model-store.ts';
import { downloadTarget, modelsToDownload, pickerRows, shownModel } from '../../../offline-transcription/src/picker.ts';
import { uiOfflineModel } from '../../../offline-transcription/src/status.ts';
import { LIVE_CHAIN, detectFinalTier, readyLiveModel } from '../../../offline-transcription/src/tier.ts';
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

/** The ones of the live models and the choice's target that are stored on this computer. */
async function installedFor(choice, machine) {
  const ids = [...new Set([...LIVE_CHAIN, downloadTarget(choice, machine)])];
  return (await modelStore().statusAll(ids)).filter((status) => status.state === 'ready').map((status) => status.id);
}

/** The models the start view checks and its download installs for the stored choice (#36101). */
export async function modelsForThisComputer() {
  const [choice, machine] = await Promise.all([storedChoice(), thisComputerTier()]);
  return modelsToDownload(choice, machine, await installedFor(choice, machine));
}

let lastStored = null;
let lastKey = '';
let lastReadAt = 0;

export async function readModel() {
  const [{ [DOWNLOAD_KEY]: report }, choice, machine] = await Promise.all([chrome.storage.session.get(DOWNLOAD_KEY), storedChoice(), thisComputerTier()]);
  // Reading the files is not free: on every poll only while a download runs,
  // or when the choice changed.
  const downloading = report && report.state === 'downloading';
  const key = `${choice ?? ''}|${machine}`;
  if (!lastStored || downloading || key !== lastKey || Date.now() - lastReadAt > 10_000) {
    const ids = modelsToDownload(choice, machine, await installedFor(choice, machine));
    // Start needs one live model, Parakeet or Vosk (#16617); the live model is first
    // in the list (with no choice it is Parakeet alone, which also makes the text
    // after Stop, #36101). The rest improve the text after Stop; one that is missing
    // is passed over (#16603). The live model picked: no final model (#16611).
    // The sizes stay those of the whole set: the model page fetches each one missing.
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
