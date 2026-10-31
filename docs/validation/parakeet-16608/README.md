# Parakeet TDT in the extension (board #16608)

**Not published.** The reading passage, its audio and every model output on it
(`hyp/`, the `out/*passage*.json` files) were removed before the repository was made
public: the passage named a customer. The numbers here are the record; the commands need
your own passage (see `../wer-16603/README.md`).

Speed, memory and word error rate (WER) of the final pass after Stop, run inside the demo
extension's offscreen document, the same code path the narwal extension uses. The #16603 table
(`../wer-16603/`) ran each model natively over the whole file; this one runs the browser
build over the pass's speech spans (20 s or less each).

Measured 2026-10-14 on a Linux desktop (i7-12700, 20 logical CPUs), Chromium from Playwright 1.63.0,
headless. Code: NarWal#39 at the commit that adds this directory.

## Matt's 113 s reading passage (N = 234 reference tokens)

| Model | Runtime in the extension | CPUs the browser had | WER | Wall time | × audio | WebAssembly heap | Browser RSS before → peak |
|---|---|---|---|---|---|---|---|
| Parakeet TDT 0.6B v2 int8 | sherpa-onnx v1.13.8 WebAssembly, 1 thread | all 20 | **9.0%** (S 11, D 1, I 9) | 29.2 s (load 2.1 s) | 0.26 | 0.98 GB | 3.17 → 4.49 GB (+1.32 GB) |
| Parakeet TDT 0.6B v2 int8 | same | one (`taskset -c 5`) | **9.0%** (S 11, D 1, I 9) | 31.8 s (load 3.0 s) | 0.28 | 0.98 GB | 3.19 → 4.51 GB (+1.32 GB) |
| Whisper small.en q8 | transformers.js 4.3.1, ONNX Runtime WebAssembly, 4 threads | all 20 | **14.1%** (S 19, D 3, I 11) | 46.1 s (load 2.8 s) | 0.41 | - | 1.49 → 2.68 GB (+1.19 GB) |

**Speed and the time limit.** On that machine Parakeet takes 0.26-0.27 × the audio length; the
controller's rerun on the same machine under load (NarWal#39 review) took about 0.42 ×. The chain stops a
model whose projected finish passes 10 min + audio length ÷ 4 (`final-chain.ts`), so the
longest recording that fits is about (600 s − load) ÷ (speed − 0.25). Near 0.25 × that figure
swings widely with small speed changes: about 8 h of audio at 0.27 ×, 5.5 h at 0.28 ×, but
about **1 h at 0.42 ×**. Plan on about an hour on a busy computer. A longer recording there
moves to the next model once the projection is reliable (after 20 s); the last model in the
chain always finishes. small.en at 0.41 × fits about 1 h too.

WER uses the #16603 scorer and normalisation (`../wer-16603/score.mjs`, numbers spoken as words
count as digits). The `wer` field inside `out/*.json` is the e2e script's simpler normaliser
(lowercase, punctuation removed, N = 273): 11.0% for Parakeet, 24.5% for small.en.

The same passage scored natively over the whole file (#16603): Parakeet 5.1%, small.en 9.8%.
In the extension both lose accuracy to the span cuts, and the order stays the same: Parakeet
makes 21 errors where small.en makes 33. Parakeet's extra errors against its native run are
at span edges ("That It's the end" where a span starts inside "That's", "Mm-hmm" from a
210 ms span at 0 s) and in names ("path" for "pass").

Memory: the heap is what the sherpa-onnx worker reports (`HEAPU8.byteLength`). RSS is every
process below the measuring script, sampled every 250 ms; the "before" figure is after the
model install, before the pass. The one-core run measures a one-thread page: Parakeet's build
has no WebAssembly threads, so the only change is the CPUs the browser's other processes get.

## The 31.5 s e2e fixture (word times)

| Model | Words | Start bias (median) | Start error median / p90 | × audio |
|---|---|---|---|---|
| Parakeet, `timing.correctionMs` -30 | 69 of 69, WER 0 | +3 ms | 28 ms / 83 ms | 0.30 |
| Parakeet, no correction (earlier run, same code otherwise) | 69 of 69, WER 0 | +33 ms | 36 ms / 103 ms | 0.29 |

Parakeet's word starts are the TDT decoder's token frames (80 ms). They ran 33 ms late on the
fixture, and about 45 ms late on the passage (30 ms behind Vosk, which runs 15 ms behind
forced alignment, #16539). The pass moves them 30 ms earlier (`SHERPA_TIMING` in
`packages/offline-transcription/src/engines/whisper-client.ts`), less than either figure.

## Not measured here

Parakeet as the live engine (text while recording). This ticket adds it as a final model only.

## Files

| File | What it is |
|---|---|
| `out/parakeet-passage-all-cores.json`, `out/parakeet-passage-one-core.json`, `out/small.en-passage-all-cores.json`, `out/parakeet-fixture-31s.json` | `e2e/measure-final.mjs` output: timings, memory, stats, timing method and the full revision with word times. |
| `hyp/*.txt` | The revision text of each passage run, as scored. |

## Run it again

The passage audio is not committed: board #16603 attachment 25570, `passage-v1-narration.webm`,
sha256 `60f7761fb67d19dd8924a789b64d4009a4c96136336b53405d72e35923b1333a`.

```sh
cd packages/offline-transcription
npm ci && node build.mjs
# Optional: NARWAL_MODEL_MIRROR=<dir> serves <dir>/<modelId>/<path> instead of Hugging Face
# (the store still checks every size and SHA-256).
NARWAL_MEASURE_AUDIO=<passage-v1-narration.webm> \
NARWAL_MEASURE_REFERENCE=../../docs/validation/wer-16603/reading-passage-v1.txt \
  node e2e/measure-final.mjs                                   # Parakeet, all CPUs
# taskset -c 5 node e2e/measure-final.mjs                      # one CPU
# NARWAL_MEASURE_MODEL=whisper-small.en-q8 node e2e/measure-final.mjs
node e2e/measure-final.mjs                                     # the fixture, with word times
```

Each run writes `.e2e-measure/measure.json`. Score its text with the #16603 scorer:

```sh
cd docs/validation/wer-16603
node score.mjs reading-passage-v1.txt ../parakeet-16608/hyp/*.txt
```

Expected:

```
  9.0%  N=234 S=11 D=1 I=9  ../parakeet-16608/hyp/parakeet-passage-all-cores.txt
  9.0%  N=234 S=11 D=1 I=9  ../parakeet-16608/hyp/parakeet-passage-one-core.txt
 14.1%  N=234 S=19 D=3 I=11  ../parakeet-16608/hyp/small.en-passage-all-cores.txt
```
