# Following windows the recorded tab opens (board #16754)

Question (Matt): "if NarWal is recording and you pop up another window we
need to potentially be able to record that window. Is that something we
could do?"

Decision (Matt, q3582, Telegram 2026-10-15 18:38Z): record **only the window
the person switches to, also on other websites**.

## Verdict

Yes, for windows the browser lets the page open. A tab or popup opened by a
recorded tab is a candidate. It is recorded from the moment the person
switches to it (it opens in front, or later by tab switch or window focus)
until it closes, on any site. One the person never switches to is never
recorded. Everything stays one session on one clock: one stream per window,
`window` observations for opened, switched-to and closed, and replay shows
the window in front (schema 1.1, `docs/bundle-schema.md` §5).

## How it works

- The service worker sees a new window from the recorded tab through
  `webNavigation.onCreatedNavigationTarget` (its `sourceTabId`) and
  `tabs.onCreated` (its `openerTabId`). Either makes it a candidate; a tab
  opened by a followed window is a candidate too.
- A candidate is followed when it is active at creation, or on
  `tabs.onActivated` / `windows.onFocusChanged` to it. Following adds it to
  the offscreen recorder's set of tabs and injects the content script into it
  (all frames), so a page that loaded before the switch joins at once.
- Closing a followed window ends its stream (`closed`); closing the first tab
  stops the recording, as before. Other tabs are still refused.
- Restricted pages in a followed window are gaps of that window only, so the
  first tab's page is not blanked.

## Measurement

Headless harness: `node test/e2e/run.mjs popupFollow` in
`packages/extension` (Playwright 1.63.0, Chrome for Testing 153.0.8010.12,
Linux x64, fake microphone, local fixture site only). The recorded
companies page opens a background tab it never switches to, a sign-in popup
(`window.open` with popup features) that the person marks in and that
closes itself, and a `target=_blank` tab the person switches away from and
back to before closing it. The exported bundle is validated and replayed.

Three runs on 2026-10-15, all 23 checks passed each time:

| Run | Popup: click to opened | Popup: opened to first snapshot | New tab: click to opened | New tab: opened to first snapshot |
| --- | --- | --- | --- | --- |
| 1 | 61 ms | 30 ms | 59 ms | 91 ms |
| 2 | 84 ms | 168 ms | 45 ms | 236 ms |
| 3 | 52 ms | 29 ms | 48 ms | 65 ms |

What each run showed:

- The background tab was a candidate, never followed; its URL is nowhere in
  the bundle.
- The popup and the new tab were followed from their first page and each had
  its own rrweb stream; the in-page strip appeared in the popup.
- The mark in the popup is a `marker-element` on the popup's document, with
  `window=w2` in the walkthrough and the agent view.
- Window lines, in order: opened w2, closed w2, opened w3, switched to w1,
  switched to w3, switched to w1, closed w3.
- Replay showed the popup while it was in front, the companies page once it
  closed, the new tab while it was in front, and the companies page after
  the switch back. Screenshots: `docs/images/replay-two-windows-*.png`.
- The popup's URL query value was not in the bundle.

## Not measured

- **Focus between windows.** Headless Chromium never fires
  `windows.onFocusChanged`: neither Playwright's `bringToFront` nor
  `chrome.windows.update({ focused: true })` moved focus in this harness. The
  switch lines above come from tab switches in one window
  (`tabs.onActivated`). Switching back and forth between the first tab and a
  popup window uses the same code path but was not exercised. The manual
  Edge run below was the test for it and was not run.
- **Manual Edge run with a real sign-in popup.** Not run. Decision (Matt,
  q3593, Telegram 2026-10-22 08:02Z): "Skip it: the headless result is
  enough". So two things are not measured: a real provider's popup
  (another site, redirects) and focus between windows (the item above).
- Popups the browser blocks are never created, so there is nothing to see
  or record.
- **narwal-review.** The maintainers' review tool pins a NarWal commit from
  before 1.1. On the two-windows fixture its old validator says VALID with
  warnings, rebuilds the walkthrough without windows, and lists a mark made
  in the first window under the popup's route. Pinning a commit with this
  change and naming each finding's window is board #16776.

## Manual Edge run with a real sign-in popup (board #16790)

Status: not run (see "Not measured" above). Use this protocol and checker
if someone asks for the run later.

A person records in Microsoft Edge on a Mac. The checker on a Linux machine then reads
the exported bundle. This run covers the two things the headless harness
cannot: a real provider's popup (another site, redirects) and focus moving
between two separate windows (`windows.onFocusChanged`).

Page: the FirebaseUI demo, `https://fir-ui-demo-84a6c.firebaseapp.com/`
(Google's own demo of Firebase sign-in). **Sign In with Popup** opens
`/widget` in a popup window with `window.open`. **Sign in with Google** in
that popup goes to `accounts.google.com`. No sign-in is needed: the popup is
closed by hand.

Protocol:

1. Load the current build: `edge://extensions`, press **Reload** under
   narwal. Edge loads an unpacked extension when it starts, so a build
   copied in while Edge was open is not running yet.
2. Open the demo page and press the narwal button, then **Start recording**.
3. Say a sentence, then press **Sign In with Popup**. The popup opens in
   front.
4. In the popup, press **Sign in with Google**. Wait for the Google page.
5. Click the first window (the demo page) so that it comes to the front.
   Then click the popup again.
6. In the popup, right-click the Google page's heading to mark it.
7. Close the popup with its close button. If Google opened in a second
   popup, close that one too.
8. Press **Stop** on the strip, then **Export**. The bundle is saved in
   Downloads.

Check (in `packages/extension`, after `node build.mjs --test`):

```sh
NARWAL_BUNDLE=<file.narwal.zip> playwright-libs run -- node test/e2e/run.mjs realPopupBundle
```

It checks that the bundle is valid and schema 1.1; a popup window was
opened by a recorded window and closed before stop; a popup holds a page on
another site than the recorded tab; each captured popup page has its own
rrweb stream; the window lines say opened and closed for each popup; focus
moved to the recorded tab and back to a popup while the popup was open; a
mark was made in a popup; the walkthrough has the window lines and the mark
with its `window=`; the agent view lists the mark in its window; no URL
query or fragment value is kept; replay shows the popup while it is in
front, and the recorded tab at the end. The results file also lists the
browser, the windows, the window lines, the origin of each page and, for
each popup, the time from its opened line to its first full snapshot.

Control: the checker run on the headless `popupFollow` bundle (2026-10-15)
passed 11 checks and failed the two that only a real browser can pass: the
popup page is on the same site as the recorded tab, and no focus moved
between windows while the popup was open.

Result: not run (see "Not measured" above). The result of record is the
headless measurement in "Measurement" (23 of 23 checks, three runs).
