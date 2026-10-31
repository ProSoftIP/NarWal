# sherpa-onnx, ASR-only WebAssembly build

The engine that runs Parakeet TDT in the final pass (board #16608).

| File | What it is | Size | SHA-256 |
|---|---|---|---|
| `sherpa-onnx-asr-wasm.wasm` | sherpa-onnx v1.13.8 compiled for the browser, speech recognition only | 14,071,683 B | `a494e2b7f659dd622304ed0dbfcc89cfdb39956139c643b2510aa53a308dae11` |
| `sherpa-onnx-asr-wasm.js` | its Emscripten glue (`createSherpaOnnxAsrModule`) | 80,243 B | `8d95bbe9dd7fc4a461eb098ffb86f8e4e47e5167721c182a1074987b70f80324` |
| `sherpa-onnx-asr.js` | upstream `wasm/asr/sherpa-onnx-asr.js`, unchanged | 53,867 B | `d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178` |

`build.mjs` pins all three. It refuses glue with `eval(`, `new Function`,
`importScripts(`, `require(` or `NODERAWFS`, and makes the wrapper's
`module.exports` unconditional (upstream sets it only under Node). The
worker (`src/engines/sherpa-worker.ts`) is bundled to
`dist/runtime/sherpa-worker.js`; the `.wasm` is copied to
`dist/runtime/sherpa-onnx.wasm`.

## Why not the npm package

`sherpa-onnx` on npm ships one WebAssembly file for every feature. It links
espeak-ng and piper-phonemize for text to speech; espeak-ng is GPL-3.0. Its
glue also reads files through Node (`NODERAWFS`), which a browser worker
cannot do. This build turns text to speech and speaker diarization off, so
neither library is in the binary (`strings` finds no `espeak` or `piper`),
and links for `web,worker` with an in-memory file system.

## Build

```sh
./build-wasm.sh /tmp/sherpa-build      # a scratch directory outside the repository
```

The script checks out tag v1.13.8 (commit
`11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`), installs Emscripten 4.0.23
(what upstream CI uses), adds a `wasm/asr-browser` target and builds it.
Link options: single thread, `-msimd128`, `MODULARIZE`,
`ENVIRONMENT=web,worker`, `DYNAMIC_EXECUTION=0`, `INITIAL_MEMORY=512MB`,
growth to 4 GB. It also builds a Node twin (same objects, `ENVIRONMENT` adds
`node`) for a smoke test outside the browser; that twin is not shipped.

The compile flags map the work directory to `/sherpa-build`
(`-ffile-prefix-map`, `-fmacro-prefix-map`), so the output does not depend
on the folder: builds in `/tmp/l16608/sherpa-build` and
`/tmp/l16608/second-folder/other-work-dir` gave byte-identical files with the
SHA-256 values above. The script fails if the work directory's path is left
in a `.wasm`.

Copy the three files from `<work-dir>/out/` here and change the pins in
`build.mjs` in the same commit.

## Licences

sherpa-onnx is Apache-2.0. Compiled in: ONNX Runtime 1.28.2 (MIT),
kaldi-native-fbank, kaldi-decoder, kaldifst, OpenFst and
simple-sentencepiece (Apache-2.0), KISS FFT (BSD-3-Clause), nlohmann/json
(MIT), Eigen (MPL-2.0), the Emscripten runtime and musl (MIT).
`third-party/NOTICES.txt` lists the versions and texts; the build fails when
the notice is missing.
