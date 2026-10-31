// ctc.mjs <wav 16k> <threads> <out.json> — Parakeet CTC 0.6B (q8) run directly: greedy argmax per frame,
// collapse repeats, drop blank, then word start/end from the frames of each word's first/last token.
import fs from 'node:fs';
import { AutoProcessor, AutoModelForCTC, AutoTokenizer, AutoConfig, env } from '@huggingface/transformers';
// Model cache (transformers.js layout <cacheDir>/<repo>/<revision>/<file>); prefetch.sh fills it.
env.cacheDir = process.env.WER_MODELS_DIR || new URL('../models-js', import.meta.url).pathname;
const [wavPath, thr, outPath] = process.argv.slice(2);
const tl0 = performance.now();
const id = 'onnx-community/parakeet-ctc-0.6b-ONNX', revision = '7df2cab7aed886b8b7f80d68a8214007e4847601';
const b = fs.readFileSync(wavPath); let off = 12, data;
while (off + 8 <= b.length) { const cid = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4); if (cid === 'data') data = b.subarray(off + 8, off + 8 + sz); off += 8 + sz + (sz & 1); }
const audio = new Float32Array(data.length >> 1); for (let i = 0; i < audio.length; i++) audio[i] = data.readInt16LE(i * 2) / 32768;
const config = await AutoConfig.from_pretrained(id, { revision });
const processor = await AutoProcessor.from_pretrained(id, { revision });
const tok = await AutoTokenizer.from_pretrained(id, { revision });
const model = await AutoModelForCTC.from_pretrained(id, { revision, dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: Number(thr), interOpNumThreads: 1 } });
const loadS = (performance.now() - tl0) / 1000;
// id -> SentencePiece piece straight from the cached tokenizer.json (BPE vocab dict)
const tj = JSON.parse(fs.readFileSync(`${env.cacheDir}/${id}/${revision}/tokenizer.json`, 'utf8'));
const id2piece = []; for (const [p, i] of Object.entries(tj.model.vocab)) id2piece[i] = p;
const t0 = performance.now();
const inputs = await processor(audio);
const { logits } = await model(inputs);
const ms = performance.now() - t0;
const [, T, V] = logits.dims; const L = logits.data;
const ids = new Int32Array(T);
for (let t = 0; t < T; t++) { let bi = 0, bv = -Infinity; for (let v = 0; v < V; v++) { const x = L[t * V + v]; if (x > bv) { bv = x; bi = v; } } ids[t] = bi; }
const counts = {}; for (const x of ids) counts[x] = (counts[x] || 0) + 1;
const blank = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]); // most frequent frame label
const frameS = audio.length / 16000 / T;
// emitted tokens with first and last frame
const toks = []; let prev = -1;
for (let t = 0; t < T; t++) { const x = ids[t]; if (x !== blank && x !== prev) toks.push({ id: x, f0: t, f1: t }); else if (x !== blank && x === prev) toks[toks.length - 1].f1 = t; prev = x; }
const raw = toks.map(k => id2piece[k.id] ?? '');
const words = [];
toks.forEach((k, i) => {
  const piece = raw[i]; const startsWord = piece.startsWith('▁') || words.length === 0;
  if (startsWord) words.push({ w: piece.replace('▁', ''), start: +(k.f0 * frameS).toFixed(2), end: +((k.f1 + 1) * frameS).toFixed(2) });
  else { const w = words[words.length - 1]; w.w += piece; w.end = +((k.f1 + 1) * frameS).toFixed(2); }
});
const text = tok.decode(toks.map(k => k.id), { skip_special_tokens: true }).trim();
const res = { label: 'parakeet-ctc-q8-owndecode', modelId: id, revision, dtype: 'q8', runtime: 'transformers.js 4.3.1 / onnxruntime-node 1.30.0 (AutoModelForCTC + own greedy CTC collapse)', device: 'cpu', threads: Number(thr), audioSeconds: audio.length / 16000, loadS, transcribeS: ms / 1000, wallS: loadS + ms / 1000, wordTimestamps: true, configBlank: config.pad_token_id ?? null, blankUsed: blank, vocab: V, frames: T, frameS, inferenceS: ms / 1000, text, words };
fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
console.log(`frames=${T} V=${V} blank=${blank} (config pad ${config.pad_token_id}) frame=${(frameS * 1000).toFixed(1)}ms infer=${(ms / 1000).toFixed(2)}s`);
console.log('TEXT:', text);
console.log(words.slice(0, 10).map(w => `${w.w} ${w.start}-${w.end}`).join(' | '));
