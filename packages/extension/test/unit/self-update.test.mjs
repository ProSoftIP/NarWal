// An unpacked NarWal reloads itself when a new build is in its folder (board #17009).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTORE_WITHIN_MS, createSelfUpdate, heldEntry, isNewBuild, reloadBlocker, restoreTabs, tabsToRestore } from '../../src/sw/self-update.js';

const RUNNING = { version: '1.0.3', commit: 'bda549a' };
const FOLDER_SAME = { name: 'NarWal', version: '1.0.3', commit: 'bda549a7d7', short: 'bda549a', dirty: false };
const FOLDER_NEW = { name: 'NarWal', version: '1.0.4', commit: 'c0ffee1234', short: 'c0ffee1', dirty: false };

function world({ installType = 'development', folder = FOLDER_NEW, blocker = null, tried = null } = {}) {
  const w = { reloads: 0, saved: [], held: [], logs: [], order: [] };
  w.check = createSelfUpdate({
    running: RUNNING,
    installType: async () => installType,
    readFolderBuild: async () => {
      if (folder instanceof Error) throw folder;
      return folder;
    },
    blocker: async () => blocker,
    lastReload: async () => tried,
    saveReload: async (entry) => w.saved.push(entry),
    noteHeld: async (held) => w.held.push(held),
    beforeReload: async () => w.order.push('tabs-written'),
    reload: () => {
      w.order.push('reload');
      w.reloads++;
    },
    log: (text) => w.logs.push(text),
  });
  return w;
}

test('a new build in the folder of an unpacked install reloads once, and records which build', async () => {
  const w = world();
  assert.equal(await w.check('alarm'), 'reloading');
  assert.equal(w.reloads, 1);
  assert.equal(w.saved.length, 1);
  assert.deepEqual({ short: w.saved[0].short, version: w.saved[0].version, from: w.saved[0].from, trigger: w.saved[0].trigger }, { short: 'c0ffee1', version: '1.0.4', from: 'bda549a', trigger: 'alarm' });
  assert.match(w.logs[0], /c0ffee1.*reloading/);
  assert.deepEqual(w.order, ['tabs-written', 'reload'], 'the NarWal tabs are written down before the reload');
});

test('the same build in the folder does nothing', async () => {
  const w = world({ folder: FOLDER_SAME });
  assert.equal(await w.check('alarm'), 'same');
  assert.equal(w.reloads, 0);
  assert.equal(w.saved.length, 0);
});

test('a store install (or an unknown install type) never reloads itself', async () => {
  for (const installType of ['normal', 'store', 'admin', 'sideload', null]) {
    const w = world({ installType });
    assert.equal(await w.check('alarm'), 'not-unpacked', String(installType));
    assert.equal(w.reloads, 0);
  }
});

test('a folder with no readable build.json (mid-swap, an old build) never reloads', async () => {
  for (const folder of [null, new Error('Failed to fetch'), {}, { short: '', version: '1.0.4' }, { short: 'c0ffee1' }]) {
    const w = world({ folder });
    assert.ok(['unreadable', 'same'].includes(await w.check('alarm')));
    assert.equal(w.reloads, 0);
  }
});

test('work in progress holds the reload; the next check after it ends reloads', async () => {
  const busy = world({ blocker: 'recording' });
  assert.equal(await busy.check('alarm'), 'busy:recording');
  assert.equal(busy.reloads, 0);
  assert.equal(busy.saved.length, 0, 'a held reload is not recorded as tried');
  const idle = world({ blocker: null });
  assert.equal(await idle.check('alarm'), 'reloading');
});

test('a held reload writes down which build waits and why; one that goes ahead clears it', async () => {
  const busy = world({ blocker: 'page-in-use' });
  await busy.check('alarm');
  assert.deepEqual(busy.held, [{ short: 'c0ffee1', version: '1.0.4', why: 'page-in-use' }]);
  const idle = world();
  await idle.check('alarm');
  assert.deepEqual(idle.held, [null], 'cleared before the reload');
  const same = world({ folder: FOLDER_SAME });
  await same.check('alarm');
  assert.deepEqual(same.held, [null], 'cleared when the folder build already runs (a Reload click or an Edge restart)');
});

test('heldEntry: written when the build or reason changes, kept since the build first waited', () => {
  const t1 = new Date('2026-10-31T19:00:00Z');
  const t2 = new Date('2026-10-31T19:05:00Z');
  const first = heldEntry(null, { short: 'c0ffee1', version: '1.0.4', why: 'page-in-use' }, t1);
  assert.deepEqual(first, { short: 'c0ffee1', version: '1.0.4', why: 'page-in-use', since: t1.toISOString(), at: t1.toISOString() });
  assert.equal(heldEntry(first, { short: 'c0ffee1', version: '1.0.4', why: 'page-in-use' }, t2), null, 'an unchanged wait is not written again');
  const recording = heldEntry(first, { short: 'c0ffee1', version: '1.0.4', why: 'recording' }, t2);
  assert.deepEqual(recording, { short: 'c0ffee1', version: '1.0.4', why: 'recording', since: t1.toISOString(), at: t2.toISOString() });
  const newer = heldEntry(recording, { short: 'beef123', version: '1.0.5', why: 'recording' }, t2);
  assert.equal(newer.since, t2.toISOString(), 'a newer folder build starts its own wait');
});

test('a folder build it already reloaded for is never reloaded for again (no loop)', async () => {
  const w = world({ tried: { short: 'c0ffee1', version: '1.0.4' } });
  assert.equal(await w.check('worker-start'), 'tried');
  assert.equal(w.reloads, 0);
  // A later build in the folder is a new attempt.
  const later = world({ tried: { short: 'c0ffee1', version: '1.0.4' }, folder: { ...FOLDER_NEW, short: 'deadbee', version: '1.0.5' } });
  assert.equal(await later.check('alarm'), 'reloading');
});

test('isNewBuild: a different commit or version is new; a missing field is not', () => {
  assert.equal(isNewBuild(RUNNING, FOLDER_NEW), true);
  assert.equal(isNewBuild(RUNNING, { ...FOLDER_SAME, version: '1.0.4' }), true);
  assert.equal(isNewBuild(RUNNING, { ...FOLDER_SAME, short: 'bda549a-dirty' }), true);
  assert.equal(isNewBuild(RUNNING, FOLDER_SAME), false);
  assert.equal(isNewBuild(RUNNING, null), false);
  assert.equal(isNewBuild(null, FOLDER_NEW), false);
});

test('reloadBlocker: a recording, a save, the recorder, the popup or a page in use holds the reload; an idle page does not', () => {
  const ctx = (...types) => [{ contextType: 'BACKGROUND' }, ...types.map((contextType) => ({ contextType }))];
  assert.equal(reloadBlocker({ live: { id: 'r1' }, stopping: null, contexts: ctx() }), 'recording');
  assert.equal(reloadBlocker({ live: null, stopping: { id: 'r1' }, contexts: ctx() }), 'saving');
  assert.equal(reloadBlocker({ live: null, stopping: null, contexts: ctx('OFFSCREEN_DOCUMENT') }), 'recorder');
  assert.equal(reloadBlocker({ live: null, stopping: null, contexts: ctx('POPUP') }), 'popup-open');
  assert.equal(reloadBlocker({ live: null, stopping: null, contexts: ctx('TAB'), pagesInUse: true }), 'page-in-use');
  // Board #17009: Saved recordings and replay tabs left in the background held every build for twelve days.
  assert.equal(reloadBlocker({ live: null, stopping: null, contexts: ctx('TAB', 'TAB', 'TAB'), pagesInUse: false }), null);
  assert.equal(reloadBlocker({ live: null, stopping: null, contexts: ctx() }), null);
  assert.equal(reloadBlocker({ live: undefined, stopping: undefined, contexts: undefined }), null);
});

const PREFIX = 'chrome-extension://gpfc/';

test('tabsToRestore: every tab showing a NarWal page, sleeping ones too, and nothing else', () => {
  const tabs = [
    { id: 1, windowId: 9, index: 0, url: 'https://example.com/', active: true },
    { id: 2, windowId: 9, index: 1, url: `${PREFIX}recordings.html`, pinned: true },
    { id: 3, windowId: 9, index: 2, url: `${PREFIX}replay.html?id=abc`, discarded: true },
    { id: 4, windowId: 9, index: 3 }, // no url: another extension's page
    { id: 5, windowId: 7, index: 0, url: 'chrome-extension://other/recordings.html' },
  ];
  assert.deepEqual(tabsToRestore(tabs, PREFIX), [
    { tabId: 2, windowId: 9, index: 1, pinned: true, active: false, url: `${PREFIX}recordings.html` },
    { tabId: 3, windowId: 9, index: 2, pinned: false, active: false, url: `${PREFIX}replay.html?id=abc` },
  ]);
  assert.deepEqual(tabsToRestore(undefined, PREFIX), []);
});

function browser({ tabs = {}, windows = [9] } = {}) {
  const b = { created: [], updated: [], cleared: 0 };
  b.deps = {
    clear: async () => b.cleared++,
    getTab: async (id) => tabs[id] || null,
    getWindow: async (id) => (windows.includes(id) ? { id } : null),
    update: async (id, props) => b.updated.push({ id, ...props }),
    create: async (props) => b.created.push(props),
  };
  return b;
}

const NOW = Date.parse('2026-10-31T18:00:00Z');
const SAVED = {
  at: new Date(NOW - 5000).toISOString(),
  tabs: [
    { tabId: 3, windowId: 9, index: 4, pinned: false, active: false, url: `${PREFIX}replay.html?id=abc` },
    { tabId: 2, windowId: 9, index: 1, pinned: true, active: true, url: `${PREFIX}recordings.html` },
  ],
};

test('restoreTabs: tabs the reload closed open again in their window, in order, at their place', async () => {
  const b = browser();
  assert.equal(await restoreTabs({ saved: SAVED, now: NOW, ...b.deps }), 2);
  assert.equal(b.cleared, 1);
  assert.deepEqual(b.created, [
    { url: `${PREFIX}recordings.html`, active: true, pinned: true, windowId: 9, index: 1 },
    { url: `${PREFIX}replay.html?id=abc`, active: false, pinned: false, windowId: 9, index: 4 },
  ]);
});

test('restoreTabs: a tab the browser kept loads again; a sleeping one is left; a closed window opens in the current one', async () => {
  const kept = browser({ tabs: { 2: { id: 2, url: `${PREFIX}recordings.html`, status: 'complete' }, 3: { id: 3, url: `${PREFIX}replay.html?id=abc`, discarded: true } } });
  assert.equal(await restoreTabs({ saved: SAVED, now: NOW, ...kept.deps }), 1);
  assert.deepEqual(kept.updated, [{ id: 2, url: `${PREFIX}recordings.html` }]);
  assert.deepEqual(kept.created, []);
  const gone = browser({ windows: [] });
  await restoreTabs({ saved: SAVED, now: NOW, ...gone.deps });
  assert.deepEqual(gone.created.map((t) => Object.keys(t).sort()), [['active', 'pinned', 'url'], ['active', 'pinned', 'url']]);
});

test('restoreTabs: once, and never from an old or broken list', async () => {
  const none = browser();
  assert.equal(await restoreTabs({ saved: null, now: NOW, ...none.deps }), 0);
  assert.equal(none.cleared, 0);
  for (const saved of [{ ...SAVED, at: new Date(NOW - RESTORE_WITHIN_MS - 1000).toISOString() }, { ...SAVED, at: 'not a date' }, { at: SAVED.at }]) {
    const b = browser();
    assert.equal(await restoreTabs({ saved, now: NOW, ...b.deps }), 0);
    assert.equal(b.cleared, 1, 'the list is removed even when it is not used');
    assert.deepEqual(b.created, []);
  }
  // One tab that fails does not stop the next.
  const flaky = browser();
  let calls = 0;
  flaky.deps.create = async (props) => {
    if (calls++ === 0) throw new Error('No window with id: 9');
    flaky.created.push(props);
  };
  assert.equal(await restoreTabs({ saved: SAVED, now: NOW, ...flaky.deps }), 1);
  assert.equal(flaky.created.length, 1);
});
