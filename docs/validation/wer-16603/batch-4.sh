#!/bin/sh
# Phase 4 (after batch-3): Cohere with max_new_tokens at 4 threads, Parakeet CTC own decode, narration extras.
H=$(cd "$(dirname "$0")" && pwd)
A=${PASSAGE_AUDIO:?set PASSAGE_AUDIO to passage-v1-narration.webm (board #16603 attachment 25570)}
N=${NARRATION_AUDIO:?set NARRATION_AUDIO to audio/narration.webm from the rec_2465dd53 bundle (board #16603 attachment 25559)}
# The original waited for batch-3 to finish: until grep -q BATCH3-DONE out/batch-3.log; do sleep 5; done
G=$H/js/go.sh
export WARM_LOAD=0
MAX_NEW_TOKENS=1024 suite-gate p-cohere-t4 -- $G passage $A cohere-q4f16-mnt1024-t4 4 onnx-community/cohere-transcribe-03-2026-ONNX 31b1c6211c9000d76b077ddd23b74c9090badeba '"q4f16"' none
suite-gate p-ctc-own-t4 -- $H/js/ctc.sh passage $A 4
suite-gate p-ctc-own-t1 -- $H/js/ctc.sh passage $A 1
suite-gate n-ctc-own-t4 -- $H/js/ctc.sh narration $N 4
suite-gate n-tdt-t4 -- $H/sherpa.sh narration $N 4
suite-gate n-turbo-b-t8 -- $G narration $N turbo-q4f16-t8 8 onnx-community/whisper-large-v3-turbo_timestamped b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a '"q4f16"' word
SEGMENT_MAX=20 suite-gate n-moon-t4 -- $G narration $N moonshine-base-q8-seg20-t4 4 onnx-community/moonshine-base-ONNX b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad '"q8"' none
MAX_NEW_TOKENS=1024 suite-gate n-cohere-t4 -- $G narration $N cohere-q4f16-mnt1024-t4 4 onnx-community/cohere-transcribe-03-2026-ONNX 31b1c6211c9000d76b077ddd23b74c9090badeba '"q4f16"' none
echo BATCH4-DONE
