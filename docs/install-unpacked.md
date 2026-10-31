# Installing NarWal unpacked

Board #16552. Load NarWal as an unpacked extension to run a build from this
repository, or a release zip, before or instead of the store version. NarWal
is open source under the MIT licence ([`LICENSE.md`](../LICENSE.md)).

Microsoft Edge on a Mac is the main target. Chrome works the same way; the
differences are listed at the end. Both need version 116 or later.

## 1. Get the extension folder

Use one of these.

**From a zip** (`narwal-<version>.zip`). Each version has a GitHub release
with its zip attached; the newest is at
<https://github.com/ProSoftIP/NarWal/releases/latest>. `npm run package`, below,
makes the same zip from the source.

1. Unzip it. It holds one folder, `narwal`.
2. Move `narwal` to a place you keep, for example `~/Applications/narwal`.
   The browser loads the extension from this folder every time it starts, so
   do not delete it or leave it in Downloads.

**From the source** (needs Node 22.18 or later and npm):

```sh
cd packages/offline-transcription && npm ci && cd ../extension
npm ci
npm run package     # release/narwal-<version>.zip, with no test hooks
```

`npm run build` alone builds `packages/extension/app/` in place; `app/` is
then the extension folder. The zip is the same folder with a fixed name.

## 2. Load it in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (the switch in the left column).
3. Press **Load unpacked** and choose the `narwal` folder (the one that holds
   `manifest.json`).
4. NarWal appears in the list. Its ID is `gpfcnaalnaknfbeonbgaafhomonmmcdj`.
   The ID is fixed by the `key` in `manifest.json`, so it stays the same for
   every copy of the folder, and so do the recordings it can see.
5. Pin it: press the puzzle-piece button in the toolbar, then the eye or pin
   button next to NarWal.

If Edge offers to turn off extensions in developer mode, decline: NarWal
turns off if you accept.

## 3. First use

1. Press the NarWal button. The popup shows **Before you start**.
2. **Microphone**: press **Allow microphone**. A NarWal tab asks for the
   microphone; allow it. If macOS asks too, allow Edge. If nothing is heard
   later, open System Settings → Privacy & Security → Microphone and turn on
   Microsoft Edge.
3. **Transcript**: pick one.
   - **On this computer**: the popup names the speech model. **Choose model**
     opens the list of models, each with its accuracy, speed and download
     size; pick one and press **Use this model**, or press **Back** to keep
     the one you had. Then press
     **Download speech model**. The NarWal tab downloads, once, the 41 MB
     live model and the picked one (the button shows the total; from
     `ccoreilly.github.io` and `huggingface.co`). Keep that tab open until it
     says the model is on this computer. After that, the transcript needs no
     internet.
   - **OpenAI**: press **Add key** and paste your OpenAI API key. The key stays
     in the extension's service worker storage; pages only see whether a key
     is saved. OpenAI makes the transcript after the recording, and the
     extension does not start that step yet (see section 7). Pick On this
     computer for a transcript today.
4. Open the tab to record, press the NarWal button, then **Start recording**.
   A strip at the edge of the page shows the recording and the live
   transcript. The strip is not recorded.
5. Stop with the strip's Stop button, the popup, or **Alt+Shift+S**
   (**Alt+Shift+N** moves the keyboard to the strip). Change the keys at
   `edge://extensions/shortcuts`.
6. While recording, mark what you are talking about:
   - **Right-click** an element marks it. The page gets no click and no menu.
     **Shift+right-click** opens the page menu as usual.
   - **Right-drag** (6 px or more) marks a box. **Esc** cancels the drag.
   - **Alt+Shift+M** marks the focused item, or the item under the pointer
     when nothing has focus.
7. **Saved recordings** in the popup lists recordings and opens their replay.
8. **Export bundle** on a stopped recording in Saved recordings downloads
   `<title>.narwal.zip` (the bundle an agent reads; nothing is uploaded) and
   adds the recording to the replay library: **Replay a bundle with narration
   and transcript** on the same page. A recording with no purpose is asked
   first: "What is this recording for, and what should happen with each thing
   you pointed at?" (board #17002). Type the answer and press **Save and
   export**; **Cancel** downloads nothing. Export on the strip and in the
   popup asks the same question on the Saved recordings page they open. There, **Edit** on a transcript line
   corrects it and **Add note** writes a note at the playhead. Press Export
   bundle again to get a bundle with the corrections and notes.
9. To keep a bundle someone sent you: on the replay page press **Open a
   bundle file**, choose the `.narwal.zip`, then press **Save to Saved
   recordings**. It is then listed in Saved recordings ("from a bundle
   file"), where **Open** replays it with Edit and Add note, and **Export
   bundle** downloads it with your corrections and notes.

There is no time limit. A recording runs until you stop it, the disk is full,
or the browser closes (then the saved part is kept and the rest is labelled
as missing).

## 4. Updating to a new version

Recordings are stored inside the browser profile, under the extension's ID.
They stay as long as the ID stays and the extension is not removed.

1. Export any recording you could not afford to lose (**Export bundle** in
   Saved recordings).
2. Either replace the files inside the existing `narwal` folder with the new
   version's files, or put the new version in a new folder.
3. Open `edge://extensions`:
   - Same folder: press **Reload** on NarWal (the circular arrow), or wait:
     NarWal reloads itself within a minute once nothing records and no NarWal
     page is open (see below).
   - New folder: press **Load unpacked** and choose the new folder. It
     replaces the old one because the ID is the same. Then delete the old
     folder.
4. Check that the version is the new one and that **Saved recordings**
   still lists your recordings. See "Which version do I have?" below.

NarWal starts a new build in its folder by itself (board #17009): within
about a minute it reloads, the same as **Reload** in `edge://extensions`. It
waits until no recording runs or is being saved, no transcript is being made
after Stop, no speech model is being installed, the popup is closed, and no
NarWal page (Saved recordings, replay, Options, the model page) is in use. A
page is in use while it is on screen, while it plays a recording, for ten
minutes after you last clicked, typed or looked at it, and while it holds text
you typed but did not save or cancel. A reload closes the NarWal tabs, so NarWal opens them again where they
were, at the same address. A shared recording you opened from a file is not
kept: open the file again. **Reload** still works at any time. The first build
with this needs one **Reload** by hand; Developer mode must stay on.

### Which version do I have?

- **Edge**: `edge://extensions` shows the version under the name NarWal, for
  example `1.0.1`. (Chrome: `chrome://extensions`, the same place.)
- **The popup**: the last line, under Saved recordings · Options · ProSoft IP,
  reads for example `NarWal 1.0.1 · build 71d3c62 · 2026-10-18`: the version,
  the commit it was built from, and the date of the build. Two copies with
  the same version and build are the same extension. A build ending in
  `-dirty` was made from a checkout with uncommitted changes.
- **The folder**: `dist/build.json` in the extension folder holds the same
  version and the full commit.

Each merge to main that changes the extension raises the version, so a
different number means a different build.

**An unpacked install built from the source** (Edge loads
`packages/extension/app` of your NarWal checkout): get the new code and build
it in place, then press **Reload** on narwal in `edge://extensions`.

```sh
cd NarWal    # your checkout
git pull && (cd packages/offline-transcription && npm ci) && cd packages/extension && npm ci && npm run build
```

If Edge loads a copied `narwal` folder or an unzipped `narwal-<version>.zip`
instead, run `npm run package` in place of `npm run build`, unzip
`release/narwal-<version>.zip`, replace the files in that folder with the ones
in the zip's `narwal` folder (step 2 above), then press **Reload**. The
version in the list says which build is loaded: `0.1.0` is the old one.

**Never press Remove.** Removing the extension deletes every recording it
holds. An exported bundle can be put back: **Open a shared recording** on
Saved recordings, then **Save to Saved recordings**.

## 5. Chrome

Same steps with these differences:

- Page: `chrome://extensions`; Developer mode is the switch at the top right.
- Shortcuts: `chrome://extensions/shortcuts`.
- macOS microphone setting: Google Chrome.
- Chrome and Edge keep separate profiles. A recording made in one is not
  visible in the other.

## 6. Notices

- `dist/THIRD-PARTY-NOTICES.txt` in the extension folder: the code bundled
  into the extension's scripts (rrweb and the packages it includes).
- `dist/runtime/THIRD-PARTY-NOTICES.txt` and
  `dist/runtime/onnxruntime-ThirdPartyNotices.txt`: the offline engines
  (Vosk, ONNX Runtime, Transformers.js) and the speech models (Vosk small
  English, Apache-2.0; Whisper base.en, small.en and large-v3-turbo, MIT,
  from ONNX conversion repositories that carry no licence tag; Moonshine
  base, MIT, from a conversion repository tagged MIT; Parakeet TDT 0.6B v2,
  CC-BY-4.0, NVIDIA, run by an ASR-only sherpa-onnx build).
- `packages/offline-transcription/README.md` has the model sources, sizes
  and checksums.

## 7. What is not in v1 yet

At the time of writing (main after #21, #22 and #23):

- After-recording transcripts (OpenAI, the Whisper final pass) are not
  started from the extension yet; no ticket yet. The live transcript (On
  this computer) works.

See `docs/v1-validation.md` for what was measured and every known gap.
