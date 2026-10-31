// The RecorderPort the recorder UI needs (packages/recorder-ui/README.md),
// over service worker messages. The popup and the in-page strip each make
// one. Status comes from polling `ui-status`: the service worker keeps no
// state in memory and may restart at any time, so a poll is always right.
import { afterTranscriptBusy, toRecorderStatus } from '../shared/ui-status.js';

const ACTIVE = new Set(['starting', 'recording', 'stopping']);

/**
 * @param {object} options
 * @param {(cmd: string, extra?: object) => Promise<any>} options.send  a message to the service worker
 * @param {number} [options.tabId]  the tab this view belongs to (popup)
 * @param {() => Promise<object>} [options.readContext]  tab, mic, online, model, keys (popup only)
 * @param {boolean} [options.pollWhenIdle]  keep reading after the recording ends (popup: model download progress)
 * @param {number} [options.pollMs]
 * @param {() => Promise<void>} [options.requestMic]
 * @param {() => Promise<void>} [options.downloadModel]
 * @param {() => Promise<void>} [options.pickRegions]  hide parts of the page before Start (popup only; board #16592)
 * @param {() => Promise<void>} [options.chooseModel]  open the speech model picker (popup only; board #16611)
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 */
export function createExtensionPort({
  send,
  tabId,
  readContext = async () => ({}),
  pollWhenIdle = false,
  pollMs = 1000,
  requestMic = async () => {},
  downloadModel = async () => {},
  pickRegions,
  chooseModel,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  const listeners = new Set();
  let status = null;
  let local = null; // 'starting' | 'stopping' while that call runs
  let cursor; // opaque, from the recorder (#16570); undefined on the first read
  let timer = null;
  let reading = null;

  const emit = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('NarWal: recorder UI listener failed', err);
      }
    }
  };

  async function ask(cmd, extra) {
    const reply = await send(cmd, extra);
    if (!reply || reply.ok === false) throw new Error((reply && (reply.message || reply.error)) || 'the recorder did not answer');
    return reply;
  }

  function withLocal(next) {
    if (local === 'starting' && next.phase !== 'recording') return { ...next, phase: 'starting' };
    if (local === 'stopping' && (next.phase === 'recording' || next.phase === 'idle')) return { ...next, phase: 'stopping' };
    return next;
  }

  async function readOnce() {
    const [sw, context] = await Promise.all([ask('ui-status', { cursor }), readContext()]);
    if (sw.cursor !== undefined && sw.cursor !== null) cursor = sw.cursor;
    status = withLocal(toRecorderStatus(sw, { ...context, tabId }));
    emit({ type: 'status', status });
    for (const event of sw.events || []) emit(event);
    return status;
  }

  // One read at a time; callers that arrive meanwhile share it.
  function read() {
    if (!reading) reading = readOnce().finally(() => (reading = null));
    return reading;
  }

  function schedule() {
    clearTimer(timer);
    timer = null;
    if (!listeners.size) return;
    // A transcript being made after Stop is shown as it goes: OpenAI's (#16588)
    // or the improved one on this computer (#16603).
    const coming = afterTranscriptBusy(status && status.afterTranscript);
    if (!pollWhenIdle && status && !ACTIVE.has(status.phase) && !coming && !local) return;
    timer = setTimer(tick, pollMs);
  }

  function tick() {
    timer = null;
    read()
      .catch(() => {})
      .finally(schedule);
  }

  function publishLocal(phase) {
    local = phase;
    if (status) {
      status = withLocal(status);
      emit({ type: 'status', status });
    }
  }

  async function settle() {
    await read().catch(() => {});
    schedule();
  }

  const port = {
    async getStatus() {
      const first = status || (await read());
      schedule();
      return first;
    },
    subscribe(listener) {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimer(timer);
          timer = null;
        }
      };
    },
    async start({ transcription, purpose }) {
      publishLocal('starting');
      try {
        await ask('start', { tabId, transcription, purpose });
      } finally {
        local = null;
        await settle();
      }
    },
    async stop() {
      publishLocal('stopping');
      try {
        await ask('stop');
      } finally {
        local = null;
        await settle();
      }
    },
    async requestMic() {
      await requestMic();
      await settle();
    },
    async refresh() {
      await settle();
    },
    async downloadModel() {
      await downloadModel();
      await settle();
    },
    async saveKey(provider, key) {
      await ask('save-key', { provider, key });
      await settle();
    },
    async removeKey(provider) {
      await ask('remove-key', { provider });
      await settle();
    },
    async retryTranscript() {
      await ask('retry-transcript');
      await settle();
    },
    async openRecording(recordingId) {
      await ask('open-recording', { id: recordingId });
    },
    async exportRecording(recordingId) {
      await ask('export-recording', { id: recordingId });
    },
    /** The live recording's microphone level for the strip's meter (board #16785); null when there is none. */
    async micLevel() {
      const reply = await send('mic-level').catch(() => null);
      return reply && reply.ok && typeof reply.level === 'number' ? { level: reply.level, heard: reply.heard === true } : null;
    },
    /** The user closed the saved or failed message. */
    async dismiss(recordingId) {
      await ask('dismiss', { id: recordingId }).catch(() => {});
    },
  };
  // The start view offers "Hide areas" only when the port has this.
  if (pickRegions) {
    port.pickRegions = async () => {
      await pickRegions();
      await settle();
    };
  }
  // The start view offers "Choose model" only when the port has this.
  if (chooseModel) {
    port.chooseModel = async () => {
      await chooseModel();
    };
  }
  return port;
}
