# Corrections and notes

Board #16550. The user can correct the transcript and write notes on a
recording without changing what was captured. Code: `packages/edits`. UI: the
replay page (`app/replay.html?id=<id>`), for recordings in the local library.
A file opened from disk is replayed, not edited.

## What is stored

Everything goes in the two user layers of the bundle
(`docs/bundle-schema.md` §8). Nothing else is written.

| Layer | What an edit adds |
| --- | --- |
| `transcript/<id>.json` | A new revision from a retranscription. Earlier revisions are never rewritten. |
| `edits.jsonl` | One line per change: `correction`, `note` or `retract`. Old lines stay as the first bytes of the file. |
| `manifest.json` | `transcript.activeRevision` (which revision is read), `purpose` (what the recording is for) and the `files` list. |
| `agent/*`, `README.md`, `AGENTS.md` | Always written fresh from the edited tree, so they match the edits. A copy that came in with an imported zip is replaced, never kept. |

Captured files (page, audio, clock, observations, gaps) pass through byte for
byte. `RecordingLibrary.update` refuses any other change
(`packages/library/src/update-rules.ts`).

Every record keeps where it came from:

| Field | Meaning |
| --- | --- |
| `revisionId`, `segmentId`, `wordStart`/`wordEnd` | The original words a correction replaces. The revision file still holds them. |
| `supersedes` | The correction or note this one replaces. |
| `retract` `target` | A correction or note the user removed. |
| `carriedFrom` | The correction on an earlier revision this one was copied from. |
| `createdAt` | Wall time of the change. |
| `provider`, `model`, `source` (revision) | Which engine wrote a transcript. User text is always an edit, never a revision. |

## Timing

A correction has no times of its own. The corrected text stands on the time
span of the words it replaced. Three new words in place of one heard word
share that word's span; they never get invented per-word times.
`correctedSegment` returns the text as pieces, each marked `word` (the
engine's time for that word) or `span` (the time of the words it replaced).

Editing a line compares the typed text with the engine's words and writes the
smallest changed word range as one correction. The words around it keep their
own times. A line without word times is corrected as a whole and keeps the
segment span. Utterance times, pages, markers and gaps are the same before and
after any edit, so replay stays on the captured timeline. Time ranges cannot
be cut or deleted (v1).

Notes are anchored to session time: `atMs`, and optionally `endMs` for a span.
Both must be inside the recording.

## Changing and removing

| Action | Record written |
| --- | --- |
| Edit a line that has no correction | `correction` |
| Edit a line that has one correction | `correction` with `supersedes` |
| Edit a line that has several corrections | `retract` for each, then one `correction` |
| Type back what was heard | `retract` for each correction |
| Change a note | `note` with `supersedes` |
| Remove a note | `retract` |
| Change what the recording is for | `manifest.purpose` replaced; the old text is not kept |
| Clear what the recording is for | `manifest.purpose` removed |

An edit that changes nothing writes nothing. A refused edit (`EditError`
with a `code`) writes nothing.

## Retranscription after corrections

A new provider run is stored as a new revision. Its words are compared with
each active correction by session time (`planCarryForward` in
`packages/transcription/src/revisions.ts`):

| Outcome | Meaning | What happens |
| --- | --- | --- |
| `carried` | Same words there | A new correction with `carriedFrom` is written on the new revision. |
| `redundant` | The new words already say what the user wrote | Nothing to write. |
| `conflict` | Different words, no words, words across segments, or already corrected | The user decides. |

With no conflict, the new revision becomes the active one. With any conflict,
the new revision is stored but **not** activated. The user keeps reading their
corrected transcript, and the replay page shows the newer transcript as
waiting, with each conflict:

> You wrote "next" for "second". The newer transcript says "secant".

For each conflict the user picks:

- **Keep my text**: the user's text is written on the matching words of the
  new revision (`carriedFrom` the old correction). Only possible when the new
  words sit in one segment with no correction on them.
- **Use the newer words**: nothing is written. The old correction stays on its
  own revision.

Then the new revision becomes active (`resolveRetranscription`). A revision
with a gap (a failed upload) is also stored without being activated: it would
drop text the user reads. The user can switch to it on purpose.

The waiting state is in the bundle itself (a revision newer than the active
one), so it survives export, import and reopening (`waitingRevisions`).

`completeRetranscription` in `packages/transcription` follows the same rule:
a conflicting revision is stored with `notActivated: 'conflicts'`, and the
corrections that match are carried onto it. A retranscription must not
silently replace corrections the user reads.

## Writing to the library

`editRecording(library, id, change)` reads the stored tree and its library
revision in one read (`RecordingLibrary.read`), builds the change from it,
validates the new tree in full and writes it with `RecordingLibrary.update`,
passing that revision as `expectedRevision`. If another write landed after
the read, even one that changed only the manifest (a switch of the active
transcript), the library refuses with `recording-conflict` and the change is
built again from the newer tree (up to 3 tries). `change` is one of `correctSegment`,
`addCorrection`, `addNote`, `editNote`, `retractEdit`, `addRetranscription`,
`resolveRetranscription` or `setPurpose`.

## What the recording is for

Board #16594. The Start view asks "What is this recording for?" (optional).
The answer is `manifest.purpose`: the first header line of
`agent/walkthrough.md` and the "Why it was recorded" section of `README.md`.
It is edited afterwards in two places: Saved recordings (for a recording made
here, also written to its library copy) and the replay page (for a library
recording). `setPurpose` trims it; blank text removes it; more than 1,000
characters or a key-shaped value is refused (`text-too-long`, `credential`).

## Tests

- `packages/edits/test`: edits, export, import and reopen through the library;
  replay times unchanged; purpose set, changed and removed; retranscription conflict, keep-mine, take-new,
  redundant, gap and refusal cases; an edit built before a switch to the new
  revision does not undo the switch.
- `packages/extension/test/e2e/replay.mjs edit`: the replay page edits a line,
  adds and removes a note, switches to a conflicting transcript with
  keep-mine, and passes every seek check on the edited recording.
