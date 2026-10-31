// A NarWal page holds a new build's reload only while it is in use (board #17009).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_IDLE_MS, PAGE_IN_USE_LOCK, isTextField, pageInUse } from '../../src/shared/page-use.js';
import { guardPage } from '../../src/ui/page-guard.js';

function page({ visible = true } = {}) {
  const p = { t: 0, listeners: {}, timers: [], held: 0, requests: 0 };
  p.media = [];
  p.doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (type, fn) => (p.listeners[type] ||= []).push(fn),
    querySelectorAll: (sel) => (sel === 'audio, video' ? p.media : []),
  };
  p.locks = {
    request: async (name, options, fn) => {
      assert.equal(name, PAGE_IN_USE_LOCK);
      assert.equal(options.mode, 'shared');
      p.requests++;
      p.held++;
      await fn();
      p.held--;
    },
  };
  p.fire = (type, target = {}) => (p.listeners[type] || []).forEach((fn) => fn({ target }));
  p.hide = () => {
    p.doc.visibilityState = 'hidden';
    p.fire('visibilitychange');
  };
  // Runs the timer that is due, as the browser would.
  p.advance = async (ms) => {
    p.t += ms;
    const due = p.timers.filter((x) => !x.cleared && x.at <= p.t);
    for (const x of due) {
      x.cleared = true;
      x.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  p.guard = guardPage({
    doc: p.doc,
    locks: p.locks,
    now: () => p.t,
    setTimer: (fn, ms) => {
      const x = { fn, at: p.t + ms, cleared: false };
      p.timers.push(x);
      return x;
    },
    clearTimer: (x) => x && (x.cleared = true),
  });
  return p;
}

// A tiny DOM: elements with a parent, buttons found inside, contains().
function node(tagName, parent = null, extra = {}) {
  const n = { tagName, parentElement: parent, kids: [], isConnected: true, value: '', ...extra };
  if (parent) parent.kids.push(n);
  n.contains = (other) => {
    for (let el = other; el; el = el.parentElement) if (el === n) return true;
    return false;
  };
  n.querySelector = (sel) => {
    const walk = (el) => el.kids.find((k) => k.tagName === sel.toUpperCase()) || el.kids.map(walk).find(Boolean) || null;
    return walk(n);
  };
  n.closest = (sel) => {
    for (let el = n; el; el = el.parentElement) if (el.tagName === sel.toUpperCase()) return el;
    return null;
  };
  return n;
}
// The replay page: a note form with its Add note button, and Play elsewhere.
function replayPage() {
  const body = node('BODY');
  const form = node('DIV', body);
  const note = node('TEXTAREA', form);
  const add = node('BUTTON', node('DIV', form));
  const play = node('BUTTON', node('DIV', body));
  return { note, add, play };
}

test('a page shown holds the reload; hidden and left alone for ten minutes it lets go', async () => {
  const p = page();
  await p.advance(0);
  assert.equal(p.guard.inUse(), true);
  assert.equal(p.held, 1);
  p.hide();
  await p.advance(PAGE_IDLE_MS - 60000);
  assert.equal(p.guard.inUse(), true, 'hidden a moment ago: still in use');
  await p.advance(2 * 60000);
  assert.equal(p.guard.inUse(), false);
  assert.equal(p.held, 0, 'the lock is released');
});

test('a page shown again takes the lock again', async () => {
  const p = page();
  p.hide();
  await p.advance(PAGE_IDLE_MS + 2000);
  assert.equal(p.held, 0);
  p.doc.visibilityState = 'visible';
  p.fire('visibilitychange');
  await p.advance(0);
  assert.equal(p.held, 1);
  assert.equal(p.requests, 2);
});

test('typed text not saved holds the reload in a hidden page until the button beside it saves it', async () => {
  const p = page();
  const { note, add, play } = replayPage();
  note.value = 'the header is wrong';
  p.fire('input', note);
  p.fire('click', play);
  p.hide();
  await p.advance(PAGE_IDLE_MS * 6);
  assert.equal(p.guard.inUse(), true, 'Play is not Add note: an hour later the note is still unsaved');
  p.fire('click', add);
  await p.advance(PAGE_IDLE_MS + 2000);
  assert.equal(p.guard.inUse(), false);
});

test('typed text that was emptied, or a box the page took away (Save, Cancel on an edit row), is not unsaved', async () => {
  for (const end of [(f) => (f.value = ''), (f) => (f.isConnected = false)]) {
    const p = page();
    const { note } = replayPage();
    note.value = 'x';
    p.fire('input', note);
    end(note);
    p.hide();
    await p.advance(PAGE_IDLE_MS + 2000);
    assert.equal(p.guard.inUse(), false);
  }
});

test('a recording playing in a hidden tab holds the reload; ten minutes after it stops it lets go', async () => {
  const p = page();
  const audio = { paused: false, ended: false };
  p.media.push(audio);
  p.fire('play', audio);
  p.hide();
  await p.advance(PAGE_IDLE_MS * 3);
  assert.equal(p.guard.inUse(), true, 'still playing half an hour later');
  audio.ended = true;
  p.fire('ended', audio);
  await p.advance(PAGE_IDLE_MS - 60000);
  assert.equal(p.guard.inUse(), true, 'it stopped a moment ago');
  await p.advance(2 * 60000);
  assert.equal(p.guard.inUse(), false);
});

test('a search box or a slider is not unsaved work', async () => {
  const p = page();
  p.fire('input', { tagName: 'INPUT', type: 'search', value: 'dash', isConnected: true });
  p.fire('input', { tagName: 'INPUT', type: 'range', value: '40', isConnected: true });
  p.hide();
  await p.advance(PAGE_IDLE_MS + 2000);
  assert.equal(p.guard.inUse(), false);
});

test('the e2e hook stands in for a hidden, idle tab, and null hands back to the real state', async () => {
  const p = page();
  p.guard.force({ visible: false, idle: true });
  await p.advance(0);
  assert.equal(p.guard.inUse(), false);
  p.guard.force(null);
  assert.equal(p.guard.inUse(), true);
});

test('pageInUse and isTextField', () => {
  assert.equal(pageInUse({ visible: true, lastUsedAt: 0, unsaved: false, now: 1e9 }), true);
  assert.equal(pageInUse({ visible: false, lastUsedAt: 0, unsaved: true, now: 1e9 }), true);
  assert.equal(pageInUse({ visible: false, playing: true, lastUsedAt: 0, unsaved: false, now: 1e9 }), true);
  assert.equal(pageInUse({ visible: false, lastUsedAt: 1e9 - PAGE_IDLE_MS + 1, unsaved: false, now: 1e9 }), true);
  assert.equal(pageInUse({ visible: false, lastUsedAt: 1e9 - PAGE_IDLE_MS, unsaved: false, now: 1e9 }), false);
  assert.equal(isTextField({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextField({ tagName: 'TEXTAREA', readOnly: true }), false);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextField({ tagName: 'INPUT' }), true);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextField({ tagName: 'BUTTON' }), false);
  assert.equal(isTextField(null), false);
});
