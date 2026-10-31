#!/bin/sh
# fw.sh <set> <audio file, any format> <model> <threads>
set -e
H=$(cd "$(dirname "$0")" && pwd)  # this directory (docs/validation/wer-16603)
S=$1; A=$2; M=$3; T=$4; W=${WER_WAV_DIR:-$H/wav}/$S.wav; O=${WER_OUT_DIR:-$H/out}/$S; mkdir -p "$(dirname "$W")"; mkdir -p $O
[ -s "$W" ] || $H/to16k.sh "$A" "$W"
L=fw-$M-t$T; cat /proc/loadavg > $O/$L.loadavg
/usr/bin/time -v -o $O/$L.time python3 -I $H/fw.py $M "$W" $O/$L.json $T
grep -E "Maximum resident|Elapsed" $O/$L.time
