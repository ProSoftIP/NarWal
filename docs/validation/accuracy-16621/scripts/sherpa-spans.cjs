// sherpa-spans.cjs <pcm.f32> <spans.json|whole> <out.txt> — Parakeet TDT int8 on sherpa-onnx 1.13.8 WebAssembly (npm), one span at a time.
const fs = require('fs');
const sherpa = require(process.env.SHERPA_NPM);
const M = process.env.PARAKEET_DIR + '/';
const [f, spansFile, out] = process.argv.slice(2);
const rec = sherpa.createOfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: M + 'encoder.int8.onnx', decoder: M + 'decoder.int8.onnx', joiner: M + 'joiner.int8.onnx' },
    tokens: M + 'tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: 'nemo_transducer' },
  decodingMethod: 'greedy_search',
});
const b = fs.readFileSync(f);
const pcm = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
const spans = spansFile === 'whole' ? [{ startSample: 0, endSample: pcm.length }] : JSON.parse(fs.readFileSync(spansFile, 'utf8'));
const texts = [];
const t0 = Date.now();
for (const sp of spans) {
  const s = rec.createStream();
  s.acceptWaveform(16000, pcm.slice(sp.startSample, sp.endSample));
  rec.decode(s);
  texts.push(rec.getResult(s).text.trim());
  s.free();
}
fs.writeFileSync(out, texts.join(' ') + '\n');
console.error(`${spans.length} spans ${(Date.now() - t0) / 1000}s`);
