# @narwal/recorder-ui

The two things a person sees when they record with NarWal (board #16551):

- **Start view** (`mountStartView`), for an extension page such as the toolbar popup: **Start recording** at the top with what blocks it right under it (board #16601), then three readiness checks (tab, microphone, transcript), the transcript choice with a plain-language explanation of each option, and the first-use instructions with **Start now** and **Don't show instructions again**.
- **Recording strip** (`mountStrip`), placed in the recorded page: one line across the bottom with the time, the newest transcript words, **Transcript** (opens the full transcript above the line) and **Stop**.

Both show the NarWal logo (`narwalLogo`, `src/logo.js`, board #16597): 32 px in the start view header, 16 px in the strip, drawn inline from the paths of `packages/extension/branding/narwal.svg`.

Plain JavaScript modules, no runtime dependencies, no build step. The package knows nothing about `chrome.*`: the extension gives it a port and a storage area.

Matt approved this look for the first release (board #16551, q3548).

`mountStartView` offers every choice in `PROVIDERS` unless `choices` (a list of ids) narrows it; a stored choice that is not offered falls back to the first offered one.

## Run it

| Command | What it does |
| --- | --- |
| `npm install` | Playwright and rrweb, for the tests only |
| `npm test` | unit tests (`node --test`) |
| `npm run e2e` | real Chromium: every state, keyboard use, rrweb capture exclusion; screenshots in `test/e2e/results/` |
| `npm run demo` | `http://127.0.0.1:4173/demo/start.html?s=first-use` and `/demo/page.html?s=recording` |

`demo/scenarios.js` lists the scenario names for `?s=`.

## What the extension supplies

### RecorderPort (`src/port.js`)

The UI reads one `RecorderStatus` and calls a few methods. It never talks to a provider, the microphone or recording storage.

| Method | Meaning |
| --- | --- |
| `getStatus()` | current `RecorderStatus` |
| `subscribe(listener)` | `status`, `segment` and `gap` events; returns unsubscribe |
| `start({transcription})` | begin recording the selected tab with that choice |
| `stop()` | stop and save |
| `requestMic()` | ask for microphone access (or open the page that asks) |
| `refresh()` | read tab, microphone and network again |
| `downloadModel()` | download the offline speech model; only ever called from a user click |
| `saveKey(provider, key)` / `removeKey(provider)` | hand the key to the key store (board #16545) |
| `retryTranscript()` | connect the **same** provider again |
| `openRecording(id)` | open the saved recording |
| `exportRecording(id)` | write the saved recording as a bundle and download it (#16602) |
| `pickRegions()` | optional: let the user hide parts of the page before Start (#16592). The start view offers **Hide areas** only when the port has it |
| `chooseModel()` | optional: open the speech model picker (#16611). With `status.model.choice` the start view names the model with its accuracy and speed bars, and offers **Choose model** only when the port has it |
| `micLevel()` | optional: `{level: 0..1, heard}` of the recording's microphone, or `null` (#16785). The strip polls it every 200 ms while recording and shows the level bar only when the port has it |

`RecorderStatus`:

| Field | Values |
| --- | --- |
| `phase` | `idle`, `starting`, `recording`, `stopping`, `saved`, `failed` |
| `tab` | `{ok, title?, reason?}`; `reason` is shown as written |
| `mic` | `granted`, `prompt`, `denied`, `unavailable` |
| `online` | `false` when the computer has no network |
| `model` | `{state: missing/downloading/ready/failed, bytesDone?, bytesTotal?, error?}` |
| `keys` | `{deepgram?, assemblyai?, openai?}` booleans. Never the key |
| `hidden` | areas of the tab's page that will be left out of the recording (ports with `pickRegions`) |
| `transcription` | the choice the current recording uses |
| `elapsedMs`, `micLive`, `elsewhere`, `recordingId`, `error` | recording facts |
| `micSilent` | `true` when the microphone heard nothing in the first 10 s of the recording (#16785) |
| `micFallback` | `true` when the chosen microphone was not connected and the default one records (#16785) |
| `transcript` | `{state: connecting/live/behind/reconnecting/disconnected/after-recording/off, detail?}` |

Mapping from the adapters' session status (agreed with #16544 to #16547): `live` and `connecting` map to themselves; `stopped` with an error maps to `disconnected` with the error message as `detail`; `finishing` and `finished` belong to phase `stopping`; the offline tracker's `catching-up` maps to `behind`.

`segment` events carry `{segmentKey, kind: interim/final, startMs, endMs, text}`; `gap` events carry `{startMs, endMs, reason}`. These are fields of `TranscriptSegment` and `TranscriptGap` in `research/cloud-transcription/src/contract.ts`; times are on the session clock of `docs/bundle-schema.md`.

`createFakePort()` is the in-memory port the tests and demo pages use.

### Storage (`src/prefs.js`)

`createPrefs(chrome.storage.local)` owns these fields of the object stored under `narwal.prefs.v1`:

```
{ skipInstructions: boolean, transcription: 'offline' | 'deepgram' | 'assemblyai' | 'openai',
  microphone: {id: string, label: string} | null }
```

`microphone` is the input chosen in the microphone panel (#16785); `null` is the browser's default. The label is kept so a microphone that is not connected can still be named.

Other modules may keep their own fields in the same object; `update()` preserves them. Provider keys are **not** here and are never read by this package.

## Behaviour that is decided here

- **Start**: the first press shows the instructions and records nothing. **Start now**, right under the instructions title, starts. Ticking **Don't show instructions again** is saved at once; after that Start records directly. **How recording works** opens the instructions again at any time, and unticking brings them back.
- **Start when something is missing**: the button stays focusable, says why underneath, and a press moves focus to the thing to fix (the Allow, Download or key field).
- **Offline model**: nothing is downloaded until the user presses the download button. The size is shown when the port reports it and never guessed.
- **Cloud provider**: each choice says that the microphone audio goes to that company and that the user's own account is charged. A live provider with no key, or with no network, blocks Start. OpenAI Whisper works after the recording, so a missing key is only a note.
- **Provider disconnects**: the strip says so, says that recording continues, and offers **Try transcript again**, which reconnects the same provider. Nothing switches provider. The gap is listed in the transcript with its times.
- **Microphone stops** during a recording: that message outranks every transcript message.
- **Microphone picker and test bar** (`src/mic-panel.js`, #16785): `mountStartView({microphone: {onFix}})` puts one line under Start: the inputs, a level bar and **Test**. The extension's Options page mounts the full panel with `mountMicPanel`. Test opens the chosen input and reads levels from an `AnalyserNode`; nothing is recorded, and the input is let go on **Stop test**, on Start and when the page closes. The bar turns green above about -50 dBFS (`src/mic-level.js`). Three seconds without sound says "No sound from" and the device. A saved input that is not connected is named, and the default is used. Not asked, blocked and no microphone each get one sentence and the fix (in the popup, the Microphone check says it).
- **No microphone sound** while recording: when the recording's microphone heard nothing in its first 10 s, the strip says so (below a lost microphone, above transcript messages). The level bar shows whenever the microphone records.
- **Saved**: the strip says "Saved on this computer." with **Export**, **Open recording** and **Close**; the popup's banner has **Export** and **Open recording**. Export is the primary action (#16602). While a transcript after Stop is being made (OpenAI, or improved on this computer) it reads **Export when the transcript is ready**; a press is kept and the bundle downloads when the transcript is in (#16622). It reads **Export** again when the job ends. A press that fails says why: on the strip's line, and in the popup's error line.

## Keeping the controls out of the recording (`src/capture-exclusion.js`)

Every NarWal element in a recorded page is a host marked with `markNarwalUi(host, name)` (attribute `data-narwal-ui`, class `narwal-ui`) with a **closed** shadow root. Three layers use that mark:

1. `rrweb.record({ ...RRWEB_RECORD_OPTIONS })` (`blockSelector: '[data-narwal-ui]'`). rrweb cannot read a closed root, and records the host as an empty block.
2. `createCaptureFilter()`: call it with each rrweb event of one document, in order, before storing. It removes the block and every event that points at it (mutations, pointer positions, clicks, scrolls, selections), and repairs a sibling reference to it. rrweb 2 keeps only the `class` of a blocked element, which is why the class is part of the mark.
3. `isNarwalUiEvent(event)`: interaction capture (hover, clicks, marks; board #16543) ignores events on the controls.

`npm run e2e` proves this with rrweb 2.1.7: it records the fixture page while the strip is used, with the strip mounted before and after capture starts, then checks that the stored events hold no NarWal string and no dangling node id, and that a replay shows the page without the controls.

The strip also stops its own key and pointer events at the host, so page shortcuts and "click outside" handlers do not react, and a mouse click on a control leaves focus in the page.

## Keyboard

- Start view: ordinary tab order; the transcript choices are one radio group (arrow keys); focus moves to each view as it opens.
- Strip: it comes after the page in tab order. Enter or Space on **Transcript** opens the panel, Escape closes it and returns focus to the button. The transcript log is focusable so it can be scrolled with the keyboard.
- `strip.focus()` (Stop first, else the first usable button) and `strip.toggleTranscript()` exist so the extension can bind browser-level shortcuts (`chrome.commands`) that work from anywhere in the page. The marker shortcut in the instructions is `MARK_SHORTCUT` in `src/gestures.js`.

The instructions describe the gestures that the capture code implements (#16543): right-click marks an item and the page menu does not open; Shift + right-click gives the page menu; a right-button drag of `MIN_BOX_DRAG_PX` (6) or more draws a box and Esc cancels it; Alt+Shift+M marks the focused item. `src/gestures.js` holds the words and the two constants; change them together with that code.

## Not in this package yet

- The extension side lives in `packages/extension`: the `RecorderPort` over service worker messages (`src/ui/recorder-port.js`), the popup that mounts the start view, the content-script entry that mounts the strip, and the manifest `commands`.
- A page that puts a modal `<dialog>` or `inert` over everything also covers the strip for a mouse; the browser-level shortcuts above are the way to reach Stop then.
- Text is English only.
