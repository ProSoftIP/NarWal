import test from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from '../../src/readiness.js';

const READY = { phase: 'idle', tab: { ok: true, title: 'Dashboard' }, mic: 'granted', online: true, model: { state: 'ready' }, keys: {} };
const check = (result, id) => result.checks.find((c) => c.id === id);

test('everything ready: Start is allowed', () => {
  const r = readiness(READY, 'offline');
  assert.equal(r.canStart, true);
  assert.equal(r.firstBlocker, null);
  assert.deepEqual(r.checks.map((c) => c.state), ['ok', 'ok', 'ok']);
});

test('a tab that cannot be recorded blocks Start and says why', () => {
  const r = readiness({ ...READY, tab: { ok: false, reason: 'Browser and extension pages cannot be recorded. Open a website first.' } }, 'offline');
  assert.equal(r.canStart, false);
  assert.equal(check(r, 'tab').state, 'blocked');
  assert.match(check(r, 'tab').detail, /Open a website first/);
});

test('microphone: prompt asks, denied explains, unavailable offers a recheck', () => {
  const prompt = readiness({ ...READY, mic: 'prompt' }, 'offline');
  assert.equal(prompt.canStart, false);
  assert.deepEqual(check(prompt, 'mic').action, { id: 'request-mic', label: 'Allow microphone' });

  const denied = readiness({ ...READY, mic: 'denied' }, 'offline');
  assert.equal(denied.canStart, false);
  assert.equal(check(denied, 'mic').state, 'blocked');
  assert.match(check(denied, 'mic').detail, /no narration can be recorded/);
  assert.equal(denied.firstBlocker.id, 'mic');

  const none = readiness({ ...READY, mic: 'unavailable' }, 'offline');
  assert.equal(check(none, 'mic').action.id, 'refresh');
});

test('offline model: missing names the download size and blocks Start', () => {
  const r = readiness({ ...READY, model: { state: 'missing', bytesTotal: 43_500_000 } }, 'offline');
  assert.equal(r.canStart, false);
  const c = check(r, 'transcript');
  assert.equal(c.state, 'todo');
  assert.equal(c.action.id, 'download-model');
  assert.match(c.action.label, /about 44 MB/);
  assert.match(c.detail, /no internet/);
});

test('offline model: size unknown still offers the download, with no invented number', () => {
  const c = check(readiness({ ...READY, model: { state: 'missing' } }, 'offline'), 'transcript');
  assert.equal(c.action.label, 'Download speech model');
  assert.doesNotMatch(c.detail, /MB/);
});

test('offline model: downloading shows progress; failed offers a retry', () => {
  const busy = check(readiness({ ...READY, model: { state: 'downloading', bytesDone: 10, bytesTotal: 40 } }, 'offline'), 'transcript');
  assert.equal(busy.state, 'busy');
  assert.equal(busy.progress, 0.25);
  assert.match(busy.title, /25%/);

  const failed = readiness({ ...READY, model: { state: 'failed', error: 'The download stopped.' } }, 'offline');
  assert.equal(failed.canStart, false);
  assert.equal(check(failed, 'transcript').action.id, 'download-model');
  assert.equal(check(failed, 'transcript').detail, 'The download stopped.');
});

test('a missing offline model does not block a cloud choice, and the reverse', () => {
  const cloud = readiness({ ...READY, model: { state: 'missing' }, keys: { deepgram: true } }, 'deepgram');
  assert.equal(cloud.canStart, true);
  const offline = readiness({ ...READY, keys: {} }, 'offline');
  assert.equal(offline.canStart, true);
});

test('live provider: a missing key blocks Start; another provider key does not count', () => {
  for (const id of ['deepgram', 'assemblyai']) {
    const r = readiness({ ...READY, keys: { openai: true } }, id);
    assert.equal(r.canStart, false, id);
    assert.equal(check(r, 'transcript').action.id, 'focus-key');
  }
});

test('live provider with a key but no network is blocked, and points to the offline choice', () => {
  const r = readiness({ ...READY, online: false, keys: { deepgram: true } }, 'deepgram');
  assert.equal(r.canStart, false);
  assert.match(check(r, 'transcript').detail, /On this computer/);
});

test('no network does not block the offline choice', () => {
  assert.equal(readiness({ ...READY, online: false }, 'offline').canStart, true);
});

test('OpenAI is after recording: a missing key is a note, not a blocker', () => {
  const r = readiness(READY, 'openai');
  assert.equal(check(r, 'transcript').state, 'note');
  assert.equal(r.canStart, true);
  assert.match(check(r, 'transcript').detail, /record now/);
});

test('Start is not allowed while a recording is running', () => {
  for (const phase of ['starting', 'recording', 'stopping']) {
    assert.equal(readiness({ ...READY, phase }, 'offline').canStart, false, phase);
  }
  assert.equal(readiness({ ...READY, phase: 'saved' }, 'offline').canStart, true);
});

test('an unknown choice is blocked, not guessed', () => {
  assert.equal(readiness(READY, 'whisper-cloud').canStart, false);
});

test('a hidden area the page lost blocks Start and offers a new pick (#16592)', () => {
  const lost = readiness({ ...READY, hidden: 1, hiddenLost: 1 }, 'offline');
  assert.equal(lost.canStart, false);
  assert.equal(lost.firstBlocker.id, 'hidden');
  assert.equal(lost.firstBlocker.title, '1 hidden area could not be found');
  assert.equal(lost.firstBlocker.action.id, 'pick-regions');
  assert.equal(readiness({ ...READY, hiddenLost: 2 }, 'offline').firstBlocker.title, '2 hidden areas could not be found');
  // Areas the page still has do not block anything.
  const kept = readiness({ ...READY, hidden: 2, hiddenLost: 0 }, 'offline');
  assert.equal(kept.canStart, true);
  assert.equal(kept.checks.length, 3);
});

// Board #16603 review item 2: Start needs only the live model.
test('offline: a missing final model is a note; Start is allowed and the live transcript is kept', () => {
  const r = readiness({ ...READY, model: { state: 'ready', final: { state: 'missing', bytesDone: 0, bytesTotal: 249_700_000 } } }, 'offline');
  assert.equal(r.canStart, true);
  assert.equal(r.firstBlocker, null);
  const c = check(r, 'transcript');
  assert.equal(c.state, 'note');
  assert.match(c.detail, /You can record now/);
  assert.equal(c.action.id, 'download-model');
});

test('offline: a final model still downloading is a note with its progress', () => {
  const r = readiness({ ...READY, model: { state: 'ready', final: { state: 'downloading', bytesDone: 50, bytesTotal: 200 } } }, 'offline');
  assert.equal(r.canStart, true);
  assert.equal(check(r, 'transcript').state, 'note');
  assert.match(check(r, 'transcript').title, /25%/);
});

test('offline: every model ready is ok, and a missing live model still blocks Start', () => {
  assert.equal(check(readiness({ ...READY, model: { state: 'ready', final: { state: 'ready' } } }, 'offline'), 'transcript').state, 'ok');
  assert.equal(readiness({ ...READY, model: { state: 'missing', bytesTotal: 41e6, final: { state: 'ready' } } }, 'offline').canStart, false);
});
