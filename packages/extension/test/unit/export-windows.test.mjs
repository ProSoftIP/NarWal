// Board #16754: a popup the recorded tab opened, once the person switched to
// it, is in the same bundle: its own window and stream, window lines in the
// walkthrough, and replay shows the window in front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeBundle } from '../../src/export/bundle.js';
import { analyze } from '../../src/shared/analyze.js';
import { loadReplay, stateAt } from '../../../replay/src/index.ts';

const T0 = 1_760_385_600_000;
const dec = new TextDecoder();
const lines = (bytes) => dec.decode(bytes).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chunk = (seq, entries) => ({ seq, startAt: entries[0].t, endAt: entries[entries.length - 1].t, entries });
const producer = { name: 'narwal-extension', version: '0.1.0' };
const environment = { browser: 'Chrome', browserVersion: '155.0.0.0', platform: 'linux' };
const box = { x: 10, y: 20, w: 100, h: 30 };
const scroll = { x: 0, y: 0 };
const el = (node, tag, name) => ({ node, tag, role: 'button', name, nameSource: 'text', box });
const page = { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [] }] };

// Tab 7 records; it opens popup 9 (followed at once), the person switches
// back and forth, closes the popup, then opens tab 11 on a restricted page.
// Tab 12 is opened too but never switched to, so nothing of it is here.
function recording({ follow = true } = {}) {
  const attach = (t, doc, documentId, tabId, url) => ({ k: 'attach', t, doc, documentId, tabId, windowId: tabId === 7 ? 1 : 2, frameId: 0, url, reason: 'boot', boot: { inst: `i-${doc}`, isTop: true, navType: 'navigate' } });
  const snap = (t, doc) => ({ k: 'rr', t, doc, seq: 1, sent: t, e: { type: 2, timestamp: t, data: { node: page, initialOffset: { left: 0, top: 0 } } } });
  const obs = (t, doc, o) => ({ k: 'obs', t, doc, seq: 2, sent: t, o: { doc: `i-${doc}`, ...o } });
  const nav = (t, type, more) => ({ k: 'nav', type, t, ...more });
  const followed = follow
    ? [
        nav(2000, 'tabFollowed', { tabId: 9, windowId: 2, openerTabId: 7, windowType: 'popup', url: 'https://login.vendor.example.test/authorize?client_id=abc&state=xyz', title: 'Sign in' }),
        nav(2005, 'committed', { tabId: 9, frameId: 0, documentId: 'POP1', url: 'https://login.vendor.example.test/authorize?client_id=abc&state=xyz', transitionType: 'link' }),
        attach(2010, 'p2', 'POP1', 9, 'https://login.vendor.example.test/authorize?client_id=abc&state=xyz'),
        snap(2020, 'p2'),
        obs(3000, 'p2', { kind: 'marker-element', basis: 'user-marked', atMs: 3000, target: el(22, 'button', 'Allow access'), via: 'right-click', point: { x: 15, y: 25 }, scroll }),
        nav(4000, 'tabActivated', { activeTabId: 7, windowId: 1, recorded: true }),
        nav(4500, 'tabActivated', { activeTabId: 12, windowId: 1, recorded: false }),
        nav(5000, 'windowFocused', { activeTabId: 9, windowId: 2, recorded: true }),
        nav(6000, 'tabClosed', { tabId: 9 }),
        { k: 'detach', t: 6000, doc: 'p2', error: null },
        nav(6050, 'windowFocused', { activeTabId: 7, windowId: 1, recorded: true }),
        nav(6500, 'tabFollowed', { tabId: 11, windowId: 1, openerTabId: 7, windowType: 'normal', url: 'chrome://newtab/', title: 'New Tab' }),
        nav(6510, 'committed', { tabId: 11, frameId: 0, documentId: 'NT1', url: 'chrome://newtab/', transitionType: 'link' }),
      ]
    : [];
  const entries = [
    { k: 'session', type: 'start', t: 0, tabId: 7 },
    attach(10, 'p1', 'TOP1', 7, 'https://app.example.test/companies'),
    snap(20, 'p1'),
    obs(1000, 'p1', { kind: 'click', basis: 'observed', atMs: 1000, target: el(31, 'button', 'Connect bank'), button: 'left', count: 1, point: { x: 1, y: 2 }, scroll }),
    ...followed,
    { k: 'session', type: 'stop', t: 7000 },
  ]
    .map((e) => ({ ...e, t: T0 + e.t }))
    .map((e) => (e.k === 'rr' ? { ...e, sent: e.t, e: { ...e.e, timestamp: e.t } } : e))
    .sort((a, b) => a.t - b.t);
  const meta = { id: '1b2c1e0a-1111-4222-8333-444455556666', status: 'stopped', tabId: 7, startedAt: T0, stoppedAt: T0 + 7000, title: 'Companies', url: 'https://app.example.test/companies' };
  return { meta, eventChunks: [chunk(0, entries)], audioChunks: [], producer, environment };
}

test('a followed popup is its own window, with its own document and stream', async () => {
  const { files, manifest, warnings } = await writeBundle(recording());
  assert.deepEqual(warnings, []);
  assert.equal(manifest.schemaVersion, '1.1');
  const { documents, windows } = JSON.parse(dec.decode(files.get('documents.json')));
  assert.deepEqual(windows, [
    { key: 'w1', opener: null, type: 'tab', openedMs: 0, closedMs: null },
    { key: 'w2', opener: 'w1', type: 'popup', openedMs: 2000, closedMs: 6000 },
    { key: 'w3', opener: 'w1', type: 'tab', openedMs: 6500, closedMs: null },
  ]);
  assert.deepEqual(documents.map((d) => [d.key, d.window, d.url, d.rrweb]), [
    ['d1', 'w1', 'https://app.example.test/companies', 'rrweb/d1.jsonl'],
    ['d2', 'w2', 'https://login.vendor.example.test/authorize?client_id=_&state=_', 'rrweb/d2.jsonl'],
  ]);
});

test('opened, switched and closed are window lines; a switch to an unrecorded tab is not', async () => {
  const { files } = await writeBundle(recording());
  const obs = lines(files.get('observations.jsonl'));
  assert.deepEqual(
    obs.filter((o) => o.kind === 'window').map((o) => [o.atMs, o.window, o.state, o.opener ?? null, o.url ?? null, o.title ?? null]),
    [
      [2000, 'w2', 'opened', 'w1', 'https://login.vendor.example.test/authorize?client_id=_&state=_', 'Sign in'],
      [4000, 'w1', 'focused', null, null, null],
      [5000, 'w2', 'focused', null, null, null],
      [6000, 'w2', 'closed', null, null, null],
      [6500, 'w3', 'opened', 'w1', 'chrome://newtab/', 'New Tab'],
    ],
  );
  assert.equal(obs.find((o) => o.kind === 'marker-element').doc, 'd2');
  const gaps = lines(files.get('gaps.jsonl')).filter((g) => g.reason === 'restricted-page');
  assert.deepEqual(gaps.map((g) => [g.startMs, g.endMs, g.window, g.doc ?? null]), [[6510, 7000, 'w3', null]]);

  const md = dec.decode(files.get('agent/walkthrough.md'));
  assert.match(md, /opened window w2 from w1 "Sign in"/);
  assert.match(md, /switched to window w1/);
  assert.match(md, /closed window w2/);
  assert.match(md, /marked element "Allow access" button \| window=w2/);
  assert.ok(!/client_id=abc|state=xyz/.test(md + dec.decode(files.get('documents.json')) + dec.decode(files.get('observations.jsonl'))));
});

test('replay shows the window in front, and a restricted page in a window only covers that window', async () => {
  const { files } = await writeBundle(recording());
  const { model } = await loadReplay(files);
  const at = (t) => {
    const s = stateAt(model, t);
    return [s.window, s.page?.docKey ?? null];
  };
  assert.deepEqual(at(1000), ['w1', 'd1']);
  assert.deepEqual(at(3000), ['w2', 'd2']);
  assert.deepEqual(at(4200), ['w1', 'd1']);
  assert.deepEqual(at(5500), ['w2', 'd2']);
  assert.deepEqual(at(6200), ['w1', 'd1']);
  // The new tab is in front on a page no extension can record.
  assert.deepEqual(at(6800), ['w3', null]);
});

test('a recording with no followed window writes schema 1.1 with no window fields', async () => {
  const { files } = await writeBundle(recording({ follow: false }));
  const parsed = JSON.parse(dec.decode(files.get('documents.json')));
  assert.equal(parsed.windows, undefined);
  assert.ok(parsed.documents.every((d) => d.window === undefined));
  assert.ok(!lines(files.get('observations.jsonl')).some((o) => o.kind === 'window'));
  assert.doesNotMatch(dec.decode(files.get('agent/walkthrough.md')), /window/i);
});

test('restricted-page gaps are per tab: the anchor’s next page does not end a popup’s gap', () => {
  const entries = [
    { k: 'nav', type: 'committed', t: 10, tabId: 7, frameId: 0, documentId: 'A', url: 'https://a.test/' },
    { k: 'attach', t: 11, doc: 'p1', documentId: 'A', tabId: 7, frameId: 0, url: 'https://a.test/', reason: 'boot' },
    { k: 'nav', type: 'committed', t: 20, tabId: 9, frameId: 0, documentId: 'P', url: 'chrome://settings/' },
    { k: 'nav', type: 'committed', t: 30, tabId: 7, frameId: 0, documentId: 'B', url: 'https://a.test/b' },
    { k: 'attach', t: 31, doc: 'p2', documentId: 'B', tabId: 7, frameId: 0, url: 'https://a.test/b', reason: 'boot' },
    { k: 'nav', type: 'tabReplaced', t: 35, tabId: 19, replacedTabId: 9 },
    { k: 'nav', type: 'tabClosed', t: 40, tabId: 19 },
  ];
  const rec = analyze({ meta: { status: 'stopped', startedAt: 0, stoppedAt: 50 }, eventChunks: [chunk(0, entries)], audioChunks: [] });
  assert.deepEqual(rec.gaps.filter((g) => g.reason === 'restricted-page').map((g) => [g.from, g.to, g.tabId]), [[20, 40, 9]]);
});
