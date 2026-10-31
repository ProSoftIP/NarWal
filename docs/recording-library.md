# Recording library and portable bundles

Board #16548. Code: `packages/library` (`@narwal/library`). Bundle contents
are defined by [`bundle-schema.md`](bundle-schema.md) (#16541); this document
covers what that schema leaves to this ticket: the zip packing, the local
library, deletion, and keeping recordings across manual updates.

The package has no runtime dependency and makes no network call. A test reads
the source and fails on `fetch`, `WebSocket`, `eval`, `innerHTML`, `chrome.`
and similar. Nothing is uploaded; export hands bytes to the caller, which
offers them to the user as a download.

## 1. What the library holds

One entry per recording: the bundle tree exactly as produced (every file's
bytes, `manifest.json` included) and a local record beside it.

| Field | Source |
| --- | --- |
| `id` | Random, local. Not `recordingId`: two imports may share that. |
| `recordingId`, `title`, `createdAt`, `durationMs`, `schemaVersion`, `state` | Copied from the manifest; never rewritten. |
| `contentSha256` | SHA-256 of `manifest.json`. The manifest lists the hash of every other file, so this names the whole content. |
| `origin` | `recorded` (when saved) or `imported` (when, archive SHA-256 and size, the file's base name). |
| `history` | `saved`, `imported`, `updated`, `exported`, `deleted`, `restored`, each with a time. Last 200. |
| `deletedAt` | Set while in the trash. |
| `revision` | Write counter, set by the store (§4a). |

The library never edits a bundle. Provenance of an import stays in the local
record, so export then import returns the same bytes and a bundle does not
carry one user's import history to the next.

`RecordingLibrary.list()` returns live recordings, newest first, each with a
status: `saved` (manifest `state: "complete"`) or `interrupted`
(`state: "recovered"`). `listPending()` returns recordings the recorder
(#16542) still holds as raw chunks: in progress, stopped but not finalized,
or interrupted before recovery. The recorder supplies that list through the
`pending` option; the library does not read the recorder's database.

## 2. Zip packing

File name: `<title-slug>-<recordingId>.narwal.zip`, ASCII only.

- Entry names are the bundle paths. No top-level folder, no directory entries.
- `manifest.json` is the first entry; the rest follow manifest `files` order.
- `.webm` is stored (method 0); other files use deflate (method 8).
- Timestamps are fixed (1980-01-01) and no extra fields are written, so the
  same tree always packs to the same bytes.
- No ZIP64, no encryption, no archive comment, one disk. A tree that needs
  ZIP64 (over 4 GiB or 65,535 entries) is over the bundle limits anyway.

Any zip tool can open an export. An archive from another tool imports if it
meets the rules below; directory entries in it are ignored.

## 3. Import

Import treats the archive as untrusted data. It checks in this order and
stores nothing unless every check passes:

1. Archive: size, end record, one disk, no ZIP64, entry count. For every
   entry before any is expanded: safe path, no duplicate (compared without
   case), regular file only (no links or devices), no encryption, method 0 or
   8, declared sizes within the limits, declared expansion ratio within the
   limit, no two entries sharing bytes, local header equal to the directory.
2. `manifest.json` is expanded alone and checked: size, fields, schema major
   version, every listed path.
3. Before the other files are expanded: every entry is listed, every listed
   file is present, declared sizes equal the manifest, file types allowed.
4. Each file is expanded up to its declared size and no further; CRC-32,
   size and SHA-256 must match.
5. JSON parses (each line for `.jsonl`); the credentials rule of schema §11
   applies to every non-rrweb `.json`, `.jsonl` and `.md` file and to the
   manifest.
6. The schema validator, when the caller supplies one (`validate` option;
   #16541 owns it): errors refuse the import, warnings are returned.

| Limit | Value |
| --- | --- |
| Archive file | 512 MiB |
| Entries | 2,000 |
| One file, unpacked | 512 MiB |
| All files, unpacked | 1 GiB |
| Expansion ratio per file | 200× plus 64 KiB |
| Path, `manifest.json`, `.json`, `.jsonl` line | as schema §11 |

Paths follow schema §11 and two stricter rules, so a bundle a user unpacks
by hand is safe on Windows: no segment ends with a dot, and no segment is a
reserved device name (`con`, `nul`, `com1`, …).

File types are an allowlist: `.json`, `.jsonl`, `.md`, `.webm`. A bundle with
`.html`, `.js`, `.svg` or any other type is refused even if its manifest
lists the file.

Import does not run or render anything. rrweb streams hold the markup and
scripts of captured pages; the library stores them as bytes and never parses
them into a document. It reads no cookie, credential or browser API other
than IndexedDB and Web Crypto, and it needs no extension permission. Replay
(#16549) must keep its own sandbox; a stored stream is still untrusted.

A refusal is a `NarwalError` with a `code` (for example `entry-path-unsafe`,
`entry-ratio`, `file-mismatch`, `schema-unsupported`, `credential-refused`),
a plain message and the file and line where one applies. A credential
refusal names the place and the field, never the value.

Schema versions (schema §10): another major version is refused with "This
bundle uses schema 2.0; this NarWal reads schema 1.x". A higher minor version
imports; unknown fields and files of an allowed type are kept byte for byte
and exported again unchanged.

Importing a bundle already in the library (same `contentSha256`) is refused
with `duplicate-import`, which says whether the copy is in the trash. The UI
may then offer "import a copy" (`allowDuplicate`).

Known bound: import and export hold one whole bundle in memory.

## 4. Export

`exportBundle(id)` checks the stored tree again with the import rules
(hashes, file types, credentials), then packs it. A stored bundle that fails
is not exported. Export is always a user action; nothing exports or uploads
on its own.

API keys cannot be in an export for two reasons: provider keys live in
extension settings, outside any bundle, and the credentials rule runs on
every save, import and export.

The agent-readable files (`agent/walkthrough.md`, `agent/walkthrough.json`)
are generated by the schema lane's exporter (#16541, schema §9) when a
recording is finalized. The library stores and ships them like any other
file.

## 4a. Updating a recording

`update(id, files)` replaces a recording's tree with one that adds layers
(schema §1.4, §8). The library refuses (`update-refused`) a tree that:

- adds, removes or changes a captured file (anything outside `transcript/`,
  `edits.jsonl` and `agent/`);
- changes or removes an existing `transcript/<id>.json` (new revisions are
  fine);
- removes `edits.jsonl`, or whose `edits.jsonl` does not start with the
  stored bytes (append only);
- changes a manifest field other than `files`, `transcript` and `title`.

`update(id, files, { expectedRevision })`: the revision of the read the tree
was built from (`read(id)` returns the recording and its files from one
read). The layer rules alone cannot catch a tree read before a write that
changed only the manifest, such as a switch of the active transcript; with
`expectedRevision` that write is refused (`recording-conflict`) instead of
undone.

`agent/` files, `README.md` and `AGENTS.md` are derived (schema §9) and may be
regenerated or dropped. `exportBundle` writes them fresh through the `derive`
option (the extension passes `deriveAgentFiles` from `@narwal/bundle`), so an
imported copy's derived files never leave the device as they came in.

### Concurrent changes

Two pages, or two calls on one page, may change one recording at once. Every
stored record has a `revision`, which the store raises on each write.

- `delete`, `restore` and the `exported` history entry read and write the
  record in one store transaction, so they never write back an older copy.
- `update` and `purge` remember the revision they read (for `update`, the
  caller's `expectedRevision` when given). If the record changed before they
  write, they write nothing and fail with `recording-conflict`; the caller
  reads again and retries.
- `exportBundle` and `readFiles` read the record and all files in one
  transaction, so an export is never half of one tree and half of another.

A full disk or origin quota fails a write with `storage-full`; nothing is
written.

## 5. Deleting

| Action | Effect |
| --- | --- |
| `delete(id)` | Moves the recording to the trash. All data stays on the device. |
| `restore(id)` | Returns it to the list, unchanged. |
| `purge(id, { confirm: true })` | Removes it for good. Works only on a recording in the trash. |
| `emptyTrash({ confirm: true })` | Purges everything in the trash. |

Nothing is purged without the explicit `confirm`, and the library never
empties the trash on a timer. After a purge the only copy is an export the
user made.

## 6. Keeping recordings across manual updates

Recordings live in IndexedDB database `narwal-library`, in the extension's
origin. The recorder's raw chunks are in a separate database (`narwal`), so
the two packages version their layouts independently.

The origin, and so the data, follows the extension ID. For an unpacked
extension the ID comes from the `key` in `manifest.json` or, without one,
from the folder path.

Rules for the extension build (#16542, #16552):

- `key` is pinned in `manifest.json` (ID `gpfcnaalnaknfbeonbgaafhomonmmcdj`).
  The ID then survives a move of the folder. Keep the key unchanged in every
  release; a new key is a new extension with no recordings.
- Request `unlimitedStorage`, so the browser does not evict recordings under
  storage pressure.

Manual update procedure for the user (full steps:
`docs/install-unpacked.md`):

1. Export any recording you could not afford to lose.
2. Replace the files inside the existing extension folder with the new
   version, or put the new version in a new folder.
3. Open `chrome://extensions` (`edge://extensions`) and press **Reload** on
   NarWal, or **Load unpacked** on the new folder.

The 30-minute soak (`docs/v1-validation.md`) checks the new-folder update:
same ID, the new version runs, and the recording and its transcript are
unchanged; a copy without the key gets a new ID and sees no recordings.

Do not press **Remove**: removing an extension deletes its data. If the
extension was removed, reinstall and import the exported bundles.

Storage version: the store records `storageVersion` and the product version
that last wrote it. On open, an older store is migrated one version at a
time, and each step is stamped so a stop between steps resumes correctly. A
store written by a newer NarWal is refused untouched ("Install that version
again to open them; nothing was changed"), so a downgrade cannot damage
recordings.

## 7. Not in this package yet

- A trash page. The extension lists, imports and exports (#16571, #16589:
  `docs/replay.md` "Saving an opened file"); nothing in it deletes yet.
- Finalizing a recorder session into a bundle tree and calling `save()`
  (#16541 exporter, #16542 recorder).

## 8. Checks

In `packages/library`, after installing its dev dependencies: the
`typecheck` script runs `tsc`, and the `test` script runs the files in
`test/` with Node's own test runner. Node 22.18 or later runs the TypeScript
sources directly; there is no build step.
