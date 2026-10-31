// RecorderPort: everything this UI needs from the recorder, and nothing
// else. The views call a port; they never call chrome.* or read a key.
// The extension supplies the real port (service worker messages). Tests and
// the demo pages use createFakePort.

/**
 * @typedef {Object} RecorderStatus
 * @property {'idle'|'starting'|'recording'|'stopping'|'saved'|'failed'} phase
 * @property {{ok:boolean, title?:string, reason?:string}} tab  the tab that Start would record
 * @property {'granted'|'prompt'|'denied'|'unavailable'} mic
 * @property {boolean} [online]  false when the computer has no network
 * @property {{state:'missing'|'downloading'|'ready'|'failed', bytesDone?:number, bytesTotal?:number, error?:string, choice?:ModelChoice}} model
 *   the offline speech model, and which model the choice uses (board #16611)
 * @property {{deepgram?:boolean, assemblyai?:boolean, openai?:boolean}} keys  key saved yes/no, never the key
 * @property {string} [transcription]  the choice the current recording uses
 * @property {number} [elapsedMs]  recording time on the session clock
 * @property {boolean} [micLive]  false when the microphone stopped during a recording
 * @property {boolean} [micSilent]  no sound heard in the first 10 s of the recording (board #16785)
 * @property {boolean} [micFallback]  the chosen microphone was not connected; the default one records (board #16785)
 * @property {{state:'connecting'|'live'|'behind'|'reconnecting'|'disconnected'|'after-recording'|'off', detail?:string}} [transcript]
 * @property {boolean} [elsewhere]  the recording runs in another tab than the one this view belongs to
 * @property {string} [recordingId]
 * @property {{state:'uploading'|'improving'|'done'|'partial'|'failed'|'no-key', done?:number, total?:number, progress?:number, detail?:string, activated?:boolean, next?:'retry'|'after-fix'|'never'}} [afterTranscript]
 *   the transcript made after Stop (saved phase): OpenAI's, or the improved one
 *   made on this computer (progress 0..1); never its text
 * @property {string} [error]  plain words, shown as written
 * @property {number} [hidden]  areas of the tab's page hidden from the recording (ports with pickRegions)
 * @property {number} [hiddenLost]  hidden areas the page no longer has: Start is blocked until they are picked again
 *
 * @typedef {Object} ModelChoice  the speech model of the "On this computer" choice
 * @property {string} id
 * @property {string} name
 * @property {number} accuracySteps  1..5, from the measured word error rate
 * @property {number} speedSteps  1..5, from the measured speed
 * @property {boolean} recommended  the model this computer runs first when none is chosen
 *
 * @typedef {{type:'status', status:RecorderStatus}
 *   | {type:'segment', segment:{segmentKey:string, kind:'interim'|'final', startMs:number, endMs:number, text:string}}
 *   | {type:'gap', gap:{startMs:number, endMs:number, reason:string}}} RecorderEvent
 *
 * @typedef {Object} RecorderPort
 * @property {() => Promise<RecorderStatus>} getStatus
 * @property {(listener:(event:RecorderEvent)=>void) => (() => void)} subscribe  returns unsubscribe
 * @property {(options:{transcription:string, purpose?:string}) => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} requestMic  ask for, or open the page that asks for, microphone access
 * @property {() => Promise<void>} refresh  read tab, microphone and network again
 * @property {() => Promise<void>} downloadModel
 * @property {(provider:string, key:string) => Promise<void>} saveKey
 * @property {(provider:string) => Promise<void>} removeKey
 * @property {() => Promise<void>} retryTranscript  connect the same provider again, or after Stop ask OpenAI again; never another provider
 * @property {(recordingId:string) => Promise<void>} openRecording
 * @property {(recordingId:string) => Promise<void>} exportRecording  write the saved recording as a bundle and download it (board #16602)
 * @property {() => Promise<void>} [chooseModel]  optional: open the model picker (board #16611)
 * @property {() => Promise<void>} [pickRegions]  optional: let the user hide parts of the page before Start (board #16592)
 * @property {() => Promise<{level:number, heard:boolean}|null>} [micLevel]  optional: the recording's microphone level, 0..1, for the strip's meter (board #16785)
 */

export const IDLE_STATUS = Object.freeze({
  phase: 'idle',
  tab: { ok: true, title: '' },
  mic: 'prompt',
  online: true,
  model: { state: 'missing' },
  keys: {},
});

/**
 * An in-memory port with believable behaviour: enough to drive every UI
 * state in tests and demo pages. `calls` lists each method call in order.
 *
 * @param {Partial<RecorderStatus>} [initial]
 * @param {{micResult?: 'granted'|'denied', modelBytes?: number}} [behaviour]
 * @returns {RecorderPort & {calls: Array<[string, ...unknown[]]>, set: (patch: Partial<RecorderStatus>) => void, emit: (event: RecorderEvent) => void, status: () => RecorderStatus}}
 */
export function createFakePort(initial = {}, behaviour = {}) {
  let status = { ...IDLE_STATUS, ...initial };
  const listeners = new Set();
  const calls = [];
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const set = (patch) => {
    status = { ...status, ...patch };
    emit({ type: 'status', status });
  };
  const call = (name, ...args) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    set,
    emit,
    status: () => status,
    async getStatus() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(options) {
      call('start', options);
      const after = options.transcription === 'openai';
      set({
        phase: 'recording',
        transcription: options.transcription,
        elapsedMs: 0,
        micLive: true,
        recordingId: undefined,
        error: undefined,
        transcript: { state: after ? 'after-recording' : 'connecting' },
      });
    },
    async stop() {
      call('stop');
      set({ phase: 'stopping' });
    },
    async requestMic() {
      call('requestMic');
      set({ mic: behaviour.micResult || 'granted' });
    },
    async refresh() {
      call('refresh');
      emit({ type: 'status', status });
    },
    async downloadModel() {
      call('downloadModel');
      set({ model: { state: 'downloading', bytesDone: 0, bytesTotal: behaviour.modelBytes || status.model.bytesTotal } });
    },
    async saveKey(provider, key) {
      // The key itself is not kept in `calls`: tests read `calls` into logs.
      call('saveKey', provider, key.length);
      set({ keys: { ...status.keys, [provider]: true } });
    },
    async removeKey(provider) {
      call('removeKey', provider);
      set({ keys: { ...status.keys, [provider]: false } });
    },
    async retryTranscript() {
      call('retryTranscript');
      if (status.phase === 'saved') set({ afterTranscript: status.transcription === 'offline' ? { state: 'improving', progress: 0 } : { state: 'uploading', done: 0, total: 1 } });
      else set({ transcript: { state: 'connecting' } });
    },
    async openRecording(recordingId) {
      call('openRecording', recordingId);
    },
    async exportRecording(recordingId) {
      call('exportRecording', recordingId);
    },
    async chooseModel() {
      call('chooseModel');
    },
    async micLevel() {
      return status.phase === 'recording' && status.micLive !== false ? { level: status.micSilent ? 0 : 0.6, heard: !status.micSilent } : null;
    },
    async pickRegions() {
      call('pickRegions');
      // A new pick finds every area it hides.
      set({ hidden: (status.hidden || 0) + 1, hiddenLost: 0 });
    },
  };
}
