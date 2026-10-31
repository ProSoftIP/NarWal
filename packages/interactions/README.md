# @narwal/interactions

Board #16543. Masked interaction evidence and explicit highlights for the
NarWal content script. The extension (board #16542) imports this package and
runs it in every frame next to rrweb. rrweb is only the capture/replay
primitive; this package decides what is private and what each interaction
means. Observation shapes follow `docs/bundle-schema.md` §6 (board #16541).

## Use

```js
import { record } from 'rrweb';
import { pickExcludedRegions, rrwebPrivacyOptions, startInteractionCapture } from '@narwal/interactions';

// Optional, before recording: the user hides regions.
const exclusions = await pickExcludedRegions().done;

const stopRecord = record({ emit: writeEvent, ...rrwebPrivacyOptions(exclusions) });
const capture = startInteractionCapture({
  doc: documentKey,               // the writer's key for this document
  exclusions,
  emit: writeObservation,         // the writer assigns `id`
  now: () => performance.timeOrigin + performance.now() - originEpochMs, // session ms
  nodeIdOf: (n) => { const id = record.mirror.getId(n); return id > 0 ? id : null; },
});
// ...
capture.stop();
stopRecord();
```

`capture.markFocused()` is the keyboard marker for a `chrome.commands`
binding.

Pass `now`. Bundle times are session ms (`docs/bundle-schema.md` §2). The
default clock returns epoch ms, which is correct only when the caller
subtracts `manifest.clock.originEpochMs` itself.

## What is recorded

| Kind | Basis | When |
| --- | --- | --- |
| `pointer-dwell` | derived | The pointer rests ≥ 300 ms on one element. The box is from arrival. |
| `click` | observed | Left and middle clicks. `count` is 2 for a double click. `point` is absent for keyboard activation. |
| `scroll` | observed | One record per settled scroll (250 ms quiet), for the document or a scrolling element. |
| `selection` | observed | The selection settles for 300 ms. A selection inside a form field names the field and has no text. |
| `input` | observed | One record per burst of edits to one field. The value is always `{state: 'masked'}`. |
| `route` | observed | Same-document URL changes: `history-push`, `history-replace`, `popstate`, `hash`. |
| `marker-element` | user-marked | Right-click, or the keyboard marker. |
| `marker-region` | user-marked | Right-button drag. `contains`: up to 10 elements, either at least half inside the box or holding visible text the box crosses. `text`: the visible page text inside the box, cut to the box. |
| `exclusion` | observed | An excluded region appears or is removed. |
| `viewport` | observed | At start and after each resize. |

Every `box`/`rect` is in viewport CSS px of the emitting document, measured
when the event happens. `scroll` is the document scroll offset at the same
moment, so `box + scroll` is the document position after later scrolls or
reflows.

## Privacy

- **Typed values:** rrweb masks every input with a fixed mask that does not
  show length. Observations never read a value. Names of fields come from
  labels, ARIA and placeholders, never from the value. Selected text inside a
  field is never read. The chosen `<select>` option is not recorded.
  Checkbox and radio state is recorded (`checked`).
- **Excluded regions:** the selectors from the picker, plus any element with
  `data-narwal-exclude`. rrweb keeps only a sized empty placeholder and ignores
  their mutations. Every observation inside one names the excluded root
  (`excluded: true`, no name). Excluded text is never part of a name, a
  selection or a marker box.
- **Recorder UI:** `[data-narwal-ui]` is blocked in rrweb, and events on it
  are ignored. The highlight overlay is a 0×0 `div.narwal-ui[data-narwal-ui]` host with a
  closed shadow root. It is made with the `attachShadow` saved at module load,
  so rrweb's shadow patch cannot see inside it.
- Visible page text is kept by default.

## Markers and the native context menu

While recording:

- **Right-click** marks the element under the pointer. The page receives none
  of the press, release or `contextmenu` events, so nothing activates and no
  page or native menu opens.
- **Right-button drag** of 6 CSS px or more draws a box. **Escape** cancels
  the drag.
- **Shift + right-click** is left alone, so the native menu opens. The menu
  key and Shift+F10 are also left alone.
- **Alt+Shift+M** marks the focused element. When nothing is focused, it
  marks the element under the pointer. This is the keyboard alternative.
- Each marker shows a short highlight and is announced in a polite live
  region.

Markers are `user-marked` and are always separate from `pointer-dwell`, which
is `derived`. No dwell is inferred during a marking gesture.

Only trusted events count. A page that dispatches its own pointer, mouse or
key events cannot make a marker, start or cancel a gesture, or record a form
edit; only real clicks and real `input`/`change` events are recorded.

## Region picker

`pickExcludedRegions()` runs before recording. While it runs, the page does not
react to the pointer.

- Hover outlines an element. Click toggles it.
- Tab moves focus. Space toggles the focused element.
- Arrow Up widens to the parent. Arrow Down narrows again.
- Enter finishes. Escape cancels: what was hidden when the picker opened is
  hidden again, and nothing else.
- Only trusted events count: a click a page script sends picks nothing.

The picker marks each chosen element with `data-narwal-exclude`. It resolves
with structural selectors (tag names and `:nth-of-type` only), which can be
reused after a reload. Shadow content is picked as its host, because rrweb's
`blockSelector` cannot cross a shadow boundary. A frame is picked as the
element around it (unless that is the body), because rrweb records the inside
of a blocked frame. An element the site marks with `data-narwal-exclude` is
locked, also when the site marks it while the picker is open: a click on it
says it is hidden by the site, and it is never in the picker's selectors. The
picker remembers the elements it marked, so a second picker on the same page
(no reload) keeps the first one's areas as the user's. `initial` hides
elements picked earlier when it opens.

The extension offers it as **Hide areas** in the popup
(`packages/extension/src/content/picker.js`, #16592).

## Test

Run `npm install`, then `npm run typecheck` and `npm test`. The tests use
node:test with Playwright Chromium against the pages in `test/fixtures`.
