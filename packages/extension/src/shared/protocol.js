// Names shared by the service worker, offscreen recorder, content script and
// extension pages.
export const PORT_NAME = 'narwal-capture';
export const SCRIPT_ID = 'narwal-recorder';
export const WATCHDOG_ALARM = 'narwal-watchdog';
// chrome.commands name and tab message for the keyboard marker (Alt+Shift+M).
export const MARK_FOCUSED = 'mark-focused';

// Options sent to every attached document. `DOMContentLoaded` puts the first
// snapshot within milliseconds of commit instead of after every subresource
// (board #16538, design point 5).
export const CAPTURE_OPTIONS = { recordAfter: 'DOMContentLoaded' };

// Pages no extension can script. A recording may still pass through them;
// the gap is labelled from webNavigation (no attached document).
export function recordableUrl(url) {
  if (!url) return { ok: false, reason: 'This tab has no page to record.' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'This tab has no page to record.' };
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Browser and extension pages cannot be recorded. Open a website first.' };
  }
  if (parsed.hostname === 'chromewebstore.google.com' || (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    return { ok: false, reason: 'The Chrome Web Store cannot be recorded.' };
  }
  return { ok: true };
}
