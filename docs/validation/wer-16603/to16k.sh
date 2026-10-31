#!/bin/sh
# to16k.sh <any audio (webm/m4a/wav...)> <out.wav> — 16 kHz mono PCM16 via ffmpeg.
set -e
ffmpeg -hide_banner -loglevel error -y -i "$1" -ac 1 -ar 16000 -c:a pcm_s16le "$2"
