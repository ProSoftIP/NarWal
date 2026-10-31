# NarWal capture probe (board #16538)

A research probe, not the NarWal product. It answers one question: can a
Chrome/Edge MV3 extension keep rrweb page evidence and microphone audio for one
selected tab across navigation, on one trustworthy timeline?

Findings and measured results: [`docs/research/16538-capture-continuity.md`](../../docs/research/16538-capture-continuity.md).

## What is here

| Path | Purpose |
| --- | --- |
| `extension/` | MV3 probe extension: service worker, offscreen microphone recorder and event sink, rrweb content script, report page |
| `fixtures/` | Local fixture site served on two origins (`127.0.0.1` and `localhost`), so cross-origin navigation and cross-site iframes are real |
| `harness/run.mjs` | Playwright harness: loads the extension, drives every scenario, writes `results/` |
| `harness/analyze.mjs` | Turns a session dump into measurements; also bundled into the report page |
| `results/*.json` | Committed measurement summaries; `*.raw.json` (full event logs) are git-ignored |

Fixtures only. Never point the probe at a production site.

## Automated run (headless Chromium)

Requires Node 20+.

```sh
cd research/capture
npm install
npx playwright install chromium   # once; the harness pins playwright 1.63.0 (Chrome for Testing 153)
npm run probe                     # all scenarios; SOAK_SECONDS=120 by default
node harness/run.mjs navigation spa   # selected scenarios
SOAK_SECONDS=1800 node harness/run.mjs soak   # 30-minute clock/loss soak
```

On a Linux host without Chromium's system libraries, prefix the command with
the host's library wrapper.

The harness uses Chromium's fake microphone (`--use-fake-device-for-media-stream`)
and re-enables the back/forward cache that Playwright disables by default. The
output file ends with `VERDICT=RAN` or `VERDICT=ERRORS scenarios=<names>`.

### Scenarios

| Name | What it does |
| --- | --- |
| `navigation` | Same-origin link, back, forward (bfcache), reload, cross-origin link, form POST with 303 redirect; a marker inserted in the same task as each navigation |
| `navigationNaiveBfcache` | The same journey, letting Chrome close the port on bfcache entry (shows the silent loss) |
| `bfcacheControl` | Back/forward without the extension recording (is bfcache in use at all?) |
| `spa` | `pushState` routes, hash change, `popstate` |
| `slowLoad` | A page whose `load` waits 2.5 s, with rrweb `recordAfter: 'load'` and `'DOMContentLoaded'` |
| `tabSwitch` | Another tab and a `target=_blank` popup in front of the recorded tab; a 200 ms ticker in the recorded tab |
| `restricted` | `chrome://version`, `about:blank`, a `data:` URL, `view-source:`, a failed navigation, then a normal page |
| `frames` | Same-origin, cross-site and `srcdoc` iframes, with rrweb `recordCrossOriginIframes` off and on |
| `canvas` | Animated 2D and WebGL canvases with `recordCanvas` off and on (4 fps) |
| `shadow` | Open and closed shadow roots |
| `workerRestart` | Stops the extension service worker mid-recording through CDP, then navigates |
| `soak` | Marker every 5 s, navigation every 20 s, for `SOAK_SECONDS`; clock drift and audio loss |
| `micDenied` | Separate browser; microphone permission prompts denied |
| `micRevoked` | Separate browser; the extension's microphone set to Allow in `chrome://settings`, then Block after 3 s |

## Manual run (real Chrome or Edge, real microphone)

Headless Chromium never hides a background tab and its fake microphone runs on
the system clock, so tab backgrounding, window minimising, sleep, and real
audio-clock drift must be measured on a desktop.

1. `npm install && npm run build`.
2. Open `chrome://extensions` (Edge: `edge://extensions`), turn on Developer
   mode, choose **Load unpacked**, select `research/capture/extension`.
3. Start the fixtures: `npm run fixtures` (A = `http://127.0.0.1:4801/`, B = `http://localhost:4802/`).
4. Grant the microphone once: open `chrome-extension://<id>/report.html` (the
   ID is shown on the extensions page) and press **Allow microphone for the
   probe**. An offscreen document cannot show a permission prompt.
5. Open `http://127.0.0.1:4801/`, click the toolbar button (badge shows `REC`).
6. Walk the journey, speaking throughout: links, back/forward, reload, the
   cross-origin link (edit the URL to port 4802), the SPA page, the frames page.
   Then switch to another tab for 60 s, minimise the window for 60 s, lock the
   screen for 60 s, and come back.
7. Click the toolbar button again. The report page opens with a summary;
   press **Download last recording (JSON)**.
8. Add the browser name/version, OS, and machine to the file name and attach it
   to the board ticket. Compare `clock.audioRecorded.lossSeconds`,
   `clock.audioRenderClock.ppm` and `topFrameGaps[].blindMs` with the headless run.

To test revocation: while recording, open the extension's site settings
(`chrome://settings/content/microphone`) and block the extension, then stop.
