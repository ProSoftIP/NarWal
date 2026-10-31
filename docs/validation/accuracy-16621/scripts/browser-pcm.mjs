// browser-pcm.mjs <audio> <out.f32> — the 16 kHz mono PCM Chromium's OfflineAudioContext decodes (what decodeToEnginePcm returns).
import { chromium } from '../../../../packages/offline-transcription/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [audio, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.goto('about:blank');
const b64 = readFileSync(audio).toString('base64');
const result = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const context = new OfflineAudioContext(1, 1, 16000);
  const buffer = await context.decodeAudioData(bytes.buffer);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) { const s = buffer.getChannelData(c); for (let i = 0; i < mono.length; i += 1) mono[i] += s[i] / buffer.numberOfChannels; }
  let bin = ''; const u8 = new Uint8Array(mono.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { channels: buffer.numberOfChannels, b64: btoa(bin) };
}, b64);
writeFileSync(out, Buffer.from(result.b64, 'base64'));
console.log('channels', result.channels, 'samples', Buffer.from(result.b64, 'base64').length / 4);
await browser.close();
