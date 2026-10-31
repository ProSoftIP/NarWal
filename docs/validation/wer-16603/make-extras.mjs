// make-extras.mjs — notes, sizes, lookups and the CTC alignment sample for render.mjs.
import fs from 'node:fs';
import { score } from './score.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Paths: everything is relative to this directory unless an env var overrides it (see README.md).
const W = path.dirname(fileURLToPath(import.meta.url));
const O = process.env.WER_OUT_DIR || `${W}/out`;
const RES = process.env.WER_RESULT_DIR || W;
const REF = process.env.WER_REFERENCE || `${W}/reading-passage-v1.txt`;
const j = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sup = f => j(`${O}/passage/superseded/${f}`);
const ref = fs.readFileSync(REF, 'utf8');
const pct = x => (x * 100).toFixed(1) + '%';
const R = j(`${RES}/result.json`);
const voskP = R.sets.passage.rows.find(r => r.kind === 'vosk');
const moonWhole = sup('js-moonshine-base-q8-t4.json'), cohere20 = sup('js-cohere-q4f16-t4.json');
const ctcP = j(`${O}/passage/js-parakeet-ctc-q8-owndecode-t4.json`), ctcN = j(`${O}/narration/js-parakeet-ctc-q8-owndecode-t4.json`);
const ctcPipe = R.sets.passage.rows.find(r => r.label.startsWith('js-parakeet-ctc-q8-t'));
// CTC word starts vs faster-whisper large-v3 word starts (sequential match on the lowercase word)
function ctcVsFw(ctc, fw) {
  if (!ctc || !fw) return null;
  const clean = x => x.toLowerCase().replace(/[^a-z0-9']/g, '');
  const fwW = fw.words.map(w => ({ w: clean(w.w), start: w.start }));
  let k = 0; const d = [];
  for (const w of ctc.words) { const c = clean(w.w); for (let m = k; m < Math.min(k + 6, fwW.length); m++) if (fwW[m].w === c) { d.push(w.start - fwW[m].start); k = m + 1; break; } }
  const abs = d.map(Math.abs).sort((a, b) => a - b);
  return { matched: d.length, of: ctc.words.length, medianAbsS: abs[Math.floor(abs.length / 2)], p90AbsS: abs[Math.floor(abs.length * 0.9)], meanSignedS: d.reduce((a, b) => a + b, 0) / d.length };
}
const cvf = ctcVsFw(ctcP, j(`${O}/passage/fw-large-v3-t4.json`));
const sizes = [
  ['whisper-base.en_timestamped q8 (ships today)', 'encoder_model_quantized 23.2 + decoder_model_merged_quantized 53.7', 77],
  ['whisper-small.en_timestamped q8', '92.2 + 156.8', 249],
  ['whisper-large-v3-turbo_timestamped enc fp16 / dec q4', 'encoder_model_fp16 1274.4 (one file) + decoder_model_merged_q4 334.2', 1609],
  ['whisper-large-v3-turbo_timestamped q4f16', '370.0 + 193.6', 564],
  ['whisper-large-v3-turbo_timestamped fp32', 'encoder_model.onnx + .onnx_data 2548.4 + decoder 688.1', 3236],
  ['parakeet-ctc-0.6b-ONNX q8', 'model_quantized.onnx 1.3 + .onnx_data 611.0', 612],
  ['parakeet-ctc-0.6b-ONNX q4f16 / fp16 / fp32', '454.9 / 1218.4 / 2435.9', null],
  ['sherpa-onnx parakeet-tdt-0.6b-v2 int8', 'encoder 652.2 + decoder 7.3 + joiner 1.7 (tar.bz2 482.5)', 661],
  ['onnx-community/parakeet-tdt-0.6b-v2-ONNX (fp32 only, no model_type; not loadable by transformers.js 4.3.1)', 'encoder 2477.1 + decoder 35.8', 2513],
  ['moonshine-base-ONNX q8', 'encoder_model_quantized 20.5 + decoder_model_merged_quantized 42.5', 63],
  ['cohere-transcribe-03-2026-ONNX q4f16', 'encoder 1436.9 + decoder_merged 98.1', 1535],
  ['cohere-transcribe-03-2026-ONNX q4 / q8 / fp16 / fp32', '2126.1 / 3067.1 / 4131.3 / 8352.4', null],
];
const X = { ctcVsFw: cvf,
  voskNote: `Vosk (live) on the passage: ${pct(voskP.wer)} with this scorer (S${voskP.S} D${voskP.D} I${voskP.I}, N=${voskP.N}), reproduced from the bundle's \`transcript/r1.json\`. an earlier measurement gave 40.7%; the plain normaliser (lowercase + punctuation only) reproduces that exactly (${pct(voskP.werPlain)}, N=${voskP.plainN}). The number rule folds 39 reference words into number tokens (N=234), so the same transcript scores ${pct(voskP.wer)}. OpenAI whisper-1: **not run (no key)**.`,
  narrationMethod: [
    'No human reference exists. Reference = faster-whisper `large-v3` (Systran/faster-whisper-large-v3@edaa852e, CPU int8, beam 5, language en, condition_on_previous_text=False, no VAD). A ticket correction to one sentence of the narration was checked: large-v3 already wrote exactly that, so no correction was applied. Vosk\'s "okay sir" is "Okay, so" and "kadosh" is "and could not" in large-v3 (medium.en: "in Kodawat").',
    'Sensitivity check: every row is also scored against faster-whisper `medium.en` (Systran/faster-whisper-medium.en@a29b04bd, same settings).',
    `Validation of the method on the passage (true reference known): faster-whisper large-v3 scored ${pct(R.sets.passage.rows.find(r => r.label.startsWith('fw-large-v3'))?.wer ?? NaN)} and medium.en ${pct(R.sets.passage.rows.find(r => r.label.startsWith('fw-medium.en'))?.wer ?? NaN)} against Matt's text.`,
    'Narration rows were run at 8 threads (base, small, turbo enc-fp16/dec-q4) before the thread-count request, and at 4 threads for the later rows; faster-whisper narration runs used the ctranslate2 default thread count and have no RSS reading.',
  ].join('\n\n'),
  notRun: { passage: [
    { model: 'OpenAI whisper-1', weights: '-', runtime: '-', result: 'not run (no key)' },
    ...(moonWhole ? [{ model: 'Moonshine base q8, whole 113 s file in one call (pipeline default; no chunking in `_call_moonshine`)', weights: 'dtype q8', runtime: 'transformers.js 4.3.1', result: `${pct(score(ref, moonWhole.text).wer)} — output is a run of "15000-15000-…"; superseded by the 20 s segmented row` }] : []),
    ...(cohere20 ? [{ model: 'Cohere Transcribe q4f16 without max_new_tokens', weights: 'dtype q4f16', runtime: 'transformers.js 4.3.1', result: `${pct(score(ref, cohere20.text).wer)} — the repo has no generation_config.json so generation stops at 20 tokens per 35 s chunk; superseded by the max_new_tokens=1024 row (the repo README's own setting)` }] : []),
  ] },
  sections: [
    { title: 'Parakeet in transformers.js 4.3.1', lines: [
      '- **CTC: yes.** `ParakeetForCTC` (model_type `parakeet_ctc`, `AutoModelForCTC`); the ASR pipeline sends it through `_call_wav2vec2` — text only, no timestamps. Repo: `onnx-community/parakeet-ctc-0.6b-ONNX@7df2cab7aed886b8b7f80d68a8214007e4847601`, dtype q8 = `model_quantized.onnx` (+ `.onnx_data`).',
      `- **Pipeline bug:** \`_call_wav2vec2\` argmaxes every frame and calls \`tokenizer.decode(ids)\`. Parakeet's tokenizer.json has a Metaspace decoder, not a CTC decoder, so repeated frames are never collapsed (blank = \`<pad>\` id 1024 is dropped as a special token). Result: "nararwal", "payroroll", "skyy". Pipeline row WER ${ctcPipe ? pct(ctcPipe.wer) : '-'}; the same logits with a correct greedy CTC collapse (own code, \`js/ctc.mjs\`) score ${ctcP ? pct(score(ref, ctcP.text).wer) : '-'}.`,
      '- **TDT: no.** No transducer/TDT class in 4.3.1. `onnx-community/parakeet-tdt-0.6b-v2-ONNX` exists (fp32 only, 2.5 GB, no model_type) for other runtimes. Parakeet TDT was measured with sherpa-onnx (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`, k2-fsa release `asr-models`), which returns per-token start times (`result.timestamps`); word starts = the token that begins with "▁".',
      ...(ctcP ? [
        `- **CTC frame word times (own decode, passage):** ${ctcP.frames} frames for ${ctcP.audioSeconds.toFixed(2)} s = **${(ctcP.frameS * 1000).toFixed(1)} ms per frame**; vocab ${ctcP.vocab}, blank id ${ctcP.blankUsed} (config pad_token_id ${ctcP.configBlank}). First 10 words (start-end s): ${ctcP.words.slice(0, 10).map(w => `${w.w} ${w.start}-${w.end}`).join(' · ')}`,
        ...(ctcN ? [`- Narration, first 10 words: ${ctcN.words.slice(0, 10).map(w => `${w.w} ${w.start}-${w.end}`).join(' · ')}`] : []),
        '- Plausibility: CTC peaks are one or two frames per token, so starts are good to ±1 frame (80 ms) and ends are the last emitting frame (word ends come out short; a word "ends" when its last piece fires, not when the sound stops). ' + (cvf ? `Against faster-whisper large-v3 word starts on the passage (${cvf.matched}/${cvf.of} words matched): median |difference| ${cvf.medianAbsS.toFixed(2)} s, 90th percentile ${cvf.p90AbsS.toFixed(2)} s, mean signed ${cvf.meanSignedS.toFixed(2)} s (CTC minus Whisper).` : ''),
      ] : []),
    ] },
    { title: 'ONNX sizes vs the 4 GB wasm32 memory limit', lines: [
      'Weights only (MB, from the Hugging Face tree API); the 4 GB wasm32 heap must also hold activations, the KV cache and onnxruntime arenas, so measured peak RSS (tables above) is the better guide. Anything near or above ~2.5-3 GB of weights needs Memory64 (wasm64) or WebGPU-side weights. A single ArrayBuffer is also capped at 2 GB in Chrome for files fetched whole.',
      '', '| Candidate | Files | Total MB |', '|---|---|---|',
      ...sizes.map(([a, b, c]) => `| ${a} | ${b} | ${c ?? 'see files'} |`),
    ] },
    { title: 'Lookups: public ONNX exports', lines: [
      '- **Cohere Transcribe (03-2026, 2B):** yes — https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX (transformers.js, `cohere_asr`; measured above at q4f16). Others: https://huggingface.co/csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01, https://huggingface.co/cstr/cohere-transcribe-onnx-int4, https://huggingface.co/eschmidbauer/cohere-transcribe-03-2026-onnx.',
      '- **superwhisper S1-mini:** none found. https://huggingface.co/superwhisper/s1-mini is a Qwen3-0.6B **text** normaliser for ASR output (safetensors) plus https://huggingface.co/superwhisper/s1-mini-GGUF; it is not a speech model and has no ONNX export.',
      '- **superwhisper S1:** none found (no public weights on Hugging Face; author superwhisper lists only s1-mini and s1-mini-GGUF).',
    ] },
    { title: 'Scorer and reproduction', lines: [
      '`node score.mjs <reference.txt> <hyp.txt>... [--align] [--json]` — WER = (S+D+I)/N over normalised words from a minimum-edit alignment. Normalisation, identical on both sides: lowercase; curly apostrophes -> \'; commas inside digit groups removed and "." kept only between digits; "$" dropped; every other char not in [a-z0-9\'] -> space; spelled numbers -> digits (hyphens split first; "and" inside a number is absorbed; groups that cannot combine are joined as digit strings: "twenty twenty six" -> 2026, "one twenty five" -> 125); "<N> dollars and <M> cents" and "<N> and <M> cents" -> N.MM; "dollars" after a number dropped. So "one hundred and twenty-three thousand, four hundred and fifty-six dollars and seventy-eight cents" = "$123,456.78" = token `123456.78`. Nothing else is expanded (W-2 -> "w 2" but W2 -> "w2"; "3rd" ≠ "third").',
      '',
      'Any recording (webm/m4a/wav): `to16k.sh <in> <out.wav>`; transformers.js: `js/go.sh <set> <audio> <label> <threads> <repo> <revision> <dtypeJSON> <word|none>` (env WARM_LOAD=0, SEGMENT_MAX=20 for Moonshine, MAX_NEW_TOKENS=1024 for Cohere); Parakeet CTC own decode: `js/ctc.sh <set> <audio> <threads>`; Parakeet TDT: `sherpa.sh <set> <audio> <threads>`; faster-whisper: `fw.sh <set> <audio> <model> <threads>`; then `node build.mjs && node make-extras.mjs && node render.mjs`. Batches used: `batch-passage.sh 4`, `batch-3.sh`, `batch-4.sh`. Each model run was wrapped in `suite-gate` and returned `VERDICT=RAN exit=0` (logs in `out/*.log`).',
    ] },
  ],
};
fs.writeFileSync(`${RES}/extras.json`, JSON.stringify(X, null, 1));
console.log('extras ok');
