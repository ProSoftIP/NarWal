import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptHost } from '../../src/offscreen/transcript.js';
import { createTranscriptHistory, addRevision } from '../../../transcription/src/revisions.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const block = (startMs, samples = 1600) => ({ pcm: new Int16Array(samples), sampleRate: 16000, startAt: 1e12 + startMs, startMs });

function fakeStore(initial = {}) {
  const entries = new Map(Object.entries(initial.entries || {}));
  const histories = new Map();
  return {
    entries,
    histories,
    async nextEntrySeq(id) {
      return (entries.get(id) || []).length;
    },
    async putEntry(id, seq, entry) {
      const list = entries.get(id) || [];
      list[seq] = structuredClone(entry);
      entries.set(id, list);
    },
    async readEntries(id) {
      return (entries.get(id) || []).filter(Boolean).map((e) => structuredClone(e));
    },
    async updateHistory(id, change) {
      const next = change(histories.get(id) || createTranscriptHistory(id));
      histories.set(id, next);
      return next;
    },
  };
}

// A stand-in for LocalLiveSession: the test drives its events.
function fakeOffline({ startOutcome = 'open' } = {}) {
  const sessions = [];
  let gate = null;
  const api = {
    sessions,
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
    async openOffline() {
      return {
        async startLive(options, onEvent) {
          const session = {
            options,
            onEvent,
            audio: [],
            finished: false,
            aborted: false,
            sendAudio(data) {
              this.audio.push(data);
            },
            async finish() {
              this.finished = true;
              onEvent({ type: 'state', state: 'closed' });
            },
            abort() {
              this.aborted = true;
            },
          };
          sessions.push(session);
          onEvent({ type: 'state', state: 'connecting' });
          if (gate) await gate;
          if (startOutcome === 'model-missing' && sessions.length === 1) {
            onEvent({ type: 'error', error: { kind: 'model', code: 'model-missing', message: 'not downloaded' } });
            onEvent({ type: 'state', state: 'closed' });
          } else {
            onEvent({ type: 'state', state: 'open' });
          }
          return session;
        },
      };
    },
  };
  return api;
}

function setup(options = {}) {
  let consumer = null;
  const offline = fakeOffline(options);
  const store = options.store || fakeStore();
  const errors = [];
  const host = createTranscriptHost({
    addPcmConsumer: (fn) => {
      consumer = fn;
      return () => (consumer = null);
    },
    openOffline: offline.openOffline,
    store,
    now: () => 1_700_000_000_000,
    boot: 'b1',
    onError: (err, where) => errors.push([where, String(err)]),
  });
  return { host, offline, store, errors, pcm: (chunk) => consumer && consumer(chunk), subscribed: () => consumer !== null };
}

const seg = (key, kind, startMs, endMs, text) => ({ type: 'segment', segment: { provider: 'browser-local', connectionId: 'c', segmentKey: key, kind, startMs, endMs, text, endOfUtterance: kind === 'final', words: [] } });

test('offline: the session starts at the first audio block and the strip reads new text after its cursor', async () => {
  const t = setup();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  assert.deepEqual(t.host.status().transcript, { state: 'connecting' });
  t.pcm(block(400));
  await tick();
  const [s] = t.offline.sessions;
  assert.equal(s.options.audioOriginMs, 400);
  assert.match(s.options.connectionId, /^R\.b1\.1$/);
  assert.equal(s.audio.length, 1, 'audio held while the engine loaded is sent');
  assert.deepEqual(t.host.status().transcript, { state: 'live' });

  s.onEvent(seg('k1', 'interim', 400, 900, 'hel'));
  const first = t.host.status(undefined);
  assert.deepEqual(first.transcriptEvents, [{ type: 'segment', segment: { segmentKey: 'k1', kind: 'interim', startMs: 400, endMs: 900, text: 'hel' } }]);

  s.onEvent(seg('k1', 'interim', 400, 1000, 'hello'));
  s.onEvent(seg('k1', 'final', 400, 1100, 'hello there'));
  const second = t.host.status(first.transcriptCursor);
  assert.deepEqual(
    second.transcriptEvents.map((e) => [e.segment.kind, e.segment.text]),
    [['final', 'hello there']],
    'the final replaces the interim lines of its segment',
  );
  assert.deepEqual(t.host.status(second.transcriptCursor).transcriptEvents, []);
  // A cursor from another recorder (or none) gets the whole log; superseded interim text is gone.
  assert.deepEqual(t.host.status('other.1:99').transcriptEvents.map((e) => e.segment.text), ['hello there']);
  t.pcm(block(500));
  assert.equal(s.audio.length, 2);
});

test('engine behind shows as behind with the reason', async () => {
  const t = setup();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  await tick();
  t.offline.sessions[0].onEvent({ type: 'backlog', behind: true, lagMs: 12_000 });
  const { transcript } = t.host.status();
  assert.equal(transcript.state, 'behind');
  assert.match(transcript.detail, /12 s behind/);
});

test('a missing model shows disconnected; Try again starts a new session on the same engine', async () => {
  const t = setup({ startOutcome: 'model-missing' });
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  await tick();
  const down = t.host.status().transcript;
  assert.equal(down.state, 'disconnected');
  assert.match(down.detail, /not downloaded/);

  const retried = await t.host.retry();
  assert.equal(retried.ok, true);
  assert.equal(retried.transcript.state, 'reconnecting');
  await tick();
  assert.equal(t.offline.sessions[0].finished, true, 'the old session finishes and records its gap');
  t.pcm(block(5000));
  await tick();
  assert.equal(t.offline.sessions.length, 2);
  assert.equal(t.offline.sessions[1].options.audioOriginMs, 5000);
  assert.deepEqual(t.host.status().transcript, { state: 'live' });
});

test('retry while live changes nothing', async () => {
  const t = setup();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  await tick();
  const r = await t.host.retry();
  assert.deepEqual(r, { ok: true, transcript: { state: 'live' } });
  assert.equal(t.offline.sessions[0].finished, false);
});

test('a jump in the audio clock starts a new session at the new time', async () => {
  const t = setup();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  await tick();
  t.pcm(block(100));
  t.pcm(block(60_000));
  await tick();
  assert.equal(t.offline.sessions.length, 2);
  assert.equal(t.offline.sessions[0].finished, true);
  assert.equal(t.offline.sessions[1].options.audioOriginMs, 60_000);
});

test('Stop adds finals and gaps to the history as one live revision and names it active', async () => {
  const t = setup();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  await tick();
  const s = t.offline.sessions[0];
  s.onEvent(seg('k2', 'final', 3000, 3500, 'second'));
  s.onEvent(seg('k1', 'final', 100, 900, 'first'));
  s.onEvent(seg('k3', 'interim', 4000, 4100, 'never final'));
  s.onEvent({ type: 'gap', gap: { provider: 'browser-local', startMs: 1000, endMs: 2000, reason: 'engine-behind' } });
  const summary = await t.host.stop();
  assert.equal(t.subscribed(), false);
  assert.equal(s.finished, true);
  assert.deepEqual(summary, {
    choice: 'offline',
    activeRevision: 'r1',
    revisions: [{ revisionId: 'r1', source: 'live', provider: 'browser-local', model: 'vosk-small-en-us', createdAt: '2023-11-14T22:13:20.000Z', segments: 2, gaps: 1 }],
  });
  const history = t.store.histories.get('R');
  assert.equal(history.activeRevision, 'r1');
  const [revision] = history.revisions;
  assert.deepEqual(revision.segments.map((x) => [x.id, x.text, x.timing]), [['s1', 'first', 'aligned'], ['s2', 'second', 'aligned']]);
  assert.deepEqual(revision.gaps, [{ startMs: 1000, endMs: 2000, reason: 'not-transcribed', detail: 'engine-behind' }]);
  assert.equal(await t.host.stop(), summary, 'a second Stop writes nothing new');
  assert.equal(t.store.histories.get('R').revisions.length, 1);
});

test('a live revision added after another one does not take over the active one', async () => {
  const store = fakeStore();
  const earlier = { revisionId: 'x', provider: 'openai', model: 'whisper-1', createdAtMs: 1, source: 'after-recording', segments: [], gaps: [] };
  store.histories.set('R', addRevision(createTranscriptHistory('R'), earlier));
  const t = setup({ store });
  await t.host.start({ recordingId: 'R', choice: 'offline', resume: true });
  t.pcm(block(0));
  await tick();
  t.offline.sessions[0].onEvent(seg('k1', 'final', 100, 900, 'later'));
  const summary = await t.host.stop();
  assert.equal(summary.activeRevision, 'r1');
  assert.deepEqual(store.histories.get('R').revisions.map((r) => [r.revisionId, r.source]), [['r1', 'after-recording'], ['r2', 'live']]);
});

test('a resumed recorder keeps what the earlier one saved and marks the restart', async () => {
  const store = fakeStore({ entries: { R: [seg('old:0', 'final', 0, 800, 'before the crash')] } });
  const t = setup({ store });
  await t.host.start({ recordingId: 'R', choice: 'offline', resume: true });
  t.pcm(block(10_000));
  await tick();
  t.offline.sessions[0].onEvent(seg('new:0', 'final', 10_100, 10_900, 'after'));
  const summary = await t.host.stop();
  const [revision] = store.histories.get('R').revisions;
  assert.deepEqual(revision.segments.map((x) => x.text), ['before the crash', 'after']);
  assert.deepEqual(revision.gaps.map((g) => [g.startMs, g.endMs, g.reason, g.detail]), [[800, 10_000, 'not-transcribed', 'engine-failed: recorder restarted']]);
  assert.equal(summary.activeRevision, 'r1');
  assert.equal(store.entries.get('R').length, 3, 'new entries append after the saved ones');
});

test('OpenAI is after recording and Deepgram is off; neither taps the microphone', async () => {
  for (const [choice, state] of [['openai', 'after-recording'], ['deepgram', 'off'], ['assemblyai', 'off']]) {
    const t = setup();
    await t.host.start({ recordingId: 'R', choice });
    assert.equal(t.subscribed(), false);
    const status = t.host.status();
    assert.equal(status.transcript.state, state);
    assert.equal(status.transcription, choice);
    assert.deepEqual(status.transcriptEvents, []);
    assert.deepEqual(await t.host.retry(), { ok: false, error: 'nothing to retry' });
    assert.deepEqual(await t.host.stop(), { choice, activeRevision: null, revisions: [] });
  }
});

test('audio before the engine is ready waits and is sent in order', async () => {
  const t = setup();
  const release = t.offline.hold();
  await t.host.start({ recordingId: 'R', choice: 'offline' });
  t.pcm(block(0));
  t.pcm(block(100));
  await tick();
  assert.equal(t.host.status().transcript.state, 'connecting');
  t.pcm(block(200));
  release();
  await tick();
  await tick();
  assert.equal(t.offline.sessions[0].audio.length, 3);
  assert.equal(t.host.status().transcript.state, 'live');
});
