// Screenshots of the four pages in the Tiles B language (board #16783): Saved
// recordings, the popup and the in-page strip, the speech model page and
// Replay, light and dark, 1440 and 1024 wide. Records a short session on the
// local demo page (test/e2e/site/dashboard.html) with the fake microphone,
// marks a card, then opens each page. The fake microphone plays a tone, so
// the script saves a stand-in live transcript for the recording; everything
// else is what the recorder saved.
// With DOCS_DIR set it also writes the README's saved-recordings-light.png
// there at 2x, 1180 wide.
// Usage: npm run build:test && [DOCS_DIR=../../docs/images] node test/e2e/shots.mjs [out-dir]
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './server.mjs';

const APP = fileURLToPath(new URL('../../app', import.meta.url));
const OUT = process.argv[2] || join(tmpdir(), 'narwal-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHEMES = ['light', 'dark'];
const WIDTHS = [1440, 1024];
const DOCS = process.env.DOCS_DIR;
const DOCS_W = 1180;

const SAID = [
  [600, 'This is the quarterly dashboard we changed yesterday.'],
  [3200, 'On orders the numbers look right.'],
  [5200, 'This revenue card should match the orders total, and it does not.'],
  [8600, 'Customers is still slow to load.'],
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const fx = await startFixtures();
  const dir = await mkdtemp(join(tmpdir(), 'narwal-shots-profile-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${APP}`, `--load-extension=${APP}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: DOCS ? 2 : 1,
  });
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host;
    const url = (path) => `chrome-extension://${id}/${path}`;
    const shot = async (page, name, { full = true } = {}) => {
      await sleep(400);
      await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
      console.log(join(OUT, `${name}.png`));
    };
    const docShot = async (page, name, options = {}) => {
      if (!DOCS) return;
      await sleep(400);
      await page.screenshot({ path: join(DOCS, `${name}.png`), ...options });
      console.log(join(DOCS, `${name}.png`));
    };

    // The popup before Start, as its own 400 px page.
    const popup = await context.newPage();
    for (const scheme of SCHEMES) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.setViewportSize({ width: 400, height: 640 });
      await popup.goto(url('popup.html'));
      await popup.locator('#root button').first().waitFor();
      await shot(popup, `popup-${scheme}`);
    }
    await popup.close();

    // A short recording on the demo page: two routes, a marked card, an area.
    const page = await context.newPage();
    await page.goto(`${fx.A}/dashboard.html#/overview`);
    await page.bringToFront();
    const tabId = await sw.evaluate((u) => chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === u).id), page.url());
    const started = await sw.evaluate((t) => globalThis.narwal.start(t), tabId);
    if (!started || !started.ok) throw new Error(`start failed: ${JSON.stringify(started)}`);
    await sleep(2500);
    await page.click('#to-orders');
    await sleep(2200);
    const box = await page.locator('#revenue').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await sleep(1500);
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 760 });
        await shot(page, `strip-${scheme}-${width}`, { full: false });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#to-customers');
    await sleep(2500);
    await sw.evaluate(() => globalThis.narwal.stop());
    await sleep(1500);

    const viewer = await context.newPage();
    await viewer.goto(url('recordings.html'));
    const recId = await viewer.evaluate(() => globalThis.narwalViewer.list().then((l) => l[0].id));
    // The stand-in live transcript (the fake microphone says nothing).
    await viewer.evaluate(
      ([rid, said]) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('narwal');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const segments = said.map(([startMs, text], i) => ({ id: `s${i + 1}`, startMs, endMs: startMs + 2000, text, words: [] }));
            const history = {
              recordingId: rid,
              version: 1,
              revisions: [{ revisionId: 'r1', source: 'live', provider: 'browser-local', model: 'stand-in', language: 'en', createdAt: new Date().toISOString(), segments, gaps: [] }],
              activeRevision: 'r1',
              edits: [],
              pending: null,
              usedConsents: [],
            };
            const tx = open.result.transaction('chunks', 'readwrite');
            tx.objectStore('chunks').put({ recordingId: rid, stream: 'history', seq: 0, history });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
      [recId, SAID],
    );
    await viewer.evaluate((rid) => globalThis.narwalViewer.savePurpose(rid, 'Review of yesterday’s dashboard changes; each thing I point at is a change request.'), recId);
    // Export once: the recording gets its library copy, which Replay opens.
    const exported = await viewer.evaluate((rid) => globalThis.narwalViewer.exportRecording(rid).then((r) => ({ ok: true, file: r.fileName }), (err) => ({ ok: false, error: String(err && err.message) })), recId);
    if (!exported.ok) throw new Error(`export failed: ${exported.error}`);

    for (const scheme of SCHEMES) {
      await viewer.emulateMedia({ colorScheme: scheme });
      for (const width of WIDTHS) {
        await viewer.setViewportSize({ width, height: 900 });
        await viewer.goto(url('recordings.html'));
        await viewer.locator('#detail:not([hidden])').waitFor();
        await viewer.locator('#replay iframe').waitFor();
        await sleep(1200);
        await shot(viewer, `recordings-${scheme}-${width}`);
      }
    }

    await viewer.emulateMedia({ colorScheme: 'light' });
    await viewer.setViewportSize({ width: DOCS_W, height: 900 });
    await viewer.goto(url('recordings.html'));
    await viewer.locator('#replay iframe').waitFor();
    await sleep(1200);
    await docShot(viewer, 'saved-recordings-light', { fullPage: true });

    const replayHref = await viewer.locator('#detail-acts a').getAttribute('href');
    for (const scheme of SCHEMES) {
      await viewer.emulateMedia({ colorScheme: scheme });
      for (const width of WIDTHS) {
        await viewer.setViewportSize({ width, height: 900 });
        await viewer.goto(url(replayHref));
        await viewer.locator('#player:not([hidden])').waitFor();
        // At the mark, so the frame shows the marked card.
        await viewer.evaluate(() => globalThis.__narwalReplay.player.seek(4300));
        await sleep(1500);
        await shot(viewer, `replay-${scheme}-${width}`);
        await viewer.goto(url('model.html'));
        await viewer.locator('.model').first().waitFor();
        await sleep(300);
        // The Use this model bar is sticky: a full-page capture leaves it at the
        // first screen's edge, so make the window as tall as the page instead.
        const tall = await viewer.evaluate(() => document.documentElement.scrollHeight);
        await viewer.setViewportSize({ width, height: tall });
        await shot(viewer, `model-${scheme}-${width}`, { full: false });
      }
    }
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
    await fx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
