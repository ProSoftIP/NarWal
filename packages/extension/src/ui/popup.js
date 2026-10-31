// Toolbar popup: the NarWal start view (@narwal/recorder-ui, board #16551)
// over the service worker. Readiness of this tab, the microphone, the
// network, the offline speech model and saved keys is read here; the view
// decides what to show.
import { mountStartView } from '../../../recorder-ui/src/start-view.js';
import { createPrefs } from '../../../recorder-ui/src/prefs.js';
import { buildLine } from '../shared/build-info.js';
import { recordableUrl } from '../shared/protocol.js';
import { TRANSCRIPTION_IDS } from '../shared/ui-status.js';
import { readModel } from './model-state.js';
import { bytesText, recordingsBytes } from '../store/usage.js';
import { createExtensionPort } from './recorder-port.js';
import { microphoneState, toWorker } from './sw.js';

let tab = null;
let tabId;

async function micState() {
  const state = await microphoneState();
  if (state !== 'granted') return state;
  // Allowed, but is there a microphone? Device names are not needed.
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => null);
  return devices && !devices.some((d) => d.kind === 'audioinput') ? 'unavailable' : 'granted';
}

async function readContext() {
  const recordable = recordableUrl(tab && tab.url);
  const [mic, keys, model, hidden] = await Promise.all([
    micState(),
    toWorker('keys').then((r) => (r && r.ok ? r.keys : {})),
    readModel(),
    // Only the areas the page still has count; a lost one blocks Start (board #16592).
    recordable.ok ? toWorker('hidden-regions', { tabId }).then((r) => (r && r.ok ? r : { count: 0, lost: 0 })) : { count: 0, lost: 0 },
  ]);
  return {
    tab: recordable.ok ? { ok: true, title: tab.title || '' } : { ok: false, reason: recordable.reason },
    mic,
    online: navigator.onLine,
    keys,
    model,
    hidden: hidden.count,
    hiddenLost: hidden.lost,
  };
}

async function requestMic() {
  // Chrome shows the microphone prompt only on a visible extension page. A
  // blocked microphone is changed in NarWal's site settings.
  const url =
    (await microphoneState()) === 'denied'
      ? `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`
      : chrome.runtime.getURL(`permission.html?tab=${tabId}`);
  await chrome.tabs.create({ url });
  window.close();
}

const fromTab = (lead = '&') => (tabId === undefined ? '' : `${lead}from=${tabId}`);

async function downloadModel() {
  // A visible page keeps the download running after this popup closes.
  // ?from: the picker's Back and Use this model return to this tab (board #16623).
  await chrome.tabs.create({ url: chrome.runtime.getURL(`model.html?download=1${fromTab()}`) });
  window.close();
}

async function chooseModel() {
  // The picker (board #16611) downloads nothing until a click there.
  await chrome.tabs.create({ url: chrome.runtime.getURL(`model.html${fromTab('?')}`) });
  window.close();
}

async function pickRegions() {
  // The picker runs in the page: the popup gets out of the way.
  const reply = await toWorker('pick-regions', { tabId });
  if (!reply || reply.ok === false) throw new Error((reply && (reply.message || reply.error)) || 'the recorder did not answer');
  window.close();
}

async function activeTab() {
  // The e2e run opens this page in a tab of its own and names the tab it is for.
  const named = typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST && Number(new URLSearchParams(location.search).get('tab'));
  if (named) return chrome.tabs.get(named);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function main() {
  document.getElementById('build').textContent = buildLine(
    chrome.runtime.getManifest().version,
    typeof NARWAL_BUILD !== 'undefined' ? NARWAL_BUILD : null,
  );
  tab = await activeTab();
  tabId = tab ? tab.id : undefined;
  const port = createExtensionPort({ send: toWorker, tabId, readContext, pollWhenIdle: true, requestMic, downloadModel, pickRegions, chooseModel });
  const view = mountStartView({
    root: document.getElementById('root'),
    port,
    prefs: createPrefs(chrome.storage.local),
    choices: TRANSCRIPTION_IDS,
    onStarted: () => window.close(),
    // The picker and test bar under Start (board #16785).
    microphone: { onFix: () => requestMic() },
    // Saved recordings at the top, beside the name (board #17006).
    library: { href: 'recordings.html', id: 'library' },
  });
  addEventListener('online', () => port.refresh());
  addEventListener('offline', () => port.refresh());
  globalThis.narwalPopup = { port, view };
  showStorageUsed();
}

/** How much space the recordings take, on the bottom line (board #17003, #17006). */
async function showStorageUsed() {
  const bytes = await recordingsBytes().catch(() => null);
  if (bytes === null) return;
  document.getElementById('storage-used').textContent = ` (${bytesText(bytes)})`;
  document.getElementById('storage-line').hidden = false;
}

main();
