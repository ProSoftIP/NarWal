#!/bin/sh
# Runs every candidate on the passage, one at a time, each under suite-gate. Usage: batch-passage.sh <threads...>
H=$(cd "$(dirname "$0")" && pwd)
A=${PASSAGE_AUDIO:?set PASSAGE_AUDIO to passage-v1-narration.webm (board #16603 attachment 25570)}
G=$H/js/go.sh
export WARM_LOAD=0
for T in "$@"; do
  suite-gate p-base-t$T -- $G passage $A base.en-q8-t$T $T onnx-community/whisper-base.en_timestamped fa239a41836c3305f6beec180e5940f3823ff5b8 '"q8"' word
  suite-gate p-small-t$T -- $G passage $A small.en-q8-t$T $T onnx-community/whisper-small.en_timestamped 8085393831131554ad978a4e438295a734d3d2c0 '"q8"' word
  suite-gate p-tdt-t$T -- $H/sherpa.sh passage $A $T
  suite-gate p-ctc-t$T -- $G passage $A parakeet-ctc-q8-t$T $T onnx-community/parakeet-ctc-0.6b-ONNX 7df2cab7aed886b8b7f80d68a8214007e4847601 '"q8"' none
  SEGMENT_MAX=20 suite-gate p-moon-t$T -- $G passage $A moonshine-base-q8-seg20-t$T $T onnx-community/moonshine-base-ONNX b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad '"q8"' none
  suite-gate p-turbo-a-t$T -- $G passage $A turbo-encfp16-decq4-t$T $T onnx-community/whisper-large-v3-turbo_timestamped b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a '{"encoder_model":"fp16","decoder_model_merged":"q4"}' word
  suite-gate p-turbo-b-t$T -- $G passage $A turbo-q4f16-t$T $T onnx-community/whisper-large-v3-turbo_timestamped b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a '"q4f16"' word
  MAX_NEW_TOKENS=1024 suite-gate p-cohere-t$T -- $G passage $A cohere-q4f16-mnt1024-t$T $T onnx-community/cohere-transcribe-03-2026-ONNX 31b1c6211c9000d76b077ddd23b74c9090badeba '"q4f16"' none
done
echo BATCH-DONE
