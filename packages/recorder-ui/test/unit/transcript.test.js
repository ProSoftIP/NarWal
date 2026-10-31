import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscript, formatClock } from '../../src/transcript.js';

const seg = (segmentKey, kind, startMs, endMs, text) => ({ type: 'segment', segment: { segmentKey, kind, startMs, endMs, text } });

test('formatClock', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(59_999), '00:59');
  assert.equal(formatClock(1_800_000), '30:00');
  assert.equal(formatClock(3_600_000), '1:00:00');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(undefined), '00:00');
});

test('an interim is replaced by later text for the same segment, then by the final', () => {
  const t = createTranscript();
  t.apply(seg('a', 'interim', 0, 500, 'this sh'));
  t.apply(seg('a', 'interim', 0, 900, 'this should'));
  assert.deepEqual(t.lines().map((l) => [l.kind, l.text]), [['interim', 'this should']]);
  t.apply(seg('a', 'final', 0, 1200, 'This should collapse.'));
  assert.deepEqual(t.lines().map((l) => [l.kind, l.text]), [['final', 'This should collapse.']]);
});

test('a late interim never replaces settled text; a second final does (formatted copy)', () => {
  const t = createTranscript();
  t.apply(seg('a', 'final', 0, 1200, 'this should collapse'));
  assert.equal(t.apply(seg('a', 'interim', 0, 800, 'this sh')), false);
  assert.equal(t.lines()[0].text, 'this should collapse');
  t.apply(seg('a', 'final', 0, 1200, 'This should collapse.'));
  assert.equal(t.lines()[0].text, 'This should collapse.');
});

test('lines are in time order whatever order they arrive in; empty text is left out', () => {
  const t = createTranscript();
  t.apply(seg('b', 'final', 5000, 6000, 'second'));
  t.apply(seg('a', 'final', 1000, 2000, 'first'));
  t.apply(seg('c', 'interim', 7000, 7100, '   '));
  assert.deepEqual(t.lines().map((l) => l.text), ['first', 'second']);
});

test('a gap is shown in place, in plain words, and says the recording has that part', () => {
  const t = createTranscript();
  t.apply(seg('a', 'final', 1000, 2000, 'before'));
  t.apply({ type: 'gap', gap: { startMs: 21_000, endMs: 34_000, reason: 'disconnected' } });
  t.apply(seg('b', 'final', 35_000, 36_000, 'after'));
  const lines = t.lines();
  assert.deepEqual(lines.map((l) => l.kind), ['final', 'gap', 'final']);
  assert.equal(lines[1].text, 'No transcript from 00:21 to 00:34: connection lost. The recording has this part.');
});

test('tail is the newest words, without gap text, cut from the front', () => {
  const t = createTranscript();
  t.apply(seg('a', 'final', 0, 1000, 'one two three'));
  t.apply({ type: 'gap', gap: { startMs: 1000, endMs: 2000, reason: 'disconnected' } });
  t.apply(seg('b', 'interim', 2000, 3000, 'four five'));
  assert.equal(t.tail(), 'one two three four five');
  assert.equal(t.tail(9), '…four five');
});

test('clear empties it', () => {
  const t = createTranscript();
  t.apply(seg('a', 'final', 0, 1000, 'one'));
  t.clear();
  assert.deepEqual(t.lines(), []);
  assert.equal(t.tail(), '');
});
