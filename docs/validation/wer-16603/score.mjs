#!/usr/bin/env node
// Word error rate scorer for board #16603.
// Usage: node score.mjs <reference.txt> <hyp.txt> [<hyp.txt>...] [--json] [--align]
// Normalisation (applied identically to reference and hypothesis):
//  1. Lowercase; curly apostrophes (’ ‘) become '.
//  2. Digit groups: commas between digits are removed ("123,456" -> "123456");
//     a "." between two digits is kept ("123456.78"); "$" is dropped.
//  3. Every char not in [a-z0-9'.] becomes a space; a "." not between digits becomes a space.
//  4. Spelled numbers become digits. Number words: zero..nineteen, twenty..ninety, hundred,
//     thousand, million, billion; hyphens were already split in step 3. "and" between a
//     hundred/thousand and a following number word is part of the number. Words combine
//     arithmetically ("two hundred and ten thousand one hundred and five" -> 210105).
//     Adjacent number groups that cannot combine are joined as digit strings, the way years
//     and codes are read ("twenty twenty six" -> 2026, "one twenty five" -> 125).
//  5. Amounts: "<N> dollars and <M> cents" and "<N> and <M> cents" -> "N.MM"; "<N> dollars" -> "N" (the word
//     "dollars" after a number is dropped). So "$123,456.78" and "one hundred and
//     twenty-three thousand, four hundred and fifty-six dollars and seventy-eight cents" both -> "123456.78".
//  6. Split on whitespace. Nothing else is expanded (no contractions, no spelling variants).
// WER = (S + D + I) / N, N = reference token count, from a minimum-edit word alignment.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
const kind = w => w in UNITS ? 'unit' : w in TEENS ? 'teen' : w in TENS ? 'tens' : w === 'hundred' ? 'hundred' : w in SCALES ? 'scale' : null;
const val = w => UNITS[w] ?? TEENS[w] ?? TENS[w];

// Parse a maximal run of number words (and joining "and") into digit strings.
function spellToDigits(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (!kind(words[i])) { out.push(words[i]); i++; continue; }
    const groups = []; // digit strings of adjacent groups that did not combine
    let total = 0, cur = 0, last = null, lastScale = Infinity, started = false;
    const flush = () => { if (started) groups.push(String(total + cur)); total = 0; cur = 0; last = null; lastScale = Infinity; started = false; };
    while (i < words.length) {
      const w = words[i], k = kind(w);
      if (w === 'and' && (last === 'hundred' || last === 'scale') && ['unit', 'teen', 'tens'].includes(kind(words[i + 1]))) { i++; continue; }
      if (!k) break;
      let ok;
      if (k === 'unit') ok = last === null || last === 'tens' || last === 'hundred' || last === 'scale';
      else if (k === 'teen' || k === 'tens') ok = last === null || last === 'hundred' || last === 'scale';
      else if (k === 'hundred') ok = (last === 'unit' || last === 'teen') && cur < 100 ;
      else ok = (last !== null && last !== 'scale') && SCALES[w] < lastScale;
      if (!ok) { flush(); continue; } // start a new group with the same word
      if (k === 'unit' || k === 'teen' || k === 'tens') cur += val(w);
      else if (k === 'hundred') cur *= 100;
      else { total += cur * SCALES[w]; cur = 0; lastScale = SCALES[w]; }
      last = k; started = true; i++;
    }
    flush();
    out.push(groups.join(''));
  }
  return out;
}

export function normalize(text) {
  let s = text.toLowerCase().replace(/[’‘]/g, "'");
  s = s.replace(/(\d),(?=\d)/g, '$1').replace(/\$/g, ' ');
  s = s.replace(/[^a-z0-9'.]/g, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ');
  let w = s.split(/\s+/).filter(Boolean);
  w = spellToDigits(w);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const isNum = x => /^\d+(\.\d+)?$/.test(x ?? '');
    if (isNum(w[i]) && w[i + 1] === 'dollars' && w[i + 2] === 'and' && /^\d{1,2}$/.test(w[i + 3] ?? '') && w[i + 4] === 'cents') {
      out.push(`${w[i]}.${w[i + 3].padStart(2, '0')}`); i += 4; continue;
    }
    if (isNum(w[i]) && !w[i].includes('.') && w[i + 1] === 'and' && /^\d{1,2}$/.test(w[i + 2] ?? '') && w[i + 3] === 'cents') {
      out.push(`${w[i]}.${w[i + 2].padStart(2, '0')}`); i += 3; continue;
    }
    if (w[i] === 'dollars' && isNum(out[out.length - 1])) continue;
    out.push(w[i]);
  }
  return out;
}

export function align(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Int32Array(m + 1); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    d[i][j] = Math.min(d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
  let i = n, j = m, S = 0, D = 0, I = 0; const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) { S++; ops.push(['S', ref[i - 1], hyp[j - 1]]); } else ops.push(['=', ref[i - 1], hyp[j - 1]]);
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { D++; ops.push(['D', ref[i - 1], null]); i--; }
    else { I++; ops.push(['I', null, hyp[j - 1]]); j--; }
  }
  ops.reverse();
  return { N: n, S, D, I, wer: n ? (S + D + I) / n : 0, ops };
}

export function score(refText, hypText) { return align(normalize(refText), normalize(hypText)); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), json = args.includes('--json'), showAlign = args.includes('--align');
  const files = args.filter(a => !a.startsWith('--'));
  if (files.length < 2) { console.error('usage: node score.mjs <reference.txt> <hyp.txt>... [--json] [--align]'); process.exit(2); }
  const ref = fs.readFileSync(files[0], 'utf8');
  const rows = files.slice(1).map(f => { const r = score(ref, fs.readFileSync(f, 'utf8')); return { file: f, ...r, ops: showAlign || json ? r.ops.filter(o => o[0] !== '=') : undefined }; });
  if (json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) {
    console.log(`${(r.wer * 100).toFixed(1).padStart(5)}%  N=${r.N} S=${r.S} D=${r.D} I=${r.I}  ${r.file}`);
    if (showAlign) for (const o of r.ops) console.log(`    ${o[0]} ${o[1] ?? '-'} -> ${o[2] ?? '-'}`);
  }
}
