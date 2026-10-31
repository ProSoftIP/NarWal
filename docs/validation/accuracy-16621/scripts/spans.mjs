// spans.mjs <pcm.f32> <out.json> [vad json overrides] — the final pass's VAD plan over 16 kHz f32 PCM.
import { readFileSync, writeFileSync } from 'node:fs';
import { planSpeech, pcmSource } from '../../../../packages/offline-transcription/src/vad.ts';
const [f, out, opts] = process.argv.slice(2);
const b = readFileSync(f);
const pcm = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
const plan = await planSpeech(pcmSource(pcm), opts ? JSON.parse(opts) : {});
writeFileSync(out, JSON.stringify(plan));
console.log(plan.length, 'spans', plan.map((s) => ((s.endSample - s.startSample) / 16000).toFixed(2)).join(' '));
