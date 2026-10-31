# Browser capture and navigation continuity (board #16538)

Slice A of the NarWal map (#16531). Question: can a Chrome/Edge MV3 extension
keep rrweb page evidence and microphone audio for one selected tab across
navigation, on one timeline we can trust?

Probe, fixtures and reproduction steps: [`research/capture/`](../../research/capture/README.md).
Measured summary: [`research/capture/results/2026-10-13-chromium-153-linux.json`](../../research/capture/results/2026-10-13-chromium-153-linux.json).

## Verdict

Yes, inside stated bounds. With the design below, the probe lost no page
evidence and no messages over 7 minutes, 42 documents and 21 navigations in
headless Chromium 153. Every marker written into the page was in the
recording, including markers written in the same task that started a
navigation.

It is not universal. Some pages cannot be recorded at all (restricted pages),
some content is invisible to rrweb (closed shadow roots, cross-origin frame
content unless we inject there too), and some evidence is costly (canvas).
Backgrounding, sleep, Edge and real microphone clocks are not measured yet;
the manual protocol in the probe README covers them. The product must label
each gap in the bundle, never hide it.

## Method

- Probe extension (`research/capture/extension/`): service worker, offscreen
  document, rrweb 2.1.7 content script, report page.
- Fixture site served on two origins (`127.0.0.1` and `localhost`), so
  cross-origin navigation and cross-site frames are real. No production site
  was touched.
- Playwright 1.63.0 drives Chrome for Testing 153.0.8010.12, headless, Linux
  x64, with Chromium's fake microphone. The harness turns the back/forward
  cache back on (Playwright disables it by default).
- Each scenario writes markers into the page (`<p data-marker>`) and checks
  that the marker text is in the rrweb stream. Every content-script message
  carries a per-document sequence number and send time; the offscreen
  document stamps receive time. Gaps in sequence numbers are lost messages.
- All clocks are `performance.timeOrigin + performance.now()` in each
  context, which share one wall-clock base in Chromium.

## Design that held

1. **Offscreen document as the only sink.** One offscreen document
   (`USER_MEDIA` reason) owns the microphone and receives every content-script
   port through `chrome.runtime.onConnect`. The service worker only starts,
   stops and forwards `webNavigation` events. Stopping the worker
   mid-recording (`workerRestart`) lost nothing: two worker boots in the log,
   all 4 markers captured. Offscreen documents with reasons other than
   `AUDIO_PLAYBACK` have no lifetime limit.
2. **Registered `document_start` script in all frames.**
   `scripting.registerContentScripts` with `runAt: document_start`,
   `allFrames`, `matchOriginAsFallback`, `persistAcrossSessions: false`,
   plus one `executeScript` into frames already open at start. The script
   connects as soon as it runs, so a new document is attached before rrweb's
   first snapshot.
3. **`<all_urls>` host permission.** `activeTab` "is revoked when the user
   navigates away", so it cannot follow a recording across origins. The
   product needs a host permission for every origin the user may visit while
   recording (an optional host permission requested at first record is
   enough).
4. **Detach before the back/forward cache.** Since Chrome 123 a page that
   enters the bfcache has its extension ports closed. Messages posted on that
   port before the page learns of it are dropped without error. With the
   naive design the probe lost 8 lifecycle messages in one journey
   (`navigationNaiveBfcache`). Fix, measured lossless: on
   `pagehide(persisted)` drop the port and queue locally; on
   `pageshow(persisted)` reconnect and call `record.takeFullSnapshot()`.
5. **`recordAfter: 'DOMContentLoaded'`.** rrweb's default `'load'` waits for
   every subresource. On a page with a 2.5 s image the first snapshot came
   2521 ms after commit and an early marker appeared only inside that late
   snapshot. With `'DOMContentLoaded'`: 15 ms, marker latency 1 ms.
6. **Document identity from the browser, not the URL.** Each port carries
   `sender.documentId`, `frameId` and `documentLifecycle`; `webNavigation`
   events carry `documentId`, `parentDocumentId`, `transitionType` and
   qualifiers. The content script adds its own instance ID and
   `performance` navigation type. A bfcache restore reattaches the same
   document (attachments `boot`, `bfcache-restore`); a reload is a new
   document.
7. **Only the selected tab.** The registered script runs in every tab (there
   is no per-tab registration); the offscreen sink refuses ports from other
   tabs. In `tabSwitch` both the other tab and a popup opened by the recorded
   tab were refused (2 refused ports, markers absent).

## Results (Chromium 153, headless, Linux)

| Scenario | Result |
| --- | --- |
| Full navigation: link, back, forward, reload, cross-origin link, form POST + 303 | All 9 markers captured, latency 0–3 ms. Blind window (last message of the old document to first snapshot of the new one): 9–72 ms; back 312 ms includes a 300 ms harness pause. Commit to first snapshot 2–52 ms. 0 lost messages. Masked input value absent from the recording. |
| Same journey, naive bfcache handling | Markers captured; 8 lifecycle messages lost silently. |
| SPA: `pushState`, hash, `popstate` | One document. rrweb emits no Meta event on `pushState` (href stays the first URL). Navigation API events and `webNavigation.onHistoryStateUpdated` / `onReferenceFragmentUpdated` recorded every route. All 4 markers captured. |
| Slow load | See design point 5. |
| Tab switch and popup | Other tabs refused; ticker in the recorded tab captured with no gap (ticks 0–71). Headless never hides a tab, so throttling was not exercised. |
| Restricted pages | `chrome://version`, `about:blank`, `data:`, `view-source:`: no injection, no DOM evidence. An unsafe-port URL produced `onErrorOccurred` (`ERR_UNSAFE_PORT`). `webNavigation` still logged each commit URL, so the gap can be labelled. |
| Frames, `recordCrossOriginIframes` off | Each frame has its own stream. Same-origin and `srcdoc` children are also inlined in the top stream (duplicated). Cross-origin child only in its own stream. |
| Frames, `recordCrossOriginIframes` on | Everything inlined in the top stream, but the embedding page's own scripts saw 5 rrweb relay messages: rrweb relays through `window.postMessage`, so the page can read the cross-origin frame's recording. |
| Frame stitching | `chrome.runtime.getFrameId` is absent in content scripts. Matching a child's index in `window.parent.frames` to `iframe.contentWindow` in the parent mapped 3 of 3 frames to their rrweb node IDs. |
| Canvas, 5 s of 2D + WebGL animation | Off: 2 events, 1.6 KB. On at 4 fps: 42 events, 103 KB (about 20 KB/s for two small canvases). |
| Shadow DOM | Open shadow text captured. Closed shadow text not captured. `chrome.dom.openOrClosedShadowRoot` counted the closed root, so the gap can be labelled. |
| Service worker stopped mid-recording | No loss (design point 1). |
| Soak, 423 s | 42 documents, 21 navigations, 84 markers: all captured, 0 lost messages, blind window 28–66 ms per navigation. |
| Microphone denied | `NotAllowedError`; DOM capture continued. |
| Microphone revoked after 3 s (`chrome://settings`, Block) | Track `ended` at 3.07 s into a session blocked at about 3 s; no `mute` first. MediaRecorder stayed active and produced no audio until stop: 3.0 s decoded over 7.0 s wall. DOM capture continued. |

## Clock and capture loss (soak, 423 s)

| Measure | Value |
| --- | --- |
| Content script to offscreen latency | p50 0.5 ms, p95 2.2 ms, max 4.6 ms (n = 1314) |
| rrweb event timestamp to send | p95 0.9 ms |
| `Date.now()` against the performance clock | 0.1 ppm, residual p95 0.46 ms |
| AudioContext render clock against the performance clock | −270 ppm, residual p50 23 ms, max 52 ms |
| MediaRecorder chunks (`timeslice` 1000 ms) | 414 chunks, interval p50 1020 ms, max 1022.7 ms |
| Recorded audio | 421.98 s decoded over 422.90 s wall: 0.92 s short (0.22 %), not yet attributed; recorder start lag is about 0.1 s |
| Audio size | 6.79 MB, about 16 KB/s Opus |

Page evidence and navigation events share one clock to within a few
milliseconds. Audio does not: the render clock ran 270 ppm slow here (about
1 s an hour) and this is a fake device, so real hardware may differ either
way. The product must not place speech by sample count alone. Record
`(audio frames, performance time)` pairs about once a second and map audio
to the timeline with a fitted line; mark audio gaps (`ended`, `mute`,
recorder errors) explicitly.

## Microphone, not tab audio

`getUserMedia` in the offscreen document captures the microphone only. Tab
output is not in the recording unless it leaks acoustically from speakers;
echo cancellation is on by default. Tab audio would need `chrome.tabCapture`,
which is a separate capture with its own consent and is out of scope for v1.

## Permission lifetime

- The offscreen document cannot show a permission prompt. The first grant
  must come from a visible extension page (the probe's report page). The
  grant is stored for the extension origin in the profile and survives
  restarts until the user changes it.
- Revocation ends the track (`ended`) and does not restart; the product must
  stop or flag audio as lost and keep the DOM evidence.
- The recording state lives in `chrome.storage.session`; the content-script
  registration uses `persistAcrossSessions: false`, so a browser restart
  never resumes injection.

## Resource cleanup

Stop unregisters the content script, sends `stop` to every live port (rrweb
stops), stops the media tracks, closes the AudioContext and closes the
offscreen document. Pages that stay open keep the stopped content script
until they navigate.

## Gaps to label in every recording

| Gap | Effect | How the product detects it |
| --- | --- | --- |
| Restricted pages (`chrome://`, `edge://`, Web Store, `view-source:`, `data:` top frames, PDFs and other viewers) | No DOM evidence | `webNavigation` commit with no attached document |
| Cross-origin frames | Content only in the child's own stream; rrweb's relay leaks it to the embedding page | Per-frame streams, index stitching; do not use `recordCrossOriginIframes` |
| Same-origin frames | Duplicated in parent and own stream | Keep one (the parent's inline copy) when stitching |
| Canvas | Off by default; on costs about 10 KB/s per small animated canvas | Census of canvases at snapshot time |
| Closed shadow roots | Contents missing | `chrome.dom.openOrClosedShadowRoot` census |
| rrweb start | Creates a hidden `about:blank` iframe for a moment; the page's MutationObservers can see it | Filtered in analysis; note in the privacy section |
| Recording in all tabs | The script loads in every document while recording, then is refused | Accepted cost; injecting on `onCommitted` instead cannot guarantee `document_start` timing (not measured) |
| Popups and new tabs from the recorded tab | Not followed | Product decision (not in this slice) |
| Audio gaps | Revocation, device loss | Track events, recorder errors, decoded duration against wall time |
| Blind window per navigation | 9–72 ms of unrecorded DOM (soak 28–66 ms) | Last message and first snapshot times per document |

## Not measured here

- Background tab, minimised window, screen lock and sleep (headless never
  hides a tab; CDP freeze emulation has no effect on a visible page).
- Real microphone clock drift and real hardware audio loss.
- Microsoft Edge (same Chromium APIs; untested).
- Long sessions beyond 7 minutes in the committed run (`SOAK_SECONDS`
  supports any length).
- Prerendered and fenced-frame documents.

## Proposed supported-browser bounds (v1)

- Desktop Chrome and Microsoft Edge, version 116 or later
  (`runtime.getContexts` is 116; offscreen API 109; document IDs 106; the
  bfcache port behaviour applies from 123 and the detach design works on
  either side).
- Measured on Chromium 153 only. Claims for other versions and for Edge
  wait for the manual run.
- Not supported: Firefox and Safari (no offscreen documents), mobile, other
  Chromium browsers until tested.

## Input for the bundle schema (slice D)

Per recording: one session ID, one clock base (`performance.timeOrigin`
values are wall-clock milliseconds). Per document: browser `documentId`,
`frameId`, parent document, URL, navigation type, attachments with reasons,
rrweb events with send/receive times and sequence numbers. Navigation
events from `webNavigation` with `transitionType`. Audio: Opus chunks with
receive times, `(frames, time)` clock pairs, track events. Gap records for
every row in the table above.

## Sources

- Chrome offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome `activeTab`: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- bfcache and extension messaging: https://developer.chrome.com/blog/bfcache-extension-messaging-changes
- rrweb guide: https://github.com/rrweb-io/rrweb/blob/master/guide.md
