# @narwal/offline-transcription

Browser-local English transcription for the NarWal extension (board #16544).
Speech is transcribed on the user's computer. The models download once, when
the user asks; after that no audio and no text leaves the browser.

This package is the engine side: model download and readiness, live
provisional text, the final pass with word times, retry from captured audio,
and the "falling behind" signal. Capture (#16542) hands it audio; the recorder
strip (#16551) shows its state. It has no UI of its own except the proof page
in `demo-extension/`.

## The engines

| Use | Model | Runtime | Download |
|---|---|---|---|
| Live text while recording, when Parakeet is not installed or does not load | Vosk small English 0.15 (`vosk-small-en-us`) | vosk-browser 0.0.8, WebAssembly | 41.2 MB |
| Live text while recording (#16617); final text after Stop, other computers | Parakeet TDT 0.6B v2, 8-bit (`parakeet-tdt-0.6b-v2-int8`) | sherpa-onnx 1.13.8 (ASR-only build, `vendor/sherpa-onnx/`), WebAssembly | 661.2 MB |
| Final text after Stop, WebGPU computers | Whisper large-v3-turbo, 4-bit weights with half-precision activations (`whisper-large-v3-turbo`) | transformers.js 4.3.1 on ONNX Runtime Web, WebGPU | 566.4 MB |
| Final text after Stop, WebGPU fallback; other computers when Parakeet cannot run | Whisper small.en, 8-bit (`whisper-small.en-q8`) | transformers.js 4.3.1, WebAssembly | 251.7 MB |
| Final text after Stop, slow computers | Moonshine base, 8-bit (`moonshine-base-q8`) | transformers.js 4.3.1, WebAssembly | 66.9 MB |
| Proof extension and default of `runFinalPass` only; no tier runs it since #16609 | Whisper base.en, 8-bit (`whisper-base.en-q8`) | transformers.js 4.3.1, WebAssembly | 79.6 MB |

Live is Parakeet when it is installed, Vosk otherwise (#16617, see **Live
engine** below). The final pass is Parakeet or Whisper, or
Moonshine on slow computers. Parakeet's word times are the TDT decoder's
token frames (`tdt-token-times`). Whisper word times come from attention
alignment; Moonshine gives none, so the pass spreads its words over each
span's speech. Those two are marked `approximate`.

**Which final model (#16603).** `src/tier.ts` is the one place that names
them. `detectFinalTier` picks `webgpu` for a hardware WebGPU adapter with
`shader-f16`; anything else (no adapter, SwiftShader, no half-precision
shaders) is `wasm`.

| Tier | Chain, best first | Offline download in total |
|---|---|---|
| `webgpu` | turbo, then small.en | 1520.5 MB |
| `wasm` | Parakeet, then small.en, then Moonshine base | 1021.0 MB |

The totals include both live models, Vosk and Parakeet (`LIVE_CHAIN`); on
`webgpu` Parakeet is downloaded for the live text only.

base.en was the last `wasm` model before #16609 (`RETIRED_FINAL` in
`src/tier.ts`). It is no longer downloaded, but a computer that holds it and
not Moonshine base still runs it last, so it keeps its final pass.

`finalizeWithChain` (`src/final-chain.ts`) runs the first installed model. A
missing, damaged or failing model moves the job to the next one. After 20 s
it projects the finish time; a model that would take longer than
10 min + audio length ÷ 4 stops and the next model starts. The last model
always finishes. A job resumed with `resumeFrom` goes on with that model
when it is still in the chain. After a crash the extension leaves the model
that was cut short out first (`chainAfterCutShort`), so the next one runs.

Each manifest entry names its `engine` (`vosk`, `transformers.js` or
`sherpa-onnx`) and carries that engine's `runtime`. The Whisper worker and its
network guard load only `transformers.js` entries (`TRANSFORMERS_MODEL_IDS`,
`transformersRuntime`); the sherpa-onnx worker loads only `sherpa-onnx`
entries (`isSherpaModel`, `sherpaRuntime`). `FinalModelId` and
`FINAL_MODEL_IDS` cover every final model, whatever its engine.

`implausibleFinal` (`src/plausible.ts`) says when a final text must not
replace the live one: no words, a phrase of 1 to 4 words repeated 4 or more
times back to back over 16 or more words, or under half the live text's words
when the live text has 20 or more.

The order is by word error rate on Matt's 113 s reading passage (234 words):
Parakeet 5.1%, turbo 6.0%, Moonshine base 9.4%, small.en 9.8%, base.en
28.6%, live Vosk 45.3%. The full table, with Cohere and the native speeds, is
on #16603; the harness and every stored output are in
`docs/validation/wer-16603/`. Moonshine comes after small.en although its
error rate is close: it gives no word times. In the browser it takes 0.06 ×
audio length at 4 threads and 0.11 at 1 thread, against 0.14 and 0.26 for
base.en (`e2e/bench-final.mjs`, #16609).

**Parakeet in the extension (#16608).** `e2e/measure-final.mjs` runs one
final model in the demo extension's offscreen document and reports its speed,
memory and word error rate. On the 113 s passage, Chromium, scored with the
#16603 scorer (`docs/validation/parakeet-16608/` has the outputs):

| Model | Browser | WER | Wall time | × audio | Heap | Browser RSS rise |
|---|---|---|---|---|---|---|
| Parakeet, 1 WebAssembly thread | all cores | 9.0% | 29.2 s (load 2.1 s) | 0.26 | 0.98 GB | 1.32 GB |
| Parakeet, 1 WebAssembly thread | one core (`taskset -c 5`) | 9.0% | 31.8 s (load 3.0 s) | 0.28 | 0.98 GB | 1.32 GB |
| small.en, 4 WebAssembly threads | all cores | 14.1% | 46.1 s (load 2.8 s) | 0.41 | - | 1.19 GB |

On a loaded machine Parakeet took about 0.42 × (NarWal#39 review). Those rows
are #16608's: then both scored worse than over the whole file natively (5.1% and
9.8%), because the pass cuts the audio into speech spans of 20 s or less.

**Context at span cuts (#16621).** A span cut mid-speech, or under 1 s, is now
decoded with 2 s of the audio around it (`src/span-context.ts`), and Whisper's
word pieces join the word before (`src/engines/whisper-words.ts`). In the
extension Parakeet now scores 5.6% and small.en 9.0%. The extra audio makes
Parakeet slower: 0.32 × on one core (was 0.28). The longest recording inside
10 min + audio/4 is about (600 s − load) ÷ (speed − 0.25): about 147 min at
0.32 ×, and about 1 h at 0.42 × on a loaded machine; a longer one moves to the
next model. `docs/validation/accuracy-16621/` has the split, the policies tried
and the outputs. On the 31 s e2e fixture
Parakeet got all 69 words; its token-frame starts ran 33 ms late at the
median, so the pass moves them 30 ms earlier (`SHERPA_TIMING`): then +3 ms at
the median and within 83 ms at p90. The engine is sherpa-onnx built for
ASR only (`vendor/sherpa-onnx/README.md` says why and how to rebuild it).

**Live engine (#16617).** `liveEngineChain` (`src/live-chain.ts`) opens the
first installed live model in `LIVE_CHAIN` (`src/tier.ts`): Parakeet, then
Vosk. A model that is missing, damaged or fails to load moves the session to
Vosk, and `liveFallback` says why. So does a Parakeet that falls so far behind
that the session skips audio (`maxBacklogMs`, 60 s): on that machine it would
skip again every minute, so the session hands over to Vosk at the first skip. Start needs one of them (`readyLiveModel`).
Parakeet has no streaming mode here: the session cuts the audio with the same
energy VAD as the final pass and transcribes each span when it closes, so
there is no provisional text. A span closes at a 0.6 s pause or at 6 s
(`LIVE_VAD` in `src/engines/parakeet-live.ts`). Live Parakeet finals carry
token-frame word times: `timing: "approximate"`, `tdt-token-times`.
`e2e/measure-live.mjs` ran the live session at real speed in the demo
extension (`docs/validation/parakeet-live-16617/` has the outputs):

| Live engine | WER, 113 s passage | Word on screen after it was spoken, p50 / p90 | Browser CPU, mean / p90 | Heap | Browser RSS rise |
|---|---|---|---|---|---|
| Parakeet, 6 s spans | 12.0% | 4.7 / 6.8 s | 0.33 / 1.0 cores | 0.86 GB | 0.8 GB |
| Parakeet, 6 s spans, one core | 12.0% | 5.0 / 7.1 s | 0.37 / 1.0 cores | 0.86 GB | 1.0 GB |
| Vosk | 45.3% | provisional words in 0.4 / 0.5 s | 0.28 / 0.37 cores | - | 0.25 GB |

8 s spans scored the same with each word a second later; 5 s spans cost 1.2
points and 4 s nearly 8, because the cuts land inside words. No run skipped
audio, restarted the engine or delivered a captured chunk late. The live
worker stops when the session finishes, before the final pass loads its own
Parakeet.

The runtimes ship inside the extension package (`dist/runtime/`, 46.8 MB:
the three workers, the ONNX Runtime WebAssembly file and the sherpa-onnx
WebAssembly file). Model weights are data:
they are downloaded, checked against pinned SHA-256 values and kept in the
Cache API (`narwal-models-v1`).

### The model picker (#16611)

Each model with a `measured` block in `models.ts` is a row of the picker
(`picker.ts`, `pickerRows(tier)`): word error rate on the passage and where
it ran (in the extension where possible; turbo only natively, as the test machine has no
WebGPU), the speed as × audio length and the setup it was timed on, memory,
the tier it needs (WebGPU or WebAssembly), and where the numbers come from
(`docs/validation/picker-16611`). The bars have five steps and come from the
numbers only:

| Steps | 5 | 4 | 3 | 2 | 1 |
| --- | --- | --- | --- | --- | --- |
| Accuracy: word error rate at or under | 6% | 10% | 20% | 35% | more |
| Speed: real-time factor at or under | 0.1 | 0.2 | 0.4 | 0.8 | more |

The live model keeps up with the voice, so its speed is 5. A model that needs
WebGPU is a greyed row with the reason on a computer without it, not hidden.

The choice is one model id or none. `chainFor(choice, tier)` gives the
models to try after Stop: none chosen, the tier chain; the live model,
nothing (the live text is the transcript); a final model, that one and then
the tier chain. A choice this computer cannot run counts as none.
`installedChain(choice, installed)` keeps the installed ones, the pick first
(even a retired one). `modelsToDownload` gives what the download button
installs: Vosk and the chosen one, or the tier chain with Parakeet for the
live text. Start needs one live model; the picker never blocks it. Live uses
Parakeet whenever it is installed, whatever the pick.

## Use

```ts
import { createBrowserOfflineTranscriber } from '@narwal/offline-transcription/src/browser.ts';

const { transcriber } = createBrowserOfflineTranscriber(chrome.runtime.getURL('runtime/'));

// 1. Readiness. Nothing downloads until the user asks.
await transcriber.models.statusAll();                 // missing | downloading | ready | corrupt | failed
await transcriber.models.install('vosk-small-en-us', { onProgress });
await transcriber.models.verify('whisper-base.en-q8'); // full hash check
await transcriber.models.repair('whisper-base.en-q8'); // fetches only the bad files
await transcriber.uiModel();                           // the shape the recorder strip shows

// 2. Live. The same surface as the cloud live adapters, without a credential.
const session = await transcriber.startLive({ language: 'en', audioOriginMs, connectionId }, onEvent);
session.sendAudio(pcm16Chunk);   // 16 kHz mono PCM16. Never blocks, never throws.
await session.finish();

// 3. Final pass, or a retry of chosen time ranges, from the captured audio.
const { revision } = await transcriber.finalize({
  recordingId, revisionId, audio, timeMap, supersedes: liveRevisionId,
  ranges, base,            // retry only
  resumeFrom, onCheckpoint // survives a closed tab or a crashed engine
});
```

`onEvent` receives the cloud contract's events (`segment`, `gap`, `error`,
`state`) and one local event, `backlog`. `LiveRevisionCollector` turns the
events into the live revision. `UiTranscriptTracker` turns them into the
transcript state the strip shows.

### What capture has to provide (#16542)

- Live: contiguous 16 kHz mono audio, as PCM16 `ArrayBuffer` chunks to
  `sendAudio` or `Float32Array` to `pushAudio`, and the session time of the
  first sample (`audioOriginMs`). A tap at the device rate uses
  `StreamResampler`, or an `AudioContext({ sampleRate: 16000 })`.
- Final: a `PcmSource` over the captured narration (`decodeToEnginePcm`
  decodes a stored file) and `fitAudioClock(pairs)` over the bundle's clock
  pairs as `timeMap`.
- The engines run in the offscreen document. An offscreen document has
  `chrome.runtime` only: keep checkpoints in IndexedDB, or send them to the
  service worker.

### What the extension manifest needs

```json
{
  "permissions": ["unlimitedStorage", "offscreen"],
  "host_permissions": ["https://huggingface.co/*", "https://*.hf.co/*", "https://ccoreilly.github.io/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co https://ccoreilly.github.io"
  },
  "cross_origin_embedder_policy": { "value": "require-corp" },
  "cross_origin_opener_policy": { "value": "same-origin" }
}
```

The two cross-origin keys make extension pages cross-origin isolated, which
WebAssembly threads need. They apply to every extension page: a page that
loads a cross-origin image or frame needs that resource to allow it.

## Behaviour

**Model missing or damaged.** `startLive` and `finalize` never download.
Live returns a session that reports `model-missing` or `model-corrupt` once
and records the audio as one gap. The final pass rejects with a `ModelError`
before it does any work. The gap stays in the revision, so a retry after the
user repairs the model fills it from the captured audio.

**Falling behind.** `sendAudio` copies the chunk and returns; it does no
engine work. When recognition is more than `behindMs` (10 s) behind, the
session emits `backlog { behind: true, lagMs }`. With more than `maxBacklogMs` (60 s) of audio waiting
it skips ahead and records the skipped audio as an `engine-behind` gap. A
stalled engine is restarted, at most `maxRestarts` times. Capture is never
slowed, paused or dropped by any of this.

**Engine failures.** A Vosk worker that fails to start is replaced once,
after its extracted model copy is deleted; later starts reuse that worker.
A live Parakeet engine that does not load, fails or stalls gives way to Vosk
for the rest of the document's life (`src/live-chain.ts`).
A Whisper or Parakeet call that does not answer within `transcribeTimeoutMs` (120 s; a
span is at most 20 s of audio) stops the hung worker and fails; the final
pass records the span as an `engine-failed` gap, and the next call starts a
new worker.

**Revisions.** Every run writes a new revision; none is edited. The final
pass names the revision it replaces in `supersedes`. A retry takes time
ranges and a base revision, transcribes only the speech in those ranges and
carries every other segment over unchanged.

**Timing.** Vosk live finals carry Vosk's word alignment: `timing: "aligned"`.
Interim text has no word times. Parakeet live finals carry its token frames,
shifted as in the final pass, and are `approximate`; a live revision with
both is `mixed` (`liveRevisionModel`). Whisper word times are shifted by a constant
−150 ms (the bias #16539 measured) and marked `timing: "approximate"`; the
revision says `{ quality, method: "whisper-dtw", correctionMs: -150 }`.
Parakeet word times are its token frames, shifted by −30 ms (`SHERPA_TIMING`,
#16608): `{ quality, method: "tdt-token-times", correctionMs: -30 }`.
Moonshine gives text only. Each word gets a share of the span's voiced 20 ms
windows (pauses up to `shortPauseS` count as speech) in proportion to its
letters and digits (`src/word-times.ts`); the revision says
`{ quality: "approximate", method: "span-interpolated", correctionMs: 0 }`.
Moonshine needs spans of 20 s or less (a whole file gave 99.6% WER); the VAD
plan already caps spans at 20 s. A retry over a live revision holds both
kinds and is `mixed`.

**Same contract as the cloud adapters.** `src/contract.ts` is the cloud
contract (`packages/transcription/src/contract.ts`) plus the local additions.
This change adds `browser-local`, `timing`, `supersedes` and the local gap
reasons to the shared contract, so `addRevision` in the shared history takes a
local revision as it is. A stored gap uses `reason: "not-transcribed"` with
the local reason in `detail`, as `docs/bundle-schema.md` §8.1 says.
`test/shared-contract.test.ts` checks that the file the shared history stores
is the file `toBundleRevision` writes.

## No cloud traffic

There is no cloud fallback in this package: no code path sends audio or text
anywhere, and a failure produces a gap, never another provider's text. The
proof has five independent layers.

1. **Engine guard.** Each engine worker replaces `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource` and `sendBeacon` before the engine loads. It
   allows the worker's own packaged files and the local model store, refuses
   everything else and keeps a ledger.
2. **Extension policy.** `connect-src` allows the model hosts only.
3. **Network off.** The e2e offline phases run with DNS resolution disabled
   and the browser context offline. A request to an allowed host must fail
   first (negative control), so "no traffic" cannot mean "the check is blind".
4. **Chromium NetLog.** Every request the browser starts is logged. Requests
   whose initiator is the extension are counted per phase; every other
   request in the log must be one of Chromium's own service hosts.
5. **Download ledger.** The model store records each file it fetched.

## Results

`npm run e2e` runs the built extension in Chromium 153 (headless, Playwright)
on the 31.5 s English fixture. Model setup uses the network; then every
transcription phase runs with the network disabled. Each phase is a new
browser process on the same profile, so models, revisions and the checkpoint
must survive a restart. Summaries: `results/e2e.summary.json` (pinned public
hosts) and `results/e2e-2core.summary.json`. Both runs: 79 of 79 checks
passed, 2026-10-13.

| | Full machine (i7-12700, 20 threads) | Two efficiency cores |
|---|---|---|
| Final-pass threads | 4 | 2 |
| Live: engine start | 1.3 s | 1.9 s |
| Live: word error rate | 0.13 | 0.13 |
| Live: text visible after the word, p50 / p90 | 0.30 s / 0.48 s | 0.32 s / 0.50 s |
| Live: word start error, p90 | 36 ms | 36 ms |
| Live: most behind | 0.5 s | 0.6 s |
| Final: word error rate | 0.072 | 0.072 |
| Final: word start error, median / p90 | 60 ms / 110 ms | 60 ms / 110 ms |
| Final: time for 3 engine calls (model load included) | 6.6 s | 15.0 s |
| Retry of the 8–20 s range (3 spans, 19 s of audio) | 9.2 s | 35.3 s |

What the checks cover:

- **A, online, no model:** live and final report `model-missing`; capture is
  complete; nothing is downloaded; the extension makes zero requests.
- **B, online:** explicit install with progress; hashes verified; 120.7 MB
  stored; requests went to the pinned hosts only (`ccoreilly.github.io`,
  `huggingface.co` and its CDN).
- **C, offline:** live text in the offscreen document at real time; a final
  pass cancelled after two spans leaves a checkpoint.
- **D, offline:** the final pass resumes from the checkpoint after a restart
  and supersedes the live revision; both are kept. Audio fed at 12× makes the
  session fall behind: every sample is still captured (504,000 of 504,000),
  the hand-over never took more than 1.3 ms, and the skipped audio is marked
  as gaps. A damaged file in each model gives `model-corrupt` and no text.
  Repair fails visibly while offline.
- **E, online:** repair downloads only the damaged file.
- **F, offline:** live works again; a retry of 8–20 s on the final revision
  writes a third revision; all three are kept.
- **Network, every offline phase:** the engines tried zero outside requests.
  The only extension requests in the NetLog are the negative-control probe and
  the repair the test asked for; both failed.

The accuracy limits in the e2e (`liveWer ≤ 0.2`, `finalWer ≤ 0.12`) are
regression bounds for one 69-word fixture, not a claim about general
accuracy. #16539 holds the longer measurements.

### Supported machines, and what was not measured

#16539 declared a 2-vCPU cloud browser without GPU as the floor. The shared
Browserbase helper cannot load an unpacked extension, so the extension was
**not** run on that machine. The second column is a stand-in: the same
desktop with the browser pinned to two efficiency cores (`taskset -c 16,17`)
and the final engine capped at two threads. Those cores were shared with
other work during the run, so its times are upper bounds. The combined
30-minute check on a declared machine belongs to the acceptance ticket
(#16552).

Not measured here: a real laptop, WebGPU, live timing drift over 30 minutes,
and memory use over a long recording.

## Known risks

- **vosk-browser is unmaintained** (0.0.8, 2022). It starts its worker from a
  blob and builds functions from strings, which an MV3 extension forbids.
  `build.mjs` takes the worker out of the bundle and replaces three embind
  helpers with closures. The input file is hash-pinned; `test/build.test.ts`
  checks the replacements behave like the originals.
- **Parakeet memory.** Its WebAssembly heap grows to about 1 GB during the
  final pass, and the browser's resident memory rose 1.3 GB (#16608). Live
  Parakeet holds 0.86 GB while recording, in the page that also records
  (#16617). A new recording started while an earlier final pass still runs
  holds both. A computer that cannot spare that fails the load; the live
  chain then runs Vosk and the final chain small.en.
- **Third-party model hosts.** The Vosk archive comes from a GitHub Pages
  site, and Whisper, Moonshine and Parakeet from Hugging Face, at a pinned revision. Hashes protect
  integrity, not availability. Hosting the files ourselves is a later
  decision (no NarWal server exists).
- **Licence.** Vosk small English is Apache-2.0. Whisper is MIT; the ONNX
  conversion repositories (`onnx-community/whisper-base.en_timestamped`,
  `whisper-small.en_timestamped`, `whisper-large-v3-turbo_timestamped`) have
  no licence tag. Moonshine base is MIT, and its conversion
  (`onnx-community/moonshine-base-ONNX`) is tagged MIT. Parakeet TDT 0.6B v2
  is NVIDIA's, CC-BY-4.0; the k2-fsa ONNX export
  (`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`) is tagged
  CC-BY-4.0 too, and the notice credits NVIDIA. sherpa-onnx is Apache-2.0;
  its published WebAssembly build also links espeak-ng (GPL-3.0) for text to
  speech, so `vendor/sherpa-onnx/` holds an ASR-only build without it. The
  repository licence is deferred (#16531); review this
  before a public release. The build strips legal comments from the code, so
  `third-party/NOTICES.txt` (Apache-2.0, MIT, BSD and zlib components, and
  every model) and ONNX Runtime's own notices ship in `dist/runtime`. The
  build fails when a bundled package has no entry at its installed version.
- **Storage.** 1021.0 MB (WebAssembly tier) or 1520.5 MB (WebGPU tier) in the Cache API, plus the copy Vosk extracts into
  IndexedDB on first start. `remove` deletes both.
- **Engine start.** The first live words wait for the engine to start
  (Vosk 1.3–3 s, Parakeet 3–5 s, 6 s on one core) and, with Parakeet, for the
  first span to close. Starting the engine when the recorder opens would
  remove the first part.

## Develop

```sh
npm ci
npm test           # node --test
npm run typecheck
npm run build      # dist/runtime and dist/demo-extension
npm run e2e        # needs Playwright's Chromium
```

`NARWAL_MODEL_MIRROR=<dir>` serves `<dir>/<modelId>/<path>` in place of the
download hosts, and `NARWAL_E2E_THREADS=<n>` caps the final engine.
`dist/demo-extension` loads as an unpacked extension; its page shows model
readiness and runs the same checks by hand.
