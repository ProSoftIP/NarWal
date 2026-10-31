#!/usr/bin/env bash
# Reproducible ASR-only browser WebAssembly build of sherpa-onnx v1.13.8
# (NarWal board #16608).
#
# Output (in $OUT):
#   sherpa-onnx-asr-wasm.js / .wasm       ENVIRONMENT=web,worker       (ship)
#   sherpa-onnx-asr-wasm-node.js / .wasm  ENVIRONMENT=web,worker,node  (Node smoke test twin;
#                                         same objects, same link flags except ENVIRONMENT)
#   sherpa-onnx-asr.js                    upstream wasm/asr wrapper, unchanged
#
# The two ship files and the wrapper are copied by hand into this directory;
# build.mjs pins their SHA-256, so change the pins in the same commit.
#
# No TTS (no espeak-ng, no piper-phonemize), no speaker diarization (no hclust-cpp),
# no NODERAWFS, no pthreads, no --preload-file, DYNAMIC_EXECUTION=0.
#
# Usage: ./build-wasm.sh <work-dir>   (a scratch directory outside the repository)
# Needs: git, python3, curl/network, and either cmake>=3.13 on PATH or `uv` (used to
# install cmake 3.31.6 + ninja into a local venv).

set -euo pipefail

WORK=${1:?usage: build-wasm.sh <work-dir>}
SHERPA_TAG=v1.13.8
SHERPA_COMMIT=11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf
EMSDK_VERSION=4.0.23          # what sherpa-onnx CI uses (.github/workflows/npm.yaml)
JOBS=${JOBS:-8}
OUT=$WORK/out

mkdir -p "$WORK" "$OUT"
cd "$WORK"

# 1. sherpa-onnx at the tag
if [ ! -d sherpa-onnx ]; then
  git clone --depth 1 --branch "$SHERPA_TAG" https://github.com/k2-fsa/sherpa-onnx
fi
got=$(git -C sherpa-onnx rev-parse HEAD)
[ "$got" = "$SHERPA_COMMIT" ] || { echo "sherpa-onnx HEAD $got != $SHERPA_COMMIT"; exit 1; }

# 2. emsdk, exact version
if [ ! -d emsdk ]; then
  git clone https://github.com/emscripten-core/emsdk.git
fi
(cd emsdk && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"
emcc --version | head -1
EMSCRIPTEN=$(dirname "$(realpath "$(which emcc)")")

# 3. cmake + ninja
if ! command -v cmake >/dev/null; then
  if [ ! -x "$WORK/venv/bin/cmake" ]; then
    uv venv -q "$WORK/venv"
    VIRTUAL_ENV="$WORK/venv" uv pip install -q cmake==3.31.6 ninja
  fi
  export PATH="$WORK/venv/bin:$PATH"
fi
cmake --version | head -1

# 4. Add an ASR-only browser target to the sherpa-onnx tree.
SRC=$WORK/sherpa-onnx
TGT=$SRC/wasm/asr-browser
mkdir -p "$TGT"

# Same C glue as wasm/nodejs/sherpa-onnx-wasm-nodejs.cc (struct-layout static_asserts
# for the JS wrapper, PrintOfflineRecognizerConfig, CopyHeap) minus PrintOfflineTtsConfig.
awk '
  /^void PrintOfflineTtsConfig\(/ { skip = 1 }
  /^void PrintOfflineRecognizerConfig\(/ { skip = 0 }
  !skip { print }
' "$SRC/wasm/nodejs/sherpa-onnx-wasm-nodejs.cc" > "$TGT/sherpa-onnx-wasm-asr-browser.cc"

cat > "$TGT/CMakeLists.txt" <<'CMAKE'
# ASR-only browser build (NarWal #16608). Functions = what wasm/asr/sherpa-onnx-asr.js
# calls, plus a few offline/version helpers.
set(exported_functions
  CopyHeap
  malloc
  free
  PrintOfflineRecognizerConfig
  # non-streaming ASR
  SherpaOnnxAcceptWaveformOffline
  SherpaOnnxCreateOfflineRecognizer
  SherpaOnnxCreateOfflineStream
  SherpaOnnxDecodeMultipleOfflineStreams
  SherpaOnnxDecodeOfflineStream
  SherpaOnnxDestroyOfflineRecognizer
  SherpaOnnxDestroyOfflineRecognizerResult
  SherpaOnnxDestroyOfflineStream
  SherpaOnnxDestroyOfflineStreamResultJson
  SherpaOnnxGetOfflineStreamResult
  SherpaOnnxGetOfflineStreamResultAsJson
  SherpaOnnxOfflineStreamGetOption
  SherpaOnnxOfflineStreamSetOption
  SherpaOnnxOfflineRecognizerSetConfig
  # streaming ASR (sherpa-onnx-asr.js also wraps these)
  SherpaOnnxCreateOnlineRecognizer
  SherpaOnnxCreateOnlineStream
  SherpaOnnxDecodeOnlineStream
  SherpaOnnxDestroyOnlineRecognizer
  SherpaOnnxDestroyOnlineRecognizerResult
  SherpaOnnxDestroyOnlineStream
  SherpaOnnxDestroyOnlineStreamResultJson
  SherpaOnnxGetOnlineStreamResult
  SherpaOnnxGetOnlineStreamResultAsJson
  SherpaOnnxIsOnlineStreamReady
  SherpaOnnxOnlineStreamAcceptWaveform
  SherpaOnnxOnlineStreamGetOption
  SherpaOnnxOnlineStreamInputFinished
  SherpaOnnxOnlineStreamIsEndpoint
  SherpaOnnxOnlineStreamReset
  SherpaOnnxOnlineStreamSetOption
  # version
  SherpaOnnxGetGitDate
  SherpaOnnxGetGitSha1
  SherpaOnnxGetVersionStr
  SherpaOnnxGetOnnxruntimeVersionStr
)
set(mangled)
foreach(x IN LISTS exported_functions)
  list(APPEND mangled "_${x}")
endforeach()
list(JOIN mangled "," all_exported)

set(common_link
  -O3
  -sMODULARIZE=1
  -sEXPORT_NAME=createSherpaOnnxAsrModule
  -sFORCE_FILESYSTEM=1
  -sINITIAL_MEMORY=512MB
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=10485760
  -sDYNAMIC_EXECUTION=0
  -sNODERAWFS=0
  -sWASM_ASYNC_COMPILATION=1
  "-sEXPORTED_FUNCTIONS=[${all_exported}]"
  "-sEXPORTED_RUNTIME_METHODS=['setValue','getValue','lengthBytesUTF8','stringToUTF8','UTF8ToString','HEAP8','HEAPU8','HEAP32','HEAPU32','HEAPF32','FS']"
)

add_executable(sherpa-onnx-asr-wasm sherpa-onnx-wasm-asr-browser.cc)
target_link_libraries(sherpa-onnx-asr-wasm sherpa-onnx-c-api sherpa-onnx-core)
target_link_options(sherpa-onnx-asr-wasm PRIVATE ${common_link} "-sENVIRONMENT=web,worker")

add_executable(sherpa-onnx-asr-wasm-node sherpa-onnx-wasm-asr-browser.cc)
target_link_libraries(sherpa-onnx-asr-wasm-node sherpa-onnx-c-api sherpa-onnx-core)
target_link_options(sherpa-onnx-asr-wasm-node PRIVATE ${common_link} "-sENVIRONMENT=web,worker,node")
CMAKE

grep -q 'asr-browser' "$SRC/wasm/CMakeLists.txt" || cat >> "$SRC/wasm/CMakeLists.txt" <<'CMAKE'

if(SHERPA_ONNX_ENABLE_WASM_ASR_BROWSER)
  add_subdirectory(asr-browser)
endif()
CMAKE

# 5. Configure + build
# The prefix maps rewrite the work directory to /sherpa-build in __FILE__ (log
# and assert messages) and debug paths, so the output does not depend on the
# folder it was built in: a build in any <work-dir> gives the same SHA-256.
BUILD=$WORK/build-asr-browser
mkdir -p "$BUILD"
WORK_ABS=$(realpath "$WORK")
PREFIX_MAP="-ffile-prefix-map=$WORK_ABS=/sherpa-build -fmacro-prefix-map=$WORK_ABS=/sherpa-build"
cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_C_FLAGS="-msimd128 $PREFIX_MAP" \
  -DCMAKE_CXX_FLAGS="-msimd128 $PREFIX_MAP" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_ASR_BROWSER=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF
cmake --build "$BUILD" -j "$JOBS" --target sherpa-onnx-asr-wasm sherpa-onnx-asr-wasm-node

# 6. Collect
B=$BUILD/bin
[ -f "$B/sherpa-onnx-asr-wasm.js" ] || B=$(dirname "$(find "$BUILD" -name sherpa-onnx-asr-wasm.js | head -1)")
cp -f "$B/sherpa-onnx-asr-wasm.js" "$B/sherpa-onnx-asr-wasm.wasm" "$OUT/"
cp -f "$B/sherpa-onnx-asr-wasm-node.js" "$B/sherpa-onnx-asr-wasm-node.wasm" "$OUT/"
cp -f "$SRC/wasm/asr/sherpa-onnx-asr.js" "$OUT/sherpa-onnx-asr.js"

# 7. Checks that must say NO
for f in "$OUT"/sherpa-onnx-asr-wasm*.js; do
  if grep -nE '\beval\(|new Function' "$f"; then echo "FAIL dynamic code in $f"; exit 1; fi
  if grep -q 'NODERAWFS' "$f"; then echo "FAIL NODERAWFS in $f"; exit 1; fi
done
for f in "$OUT"/sherpa-onnx-asr-wasm*.wasm; do
  if strings "$f" | grep -iE 'espeak|piper'; then echo "FAIL espeak/piper in $f"; exit 1; fi
  if strings "$f" | grep -F "$WORK_ABS"; then echo "FAIL work-dir path in $f"; exit 1; fi
done
ls -l "$OUT"
sha256sum "$OUT"/*
echo "BUILD OK"
