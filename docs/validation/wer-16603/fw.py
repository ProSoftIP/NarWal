# fw.py <model> <wav 16k> <out.json> [threads] — faster-whisper reference transcription (CPU int8, beam 5).
import sys, json, time, site
sys.path.append(site.getusersitepackages())  # faster_whisper lives in the user site; -I hides it
from faster_whisper import WhisperModel
model_name, wav, out = sys.argv[1], sys.argv[2], sys.argv[3]
threads = int(sys.argv[4]) if len(sys.argv) > 4 else 0
t0 = time.time()
m = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
t1 = time.time()
segs, info = m.transcribe(wav, beam_size=5, language="en", condition_on_previous_text=False,
                          vad_filter=False, word_timestamps=True)
segs = list(segs)
t2 = time.time()
text = " ".join(s.text.strip() for s in segs)
words = [{"w": w.word, "start": w.start, "end": w.end, "p": w.probability} for s in segs for w in (s.words or [])]
json.dump({"model": model_name, "threads": threads or "ctranslate2 default (0)", "audioSeconds": info.duration, "runtime": "faster-whisper 1.2.1 / ctranslate2 4.8.1 CPU int8",
           "load_s": t1 - t0, "transcribe_s": t2 - t1, "wall_s": t2 - t0, "text": text,
           "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in segs], "words": words},
          open(out, "w"), indent=1)
print("TEXT:", text); print("wall", t2 - t0, "transcribe", t2 - t1)
