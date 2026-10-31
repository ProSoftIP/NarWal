// When an open NarWal page holds a new build's reload (board #17009).
//
// Each NarWal page (Saved recordings, replay, Options, the model page, the
// microphone permission page) holds the Web Lock PAGE_IN_USE_LOCK while it is
// in use (src/ui/page-guard.js). The worker reloads for a new build in the
// folder only when no page holds it, and opens the NarWal tabs again after
// the reload (src/sw/self-update.js). A page left open in a background tab
// therefore no longer holds the reload for days.

export const PAGE_IN_USE_LOCK = 'narwal-page-in-use';
// A page hidden this long with no click or key press is not in use.
export const PAGE_IDLE_MS = 10 * 60 * 1000;

/**
 * True while a reload would take something from the person using the page:
 * the page is shown, it plays sound or video, it was used in the last
 * `idleMs`, or it holds typed text that was not saved or cancelled.
 */
export function pageInUse({ visible, playing = false, lastUsedAt, unsaved, now, idleMs = PAGE_IDLE_MS }) {
  if (visible || playing || unsaved) return true;
  return now - lastUsedAt < idleMs;
}

/** A field whose typed text is lost by a reload: a text box or a textarea (not search or a slider). */
export function isTextField(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return !el.readOnly;
  if (tag !== 'INPUT') return false;
  return !el.readOnly && ['text', 'email', 'url', 'tel', 'number', 'password'].includes(String(el.type || 'text').toLowerCase());
}
