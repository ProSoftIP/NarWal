// Hide parts of the page before recording (board #16592; Matt, INTERVIEW-04:
// "let me exclude sensitive areas before recording"). The popup's "Hide
// areas" button has the service worker inject this script into the top frame
// of the tab, then call `__narwalPicker.open(selectors)`.
//
// It runs the region picker of packages/interactions (pickExcludedRegions):
// each picked element gets `data-narwal-exclude`, which the recording blocks
// from its first snapshot. A one-line bar at the bottom says what to do and
// has Done. Every change goes to the service worker with the page it was made
// on (origin and path only): each area is its structural selector and the
// fingerprint of the element (src/shared/hidden-regions.js), so Start can
// check that the selector still finds that element, and the areas still apply
// after a reload of that page. Areas the site marks are not the user's: they
// are never reported or counted.
//
// The service worker also calls `__narwalPicker.check(areas)` here: Start and
// the popup count only the areas this page still has.
import { pickExcludedRegions } from '../../../interactions/src/index.ts';
import { markNarwalUi } from '../../../recorder-ui/src/capture-exclusion.js';
import { adoptCss, h } from '../../../recorder-ui/src/dom.js';
import { fingerprintOf, pageKey, resolveAreas } from '../shared/hidden-regions.js';

const BAR_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  z-index: 2147483647 !important;
  display: block !important;
}
@media print { :host { display: none !important; } }
.bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 4px 10px;
  background: #141417;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
  font: 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #f5f5f4;
}
.badge { flex: none; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #7cb4f0; }
.text { flex: 1 1 auto; min-width: 0; color: #d6d3d1; }
.count { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.btn {
  flex: none;
  box-sizing: border-box;
  height: 24px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid #1971c2;
  background: #1971c2;
  color: #ffffff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.btn:hover { background: #1864ab; }
.btn:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
`;

const countText = (n) => (n === 0 ? 'Nothing hidden' : n === 1 ? '1 area hidden' : `${n} areas hidden`);

// The picked selectors as areas: each with the fingerprint of the one element it finds.
function areasOf(selectors) {
  const areas = [];
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    if (matches.length === 1) areas.push({ selector, fp: fingerprintOf(matches[0]) });
  }
  return areas;
}

function report(areas, done) {
  return chrome.runtime
    .sendMessage({ to: 'sw', cmd: 'regions-picked', page: pageKey(location.href), areas, done })
    .catch(() => {});
}

function showBar(onDone) {
  const host = markNarwalUi(h(document, 'div'), 'picker');
  const shadow = host.attachShadow({ mode: 'closed' });
  adoptCss(shadow, BAR_CSS);
  const count = h(document, 'span', { class: 'count', role: 'status', 'aria-live': 'polite' });
  const done = h(document, 'button', { class: 'btn', type: 'button', text: 'Done', on: { click: onDone } });
  shadow.append(
    h(
      document,
      'div',
      { class: 'bar', role: 'region', 'aria-label': 'NarWal: hide parts of the page' },
      h(document, 'span', { class: 'badge', text: 'Hide areas' }),
      h(document, 'span', {
        class: 'text',
        text: 'Click each part of the page to leave out of the recording. Click it again to show it. Arrow Up makes the outline bigger. Enter or Done when you finish; Escape cancels.',
      }),
      count,
      done,
    ),
  );
  (document.body || document.documentElement).appendChild(host);
  return { host, setCount: (n) => (count.textContent = countText(n)) };
}

let running = null;

/**
 * Starts picking. `stored` are the areas picked earlier on this page: the ones
 * this page still has are hidden again first; the others are dropped.
 */
function open(stored = []) {
  if (running) return running.picker.selectors().length;
  const bar = showBar(() => picker.finish());
  const picker = pickExcludedRegions({
    initial: resolveAreas(document, stored).found.map((f) => f.element),
    onChange: (selectors) => {
      const areas = areasOf(selectors);
      bar.setCount(areas.length);
      report(areas, false);
    },
  });
  running = { picker, bar };
  const areas = areasOf(picker.selectors());
  bar.setCount(areas.length);
  report(areas, false);
  picker.done.then((selectors) => {
    bar.host.remove();
    running = null;
    report(areasOf(selectors), true);
  });
  return picker.selectors().length;
}

/** Ends picking (Start pressed while the picker runs). Returns the areas, or null when it was not running. */
function finish() {
  if (!running) return null;
  const areas = areasOf(running.picker.selectors());
  running.picker.finish();
  return areas;
}

/** How many of the areas this page still has, and how many it lost. */
function check(areas = []) {
  const { found, lost } = resolveAreas(document, areas);
  return { found: found.length, lost };
}

globalThis.__narwalPicker ||= { open, finish, check };
