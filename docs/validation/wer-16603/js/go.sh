#!/bin/sh
# go.sh <set> <audio file, any format> <label> <threads> <modelId> <revision> <dtypeJSON> <word|none>
# Converts the audio to 16 kHz mono WAV once (wav/<set>.wav), then runs one transformers.js
# model under /usr/bin/time -v. Writes out/<set>/js-<label>.json, .time and .loadavg.
set -e
H=$(cd "$(dirname "$0")/.." && pwd)  # docs/validation/wer-16603
S=$1; A=$2; L=$3; T=$4; shift 4
W=${WER_WAV_DIR:-$H/wav}/$S.wav; O=${WER_OUT_DIR:-$H/out}/$S; mkdir -p "$(dirname "$W")"; mkdir -p $O
[ -s "$W" ] || $H/to16k.sh "$A" "$W"
cat /proc/loadavg > $O/js-$L.loadavg
THREADS=$T /usr/bin/time -v -o $O/js-$L.time node $H/js/run.mjs "$L" "$1" "$2" "$3" "$4" "$W" $O/js-$L.json
grep -E "Maximum resident|Elapsed" $O/js-$L.time
