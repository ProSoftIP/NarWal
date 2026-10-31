# Browser-local English live transcription: measured (board #16539)

Map #16531. The question: which model and runtime can transcribe English live, inside the
browser, with no desktop helper and no NarWal server, and still give usable word timing over a
30-minute narration?

**Answer: feasible on a 2-vCPU, no-GPU floor machine. Recommended: two engines.**

- **Live (while narrating): Vosk (Kaldi) small English model through `vosk-browser`.** Over
  30 minutes it used 0.18 cores, showed words 0.34 s after they were spoken (p90 0.50 s), and
  put word starts within 38 ms (p90) of a forced alignment. Its accuracy is the lowest measured
  (WER 9.6 % over 30 minutes of read speech).
- **Final (after Stop): Whisper base.en (q8) through transformers.js on WASM.** WER 3.7 %,
  word starts within 0.27 s (p90). Finalizing 30 minutes of audio took 10.0 minutes on the
  same machine.
- This matches the settled design: "live transcript while narrating, finalized after stopping"
  (INTERVIEW-07). The live text is a draft; the final text replaces it.

**Alternative, also measured: Whisper base.en alone, live.** On 2 vCPU it kept up for the
full 30 minutes with no drift: final-text delay 22.4 s p90 in the first 5 minutes and 22.1 s
in the last 5. WER was 4.5 %, and the final text is ready about 23 s after Stop, with no
10-minute wait. The costs: words appear 4.5 s late (p90 7.7 s), and it uses 1.6 of the 2 cores
for the whole session. That leaves 0.4 cores for the page being narrated, the capture and the
extension. Whether it is the better default depends on typical users' laptops, which are
not measured (see [Smallest follow-up](#smallest-follow-up)).

Rejected: Whisper tiny.en (word times 0.36 s late on median, 2 words invented in silence over
30 minutes, and less accurate than base.en for little gain) and whisper.cpp
(`@transcribe/shout`), which falls minutes behind on 2 vCPU and gives token times only.

Machine measured: **one** cloud browser (below). WebGPU and real laptops are **not measured**;
see [Not measured, and why](#not-measured-and-why).

## Machine

| | |
|---|---|
| Where | Browserbase cloud browser, one fresh session per run (session URLs in each `results/*.summary.json`) |
| Browser | Chrome 155, Linux x86_64 |
| CPU | `navigator.hardwareConcurrency` = **2** |
| Memory | `navigator.deviceMemory` = 8 (GB, browser-rounded) |
| GPU | **No WebGPU adapter** (`navigator.gpu.requestAdapter()` → null) |
| Isolation | Cross-origin isolated (COOP `same-origin`, COEP `credentialless`), so WASM threads and SharedArrayBuffer work |

Why this machine: it is an approved test machine, it is the weakest realistic target (2 cores,
no GPU, like a low-end Chromebook or an old Windows laptop), and nothing in the measurement
runs on the controlling machine. It only serves the harness files and reads results over CDP; it ran no
model inference and no synthetic load.

## Method

- **Fixtures** (`fixtures/build_fixtures.py`, seed 16539): LibriSpeech test-clean utterances
  (CC BY 4.0) joined into one 1795.6 s stream (3893 words) and one 120 s clip (279 words).
  Gaps of 0.3–1.5 s between utterances, plus a 6–12 s silence about every 2 minutes, so
  hallucination in silence is visible. Reference word times are Montreal Forced Aligner
  alignments (`gilkeyio/librispeech-alignments`, CC BY 4.0).
- **Feed** (`harness/harness.js`): 16 kHz mono Float32 frames of 100 ms, paced by the wall
  clock, as an AudioWorklet would deliver them. The microphone and AudioWorklet are bypassed
  (slice A/G owns capture); everything after "frames arrive" is measured.
- **Live policy for Whisper-type engines** (they transcribe chunks, not streams): energy VAD
  (RMS > 0.004 over 20 ms); commit a final segment at a pause of ≥ 0.6 s, or force one at 20 s
  at the last short pause; while a segment is open and the engine is idle, re-transcribe it
  every 1.5 s as an interim. Silence is never sent to the model.
- **Finalize-after-stop** (`batch-*` runs): the same VAD segmentation over the whole
  recording, transcribed as fast as possible, no interims.
- **Vosk** is a streaming recognizer: frames go straight in; it emits partials and finals.
- **Load**: cold load (download + compile), two warm-up inferences on 8 s, then a cached
  reload in a fresh engine instance (Cache API / IndexedDB, no network), then the run.
- **Offline**: after the run, the browser context is set offline
  (`BrowserContext.setOffline(true)`), the engine is disposed and rebuilt from the local cache,
  and it transcribes 8 s of speech.
- **Scoring** (`score.mjs`): WER of final words after normalisation (case, punctuation,
  hyphens, integers to words, Mr/Mrs/Dr/St). Word timing: signed start/end error of every word
  aligned as an exact match. Visible latency: from the end of a spoken word to the first
  partial or final that shows it. Final latency: to the final that commits it. Silence
  insertions: hypothesis words that start inside a reference gap. CPU: Chrome's per-process
  CPU time (`SystemInfo.getProcessInfo`) every 15 s, as cores in use. Memory:
  `performance.measureUserAgentSpecificMemory()`. Download: bytes per host from the network
  log.

## Results: 2-minute clip, all six configurations

| Run | WER | Start error median / p90 | Starts ≤ 250 ms | Start bias | p90 after removing bias | Visible latency p50 / p90 | Final latency p50 / p90 | Cores used (mean) | Memory max | Download | Cold load | First inference (8 s) | Cached reload | Offline reload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Vosk small | 11.8 % | **0.018 / 0.038 s** | **100 %** | +0.016 s | 0.026 s | **0.34 / 0.50 s** | 4.4 / 9.4 s | **0.20** | 330 MB | 43.5 MB | 4.4 s | 3.3 s | 1.1 s | PASS |
| Whisper tiny.en q8 (transformers.js) | 6.5 % | 0.363 / 0.608 s | 9 % | +0.397 s | 0.245 s | 2.5 / 3.9 s | 7.5 / 17.3 s | 1.01 | 410 MB | 49.4 MB | 6.7 s | 3.4 s | 0.7 s | PASS |
| Whisper base.en q8 (transformers.js) | **3.2 %** | 0.143 / 0.260 s | 87 % | +0.160 s | 0.117 s | 4.8 / 8.2 s | 12.2 / 22.6 s | 1.26 | 572 MB | 85.4 MB | 7.8 s | 4.0 s | 0.9 s | PASS |
| Whisper base.en, fp32 encoder | 3.9 % | 0.143 / 0.268 s | 86 % | +0.163 s | 0.125 s | 6.6 / 10.1 s | 15.5 / 24.9 s | 1.18 | not reported¹ | 144.8 MB | 9.8 s | 4.9 s | 1.3 s | PASS |
| whisper.cpp tiny.en q5_1 (`@transcribe/shout`) | 5.7 % | 0.147 / 0.792 s | 65 % | −0.055 s | 0.787 s | 34 / 51 s | 39 / 56 s | 1.41 | 3940 MB² | 34.5 MB | 2.3 s | 44.7 s | 0.5 s | PASS |
| whisper.cpp base.en q5_1 (`@transcribe/shout`) | 4.3 % | 0.167 / 0.739 s | 64 % | +0.154 s | 0.679 s | 142 / 179 s | 142 / 183 s | 1.66 | 4325 MB² | 62.1 MB | 3.4 s | 49.5 s | 1.0 s | PASS |

No configuration inserted words during the silences of the 2-minute clip.

¹ `measureUserAgentSpecificMemory` returned no sample in that session.
² whisper.cpp's WASM build reserves a large SharedArrayBuffer up front; this is reserved
address space attributed to the page, not 4 GB of touched memory, but a browser will count it.

"p90 after removing bias" is the best a fixed per-model correction could reach. It is
optimistic: the bias is fitted on the same words it is scored on.

## Results: 30 minutes

### Finalize after Stop (whole recording, as fast as possible)

| Run | WER | Start error median / p90 | Starts ≤ 250 ms | Start bias | p90 after removing bias | Silence insertions | Time to finalize 30 min | Real-time factor | Cores used (mean) | Memory |
|---|---|---|---|---|---|---|---|---|---|---|
| Whisper base.en q8 | **3.7 %** | 0.134 / 0.267 s | 87 % | +0.152 s | 0.134 s | 0 | **10.0 min** | 0.33 | 1.70 | 562 MB³ |
| Whisper tiny.en q8 | 5.0 % | 0.357 / 0.588 s | 16 % | +0.386 s | 0.232 s | 1 | 7.0 min | 0.23 | 1.56 | 442 MB³ |

³ One sample at the end of the run; the periodic samples did not fire while the batch loop
ran, so memory growth over the batch is not measured.

### Live (wall-clock paced, 30 minutes)

| Run | WER | Start error median / p90 | Starts ≤ 250 ms | Start bias | Silence insertions | Visible latency p50 / p90 | Final latency p50 / p90 | Final p90, first / last 5 min | Max backlog | Cores used (mean / p90) | Memory first → max | Memory growth |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Vosk small | 9.6 % | **0.017 / 0.038 s** | **100 %** | +0.015 s | 0 | **0.34 / 0.50 s** | 4.3 / 10.8 s | 10.6 / 11.2 s | 0 s | **0.18 / 0.19** | 437 → 598 MB | +43 MB / 10 min |
| Whisper base.en q8 | **4.5 %** | 0.134 / 0.267 s | 88 % | +0.152 s | 0 | 4.5 / 7.7 s | 12.9 / 23.0 s | 22.4 / 22.1 s | 26 s | 1.59 / 1.83 | 637 → 687 MB | +5 MB / 10 min |
| Whisper tiny.en q8 | 5.8 % | 0.357 / 0.593 s | 17 % | +0.388 s | 2 | 2.8 / 4.9 s | 10.3 / 20.6 s | 19.7 / 21.0 s | 23 s | 1.39 / 1.70 | 493 → 521 MB | +7 MB / 10 min |

All three ran for the full 1795.6 s at wall-clock pace and passed the offline reload afterwards.
"Max backlog" is the age of the oldest audio not yet committed as final. For Whisper it is
bounded by the 20 s forced segment plus one inference, and did not grow over the session. Vosk's
memory grew about 43 MB per 10 minutes (about 130 MB over 30 minutes). That is acceptable for
the 30-minute target; for longer sessions, recreate the recognizer at a pause (the model stays
loaded).

Whisper's live WER (4.5 %) is higher than the same model after Stop (3.7 %), because live
segments are cut at forced 20 s boundaries while the speaker is still talking.

## Recommendation

1. **Build the live view on Vosk small and the final transcript on Whisper base.en q8**
   (transformers.js, WASM). It is the only combination measured to leave the machine mostly
   idle during narration (0.18 cores) while still giving accurate final text and timing.
2. **Keep Vosk's word times for the final transcript where the words match**: align the
   Whisper final to the Vosk words (the same alignment `score.mjs` uses). Whisper's own times
   are 0.15 s late on median; subtract that offset where no Vosk word matches.
3. **Show finalizing progress after Stop**: about one third of the recording length on a
   2-core machine. Recording a new walkthrough must stay possible while it runs.
4. **Make Whisper base.en live an option, not the default**, until a laptop run shows it leaves
   enough CPU on typical machines. If it does, it removes Vosk (and its maintenance risk) and the
   post-Stop wait.
5. **Download both models on first use, about 121 MB**, with `navigator.storage.persist()`.
   Record even when they are missing (see the failure plan).

## Downloads and offline-after-download

| Piece | Size | Source in the test | In the extension |
|---|---|---|---|
| ONNX Runtime Web WASM (`ort-wasm-simd-threaded.asyncify.wasm`) | 26.9 MB | jsDelivr (7.9 MB transferred with transformers.js, compressed) | **Must ship inside the extension package**: MV3 forbids remotely hosted code, and a `.wasm` module is code. |
| transformers.js `dist/transformers.js` (bundles ORT JS) | ≈ 1.3 MB | jsDelivr | Ship in the package. |
| Whisper base.en q8 (encoder + merged decoder + tokenizer/config) | 79.6 MB | huggingface.co (`onnx-community/whisper-base.en_timestamped`) | Download once on first use; model weights are data, not code, so a download is allowed. |
| Whisper tiny.en q8 | 43.5 MB | same | same |
| `vosk-browser` `dist/vosk.js` (Kaldi WASM inlined, worker inlined) | 5.6 MB (2.3 MB transferred) | jsDelivr | Ship in the package (see the MV3 note under [Risks](#risks-and-unknowns)). |
| Vosk small English model `vosk-model-small-en-us-0.15.tar.gz` | 41.2 MB | ccoreilly.github.io | Download once; better: host a copy we control (Apache-2.0 allows it). |

Live + final pair (Vosk small + Whisper base.en q8): **≈ 121 MB of model downloads** plus
≈ 34 MB of runtime in the package.

Offline behaviour, measured: after one online load, every configuration reloaded from the
browser's local storage and transcribed with the network off (column "Offline reload" above).
transformers.js reads model files from the Cache API (`transformers-cache`); Vosk keeps the
unpacked model in IndexedDB (Emscripten IDBFS); whisper.cpp files came from the harness's own
Cache API store. With the network off, every reload and inference succeeded, so none needed the network after the first load.

What the test does not prove: the browser can evict Cache API and IndexedDB data under storage
pressure. The extension must call `navigator.storage.persist()` (or hold the
`unlimitedStorage` permission), check that the model is present before recording, and say so
when it is not. The ORT and Vosk runtimes came from the HTTP cache in the offline check; in the
extension they are in the package, so that difference does not matter.

## Word-timing limitations

- **Vosk**: word times come from the Kaldi decoder's own alignment. Measured error 18 ms median,
  38 ms p90 on read speech. Partial results carry no word times; only finals do. Finals arrive
  when Kaldi's endpointer sees silence: over 30 minutes, 4.3 s median after the word, p90
  10.8 s, worst 19.7 s.
- **Whisper (transformers.js `_timestamped` models)**: word times come from cross-attention
  DTW (`return_timestamps: 'word'`). They are systematically late (base.en +0.16 s, tiny.en
  +0.40 s on median); a fixed per-model offset removes most of that (p90 0.12 s for base.en).
  Times are relative to the chunk, so the caller adds the chunk's start; a word cut by a forced
  20 s boundary can be split or doubled. Words in a re-transcribed interim can move or change;
  only a final's times are stable. Whisper writes numbers and abbreviations ("Mr.", "1850")
  its own way, so a word does not always map one-to-one to the spoken token.
- **whisper.cpp (`@transcribe/shout` 1.0.7)**: the published WASM build exposes token
  timestamps only (no DTW field in its output), so word times are merged from tokens. p90 error
  0.74–0.79 s: not usable for click-to-moment alignment.
- **All engines**: read LibriSpeech speech is cleaner than real narration (pauses, "um",
  clicks, background noise, accents). Timing error on real narration will be larger; the
  ranking is unlikely to change.
- **Combining the two**: the final Whisper text can keep Vosk's word times by aligning the two
  word sequences (the same Levenshtein alignment `score.mjs` uses); unmatched Whisper words get
  bias-corrected Whisper times. Recommended (see [Recommendation](#recommendation)); not built or
  measured here.

## Failure and recovery plan

The design already settles the user-facing rules: capture is never lost when transcription
fails, gaps are shown, retry is explicit, offline audio is never uploaded silently and no paid
provider is switched in silently. Within that:

| Failure | Detection | Recovery |
|---|---|---|
| Model not downloaded / evicted | Check before recording (Cache API / IndexedDB presence + size) | Record anyway; show "transcript pending: model not downloaded"; offer download; transcribe the saved audio after. |
| Download fails or is interrupted | `fetch` error or size mismatch | Keep partial files out of the cache (write only complete responses); retry with backoff; the user can still record. |
| Runtime cannot start (no SIMD/threads, WASM compile error, low memory) | Engine `init` throws; or `crossOriginIsolated` false → single-thread fallback | Fall back to Vosk only (smallest, single-threaded, 0.2 cores); if that fails, record audio only and say why. |
| Live engine falls behind | Backlog (age of the oldest uncommitted audio) above 40 s; the measured normal maximum is 26 s for Whisper and 0 s for Vosk | Stop interims; keep finals only; mark the live view "catching up". Never drop audio: the recording is the source of truth and the final pass covers it. |
| Live engine crashes mid-session (worker/tab error) | Worker `error` / no event for 15 s while audio flows | Restart the engine; feed from the last committed final; mark the span in between as a gap; the final pass fills it. |
| Final pass fails or the user closes the tab | Job state persisted per segment | Resume from the last finished segment next time; segments already finished stay. Explicit "retry transcription" per gap. |
| Hallucination in silence | Words inside VAD-silent spans | Never send silence to Whisper (the VAD does this; 0 insertions measured); drop final words that fall inside VAD silence. |
| Memory growth over a long session | `performance.measureUserAgentSpecificMemory()` trend, where available | Recreate the engine at a segment boundary; the model stays cached, reload is ~1 s. |

## Licences

| Component | Version | Licence |
|---|---|---|
| transformers.js (`@huggingface/transformers`) | 4.3.1 | Apache-2.0 |
| ONNX Runtime Web (`onnxruntime-web`) | 1.31.0-dev.20260914 | MIT |
| `@huggingface/tokenizers` / `@huggingface/jinja` (transformers.js deps) | 0.2.0 / 0.5.10 | Apache-2.0 / MIT |
| Whisper weights (OpenAI) | base.en, tiny.en | MIT (openai/whisper repository); the `openai/whisper-*.en` Hugging Face cards say Apache-2.0 |
| ONNX conversions `onnx-community/whisper-{tiny,base}.en_timestamped` | 2025-03-05 | **No licence tag on the model card.** Derived from the OpenAI weights; confirm or convert ourselves before shipping. |
| whisper.cpp / ggml model files (`ggerganov/whisper.cpp`) | q5_1 | MIT |
| `@transcribe/shout`, `@transcribe/transcriber` | 1.0.7, 3.0.1 | MIT |
| `vosk-browser` | 0.0.8 | Apache-2.0 (Kaldi: Apache-2.0) |
| Vosk model `vosk-model-small-en-us-0.15` | 0.15 | Apache-2.0 (alphacephei.com/vosk/models) |
| LibriSpeech test-clean (fixtures only, not shipped) | | CC BY 4.0 |
| `gilkeyio/librispeech-alignments` (fixtures only) | | CC BY 4.0 |

All are compatible with a closed-source or any-licence extension, with attribution and licence
text in the package. NarWal's own licence is deferred (map decision); nothing here forces it.

## Risks and unknowns

- **`vosk-browser` is unmaintained** (last published 2022-12-25). It works in Chrome 155. It
  creates its worker from a `blob:` URL; MV3 extension pages may refuse `blob:` workers under
  the default CSP. Mitigation: rebuild it from source (Apache-2.0) with the worker as a packaged
  file. Not tested in an extension.
- **MV3 packaging is untested.** Needed: `'wasm-unsafe-eval'` in `content_security_policy`
  (allowed in MV3), cross-origin isolation for the offscreen document
  (`cross_origin_embedder_policy` / `cross_origin_opener_policy` manifest keys) so ORT can use
  threads, and the runtime files in the package. Without isolation ORT runs single-threaded,
  which on 2 cores roughly halves Whisper's speed (not measured).
- **Only one machine class measured.** Faster laptops will make Whisper base.en live more
  plausible; a WebGPU path (transformers.js `device: 'webgpu'`) is unmeasured.
- **Read speech fixtures.** Real narration has disfluencies and noise; WER will be higher for
  every engine, and Vosk small more so.
- **Final pass time scales with machine speed.** On a 2-vCPU machine a 30-minute narration
  took 10.0 minutes to finalize (base.en) or 7.0 minutes (tiny.en).

## Not measured, and why

- **WebGPU**: no adapter on the measured machine.
- **sherpa-onnx WASM**: the English streaming demo space is gone; the remaining
  `sherpa-ncnn` English build is a 141 MB data file and its prebuilt JS exposes no word times.
- **Moonshine** (transformers.js): no word timestamps in transformers.js for it.
- **Whisper small.en**: about 4× base.en's compute; base.en already uses 1.6 of 2 cores live.
- **Microphone capture** (`getUserMedia` → AudioWorklet → resample): slice A/G.

## Smallest follow-up

No scope change is needed: the design's live-then-final split is feasible on the floor
machine. Two checks remain before the extension slice commits to this pair:

1. **Run the same harness on one real laptop** (any recent Mac or Windows machine with a GPU),
   adding a `webgpu` configuration. This tells us how much CPU Whisper base.en live leaves on
   typical hardware, which decides whether it can replace Vosk and its maintenance risk.
2. **Load both runtimes in an MV3 offscreen document** with the microphone path (slice A/G):
   proves the CSP, the `blob:` worker and cross-origin isolation in the real container.

## Reproduce

```sh
cd research/browser-transcription
npm install                         # local node_modules, not a symlink
uv run fixtures/build_fixtures.py <librispeech-alignments test_clean.parquet> <fixtures-dir>
NARWAL_FIXTURES=<fixtures-dir> node run-browserbase.mjs sweep-vosk-small   # one Browserbase session
NARWAL_FIXTURES=<fixtures-dir> node score.mjs results/raw/sweep-vosk-small.json
```

Configurations are in `configs.mjs` (`sweep-*` 2 min, `long-*` 30 min live, `batch-*` 30 min
finalize-after-stop). The Browserbase key is read by the helper named in `BB_BROWSER`, not
by this repository; nothing here prints it. Raw event logs (`results/raw/`) are not committed; the scored
summaries (`results/*.summary.json`) are.
