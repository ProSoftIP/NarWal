# WER harness for board #16603

Word error rate (WER) of local speech models on one read passage. This directory holds the
harness and the result, so each row can be run again from pinned weights on your own passage.

**Not published.** The passage text, its audio, the narration set and every model output
(`reading-passage-v1.txt`, `inputs/`, `out/<set>/*.json`, `out/<set>/hyp/`,
`out/<set>/reference.txt`, `result.json`, `RESULT.md`) were removed before the repository was
made public: the passage named a customer. The numbers below are the record; the scripts are
unchanged and need your own passage and audio.

Measured 2026-10-14 on a Linux desktop (i7-12700, CPU only).

## Headline (reading passage, N = 234 reference tokens)

| Model | Weights | Runtime | WER | WER plain |
|---|---|---|---|---|
| Parakeet TDT 0.6B v2 | int8 (sherpa-onnx release) | sherpa-onnx 1.13.8 | **5.1%** | 20.9% |
| whisper-large-v3-turbo | q4f16 | transformers.js 4.3.1 / onnxruntime-node 1.30.0 | **6.0%** | 21.6% |
| whisper-small.en | q8 | transformers.js 4.3.1 / onnxruntime-node 1.30.0 | **9.8%** | 23.4% |
| whisper-base.en | q8 | transformers.js 4.3.1 / onnxruntime-node 1.30.0 | **28.6%** | 39.6% |
| Vosk small en-us 0.15 (live, in the extension) | vosk-model-small-en-us-0.15 | browser vosk, not re-run | **45.3%** | 40.7% |

"WER plain" uses lowercase and punctuation removal only (no number rule). It is the figure to
compare with the 40.7% measured earlier for Vosk.

## Inputs (not committed)

| Input | Where | sha256 |
|---|---|---|
| Passage audio `passage-v1-narration.webm` (1,822,943 bytes, 113.3 s) | board #16603 attachment 25570; the same bytes are `audio/narration.webm` inside the bundle `passage-v1-rec_744021f6.narwal.zip` (attachment 25569) | `60f7761fb67d19dd8924a789b64d4009a4c96136336b53405d72e35923b1333a` |
| Narration audio (set 2), `audio/narration.webm` of a 45.6 s narrated recording (726,143 bytes, 45.6 s) | board #16603 attachment 25559 | `445acdd63e245642fbcfd42229882e1e2b38c0e8753289b79cc43f041e286afc` |
| Parakeet TDT weights `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` (482,468,385 bytes) | https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2 | `157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad` |

The reference text was `reading-passage-v1.txt` (board #16603 attachment 25568,
sha256 `66a066efed8d7cdc7165f47b979fc674cc25c8b941a5601aa44560cbf0f45ae2`), used exactly
as written, with no hand edits. It is not published (see above).

The narration set has no human reference. Its reference is the faster-whisper large-v3 output
(`out/narration/reference.txt`); medium.en is a sensitivity check.

## Files

| File | What it does |
|---|---|
| `score.mjs` | The scorer. No dependencies. `node score.mjs <reference.txt> <hyp.txt>... [--align] [--json]`. |
| `build.mjs` | Reads `out/<set>/{js,py,fw}-*.json` and `.time`/`.loadavg`, scores every run, writes `out/<set>/hyp/*.txt`, `out/<set>/reference.txt` and `result.json`. |
| `make-extras.mjs` | Writes `extras.json` (notes, model sizes, not-run rows) for `render.mjs`. |
| `render.mjs` | Writes `RESULT.md` from `result.json` and `extras.json`. |
| `result.json` (not published) | Every scored run: model, revision, dtype, runtime, threads, timings, peak RSS, WER, S/D/I and the error list. |
| `extras.json`, `RESULT.md` (not published) | Rendered notes and the full report. |
| `reading-passage-v1.txt` (not published) | Passage reference text. |
| `inputs/vosk-*-r1.json` (not published) | The live Vosk transcripts (`transcript/r1.json` of each bundle), trimmed to segment text. |
| `to16k.sh` | Any audio to 16 kHz mono PCM16 WAV with ffmpeg. |
| `js/go.sh`, `js/run.mjs` | One transformers.js model run under `/usr/bin/time -v`. |
| `js/ctc.sh`, `js/ctc.mjs` | Parakeet CTC with its own greedy decode (word times). No stored output: that batch did not run. |
| `js/package.json`, `js/package-lock.json` | Pins `@huggingface/transformers` 4.3.1 (onnxruntime-node 1.30.0 in the lock). |
| `sherpa.sh`, `sherpa.py` | Parakeet TDT int8 with sherpa-onnx (greedy). |
| `fw.sh`, `fw.py` | faster-whisper reference runs (CPU int8, beam 5, no VAD). |
| `prefetch.sh` | Downloads the big ONNX files into the transformers.js cache layout. |
| `batch-passage.sh`, `batch-passage-2.sh`, `batch-3.sh`, `batch-4.sh` | The batches that were run (each model under `suite-gate`, one at a time). |
| `out/<set>/*.json` (not published) | Raw run outputs (text, words, timings). `.time` = `/usr/bin/time -v`; `.loadavg` = `/proc/loadavg` at the start. |
| `out/<set>/hyp/*.txt` (not published) | Hypothesis text per run, as scored. Two files are left over from an older build and have no run in `out/passage/`: `js-cohere-q4f16-t4.txt` and `js-moonshine-base-q8-t4.txt` (both superseded). |
| `out/passage/superseded/` (not published) | Runs replaced by a fixed configuration (Moonshine without segmenting, Cohere without `max_new_tokens`); read by `make-extras.mjs`. |
| `out/passage/after-result/` (not published) | 1-thread runs that finished after `result.json` was built (the batch was stopped during `turbo-q4f16-t1`). They are not in the table. `js-parakeet-ctc-q8-t1.json` has empty text. |
| `out/batch-4.log`, `out/prefetch.log`, `out/onnx-sizes.txt` | The batch logs that hold no transcript, and ONNX file sizes. |

Paths: every script finds its files relative to its own directory. Env overrides:
`WER_OUT_DIR` (default `out`), `WER_RESULT_DIR` (where `result.json`, `extras.json`,
`RESULT.md` are read and written; default this directory), `WER_REFERENCE`,
`WER_VOSK_PASSAGE`, `WER_VOSK_NARRATION`, `WER_WAV_DIR` (default `wav`), `WER_MODELS_DIR`
(default `models-js`), `WER_VENV` (default `venv`), `SHERPA_MODEL_DIR` (default
`models-sherpa/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`), `PASSAGE_AUDIO`,
`NARRATION_AUDIO`. Do not commit `wav/`, `models-js/`, `models-sherpa/`, `venv/` or
`js/node_modules/`.

## Scorer normalisation

Applied the same way to the reference and the hypothesis:

1. Lowercase. Curly apostrophes become `'`.
2. Commas between digits are removed (`123,456` to `123456`). A `.` between two digits stays. `$` is removed.
3. Every character not in `[a-z0-9'.]` becomes a space. A `.` that is not between digits becomes a space.
4. Spelled numbers become digits (zero to nineteen, tens, hundred, thousand, million, billion). `and` after hundred/thousand before a number word is part of the number (`two hundred and ten thousand one hundred and five` to `210105`). Groups that cannot combine are joined as digit strings (`twenty twenty six` to `2026`).
5. Amounts: `<N> dollars and <M> cents` and `<N> and <M> cents` become `N.MM`; `dollars` after a number is removed.
6. Split on whitespace. Nothing else is expanded (no contractions, no spelling variants).

WER = (S + D + I) / N, N = reference token count, from a minimum-edit word alignment.

## Check the scoring (no models)

Not runnable from the public repository: the stored outputs and the reference are not
published (see the top of this file). With your own reference and hypothesis files:

```sh
cd docs/validation/wer-16603
node score.mjs <reference.txt> <hyp.txt>...      # one line per file: WER, N, S, D, I
```

## Run the models again

Needs Node 20, Python 3.12, ffmpeg and about 5 GB of disk for weights. Run one model at a time
(one at a time; the batch scripts wrap each in `suite-gate <label> --`, the maintainer's job runner, which you can drop). Timings vary with
machine load; the WER should not.

```sh
cd docs/validation/wer-16603
export PASSAGE_AUDIO=/path/to/passage-v1-narration.webm   # attachment 25570
./to16k.sh "$PASSAGE_AUDIO" wav/passage.wav   # the run scripts also do this when wav/ is empty

# transformers.js (Whisper)
(cd js && npm ci)            # installs @huggingface/transformers 4.3.1, onnxruntime-node 1.30.0
./prefetch.sh                # optional: large ONNX files into models-js/; run.mjs fetches the other files from huggingface.co at the pinned revision
export WARM_LOAD=0
js/go.sh passage "$PASSAGE_AUDIO" turbo-q4f16-t4 4 onnx-community/whisper-large-v3-turbo_timestamped b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a '"q4f16"' word
js/go.sh passage "$PASSAGE_AUDIO" small.en-q8-t4 4 onnx-community/whisper-small.en_timestamped 8085393831131554ad978a4e438295a734d3d2c0 '"q8"' word
js/go.sh passage "$PASSAGE_AUDIO" base.en-q8-t4 4 onnx-community/whisper-base.en_timestamped fa239a41836c3305f6beec180e5940f3823ff5b8 '"q8"' word

# Parakeet TDT int8 (sherpa-onnx)
python3.12 -m venv venv && venv/bin/pip install sherpa-onnx==1.13.8 numpy==2.5.4
mkdir -p models-sherpa && curl -L -o models-sherpa/t.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
sha256sum models-sherpa/t.tar.bz2   # 157c157b...61e1ad
tar -xjf models-sherpa/t.tar.bz2 -C models-sherpa
./sherpa.sh passage "$PASSAGE_AUDIO" 4

# faster-whisper (reference runs; fw.py also reads the user site-packages)
pip install --user faster-whisper==1.2.1    # ctranslate2 4.8.1
./fw.sh passage "$PASSAGE_AUDIO" large-v3 4  # Systran/faster-whisper-large-v3@edaa852ec7e145841d8ffdb056a99866b5f0a478

# score and render
node build.mjs && node make-extras.mjs && node render.mjs
```

Other pinned rows in `RESULT.md` (commands in `batch-passage-2.sh`):
`onnx-community/parakeet-ctc-0.6b-ONNX@7df2cab7aed886b8b7f80d68a8214007e4847601` q8,
`onnx-community/moonshine-base-ONNX@b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad` q8 with `SEGMENT_MAX=20`,
`onnx-community/whisper-large-v3-turbo_timestamped@b3f77bf9…` encoder fp16 / decoder q4,
`onnx-community/cohere-transcribe-03-2026-ONNX@31b1c6211c9000d76b077ddd23b74c9090badeba` q4f16 with `MAX_NEW_TOKENS=1024`,
`Systran/faster-whisper-medium.en@a29b04bd15381511a9af671baec01072039215e3`.

The Vosk row was not re-run. It is the live transcript the extension wrote into the bundle
(`inputs/vosk-passage-r1.json`), scored with the same scorer.
