// NarWal service worker. Starts and stops recordings, registers the
// document_start content script, forwards webNavigation evidence, and brings
// the offscreen recorder back if it dies mid-recording. It holds no capture
// state in memory: the live recording is in chrome.storage.session, so a
// restarted worker carries on (board #16538: stopping the worker lost nothing).
import { now } from '../shared/clock.js';
import { cleanAreas, lostText, pageKey } from '../shared/hidden-regions.js';
import { MARK_FOCUSED, SCRIPT_ID, WATCHDOG_ALARM, recordableUrl } from '../shared/protocol.js';
import { checkPurpose } from '../shared/purpose.js';
import { createPrefs } from '../../../recorder-ui/src/prefs.js';
import { KEY_PROVIDERS, TRANSCRIPTION_IDS, afterTranscriptNext } from '../shared/ui-status.js';
import * as store from '../store/db.js';
import { ProviderKeyStore } from '../../../transcription/src/key-store.ts';
import { createSerial } from './serial.js';
import { BUILD_ALARM, BUILD_CHECK_MINUTES, HELD_KEY, RELOAD_KEY, RESTORE_KEY, createSelfUpdate, heldEntry, reloadBlocker, restoreTabs, tabsToRestore } from './self-update.js';
import { PAGE_IN_USE_LOCK } from '../shared/page-use.js';

const WORKER_BOOT = crypto.randomUUID();
// Refuse to start below this much free space: a recording needs about
// 16 KB/s of audio plus page evidence.
const MIN_FREE_BYTES = 200 * 1024 * 1024;
// Start, stop, recorder repair and tab replacement read and change the live
// recording, so they run one at a time. Without this a second stop (two
// recorder failures, Stop as the tab closes) closed the recorder during the
// first stop's final save, and a second start killed the first (board #16568).
const serial = createSerial();
// Personal provider keys (board #16545 key store). Only this worker reads a
// key; storage.local is closed to content scripts before any key is saved.
const keys = new ProviderKeyStore(chrome.storage.local);
const keysRestricted = keys.restrictToTrustedContexts();

// Choices with a transcript job after Stop.
const AFTER_STOP_CHOICES = new Set(['openai', 'offline']);

async function liveRecording() {
  const { recording } = await chrome.storage.session.get('recording');
  return recording || null;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record microphone narration and save page evidence for the recorded tab.',
    });
  } catch (err) {
    // Another caller created it between the check and here.
    if (!(await hasOffscreen())) throw err;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

// Transcript jobs after Stop running in the recorder: OpenAI's (board #16588)
// and the improved transcript on this computer (board #16603).
const afterJobsOf = (st) => (st && (st.afterJobs || st.openaiJobs)) || [];

// Closes the recorder unless it records or makes a transcript after Stop.
async function closeIfIdle() {
  const st = await offscreenStatus();
  if (st && (st.recording || afterJobsOf(st).length)) return;
  await closeOffscreen();
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// The saved microphone choice (board #16785); null: the browser's default.
const microphoneId = (prefs) => (prefs && prefs.microphone && prefs.microphone.id) || null;

// The strip's level meter (board #16785): the live recording's microphone level, never audio.
async function micLevel() {
  const live = await liveRecording();
  if (!live || !(await hasOffscreen())) return { ok: true, level: null };
  return (await toOffscreen({ cmd: 'mic-level' }).catch(() => null)) || { ok: true, level: null };
}

async function offscreenStatus() {
  if (!(await hasOffscreen())) return null;
  return toOffscreen({ cmd: 'status' }).catch(() => null);
}

async function registerScript() {
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ['dist/content.js'],
      matches: ['<all_urls>'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      // A browser restart never resumes injection.
      persistAcrossSessions: false,
    },
  ]);
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

// Every worker boot: a recording still marked 'recording' that is not the
// live one lost its recorder (browser closed or crashed, extension reloaded).
// Mark it interrupted and keep every saved chunk. If the live recording has no
// recorder, bring one back; the gap is labelled by the recorder.
const ready = (async () => {
  const live = await liveRecording();
  const db = await store.openDb();
  const recorderUp = await hasOffscreen();
  for (const meta of await store.listRecordings(db)) {
    if (meta.status === 'recording' && (!live || live.id !== meta.id)) await markInterrupted(db, meta);
    // An OpenAI upload ends with its recorder; with no recorder it was cut off.
    if (!recorderUp && meta.afterTranscript && meta.afterTranscript.state === 'uploading') await markUploadInterrupted(db, meta.id);
  }
  // A stop that never finished (the worker stopped mid-stop): the loop above
  // marked its recording interrupted; report it as ended.
  const { stopping } = await chrome.storage.session.get('stopping');
  if (stopping && !live) await finishStopping(stopping, 'interrupted', null);
  if (live && !(await hasOffscreen())) await resume(live, 'worker-boot');
  // The improved transcript on this computer goes on from its checkpoint.
  await resumeImproving(await store.listRecordings(db));
})().catch((err) => console.error('NarWal: boot recovery failed', err));

async function markInterrupted(db, meta) {
  const last = await store.lastPersistedAt(db, meta.id);
  await store.updateRecording(db, meta.id, {
    status: 'interrupted',
    stoppedAt: last ?? meta.startedAt,
    stopReason: 'interrupted',
    interruption: { lastSavedAt: last, detectedAt: now() },
  });
}

async function markUploadInterrupted(db, id) {
  const meta = await store.getRecording(db, id);
  const job = meta && meta.afterTranscript;
  if (!job || (job.state !== 'uploading' && job.state !== 'improving')) return meta;
  const message = job.state === 'improving' ? 'the browser stopped the transcript before it finished' : 'the browser closed the upload before it finished';
  return store.updateRecording(db, id, {
    afterTranscript: { state: 'failed', jobId: job.jobId, ...(job.provider ? { provider: job.provider } : {}), at: now(), error: { kind: 'interrupted', code: 'interrupted', message, retryable: true } },
  });
}

/**
 * Improved transcripts on this computer (board #16603) that no recorder is
 * running: the recorder goes on from each checkpoint. One the recorder will
 * not resume (no checkpoint, resumed too often) is marked cut off.
 */
async function resumeImproving(metas) {
  const ids = metas.filter((m) => m && m.afterTranscript && m.afterTranscript.state === 'improving').map((m) => m.id);
  if (!ids.length) return [];
  const st = await offscreenStatus();
  const cutOff = ids.filter((id) => !afterJobsOf(st).includes(id));
  if (!cutOff.length) return [];
  await ensureOffscreen();
  const reply = await toOffscreen({ cmd: 'after-resume', recordingIds: cutOff }).catch(() => null);
  const started = (reply && reply.ok && reply.started) || [];
  const db = await openDb();
  for (const id of cutOff) if (!started.includes(id)) await markUploadInterrupted(db, id);
  if (!started.length && !(await liveRecording())) await closeIfIdle();
  return started;
}

async function resume(live, why) {
  await ensureOffscreen();
  const microphone = microphoneId(await createPrefs(chrome.storage.local).get().catch(() => ({})));
  const reply = await toOffscreen({ cmd: 'start', resume: why, recordingId: live.id, tabId: live.tabId, followed: followedTabs(live), microphoneId: microphone });
  if (reply && reply.ok) await registerScript();
  return reply;
}

// The recorder must exist and be recording whenever a recording is live.
const checkRecorder = (why) => serial(() => repairRecorder(why));

async function repairRecorder(why) {
  await ready;
  const live = await liveRecording();
  if (!live) return;
  const st = await offscreenStatus();
  if (st && st.recording && st.id === live.id) return;
  if (st && st.state === 'stopped') return; // A failure stop is in progress.
  if (!st) await closeOffscreen();
  await resume(live, why);
}

const start = (tabId, transcription, purpose) => serial(() => startNow(tabId, transcription, purpose));

// ---- areas hidden before recording (board #16592) ----------------------
// chrome.storage.session `hidden`: {[tabId]: {page, areas}}, written by the
// picker in the tab's top frame (src/content/picker.js). An area counts only
// while the page still has it (src/shared/hidden-regions.js resolveAreas):
// the popup counts those, and Start refuses while one is lost.

async function hiddenFor(tabId, url) {
  const { hidden } = await chrome.storage.session.get('hidden');
  const entry = hidden && hidden[tabId];
  return entry && entry.page === pageKey(url) && Array.isArray(entry.areas) && entry.areas.length ? entry : null;
}

// Picker reports arrive close together: one read-and-write at a time, in order.
const hiddenWrites = createSerial();
function setHidden(tabId, entry) {
  return hiddenWrites(async () => {
    const { hidden = {} } = await chrome.storage.session.get('hidden');
    if (entry) hidden[tabId] = entry;
    else delete hidden[tabId];
    await chrome.storage.session.set({ hidden });
  });
}

// Runs `__narwalPicker[name](arg)` in the tab's top frame, injecting the
// script the first time (it does nothing until called). Null when it cannot run.
async function inPicker(tabId, name, arg) {
  const target = { tabId, frameIds: [0] };
  const call = async () => {
    const [result] = await chrome.scripting.executeScript({
      target,
      func: (n, a) => (globalThis.__narwalPicker ? { value: globalThis.__narwalPicker[n](a) } : null),
      args: [name, arg],
    });
    return result ? result.result : null;
  };
  try {
    let reply = await call();
    if (!reply) {
      await chrome.scripting.executeScript({ target, files: ['dist/picker.js'] });
      reply = await call();
    }
    return reply ? reply.value : null;
  } catch {
    return null;
  }
}

async function pickRegions(tabId) {
  await ready;
  if (await liveRecording()) return { ok: false, error: 'already-recording', message: 'Hide areas before you start the recording.' };
  const tab = await chrome.tabs.get(tabId);
  const recordable = recordableUrl(tab.url);
  if (!recordable.ok) return { ok: false, error: 'not-recordable', message: recordable.reason };
  const earlier = await hiddenFor(tabId, tab.url);
  if ((await inPicker(tabId, 'open', earlier ? earlier.areas : [])) === null) {
    return { ok: false, error: 'picker-failed', message: 'The page did not let NarWal open the area picker. Reload the page and try again.' };
  }
  // The page needs the pointer and the keyboard: show it.
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  return { ok: true };
}

// The picker's report. Only the top frame of a tab sets that tab's areas.
async function regionsPicked(msg, sender) {
  const areas = cleanAreas(msg.areas);
  const page = pageKey(sender.url);
  if (!areas || !page || msg.page !== page) return { ok: false, error: 'bad-regions' };
  await setHidden(sender.tab.id, areas.length ? { page, areas } : null);
  return { ok: true, count: areas.length };
}

// What the page still has of the tab's areas: {found, lost}. A page that
// cannot be checked has lost them all (never counted as hidden).
async function checkHidden(tabId, entry) {
  const result = await inPicker(tabId, 'check', entry.areas);
  return result && Number.isFinite(result.found) && Number.isFinite(result.lost) ? result : { found: 0, lost: entry.areas.length };
}

async function hiddenCount(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const entry = tab ? await hiddenFor(tabId, tab.url) : null;
  if (!entry) return { ok: true, count: 0, lost: 0 };
  const { found, lost } = await checkHidden(tabId, entry);
  return { ok: true, count: found, lost };
}

// Start ends a picker still open in the tab; its last selection counts.
async function finishPicker(tabId) {
  const result = await chrome.scripting
    .executeScript({ target: { tabId, frameIds: [0] }, func: () => (globalThis.__narwalPicker ? globalThis.__narwalPicker.finish() : null) })
    .catch(() => null);
  return result && result[0] ? result[0].result : null;
}

// The offscreen recorder asks for the frame that holds a child frame: a
// child inside a hidden area of its parent is not recorded.
async function frameParent(tabId, frameId) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId }).catch(() => null);
  return frame && Number.isInteger(frame.parentFrameId) ? { ok: true, parentFrameId: frame.parentFrameId } : { ok: false };
}
const stop = (reason, error) => serial(() => stopNow(reason, error));

async function startNow(tabId, transcription = 'offline', purposeText = '') {
  await ready;
  if (!TRANSCRIPTION_IDS.includes(transcription)) return { ok: false, error: 'bad-transcription', message: 'Pick how to make the transcript.' };
  const purpose = checkPurpose(purposeText);
  if (!purpose.ok) return { ok: false, error: 'bad-purpose', message: purpose.message };
  if (await liveRecording()) return { ok: false, error: 'already-recording', message: 'A recording is already running.' };
  const tab = await chrome.tabs.get(tabId);
  const recordable = recordableUrl(tab.url);
  if (!recordable.ok) return { ok: false, error: 'not-recordable', message: recordable.reason };
  const estimate = await navigator.storage.estimate().catch(() => null);
  if (estimate && estimate.quota - estimate.usage < MIN_FREE_BYTES) {
    return { ok: false, error: 'storage-low', message: 'There is not enough free disk space to record. Free some space and try again.' };
  }
  const picked = cleanAreas(await finishPicker(tabId));
  if (picked) await setHidden(tabId, picked.length ? { page: pageKey(tab.url), areas: picked } : null);
  const hidden = await hiddenFor(tabId, tab.url);
  if (hidden) {
    // Never fail open: an area the page no longer has is not hidden.
    const { lost } = await checkHidden(tabId, hidden);
    if (lost) return { ok: false, error: 'hidden-areas-lost', lost, message: lostText(lost) };
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ recording: { id, tabId, startedAt: now(), transcription }, lastResult: null });
  let reply;
  try {
    await ensureOffscreen();
    // The speech model picked for "On this computer" (board #16611) is kept
    // with the recording, so its job after Stop runs the same model even if
    // the pick changes later.
    const prefs = await createPrefs(chrome.storage.local).get();
    const offlineModel = transcription === 'offline' ? prefs.offlineModel : null;
    reply = await toOffscreen({
      cmd: 'start',
      recordingId: id,
      tabId,
      url: tab.url,
      title: tab.title,
      transcription,
      hidden,
      purpose: purpose.purpose,
      offlineModel,
      // The microphone chosen in the popup or Options (board #16785).
      microphoneId: microphoneId(prefs),
    });
  } catch (err) {
    reply = { ok: false, error: String(err && err.message) };
  }
  if (!reply || !reply.ok) {
    await chrome.storage.session.remove('recording');
    await closeIfIdle();
    return { ok: false, error: 'recorder-failed', message: `The recorder did not start: ${reply && reply.error}` };
  }
  await registerScript();
  // Documents already open when recording started.
  const injected = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['dist/content.js'] })
    .then((r) => ({ ok: true, frames: r.length }))
    .catch((err) => ({ ok: false, error: err.message }));
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  await forward({ type: 'start-frames', tabId, injected, frames });
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  await setBadge('REC', '#c62828');
  return { ok: true, id, audio: reply.audio };
}

async function stopNow(reason = 'user', error = null) {
  await ready;
  const live = await liveRecording();
  if (!live) return { ok: false, error: 'not-recording' };
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.alarms.clear(WATCHDOG_ALARM);
  // The controls show "Saving" until lastResult is written.
  await chrome.storage.session.set({ stopping: { ...live, at: now() } });
  await chrome.storage.session.remove('recording');
  let reply = (await hasOffscreen()) ? await toOffscreen({ cmd: 'stop', reason }).catch((err) => ({ ok: false, error: err.message })) : null;
  if (!reply || !reply.ok) {
    // No recorder to finish it: keep what was saved and label the end.
    const db = await store.openDb();
    const meta = await store.getRecording(db, live.id);
    if (meta && meta.status === 'recording') await markInterrupted(db, meta);
    reply = { ok: true, id: live.id, stopReason: 'interrupted' };
  }
  // The OpenAI transcript is made in the recorder after Stop (board #16588);
  // it closes itself through recorder-idle when the job ends.
  if (!reply.keepOpen) await closeOffscreen();
  const storageError = reply.storageError || error || null;
  await finishStopping(live, reason, storageError);
  return { ok: true, id: live.id, stopReason: reason, storageError, audio: reply.audio || null };
}

async function finishStopping(live, reason, storageError) {
  const lastResult = { id: live.id, tabId: live.tabId, tabIds: recordedTabs(live), stopReason: reason, storageError, at: now(), startedAt: live.startedAt, transcription: live.transcription };
  await chrome.storage.session.set({ lastResult });
  await chrome.storage.session.remove('stopping');
  if (reason === 'storage-full' || reason === 'storage-error') await setBadge('FULL', '#b71c1c');
  else await setBadge('', null);
}

// Closes the recorder once nothing needs it: no recording, no OpenAI job.
const recorderIdle = () =>
  serial(async () => {
    if (!(await liveRecording())) await closeIfIdle();
  });

let dbOpen = null;
const openDb = () => (dbOpen = dbOpen || store.openDb());

/** The OpenAI job state of one recording (offscreen/openai-job.js), or null. */
async function afterTranscriptOf(id) {
  if (!id) return null;
  const db = await openDb();
  let meta = await store.getRecording(db, id);
  if (meta && meta.afterTranscript && meta.afterTranscript.state === 'uploading') {
    // No recorder, or a recorder that is not running this job: it was cut off.
    const st = (await hasOffscreen()) ? await offscreenStatus() : { openaiJobs: [] };
    if (st && !afterJobsOf(st).includes(id)) meta = await markUploadInterrupted(db, id);
  }
  if (meta && meta.afterTranscript && meta.afterTranscript.state === 'improving') {
    // In turn with recorderIdle, so the recorder is not closed while it resumes.
    await serial(() => resumeImproving([meta]));
    meta = await store.getRecording(db, id);
  }
  return (meta && meta.afterTranscript) || null;
}

/**
 * Starts, or starts again, the OpenAI transcript of a stopped recording. In
 * turn with recorderIdle, so the recorder is not closed while a job starts.
 */
const transcribeAfter = (id) => serial(() => transcribeAfterNow(id));

async function transcribeAfterNow(id) {
  await ready;
  const live = await liveRecording();
  if (live && live.id === id) return { ok: false, error: 'recording', message: 'stop the recording first' };
  await ensureOffscreen();
  const reply = await toOffscreen({ cmd: 'after-transcribe', recordingId: id }).catch((err) => ({ ok: false, error: String(err && err.message) }));
  if ((!reply || !reply.ok) && !live) await closeIfIdle();
  await wakeStrip(id);
  return reply || { ok: false, error: 'no-recorder' };
}

// A strip left open on the saved recording stops reading once its job ends.
// A job started elsewhere (the recordings page, the popup) tells it to read
// again, so it shows the new upload and how it ends (board #16598).
async function wakeStrip(id) {
  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (!lastResult || lastResult.id !== id || lastResult.dismissed) return;
  await chrome.tabs.sendMessage(lastResult.tabId, { to: 'strip', cmd: 'refresh' }, { frameId: 0 }).catch(() => {});
}

/**
 * The saved key, for the recorder's OpenAI job only. It goes back in this
 * reply and nowhere else: never into storage.session, a status or a log.
 */
async function openAiKey() {
  const key = await keys.getKey('openai').catch(() => null);
  const reply = { ok: true, key: key || null };
  if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST) {
    const { testOpenAiEndpoint } = await chrome.storage.session.get('testOpenAiEndpoint');
    if (testOpenAiEndpoint) reply.endpoint = testOpenAiEndpoint;
  }
  return reply;
}

async function status() {
  await ready;
  const live = await liveRecording();
  const { lastResult } = await chrome.storage.session.get('lastResult');
  return { ok: true, live, recorder: live ? await offscreenStatus() : null, lastResult: lastResult || null };
}

// What the recorder controls show (popup start view, in-page strip).
// `cursor` is the recorder's opaque transcript-event cursor (#16570), passed
// through unchanged; undefined on a view's first read.
async function uiStatus(cursor) {
  await ready;
  const live = await liveRecording();
  const { lastResult, stopping } = await chrome.storage.session.get(['lastResult', 'stopping']);
  const recorder = live && (await hasOffscreen()) ? await toOffscreen({ cmd: 'status', transcriptCursor: cursor }).catch(() => null) : null;
  const afterTranscript = !live && lastResult && AFTER_STOP_CHOICES.has(lastResult.transcription) ? await afterTranscriptOf(lastResult.id).catch(() => null) : null;
  return {
    ok: true,
    now: now(),
    live,
    stopping: stopping || null,
    recorder,
    lastResult: lastResult || null,
    afterTranscript,
    events: (recorder && Array.isArray(recorder.transcriptEvents) && recorder.transcriptEvents) || [],
    cursor: recorder && recorder.transcriptCursor != null ? recorder.transcriptCursor : cursor,
  };
}

async function keyPresence() {
  const present = {};
  for (const provider of KEY_PROVIDERS) present[provider] = await keys.hasKey(provider);
  return { ok: true, keys: present };
}

async function saveKey(provider, key) {
  if (!KEY_PROVIDERS.includes(provider)) return { ok: false, error: 'bad-provider' };
  if (!(await keysRestricted)) {
    return { ok: false, error: 'key-storage-open', message: 'this browser cannot keep the key away from web pages, so it was not saved' };
  }
  try {
    await keys.setKey(provider, String(key || ''));
  } catch (err) {
    return { ok: false, error: 'bad-key', message: err instanceof TypeError ? 'a key is one piece of text with no spaces' : 'the key was not saved' };
  }
  return { ok: true };
}

async function removeKey(provider) {
  if (!KEY_PROVIDERS.includes(provider)) return { ok: false, error: 'bad-provider' };
  await keys.removeKey(provider);
  return { ok: true };
}

async function dismiss(id) {
  const { lastResult } = await chrome.storage.session.get('lastResult');
  if (lastResult && lastResult.id === id) await chrome.storage.session.set({ lastResult: { ...lastResult, dismissed: true } });
  return { ok: true };
}

// Deletes a recording made here for good (board #17003): its chunks and its
// entry. Not while it records or is being saved, and not while the recorder
// makes its transcript after Stop: the recorder writes to it then. In turn
// with start, stop and the transcript jobs, so none starts on it meanwhile.
// The copy in the recording library is the page's to remove.
const deleteRecording = (id) => serial(() => deleteRecordingNow(id));

async function deleteRecordingNow(id) {
  await ready;
  const live = await liveRecording();
  const { stopping, lastResult } = await chrome.storage.session.get(['stopping', 'lastResult']);
  if ((live && live.id === id) || (stopping && stopping.id === id)) return { ok: false, error: 'recording', message: 'stop the recording first' };
  if (afterJobsOf(await offscreenStatus()).includes(id)) return { ok: false, error: 'transcript-busy', message: 'its transcript is still being made' };
  const removed = await store.deleteRecording(await openDb(), id);
  // The popup and the strip stop offering this recording.
  if (lastResult && lastResult.id === id) await chrome.storage.session.remove('lastResult');
  return { ok: true, removed };
}

async function openRecording(id) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`recordings.html?id=${encodeURIComponent(String(id))}`) });
  return { ok: true };
}

// The model page's Back and Use this model (board #16623): back to the tab
// the popup was opened on, the model page closed, and the popup open again
// on that tab where the browser allows it (chrome.action.openPopup: Chrome
// 127 and later, and only in a focused window). No such tab: { ok: false },
// and the model page goes to the recordings page itself.
async function leaveModelPage(from, sender) {
  const back = Number.isInteger(from) ? await chrome.tabs.get(from).catch(() => null) : null;
  if (!back) return { ok: false, error: 'no-tab' };
  await chrome.tabs.update(back.id, { active: true });
  await chrome.windows.update(back.windowId, { focused: true }).catch(() => {});
  if (sender && sender.tab && sender.tab.id !== back.id) await chrome.tabs.remove(sender.tab.id).catch(() => {});
  const popup = chrome.action.openPopup ? await chrome.action.openPopup({ windowId: back.windowId }).then(() => true, () => false) : false;
  return { ok: true, popup };
}

// Export from the strip or the popup (board #16602). The recordings page
// holds the bundle writer and the recording library, and a page can
// download; it exports the recording as soon as it opens.
async function exportFromPage(id) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`recordings.html?id=${encodeURIComponent(String(id))}&export=1`) });
  return { ok: true };
}

async function retryTranscript() {
  const live = await liveRecording();
  if (!live) {
    // After Stop: the OpenAI or improved transcript of the recording just saved.
    const { lastResult } = await chrome.storage.session.get('lastResult');
    if (lastResult && AFTER_STOP_CHOICES.has(lastResult.transcription)) {
      // The content script of the recorded tab may send this, and each upload
      // is paid for: only a failure that the same upload can put right starts
      // one. A transcript that is ready, or a key OpenAI refused, does not.
      const next = afterTranscriptNext(await afterTranscriptOf(lastResult.id));
      if (next !== 'retry') return { ok: false, error: 'not-retryable', message: 'the transcript cannot be tried again from here' };
      return transcribeAfter(lastResult.id);
    }
    return { ok: false, error: 'not-recording', message: 'nothing is recording' };
  }
  const reply = await toOffscreen({ cmd: 'transcript-retry' }).catch(() => null);
  return reply && reply.ok ? { ok: true } : { ok: false, error: 'no-transcript', message: 'the transcript cannot be restarted' };
}

// Moves keyboard focus to the in-page controls of the recorded tab.
async function focusControls() {
  const live = await liveRecording();
  if (!live) return;
  await chrome.tabs.sendMessage(live.tabId, { to: 'strip', cmd: 'focus' }, { frameId: 0 }).catch(() => {});
}

async function forward(event) {
  try {
    await toOffscreen({ cmd: 'nav', event: { at: now(), workerBoot: WORKER_BOOT, ...event } });
  } catch {
    // No recorder: nothing to record into. The watchdog brings it back.
  }
}

function navListener(type) {
  return async (details) => {
    const live = await liveRecording();
    if (!isRecorded(live, details.tabId)) return;
    await forward({
      type,
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
chrome.webNavigation.onTabReplaced.addListener((details) =>
  serial(async () => {
    const live = await liveRecording();
    if (!isRecorded(live, details.replacedTabId)) return;
    const swap = (id) => (id === details.replacedTabId ? details.tabId : id);
    await chrome.storage.session.set({
      recording: { ...live, tabId: swap(live.tabId), followed: (live.followed || []).map((f) => ({ ...f, tabId: swap(f.tabId), openerTabId: swap(f.openerTabId) })) },
    });
    await toOffscreen({ cmd: 'tab-replaced', tabId: details.tabId, replacedTabId: details.replacedTabId }).catch(() => {});
    await forward({ type: 'tabReplaced', tabId: details.tabId, replacedTabId: details.replacedTabId });
  }),
);

// ---- windows the recorded tab opens (board #16754) ----------------------
// A tab or popup a recorded tab opens is a candidate. It is recorded from the
// moment the person switches to it (it opens in front, or they click on it
// later) until it closes; one they never switch to is never recorded (Matt,
// board #16754 q3582: "Only the window I switch to, also on other websites").
// The recording's tab stays the anchor: closing it stops the recording.
const followedTabs = (live) => ((live && live.followed) || []).map((f) => f.tabId);
const recordedTabs = (live) => (live ? [live.tabId, ...followedTabs(live)] : []);
const isRecorded = (live, tabId) => recordedTabs(live).includes(tabId);

// A tab opened by a recorded tab: keep it as a candidate; follow it at once
// when it opened in front.
const opened = (tabId, openerTabId) =>
  serial(async () => {
    const live = await liveRecording();
    if (!isRecorded(live, openerTabId) || isRecorded(live, tabId)) return;
    const candidates = live.candidates || [];
    if (!candidates.some((c) => c.tabId === tabId)) {
      await chrome.storage.session.set({ recording: { ...live, candidates: [...candidates, { tabId, openerTabId }] } });
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.active) await follow(tabId);
  });

async function follow(tabId) {
  const live = await liveRecording();
  const candidate = live && (live.candidates || []).find((c) => c.tabId === tabId);
  if (!candidate) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  const at = now();
  await chrome.storage.session.set({
    recording: {
      ...live,
      candidates: live.candidates.filter((c) => c.tabId !== tabId),
      followed: [...(live.followed || []), { tabId, windowId: tab.windowId, openerTabId: candidate.openerTabId, at }],
    },
  });
  const event = {
    at,
    workerBoot: WORKER_BOOT,
    type: 'tabFollowed',
    tabId,
    windowId: tab.windowId,
    openerTabId: candidate.openerTabId,
    windowType: win ? win.type : null,
    url: tab.pendingUrl || tab.url || null,
    title: tab.title || null,
  };
  await toOffscreen({ cmd: 'follow', tabId, event }).catch(() => {});
  // Documents already open in it; later ones start from the registered script.
  const injected = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['dist/content.js'] })
    .then((r) => ({ ok: true, frames: r.length }))
    .catch((err) => ({ ok: false, error: err.message }));
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  await forward({ type: 'start-frames', tabId, injected, frames });
}

// The person switched to `tabId`: follow it if it is a candidate, and note
// which tab is in front.
const switchedTo = (tabId, windowId, how) =>
  serial(async () => {
    let live = await liveRecording();
    if (!live) return;
    if ((live.candidates || []).some((c) => c.tabId === tabId)) {
      await follow(tabId);
      live = await liveRecording();
    }
    await forward({ type: how, activeTabId: tabId, windowId, recordedTabActive: tabId === live.tabId, recorded: isRecorded(live, tabId) });
  });

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => opened(details.tabId, details.sourceTabId));
chrome.tabs.onCreated.addListener((tab) => {
  if (Number.isInteger(tab.openerTabId)) opened(tab.id, tab.openerTabId);
});
chrome.tabs.onActivated.addListener((info) => switchedTo(info.tabId, info.windowId, 'tabActivated'));
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) switchedTo(tab.id, windowId, 'windowFocused');
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setHidden(tabId, null);
  const live = await liveRecording();
  if (live && tabId === live.tabId) await stop('tab-closed');
  else if (live && (isRecorded(live, tabId) || (live.candidates || []).some((c) => c.tabId === tabId))) await closed(tabId);
});

// A followed tab closed: its stream ends, the recording goes on.
const closed = (tabId) =>
  serial(async () => {
    const live = await liveRecording();
    if (!live) return;
    const wasFollowed = followedTabs(live).includes(tabId);
    await chrome.storage.session.set({
      recording: { ...live, followed: (live.followed || []).filter((f) => f.tabId !== tabId), candidates: (live.candidates || []).filter((c) => c.tabId !== tabId) },
    });
    if (wasFollowed) await toOffscreen({ cmd: 'unfollow', tabId, event: { at: now(), workerBoot: WORKER_BOOT, type: 'tabClosed', tabId } }).catch(() => {});
  });
// Alt+Shift+M marks the focused element of the recorded tab. Every frame
// gets the message; the frame holding focus marks (content/main.js).
async function markFocused(tab) {
  const live = await liveRecording();
  if (!live || (tab && !isRecorded(live, tab.id))) return;
  await chrome.tabs.sendMessage(tab ? tab.id : live.tabId, { cmd: MARK_FOCUSED }).catch(() => {});
}
// ---- a new build in the folder (board #17009, src/sw/self-update.js) ----
const selfUpdate = createSelfUpdate({
  running: { version: chrome.runtime.getManifest().version, commit: typeof NARWAL_BUILD !== 'undefined' ? NARWAL_BUILD.commit : null },
  installType: () => chrome.management.getSelf().then((self) => (chrome.runtime.getManifest().update_url ? 'store' : self.installType)),
  readFolderBuild: async () => {
    const res = await fetch(chrome.runtime.getURL('dist/build.json'), { cache: 'no-store' });
    return res.ok ? res.json() : null;
  },
  blocker: async () => {
    const { recording: live, stopping } = await chrome.storage.session.get(['recording', 'stopping']);
    const { held } = await navigator.locks.query();
    const pagesInUse = (held || []).some((lock) => lock.name === PAGE_IN_USE_LOCK);
    return reloadBlocker({ live, stopping, contexts: await chrome.runtime.getContexts({}), pagesInUse });
  },
  lastReload: async () => (await chrome.storage.local.get(RELOAD_KEY))[RELOAD_KEY] || null,
  saveReload: (entry) => chrome.storage.local.set({ [RELOAD_KEY]: entry }),
  noteHeld: async (held) => {
    if (!held) return chrome.storage.local.remove(HELD_KEY);
    const next = heldEntry((await chrome.storage.local.get(HELD_KEY))[HELD_KEY], held, new Date());
    if (next) await chrome.storage.local.set({ [HELD_KEY]: next });
  },
  beforeReload: async () => {
    const tabs = tabsToRestore(await chrome.tabs.query({}), chrome.runtime.getURL(''));
    await chrome.storage.local.set({ [RESTORE_KEY]: { at: new Date().toISOString(), tabs } });
  },
  // Holds the queue while the extension unloads, so no Start begins meanwhile;
  // a reload that never happens frees it after 10 s, and its tab list goes, so
  // the next worker start does not load those tabs again.
  reload: () => {
    chrome.runtime.reload();
    return new Promise((done) => setTimeout(done, 10000)).then(() => chrome.storage.local.remove(RESTORE_KEY));
  },
  log: (text) => console.info(text),
});
// In turn with start and stop: no recording starts between the check and the reload.
const checkBuild = (trigger) =>
  serial(async () => {
    await ready;
    return selfUpdate(trigger);
  }).catch((err) => console.error('NarWal: build check failed', err));
// Alarms can be cleared by an update or a browser restart; making one again
// on every worker start would push it back each time, so only when missing.
chrome.alarms
  .get(BUILD_ALARM)
  .then((alarm) => alarm || chrome.alarms.create(BUILD_ALARM, { periodInMinutes: BUILD_CHECK_MINUTES }))
  .catch((err) => console.error('NarWal: the build check alarm was not set', err));
// No onConnect listener here: a second receiver would keep the content
// script's port open after the recorder dies, and it would miss that.
// The NarWal tabs open before a self-reload come back first (board #17009).
const restored = chrome.storage.local
  .get(RESTORE_KEY)
  .then((got) =>
    restoreTabs({
      saved: got[RESTORE_KEY] || null,
      now: Date.now(),
      clear: () => chrome.storage.local.remove(RESTORE_KEY),
      getTab: (id) => chrome.tabs.get(id).catch(() => null),
      getWindow: (id) => chrome.windows.get(id).catch(() => null),
      update: (id, props) => chrome.tabs.update(id, props),
      create: (props) => chrome.tabs.create(props),
    }),
  )
  .catch((err) => console.error('NarWal: the tabs open before the reload did not open again', err));
restored.then(() => checkBuild('worker-start'));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) checkRecorder('watchdog');
  if (alarm.name === BUILD_ALARM) checkBuild('alarm');
});
// Browser-level shortcuts (manifest `commands`): they work even when a page
// covers the in-page controls.
function onShortcut(command, tab) {
  if (command === 'stop-recording') stop('user').catch((err) => console.error('NarWal: stop from the shortcut failed', err));
  if (command === 'focus-controls') focusControls();
  if (command === MARK_FOCUSED) return markFocused(tab);
}
chrome.commands.onCommand.addListener(onShortcut);

// An extension page (popup, permission, model, recordings) or the recorder.
function fromExtensionPage(sender) {
  return Boolean(sender && sender.url && sender.url.startsWith(chrome.runtime.getURL('')));
}

// The recorder (offscreen document) only: no page, popup or content script.
function fromRecorder(sender) {
  return Boolean(sender && !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html'));
}
const RECORDER_COMMANDS = new Set(['openai-key', 'recorder-idle']);

// The content script in the recorded tab may use the strip's commands, and
// only for its own tab. The content script runs in every tab while recording,
// so other tabs get no status either (it carries transcript text).
async function fromRecordedTab(sender) {
  if (!sender || !sender.tab) return false;
  const live = (await liveRecording()) || (await chrome.storage.session.get('stopping')).stopping;
  const { lastResult } = await chrome.storage.session.get('lastResult');
  // The recorded tab and the windows it opened that were followed (board #16754).
  const tabIds = live ? recordedTabs(live) : lastResult ? (lastResult.tabIds ?? [lastResult.tabId]) : [];
  return tabIds.includes(sender.tab.id);
}

const STRIP_COMMANDS = new Set(['ui-status', 'mic-level', 'stop', 'retry-transcript', 'open-recording', 'export-recording', 'dismiss']);
const CONTENT_COMMANDS = new Set(['sink-lost', 'regions-picked', ...STRIP_COMMANDS]);

async function allowed(cmd, sender) {
  if (RECORDER_COMMANDS.has(cmd)) return fromRecorder(sender);
  if (cmd === 'regions-picked') return Boolean(sender && sender.tab && sender.frameId === 0 && !fromExtensionPage(sender));
  if (fromExtensionPage(sender)) return true;
  if (!CONTENT_COMMANDS.has(cmd)) return false;
  if (cmd === 'sink-lost') return true;
  return fromRecordedTab(sender);
}

// Messages from extension pages, the recorder, and the content script.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'sw') return false;
  const handlers = {
    start: () => start(msg.tabId, msg.transcription, msg.purpose),
    stop: () => stop('user'),
    status: () => status(),
    'ui-status': () => uiStatus(msg.cursor),
    'mic-level': () => micLevel(),
    keys: () => keyPresence(),
    'save-key': () => saveKey(msg.provider, msg.key),
    'remove-key': () => removeKey(msg.provider),
    'pick-regions': () => pickRegions(msg.tabId),
    'hidden-regions': () => hiddenCount(msg.tabId),
    'regions-picked': () => regionsPicked(msg, sender),
    'frame-parent': () => frameParent(msg.tabId, msg.frameId),
    'retry-transcript': () => retryTranscript(),
    transcribe: () => transcribeAfter(String(msg.id)),
    'transcript-state': () => afterTranscriptOf(String(msg.id)).then((afterTranscript) => ({ ok: true, afterTranscript })),
    'openai-key': () => openAiKey(),
    'recorder-idle': () => recorderIdle().then(() => ({ ok: true })),
    'open-recording': () => openRecording(msg.id),
    'delete-recording': () => deleteRecording(String(msg.id)),
    'export-recording': () => exportFromPage(msg.id),
    'leave-model-page': () => leaveModelPage(msg.from, sender),
    dismiss: () => dismiss(msg.id),
    'sink-lost': () => checkRecorder('content-reconnect').then(() => ({ ok: true })),
    'recorder-failed': () => stop(msg.reason, msg.error),
  };
  if (!handlers[msg.cmd]) return false;
  const run = () =>
    allowed(msg.cmd, sender).then((ok) => (ok ? handlers[msg.cmd]() : { ok: false, error: 'not-allowed', message: 'not allowed from this page' }));
  run().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

globalThis.narwal = { start, stop, status };
if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST) {
  Object.assign(globalThis.narwal, {
    // A renderer crash, as far as the recording can tell.
    killRecorder: () => chrome.offscreen.closeDocument(),
    checkRecorder,
    failWrites: () => toOffscreen({ cmd: 'test:fail-writes' }),
    throwingConsumer: () => toOffscreen({ cmd: 'test:throwing-consumer' }),
    // chrome.commands cannot be pressed from the test driver: call the handler.
    command: onShortcut,
    // The e2e run answers OpenAI uploads from its fixture server (board #16588).
    openAiEndpoint: (url) => chrome.storage.session.set({ testOpenAiEndpoint: url }),
    // Installs a model with no recording running, as the model page does (board #16603).
    installModel: (model) => ensureOffscreen().then(() => toOffscreen({ cmd: 'test:model-install', model })),
    // The build check the alarm runs (board #17009), on demand.
    checkBuild,
  });
}
