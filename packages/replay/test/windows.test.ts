// Board #16754: a recording that followed a popup replays the window in
// front, switches when the person switches, and says which window it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReplay } from '../src/load.ts';
import { describeWindow } from '../src/labels.ts';
import { stateAt } from '../src/model.ts';

const dir = fileURLToPath(new URL('../../bundle/fixtures/good/two-windows/', import.meta.url));
function filesOf(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), readFileSync(p));
    }
  };
  walk(root);
  return out;
}

const { model, warnings } = await loadReplay(filesOf(dir));

test('each window has its own page span and the windows are listed', () => {
  assert.deepEqual(warnings, []);
  assert.deepEqual(model.spans, [
    { docKey: 'd1', fromMs: 0, toMs: 30000, window: 'w1' },
    { docKey: 'd2', fromMs: 8000.5, toMs: 20000, window: 'w2' },
  ]);
  assert.deepEqual(
    model.windows.map((w) => [w.key, w.number, w.type, w.opener, w.title]),
    [
      ['w1', 1, 'tab', null, 'Companies'],
      ['w2', 2, 'popup', 'w1', 'Sign in to Vendor'],
    ],
  );
});

test('focus follows opened, switched and closed windows; a closed window hands back to its opener', () => {
  assert.deepEqual(
    model.focus.map((f) => [f.window, f.fromMs, f.toMs]),
    [
      ['w1', 0, 8000],
      ['w2', 8000, 15000],
      ['w1', 15000, 18000],
      ['w2', 18000, 20000],
      ['w1', 20000, 30000],
    ],
  );
});

test('a seek shows the page of the window in front, with that window’s marks', () => {
  const at = (t: number) => {
    const s = stateAt(model, t);
    return [s.window, s.page?.docKey ?? null, s.markers.map((m) => m.id)];
  };
  assert.deepEqual(at(5000), ['w1', 'd1', []]);
  assert.deepEqual(at(12000), ['w2', 'd2', ['o7']]);
  assert.deepEqual(at(16000), ['w1', 'd1', ['o9']]);
  assert.deepEqual(at(19500), ['w2', 'd2', ['o11']]);
  assert.deepEqual(at(25000), ['w1', 'd1', []]);
  assert.deepEqual(at(30000), ['w1', 'd1', []]);
});

test('the only page gap is before the first snapshot; the popup’s gaps do not invent more', () => {
  assert.deepEqual(
    model.gaps.filter((g) => g.effect === 'no-page').map((g) => [g.reason, g.startMs, g.endMs]),
    [['no-page-evidence', 0, 6.75]],
  );
});

test('the window label says which window and where it came from', () => {
  assert.equal(describeWindow(model.windows, 'w1'), 'Window 1 of 2: the tab the recording started in');
  assert.equal(describeWindow(model.windows, 'w2'), 'Window 2 of 2: popup opened from window 1');
  assert.equal(describeWindow([], null), '');
});
