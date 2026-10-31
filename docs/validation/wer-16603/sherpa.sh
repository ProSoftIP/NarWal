#!/bin/sh
# sherpa.sh <set> <audio file, any format> <threads>
set -e
H=$(cd "$(dirname "$0")" && pwd)  # this directory (docs/validation/wer-16603)
S=$1; A=$2; T=$3; W=${WER_WAV_DIR:-$H/wav}/$S.wav; O=${WER_OUT_DIR:-$H/out}/$S; mkdir -p "$(dirname "$W")"; mkdir -p $O
[ -s "$W" ] || $H/to16k.sh "$A" "$W"
L=parakeet-tdt-int8-t$T; cat /proc/loadavg > $O/py-$L.loadavg
/usr/bin/time -v -o $O/py-$L.time ${WER_VENV:-$H/venv}/bin/python -I $H/sherpa.py "$W" "$T" $O/py-$L.json
grep -E "Maximum resident|Elapsed" $O/py-$L.time
