# sherpa.py <wav 16k mono> <threads> <out.json> — Parakeet TDT 0.6B v2 int8 via sherpa-onnx (greedy).
import sys, json, time, wave
import numpy as np
import sherpa_onnx
wav, threads, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
import os
# Unpacked k2-fsa release (see README.md); override with SHERPA_MODEL_DIR.
D = os.environ.get("SHERPA_MODEL_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models-sherpa", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
with wave.open(wav) as w:
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
t0 = time.time()
rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{D}/encoder.int8.onnx", decoder=f"{D}/decoder.int8.onnx", joiner=f"{D}/joiner.int8.onnx",
    tokens=f"{D}/tokens.txt", num_threads=threads, model_type="nemo_transducer", decoding_method="greedy_search")
t1 = time.time()
s = rec.create_stream(); s.accept_waveform(16000, x); rec.decode_stream(s)
t2 = time.time()
r = s.result
toks, ts = list(r.tokens), list(r.timestamps)
# words: a token starting with U+2581 or a space begins a new word
words = []
for tok, t in zip(toks, ts):
    if tok.startswith("▁") or tok.startswith(" ") or not words:
        words.append({"w": tok.replace("▁", "").strip(), "start": t})
    else:
        words[-1]["w"] += tok
res = {"label": f"parakeet-tdt-0.6b-v2-int8-t{threads}", "modelId": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 (k2-fsa release asr-models)",
       "runtime": f"sherpa-onnx {sherpa_onnx.__version__} (python, onnxruntime CPU)", "threads": threads,
       "dtype": "int8 encoder/decoder/joiner", "audioSeconds": len(x) / 16000, "loadS": t1 - t0, "transcribeS": t2 - t1,
       "wallS": t2 - t0, "wordTimestamps": len(ts) == len(toks) and len(ts) > 0, "tokenTimestamps": len(ts) > 0,
       "durations": list(getattr(r, "durations", []) or [])[:0], "text": r.text.strip(), "tokens": toks, "tokenStarts": ts, "words": words}
json.dump(res, open(out, "w"), indent=1)
print("TEXT:", res["text"]); print(f"load {t1-t0:.2f}s transcribe {t2-t1:.2f}s tokens={len(toks)} ts={len(ts)}")
