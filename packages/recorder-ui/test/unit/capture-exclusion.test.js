import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureFilter, isNarwalUiEvent, markNarwalUi, RRWEB_RECORD_OPTIONS, UI_ATTR, UI_CLASS, UI_SELECTOR } from '../../src/capture-exclusion.js';

// rrweb 2 shapes: node type 0 document, 2 element, 3 text.
const el = (id, tagName, attributes = {}, childNodes = []) => ({ type: 2, id, tagName, attributes, childNodes });
const text = (id, textContent) => ({ type: 3, id, textContent });
const snapshot = (...htmlChildren) => ({
  type: 2,
  timestamp: 1,
  data: { node: { type: 0, id: 1, childNodes: [el(2, 'html', {}, htmlChildren)] }, initialOffset: { left: 0, top: 0 } },
});
const mutation = (data) => ({ type: 3, timestamp: 2, data: { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data } });
// What rrweb 2.1.7 records for a blocked element: class and size, nothing else.
const HOST = (id) => el(id, 'div', { class: UI_CLASS, rr_width: '1280px', rr_height: '34px' });

test('the rrweb option blocks the same mark the filter removes', () => {
  assert.equal(UI_SELECTOR, '[data-narwal-ui]');
  assert.deepEqual({ ...RRWEB_RECORD_OPTIONS }, { blockSelector: '[data-narwal-ui]' });
});

test('markNarwalUi sets the attribute the selector finds and the class the filter finds', () => {
  const attrs = {};
  const classes = new Set();
  const host = { setAttribute: (k, v) => (attrs[k] = v), classList: { add: (c) => classes.add(c) } };
  assert.equal(markNarwalUi(host, 'strip'), host);
  assert.deepEqual(attrs, { [UI_ATTR]: 'strip' });
  assert.deepEqual([...classes], [UI_CLASS]);
});

test('a host recorded without blocking (attribute kept) is removed too', () => {
  const filter = createCaptureFilter();
  const out = filter(snapshot(el(3, 'body'), el(5, 'div', { [UI_ATTR]: 'strip' })));
  assert.deepEqual(out.data.node.childNodes[0].childNodes.map((n) => n.id), [3]);
});

test('a page element whose class only looks similar is kept', () => {
  const filter = createCaptureFilter();
  const event = snapshot(el(3, 'body', {}, [el(4, 'div', { class: 'narwal-ui-kit not-narwal-ui' })]));
  assert.equal(filter(event), event);
});

test('a snapshot with no controls is passed through untouched (same object)', () => {
  const filter = createCaptureFilter();
  const event = snapshot(el(3, 'body', {}, [text(4, 'hello')]));
  assert.equal(filter(event), event);
});

test('controls in a full snapshot are removed and the input is not changed', () => {
  const filter = createCaptureFilter();
  const event = snapshot(el(3, 'body', {}, [text(4, 'hello')]), HOST(5));
  const out = filter(event);
  assert.doesNotMatch(JSON.stringify(out), /narwal/i);
  assert.deepEqual(out.data.node.childNodes[0].childNodes.map((n) => n.id), [3]);
  assert.equal(event.data.node.childNodes[0].childNodes.length, 2, 'the caller keeps its own event');
});

test('controls added after the snapshot: the add is dropped, and so is the whole event when nothing else is in it', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body')));
  assert.equal(filter(mutation({ adds: [{ parentId: 2, nextId: null, node: HOST(9) }] })), null);
});

test('a page change in the same mutation as the controls is kept', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body')));
  const out = filter(
    mutation({
      adds: [
        { parentId: 2, nextId: null, node: HOST(9) },
        { parentId: 3, nextId: null, node: el(10, 'p') },
      ],
      texts: [{ id: 4, value: 'page text' }],
    }),
  );
  assert.deepEqual(out.data.adds.map((a) => a.node.id), [10]);
  assert.deepEqual(out.data.texts, [{ id: 4, value: 'page text' }]);
});

test('controls inside an added subtree (a same-origin iframe attached to the page) are removed', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body', {}, [el(4, 'iframe')])));
  const frameDoc = { type: 0, id: 20, childNodes: [el(21, 'html', {}, [el(22, 'body', {}, [el(23, 'button'), HOST(24)])])] };
  const event = mutation({ adds: [{ parentId: 4, nextId: null, node: frameDoc }], isAttachIframe: true });
  const copy = structuredClone(event);
  const out = filter(event);
  assert.deepEqual(event, copy);
  assert.ok(!JSON.stringify(out).includes(UI_CLASS));
  assert.deepEqual(out.data.adds[0].node.childNodes[0].childNodes[0].childNodes.map((n) => n.id), [23]);
  assert.equal(out.data.isAttachIframe, true);
  assert.equal(filter(mutation({ attributes: [{ id: 24, attributes: { style: 'x' } }] })), null);
});

test('later events that point at the controls are dropped; page events are kept', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5)));
  const incremental = (data) => ({ type: 3, timestamp: 3, data });
  assert.equal(filter(incremental({ source: 2, type: 2, id: 5, x: 10, y: 700 })), null, 'click on the strip');
  assert.equal(filter(incremental({ source: 3, id: 5, x: 0, y: 0 })), null, 'scroll in the strip');
  assert.equal(filter(mutation({ attributes: [{ id: 5, attributes: { style: 'x' } }] })), null);
  assert.equal(filter(mutation({ removes: [{ parentId: 2, id: 5 }] })), null);
  const click = incremental({ source: 2, type: 2, id: 3, x: 10, y: 10 });
  assert.equal(filter(click), click);
  const meta = { type: 4, timestamp: 1, data: { href: 'https://example.test/', width: 1280, height: 720 } };
  assert.equal(filter(meta), meta);
});

test('mouse movement over the controls is removed from a mixed batch', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5)));
  const out = filter({
    type: 3,
    timestamp: 3,
    data: { source: 1, positions: [{ x: 1, y: 1, id: 3, timeOffset: -20 }, { x: 1, y: 700, id: 5, timeOffset: 0 }] },
  });
  assert.deepEqual(out.data.positions.map((p) => p.id), [3]);
  assert.equal(filter({ type: 3, timestamp: 4, data: { source: 1, positions: [{ x: 1, y: 700, id: 5, timeOffset: 0 }] } }), null);
});

test('a page node inserted before the controls is inserted before what follows them', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5), el(6, 'div', { id: 'toast-root' })));
  const out = filter(mutation({ adds: [{ parentId: 2, nextId: 5, node: el(11, 'div') }] }));
  assert.equal(out.data.adds[0].nextId, 6);
});

test('...and at the end when the node after the controls has been removed', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5), el(6, 'div')));
  filter(mutation({ removes: [{ parentId: 2, id: 6 }] }));
  const out = filter(mutation({ adds: [{ parentId: 2, nextId: 5, node: el(11, 'div') }] }));
  assert.equal(out.data.adds[0].nextId, null);
});

test('two NarWal hosts side by side (strip and mark highlight) leave no dangling id', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5), el(6, 'div', { class: `${UI_CLASS} other` })));
  const out = filter(mutation({ adds: [{ parentId: 2, nextId: 5, node: el(11, 'div') }] }));
  assert.equal(out.data.adds[0].nextId, null);
});

test('a new full snapshot starts again: old ids no longer count', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body'), HOST(5)));
  filter(snapshot(el(3, 'body', {}, [el(5, 'main')])));
  const click = { type: 3, timestamp: 9, data: { source: 2, type: 2, id: 5, x: 1, y: 1 } };
  assert.equal(filter(click), click);
});

test('a selection that ends in the controls is removed from the event', () => {
  const filter = createCaptureFilter();
  filter(snapshot(el(3, 'body', {}, [text(4, 'hello')]), HOST(5)));
  const out = filter({
    type: 3,
    timestamp: 3,
    data: { source: 14, ranges: [{ start: 4, startOffset: 0, end: 4, endOffset: 2 }, { start: 4, startOffset: 0, end: 5, endOffset: 0 }] },
  });
  assert.equal(out.data.ranges.length, 1);
});

test('isNarwalUiEvent: true for an event whose path holds a NarWal host', () => {
  const host = { nodeType: 1, hasAttribute: (name) => name === UI_ATTR };
  const page = { nodeType: 1, hasAttribute: () => false };
  assert.equal(isNarwalUiEvent({ composedPath: () => [host, page] }), true);
  assert.equal(isNarwalUiEvent({ composedPath: () => [page] }), false);
  assert.equal(isNarwalUiEvent({ target: { nodeType: 1, hasAttribute: () => false, closest: () => null } }), false);
});
