// build.mjs — collect out/<set>/*.json + .time, score, write result.json and hyp/*.txt.
import fs from 'node:fs';
import { score, normalize, align } from './score.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Paths: everything is relative to this directory unless an env var overrides it (see README.md).
const W = path.dirname(fileURLToPath(import.meta.url));
const O = process.env.WER_OUT_DIR || `${W}/out`;
const RES = process.env.WER_RESULT_DIR || W;
const REF = process.env.WER_REFERENCE || `${W}/reading-passage-v1.txt`;
const plain = t => t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
const rssMB = f => { try { const m = fs.readFileSync(f, 'utf8').match(/Maximum resident set size \(kbytes\): (\d+)/); return m ? Math.round(+m[1] / 1024) : null; } catch { return null; } };
const elapsed = f => { try { const m = fs.readFileSync(f, 'utf8').match(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)/); return m ? m[1].split(':').reduce((a, x) => a * 60 + +x, 0) : null; } catch { return null; } };
const load = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const vosk = p => JSON.parse(fs.readFileSync(p, 'utf8')).segments.map(s => s.text).join(' ').trim();

function describe(dir, file, d) {
  const base = `${dir}/${file.replace(/\.json$/, '')}`;
  if (file.startsWith('js-')) return { kind: 'js', model: d.modelId, revision: d.revision, weights: typeof d.dtype === 'string' ? `dtype ${d.dtype}` : `dtype ${JSON.stringify(d.dtype)}`, runtime: d.runtime, threads: d.threads, wordTimestamps: d.wordTimestamps, loadS: d.loadS, transcribeS: d.transcribeS, audioSeconds: d.audioSeconds, text: d.text, warmLoad: d.warmLoad ?? (d.firstLoadS != null), rssMB: rssMB(`${base}.time`), processS: elapsed(`${base}.time`), loadavg: load(`${base}.loadavg`) };
  if (file.startsWith('py-')) return { kind: 'sherpa', model: d.modelId, revision: 'sherpa-onnx release tag asr-models', weights: d.dtype, runtime: d.runtime, threads: d.threads, wordTimestamps: d.tokenTimestamps ? 'token start times (yes)' : false, loadS: d.loadS, transcribeS: d.transcribeS, audioSeconds: d.audioSeconds, text: d.text, rssMB: rssMB(`${base}.time`), processS: elapsed(`${base}.time`), loadavg: load(`${base}.loadavg`) };
  if (file.startsWith('fw-')) return { kind: 'fw', model: `faster-whisper ${d.model} (Systran)`, revision: d.model === 'large-v3' ? 'Systran/faster-whisper-large-v3@edaa852ec7e145841d8ffdb056a99866b5f0a478' : d.model === 'medium.en' ? 'Systran/faster-whisper-medium.en@a29b04bd15381511a9af671baec01072039215e3' : '', weights: 'ctranslate2 int8, beam 5, no VAD, condition_on_previous_text=False', runtime: d.runtime, threads: d.threads ?? 'ctranslate2 default', wordTimestamps: true, loadS: d.load_s, transcribeS: d.transcribe_s, audioSeconds: d.audioSeconds ?? 45.6, text: d.text, rssMB: rssMB(`${base}.time`), processS: elapsed(`${base}.time`), loadavg: load(`${base}.loadavg`) };
}

const sets = {};
for (const set of ['passage', 'narration']) {
  const dir = `${O}/${set}`; if (!fs.existsSync(dir)) continue;
  fs.mkdirSync(`${dir}/hyp`, { recursive: true });
  const refs = set === 'passage'
    ? { reference: fs.readFileSync(REF, 'utf8') }
    : { reference: JSON.parse(fs.readFileSync(`${dir}/fw-large-v3.json`, 'utf8')).text, mediumEn: JSON.parse(fs.readFileSync(`${dir}/fw-medium.en.json`, 'utf8')).text };
  for (const [k, v] of Object.entries(refs)) fs.writeFileSync(`${dir}/${k}.txt`, v + '\n');
  const rows = [];
  const voskText = vosk(set === 'passage' ? (process.env.WER_VOSK_PASSAGE || `${W}/inputs/vosk-passage-r1.json`) : (process.env.WER_VOSK_NARRATION || `${W}/inputs/vosk-narration-r1.json`));
  rows.push({ label: 'vosk-live', kind: 'vosk', model: 'Vosk small en-us 0.15 (live, in the extension)', weights: 'vosk-model-small-en-us-0.15', runtime: 'browser-local vosk (not re-run; bundle transcript/r1.json)', threads: 'n/a', wordTimestamps: 'yes (live)', text: voskText });
  for (const f of fs.readdirSync(dir).filter(f => /^(js|py|fw)-.*\.json$/.test(f)).sort()) {
    const d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    rows.push({ label: f.replace(/\.json$/, ''), ...describe(dir, f, d) });
  }
  for (const r of rows) {
    fs.writeFileSync(`${dir}/hyp/${r.label}.txt`, r.text + '\n');
    const s = score(refs.reference, r.text);
    const pl = align(plain(refs.reference), plain(r.text)); r.werPlain = pl.wer; r.plainN = pl.N;
    r.wer = s.wer; r.S = s.S; r.D = s.D; r.I = s.I; r.N = s.N;
    r.errors = s.ops.filter(o => o[0] !== '=').map(o => `${o[0]} ${o[1] ?? '-'}→${o[2] ?? '-'}`);
    if (refs.mediumEn) { const m = score(refs.mediumEn, r.text); r.werVsMediumEn = m.wer; r.mediumEnCounts = { N: m.N, S: m.S, D: m.D, I: m.I }; }
    if (r.transcribeS != null) { r.rtf = r.transcribeS / r.audioSeconds; r.minPerAudioMin = r.rtf; }
  }
  sets[set] = { references: refs, refNormalized: normalize(refs.reference), rows };
}
// uncertain words in the narration reference: large-v3 vs medium.en alignment
if (sets.narration) { const a = score(sets.narration.references.reference, sets.narration.references.mediumEn); sets.narration.uncertain = a.ops.filter(o => o[0] !== '=').map(o => ({ op: o[0], largeV3: o[1], mediumEn: o[2] })); }
fs.mkdirSync(RES, { recursive: true });
fs.writeFileSync(`${RES}/result.json`, JSON.stringify({ ticket: 16603, generated: new Date().toISOString(), sets }, null, 1));
for (const [set, v] of Object.entries(sets)) { console.log(`== ${set}`); for (const r of v.rows) console.log(`${(r.wer * 100).toFixed(1).padStart(5)}%  S${r.S} D${r.D} I${r.I}  t=${r.threads} rtf=${r.rtf?.toFixed(3) ?? '-'} rss=${r.rssMB ?? '-'}MB  ${r.label}`); }
