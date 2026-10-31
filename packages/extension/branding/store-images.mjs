#!/usr/bin/env node
// The store listing images (board #16955, docs/release/): five 1280x800
// screenshots with a caption each, the 128 px store icon and Edge's 300 px
// logo, drawn from narwal.svg.
//
// The screenshots are cut from shots.mjs captures of the current build, so
// they show the real pages; the crops leave out the parts of a test run that
// only exist because the fake microphone says nothing and no speech model is
// downloaded. JPEG, because the Chrome Web Store refuses a PNG screenshot
// with an alpha channel.
//
// Capture at 2x (shots.mjs does when DOCS_DIR is set), so a crop can be
// enlarged and stay sharp:
//
//   npm run build:test
//   DOCS_DIR=/tmp/narwal-docs playwright-libs run -- node test/e2e/shots.mjs /tmp/narwal-shots
//   playwright-libs run -- node branding/store-images.mjs /tmp/narwal-shots
//   npm run release        (rebuilds app/ with no test hooks)
//
// Writes ../../docs/release/images/.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = process.argv[2];
if (!SHOTS) throw new Error('usage: node branding/store-images.mjs <shots.mjs output dir>');
const OUT = fileURLToPath(new URL('../../../docs/release/images', import.meta.url));
const SVG = readFileSync(fileURLToPath(new URL('narwal.svg', import.meta.url)), 'utf8');

const png = (name) => `data:image/png;base64,${readFileSync(join(SHOTS, name)).toString('base64')}`;
/** The width in pixels from a PNG's IHDR. */
const pngWidth = (name) => readFileSync(join(SHOTS, name)).readUInt32BE(16);
// The popup page is 400 CSS px wide, so its capture gives the pixel ratio.
const DPR = pngWidth('popup-light.png') / 400;
const svg = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

/** One crop of a capture: the source file and its box in CSS pixels. */
const crop = (file, x, y, w, h) => ({ file, x, y, w, h });

// Each slide is rows of crops; the crops in a row sit side by side.
const SLIDES = [
  {
    name: 'store-1-replay',
    title: 'Replay the page with your voice',
    text: 'Every click, route and mark plays back in step with the transcript.',
    rows: [[crop('replay-light-1440.png', 40, 58, 1360, 56)], [crop('replay-light-1440.png', 40, 148, 1360, 614)]],
  },
  {
    name: 'store-2-mark',
    title: 'Point at what you mean',
    text: 'Right-click a part of the page while you talk; the mark is saved with that moment.',
    rows: [
      [crop('recordings-light-1024.png', 20, 54, 984, 92)],
      [crop('recordings-light-1024.png', 20, 154, 612, 508), crop('recordings-light-1024.png', 640, 282, 364, 262)],
    ],
  },
  {
    name: 'store-3-saved',
    title: 'Every recording stays in your browser',
    text: 'Your voice, the pages and the transcript, saved together. Search them, replay one, or export one file to share.',
    rows: [
      [crop('recordings-light-1024.png', 20, 54, 984, 92)],
      [crop('recordings-light-1024.png', 20, 670, 488, 132), crop('recordings-light-1024.png', 516, 670, 488, 132)],
      [crop('recordings-light-1024.png', 20, 810, 984, 168)],
    ],
  },
  {
    name: 'store-4-model',
    title: 'Transcribe on this computer',
    text: 'Pick a measured speech model. After one download it works with no internet.',
    rows: [[crop('model-light-1440.png', 120, 58, 1200, 796)]],
  },
  {
    name: 'store-5-choice',
    title: 'You choose where your voice goes',
    text: 'On this computer, or OpenAI with your own key. What you do on the page stays here.',
    rows: [[crop('popup-light.png', 0, 0, 400, 50)], [crop('popup-light.png', 0, 466, 400, 666)]],
  },
];

const W = 1280;
const H = 800;
const PAD = 56;
const HEAD = 150;
const GAP = 12;

/** The rows of one slide stacked, scaled to fit under the caption. */
function slideHtml(slide) {
  const rowW = (row) => row.reduce((sum, c) => sum + c.w, 0) + GAP * (row.length - 1);
  const rowH = (row) => Math.max(...row.map((c) => c.h));
  const natW = Math.max(...slide.rows.map(rowW));
  const natH = slide.rows.reduce((sum, row) => sum + rowH(row), 0) + GAP * (slide.rows.length - 1);
  // Enlarge a small crop no further than the capture's pixels allow.
  const scale = Math.min((W - 2 * PAD) / natW, (H - HEAD - PAD / 2) / natH, DPR * 0.8);
  const tile = (c) =>
    `<div class="tile" style="width:${c.w * scale}px;height:${c.h * scale}px"><img src="${png(c.file)}" style="width:${(pngWidth(c.file) / DPR) * scale}px;left:${-c.x * scale}px;top:${-c.y * scale}px"></div>`;
  const rows = slide.rows.map((row) => `<div class="row">${row.map(tile).join('')}</div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#eceef2;font-family:'Noto Sans',system-ui,sans-serif;color:#1c1f26}
    body{display:flex;flex-direction:column}
    header{height:${HEAD}px;flex:none;box-sizing:border-box;padding:40px ${PAD}px 0;display:flex;gap:20px;align-items:flex-start}
    header img{width:52px;height:52px}
    h1{margin:0;font-size:36px;line-height:1.15;font-weight:700}
    p{margin:8px 0 0;font-size:21px;color:#4a5161}
    main{flex:1;padding-bottom:${PAD / 2}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${GAP}px}
    .row{display:flex;gap:${GAP}px;align-items:flex-start}
    .tile{position:relative;overflow:hidden;border-radius:10px;box-shadow:0 8px 28px rgba(20,24,34,.16),0 0 0 1px rgba(20,24,34,.08);background:#fff}
    .tile img{position:absolute}
  </style><header><img src="${svg}" alt=""><div><h1>${slide.title}</h1><p>${slide.text}</p></div></header><main>${rows}</main>`;
}

/** narwal.svg centred on a transparent square: `art` px of drawing in a `size` px image. */
const iconHtml = (size, art) =>
  `<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent;display:grid;place-items:center}img{width:${art}px;height:${art}px}</style><img src="${svg}" alt="">`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const slide of SLIDES) {
    await page.setContent(slideHtml(slide), { waitUntil: 'load' });
    await page.screenshot({ path: join(OUT, `${slide.name}.jpg`), type: 'jpeg', quality: 92 });
    console.log(join(OUT, `${slide.name}.jpg`));
  }
  // Chrome Web Store: 128x128, 96x96 of art and 16 px of transparent padding.
  // Edge Add-ons: a 1:1 logo, 300x300.
  for (const [name, size, art] of [
    ['store-icon-128.png', 128, 96],
    ['edge-logo-300.png', 300, 252],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconHtml(size, art), { waitUntil: 'load' });
    await page.screenshot({ path: join(OUT, name), omitBackground: true });
    console.log(join(OUT, name));
  }
} finally {
  await browser.close();
}
