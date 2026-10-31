// tjs-spans.mjs <small|base|moon|turbo> <pcm.f32> <spans.json|whole> <out.txt> — transformers.js 4.3.1 on onnxruntime-node (native CPU),
// called per span the way whisper-worker.ts calls it in the extension. `whole` with Whisper uses the #16603 call (30 s chunks, 5 s stride).
import fs from 'node:fs';
const { pipeline, env } = await import(process.env.TRANSFORMERS_NODE);
env.cacheDir = process.env.TRANSFORMERS_CACHE;
const M = {
  small: ['onnx-community/whisper-small.en_timestamped', '8085393831131554ad978a4e438295a734d3d2c0', 'q8'],
  base: ['onnx-community/whisper-base.en_timestamped', 'fa239a41836c3305f6beec180e5940f3823ff5b8', 'q8'],
  moon: ['onnx-community/moonshine-base-ONNX', 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', 'q8'],
  turbo: ['onnx-community/whisper-large-v3-turbo_timestamped', 'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a', 'q4f16'],
};
const [key, f, spansFile, out] = process.argv.slice(2);
const [repo, revision, dtype] = M[key];
const b = fs.readFileSync(f);
const pcm = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
const asr = await pipeline('automatic-speech-recognition', repo, { revision, dtype, device: 'cpu', session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } });
const moon = key === 'moon';
const t0 = performance.now();
const texts = [];
if (spansFile === 'whole' && !moon) {
  texts.push((await asr(pcm, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: 'word' })).text.trim());
} else {
  const spans = spansFile === 'whole' ? [{ startSample: 0, endSample: pcm.length }] : JSON.parse(fs.readFileSync(spansFile, 'utf8'));
  for (const sp of spans) {
    const x = pcm.slice(sp.startSample, sp.endSample);
    const r = moon ? await asr(x, { max_new_tokens: Math.max(12, Math.ceil((x.length / 16000) * 6)) }) : await asr(x, { return_timestamps: 'word' });
    texts.push((moon ? r.text : (r.chunks ?? []).map((c) => c.text).join('')).trim());
  }
}
fs.writeFileSync(out, texts.join(' ') + '\n');
console.error(`${key} ${spansFile} ${((performance.now() - t0) / 1000).toFixed(1)}s`);
await asr.dispose();
