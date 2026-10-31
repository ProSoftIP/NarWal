// Holds a new build's reload while this NarWal page is in use (board #17009,
// src/shared/page-use.js). In use: the page is shown, it plays a recording's
// sound, it had a click or key press in the last ten minutes (it counts as
// used when it opens, when it is hidden and when playing stops), or a text
// box holds typed text. Typed text counts until a button next to the box
// (Save, Add note, Cancel; Enter and Escape press them) is pressed, the box
// is emptied, or the page takes the box away. The worker reads the lock with
// navigator.locks.query(); the browser drops it when the page closes.
import { PAGE_IDLE_MS, PAGE_IN_USE_LOCK, isTextField, pageInUse } from '../shared/page-use.js';

export function guardPage({ doc = document, locks = navigator.locks, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, idleMs = PAGE_IDLE_MS } = {}) {
  let lastUsedAt = now();
  // Text boxes the person typed in that no button next to them has saved or cancelled.
  const edited = new Set();
  let release = null;
  let timer = null;
  // The e2e run stands in for the tab being hidden and left alone.
  let forced = null;

  const hold = () => {
    let done;
    const held = new Promise((resolve) => (done = resolve));
    release = done;
    locks.request(PAGE_IN_USE_LOCK, { mode: 'shared' }, () => held).catch(() => {});
  };
  const visible = () => (forced ? forced.visible : doc.visibilityState === 'visible');
  const playing = () => !forced && [...doc.querySelectorAll('audio, video')].some((m) => !m.paused && !m.ended);
  const unsavedText = () => {
    for (const field of edited) if (!field.isConnected || !field.value) edited.delete(field);
    return edited.size > 0;
  };
  const update = () => {
    clearTimer(timer);
    timer = null;
    const unsaved = unsavedText();
    const state = { visible: visible(), playing: playing(), lastUsedAt: forced && forced.idle ? -Infinity : lastUsedAt, unsaved, now: now(), idleMs };
    const inUse = pageInUse(state);
    if (inUse && !release) hold();
    if (!inUse && release) {
      release();
      release = null;
    }
    // Hidden and used a moment ago: look again when the ten minutes are up.
    if (inUse && !state.visible && !state.playing && !unsaved) timer = setTimer(update, Math.max(1000, state.lastUsedAt + idleMs - state.now + 1000));
  };
  const used = () => {
    lastUsedAt = now();
    update();
  };

  doc.addEventListener('pointerdown', used, { capture: true, passive: true });
  doc.addEventListener('keydown', used, { capture: true, passive: true });
  doc.addEventListener(
    'input',
    (event) => {
      if (isTextField(event.target)) edited.add(event.target);
      used();
    },
    { capture: true, passive: true },
  );
  // A button next to a text box (in the nearest box around it that has a
  // button) ends its edit: Save, Add note, Cancel. Play elsewhere does not.
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      const pressed = target && typeof target.closest === 'function' ? target.closest('button') : null;
      if (pressed) for (const field of edited) if (besideButtons(field)?.contains(pressed)) edited.delete(field);
      used();
    },
    { capture: true, passive: true },
  );
  doc.addEventListener('visibilitychange', used);
  // Media events do not bubble; the capture phase sees them on the document.
  for (const type of ['play', 'pause', 'ended']) doc.addEventListener(type, used, { capture: true, passive: true });
  update();

  return {
    inUse: () => Boolean(release),
    // Test hook only (NARWAL_TEST builds): { visible, idle } in place of the tab's real state; null ends it.
    force: (state) => {
      forced = state;
      update();
    },
  };
}

/** The nearest element around `field` that holds a button: the field's own form, edit row or dialog. */
function besideButtons(field) {
  for (let el = field.parentElement; el; el = el.parentElement) if (el.querySelector('button')) return el;
  return null;
}

/** Guards the page that calls it; each NarWal page calls it once as it loads. */
export function guardThisPage() {
  const guard = guardPage();
  if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST) globalThis.narwalPageGuard = guard;
  return guard;
}
