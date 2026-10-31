# Parakeet as the live engine (board #16617)

**Not published.** The reading passage, its audio and every model output on it
(`hyp/`, the `out/*passage*.json` files) were removed before the repository was made
public: the passage named a customer. The numbers here are the record; the commands need
your own passage (see `../wer-16603/README.md`).

Live text while recording, run inside the demo extension's offscreen document, the same
code path the narwal extension uses. The recording is fed to a live session at real speed
in 100 ms chunks, as the capture path does (`e2e/measure-live.mjs`). Parakeet transcribes
each speech span when it closes; Vosk streams.

Measured 2026-10-14 on a Linux desktop (i7-12700, 20 logical CPUs), Chromium from Playwright 1.63.0,
headless. Code: the NarWal pull request that adds this directory.

## Matt's 113 s reading passage (N = 234 reference tokens)

| Live engine | Span limit | CPUs the browser had | WER | Word on screen after it was spoken, p50 / p90 / max | Browser CPU, mean / p90 / max (cores) | Most behind | WebAssembly heap | Browser RSS before → peak |
|---|---|---|---|---|---|---|---|---|
| Parakeet | 8 s | all 20 | **12.0%** (S 15, D 1, I 12) | 5.9 / 8.6 / 9.7 s | 0.28 / 1.01 / 1.32 | 2.0 s | 0.86 GB | 2.51 → 3.83 GB |
| **Parakeet (shipped)** | **6 s** | all 20 | **12.0%** (S 16, D 2, I 10) | **4.7 / 6.8 / 8.0 s** | 0.33 / 1.00 / 1.55 | 2.2 s | 0.86 GB | 2.51 → 3.31 GB |
| Parakeet | 6 s | one (`taskset -c 5`) | **12.0%** (S 16, D 2, I 10) | 5.0 / 7.1 / 8.2 s | 0.37 / 0.99 / 1.01 | 2.6 s | 0.86 GB | 2.52 → 3.55 GB |
| Parakeet | 5 s | all 20 | 13.2% (S 13, D 5, I 13) | 3.7 / 5.5 / 6.5 s | 0.29 / 0.89 / 1.58 | 1.8 s | 0.86 GB | 2.50 → 3.37 GB |
| Parakeet | 4 s | all 20 | 19.7% (S 24, D 7, I 15) | 3.0 / 4.3 / 4.9 s | 0.29 / 0.69 / 1.62 | 1.1 s | 0.86 GB | 2.51 → 3.32 GB |
| Vosk (fallback) | - | all 20 | 45.3% (S 72, D 5, I 29) | provisional words at once, see the fixture | 0.28 / 0.37 / 1.53 | 0.5 s | - | 1.30 → 1.55 GB |

Every run: no error, no skipped audio, no restart, every captured sample reached the
session, no chunk delivered late, no console error.

**The span limit.** A span closes at a pause (0.6 s) or at the limit, whichever comes first.
Matt reads with few pauses, so most spans run to the limit, and a word waits for the end of
its span plus the decode (about a quarter of the span). 6 s keeps the accuracy of 8 s with
each word on screen about a second sooner. Below 6 s the cuts land inside words: 5 s costs
1.2 points, 4 s nearly 8 ("Yeah." and split words at the cuts). `LIVE_VAD` in
`packages/offline-transcription/src/engines/parakeet-live.ts`.

**Accuracy.** Live Parakeet makes 28 errors on the passage, live Vosk 106. The same model
over the final pass's bare spans (up to 20 s) made 21 (9.0%, `../parakeet-16608/`); with 2 s
of context at the cuts, the final pass now makes 13 (5.6%, `../accuracy-16621/`). The extra
live errors are at span cuts ("the Yeah." for "the same words"). The final pass after Stop
still replaces the live text.

WER uses the #16603 scorer and normalisation (`../wer-16603/score.mjs`). The `wer` field
inside `out/*.json` is the measuring script's simpler normaliser (lowercase, punctuation
removed, numbers not converted), so "$123,456.78" against the spelled-out reference counts
as errors there: 16.9% for the shipped Parakeet, 39.9% for Vosk.

**Delay.** "Word on screen" is, for every word of the live text, the moment its final
appeared minus the end of that word, both on the audio clock. The word ends are the live
engine's own word times. On the fixture below, the same figure against the forced
alignment differs by 0.1 s or less, so the live word times are a fair clock.

**CPU.** Every process of the browser, from /proc, sampled each second while recording
(install excluded). Parakeet's build has one WebAssembly thread: while a span decodes the
browser uses about one core, between spans almost none. With the whole browser on one core
the delay grew 0.3 s at p50 and the session stayed at most 2.6 s behind. The capture path
never waited: `sendAudio` copies the chunk and returns (longest call 42 ms; Vosk 65 ms).

**Memory.** The live Parakeet worker holds a 0.86 GB WebAssembly heap while the recording
runs, in the offscreen page that also holds the recorder. The browser's resident memory rose
0.8 to 1.3 GB over the post-install level; Vosk rose 0.25 GB. The
worker is stopped when the session finishes, so at Stop the final pass's own Parakeet
(about 1 GB, #16608) loads after the live one is gone. A new recording started while an
earlier recording's final pass still runs holds both: about 2 GB of heap.

## The 31.5 s e2e fixture (word times)

| Live engine | Span limit | WER (e2e normaliser) | Word on screen after the word (forced alignment), p50 / p90 | Each final after its last word, p50 / p90 | Word start error p90 |
|---|---|---|---|---|---|
| Parakeet | 8 s | 5.8% | 3.8 / 8.4 s | 1.3 / 2.3 s | 73 ms |
| **Parakeet (shipped)** | **6 s** | **0%** | **3.6 / 6.6 s** | 1.5 / 1.7 s | 112 ms |
| Parakeet | 5 s | 1.4% | 3.8 / 6.1 s | 1.5 / 2.3 s | 110 ms |
| Parakeet | 4 s | 8.7% | 3.3 / 5.1 s | 2.1 / 2.4 s | 120 ms |
| Vosk | - | 13.0% | 0.36 / 0.52 s (provisional text) | 0.9 / 1.1 s | 36 ms |

Vosk shows provisional words within half a second and corrects them; Parakeet shows each
word once, final, a few seconds later. Its live revision says `{ quality: "approximate",
method: "tdt-token-times", correctionMs: -30 }`, as the final pass does.

Engine start (session open to first audio accepted, model load included): Parakeet 2.9-4.7 s
(model load 2.1-3.8 s), 6.2 s on one CPU (load 4.8 s); Vosk 1.7 s.

## Files

| File | What it is |
|---|---|
| `out/parakeet-cap{8,6,5,4}s-{passage,fixture}.json`, `out/parakeet-cap6s-passage-one-core.json`, `out/vosk-{passage,fixture}.json` | `e2e/measure-live.mjs` output: delays, CPU and memory samples, session stats, every final with its word ends, and the live revision. |
| `hyp/*.txt` | The live text of each passage run, as scored. |

The 6 s runs are of the shipped code; the 8, 5 and 4 s runs differ only in `LIVE_VAD.maxSegS`.

## Run it again

The passage audio is not committed: board #16603 attachment 25570, `passage-v1-narration.webm`,
sha256 `60f7761fb67d19dd8924a789b64d4009a4c96136336b53405d72e35923b1333a`.

```sh
cd packages/offline-transcription
npm ci && node build.mjs
# Optional: NARWAL_MODEL_MIRROR=<dir> serves <dir>/<modelId>/<path> instead of the model hosts
# (the store still checks every size and SHA-256).
NARWAL_MEASURE_AUDIO=<passage-v1-narration.webm> \
NARWAL_MEASURE_REFERENCE=../../docs/validation/wer-16603/reading-passage-v1.txt \
  node e2e/measure-live.mjs                          # Parakeet, all CPUs
# taskset -c 5 node e2e/measure-live.mjs             # one CPU
# NARWAL_MEASURE_LIVE=vosk node e2e/measure-live.mjs # Vosk
# Without NARWAL_MEASURE_AUDIO: the 31.5 s fixture, scored against its word times.
node ../../docs/validation/wer-16603/score.mjs ../../docs/validation/wer-16603/reading-passage-v1.txt <hyp.txt>
```
