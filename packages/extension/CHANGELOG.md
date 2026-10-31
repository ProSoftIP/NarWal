# Changelog

The NarWal extension's releases. The version is the one in
`app/manifest.json` and `package.json`; `npm run release` refuses a version
with no section here (board #16955). The maintainers' release job adds a section
with each version it bumps after a merge to main (board #17005).

## 1.0.8

- docs(extension): drop an internal tool name from a comment before publishing

## 1.0.7

- fix(extension): the held entry also clears once the folder build already runs (board #17009)
- feat(extension): a held self-reload writes down which build waits and why (board #17009)

## 1.0.6

- fix(extension): typed text stays unsaved until its own button, and a playing recording holds the reload (board #17009)
- fix(extension): a NarWal tab left open no longer holds a new build's reload (board #17009)

## 1.0.5

- docs(release): remove a customer name and payroll figures left in the tree (board #27493)

## 1.0.4

- feat(release): prepare NarWal for open source and the store listings (board #27493)

## 1.0.3

- feat(extension): Open a shared recording, and say how to share after Export

## 1.0.2

- fix(replay): leave page-loading gaps out of Missing evidence

## 1.0.1

- feat(extension): an unpacked install starts a new build in its folder by itself (board #17009)

## 1.0.0 (unreleased)

The first release for the Chrome Web Store and Edge Add-ons. It is the
private v1 build with a licence and a store package.

- Licence: NarWal is proprietary, all rights reserved (ProSoft IP). The
  licence, `LICENSE.md`, ships in the extension folder as
  `dist/LICENSE.md`.
- `npm run release` builds the store zip, `release/narwal-1.0.0-store.zip`:
  manifest at the root, no manifest `key`, only the extension's own files,
  scanned for secrets, with its SHA-256.
- `dist/THIRD-PARTY-NOTICES.txt` names NVIDIA's Parakeet model under
  CC-BY-4.0 and where to get the MPL-2.0 Eigen source built into the speech
  engines.
- The name is spelt NarWal in the toolbar, the store listing and every page
  (board #16968). The extension ID, folder and file names do not change.
- Export asks what the recording is for when it has no purpose (board
  #17002): "What is this recording for, and what should happen with each
  thing you pointed at?". The modal cannot be confirmed blank, and Cancel or
  Escape downloads nothing. The answer is saved on the recording and goes
  into the bundle (`manifest.purpose` and README.md's "Why it was
  recorded"), so the AI that gets the bundle knows what to do with it. This
  covers Export bundle in Saved recordings (recordings made here and bundles
  saved from a file) and Export on the strip and in the popup. The purpose
  field at Start stays optional.
- Saved recordings can be deleted (board #17003): Delete on a row, or tick
  rows and Delete selected. One confirm names each recording and its length.
  The space used shows in the list and in the popup.
- Saved recordings is a button at the top of the popup, beside the name
  (board #17006). Options, ProSoft IP and the space the recordings use stay
  at the bottom.
- A new build in the folder of an unpacked install starts by itself
  (board #17009): within about a minute, once nothing records, no transcript
  is being made and no NarWal page or popup is open. No Reload click.
- Everything recorded in 0.1.0 works the same: recording one tab with its
  windows, the microphone, marks, the live transcript on this computer or
  OpenAI after Stop, saved recordings, replay, transcript edits and the
  bundle export.

## 0.1.0

The private v1 build, installed by hand as an unpacked extension
(`docs/install-unpacked.md`).
