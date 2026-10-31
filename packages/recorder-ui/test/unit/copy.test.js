// The words a first-time user reads: what is downloaded, what is uploaded,
// and how to mark things. These tests pin the facts, not the phrasing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTION_STEPS, MARK_SHORTCUT, MIN_BOX_DRAG_PX } from '../../src/gestures.js';
import { DEFAULT_TRANSCRIPTION, formatDownloadSize, normaliseTranscription, PRIVACY_NOTES, providerById, PROVIDERS, PURPOSE_FIELD } from '../../src/providers.js';

test('the default sends nothing anywhere', () => {
  assert.equal(DEFAULT_TRANSCRIPTION, 'offline');
  assert.equal(providerById('offline').needs, 'model');
  assert.equal(normaliseTranscription('nonsense'), 'offline');
  assert.equal(normaliseTranscription('deepgram'), 'deepgram');
});

test('every choice explains itself and says how to set it up', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['offline', 'deepgram', 'assemblyai', 'openai']);
  for (const p of PROVIDERS) {
    assert.ok(p.label && p.tag && p.explain.length > 40 && p.setup.length > 20, p.id);
  }
});

test('the offline choice explains the one-time download and that speech stays here', () => {
  const text = `${providerById('offline').explain} ${providerById('offline').setup}`;
  assert.match(text, /download/i);
  assert.match(text, /one-time download/i);
  assert.match(text, /does not leave/i);
  assert.match(text, /this computer/i);
});

test('every cloud choice says the voice is sent to that company, and whose key pays', () => {
  for (const id of ['deepgram', 'assemblyai', 'openai']) {
    const p = providerById(id);
    assert.equal(p.needs, 'key', id);
    assert.ok(p.keyLabel, id);
    assert.match(p.explain, new RegExp(`audio (is sent )?to ${p.label.split(' ')[0]}`), id);
    assert.match(p.setup, new RegExp(`your own ${p.label.split(' ')[0]} key`), id);
    assert.match(p.setup, /charges your/, id);
  }
  assert.equal(providerById('openai').timing, 'after-recording');
  assert.match(providerById('openai').explain, /after/i);
});

test('the privacy notes cover what is uploaded, where keys live, and no silent switch', () => {
  const all = PRIVACY_NOTES.join(' ');
  assert.match(all, /voice/i);
  assert.match(all, /key/i);
  assert.match(all, /never/i);
});

test('download sizes are rounded and never invented', () => {
  assert.equal(formatDownloadSize(43_500_000), 'about 44 MB');
  assert.equal(formatDownloadSize(85_400_000), 'about 85 MB');
  assert.equal(formatDownloadSize(0), '');
  assert.equal(formatDownloadSize(undefined), '');
});

test('the instructions name the gestures the capture code implements (#16543)', () => {
  assert.equal(MIN_BOX_DRAG_PX, 6);
  assert.equal(MARK_SHORTCUT, 'Alt+Shift+M');
  const step = (id) => INSTRUCTION_STEPS.find((s) => s.id === id);
  assert.deepEqual(INSTRUCTION_STEPS.map((s) => s.id), ['talk', 'mark', 'box', 'tab', 'private', 'stop']);
  const mark = `${step('mark').title} ${step('mark').body}`;
  assert.match(mark, /right-click/i);
  assert.match(mark, /hold Shift and right-click/);
  assert.match(mark, /page menu does not open/);
  assert.match(mark, /Alt\+Shift\+M/);
  const box = `${step('box').title} ${step('box').body}`;
  assert.match(box, /right mouse button/i);
  assert.match(box, /Esc/);
});

test('the first-use instructions say how to hide part of the page (#16592)', () => {
  const step = INSTRUCTION_STEPS.find((s) => s.id === 'private');
  assert.match(step.body, /Hide areas before you start/);
});

test('the purpose field is optional, says where the words go, and matches the schema cap (#16594)', () => {
  assert.equal(PURPOSE_FIELD.label, 'What is this recording for?');
  assert.match(PURPOSE_FIELD.hint, /^Optional\./);
  assert.match(PURPOSE_FIELD.hint, /exported recording/);
  assert.ok(PURPOSE_FIELD.placeholder.length > 20 && PURPOSE_FIELD.placeholder.length < 120);
  assert.equal(PURPOSE_FIELD.maxLength, 1000);
});
