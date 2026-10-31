import test from 'node:test';
import assert from 'node:assert/strict';
import { MIC_TEXT, microphoneChoices } from '../../src/mic-panel.js';

const mic = (deviceId, label) => ({ kind: 'audioinput', deviceId, label });
const DEVICES = [
  mic('default', 'Default - MacBook Pro Microphone (Built-in)'),
  mic('communications', 'Communications - Headset'),
  mic('builtin', 'MacBook Pro Microphone (Built-in)'),
  mic('headset', 'Jabra Evolve2 65'),
  { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
  { kind: 'videoinput', deviceId: 'cam', label: 'FaceTime HD Camera' },
];

test('board #16785: the list names each microphone once and the default by its device', () => {
  const c = microphoneChoices(DEVICES, null);
  assert.deepEqual(
    c.options.map((o) => [o.value, o.label]),
    [
      ['', 'Default: MacBook Pro Microphone (Built-in)'],
      ['builtin', 'MacBook Pro Microphone (Built-in)'],
      ['headset', 'Jabra Evolve2 65'],
    ],
  );
  assert.equal(c.selected, '');
  assert.equal(c.missing, null);
  assert.equal(c.count, 2);
});

test('the saved microphone is selected; a gone one is named and the default is used', () => {
  assert.equal(microphoneChoices(DEVICES, { id: 'headset', label: 'Jabra Evolve2 65' }).selected, 'headset');
  const gone = microphoneChoices(DEVICES, { id: 'usb-1', label: 'Blue Yeti' });
  assert.equal(gone.selected, '');
  assert.equal(gone.missing, 'Blue Yeti');
  assert.match(MIC_TEXT.missing(gone.missing), /^Blue Yeti is not connected\. NarWal records with the default microphone/);
});

test('no microphones, and devices without names (no permission yet)', () => {
  const none = microphoneChoices([], null);
  assert.equal(none.count, 0);
  assert.deepEqual(none.options, [{ value: '', label: 'Default microphone' }]);
  const unnamed = microphoneChoices([mic('a', ''), mic('b', '')], null);
  assert.deepEqual(unnamed.options.map((o) => o.label), ['Default microphone', 'Microphone 1', 'Microphone 2']);
});
