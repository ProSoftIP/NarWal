# NarWal v1 validation: one 30-minute walkthrough

Board #16552. One continuous 30-minute recording through the whole v1
workflow, with measured cost, plus the focused tests that cover what one
recording cannot. Run on main c04f4f2 (after #21 interaction capture and
bundle export, #22 recorder controls and #23 corrections) with the soak
steps of this change.

Results file: `docs/validation/soak-30min-2026-10-14.json` (the full output of
the run, every check and every minute's sample). The first run, before #21,
is `docs/validation/soak-30min-2026-10-13.json` (24 of 24 passed).

The 30-minute bundle the run exported (with its correction and note) is
attached to board #16552: `narwal-soak-30min-2026-10-14.narwal.zip`, 26.4 MB,
SHA-256 `0a74e8b66377b7049bdc7348bf53543c262e6f700d0b84fa47dd4be0b9643497`.

## 1. What was run

`node test/e2e/run.mjs soak` (`packages/extension`, after
`npm run build:test`), `NARWAL_SOAK_MINUTES=30`. Fixtures only: the e2e
site's own two origins on 127.0.0.1 and a looped speech recording as the
microphone. No real site, account or key.

| | |
| --- | --- |
| Browser | Google Chrome for Testing 153.0.8010.12 (Playwright 1.63.0 Chromium, new headless) |
| OS | Ubuntu 26.04 LTS, Linux 7.0 |
| Hardware | 12th Gen Intel(R) Core(TM) i7-12700, 20 threads, 62 GB RAM |
| Microphone | Chrome's fake device playing a speech WAV in a loop (48 kHz) |
| Network | none for the whole recording: every host resolves to nothing except 127.0.0.1 (negative control: a fetch to the internet fails) |
| Transcription | On this computer: Vosk small English, live |

Steps, in one recording:

1. Install the copy in folder `narwal-0.1.0`; its ID must be the manifest
   key's ID. Download the live model (network on), then restart the browser
   with no network.
2. Type into a masked field, then start recording. The in-page strip must
   appear.
3. For 30 minutes, cycle through: a link to a second page; back and
   forward (back/forward cache); reload; a link to the other origin; a form
   post with a typed secret; single-page routes, hash and popstate. Each
   step adds a new masked input and a `data-narwal-ui` hidden region with
   unique text, types a secret, moves the mouse, right-clicks one new
   button (a mark), focuses another and presses Alt+Shift+M (a mark), and
   adds a fixture page marker.
4. A third of the way in, stop the service worker (CDP
   `ServiceWorker.stopAllWorkers`).
5. Every 60 s: memory (PSS of every browser process), CPU time and storage.
   (Since #16591: every 30 s, plus the recorder's memory after a garbage
   collection; section 3.)
6. Stop from the extension; reopen the recording from its chunks and replay
   its first page.
7. Press **Export bundle** on the recordings page and keep the download.
   Read it as an agent does: unzip with the library's bounded reader,
   `validateBundle` and `buildAgentView` from `@narwal/bundle`.
8. Open the exported recording on the replay page; **Edit** the first
   transcript line and **Add note** at 1:00. Press **Export bundle** again
   and read the second bundle the same way.
9. Manual update: copy the extension into a new folder `narwal-0.1.1` with
   version 0.1.1 and load that folder instead.
10. Negative control: a copy without the `key` loads as a different ID.

## 2. Result: 33 of 33 checks passed

- PASS: the extension ID comes from the manifest key
- PASS: setup: the live model downloads
- PASS: negative control: no network for the whole recording
- PASS: still recording at the end, after the service worker stop
- PASS: stop succeeds
- PASS: the recording is 30 minutes long and stopped
- PASS: no automatic cutoff: stopped by the user
- PASS: all 137 markers captured
- PASS: none of 321 masked or hidden strings is in the recording
- PASS: the recording strip is not in the recording
- PASS: every committed top document has a full snapshot
- PASS: back/forward restored documents from the cache
- PASS: SPA routes recorded
- PASS: no gaps and no restarts
- PASS: one audio part that decodes to its full length (within 1.5 s)
- PASS: live transcript ran the whole time with no network
- PASS: Stop saved one live revision, active, with no gaps
- PASS: the transcript is the speech (80% of words known)
- PASS: every marker was saved within 15 s
- PASS: replay of the first page shows the recorded page
- PASS: Export bundle on the recordings page downloads a .narwal.zip
- PASS: @narwal/bundle: the export is valid
- PASS: the bundle is the whole recording: complete, 30 minutes, narration, active transcript
- PASS: all 137 right-click marks and 137 Alt+Shift+M marks are in the bundle
- PASS: the agent view has the narration, the routes and the marks
- PASS: no masked or hidden string is in the bundle
- PASS: replay: a correction and a note are saved on the exported recording
- PASS: the second export is valid and carries the correction and the note
- PASS: edits change no captured file (observations, rrweb, audio, transcript)
- PASS: update: same extension ID from a different folder
- PASS: update: the new version is running
- PASS: update: the recording and its transcript are unchanged
- PASS: negative control: with no key the ID changes and no recording is visible

The attached bundle, unzipped, also passes the command-line tool:
`node packages/bundle/bin/narwal-bundle.ts validate <dir>` prints
`VALID errors=0 warnings=0`, and `narwal-bundle export <dir>` writes an
82 KB Markdown walkthrough that starts "Narrated walkthrough", says
"1 correction applied", shows the corrected first line with what was heard,
the note at 01:00.0, and each mark next to the narration at that time.

### What the agent gets

| | |
| --- | --- |
| Bundle | 26,436,799 bytes, 147 files (146 before the edits) |
| `manifest.json` | state `complete`, 30:01.0 long, narration `audio/narration.webm`, active transcript `r1` |
| `observations.jsonl` | 274 `marker-element` (137 right-click, 137 keyboard), 253 `route`, 137 `viewport`, 96 `click`, 41 `pointer-dwell`, 39 `input` (all masked) |
| `transcript/r1.json` | the live revision (Vosk small English) |
| `edits.jsonl` | one correction (`c1`, segment `s1` of `r1`) and one note (`n1` at 60000 ms) |
| `rrweb/` | 137 streams, one per recorded document |
| `agent/walkthrough.md`, `.json` | 286 narration lines and 390 observation lines in time order, plus the note |

## 3. Measurements

### Memory and CPU

PSS of the whole browser (every process of the profile), sampled each
minute. "Extension" is the extension's own processes (service worker and
offscreen recorder with the Vosk worker).

| Minute | Whole browser PSS (MB) | Extension processes (MB) | Pages (MB) | Processes |
| --- | --- | --- | --- | --- |
| 0 | 657 | 363 | 111 | 12 |
| 5.1 | 771 | 329 | 208 | 14 |
| 10.1 | 815 | 375 | 208 | 14 |
| 15.2 | 822 | 367 | 224 | 14 |
| 20 | 829 | 361 | 235 | 14 |
| 25.1 | 805 | 361 | 209 | 14 |
| 29 | 851 | 379 | 240 | 14 |
| after-stop | 525 | 78 | 222 | 14 |

CPU time used by the whole browser: 385 s over the 29 minutes between the
first and last sample (22 % of one core on average).

The extension's processes measured 303 MB at minute 1.1 and 379 MB at
minute 29, and fall to 78 MB after Stop. That line, about 2.7 MB a minute,
runs from a trough to a peak: the memory levels off (next section).

### Recorder memory (board #16591)

Measured in later soaks of the same scenario, on the recorder process alone
(its own memory: PSS without the files it shares), from `/proc/<pid>/smaps`
by mapping and each JavaScript heap over the DevTools protocol. The
recorder is one process: the offscreen document, its audio worklet, the
Vosk worker and the service worker.

- **Vosk's WebAssembly memory fills in the first 10 minutes**, from 148.5
  to 185.5 MB, then holds (186.2 MB at minute 29).
- **The audio sent to the Vosk worker is garbage until that worker
  collects it**: first at about minute 4, then every 6.6 to 7 minutes. This
  is a sawtooth of up to about 27 MB.
- **The four heaps leave some garbage between collections.** In a natural
  30-minute run the peaks after minute 10 were 348.9, 348.7, 353.4 and
  355.7 MB and the troughs 318.6, 325.6 and 329 MB (a fitted 0.85 MB a
  minute).
- **No leak.** At minute 18 of a 20-minute soak, a garbage collection in
  each heap in turn took the process from 331.7 MB to 325.2 (service
  worker), 319.8 (offscreen), 318.5 (worklet) and 310.0 MB (Vosk worker).
  Without the Vosk memory that is 122.5 MB; at minute 0.5 it was 123.0 MB.

Two changes to the audio path were tried and not kept: both remove the
pressure that makes the Vosk worker collect, so its garbage piled up. Own
memory after minute 10, fitted: 0.85 MB a minute as shipped; 1.8 when the
worker handed each buffer back for reuse; 5.96 when the worker released
each buffer after use. The curves are in
`docs/validation/recorder-memory-curves-2026-10-14.json`.

The soak now reads memory every 30 s, and at minutes 12 and 21 and at the
end it collects the garbage in all four heaps and reads what is left. A
30-minute soak fails if what is left rises more than 5 MB, or if one
collection frees more than 45 MB (`test/e2e/memory.mjs`).

The 30-minute soak of #16591 (`docs/validation/soak-30min-2026-10-14-memory.json`):

| Minute | Before (MB) | After the collection (MB) | Freed (MB) |
| --- | --- | --- | --- |
| 12.1 | 328.0 | 307.3 | 20.7 |
| 21 | 334.0 | 308.3 | 25.7 |
| 29.8 | 335.2 | 309.0 | 26.2 |

What is left rises 1.7 MB over 17.7 minutes. Vosk's memory filled from
150.5 to 185.5 MB by minute 10 and moved 0.6 MB after that. Both memory
checks pass. Two other checks of that run fail, unrelated to
memory: the bundle now carries `AGENTS.md` and `README.md` (#16594), and
the recordings page is counted before its row draws (the export itself
succeeds; seen in an earlier 30-minute run too).

### Storage

| | After stop |
| --- | --- |
| All extension storage | 115.4 MB |
| IndexedDB (recordings, plus the live model's unpacked files) | 76.1 MB |
| Cache API (the downloaded model archive) | 39.3 MB |
| Page events of this recording | 2.44 MB (4.9 MB per hour) |
| Audio of this recording (WebM/Opus) | 26.1 MB (52 MB per hour) |
| Exported bundle (`.narwal.zip`) | 26.4 MB (53 MB per hour) |

The models are stored once per browser (about 90 MB with the live model
only); each hour of recording adds about 57 MB on top. Export also keeps one
copy of the bundle in the replay library.

### Latency

| | p50 | p95 | max | n |
| --- | --- | --- | --- | --- |
| Marker in the page → saved in IndexedDB | 512 | 624 | 1024 | 137 |
| End of a spoken phrase → final transcript line at the strip's seam (1 s poll) | 1468 | 1990 | 2212 | 285 |
| Page event → recorder receive (`t − sent`; worst minute's p50, p95 and max) | 0.3 | 11.5 | 22.8 | 2148 |

The worst page-clock minutes are minute 12 (p95 11.5 ms, max 14.2 ms) and
minute 0 (max 22.8 ms); every other minute has a max under 10 ms.

Stop (press → saved): 110 ms. Reopen of the 30-minute recording from its
chunks, with the needle search: 3502 ms. Export bundle (press → download
saved): 1079 ms; again after the edits: 939 ms.

### Drift

- Audio: 1800878 ms of recorded time decodes to 1800840 ms of audio
  (-21 ppm): the audio is 0.04 s shorter than the recording's span; the
  check allows 1.5 s. One run with a fake device cannot separate a start
  offset from clock drift, and a real microphone was not measured.
- Page clock: the page-to-recorder delay, every fifth minute:

| Minute | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- |
| 0 | 0.3 | 2.4 | 22.8 |
| 5 | 0.2 | 3 | 4.4 |
| 10 | 0.2 | 2 | 5 |
| 15 | 0.3 | 2.5 | 5.1 |
| 20 | 0.3 | 1.9 | 2.2 |
| 25 | 0.3 | 3.1 | 6.2 |
| 29 | 0.4 | 3.7 | 5.4 |

## 4. Coverage map

| Ticket item | Where it is checked |
| --- | --- |
| 30-minute capture, navigation, markers (right-click and Alt+Shift+M), masked inputs, hidden regions, live transcript, stop | This run (section 2) |
| No automatic 30-minute cutoff | This run: stop reason is `user` at full length. The recorder has no timer that stops a recording (`src/offscreen/main.js`) |
| Correction | This run: a correction and a note on the exported 30-minute recording in replay, carried by the next export. `npm run e2e:replay` (edit, note, keep-mine/take-new, #23) and `packages/edits` tests |
| Export / import | This run: Export bundle on the recordings page, validated by `@narwal/bundle` and the `narwal-bundle` CLI. e2e `markers` (#21); `packages/library` and `packages/bundle` tests; the replay page's hostile-bundle e2e. Import into Saved recordings: added after this run (#16589), `npm run e2e:replay` scenario `keep` |
| Synchronized replay | This run (first page); `npm run e2e:replay` (seek and playback sync, #16549) |
| Offline route without network | This run (whole recording, negative control); `offline-transcription` network-guard test (zero outside requests in every offline phase) |
| Each cloud adapter | Fixture tests in `packages/transcription/test/{openai,deepgram,assemblyai}`. OpenAI live smoke passed with a real key (#16547). Deepgram and AssemblyAI: UNTESTED-LIVE; not offered in v1 (Matt, 2026-10-13 22:23Z: v1 cloud transcription is OpenAI or this computer) |
| Recovery | e2e `workerRestart` (service worker stopped), `recorderCrash` (offscreen recorder killed, resumes with a labelled gap), `interruption` (browser exits; the recording reopens as `interrupted`), `storageFull`, `micDenied`, `restrictedPage`, `concurrentStops`, `concurrentStarts`, `transcriptionFailure`; this run stops the service worker mid-recording |
| Key isolation | `packages/transcription/test/key-store.test.ts` (no key is stored until storage is limited to trusted contexts); e2e `controlsTwice` (another tab's content script gets no status); pages see only whether a key is saved (`src/shared/ui-status.js`) |
| Untrusted import boundaries | `packages/library/test/zip.test.ts` (unsafe and duplicate paths, links, size and entry limits, checksums, ZIP64 and encryption refused), `packages/bundle/test/validate.test.ts`, `npm run e2e:replay` hostile bundle (no recorded script runs, nothing written to extension storage, sandboxed frame), replay page opens a file as untrusted and saves it only on Save, through the same import checks (#16589, e2e `keep`) |
| Preservation across a manual update | This run, steps 7 and 8 |
| Unpacked install and update | `docs/install-unpacked.md` |
| Dependency and model notices | `app/dist/THIRD-PARTY-NOTICES.txt` (generated; the build fails on a bundled package with no notice); `app/dist/runtime/` notices for engines and models |

Evidence run for this PR (same tree):

- `NARWAL_SOAK_MINUTES=30 node test/e2e/run.mjs soak` on main c04f4f2 plus this change: 33 of 33 passed (this document).
- The same scenario for 1.5 minutes: 32 of 32 passed.
- First run (#24, main 01786c5, before #21): 24 of 24 passed; `node build.mjs` fails on a bundled package with no notice entry.
- `npm run package` on c04f4f2: `release/narwal-0.1.0.zip`, 26 files, 9.2 MB, no test hooks; this is the build on Matt's Mac (board #16552).
- The package unit suites and the other e2e scenarios ran on their own PRs (#16-#23) and were not changed here.

## 5. Known gaps

- **Edge not run.** Edge is not installed on the test machine; the run
  used Chrome for Testing 153. Edge 116+ is the same Chromium
  extension platform (MV3, offscreen documents), but the Edge-on-Mac steps
  in `docs/install-unpacked.md` are not yet checked on a real Mac.
- **Not real hardware or a real microphone.** One Linux desktop, headless,
  fake microphone. Mac memory, CPU and real-microphone drift are not
  measured.
- **Recorder memory grows**: closed after this run by #16591. The 2.7 MB
  a minute was a line from a trough to a peak; the memory levels off once
  Vosk's memory is full (section 3, Recorder memory). Not measured: a
  recording longer than 30 minutes.
- **Import into Saved recordings.** Closed after this run by #16589: the
  replay page offers **Save to Saved recordings** for an opened bundle
  (`docs/replay.md`). Not part of the 30-minute run above.
- **After-recording transcripts.** The OpenAI transcript after Stop: closed
  after this run by #16588 (e2e `openaiAfter` on a fixture response; a live
  smoke with a real key is not done). Not part of the 30-minute run above.
  The Whisper final pass is not started from the extension. The live
  transcript on this computer works.
- **Page titles in the bundle**: 1 of 310 documents has a title (the
  first); the others have an empty title (`""` in the walkthrough's Pages
  line), although every fixture page has one. Their URLs and routes are
  there. Fixed after this run (board #16590): the export reads each
  document's title from its saved page content, so recordings made before
  the fix get their titles too. e2e `pageTitles` covers it.
- **Right-drag box marks** are not in this run; e2e `markers` covers them.
- **Model download from the model page** was not part of this run (it used
  the test hook that the model page's code also calls); #22 tests the page.
- **Deepgram and AssemblyAI** live: untested, and not offered in v1.
- **Licence**: deferred (ticket).

## 6. Rerun after #21

Done: sections 1 to 3 are the rerun on main c04f4f2 with the added steps
(marks in each cycle, Export bundle validated with `@narwal/bundle`, a
correction and a note in replay). The bundle is attached to board #16552.

## 7. Reproduce

```sh
cd packages/offline-transcription && npm ci && cd ../extension && npm ci
npm run build:test
NARWAL_SOAK_MINUTES=30 node test/e2e/run.mjs soak   # about 33 minutes
```

The run downloads the 41 MB live model once (network on), then records with
no network. Results: `test/e2e/results/<time>.json`, and the exported
bundle with the edits next to it as `test/e2e/results/soak-<time>.narwal.zip`.
