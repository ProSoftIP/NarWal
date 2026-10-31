# Closing the browser-vs-native accuracy gap (board #16621)

**Not published.** The reading passage, its audio and every model output on it
(`hyp/`, the `out/*passage*.json` files) were removed before the repository was made
public: the passage named a customer. The numbers here are the record; the commands need
your own passage (see `../wer-16603/README.md`).

Matt saw Parakeet at 9.0% WER in the model picker against 5.1% natively. Every WebAssembly
model was worse inside the extension than natively on the same 113 s passage. This directory
splits each gap into chunking (the final pass's 20 s VAD spans) and runtime (WebAssembly,
browser decoding), closes what could be closed, and records turbo's first WebGPU number.

Scorer: `../wer-16603/score.mjs` (numbers as digits, N = 234 reference tokens).
Machine: a Linux desktop (i7-12700, 20 logical CPUs), Chromium from Playwright 1.63.0, headless,
`e2e/measure-final.mjs` (the offscreen code path of the extension). Turbo: Matt's Mac M5,
Edge, build e636478, WebGPU.

## Before and after, in the extension (passage)

| Model | Before | After | Native, whole file | Speed after (× audio) |
|---|---|---|---|---|
| Parakeet TDT 0.6B v2 int8 | 9.0% | **5.6%** (S 8, D 1, I 4) | 5.1% | 0.32 (1 thread, one core; was 0.28) |
| Whisper small.en q8 | 14.1% | **9.0%** (S 13, D 4, I 4) | 9.8% | 0.55 (4 threads; quiet machine, see below) |
| Whisper base.en q8 (retired) | 24.4% | **20.1%** (S 20, D 22, I 5) | 28.6% | 0.16 (4 threads) |
| Moonshine base q8 | 11.1% | 11.1% (unchanged: no word times, no context) | 9.4% | 0.06 (unchanged) |
| Whisper large-v3-turbo q4f16 | native 6.0% shown | **9.4%** (S 14, D 3, I 5): a different take, see below | 6.0% | 0.15 (Stop to finished text, model load included) |

Each WER run repeats to the word.

**Turbo does not compare with the rows above.** Its numbers are not from the 113 s recording
the others ran on. They come from Matt's separate 120 s take of the same passage
(rec_49bbce68, board attachment 25614), on his Mac with WebGPU, on build e636478, which is
before this change: no span context and no joined word pieces. Its speed counts from Stop to
the finished text and includes loading the model; the other speeds are the pass alone. The
picker marks turbo "measured on a different take" and its Measured detail names the take.
Turbo was not run again after the fix (no WebGPU on the test machine); a re-recording needs a Mac.
4 of its 22 errors are amounts split into pieces ("$12 ,345", "$6 ,789"), the bug fixed
below; joining them in the same output gives 7.7% (`hyp/…-pieces-joined.txt`).
The earlier 7.2% on the ticket used its own normaliser (digit groups joined, dollar and
cents words dropped, N = 235); with the #16603 scorer the same output is 9.4%.

**small.en speed.** Three runs on a quiet machine, 2026-10-14 13:46-13:51Z: 0.553, 0.552 and
0.526 × audio (median 0.55; `out/whisper-small.en-q8-passage-idle-q2..q4.json`). Each run
started only when the whole machine was at most 15% busy over the 10 s before it (measured:
9%, 13%, 15%, `/proc/stat`), and counts only when the machine was at most 35% busy over the
run (measured: 33%, 33%, 26%; the run's own 4 threads are about 20% of the 20 CPUs). The machine
ran other jobs, so it was never fully idle: before each run the rest of the
machine used about 2-3 CPUs. A run at 38% busy gave 0.604 and was not kept. The first
measurement, 0.52 (`out/whisper-small.en-q8-passage-loaded.json`), ran on a loaded machine.
WER was 9.0% in every run, the same words each time.

**Parakeet's time limit.** The final pass must finish inside 10 min + audio/4
(`final-chain.ts`). At 0.32 × on one core the longest recording that fits is about
(600 s − load) ÷ (0.32 − 0.25): about 147 min (`longestAudioWithinDeadlineMin` in
`out/parakeet-tdt-0.6b-v2-int8-passage-one-core.json`; it was several hours at 0.28 ×). A
longer recording moves to the next model in the chain.

## Where each gap came from

Each model run natively on the extension's own VAD spans, cut from the PCM Chromium decodes
(`scripts/browser-pcm.mjs`, `scripts/spans.mjs`):

| Model | Native, whole file | Native, same spans | Extension, before | Gap was |
|---|---|---|---|---|
| Parakeet (sherpa-onnx WebAssembly in node) | 5.1% (browser PCM too) | 9.0% (8.1% on ffmpeg PCM) | 9.0% | all chunking; runtime 0 |
| small.en (onnxruntime-node) | 9.8% | 9.4% | 14.1% | word pieces joined with spaces |
| base.en (onnxruntime-node) | 28.6% | 20.9% | 24.4% | word pieces joined with spaces |
| Moonshine (onnxruntime-node) | 9.4% (fixed 20 s cuts) | 12.0% | 11.1% | none: the extension beats the same spans natively |

Parakeet's errors sat at span edges: "Mm-hmm" from a 0.26 s click span at 0 s, "H2" →
"who/h", "v3" → "v 3", "That's" → "That It's". Whisper's 30 s chunking is no better than the
spans (small.en 9.4% on spans against 9.8% whole). Whisper's extra errors in the extension
came from `whisper-worker.ts`: each word piece became a word, so "$123,456.78" was written
"$123 ,456 .78".

## What changed

1. `src/engines/whisper-words.ts`: a piece without a leading space continues the word before
   it. Used by `whisper-worker.ts` for every Whisper model (base.en, small.en, turbo).
2. `src/span-context.ts`, used by `final-pass.ts` for engines with word times (Parakeet,
   Whisper): a span that shares a cut with the span before or after it (a long run cut at
   20 s) is decoded with 2 s of audio on that side, and a span under 1 s with 2 s on both
   sides. Words are kept by start time inside the span. At a cut a word both decodes heard is
   kept once, and a word the span before missed is taken from the 0.5 s before the cut. The
   last kept word of each span is saved in the checkpoint, so a resumed run makes the same
   choice. A widened 20 s span is at most 24 s, inside Whisper's 30 s window. Moonshine
   (text only) keeps bare spans.

Cost: 16% more audio decoded on the passage (111.4 s → 129.4 s), 25% on a short narration.

## Policies tried (Parakeet unless named, `scripts/ctx-exp.mjs`, node, browser PCM)

Totals over the passage and Matt's Mac recording of it (N = 468): bare spans 40 errors,
whole file 28.

| Policy | Passage | Mac recording |
|---|---|---|
| Bare spans | 9.0% | 8.1% |
| Whole file | 5.1% | 6.8% |
| 2 s context on every span, dedupe at cuts | 5.6% | 7.7% |
| 2 s at cuts only, dedupe | 6.4% | 7.7% |
| **2 s at cuts and around spans under 1 s, dedupe (shipped)** | **5.6%** | **7.7%** |
| 30 s spans with 2 s context | worse: Parakeet dropped a sentence (19 deletions) | |
| 0.5 s right context | 8.1%: words cut mid-way | |
| small.en, shipped policy (pieces joined) | 9.0% (bare 9.4%) | 9.4% (bare 10.3%) |

On a 50 s narration (N = 81, a faster-whisper reference) the shipped policy changed
nothing: Parakeet 3.7%, small.en 8.6%.

## Files

| File | What it is |
|---|---|
| `out/*.json` | `e2e/measure-final.mjs` output after the change: timings, memory, the full revision. |
| `hyp/*-passage*.txt` | The revision text of each in-extension run, as scored. |
| `hyp/whisper-large-v3-turbo-matt-mac-webgpu-r2.txt` | Revision r2 of Matt's export rec_49bbce68 (board attachment 25614). |
| `hyp/split/*.txt` | The split runs: native whole file and same spans; `mac-*` on Matt's recording. |
| `scripts/` | The split and policy scripts. Env: `SHERPA_NPM`, `PARAKEET_DIR`, `TRANSFORMERS_NODE`, `TRANSFORMERS_CACHE` (the #16608 and #16603 setups). |

## Run it again

Passage audio: board #16603 attachment 25570, sha256
`60f7761fb67d19dd8924a789b64d4009a4c96136336b53405d72e35923b1333a`.

```sh
cd packages/offline-transcription
node build.mjs
NARWAL_MEASURE_MODEL=parakeet-tdt-0.6b-v2-int8 NARWAL_MEASURE_AUDIO=<passage.webm> \
  NARWAL_MEASURE_REFERENCE=../../docs/validation/wer-16603/reading-passage-v1.txt \
  NARWAL_MODEL_MIRROR=<mirror> taskset -c 5 node e2e/measure-final.mjs
# the same with whisper-small.en-q8, whisper-base.en-q8, moonshine-base-q8, without taskset
node ../../docs/validation/wer-16603/score.mjs ../../docs/validation/wer-16603/reading-passage-v1.txt <hyp.txt>
```
