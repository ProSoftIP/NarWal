import test from 'node:test';
import assert from 'node:assert/strict';
import { startFlow } from '../../src/flow.js';

const FIRST = { view: 'setup', skipInstructions: false };
const READY = { canStart: true };

test('first use: Start shows the instructions and does not record yet', () => {
  const r = startFlow(FIRST, { type: 'start-pressed' }, READY);
  assert.equal(r.state.view, 'instructions');
  assert.deepEqual(r.effects, []);
});

test('Start now begins the recording', () => {
  const r = startFlow({ ...FIRST, view: 'instructions' }, { type: 'start-now' }, READY);
  assert.deepEqual(r.effects, [{ type: 'start' }]);
  assert.equal(r.state.view, 'setup');
});

test("ticking Don't show instructions again is saved at once", () => {
  const r = startFlow({ ...FIRST, view: 'instructions' }, { type: 'set-skip', value: true }, READY);
  assert.deepEqual(r.effects, [{ type: 'save-skip', value: true }]);
  assert.equal(r.state.skipInstructions, true);
  assert.equal(r.state.view, 'instructions');
});

test('unticking saves false; the same value saves nothing', () => {
  const skipped = { view: 'instructions', skipInstructions: true };
  assert.deepEqual(startFlow(skipped, { type: 'set-skip', value: false }, READY).effects, [{ type: 'save-skip', value: false }]);
  assert.deepEqual(startFlow(skipped, { type: 'set-skip', value: true }, READY).effects, []);
});

test('instructions skipped: Start records at once', () => {
  const r = startFlow({ view: 'setup', skipInstructions: true }, { type: 'start-pressed' }, READY);
  assert.deepEqual(r.effects, [{ type: 'start' }]);
  assert.equal(r.state.view, 'setup');
});

test('not ready: Start does nothing, with or without the skip', () => {
  for (const skipInstructions of [false, true]) {
    const r = startFlow({ view: 'setup', skipInstructions }, { type: 'start-pressed' }, { canStart: false });
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.view, 'setup');
  }
});

test('Start now when readiness was lost goes back to the checks and does not record', () => {
  const r = startFlow({ ...FIRST, view: 'instructions' }, { type: 'start-now' }, { canStart: false });
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.view, 'setup');
});

test('the instructions can be opened again after they were skipped, and Back returns', () => {
  const skipped = { view: 'setup', skipInstructions: true };
  const open = startFlow(skipped, { type: 'show-instructions' }, READY);
  assert.equal(open.state.view, 'instructions');
  assert.equal(open.state.skipInstructions, true);
  assert.equal(startFlow(open.state, { type: 'back' }, READY).state.view, 'setup');
});
