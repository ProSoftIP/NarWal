// NarWal capture probe — service worker (board #16538).
// Starts/stops a recording of one tab, registers the document_start content
// script, and forwards webNavigation evidence to the offscreen document. It
// keeps no capture state in memory: the recorded tab lives in
// chrome.storage.session so a restarted worker still filters correctly.
const now = () => performance.timeOrigin + performance.now();
const SCRIPT_ID = 'narwal-probe';
// Changes every time the worker starts, so a restart is visible in the log.
const WORKER_BOOT = crypto.randomUUID();

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record microphone narration and receive page evidence for the recorded tab.',
  });
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function start(tabId, options = {}) {
  await ensureOffscreen();
  await chrome.storage.session.set({ recordingTabId: tabId });
  const reply = await toOffscreen({ cmd: 'start', tabId, options });
  if (!reply || !reply.ok) return reply;
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ['dist/content.js'],
      matches: ['<all_urls>'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    },
  ]);
  // Documents that were already open when recording started.
  const injected = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['dist/content.js'] })
    .then((r) => ({ ok: true, frames: r.length }))
    .catch((err) => ({ ok: false, error: err.message }));
  await forward({ type: 'start-inject', tabId, injected, at: now() });
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  await forward({ type: 'frames', tabId, frames, at: now() });
  return { ...reply, injected };
}

async function stop() {
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.storage.session.remove('recordingTabId');
  const reply = await toOffscreen({ cmd: 'stop' });
  return reply;
}

async function dump() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) return { ok: false, error: 'no offscreen document' };
  return toOffscreen({ cmd: 'dump' });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
  return { ok: true };
}

async function recordedTab() {
  const { recordingTabId } = await chrome.storage.session.get('recordingTabId');
  return recordingTabId ?? null;
}

async function forward(event) {
  try {
    await toOffscreen({ cmd: 'nav', event: { ...event, workerBoot: WORKER_BOOT } });
  } catch (err) {
    // Offscreen document gone; nothing to record into.
  }
}

function navListener(type) {
  return async (details) => {
    const tabId = await recordedTab();
    if (tabId === null || details.tabId !== tabId) return;
    await forward({
      type,
      at: now(),
      tabId: details.tabId,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      url: details.url,
      documentId: details.documentId || null,
      parentDocumentId: details.parentDocumentId || null,
      documentLifecycle: details.documentLifecycle || null,
      frameType: details.frameType || null,
      transitionType: details.transitionType || null,
      transitionQualifiers: details.transitionQualifiers || null,
      timeStamp: details.timeStamp,
      error: details.error || null,
    });
  };
}

chrome.webNavigation.onBeforeNavigate.addListener(navListener('beforeNavigate'));
chrome.webNavigation.onCommitted.addListener(navListener('committed'));
chrome.webNavigation.onDOMContentLoaded.addListener(navListener('domContentLoaded'));
chrome.webNavigation.onCompleted.addListener(navListener('completed'));
chrome.webNavigation.onHistoryStateUpdated.addListener(navListener('historyStateUpdated'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(navListener('referenceFragmentUpdated'));
chrome.webNavigation.onErrorOccurred.addListener(navListener('errorOccurred'));
chrome.webNavigation.onTabReplaced.addListener(async (details) => {
  const tabId = await recordedTab();
  if (tabId !== null && details.replacedTabId === tabId) {
    await chrome.storage.session.set({ recordingTabId: details.tabId });
    await forward({ type: 'tabReplaced', at: now(), ...details });
  }
});
chrome.tabs.onActivated.addListener(async (info) => {
  const tabId = await recordedTab();
  if (tabId === null) return;
  await forward({ type: 'tabActivated', at: now(), activeTabId: info.tabId, recordedTabActive: info.tabId === tabId });
});
chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const tabId = await recordedTab();
  if (tabId !== null && removedTabId === tabId) await forward({ type: 'tabRemoved', at: now(), tabId });
});

// Manual mode: the toolbar button toggles recording of the clicked tab.
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = await recordedTab();
  if (tabId === null) {
    const reply = await start(tab.id, { recordAfter: 'DOMContentLoaded' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: reply && reply.ok ? 'REC' : 'ERR' });
    if (!reply || !reply.ok || (reply.audio && reply.audio.error)) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
    }
    return;
  }
  await stop();
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
});

// Harness entry points (Playwright evaluates these in the worker).
globalThis.narwalProbe = { start, stop, dump, closeOffscreen, recordedTab };
