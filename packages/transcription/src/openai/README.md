# OpenAI Whisper: after-recording transcription with word timing

Board #16547. One of the cloud options from `research/cloud-transcription`. The user's own OpenAI key pays; NarWal has no server.

**This option works after the recording stops.** It has no live mode. `OPENAI_WHISPER_INFO.liveTranscript` is `false`, and `describeOpenAiUpload` says so in the consent prompt. Do not show it as a live transcript source.

## Use

```ts
import { OpenAiWhisperAdapter, createDecodingSlicer, describeOpenAiUpload, UPLOAD_SAMPLE_RATE } from './index.ts';
import { retranscribe } from '../revisions.ts';

const adapter = new OpenAiWhisperAdapter({
  // Needed only for audio over 25 MB. Web Audio exists in an offscreen document, not in the service worker.
  slicer: createDecodingSlicer(() => new OfflineAudioContext(1, 1, UPLOAD_SAMPLE_RATE)),
  onProgress: ({ completedUploads, uploads }) => {},
});

// First transcript, or a new one for a recording that already has one.
const { history, revisionId, activated, items } = await retranscribe(store, adapter, request, credential, signal, { jobId, startedAtMs });
```

- `request.consent` must name `openai`, this recording and `narration-audio`. Without it nothing is uploaded (`UploadRefused('no-consent')`).
- One consent covers one upload job. A second job with the same consent is refused (`consent-already-used`): each upload is charged.
- The key goes in the `Authorization` header only. It is removed from every error message. This package stores no key.

## Cost and limits (list values, read 2026-10-13)

| | |
|---|---|
| Model | `whisper-1`, the only OpenAI model with word timestamps |
| Price | $0.006 per minute of audio, charged to the user's key |
| File limit | 25 MB per upload |
| Rate limit | 3 uploads per minute on a free-tier key; 2500 on the first paid tier |

`describeOpenAiUpload` turns these into the lines shown before the upload. `transcribeDetailed` returns the audio OpenAI billed and the list-price estimate.

## Long recordings

Audio over 25 MB cannot be cut at a byte offset (WebM/Opus), so it is decoded to 16 kHz mono WAV and sent as time ranges of about 12.8 minutes each.

- Neighbouring uploads share 4 s of audio. The cut goes to the longest silence in that shared audio, so no word is cut in half.
- Each word belongs to one upload, so no word appears twice.
- Word times from each upload are moved by that upload's start and by `audioOriginMs`, so all times are on the session timeline.
- Uploads go one at a time. The shared audio is billed twice: about 4 s per cut.
- whisper-1 can add text when an upload ends in silence. Segments with no text, and a phrase given less than 50 ms per word at the very end of an upload, are dropped (`dropUnspokenTail`). Seen in the live test: a repeated "Number 10." in 40 ms.
- Decoding holds about 8 MB per minute of narration in memory at the peak (1 GB for two hours), then about 2 MB per minute until the last part is sent.

## Retry and failure

- 429, 408, 5xx and network errors are retried up to 4 attempts with growing waits. `Retry-After` is obeyed up to 120 s.
- One attempt has 10 minutes for the upload and the answer (`requestTimeoutMs`). After that it counts as a timeout and is tried again. OpenAI can still charge for an attempt that timed out.
- Wrong key, no quota and bad input are not retried.
- If a later upload fails for good, the revision holds what was transcribed and a gap from there to the end, with the reason. `transcribeDetailed` also returns the error. A later part that is refused before it is sent (oversized, wrong type) is handled the same way: the parts already charged are kept.
- An empty, oversized (no slicer) or unsupported file is refused before any upload. `UploadRefused` always means nothing was sent, so the consent is given back.
- `TranscriptionFailed` is a `ProviderErrorException` (`../provider-error.ts`), the error class of the live adapters. The key is removed from messages by the shared `redactSecrets`.

## Revisions (`../revisions.ts`)

Follows `docs/bundle-schema.md` §8.

- A transcript is never edited. Each run adds a revision (`r1`, `r2`, …; at most 32) and makes it the active one. The recording and the earlier revisions stay.
- Corrections belong to one revision. After a new run each active correction is compared with the new revision by session time:
  - same words there: a new correction is written with `carriedFrom`;
  - the new revision already has the user's text: nothing to do;
  - different words, no words, or words split over segments: a conflict in `items` for the user. The correction is not applied to other words and is not dropped. With any conflict the new revision is stored but not made active (`activated: false`, `notActivated: 'conflicts'`); the matching corrections are still carried onto it.
- Corrections made while the upload runs are kept and carried too.
- A new revision with a gap (a later upload failed) is stored, but it does not replace a transcript the user already reads: `activated: false`, `notActivated: 'incomplete'`. The user can switch to it with `activateRevision` and `carryCorrections`. With no transcript yet, it becomes the active one.
- A second job for the same recording is refused while one runs. A job older than 30 minutes counts as abandoned and can be replaced. If the replaced job still finishes, its revision is stored but not made active (`activated: false`).
- Writes carry the version they read. A stale write is refused (`stale-version`) and applied again on the newest history.

## Live test (2026-10-13)

`scripts/openai-smoke.ts` runs `OpenAiWhisperAdapter.transcribeDetailed` against the live API with a real key. Without `--live` it sends nothing.

```sh
node scripts/openai-smoke.ts --audio ../offline-transcription/fixtures/speech-en-31s.flac \
  --reference ../offline-transcription/fixtures/speech-en-31s.json            # dry run
OPENAI_API_KEY=... node scripts/openai-smoke.ts --audio ... --reference ... --live
```

Audio: 31.5 s of LibriSpeech (CC BY 4.0) with word times from a forced aligner as the reference.

| Run | Result |
|---|---|
| One upload (FLAC, 444 kB) | PASS. 69 of 69 words returned, 68 matched to the reference; word start error median 62 ms, p90 240 ms; billed 32 s; answer in 4.4 s |
| Four uploads (16 kHz WAV, limit forced to 400 kB, `audioOriginMs` 5000) | PASS. 69 words, each once; all times on the session clock; word start error median 70 ms, p90 200 ms; billed 44 s (overlap is charged twice) |
| Rejected key | `auth`, `invalid_api_key`, not retried |

- The live answers are stored as fixtures (`fixtures/openai/live-speech-en-31s*.json`) and replayed by the tests.
- The first four-upload run returned 71 words: whisper-1 repeated "Number 10." in the closing silence of the last part. `dropUnspokenTail` came from that run.
- The live answer has the documented shape: `duration` is a number, `usage` is `{ type: "duration", seconds }`, word text has no punctuation.

## Not tested

- `createDecodingSlicer` is tested with a fake decoder, not in a browser. The live test cut a WAV file with `wavPcmSlicer`.
- The request was sent from Node, not from an extension page (`chrome-extension://` origin).
- 429 and `Retry-After` handling is tested with fixtures only: the live key was not rate limited.
- A real 25 MB upload was not sent; the four-upload run used a small limit.
- `StoredRevision` and `CorrectionEdit` follow the schema document (`docs/bundle-schema.md` §8), not the types of `packages/bundle`.
