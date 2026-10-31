#!/bin/sh
# Phase 3: Moonshine segmented at 4 threads, every candidate at 1 thread, CTC alignment, faster-whisper on the passage.
H=$(cd "$(dirname "$0")" && pwd)
A=${PASSAGE_AUDIO:?set PASSAGE_AUDIO to passage-v1-narration.webm (board #16603 attachment 25570)}
O=${WER_OUT_DIR:-$H/out}; WV=${WER_WAV_DIR:-$H/wav}
export WARM_LOAD=0
SEGMENT_MAX=20 suite-gate p-moon-seg-t4 -- $H/js/go.sh passage $A moonshine-base-q8-seg20-t4 4 onnx-community/moonshine-base-ONNX b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad '"q8"' none
suite-gate p-ctc-align -- node $H/js/ctc.mjs $WV/passage.wav 4 $O/ctc-align-passage.json
suite-gate n-ctc-align -- node $H/js/ctc.mjs $WV/narration.wav 4 $O/ctc-align-narration.json
suite-gate p-fw-large -- $H/fw.sh passage $A large-v3 4
suite-gate p-fw-medium -- $H/fw.sh passage $A medium.en 4
$H/batch-passage-2.sh 1
echo BATCH3-DONE
