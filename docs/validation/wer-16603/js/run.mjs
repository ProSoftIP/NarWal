// Env THREADS (default 8) sets onnxruntime intraOpNumThreads.
// Usage: node run.mjs <label> <modelId> <revision> <dtypeJSON> <word|none> <wav> <out.json>
import fs from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';
const [label, modelId, revision, dtypeArg, tsMode, wavPath, outPath] = process.argv.slice(2);
// Model cache (transformers.js layout <cacheDir>/<repo>/<revision>/<file>); prefetch.sh fills it.
env.cacheDir = process.env.WER_MODELS_DIR || new URL('../models-js', import.meta.url).pathname;
const dtype = JSON.parse(dtypeArg);

function readWav16(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not RIFF/WAVE');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) throw new Error('need 16k mono PCM16: ' + JSON.stringify(fmt));
  const n = data.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

const audio = readWav16(wavPath);
const isWhisper = /whisper/.test(modelId);
const threads = Number(process.env.THREADS || 8);
const opts = { revision, dtype, device: 'cpu', session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } };

// Pass 1: load (downloads into the scratch cache on first use), then dispose — not timed.
// WARM_LOAD=1 (default) does this; WARM_LOAD=0 skips it when the cache is already full, so peak RSS
// reflects one loaded copy.
let t = performance.now(), asr, firstLoadS = null;
if (process.env.WARM_LOAD !== '0') {
  asr = await pipeline('automatic-speech-recognition', modelId, opts);
  firstLoadS = (performance.now() - t) / 1000;
  await asr.dispose();
}
// Pass 2: timed load from local cache, then one timed transcription.
t = performance.now();
asr = await pipeline('automatic-speech-recognition', modelId, opts);
const loadS = (performance.now() - t) / 1000;
const callOpts = isWhisper ? { chunk_length_s: 30, stride_length_s: 5, return_timestamps: tsMode === 'word' ? 'word' : false } : {};
// MAX_NEW_TOKENS=<n> passes max_new_tokens (Cohere has no generation_config.json, so the default cap is 20 tokens per chunk).
if (process.env.MAX_NEW_TOKENS) callOpts.max_new_tokens = Number(process.env.MAX_NEW_TOKENS);
t = performance.now();
// SEGMENT_MAX=<s>: cut the audio at the quietest 100 ms frame between 0.6*max and max seconds into each
// segment (a crude energy VAD), run each segment, join the texts. Used for Moonshine, whose pipeline
// path has no chunking. Off by default.
const segMax = Number(process.env.SEGMENT_MAX || 0);
let res, segments = null;
if (segMax > 0) {
  const fr = 1600, cuts = [0];
  while (audio.length - cuts[cuts.length - 1] > segMax * 16000) {
    const s0 = cuts[cuts.length - 1]; let best = -1, bestE = Infinity;
    for (let f = s0 + Math.floor(0.6 * segMax * 16000); f + fr <= s0 + segMax * 16000; f += fr) {
      let e = 0; for (let i = f; i < f + fr; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = f + fr / 2; }
    }
    cuts.push(best);
  }
  cuts.push(audio.length);
  const texts = [];
  for (let k = 0; k + 1 < cuts.length; k++) texts.push((await asr(audio.subarray(cuts[k], cuts[k + 1]), callOpts)).text.trim());
  segments = cuts.map(c => +(c / 16000).toFixed(2));
  res = { text: texts.join(' ') };
} else res = await asr(audio, callOpts);
const transcribeS = (performance.now() - t) / 1000;
await asr.dispose();
const words = (res.chunks ?? []).map(c => ({ w: c.text, start: c.timestamp?.[0] ?? null, end: c.timestamp?.[1] ?? null }));
const result = {
  label, modelId, revision, dtype, device: 'cpu', threads, runtime: 'transformers.js 4.3.1 / onnxruntime-node 1.30.0',
  callOpts, segmentMaxS: segMax || null, segmentCutsS: segments, audioSeconds: audio.length / 16000,
  warmLoad: process.env.WARM_LOAD !== '0', firstLoadS, loadS, transcribeS, wallS: loadS + transcribeS,
  wordTimestamps: words.length > 0 && words.every(x => typeof x.start === 'number'),
  wordCount: words.length, text: res.text.trim(), words,
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log('TEXT:', result.text);
console.log(`load ${loadS.toFixed(2)}s transcribe ${transcribeS.toFixed(2)}s wordTimestamps=${result.wordTimestamps} words=${words.length}`);
