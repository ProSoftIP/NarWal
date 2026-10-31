// render.mjs — RESULT.md from result.json plus extras.json (sizes, lookups, CTC alignment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Paths: everything is relative to this directory unless an env var overrides it (see README.md).
const W = path.dirname(fileURLToPath(import.meta.url));
const RES = process.env.WER_RESULT_DIR || W;
const R = JSON.parse(fs.readFileSync(`${RES}/result.json`, 'utf8'));
const X = JSON.parse(fs.readFileSync(`${RES}/extras.json`, 'utf8'));
const pct = x => x == null ? '-' : (x * 100).toFixed(1) + '%';
const f1 = x => x == null ? '-' : x.toFixed(1);
const f2 = x => x == null ? '-' : x.toFixed(2);
const ts = v => v === true ? 'yes (word)' : v === false ? 'no' : String(v);
const name = r => r.label.replace(/-t\d+$/, '');
const L = [];
L.push(`# Board #16603 — speech-recognition accuracy (WER) on Matt's recordings`, '');
L.push(`Generated ${R.generated}. All runs on one Linux desktop CPU (i7-12700, 12 cores / 20 threads), one at a time under \`suite-gate\`, peak RSS from \`/usr/bin/time -v\`. Nothing was sent to OpenAI or any other service; only model weights were downloaded (huggingface.co, github.com k2-fsa release).`, '');
L.push(`Columns: **RTF** = transcribe seconds ÷ audio seconds (model already loaded; 0.10 = 6 s per audio minute; also = minutes of compute per audio minute). **Load** = load from local disk cache. **Peak RSS** = whole process maximum (**†** = that run loaded the model twice — a first load that filled the cache, dispose, then the timed load — so its RSS may include part of the first copy; unmarked runs loaded once). **WER plain** = same alignment with only lowercase + punctuation removal (no number rule), for comparison with the earlier figure. Threads = onnxruntime \`intraOpNumThreads\` (sherpa \`num_threads\`, ctranslate2 \`cpu_threads\`).`, '');
L.push(`**Caveat:** these are native onnxruntime-node / sherpa-onnx CPU numbers. The browser's onnxruntime-web WASM is slower per thread (no native kernels; int8 and fp16 paths are weaker), so a 1-thread native RTF is a lower bound for 1-thread WASM. The machine was shared with other lanes; \`/proc/loadavg\` at each run start is in result.json.`, '');

function table(set, extraCols) {
  const rows = R.sets[set].rows;
  const groups = new Map();
  for (const r of rows) { const k = name(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const threadsSeen = [...new Set(rows.filter(r => typeof r.threads === 'number').map(r => r.threads))].sort((a, b) => b - a);
  const head = ['Model', 'Weights / dtype', 'Runtime', 'Word timestamps', 'WER', 'S/D/I (N)', 'WER plain', ...(extraCols ? ['WER vs medium.en'] : []), ...threadsSeen.flatMap(t => [`RTF ${t}T`, `Peak RSS ${t}T`]), 'Load s'];
  L.push('| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|');
  const order = [...groups.entries()].sort((a, b) => a[1][0].wer - b[1][0].wer);
  for (const [k, g] of order) {
    const r = g[0];
    const byT = Object.fromEntries(g.map(x => [x.threads, x]));
    const cells = [r.kind === 'vosk' ? r.model : `${r.model}${r.revision ? ` @${String(r.revision).slice(0, 60)}` : ''}`, r.weights ?? '-', r.runtime, ts(r.wordTimestamps), `**${pct(r.wer)}**`, `${r.S}/${r.D}/${r.I} (${r.N})`, pct(r.werPlain),
      ...(extraCols ? [pct(r.werVsMediumEn)] : []),
      ...threadsSeen.flatMap(t => [byT[t] ? f2(byT[t].rtf) + ` (${f1(byT[t].transcribeS)} s)` : '-', byT[t]?.rssMB ? byT[t].rssMB + (byT[t].warmLoad ? ' MB†' : ' MB') : '-']),
      g.map(x => x.loadS != null ? `${f1(x.loadS)}${typeof x.threads === 'number' ? `@${x.threads}T` : ''}` : '-').join(', ')];
    L.push('| ' + cells.map(c => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |');
    if (g.some(x => x.wer !== r.wer)) L.push(`| ↳ WER by thread count: ${g.map(x => `${x.threads}T ${pct(x.wer)}`).join(', ')} |`);
  }
  for (const extra of (X.notRun?.[set] ?? [])) L.push(`| ${extra.model} | ${extra.weights} | ${extra.runtime} | - | ${extra.result} | - |`);
  return order;
}
function texts(set, order) {
  L.push('', `### Full hypothesis text, verbatim (${set})`, '');
  for (const [k, g] of order) for (const r of g.slice(0, 1)) {
    const variants = g.filter(x => x.text !== r.text);
    L.push(`**${k}** (${pct(r.wer)})`, '', '> ' + r.text, '');
    for (const v of variants) L.push(`*${v.label} text differs:*`, '', '> ' + v.text, '');
  }
}

L.push(`## 1. Reading passage (primary test set)`, '');
L.push(`Audio: \`passage-v1-narration.webm\` (identical bytes to \`audio/narration.webm\` in passage-v1-rec_744021f6.narwal.zip), ${f1(R.sets.passage.rows.find(r => r.audioSeconds)?.audioSeconds)} s. Reference: \`reading-passage-v1.txt\` exactly as written, no hand edits (${R.sets.passage.refNormalized.length} tokens after normalisation; amounts become digits, e.g. \`123456.78\`).`, '');
const po = table('passage', false);
L.push('', X.voskNote, '');
texts('passage', po);
L.push(`### Reference (passage)`, '', '> ' + R.sets.passage.references.reference.trim().replace(/\n+/g, ' '), '');

if (R.sets.narration) {
  L.push(`## 2. Narration rec_2465dd53 (45.6 s, no human reference)`, '');
  L.push(X.narrationMethod, '');
  L.push(`Uncertain words (large-v3 vs medium.en disagree; ${R.sets.narration.uncertain.length} edits): ` + R.sets.narration.uncertain.map(u => `\`${u.largeV3 ?? '∅'}\`/\`${u.mediumEn ?? '∅'}\``).join(', '), '');
  const no = table('narration', true);
  texts('narration', no);
  L.push(`### Reference (narration) = faster-whisper large-v3 output`, '', '> ' + R.sets.narration.references.reference, '');
  L.push(`### medium.en text (sensitivity check)`, '', '> ' + R.sets.narration.references.mediumEn, '');
}
for (const s of X.sections) L.push(`## ${s.title}`, '', ...s.lines, '');
fs.writeFileSync(`${RES}/RESULT.md`, L.join('\n') + '\n');
console.log('wrote RESULT.md', L.length, 'lines');
