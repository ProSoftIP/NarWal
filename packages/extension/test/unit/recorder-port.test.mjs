import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionPort } from '../../src/ui/recorder-port.js';

const T0 = 1_700_000_000_000;
const flush = () => new Promise((r) => setImmediate(r));

// A fake service worker: `state` is what ui-status answers; `sent` lists commands.
function fakeWorker(state = {}) {
  const sent = [];
  const worker = {
    sent,
    events: [],
    state: { live: null, stopping: null, lastResult: null, ...state },
    replies: {},
    async send(cmd, extra = {}) {
      sent.push([cmd, extra]);
      if (cmd === 'ui-status') return { ok: true, now: T0, cursor: `c${Number(String(extra.cursor || 'c0').slice(1)) + 1}`, events: worker.events, ...worker.state };
      if (worker.replies[cmd]) return worker.replies[cmd](extra);
      return { ok: true };
    },
  };
  return worker;
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (id) => pending.delete(id),
    async fire() {
      const [[id, { fn }]] = pending;
      pending.delete(id);
      fn();
      await flush();
    },
  };
}

test('status comes from ui-status with the cursor, and transcript events are passed on', async () => {
  const sw = fakeWorker({ live: { id: 'r1', tabId: 3, startedAt: T0 - 1000, transcription: 'offline' } });
  sw.events = [{ type: 'segment', segment: { segmentKey: 'a', kind: 'final', startMs: 0, endMs: 1, text: 'hi' } }];
  const timers = fakeTimers();
  const port = createExtensionPort({ send: sw.send, tabId: 3, ...timers });
  const seen = [];
  port.subscribe((e) => seen.push(e.type));
  const first = await port.getStatus();
  assert.equal(first.phase, 'recording');
  assert.deepEqual(seen, ['status', 'segment']);
  await timers.fire();
  assert.deepEqual(
    sw.sent.filter(([c]) => c === 'ui-status').map(([, x]) => x.cursor),
    [undefined, 'c1'],
  );
});

test('the strip stops polling once the recording ended; the popup keeps polling', async () => {
  const sw = fakeWorker();
  const strip = fakeTimers();
  const p1 = createExtensionPort({ send: sw.send, ...strip });
  p1.subscribe(() => {});
  await p1.getStatus();
  assert.equal(strip.pending.size, 0);

  const popup = fakeTimers();
  const p2 = createExtensionPort({ send: sw.send, pollWhenIdle: true, ...popup });
  const off = p2.subscribe(() => {});
  await p2.getStatus();
  assert.equal(popup.pending.size, 1);
  off();
  assert.equal(popup.pending.size, 0);
});

test('after Stop the strip keeps polling while OpenAI makes the transcript (#16588)', async () => {
  const lastResult = { id: 'r1', tabId: 3, stopReason: 'user', at: T0, startedAt: T0 - 1000, transcription: 'openai' };
  const sw = fakeWorker({ lastResult, afterTranscript: { state: 'uploading', done: 0, total: 1 } });
  const strip = fakeTimers();
  const port = createExtensionPort({ send: sw.send, ...strip });
  port.subscribe(() => {});
  const first = await port.getStatus();
  assert.deepEqual([first.phase, first.afterTranscript.state], ['saved', 'uploading']);
  assert.equal(strip.pending.size, 1, 'polls while uploading');
  sw.state.afterTranscript = { state: 'failed', error: { kind: 'network', code: 'network', message: 'offline' } };
  await strip.fire();
  assert.equal(strip.pending.size, 0, 'stops once the job ended');
  await port.retryTranscript();
  assert.deepEqual(sw.sent.at(-2), ['retry-transcript', {}]);
});

test('a strip told to read again polls a job started elsewhere until it ends (#16598)', async () => {
  const lastResult = { id: 'r1', tabId: 3, stopReason: 'user', at: T0, startedAt: T0 - 1000, transcription: 'openai' };
  const sw = fakeWorker({ lastResult, afterTranscript: { state: 'failed', error: { kind: 'auth', code: 'auth', message: 'refused', retryable: false } } });
  const strip = fakeTimers();
  const port = createExtensionPort({ send: sw.send, ...strip });
  const states = [];
  port.subscribe((e) => e.type === 'status' && states.push(e.status.afterTranscript.state));
  await port.getStatus();
  assert.equal(strip.pending.size, 0, 'idle after the failure');
  sw.state.afterTranscript = { state: 'uploading', done: 0, total: 1 };
  await port.refresh();
  assert.equal(strip.pending.size, 1, 'polls the new upload');
  sw.state.afterTranscript = { state: 'done' };
  await strip.fire();
  assert.equal(strip.pending.size, 0);
  assert.deepEqual(states, ['failed', 'uploading', 'done']);
});

test('start shows Starting at once, sends the choice, purpose and tab, then reads the result', async () => {
  const sw = fakeWorker();
  const port = createExtensionPort({ send: sw.send, tabId: 7, ...fakeTimers() });
  const phases = [];
  port.subscribe((e) => e.type === 'status' && phases.push(e.status.phase));
  await port.getStatus();
  sw.replies.start = () => {
    sw.state.live = { id: 'r2', tabId: 7, startedAt: T0, transcription: 'deepgram' };
    return { ok: true, id: 'r2' };
  };
  await port.start({ transcription: 'deepgram', purpose: 'Each mark is a bug' });
  assert.deepEqual(sw.sent.find(([c]) => c === 'start')[1], { tabId: 7, transcription: 'deepgram', purpose: 'Each mark is a bug' });
  assert.deepEqual(phases, ['idle', 'starting', 'recording']);
});

test('a refused start throws its message and the view is idle again', async () => {
  const sw = fakeWorker();
  const port = createExtensionPort({ send: sw.send, tabId: 7, ...fakeTimers() });
  await port.getStatus();
  sw.replies.start = () => ({ ok: false, error: 'already-recording', message: 'A recording is already running.' });
  await assert.rejects(port.start({ transcription: 'offline' }), /A recording is already running\./);
  assert.equal((await port.getStatus()).phase, 'idle');
});

test('stop shows Saving until the worker reports the result', async () => {
  const sw = fakeWorker({ live: { id: 'r1', tabId: 3, startedAt: T0 - 2000, transcription: 'offline' } });
  const port = createExtensionPort({ send: sw.send, ...fakeTimers() });
  const phases = [];
  port.subscribe((e) => e.type === 'status' && phases.push(e.status.phase));
  await port.getStatus();
  sw.replies.stop = () => {
    sw.state.live = null;
    sw.state.lastResult = { id: 'r1', stopReason: 'user', storageError: null, at: T0, startedAt: T0 - 2000 };
    return { ok: true };
  };
  await port.stop();
  assert.deepEqual(phases, ['recording', 'stopping', 'saved']);
});

test('keys, retry, open and dismiss go to the worker; the key is never kept', async () => {
  const sw = fakeWorker();
  const port = createExtensionPort({ send: sw.send, ...fakeTimers() });
  await port.saveKey('deepgram', 'k-123');
  await port.removeKey('deepgram');
  await port.retryTranscript();
  await port.openRecording('r1');
  sw.replies.dismiss = () => ({ ok: false, error: 'gone' });
  await port.dismiss('r1');
  const cmds = sw.sent.map(([c]) => c).filter((c) => c !== 'ui-status');
  assert.deepEqual(cmds, ['save-key', 'remove-key', 'retry-transcript', 'open-recording', 'dismiss']);
  assert.ok(!JSON.stringify(await port.getStatus()).includes('k-123'));
  sw.replies['save-key'] = () => ({ ok: false, error: 'key-storage-open', message: 'not saved' });
  await assert.rejects(port.saveKey('deepgram', 'x'), /not saved/);
});

test('the popup context (tab, mic, model, keys) is read with each status', async () => {
  const sw = fakeWorker();
  let reads = 0;
  const readContext = async () => {
    reads += 1;
    return { mic: 'denied', model: { state: 'missing' }, keys: { openai: true }, online: false, tab: { ok: false, reason: 'restricted' } };
  };
  const port = createExtensionPort({ send: sw.send, readContext, ...fakeTimers() });
  const s = await port.getStatus();
  assert.deepEqual([s.mic, s.online, s.keys.openai, s.tab.ok], ['denied', false, true, false]);
  await port.refresh();
  assert.equal(reads, 2);
});

test('Hide areas is offered only by a port that can pick, and the count is read again after (#16592)', async () => {
  const sw = fakeWorker();
  assert.equal(createExtensionPort({ send: sw.send, ...fakeTimers() }).pickRegions, undefined);
  let picks = 0;
  let hidden = 0;
  const port = createExtensionPort({
    send: sw.send,
    readContext: async () => ({ hidden }),
    pickRegions: async () => {
      picks += 1;
      hidden = 1;
    },
    ...fakeTimers(),
  });
  assert.equal((await port.getStatus()).hidden, 0);
  const seen = [];
  port.subscribe((e) => e.type === 'status' && seen.push(e.status.hidden));
  await port.pickRegions();
  assert.equal(picks, 1);
  assert.equal(seen.at(-1), 1);
});

test('Choose model is offered only by a port that can open the picker (#16611)', async () => {
  const sw = fakeWorker();
  assert.equal(createExtensionPort({ send: sw.send, ...fakeTimers() }).chooseModel, undefined);
  let opened = 0;
  const port = createExtensionPort({ send: sw.send, chooseModel: async () => (opened += 1), ...fakeTimers() });
  await port.chooseModel();
  assert.equal(opened, 1);
});
