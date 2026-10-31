# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow>=17", "soundfile>=0.12", "numpy>=1.26"]
# ///
"""Build the narration fixtures for board #16539 from LibriSpeech test-clean (CC BY 4.0)
with Montreal Forced Aligner word timings (gilkeyio/librispeech-alignments, CC BY 4.0).

Usage: uv run build_fixtures.py <test_clean.parquet> <out-dir>

Writes:
  narration-30m.flac / .json  continuous 30-minute stream, 16 kHz mono
  narration-2m.flac  / .json  its first two minutes (model sweeps)
The JSON holds every reference word on the stream timeline: {"w","s","e"} in seconds.

A walkthrough narrator pauses while clicking, so the stream inserts a short gap between
utterances (0.3-1.5 s) and a long silence (6-12 s) roughly every two minutes. Long silences
are where Whisper-style decoders hallucinate, so they are part of the test, not padding.
"""
import io, json, random, sys
import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

SR = 16000
TARGET_S = 1800.0
SHORT_S = 120.0

def main(src, out):
    table = pq.read_table(src, columns=["id", "audio", "words"])
    rows = table.to_pylist()
    rows.sort(key=lambda r: r["id"])
    rng = random.Random(16539)
    chunks, words, t, next_long = [], [], 0.0, 120.0
    used = []
    for r in rows:
        if t >= TARGET_S:
            break
        audio, sr = sf.read(io.BytesIO(r["audio"]["bytes"]), dtype="float32")
        assert sr == SR, sr
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        dur = len(audio) / SR
        if t + dur > TARGET_S:
            break
        chunks.append(audio)
        for w in r["words"] or []:
            if w["word"]:
                words.append({"w": w["word"].lower(), "s": round(t + w["start"], 3), "e": round(t + w["end"], 3)})
        used.append(r["id"])
        t += dur
        gap = rng.uniform(6.0, 12.0) if t >= next_long else rng.uniform(0.3, 1.5)
        if t >= next_long:
            next_long += 120.0
        gap = min(gap, TARGET_S - t)
        chunks.append(np.zeros(int(gap * SR), dtype="float32"))
        t += gap
    stream = np.concatenate(chunks)
    meta = {"source": "LibriSpeech test-clean (CC BY 4.0) + MFA alignments gilkeyio/librispeech-alignments (CC BY 4.0)",
            "sampleRate": SR, "durationS": round(len(stream) / SR, 3), "utterances": used}
    write(out, "narration-30m", stream, words, meta)
    short = stream[: int(SHORT_S * SR)]
    write(out, "narration-2m", short, [w for w in words if w["e"] <= SHORT_S],
          {**meta, "durationS": SHORT_S, "utterances": None})

def write(out, name, audio, words, meta):
    sf.write(f"{out}/{name}.flac", audio, SR, subtype="PCM_16")
    with open(f"{out}/{name}.json", "w") as f:
        json.dump({**meta, "words": words}, f)
    print(name, f"{len(audio)/SR:.1f}s", len(words), "words")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
