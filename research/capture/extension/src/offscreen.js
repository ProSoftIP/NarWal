// NarWal capture probe — offscreen document (board #16538).
// Owns the microphone (USER_MEDIA reason) and is the single sink for every
// content-script port, so capture does not depend on the service worker
// staying alive. All timestamps use performance.timeOrigin + performance.now().
const now = () => performance.timeOrigin + performance.now();

let session = null;

function log(entry) {
  if (!session) return;
  entry.recv = entry.recv || now();
  session.log.push(entry);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case 'start':
      return start(msg);
    case 'stop':
      return stop();
    case 'nav':
      log({ k: 'nav', ...msg.event });
      return { ok: true };
    case 'dump':
      return { ok: true, session: session ? serialisable(session) : null };
    case 'status':
      return { ok: true, recording: Boolean(session && !session.stoppedAt), tabId: session && session.tabId };
    default:
      return { ok: false, error: `unknown cmd ${msg.cmd}` };
  }
}

async function start({ tabId, options }) {
  if (session && !session.stoppedAt) throw new Error('already recording');
  session = { id: crypto.randomUUID(), tabId, options: options || {}, startedAt: now(), log: [], ports: new Map(), audio: null };
  log({ k: 'session-start', tabId, options });
  session.audio = await startAudio(options || {});
  return { ok: true, id: session.id, audio: session.audio.summary() };
}

async function stop() {
  if (!session) return { ok: false, error: 'not recording' };
  for (const port of session.ports.values()) {
    try {
      port.postMessage({ cmd: 'stop' });
    } catch (err) {
      // Port already closed.
    }
  }
  const audio = session.audio ? await session.audio.stop() : null;
  session.stoppedAt = now();
  log({ k: 'session-stop', audio });
  return { ok: true, id: session.id };
}

function serialisable(s) {
  return {
    id: s.id,
    tabId: s.tabId,
    options: s.options,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt || null,
    audio: s.audio ? s.audio.summary() : null,
    log: s.log,
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'narwal-capture') return;
  const sender = port.sender || {};
  const tabId = sender.tab ? sender.tab.id : null;
  if (!session || session.stoppedAt || tabId !== session.tabId) {
    port.postMessage({ cmd: 'ignore' });
    // Logged so tab-switch tests can prove other tabs were refused.
    if (session && !session.stoppedAt) log({ k: 'refused', tabId, url: sender.url, frameId: sender.frameId });
    return;
  }
  const key = `${sender.documentId || 'nodoc'}:${sender.frameId}:${crypto.randomUUID().slice(0, 8)}`;
  const meta = {
    key,
    documentId: sender.documentId || null,
    documentLifecycle: sender.documentLifecycle || null,
    frameId: sender.frameId,
    url: sender.url,
    origin: sender.origin || null,
  };
  session.ports.set(key, port);
  log({ k: 'conn', ...meta });
  port.onMessage.addListener((msg) => {
    const recv = now();
    if (msg.k === 'hello') {
      log({ k: 'hello', port: key, recv, sent: msg.sent, reason: msg.reason, boot: msg.boot, pendingCount: msg.pendingCount, dropped: msg.dropped, recent: msg.reason === 'boot' ? [] : msg.recent });
      port.postMessage({ cmd: 'start', options: session.options, reason: msg.reason });
      return;
    }
    log({ ...msg, port: key, recv });
  });
  port.onDisconnect.addListener(() => {
    session.ports.delete(key);
    log({ k: 'disc', port: key, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
  });
});

async function startAudio(options) {
  const state = { chunks: 0, bytes: 0, blobs: [], error: null, settings: null, recorderStartedAt: null, clock: [], trackEvents: [] };
  let stream = null;
  let ctx = null;
  let recorder = null;
  const summary = () => ({
    error: state.error,
    settings: state.settings,
    chunks: state.chunks,
    bytes: state.bytes,
    recorderStartedAt: state.recorderStartedAt,
    sampleRate: ctx ? ctx.sampleRate : null,
    baseLatency: ctx ? ctx.baseLatency : null,
    clockPoints: state.clock.length,
    decodedSeconds: state.decodedSeconds ?? null,
    trackEvents: state.trackEvents,
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: options.echoCancellation ?? true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    state.error = { name: err.name, message: err.message };
    log({ k: 'audio-error', name: err.name, message: err.message });
    return { summary, stop: async () => summary() };
  }
  const track = stream.getAudioTracks()[0];
  state.settings = track.getSettings();
  for (const type of ['ended', 'mute', 'unmute']) {
    track.addEventListener(type, () => {
      state.trackEvents.push({ type, at: now(), readyState: track.readyState });
      log({ k: 'audio-track', type, readyState: track.readyState });
    });
  }

  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
  const source = ctx.createMediaStreamSource(stream);
  const counter = new AudioWorkletNode(ctx, 'narwal-frame-counter');
  counter.port.onmessage = (e) => {
    const point = { frames: e.data.frames, ctxTime: ctx.currentTime, at: now() };
    state.clock.push(point);
    log({ k: 'audio-clock', ...point });
  };
  source.connect(counter);
  // A worklet with no path to the destination is not pulled in some builds.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  counter.connect(sink).connect(ctx.destination);

  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.addEventListener('start', () => {
    state.recorderStartedAt = now();
    log({ k: 'audio-recorder', type: 'start' });
  });
  recorder.addEventListener('dataavailable', (e) => {
    state.chunks += 1;
    state.bytes += e.data.size;
    state.blobs.push(e.data);
    log({ k: 'audio-chunk', size: e.data.size });
  });
  recorder.addEventListener('error', (e) => log({ k: 'audio-recorder', type: 'error', message: String(e.error && e.error.message) }));
  recorder.start(1000);

  const stop = async () => {
    if (recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    try {
      const blob = new Blob(state.blobs, { type: 'audio/webm' });
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      state.decodedSeconds = decoded.duration;
    } catch (err) {
      state.decodedSeconds = null;
      log({ k: 'audio-decode-error', message: String(err && err.message) });
    }
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return summary();
  };
  return { summary, stop };
}
