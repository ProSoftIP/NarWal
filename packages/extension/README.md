# NarWal recorder extension

Board #16542. A Chrome MV3 extension that records one tab (rrweb) and the
microphone, and saves both in bounded chunks while the recording runs. Design
inputs: the capture probe (`research/capture`, #16538) and the bundle schema
draft (`docs/bundle-schema.md`, #16541). Interaction capture, markers and the
bundle export are #16571; the in-page controls are #16551; transcription is
#16545.

## Build, load, test

```sh
(cd ../offline-transcription && npm ci)   # the offline engines build from its pinned dependencies
npm ci
npm run build          # app/dist, no test hooks; app/dist/runtime holds the offline engines
npm run package        # the same build, zipped as release/narwal-<version>.zip
npm run release        # package, then the store zip release/narwal-<version>-store.zip
```

`npm run release` (board #16955) writes the zip for the Chrome Web Store and
Edge Add-ons: manifest at the root, no `key` (the stores give their own ID),
only the files `src/release/store-package.js` allows, a gitleaks scan of the
contents (`release-gitleaks.toml` holds the measured false positives) and
the SHA-256. It refuses a version with no `CHANGELOG.md` section. The
listing kit and checklist are in `docs/release/`; the store images come from
`branding/store-images.mjs`.

Load `app/` as an unpacked extension (chrome://extensions, Developer mode).
Chrome or Edge 116 or later. Steps for people, including Edge on a Mac and
updates: `docs/install-unpacked.md`. The `key` in `manifest.json` fixes the
extension ID (`gpfcnaalnaknfbeonbgaafhomonmmcdj`) for every folder, so an
update in a new folder keeps the recordings. The build writes
`app/dist/THIRD-PARTY-NOTICES.txt` and fails if a bundled package has no
notice.

The toolbar and store icons are `app/icons/icon-{16,32,48,128}.png` (the store
listing icon, with its transparent edge, is `docs/release/images/store-icon-128.png`): the narwhal at 80% on a white rounded square (corner
22%) so it shows on a dark toolbar (#16601). The logo is `app/logo/narwal.svg`,
with no square. Their master is
`branding/narwal.svg` (Matt's pack, option 23 white eye, #16597):
`node branding/build.cjs` renders them again with `rsvg-convert`.

```sh
npm test                                  # pure logic (or node --test test/unit/<file>.test.mjs)
npm run e2e                               # builds with test hooks, runs Playwright Chromium
node test/e2e/run.mjs journey             # one scenario (after npm run build:test)
node test/e2e/run.mjs microphone microphoneSilent  # the microphone picker, test bar and strip meter (#16785)
node test/e2e/run.mjs listSelect          # Saved recordings: a click on a row selects it, up/down, Enter, search (#16839); SHOTS_DIR=<dir> saves screenshots
node test/e2e/run.mjs deleteRecordings    # Saved recordings: Delete on a row and Delete selected, the confirm, the popup's space used (#17003); SHOTS_DIR=<dir> saves screenshots
node test/e2e/run.mjs selfUpdate          # a new build in the folder: held by a page in use and a recording, then the alarm reloads it with idle tabs open, once, and opens them again (#17009; about 2 minutes)
node test/e2e/mic-shots.mjs               # screenshots of the popup and Options, light and dark, hearing and silent
node test/e2e/run.mjs transcript          # offline transcription and the final pass; downloads the 41 MB live model and 67 MB Moonshine base, needs ffmpeg
node test/e2e/run.mjs exportWhileImproving # Export on the strip and the popup while and just after the final pass runs; downloads Moonshine base, needs ffmpeg
node test/e2e/run.mjs transcriptParakeet  # Parakeet as the live engine and its fallback to Vosk; downloads 661 MB more, needs ffmpeg
npm run e2e:replay                        # replay: seeks, playback sync, hostile bundle, saving an opened file, sharing between two profiles (docs/replay.md)
node test/e2e/select.mjs                  # Saved recordings: pick and hover transcript lines, whole recorded window (#16844; after npm run build:test)
node test/e2e/run.mjs soak                # 30-minute recording with no network (NARWAL_SOAK_MINUTES); docs/v1-validation.md
```

The e2e run uses a fake microphone and a local two-origin fixture server
(`test/e2e/server.mjs`). It writes `test/e2e/results/<time>.json`.

## Version and releases

Boards #16864 and #17005. The version is in `package.json`. PRs do not bump
it: two open PRs that both took the next number conflicted on every version
line. After each merge to main the maintainers' release job
runs `node version.mjs plan`; when the current version already has a release
and a file that goes into the zip changed since (anything under `packages/`
except tests, e2e and Markdown, because the extension bundles the other
packages), it runs `node version.mjs bump --since v<version>`, which writes
the next patch version into `package.json`, `package-lock.json` and
`app/manifest.json` and adds a `CHANGELOG.md` section from the commit
subjects, and pushes that commit to main. `npm run bump -- minor` raises the
minor version by hand. `npm run check-version` checks that the three files
and the changelog agree.

The build writes the short commit and the build date into the popup's last
line (`NarWal 1.0.1 · build 71d3c62 · 2026-10-18`) and `app/dist/build.json`
(version, full commit, date). `npm run github-release` builds
`release/narwal-<version>.zip` and publishes it as the GitHub release
`v<version>` with its SHA-256, once per version, only from a clean commit on
origin/main (newest: <https://github.com/ProSoftIP/NarWal/releases/latest>);
`-- --dry-run` builds the zip and prints the release without creating it.
The store zip is
`npm run release` (docs/release/CHECKLIST.md).

An unpacked install starts a new build by itself (board #17009,
`src/sw/self-update.js`): Edge never reloads an unpacked extension when the
files in its folder change. The service worker reads the folder's
`dist/build.json` when it starts and on a one-minute alarm. When the folder
holds another version or commit than the one running, it calls
`chrome.runtime.reload()`, which is what Reload in `edge://extensions` does.
It waits while a recording runs or is saved, while the recorder runs (the
transcript after Stop, a speech model install), while the popup is open, and
while a NarWal page is in use: each page holds the Web Lock
`narwal-page-in-use` while it is shown, while it plays sound or video, for ten
minutes after its last click, key press, showing or playing, and while a text
box holds typed text no button beside it has saved or cancelled (`src/ui/page-guard.js`, `src/shared/page-use.js`). A
reload closes the NarWal tabs and clears `chrome.storage.session`, so the
worker writes the tabs down (`selfUpdateTabs` in `chrome.storage.local`) and
opens them again at their place when it comes back. Before this, any open
page held the reload, and tabs left in the background held every build for
days. A store install (`update_url`, or an install type
other than `development`) never does this. It reloads once for each folder
build (`selfUpdate` in `chrome.storage.local`), so a folder whose scripts do
not match its `build.json` cannot reload in a loop. While a reload waits,
`selfUpdateHeld` in `chrome.storage.local` names the waiting build, the reason
(`recording`, `saving`, `recorder`, `popup-open` or `page-in-use`), since when
it has waited and when the reason last changed; it is removed once the reload
goes ahead or the folder build is already running. A reload needs Developer
mode on, as an unpacked install does already.

## How it works

| Part | Job |
| --- | --- |
| `src/sw/main.js` (service worker) | Start and stop, one at a time (a second stop or start waits for the first). Registers the content script at `document_start` in every frame, injects it into frames already open, forwards `webNavigation` events. Keeps no capture state in memory: the live recording is in `chrome.storage.session`. A 30 s alarm and a reconnect nudge bring the recorder back if it dies. |
| `src/offscreen/` (offscreen document) | The only sink. Owns the microphone (`MediaRecorder`, WebM/Opus, 1 s chunks) and an audio clock worklet. Saves page events about once a second (or at 512 KB) and each audio chunk as it arrives. Runs the chosen live transcription (`transcript.js`, below). |
| `src/content/main.js` | rrweb and the interaction capture (`packages/interactions`) in each frame of the recorded tab. Observations go on the same port as `{k: 'obs'}`, in session ms, with rrweb node IDs. Queues every message until the recorder acknowledges the attach. Leaves the port before the back/forward cache closes it, and re-attaches with a full snapshot on restore. Other tabs are refused. |
| `src/store/db.js` | IndexedDB `narwal`: `recordings` (one record per recording) and `chunks` (`[recordingId, stream, seq]`). Each chunk is its own transaction, so a failed write never removes saved chunks. Streams: `events`, `audio`, `transcript` (live final lines and gaps), `history` (one record: the recording's transcript history, `transcription/src/revisions.ts`). |
| `src/shared/analyze.js` | Reopens a recording from its chunks: documents (grouped by browser `documentId`), navigations, interaction observations, audio parts and labelled gaps. Used by the recordings page, the export and the tests. |
| `src/export/bundle.js` | Writes a stopped recording as a schema 1.1 bundle tree: documents (and the windows it followed, #16754), observations (routes, interactions, markers), gaps, rrweb streams, narration and its clock, the transcript history, and the agent walkthrough. Each document's page title comes from its saved page content (#16590). URLs keep no query or fragment values, in the bundle's own fields and in every exported rrweb event. The tree is checked by `@narwal/bundle` before it is returned. |
| `src/content/controls.js` | The one-line recording strip (`@narwal/recorder-ui`, #16551) in the top frame of the recorded tab, mounted when the recorder accepts the document; a strip left from an earlier recording in the same tab is replaced. It sends only the strip's commands, and the service worker accepts them (status included) from the recorded tab alone. |
| `src/ui/` | Toolbar popup (the start view of `@narwal/recorder-ui`: readiness, the microphone picker and test bar, transcript choice, first-use instructions), the Options page (`options.html`, #16785: the microphone every recording uses, with the test bar), the `RecorderPort` over service worker messages (`recorder-port.js`), the microphone permission page, the speech model download page (`model.html`), saved-recordings page, and the replay page (`replay.html`, #16549: page, narration, transcript and markers in step; `docs/replay.md`). |
| `src/shared/ui-status.js` | Turns the service worker's `ui-status` answer into the status the controls show. |
| `src/content/picker.js` | Hide areas (#16592). The popup's **Hide areas** button has the service worker inject it into the top frame of the tab. It runs the region picker of `packages/interactions` with a one-line bar (count and Done; Escape cancels) and reports each change to the service worker. It also checks stored areas against the page for Start and the popup. |
| `src/shared/hidden-regions.js` | The hidden areas of a tab: which page they belong to (origin and path), the fingerprint that finds each one again, which documents use them, and the striped placeholder in replay. |

The transcript choices are on this computer (offline model) and OpenAI
Whisper with the user's own key (Matt, q3549). Keys go to the key store of
`packages/transcription` and stay in the service worker; pages see only
whether a key is saved.

Keyboard shortcuts (`chrome://extensions/shortcuts` can change them):
Alt+Shift+S stops the recording; Alt+Shift+N moves the keyboard to the strip;
Alt+Shift+M marks the focused item (see Markers).

Privacy settings in rrweb from the first snapshot (`rrwebPrivacyOptions`):
all input values masked with a fixed mask, `contenteditable` text masked,
anything under `[data-narwal-ui]` or `[data-narwal-exclude]` blocked, and
the empty placeholder rrweb keeps for a `[data-narwal-ui]` element removed
before sending. An `input` observation never holds a value.

### Hidden areas

Before Start, **Hide areas** in the popup lets the user click the parts of
the page to leave out (Matt, INTERVIEW-04). For each area the picker keeps a
structural selector and a fingerprint of the element (tag, size, a hash of
its text and a hash of its id, name, aria-label, aria-labelledby and
data-testid; never the text or the values) for that tab and page in
`chrome.storage.session`; they still apply after a reload of the same page,
and are dropped when the tab closes. An area counts as hidden only while its
selector finds exactly one element of the same tag and about the same size,
with the same text or the same identity attributes (an area whose text
changes, such as a live panel, is still found when it has an id). The popup counts only those; when the page
lost one, Start is refused ("1 hidden area could not be found") and the popup
offers **Pick again**. Start ends a picker that is still open and passes the
areas to the top-frame documents of that page. Each one finds its areas again
when it has loaded; when one is lost there, the whole body is blocked. The
areas are blocked in rrweb (only the size of the area is kept), observations
inside them carry `excluded: true` and no name, and each area is one
`exclusion` observation, counted in the bundle's `privacy.excludedRegions`.
Replay shows each area as a striped box. Other pages keep only the areas the
site marks with `data-narwal-exclude`; the picker cannot show those, and the
popup does not count them. Areas cannot be hidden while a recording runs: the
page text is already in the recording by then.

A frame inside a hidden or site-marked area records nothing. rrweb 2.1.7
records the inside of a blocked same-origin `<iframe>`, so in the content
script's world such a frame has no `contentDocument`. Each child frame runs
its own content script: before it starts, the recorder asks the document of
its parent frame whether the frame element is hidden. A frame inside a hidden
frame, a frame that cannot be found, and no answer in 15 s all count as
hidden: the frame gets `ignore` and the recording keeps one `refused` entry
with `reason: 'hidden-area'` and no URL.

## Markers

While a recording runs, in every frame of the recorded tab:

- **Right-click** marks the element. The page gets no press and no menu.
- **Shift+right-click** opens the page menu as usual.
- **Right-drag** of 6 px or more draws a box. **Esc** cancels the drag.
- **Alt+Shift+M** (`chrome.commands` `mark-focused`; change it at
  chrome://extensions/shortcuts) marks the focused item in the focused frame,
  or the element under the pointer when nothing is focused.

## Export

The saved-recordings page has **Export bundle** for each stopped or
interrupted recording. It writes the bundle, adds it once to the recording
library (`packages/library`, so the replay page lists it), and downloads
`<title>.narwal.zip`. Nothing is uploaded.

After Stop, the strip and the popup offer **Export** for the recording just
saved (board #16602). It opens `recordings.html?id=<id>&export=1`, which
exports that recording with the same code as its **Export bundle** button and
then shows it. The page drops `export=1` from its address first, so a reload
does not download again. While a transcript after Stop is still being made,
the page says so ("The transcript is still being improved on this computer
(N%). The bundle downloads when it is ready.") and exports when the job ends
(board #16622). A refused Export says why on the strip's line. (A content script cannot reach the recordings
database, and the popup can close while the bundle is written.) `?id=<id>`
alone, as **Open recording** sends it, shows that recording.

### Sharing a recording

Sharing is the one file (board #27484). Each Export, including the strip's
and the popup's (they export on Saved recordings, above), ends its line with
"Send this file; they open it in NarWal with Open a shared recording." The person
who gets it presses **Open a shared recording** in Saved recordings (in the
header), in the popup (bottom line) or on the replay page, or drops the
`.narwal.zip` on either page. Saved recordings hands the picked file to the
replay page (`src/ui/shared-file.js`: its bytes wait in this extension's
IndexedDB until `replay.html?shared=1` takes and deletes them). The replay
page replays it for viewing only and offers **Save to Saved recordings**
(below). The popup opens the replay page, whose **Choose a .narwal.zip file**
picks it there: a file picker would close the popup. The e2e `share` scenario
(`npm run e2e:replay -- share`) exports from one browser profile and opens
the file in a second.

A bundle saved from a file on the replay page (board #16589,
`docs/replay.md`) has no local chunks. The page lists it from the library
with status "from a bundle file"; **Open** goes to its replay and **Export
bundle** packs it again with its corrections and notes.

In the list (board #16839) a click anywhere on a row selects it: the row is
marked and the tiles above show that recording. Up and down (Home, End) move
the selection; Enter or a double-click opens it like **Open**, which scrolls
to the tiles. A search keeps the selected row selected while it is listed. A
bundle saved from a file has no tiles here: a click or Enter on its row opens
it in Replay.

Every Export asks for the purpose first when the recording has none (board
#17002, `src/ui/purpose-ask.js`): a modal on the recordings page asks "What
is this recording for, and what should happen with each thing you pointed
at?". Its **Save and export** stays disabled for blank text and checks the
answer as the purpose field does (`src/shared/purpose.js`: at most 1000
characters, no key-shaped text). The answer is saved on the recording (or on
the library copy of a bundle saved from a file) before the bundle is written,
so `manifest.purpose` and README.md's "Why it was recorded" carry it.
**Cancel** or Escape exports nothing. A recording with a purpose exports with
no question. Export on the strip and in the popup asks on the page they open.

Each row has **Delete** (the trash button), and ticked rows have **Delete
selected** (board #17003). Both ask once in a dialog that names each
recording and its length; Cancel has the focus, and Escape or a click outside
deletes nothing. Delete removes the recording's entry and every chunk from
the `narwal` database in one transaction (`deleteRecording` in
`src/store/db.js`), and its copies in the recording library are purged, not
kept in the trash. The service worker refuses while that recording is being
recorded or its transcript is still being made. The list is drawn again
without a reload, and `?id=` of a deleted recording opens nothing. A bundle
file exported before is not touched. The space used, from the saved chunk
sizes and the library's records (`src/store/usage.js`), shows in the list
header and after **Saved recordings** in the popup.

## Microphone (board #16785)

The microphone chosen in the popup or on the Options page is saved as
`microphone: {id, label}` in `narwal.prefs.v1`. The service worker passes its
id to the offscreen recorder on start and on a resumed recorder; the recorder
asks for that device exactly. When it is not connected the recorder opens the
default one, logs an `audio` entry `device-missing` and reports
`audio.deviceFallback`, and the strip shows "Default microphone".

The recorder reads levels from an `AnalyserNode` on the same source as the
recording, every 100 ms. The strip asks for them with `mic-level` (allowed from
the recorded tab only) every 200 ms for its level bar. When nothing was heard
in the first 10 s, `ui-status` carries `micSilent` and the strip says "No
microphone sound". The test bar on the popup and the Options page opens the
microphone itself and records nothing.

## Gaps

Missing data is labelled with the schema's `scope` and `reason` (§7).

| Reason | Scope | When |
| --- | --- | --- |
| `restricted-page` | page | The tab committed a page no extension can record (`chrome://`, Web Store, viewers). |
| `lost-messages` | page | A message number from one page is missing. |
| `mic-denied` | audio | Microphone permission refused: the page is still recorded. |
| `mic-device-lost` | audio | No microphone available at start. |
| `mic-track-ended` | audio | The microphone stopped mid-recording (blocked or unplugged). |
| `recorder-error` | audio | `MediaRecorder` failed, or audio chunks stopped arriving. |
| `recovery-truncated` | any | The recorder restarted, the browser exited without Stop, nothing was saved for over 5 s, or a write failed. |

## Failures

- **Disk full**: the recording stops (`storage-full`), the badge shows FULL
  and the popup and strip say so. Every chunk saved before the error is kept.
- **Browser exit or crash**: on the next start the recording is marked
  `interrupted`. Its saved chunks reopen and the lost tail is labelled.
- **Service worker stopped**: nothing is lost; capture does not depend on it.
- **Recorder (offscreen document) gone**: brought back within seconds; the
  missing interval is labelled and audio continues in a new part.
- **Transcription consumer throws**: the error is recorded; capture and saving
  continue (`addAudioConsumer`, `addPcmConsumer` in `src/offscreen/audio.js`).

## Transcription (board #16570)

The start message names the choice (`transcription`); a resumed recorder
keeps the one the recording started with.

| Choice | While recording |
| --- | --- |
| `offline` (On this computer) | Parakeet, or Vosk when Parakeet is not installed or does not load (#16617), runs in the offscreen document on the 16 kHz PCM tap. No network: the model is read from the Cache API (`narwal-models-v1`); a missing model shows `disconnected` and the audio is recorded as a gap. After Stop, Whisper improves the transcript on this computer (see below). |
| `openai` | Nothing; `after-recording`. After Stop the narration audio goes to OpenAI (see below). |
| `deepgram`, `assemblyai` | `off`. Not offered in v1 (Matt, q3549 correction 2026-10-13: "I meant open ai or on this computer"). |

The offscreen `status` reply adds `transcription`, `transcript`
(`{state, detail?}`), `transcriptEvents` (segment and gap events after the
`transcriptCursor` it was given) and the new `transcriptCursor`. The cursor is
opaque; a cursor from another recorder returns every event still held.
`transcript-retry` finishes the old engine session (its unheard audio becomes a
gap) and starts a new one. Each session picks its engine when it opens:
Parakeet when it is installed and has not failed in this offscreen document,
otherwise Vosk (`offline-transcription/src/live-chain.ts`).

Final lines and gaps are saved as they arrive. Stop adds one live revision
(`source: 'live'`) to the recording's transcript history, from every saved line
of the recording, including those of an earlier recorder before a restart. It
becomes the active revision when there is none. The history is the one
`transcription/src/revisions.ts` defines (bundle schema §8): revisions are never
rewritten, and an OpenAI run adds its own revision to the same history. Stop's
reply carries a summary (`transcript: {choice, activeRevision, revisions}`).

The engines run in workers from `app/dist/runtime/`; the manifest allows
`'wasm-unsafe-eval'` for them.

## The OpenAI transcript after Stop (board #16588)

A recording made with the OpenAI choice sends its narration audio, and nothing
else, to OpenAI whisper-1 when it stops (`src/offscreen/openai-job.js`).
Choosing OpenAI and pressing Stop is the consent for that one upload; each Try
again is a new one. The job runs in the offscreen document, which stays open
until it ends; the answer is a revision (`source: 'after-recording'`) in the
same transcript history, active when there was none, so the export and the
agent walkthrough carry it.

- Each audio part is its own upload, placed at its start on the session clock.
  A part over 25 MB is cut with `OfflineAudioContext`. A later part that fails
  is a gap in the revision.
- The job's state is in the recording's meta (`afterTranscript`: uploading
  with parts done, done, failed with a plain reason, or no key). The strip and
  the recordings page show it. A job the browser closed before it ended is
  marked interrupted. A job started from the recordings page or the popup
  tells a strip still open on that recording to read again (#16598).
- A job has a time limit of 10 minutes plus a quarter of the audio length
  (`deadlineFor`). At the limit the uploads are stopped and the job fails.
- Try again shows only for a failure that a new upload can pass
  (`afterTranscriptNext`: busy, network, time limit, a gap). A refused key, a
  used-up quota and a missing key need the user first: the recordings page
  then offers "Get the transcript from OpenAI". A recording with no narration
  audio offers nothing. The worker refuses `retry-transcript` from the page in
  every other state, so a page cannot start a paid upload.
- Export waits while a job uploads. The strip and the popup show **Export
  when the transcript is ready** and **Export** when the job ends (#16602).
  A press while it uploads is kept: the recordings page waits, then
  downloads (#16622). An export made before the transcript
  arrived leaves a library copy without it; the next export adds the newer
  transcript to that copy (`src/export/refresh.js`). A copy the user corrected
  or annotated in the replay page keeps what it has, and the export says so.
- The offscreen document asks the service worker for the key (`openai-key`,
  accepted from the offscreen document only) for each job. The key goes only
  into the request header; it is not saved in the recording, status or export.
  Error text is redacted, including the starred-out key OpenAI writes in a 401.
- e2e `openaiAfter` runs it against the fixture server's stand-in for OpenAI
  with a fake key (`narwal.openAiEndpoint`, test builds only).

## The improved transcript on this computer after Stop (board #16603)

A recording made with the "On this computer" choice runs the final pass
over its saved narration when it stops (`src/offscreen/local-job.js`). Nothing
leaves the computer. The live transcript stays the one the user reads until
the improved one is ready.

- The model is the best one this computer can run in time
  (`offline-transcription/src/tier.ts`, `FINAL_CHAIN`). A computer with a
  hardware WebGPU adapter that has `shader-f16` runs Whisper large-v3-turbo on
  the GPU; any other runs Parakeet TDT 0.6B v2 on WebAssembly (sherpa-onnx,
  #16608), then Whisper small.en, then Moonshine base (#16609), which is
  faster and gives no word times. When a model is not
  installed, is damaged, fails, or would miss the time limit, the next one in
  the chain runs (`final-chain.ts`); the last always runs to the end.
- The model page (`model.html`) is the picker (#16611): every model is a row
  with an accuracy and a speed bar, the download size, whether it needs
  WebGPU, and Download or Remove. Point at a bar, or open "Measured", for the
  numbers (`offline-transcription/src/picker.ts`). A click marks a row;
  **Use this model** keeps the pick in this profile (prefs `offlineModel`)
  and **Back** leaves it as it was (#16623). Both close the page and return
  to the tab the popup was on (`?from=<tab id>`), with the popup open again
  where the browser allows it; a page opened on its own goes to the
  recordings page. Neither works while a download runs. The start view names
  the pick, with **Choose model**. Stop runs the picked model, then the tier's installed models; the
  live model picked means nothing runs after Stop. A recording keeps the
  pick it started with.
- The download button installs the live model and the picked one (no pick:
  this tier's chain, with Parakeet for the live text), each file checked
  against its pinned SHA-256. A row's Download installs that model only.
  Nothing downloads on its own. Start needs one live model, Vosk or Parakeet
  (`readyLiveModel`, #16617): the start view shows a missing or downloading
  final model as a note, never a blocker. Only installed models run (and base.en,
  last, where it was installed before #16609 and Moonshine base is not); with
  none, the job fails as soon as Stop starts it ("no transcript model for
  after Stop is installed"), so Export does not wait, and the live transcript
  stays. The strip has no Try again; the recordings page offers "Improve the
  transcript" for after the install.
- Before an improved revision is made active it passes a sanity check
  (offline-transcription `plausible.ts`): text with no words, one short phrase
  repeated back to back (4 or more times over 16 or more words), or fewer than
  half the live text's words (from 20 live words) is stored but not made
  active. The job ends `failed` with `error.kind: 'implausible'` and the live
  transcript stays.
- Each audio part is decoded to 16 kHz (`decodeToEnginePcm`) and placed on the
  session clock by its clock pairs (`fitAudioClock`). The parts make one
  revision (`source: 'after-recording'`, provider `browser-local`) that
  supersedes the live revision. It becomes active under the rules of
  `addImprovedRevision` (transcription `revisions.ts`): corrections are carried;
  a conflict with a correction, or a gap when a transcript already exists,
  stores it without taking over.
- Progress is checkpointed in IndexedDB after each speech span (stream
  `final-checkpoint`). A job the browser stopped resumes from it when the
  service worker starts again, or when a page asks for its state; after three
  resumes it is marked interrupted. The model that was running when the job
  was cut short may be what stopped the document, so the resume runs the next
  model of the chain (`chainAfterCutShort`); the last model is never left out.
  The final engine's worker ends when no job runs, which frees its memory.
- The state is in the recording's meta (`afterTranscript` with
  `provider: 'browser-local'`: improving with progress, done, partial, failed).
  The strip, the popup and the recordings page show "Improving the transcript
  on this computer (N%)". Export waits for it as for the OpenAI job, and the
  next export refreshes a library copy made before it ended.
- The time limit is the OpenAI job's (`deadlineFor`: 10 minutes plus a quarter
  of the audio). It decides when the chain moves to a faster model; a hung
  engine call ends after 120 s.
- e2e `transcript` installs Moonshine base, presses Improve, then records with no
  network and checks that Stop alone makes the improved transcript active.
  e2e `markers` checks that with no final model the job fails at once.
- The word error rates that set the chain, with the harness and every stored
  model output, are in `docs/validation/wer-16603/`.

## Not here

Any server.
Local times are epoch milliseconds; the export converts them to session time.
