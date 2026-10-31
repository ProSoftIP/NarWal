#!/bin/sh
# ctc.sh <set> <audio file, any format> <threads> — Parakeet CTC q8 with own greedy CTC decode + frame word times.
set -e
H=$(cd "$(dirname "$0")/.." && pwd)  # docs/validation/wer-16603
S=$1; A=$2; T=$3; W=${WER_WAV_DIR:-$H/wav}/$S.wav; O=${WER_OUT_DIR:-$H/out}/$S; mkdir -p "$(dirname "$W")"; mkdir -p $O
[ -s "$W" ] || $H/to16k.sh "$A" "$W"
L=js-parakeet-ctc-q8-owndecode-t$T; cat /proc/loadavg > $O/$L.loadavg
/usr/bin/time -v -o $O/$L.time node $H/js/ctc.mjs "$W" $T $O/$L.json
grep -E "Maximum resident|Elapsed" $O/$L.time
