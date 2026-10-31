// ctx-exp.mjs <engine parakeet|small|base|turbo> <pcm.f32> <vadJSON> <contextS[/rightS]> <rule> <out.txt>
// The final pass's span plan, each span decoded with contextS of audio around it; words kept by start time.
// Rules: core (start inside the span), prev (also after the previous span's last word end),
// dedupe (core plus the text check at a shared cut). Suffix -cuts: context only at a shared cut;
// -short: and around a span under 1 s. `dedupe-cuts-short` with 2 is what final-pass.ts ships.
// Env: SHERPA_NPM (sherpa-onnx npm index.js), PARAKEET_DIR, TRANSFORMERS_NODE, TRANSFORMERS_CACHE.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { planSpeech, pcmSource } from '../../../../packages/offline-transcription/src/vad.ts';
import { sherpaWords } from '../../../../packages/offline-transcription/src/engines/sherpa-words.ts';
const [engine, f, vadJson, ctxArg, rule, out] = process.argv.slice(2);
const ctxS = ctxArg;
const b = fs.readFileSync(f);
const pcm = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
const plan = await planSpeech(pcmSource(pcm), JSON.parse(vadJson || '{}'));
let transcribe;
if (engine === 'parakeet') {
  const sherpa = createRequire(import.meta.url)(process.env.SHERPA_NPM);
  const M = process.env.PARAKEET_DIR + '/';
  const rec = sherpa.createOfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: M + 'encoder.int8.onnx', decoder: M + 'decoder.int8.onnx', joiner: M + 'joiner.int8.onnx' }, tokens: M + 'tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: 'nemo_transducer' },
    decodingMethod: 'greedy_search' });
  transcribe = async (x) => { const s = rec.createStream(); s.acceptWaveform(16000, x); rec.decode(s); const r = rec.getResult(s); s.free(); return sherpaWords(r); };
} else {
  const { pipeline, env } = await import(process.env.TRANSFORMERS_NODE);
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
  const M = { small: ['onnx-community/whisper-small.en_timestamped', '8085393831131554ad978a4e438295a734d3d2c0', 'q8'], base: ['onnx-community/whisper-base.en_timestamped', 'fa239a41836c3305f6beec180e5940f3823ff5b8', 'q8'], turbo: ['onnx-community/whisper-large-v3-turbo_timestamped', 'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a', 'q4f16'] }[engine];
  const asr = await pipeline('automatic-speech-recognition', M[0], { revision: M[1], dtype: M[2], device: 'cpu', session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } });
  transcribe = async (x) => {
    const r = await asr(x, { return_timestamps: 'word' });
    const words = [];
    for (const c of r.chunks ?? []) {
      // A piece without a leading space continues the word before it (",456" after " $123").
      if (words.length && !/^\s/.test(c.text)) { const w = words[words.length - 1]; w.text += c.text; w.end = c.timestamp[1] ?? w.end; }
      else words.push({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] });
    }
    return words;
  };
}
const [ctxL, ctxR] = ctxArg.split("/").map(Number); const ctx = Math.round(ctxL * 16000), ctxRight = Math.round((ctxR ?? ctxL) * 16000);
const texts = [];
let prevEndS = -Infinity; let prevLast = null; let prevSpanEnd = -1; let audioRead = 0;
const t0 = performance.now();
const cutsOnly = rule.includes('-cuts'); const shortPad = rule.includes('-short');
for (let i = 0; i < plan.length; i += 1) {
  const sp = plan[i];
  const isShort = shortPad && sp.endSample - sp.startSample < 16000;
  const lc = !cutsOnly || isShort || (i > 0 && plan[i - 1].endSample === sp.startSample) ? ctx : 0;
  const rc = !cutsOnly || isShort || (i + 1 < plan.length && plan[i + 1].startSample === sp.endSample) ? ctxRight : 0;
  const readStart = Math.max(0, sp.startSample - lc), readEnd = Math.min(pcm.length, sp.endSample + rc);
  audioRead += readEnd - readStart;
  const words = await transcribe(pcm.slice(readStart, readEnd));
  const startS = sp.startSample / 16000, endS = sp.endSample / 16000, off = readStart / 16000;
  const contiguous = sp.startSample === prevSpanEnd;
  let lower = startS;
  if (rule.startsWith('prev')) lower = Math.max(contiguous ? startS - 0.5 : startS, prevEndS - 0.1);
  let kept = (ctx || ctxRight) ? words.filter((w) => off + w.start >= lower && off + w.start < endS) : words;
  if (rule.startsWith('dedupe') && contiguous && prevLast) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (kept.length && norm(kept[0].text) === norm(prevLast.text) && Math.abs(off + kept[0].start - prevLast.at) < 0.5) kept = kept.slice(1);
    const before = words.filter((w) => off + w.start >= startS - 0.5 && off + w.start < startS).at(-1);
    if (before && norm(before.text) !== norm(prevLast.text) && off + before.start > prevLast.at + 0.1) kept = [before, ...kept];
  }
  prevLast = kept.length ? { text: kept.at(-1).text, at: off + kept.at(-1).start } : null;
  if (process.env.DEBUG) console.error(JSON.stringify({ i, startS, endS, off, lower, n: words.length, kept: kept.length, first: words.slice(0, 3).map((w) => [w.text, +(off + w.start).toFixed(2)]), last: words.slice(-3).map((w) => [w.text, +(off + w.start).toFixed(2), +(off + w.end).toFixed(2)]) }));
  if (kept.length) prevEndS = off + kept[kept.length - 1].end;
  prevSpanEnd = sp.endSample;
  texts.push(kept.map((w) => w.text).join(' '));
}
fs.writeFileSync(out, texts.join(' ').replace(/\s+/g, ' ').trim() + '\n');
console.error(`${engine} vad=${vadJson} ctx=${ctxS} ${rule} spans=${plan.length} read=${(audioRead / 16000).toFixed(1)}s ${((performance.now() - t0) / 1000).toFixed(1)}s`);
