#!/usr/bin/env node
// The store promo tiles (board #27493, docs/release/): the 440x280 small
// promo tile and the 1400x560 marquee, drawn from narwal.svg and the listing's
// own words. Both stores take the same two sizes (the small tile is required
// by the Chrome Web Store, optional in Edge Add-ons). JPEG, because the
// Chrome Web Store refuses promo images with an alpha channel.
//
// They need no build or screenshots, unlike store-images.mjs:
//
//   playwright-libs run -- node branding/promo-tiles.mjs   (or plain node where Chromium runs)
//
// Writes ../../docs/release/images/.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../../../docs/release/images', import.meta.url));
const SVG = readFileSync(fileURLToPath(new URL('narwal.svg', import.meta.url)), 'utf8');
const svg = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

const TILES = [
  {
    name: 'promo-small-440x280',
    w: 440,
    h: 280,
    logo: 84,
    title: 34,
    text: 17,
    pad: 32,
    lines: ['Narrated walkthroughs', 'of a browser tab'],
    points: [],
  },
  {
    name: 'promo-marquee-1400x560',
    w: 1400,
    h: 560,
    logo: 260,
    title: 76,
    text: 30,
    pad: 96,
    lines: ['Narrated walkthroughs of a browser tab that an AI agent, or a colleague, can read.'],
    points: ['Your voice, the page and your marks, on one timeline', 'Transcribed on this computer', 'Nothing is uploaded to us'],
  },
];

/** One tile: the logo on the left, the name, the tagline and the points on the right. */
const tileHtml = (t) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${t.w}px;height:${t.h}px;overflow:hidden;background:#15171c;color:#f3f4f7;font-family:'Noto Sans',system-ui,sans-serif}
  body{display:flex;align-items:center;gap:${t.pad * 0.6}px;box-sizing:border-box;padding:0 ${t.pad}px;
    background:radial-gradient(circle at ${t.pad + t.logo / 2}px 50%,rgba(201,7,35,.28),rgba(201,7,35,0) ${t.logo * 1.3}px),#15171c}
  img{width:${t.logo}px;height:${t.logo}px;flex:none}
  h1{margin:0;font-size:${t.title}px;line-height:1.05;font-weight:800;letter-spacing:-.01em}
  p{margin:${t.text * 0.5}px 0 0;font-size:${t.text}px;line-height:1.3;color:#c9cdd6;max-width:${t.w - t.logo - t.pad * 2.6}px}
  ul{margin:${t.text}px 0 0;padding:0;list-style:none;font-size:${t.text * 0.8}px;color:#e9ebf0}
  li{margin:${t.text * 0.3}px 0}
  li::before{content:'';display:inline-block;width:${t.text * 0.32}px;height:${t.text * 0.32}px;border-radius:50%;background:#ff6b5e;margin-right:${t.text * 0.45}px;vertical-align:middle}
</style><img src="${svg}" alt=""><div><h1>NarWal</h1><p>${t.lines.join('<br>')}</p>${t.points.length ? `<ul>${t.points.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</div>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage();
  for (const tile of TILES) {
    await page.setViewportSize({ width: tile.w, height: tile.h });
    await page.setContent(tileHtml(tile), { waitUntil: 'load' });
    await page.screenshot({ path: join(OUT, `${tile.name}.jpg`), type: 'jpeg', quality: 92 });
    console.log(join(OUT, `${tile.name}.jpg`));
  }
} finally {
  await browser.close();
}
