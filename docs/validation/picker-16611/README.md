# The numbers behind the model picker (board #16611)

**Not published.** The reading passage, its audio and every model output on it
(`hyp/`, the `out/*passage*.json` files) were removed before the repository was made
public: the passage named a customer. The numbers here are the record; the commands need
your own passage (see `../wer-16603/README.md`).

The picker's accuracy bar is the word error rate (WER) on Matt's 113 s reading passage, measured
inside the extension where that was possible. Its speed bar is the time the pass takes as a
multiple of the audio length (× audio). Both come from the `measured` block of each model in
`packages/offline-transcription/src/models.ts`. This directory adds the two in-extension runs
that no earlier ticket made: Moonshine base and Whisper base.en.

Measured 2026-10-14 on a Linux desktop (i7-12700, 20 logical CPUs), Chromium from Playwright 1.63.0,
headless, with `e2e/measure-final.mjs` (the same offscreen code path as the narwal extension).

## Every model in the picker (passage, N = 234 reference tokens)

| Model | Needs | WER in the extension | WER native, whole file (#16603) | × audio in the picker | Source |
|---|---|---|---|---|---|
| Whisper large-v3-turbo q4f16 | WebGPU | not measured: no WebGPU on the test machine; the picker shows the native 6.0% and says so | 6.0% | 1.06 (native CPU, 4 threads) | `../wer-16603` |
| Parakeet TDT 0.6B v2 int8 | WebAssembly | **9.0%** (S 11, D 1, I 9) | 5.1% | 0.28 (1 thread) | `../parakeet-16608` |
| Moonshine base q8 | WebAssembly | **11.1%** (S 16, D 2, I 8) | 9.4% | 0.06 (4 threads) | this directory, #16609 |
| Whisper small.en q8 | WebAssembly | **14.1%** (S 19, D 3, I 11) | 9.8% | 0.35 (4 threads) | `../parakeet-16608`, #16609 |
| Whisper base.en q8 (retired) | WebAssembly | **24.4%** (S 27, D 22, I 8) | 28.6% | 0.14 (4 threads) | this directory, #16609 |
| Vosk small (live text) | WebAssembly | 45.3% (live) | - | live | `../wer-16603` |

WER uses the #16603 scorer and normalisation (`../wer-16603/score.mjs`). The `wer` field
inside `out/*.json` is the e2e script's simpler normaliser (lowercase, punctuation removed,
N = 273): 24.9% for Moonshine, 33.3% for base.en. PR #38's 24.3% for Moonshine in the
browser was that simpler normaliser too; on the #16603 scorer the same kind of run is 11.1%.

The × audio column keeps the bench figures from #16609 (`e2e/bench-final.mjs`, quiet machine).
These runs, on a loaded machine, took 0.092 × (Moonshine, 10.4 s) and 0.176 × (base.en,
20.0 s). Both are inside the job's time limit by a wide margin.

Memory, as the browser's RSS rise during the pass (sampled every 250 ms over every process
below the script): Moonshine 1.31 → 1.99 GB (+677 MB), base.en 1.34 → 1.91 GB (+565 MB).

## How the bars are drawn

`packages/offline-transcription/src/picker.ts`, from the numbers above only:

| Steps | Accuracy: WER at or under | Speed: × audio at or under |
|---|---|---|
| 5 | 6% | 0.1 |
| 4 | 10% | 0.2 |
| 3 | 20% | 0.4 |
| 2 | 35% | 0.8 |
| 1 | above | above |

The live model keeps up with speech: speed 5.

## Files

| File | What it is |
|---|---|
| `out/moonshine-base-q8-passage.json`, `out/whisper-base.en-q8-passage.json` | `e2e/measure-final.mjs` output: timings, memory, the full revision with word times. |
| `hyp/*.txt` | The revision text of each run, as scored. |

## Run it again

The passage audio is not committed: board #16603 attachment 25570, `passage-v1-narration.webm`,
sha256 `60f7761fb67d19dd8924a789b64d4009a4c96136336b53405d72e35923b1333a`.

```sh
cd packages/offline-transcription
npm ci && node build.mjs
for model in moonshine-base-q8 whisper-base.en-q8; do
  NARWAL_MEASURE_MODEL=$model NARWAL_E2E_DIR=.e2e-measure-$model \
  NARWAL_MEASURE_AUDIO=<passage-v1-narration.webm> \
  NARWAL_MEASURE_REFERENCE=../../docs/validation/wer-16603/reading-passage-v1.txt \
    node e2e/measure-final.mjs
done
cd ../..
node docs/validation/wer-16603/score.mjs docs/validation/wer-16603/reading-passage-v1.txt \
  docs/validation/picker-16611/hyp/*.txt
```
