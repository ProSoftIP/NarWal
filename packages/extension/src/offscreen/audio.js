// Microphone capture for the offscreen recorder. MediaRecorder writes Opus
// WebM in one-second chunks; each chunk is handed to saveChunk at once (never
// held until Stop). A worklet reports (frames, time) clock pairs and, on
// demand, 16 kHz PCM for live transcription. Every loss is reported as a gap.
// An analyser gives the strip its level meter and says when nothing has been
// heard (board #16785); it reads levels only and keeps no audio.
import { now } from '../shared/clock.js';
import { createSilenceWatch, measureLevel } from '../../../recorder-ui/src/mic-level.js';
import { fanOut } from './fanout.js';

const MIME = 'audio/webm;codecs=opus';
const TIMESLICE_MS = 1000;
const LEVEL_MS = 100;
const VOICE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Consumers survive recorder restarts within this offscreen document.
const chunkConsumers = new Set();
const pcmConsumers = new Set();
let activeTap = null;

/**
 * Receive every saved audio chunk: { blob, segment, startAt, endAt, mime }.
 * Returns a function that removes the consumer.
 */
export function addAudioConsumer(fn) {
  chunkConsumers.add(fn);
  return () => chunkConsumers.delete(fn);
}

/**
 * Receive 16 kHz mono s16le blocks of 100 ms:
 * { pcm: Int16Array, sampleRate: 16000, startAt (wall-clock ms), startMs (ms since recording start) }.
 */
export function addPcmConsumer(fn) {
  pcmConsumers.add(fn);
  if (activeTap) activeTap.port.postMessage({ pcm: true });
  return () => {
    pcmConsumers.delete(fn);
    if (activeTap && !pcmConsumers.size) activeTap.port.postMessage({ pcm: false });
  };
}

/**
 * The chosen microphone, or the default one when it is not connected (board
 * #16785). `fellBack` is true when the chosen one could not be opened.
 */
async function openMicrophone(deviceId) {
  if (deviceId) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: { ...VOICE, deviceId: { exact: deviceId } } }), fellBack: false };
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ audio: VOICE }), fellBack: Boolean(deviceId) };
}

/**
 * Starts the microphone. Never throws for device or permission problems:
 * those return state 'unavailable' and a gap, and page capture continues.
 *   deviceId    the microphone chosen in the popup or Options; absent: the default
 *   segment     audio segment number (a resumed recorder starts a new WebM file)
 *   recordingStartedAt  for PCM startMs
 *   onEntry     add an entry to the events stream
 *   saveChunk   persist one chunk; may reject (storage full)
 *   onConsumerError  a consumer threw
 */
export async function startAudio({ deviceId, segment, recordingStartedAt, onEntry, saveChunk, onConsumerError }) {
  const status = { state: 'starting', error: null, segment, chunks: 0, bytes: 0, settings: null, deviceFallback: false };
  let stream;
  try {
    const opened = await openMicrophone(deviceId);
    stream = opened.stream;
    status.deviceFallback = opened.fellBack;
    if (opened.fellBack) onEntry({ k: 'audio', type: 'device-missing', segment, detail: 'the chosen microphone is not connected; the default one is used' });
  } catch (err) {
    status.state = 'unavailable';
    status.error = { name: err.name, message: err.message };
    onEntry({ k: 'audio', type: 'unavailable', segment, name: err.name, message: err.message });
    onEntry({ k: 'gap', scope: 'audio', reason: err.name === 'NotAllowedError' ? 'mic-denied' : 'mic-device-lost', from: now(), to: null, detail: err.name });
    return { status: () => ({ ...status }), level: () => null, stop: async () => ({ ...status }) };
  }

  const track = stream.getAudioTracks()[0];
  status.settings = track.getSettings();
  onEntry({ k: 'audio', type: 'device', segment, label: track.label, settings: status.settings });
  for (const type of ['ended', 'mute', 'unmute']) {
    track.addEventListener(type, () => {
      onEntry({ k: 'audio', type: `track-${type}`, segment, readyState: track.readyState });
      if (type === 'ended' && status.state === 'recording') {
        // Revoked permission or unplugged device. The track never restarts.
        status.state = 'lost';
        onEntry({ k: 'gap', scope: 'audio', reason: 'mic-track-ended', from: now(), to: null, detail: 'blocked or unplugged' });
      }
    });
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // A node with no path to the destination is not pulled in some builds.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser).connect(sink);
  const samples = new Float32Array(analyser.fftSize);
  const watch = createSilenceWatch(now());
  const levelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    watch.feed(measureLevel(samples).rms, now());
  }, LEVEL_MS);

  let tap = null;
  let lastClock = null;
  try {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('dist/worklet.js'));
    tap = new AudioWorkletNode(ctx, 'narwal-tap');
    tap.port.onmessage = (e) => {
      const at = now();
      if (typeof e.data.frames === 'number') {
        lastClock = { frames: e.data.frames, at };
        onEntry({ k: 'audio', type: 'clock', segment, frames: e.data.frames, sampleRate: ctx.sampleRate, ctxTime: ctx.currentTime, t: at });
        return;
      }
      if (e.data.pcm) {
        const startAt = lastClock ? lastClock.at + ((e.data.startFrame - lastClock.frames) / ctx.sampleRate) * 1000 : at - 100;
        fanOut(pcmConsumers, { pcm: e.data.pcm, sampleRate: 16000, startAt, startMs: startAt - recordingStartedAt }, (err) => onConsumerError(err, 'pcm'));
      }
    };
    source.connect(tap).connect(sink);
    if (pcmConsumers.size) tap.port.postMessage({ pcm: true });
    activeTap = tap;
  } catch (err) {
    onEntry({ k: 'audio', type: 'clock-unavailable', segment, message: String(err && err.message) });
  }

  const recorder = new MediaRecorder(stream, { mimeType: MIME });
  let chunkStart = null;
  let saving = Promise.resolve();
  recorder.addEventListener('start', () => {
    chunkStart = now();
    status.state = 'recording';
    onEntry({ k: 'audio', type: 'recorder-start', segment, mime: MIME, t: chunkStart });
  });
  recorder.addEventListener('dataavailable', (e) => {
    const endAt = now();
    const chunk = { blob: e.data, segment, startAt: chunkStart ?? endAt, endAt, mime: MIME };
    chunkStart = endAt;
    status.chunks += 1;
    status.bytes += e.data.size;
    saving = saving.then(() => saveChunk(chunk)).then(
      () => fanOut(chunkConsumers, chunk, (err) => onConsumerError(err, 'chunk')),
      () => {}, // saveChunk reports its own failure.
    );
  });
  recorder.addEventListener('error', (e) => {
    onEntry({ k: 'audio', type: 'recorder-error', segment, message: String(e.error && e.error.message) });
    if (status.state === 'recording') {
      status.state = 'lost';
      onEntry({ k: 'gap', scope: 'audio', reason: 'recorder-error', from: now(), to: null, detail: String(e.error && e.error.name) });
    }
  });
  recorder.start(TIMESLICE_MS);

  async function stop() {
    if (recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    await saving;
    clearInterval(levelTimer);
    stream.getTracks().forEach((t) => t.stop());
    if (activeTap === tap) activeTap = null;
    await ctx.close().catch(() => {});
    if (status.state === 'recording') status.state = 'stopped';
    onEntry({ k: 'audio', type: 'recorder-stop', segment, chunks: status.chunks, bytes: status.bytes });
    return { ...status };
  }

  /** The meter's fill (0..1), whether any sound was heard, and "nothing in the first 10 s". */
  const level = () => (status.state === 'recording' ? watch.state() : null);

  return { status: () => ({ ...status }), level, stop };
}
