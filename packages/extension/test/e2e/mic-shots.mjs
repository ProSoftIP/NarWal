// Screenshots of the microphone picker and test bar (board #16785): the popup
// and the Options page, light and dark, with the meter hearing the fake
// microphone and with a silent one. Needs `node build.mjs --test` first.
// Usage: node test/e2e/mic-shots.mjs   ->  test/e2e/results/mic-shots/*.png
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './server.mjs';

const APP = fileURLToPath(new URL('../../app', import.meta.url));
const OUT = fileURLToPath(new URL('./results/mic-shots/', import.meta.url));

async function silentWav(dir) {
  const rate = 48000;
  const bytes = rate * 30 * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  const path = join(dir, 'silence.wav');
  await writeFile(path, wav);
  return path;
}

async function launch(dir, args) {
  const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${APP}`, `--load-extension=${APP}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...args],
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  return { context, sw, url: (path) => `chrome-extension://${id}/${path}` };
}

// The meter is caught while it hears sound (the fake microphone beeps), or
// once the silent one has said "No sound from …".
async function testUntil(page, root, mode) {
  await page.click(`${root} [data-key="mic-test"]`);
  await page.waitForFunction(
    ([sel, want]) => {
      const el = document.querySelector(sel);
      return want === 'active' ? el.querySelector('.nw-meter').dataset.heard === 'true' : /^No sound from /.test(el.querySelector('.nw-mic-status').textContent);
    },
    [root, mode],
    { timeout: 10000, polling: 50 },
  );
}

async function shots(mode, fx, dir) {
  const b = await launch(dir, mode === 'silent' ? [`--use-file-for-fake-audio-capture=${await silentWav(dir)}`] : []);
  try {
    // Allow the microphone once, as a person would on the Options page.
    const options = await b.context.newPage();
    await options.setViewportSize({ width: 760, height: 360 });
    await options.goto(b.url('options.html'));
    await options.waitForFunction(() => globalThis.narwalOptions && globalThis.narwalOptions.microphone);
    await options.evaluate(() => globalThis.narwalOptions.microphone.loaded);
    if (await options.$('.nw-mic-problem:not([hidden]) [data-key="mic-fix"]')) await options.click('.nw-mic-problem [data-key="mic-fix"]');
    await options.waitForSelector('.nw-mic[data-access="granted"]');
    const page = await b.context.newPage();
    await page.goto(`${fx.A}/index.html`);
    const tabId = await b.sw.evaluate((u) => chrome.tabs.query({}).then((t) => t.find((x) => x.url === u).id), page.url());
    const popup = await b.context.newPage();
    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.goto(b.url(`popup.html?tab=${tabId}`));
    await popup.waitForFunction(() => globalThis.narwalPopup && globalThis.narwalPopup.view.microphone);
    await popup.evaluate(() => globalThis.narwalPopup.view.microphone.loaded);
    for (const scheme of ['light', 'dark']) {
      await options.emulateMedia({ colorScheme: scheme });
      await options.bringToFront();
      await testUntil(options, '.nw-options .nw-mic', mode);
      await options.screenshot({ path: `${OUT}options-${scheme}-${mode}.png` });
      await options.click('.nw-options [data-key="mic-test"]');
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.bringToFront();
      await testUntil(popup, '.nw-mic-compact', mode);
      await popup.screenshot({ path: `${OUT}popup-${scheme}-${mode}.png`, clip: { x: 0, y: 0, width: 400, height: 260 } });
      await popup.click('.nw-mic-compact [data-key="mic-test"]');
    }
  } finally {
    await b.context.close();
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const fx = await startFixtures();
try {
  for (const mode of ['active', 'silent']) {
    const dir = await mkdtemp(join(tmpdir(), 'narwal-mic-shots-'));
    try {
      await shots(mode, fx, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await fx.close();
}
console.log(`wrote ${OUT}`);
