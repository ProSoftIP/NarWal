#!/bin/sh
# Prefetch large ONNX files into the transformers.js cache layout (<cacheDir>/<repo>/<revision>/<file>).
H=$(cd "$(dirname "$0")" && pwd)
C=${WER_MODELS_DIR:-$H/models-js}
get() { repo=$1; rev=$2; f=$3; d="$C/$repo/$rev/$(dirname $f)"; mkdir -p "$d"; [ -s "$C/$repo/$rev/$f" ] && return; curl -sSL --retry 3 -o "$C/$repo/$rev/$f.part" "https://huggingface.co/$repo/resolve/$rev/$f" && mv "$C/$repo/$rev/$f.part" "$C/$repo/$rev/$f"; echo "done $repo $f $(stat -c %s $C/$repo/$rev/$f)"; }
T=onnx-community/whisper-large-v3-turbo_timestamped; TR=b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a
P=onnx-community/parakeet-ctc-0.6b-ONNX; PR=7df2cab7aed886b8b7f80d68a8214007e4847601
K=onnx-community/cohere-transcribe-03-2026-ONNX; KR=31b1c6211c9000d76b077ddd23b74c9090badeba
get $P $PR onnx/model_quantized.onnx; get $P $PR onnx/model_quantized.onnx_data
get $T $TR onnx/encoder_model_q4f16.onnx; get $T $TR onnx/decoder_model_merged_q4f16.onnx
get $K $KR onnx/encoder_model_q4f16.onnx; get $K $KR onnx/encoder_model_q4f16.onnx_data
get $K $KR onnx/decoder_model_merged_q4f16.onnx; get $K $KR onnx/decoder_model_merged_q4f16.onnx_data
echo PREFETCH-DONE
