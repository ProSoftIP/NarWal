// NarWal offscreen recorder. The only sink for page evidence and the owner of
// the microphone (USER_MEDIA reason, no lifetime limit), so capture does not
// depend on the service worker staying alive (board #16538, design point 1).
// Everything it receives is saved in bounded chunks about once a second.
import { now } from '../shared/clock.js';
import { PORT_NAME, CAPTURE_OPTIONS } from '../shared/protocol.js';
import * as store from '../store/db.js';
import { createBatcher } from './batcher.js';
import { startAudio, addAudioConsumer, addPcmConsumer } from './audio.js';
import { createTranscriptHost } from './transcript.js';
import { createOpenAiJobs } from './openai-job.js';
import { createLocalJobs } from './local-job.js';
import { DEFAULT_TRANSCRIPTION, normaliseTranscription } from '../../../recorder-ui/src/providers.js';
import { createBrowserOfflineTranscriber } from '../../../offline-transcription/src/browser.ts';
import { MODEL_IDS } from '../../../offline-transcription/src/models.ts';
import { createDecodingSlicer, UPLOAD_SAMPLE_RATE } from '../../../transcription/src/openai/index.ts';

const FLUSH_MS = 1000;
// A child frame records only when the document around it says the frame is
// outside every hidden area; no answer in this time counts as hidden.
const FRAME_ANSWER_MS = 15000;

let db = null;
let session = null;

// The offline engines (board #16570) load once per offscreen document. The
// worker files are packaged in dist/runtime/ by build.mjs.
let offline = null;
function openEngines() {
  if (!offline) {
    offline = Promise.resolve()
      .then(() => createBrowserOfflineTranscriber(chrome.runtime.getURL('dist/runtime/')))
      .catch((err) => {
        offline = null;
        throw err;
      });
  }
  return offline;
}
const openOffline = () => openEngines().then((engines) => engines.transcriber);

const transcript = createTranscriptHost({
  addPcmConsumer,
  openOffline,
  store: {
    nextEntrySeq: (id) => store.nextStreamSeq(db, id, store.TRANSCRIPT_STREAM),
    putEntry: (id, seq, entry) => store.putTranscriptEntry(db, id, seq, entry),
    readEntries: (id) => store.readTranscriptEntries(db, id),
    updateHistory: (id, change) => store.updateTranscriptHistory(db, id, change),
  },
  onError: (err, where) => add({ k: 'transcript-error', where, message: String((err && err.message) || err) }),
});

// The OpenAI transcript after Stop (board #16588). The key comes from the
// service worker for each job, in its reply only.
const openai = createOpenAiJobs({
  store: {
    getRecording: async (id) => store.getRecording(await openDb(), id),
    updateRecording: async (id, patch) => store.updateRecording(await openDb(), id, patch),
    readAudio: async (id) => store.readChunks(await openDb(), id, 'audio'),
    historyStore: (id) => ({
      read: async () => store.readTranscriptHistory(await openDb(), id),
      write: async (next, expectedVersion) => store.writeTranscriptHistory(await openDb(), id, next, expectedVersion),
    }),
    updateHistory: async (id, change) => store.updateTranscriptHistory(await openDb(), id, change),
  },
  getKey: () => chrome.runtime.sendMessage({ to: 'sw', cmd: 'openai-key' }),
  now,
  // Audio over the 25 MB upload limit is decoded and cut into parts.
  slicer: createDecodingSlicer(() => new OfflineAudioContext(1, 1, UPLOAD_SAMPLE_RATE)),
  // With no recording and no other job left, the service worker may close this document.
  onEnd: () => chrome.runtime.sendMessage({ to: 'sw', cmd: 'recorder-idle' }).catch(() => {}),
});

// The improved transcript on this computer after Stop (board #16603): the
// final pass (Parakeet, Whisper or Moonshine) over the saved narration. Checkpoints are kept in the
// store, so a job the browser cut short goes on when the recorder opens again.
const local = createLocalJobs({
  store: {
    getRecording: async (id) => store.getRecording(await openDb(), id),
    updateRecording: async (id, patch) => store.updateRecording(await openDb(), id, patch),
    readAudio: async (id) => store.readChunks(await openDb(), id, 'audio'),
    readEvents: async (id) => store.readChunks(await openDb(), id, 'events'),
    readCheckpoint: async (id) => store.readFinalCheckpoint(await openDb(), id),
    writeCheckpoint: async (id, checkpoint) => store.writeFinalCheckpoint(await openDb(), id, checkpoint),
    clearCheckpoint: async (id) => store.clearFinalCheckpoint(await openDb(), id),
    readHistory: async (id) => store.readTranscriptHistory(await openDb(), id),
    updateHistory: async (id, change) => store.updateTranscriptHistory(await openDb(), id, change),
  },
  openOffline,
  now,
  // Only installed models run; with none the job fails at once (it never waits on a download).
  installed: async (models) => {
    const { transcriber } = await openEngines();
    const states = await Promise.all(models.map((id) => transcriber.models.status(id).then((s) => s.state, () => 'missing')));
    return models.filter((_, i) => states[i] === 'ready');
  },
  // The Whisper worker holds the model; it ends with the last job.
  release: () => offline && offline.then((engines) => engines.whisper.terminate(), () => {}),
  onEnd: () => chrome.runtime.sendMessage({ to: 'sw', cmd: 'recorder-idle' }).catch(() => {}),
});

/** The transcript job after Stop of the recording's choice. */
async function runAfter(recordingId, options) {
  const meta = await store.getRecording(await openDb(), recordingId);
  if (meta && meta.transcription === 'offline') return local.run(recordingId, options);
  return openai.run(recordingId);
}

const afterJobs = () => [...openai.running(), ...local.running()];

async function openDb() {
  db = db || (await store.openDb());
  return db;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case 'start':
      return start(msg);
    case 'stop':
      return stop(msg.reason || 'user');
    case 'nav':
      add({ k: 'nav', ...msg.event });
      return { ok: true };
    case 'tab-replaced':
      if (session) {
        // Any recorded tab can be replaced (prerender, back/forward cache).
        if (session.tabId === msg.replacedTabId || msg.replacedTabId === undefined) session.tabId = msg.tabId;
        if (msg.replacedTabId !== undefined) session.tabs.delete(msg.replacedTabId);
        session.tabs.add(msg.tabId);
      }
      return { ok: true };
    case 'follow':
      // A tab or popup the recorded tab opened, once the person switched to
      // it (board #16754): its documents are accepted from now on.
      if (!accepting(session)) return { ok: false, error: 'not recording' };
      session.tabs.add(msg.tabId);
      if (msg.event) add({ k: 'nav', ...msg.event });
      return { ok: true };
    case 'unfollow':
      if (session) session.tabs.delete(msg.tabId);
      if (msg.event) add({ k: 'nav', ...msg.event });
      return { ok: true };
    case 'status':
      return { ok: true, ...status(), openaiJobs: openai.running(), afterJobs: afterJobs(), ...(session ? transcript.status(msg.transcriptCursor) : {}) };
    case 'mic-level': {
      // The strip's meter (board #16785): a level, never audio.
      const level = session && session.state === 'recording' && session.audio ? session.audio.level() : null;
      return level ? { ok: true, level: level.level, heard: level.heard } : { ok: true, level: null };
    }
    case 'transcript-retry':
      return transcript.retry();
    case 'openai-transcribe':
    case 'after-transcribe':
      if (session && session.id === msg.recordingId && session.state !== 'stopped') return { ok: false, error: 'recording', message: 'stop the recording first' };
      return runAfter(String(msg.recordingId));
    case 'after-resume':
      // Jobs the browser cut short (service worker boot).
      return { ok: true, started: await local.resumeAll((msg.recordingIds || []).map(String)) };
    default:
      if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST) return testHook(msg);
      return { ok: false, error: `unknown cmd ${msg.cmd}` };
  }
}

// Entries are accepted until the final flush of Stop.
const accepting = (s) => s && (s.state === 'recording' || s.state === 'stopping');

function add(entry) {
  if (!accepting(session)) return;
  if (entry.t === undefined) entry.t = now();
  session.batcher.add(entry);
}

function status() {
  if (!session) return { recording: false };
  return {
    recording: session.state === 'recording',
    state: session.state,
    id: session.id,
    tabId: session.tabId,
    tabs: [...session.tabs],
    startedAt: session.startedAt,
    audio: session.audio ? session.audio.status() : null,
    // Nothing heard in the first 10 s (board #16785): the strip says so.
    micSilent: Boolean(session.audio && session.audio.level && session.audio.level()?.neverHeard),
    storageError: session.storageError,
    events: session.batcher.totals(),
    audioChunks: session.audioSaved,
    ports: session.ports.size,
  };
}

async function start({ recordingId, tabId, followed, url, title, resume, transcription, hidden, purpose, offlineModel, microphoneId }) {
  if (session && session.state === 'recording') {
    if (session.id === recordingId) return { ok: true, id: session.id, audio: session.audio.status(), already: true };
    throw new Error('already recording');
  }
  db = db || (await store.openDb());
  let meta = resume ? await store.getRecording(db, recordingId) : null;
  const seq = meta ? await store.nextSeq(db, recordingId) : { events: 0, audio: 0 };
  const lastAt = meta ? await store.lastPersistedAt(db, recordingId) : null;
  if (!meta) {
    meta = {
      id: recordingId,
      format: store.FORMAT,
      status: 'recording',
      tabId,
      url,
      title,
      ...(purpose ? { purpose } : {}),
      startedAt: now(),
      stoppedAt: null,
      transcription: normaliseTranscription(transcription),
      // The model picked for the job after Stop (board #16611); none: this computer's chain.
      ...(typeof offlineModel === 'string' && offlineModel ? { offlineModel } : {}),
      // Areas the user hid before Start (board #16592): {page, areas} or null.
      // Kept here so a restarted recorder hides the same areas.
      hidden: hidden || null,
      stopReason: null,
      restarts: 0,
      audioSegments: 0,
      storageError: null,
      clock: { base: 'performance.timeOrigin + performance.now()', timeOrigin: performance.timeOrigin },
    };
  } else {
    meta = { ...meta, status: 'recording', restarts: (meta.restarts || 0) + 1 };
  }
  const segment = meta.audioSegments || 0;
  meta.audioSegments = segment + 1;
  await store.putRecording(db, meta);

  session = {
    id: recordingId,
    tabId,
    // The recorded tab and the windows it opened that are followed (board #16754).
    tabs: new Set([tabId, ...(Array.isArray(followed) ? followed : [])]),
    startedAt: meta.startedAt,
    hidden: meta.hidden || null,
    state: 'recording',
    ports: new Map(),
    // Child frames (board #16592): frame -> the port of the document that
    // records in it, frame -> Promise<boolean> (is it hidden?), the frames
    // that are hidden, and the questions sent to parent documents. A frame
    // is `tabId:frameId` (frameOf), as more than one tab can record.
    framePorts: new Map(),
    frameDecisions: new Map(),
    hiddenFrames: new Set(),
    frameQuestions: new Map(),
    storageError: null,
    failureSent: false,
    audio: null,
    audioSeq: seq.audio,
    audioSaved: 0,
    flushTimer: null,
  };
  session.batcher = createBatcher({
    startSeq: seq.events,
    write: (chunk) => store.putChunk(db, { recordingId, stream: 'events', ...chunk }),
    onError: (err, chunk) => storageFailed(err, { stream: 'events', from: chunk.startAt, to: chunk.endAt }),
  });
  add({ k: 'session', type: resume ? 'resume' : 'start', tabId, url, title, options: CAPTURE_OPTIONS });
  if (resume) {
    // The recorder was gone (crash, browser killed it). Everything between
    // the last saved chunk and now is missing in every stream.
    add({ k: 'gap', scope: 'any', reason: 'recovery-truncated', from: lastAt ?? meta.startedAt, to: now(), detail: `recorder restarted (${resume})` });
  }
  session.flushTimer = setInterval(() => {
    add({ k: 'beat' });
    session.batcher.flush();
  }, FLUSH_MS);

  const own = session;
  session.audio = await startAudio({
    deviceId: typeof microphoneId === 'string' && microphoneId ? microphoneId : undefined,
    segment,
    recordingStartedAt: meta.startedAt,
    onEntry: add,
    saveChunk: (chunk) => saveAudio(own, chunk),
    onConsumerError: (err, kind) => add({ k: 'consumer-error', kind, message: String((err && err.message) || err) }),
  });
  await store.updateRecording(db, recordingId, { audio: session.audio.status() });
  // A resumed recorder keeps the choice the recording started with.
  await transcript.start({ recordingId, choice: meta.transcription || DEFAULT_TRANSCRIPTION, resume: Boolean(resume) }).catch((err) => add({ k: 'transcript-error', where: 'start', message: String((err && err.message) || err) }));
  return { ok: true, id: recordingId, audio: session.audio.status() };
}

async function saveAudio(own, chunk) {
  if (own.state !== 'recording' && own.state !== 'stopping') return;
  const record = {
    recordingId: own.id,
    stream: 'audio',
    seq: own.audioSeq++,
    segment: chunk.segment,
    startAt: chunk.startAt,
    endAt: chunk.endAt,
    bytes: chunk.blob.size,
    mime: chunk.mime,
    data: chunk.blob,
  };
  try {
    await store.putChunk(db, record);
    own.audioSaved += 1;
  } catch (err) {
    storageFailed(err, { stream: 'audio', from: chunk.startAt, to: chunk.endAt });
    throw err;
  }
}

// A write failed. Chunks already saved stay saved. A full disk stops the
// recording (writing into nothing would look like a recording that is not
// there) and the service worker shows it on the badge and in the popup.
function storageFailed(err, lost) {
  if (!session) return;
  const quota = store.isQuotaError(err);
  const info = { name: err && err.name, message: String((err && err.message) || err), quota, at: now(), lost };
  if (!session.storageError) session.storageError = info;
  // One report per session: every later failed write would ask for the same stop.
  if (session.state !== 'recording' || session.failureSent) return;
  session.failureSent = true;
  chrome.runtime.sendMessage({ to: 'sw', cmd: 'recorder-failed', reason: quota ? 'storage-full' : 'storage-error', error: info }).catch(() => {});
}

async function stop(reason) {
  if (!session || session.state !== 'recording') return { ok: false, error: 'not recording', ...status() };
  const own = session;
  own.state = 'stopping';
  for (const port of own.ports.values()) {
    try {
      port.postMessage({ cmd: 'stop' });
    } catch {
      // Port already closed.
    }
  }
  const audio = own.audio ? await own.audio.stop() : null;
  // The live engine finishes the audio it has; its revision is saved in the
  // recording's transcript history before the recording is marked stopped.
  const transcriptSummary = await transcript.stop().catch((err) => {
    add({ k: 'transcript-error', where: 'stop', message: String((err && err.message) || err) });
    return null;
  });
  clearInterval(own.flushTimer);
  add({ k: 'session', type: 'stop', reason });
  if (own.storageError) {
    add({ k: 'gap', scope: 'any', reason: 'recovery-truncated', from: own.storageError.lost.from, to: now(), detail: own.storageError.quota ? 'storage-full' : `storage-error: ${own.storageError.message}` });
  }
  await own.batcher.flush();
  own.state = 'stopped';
  const stoppedAt = now();
  const meta = await store
    .updateRecording(db, own.id, { status: 'stopped', stoppedAt, stopReason: reason, audio, storageError: own.storageError, events: own.batcher.totals(), audioChunks: own.audioSaved })
    .catch((err) => ({ updateError: String(err && err.message) }));
  for (const port of own.ports.values()) port.disconnect();
  own.ports.clear();
  // OpenAI makes the transcript now, from the saved narration; the offline
  // choice improves the live one on this computer. The service worker keeps
  // this document open while the job runs.
  const after = meta && meta.transcription === 'openai' ? openai.run(own.id) : meta && meta.transcription === 'offline' ? local.run(own.id) : null;
  const afterTranscript = after ? await after.catch((err) => ({ ok: false, error: String(err && err.message) })) : null;
  return { ok: true, id: own.id, stoppedAt, stopReason: reason, storageError: own.storageError, audio, meta, transcript: transcriptSummary, afterTranscript, keepOpen: afterJobs().length > 0 };
}

// ---- child frames inside hidden areas (board #16592) -------------------
// rrweb in a parent document does not record a frame inside a blocked area,
// but every frame runs its own content script. Before a child frame's
// document starts, the recorder asks the document of its parent frame
// whether the frame element is inside an area it hides. A frame inside a
// hidden frame is hidden too. Anything that cannot be answered is hidden.

function waitFor(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const frameOf = (tabId, frameId) => `${tabId}:${frameId}`;

// The port of the document recording in frame, once there is one.
function framePort(own, frame) {
  const port = own.framePorts.get(frame);
  if (port) return Promise.resolve(port);
  return new Promise((resolve) => {
    const waiters = (own.portWaiters ||= new Map());
    if (!waiters.has(frame)) waiters.set(frame, []);
    waiters.get(frame).push(resolve);
  });
}

function acceptFrame(own, frame, port) {
  own.framePorts.set(frame, port);
  const waiters = own.portWaiters && own.portWaiters.get(frame);
  if (waiters) {
    own.portWaiters.delete(frame);
    for (const resolve of waiters) resolve(port);
  }
}

async function askParent(own, tabId, frameId, frameIndex) {
  if (!Number.isInteger(frameIndex)) return true;
  const reply = await chrome.runtime.sendMessage({ to: 'sw', cmd: 'frame-parent', tabId, frameId }).catch(() => null);
  if (!reply || !reply.ok) return true;
  const parent = frameOf(tabId, reply.parentFrameId);
  if (own.hiddenFrames.has(parent)) return true;
  if (reply.parentFrameId !== 0) {
    const parentDecision = own.frameDecisions.get(parent);
    if (parentDecision && (await parentDecision)) return true;
  }
  const port = await framePort(own, parent);
  const q = crypto.randomUUID();
  const answer = new Promise((resolve) => own.frameQuestions.set(q, resolve));
  port.postMessage({ cmd: 'frame-hidden', q, frameIndex });
  try {
    return (await answer) !== false;
  } finally {
    own.frameQuestions.delete(q);
  }
}

/**
 * Is the child frame hidden? Asked for each document that loads in the frame;
 * once hidden, the frame stays hidden for the rest of the recording.
 */
function frameHidden(own, tabId, frameId, frameIndex) {
  const frame = frameOf(tabId, frameId);
  if (own.hiddenFrames.has(frame)) return Promise.resolve(true);
  let decision = own.frameDecisions.get(frame);
  if (!decision) {
    decision = waitFor(askParent(own, tabId, frameId, frameIndex), FRAME_ANSWER_MS, true).then((hidden) => {
      if (hidden) own.hiddenFrames.add(frame);
      own.frameDecisions.delete(frame);
      return hidden;
    });
    own.frameDecisions.set(frame, decision);
  }
  return decision;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const sender = port.sender || {};
  const tabId = sender.tab ? sender.tab.id : null;
  if (!session || session.state !== 'recording' || !session.tabs.has(tabId)) {
    // The registered script runs in every tab; only the recorded tab and the
    // windows it opened that are followed are kept.
    port.postMessage({ cmd: 'ignore' });
    if (session && session.state === 'recording') add({ k: 'refused', tabId, frameId: sender.frameId });
    return;
  }
  const own = session;
  const frameId = sender.frameId;
  const frame = frameOf(tabId, frameId);
  const doc = `${sender.documentId || 'nodoc'}:${frameId}:${crypto.randomUUID().slice(0, 8)}`;
  own.ports.set(doc, port);
  // Nothing from a document counts until it was told to start.
  let accepted = false;
  let refused = false;
  const begin = (msg, t) => {
    accepted = true;
    acceptFrame(own, frame, port);
    add({
      k: 'attach',
      doc,
      t,
      reason: msg.reason,
      documentId: sender.documentId || null,
      documentLifecycle: sender.documentLifecycle || null,
      tabId,
      windowId: sender.tab ? sender.tab.windowId : null,
      frameId,
      url: sender.url,
      origin: sender.origin || null,
      boot: msg.boot,
      queued: msg.queued,
      dropped: msg.dropped,
    });
    port.postMessage({ cmd: 'start', options: { ...CAPTURE_OPTIONS, originEpochMs: own.startedAt, hidden: own.hidden }, reason: msg.reason });
  };
  port.onMessage.addListener((msg) => {
    if (own !== session || !accepting(own) || refused) return;
    const t = now();
    if (msg.k === 'frame-hidden') {
      // A parent document's answer: not evidence.
      if (accepted && own.frameQuestions.has(msg.q)) own.frameQuestions.get(msg.q)(msg.hidden);
      return;
    }
    if (msg.k === 'hello') {
      if (accepted) return;
      if (frameId === 0) {
        begin(msg, t);
        return;
      }
      const index = msg.boot ? msg.boot.frameIndex : null;
      frameHidden(own, tabId, frameId, index).then((hidden) => {
        if (own !== session || !accepting(own) || !own.ports.has(doc)) return;
        if (!hidden) {
          begin(msg, t);
          return;
        }
        refused = true;
        // No URL: the address of a hidden frame can say what it shows.
        add({ k: 'refused', reason: 'hidden-area', tabId, frameId });
        port.postMessage({ cmd: 'ignore' });
      });
      return;
    }
    if (accepted) add({ ...msg, doc, t });
  });
  port.onDisconnect.addListener(() => {
    own.ports.delete(doc);
    if (own.framePorts.get(frame) === port) own.framePorts.delete(frame);
    if (accepted) add({ k: 'detach', doc, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
  });
});

async function testHook(msg) {
  if (msg.cmd === 'test:fail-writes') {
    globalThis.__narwalFailWrites = true;
    return { ok: true };
  }
  if (msg.cmd === 'test:throwing-consumer') {
    addAudioConsumer(() => {
      throw new Error('simulated transcription failure');
    });
    return { ok: true };
  }
  if (msg.cmd === 'test:model-install') {
    // The model page (board #16551) installs models for users; the e2e run
    // installs the live model here.
    const transcriber = await openOffline();
    const result = await transcriber.models.install(msg.model || 'vosk-small-en-us');
    return { ok: result.state === 'ready', state: result.state };
  }
  return { ok: false, error: `unknown cmd ${msg.cmd}` };
}
