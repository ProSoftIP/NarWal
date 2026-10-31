// Board #16844: the transcript on Saved recordings can be picked and hovered,
// and the replay shows the whole recorded window. Saves a recording made by
// hand straight into the local store (no recorder): a window taller than it
// is wide (1000 × 1600), an inner area scrolled 544 px down at 5 s that brings
// a "page selector" into the bottom of the window, three marked areas and four
// said lines. Then checks, in the built extension:
//   - the stage shows the whole window (it was cut at 3/4 of its width), and
//     the scroll is replayed, so the selector is inside the stage;
//   - hovering a mark shows its moment and its box, drawn stronger; leaving
//     goes back to where the replay was;
//   - clicking a line picks it (the replay stays at its moment, paused) and
//     the arrow keys move the pick through the rows, marks and routes too;
//   - an area with no text reads its size, or the named element in it.
// With NARWAL_BUNDLE=<an unpacked .narwal.zip folder> it also saves that
// recording and takes screenshots of it: the moment just after its first scroll,
// and each of its first three marks hovered.
// Usage: npm run build:test && node test/e2e/select.mjs [out-dir]
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../app', import.meta.url));
const OUT = process.argv[2] || join(tmpdir(), 'narwal-select');
const BUNDLE = process.env.NARWAL_BUNDLE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 9, 16, 14, 0, 0);
const W = 1000;
const H = 1600;

/** A minimal rrweb page: a scrolling area 3000 px tall with a page selector near its bottom. */
function fixtureEvents() {
  let id = 0;
  const n = (node) => ({ ...node, id: ++id });
  const doc = n({ type: 0, childNodes: [] });
  const doctype = n({ type: 1, name: 'html', publicId: '', systemId: '' });
  const html = n({ type: 2, tagName: 'html', attributes: {}, childNodes: [] });
  const head = n({ type: 2, tagName: 'head', attributes: {}, childNodes: [] });
  const body = n({ type: 2, tagName: 'body', attributes: { style: 'margin:0;font:16px sans-serif' }, childNodes: [] });
  const scroller = n({ type: 2, tagName: 'div', attributes: { id: 'scroller', style: `height:${H}px;overflow:auto` }, childNodes: [] });
  const inner = n({ type: 2, tagName: 'div', attributes: { style: 'height:3000px;position:relative;background:linear-gradient(#eef3ff,#fff3e8)' }, childNodes: [] });
  const block = (label, style) => {
    const el = n({ type: 2, tagName: 'div', attributes: { style: `position:absolute;left:40px;padding:12px;${style}` }, childNodes: [] });
    el.childNodes.push(n({ type: 3, textContent: label }));
    return el;
  };
  inner.childNodes.push(
    block('Search roster', 'top:200px;width:300px;height:56px;background:#dde'),
    block('Roster table', 'top:300px;width:800px;height:900px;background:#eee'),
    block('Page selector', 'top:2000px;width:400px;height:80px;background:#c33;color:#fff'),
  );
  inner.childNodes[2].attributes.id = 'selector';
  scroller.childNodes.push(inner);
  body.childNodes.push(scroller);
  html.childNodes.push(head, body);
  doc.childNodes.push(doctype, html);
  return {
    events: [
      { type: 4, data: { href: 'http://example.test/companies/1', width: W, height: H }, timestamp: T0 + 100 },
      { type: 2, data: { node: doc, initialOffset: { left: 0, top: 0 } }, timestamp: T0 + 110 },
      { type: 3, data: { source: 3, id: scroller.id, x: 0, y: 544 }, timestamp: T0 + 5000 },
      { type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] }, timestamp: T0 + 11900 },
    ],
  };
}

const FIXTURE = {
  id: 'rec-select-16844',
  title: 'Select fixture',
  url: 'http://example.test/companies/1',
  startedAt: T0,
  durationMs: 12000,
  rrweb: fixtureEvents().events,
  observations: [
    { kind: 'marker-region', atMs: 1500, endMs: 1900, rect: { x: 40, y: 200, w: 300, h: 56 }, contains: [] },
    { kind: 'marker-region', atMs: 2500, endMs: 2900, rect: { x: 40, y: 300, w: 800, h: 120 }, contains: [{ tag: 'table', role: 'table', name: 'Roster table' }] },
    { kind: 'marker-region', atMs: 8000, endMs: 8500, rect: { x: 40, y: 1456, w: 400, h: 80 }, contains: [], text: 'Page selector' },
  ],
  segments: [
    [500, 'This is the activation page.'],
    [3200, 'The table has a lot of space.'],
    [6000, 'Here is the page selector at the bottom.'],
    [9000, 'That is it for now.'],
  ],
};

/** An unpacked bundle as the same shape: its own rrweb, marks and active transcript. */
async function fromBundle(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const { documents } = JSON.parse(await readFile(join(dir, 'documents.json'), 'utf8'));
  const top = documents.find((d) => d.frameId === 0 && d.rrweb);
  const lines = async (path) => (await readFile(join(dir, path), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rrweb = (await lines(top.rrweb)).map((r) => r.event);
  const observations = (await lines('observations.jsonl')).filter((o) => o.doc === top.key);
  const active = manifest.transcript && manifest.transcript.activeRevision;
  const revisions = (await readdir(join(dir, 'transcript'))).filter((f) => f.endsWith('.json'));
  const revision = revisions.includes(`${active}.json`) ? JSON.parse(await readFile(join(dir, 'transcript', `${active}.json`), 'utf8')) : { segments: [] };
  return {
    id: 'rec-bundle-16844',
    title: manifest.title,
    url: top.url,
    startedAt: Math.round(manifest.clock.originEpochMs),
    durationMs: manifest.durationMs,
    rrweb,
    observations,
    segments: revision.segments.map((s) => [s.startMs, s.text]),
  };
}

/** Writes one recording into the extension's local store, as the recorder would have. */
function save(page, rec) {
  return page.evaluate(
    (r) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('narwal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const stoppedAt = r.startedAt + Math.round(r.durationMs);
          const entries = [
            { k: 'attach', doc: 'p1', documentId: 'D1', frameId: 0, url: r.url, reason: 'boot', boot: { isTop: true, inst: 'i1', navType: 'navigate' }, t: r.rrweb[0].timestamp },
            ...r.rrweb.map((e) => ({ k: 'rr', doc: 'p1', e, t: e.timestamp })),
            ...r.observations.map((o) => ({ k: 'obs', doc: 'p1', o, t: r.startedAt + o.atMs })),
          ].sort((a, b) => a.t - b.t);
          const segments = r.segments.map(([startMs, text], i) => ({ id: `s${i + 1}`, startMs, endMs: startMs + 2000, text, words: [] }));
          const history = {
            recordingId: r.id,
            version: 1,
            revisions: [{ revisionId: 'r1', source: 'live', provider: 'browser-local', model: 'stand-in', language: 'en', createdAt: new Date(r.startedAt).toISOString(), segments, gaps: [] }],
            activeRevision: 'r1',
            edits: [],
            pending: null,
            usedConsents: [],
          };
          const tx = open.result.transaction(['recordings', 'chunks'], 'readwrite');
          tx.objectStore('recordings').put({ id: r.id, startedAt: r.startedAt, stoppedAt, status: 'stopped', stopReason: 'user', title: r.title, url: r.url, transcription: 'none' });
          tx.objectStore('chunks').put({ recordingId: r.id, stream: 'events', seq: 0, startAt: r.startedAt, endAt: stoppedAt, entries });
          tx.objectStore('chunks').put({ recordingId: r.id, stream: 'history', seq: 0, history });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    rec,
  );
}

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` ${JSON.stringify(detail)}`}`);
}

/** What the page shows now: the time, play state, picked row, the box and the stage. */
const state = (page) =>
  page.evaluate(() => {
    const box = document.getElementById('mark-box');
    const stage = document.getElementById('stage');
    const wrapper = stage.querySelector('.replayer-wrapper');
    const picked = document.querySelector('#transcript > li[aria-selected="true"]');
    const frame = stage.querySelector('iframe');
    const scroller = frame && frame.contentDocument && frame.contentDocument.getElementById('scroller');
    const selector = frame && frame.contentDocument && frame.contentDocument.getElementById('selector');
    return {
      t: Number(document.getElementById('seek').value),
      playing: document.getElementById('play').getAttribute('aria-label') === 'Pause',
      picked: picked ? picked.textContent : null,
      focused: document.activeElement === picked,
      box: box.hidden ? null : { at: Number(box.dataset.at), focus: box.classList.contains('focus'), left: box.offsetLeft, top: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight },
      stage: { w: stage.clientWidth, h: stage.clientHeight, transform: wrapper && wrapper.style.transform, left: wrapper && parseFloat(wrapper.style.left || '0') },
      scrollTop: scroller ? scroller.scrollTop : null,
      selectorBottom: selector ? selector.getBoundingClientRect().bottom : null,
    };
  });

const scaleOf = (s) => Number(/scale\(([\d.]+)\)/.exec(s.stage.transform || '')?.[1] || 0);
const row = (page, text) => page.locator('#transcript > li', { hasText: text });

async function main() {
  await mkdir(OUT, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'narwal-select-profile-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${APP}`, `--load-extension=${APP}`],
    viewport: { width: 1440, height: 1000 },
  });
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const url = (path) => `chrome-extension://${new URL(sw.url()).host}/${path}`;
    const page = await context.newPage();
    await page.goto(url('recordings.html'));
    await save(page, FIXTURE);
    await page.goto(url(`recordings.html?id=${FIXTURE.id}`));
    await page.locator('#replay iframe').waitFor();
    await sleep(600);

    // Ask 3: an area with no text is never just "Marked an area".
    const marks = await page.locator('#transcript > li.mark .what').allTextContents();
    ok('marks read their size, the named element in them, or their text', JSON.stringify(marks) === JSON.stringify(['Marked an area 300 × 56 px', 'Marked an area 800 × 120 px with “Roster table”', 'Marked an area: “Page selector”']), marks);

    // Ask 4: the whole window, and the scroll replayed.
    let s = await state(page);
    const scale = scaleOf(s);
    ok('the stage shows the whole recorded window', scale > 0 && Math.abs(s.stage.h - H * scale) <= 2 && W * scale <= s.stage.w + 1, s.stage);

    // Ask 2: a click picks a line; the replay stays at its moment, paused.
    await row(page, 'page selector at the bottom').click();
    await sleep(500);
    s = await state(page);
    ok('a clicked line is picked and the replay shows its moment, paused', s.picked && s.picked.includes('page selector at the bottom') && s.t === 6000 && !s.playing && s.focused, s);
    ok('the scroll before that moment is replayed', s.scrollTop === 544, s.scrollTop);
    ok('the page selector at the bottom of the window is inside the stage', s.selectorBottom > H * 0.75 && s.selectorBottom <= H && s.selectorBottom * scale <= s.stage.h, { bottom: s.selectorBottom, stage: s.stage });
    await page.screenshot({ path: join(OUT, 'fixture-picked-line.png') });

    // Ask 1: hovering a mark shows its box; leaving goes back.
    await row(page, 'with “Roster table”').hover();
    await sleep(500);
    s = await state(page);
    const want = { left: Math.round(s.stage.left + 40 * scale - 3), top: Math.round(300 * scale - 3) };
    ok('hovering a mark shows its moment and its box, drawn stronger', s.t === 2500 && s.box && s.box.at === 2500 && s.box.focus && Math.abs(s.box.left - want.left) <= 2 && Math.abs(s.box.top - want.top) <= 2 && !s.playing, { s, want });
    await page.screenshot({ path: join(OUT, 'fixture-hover-mark.png') });
    await row(page, '300 × 56 px').hover();
    await sleep(400);
    s = await state(page);
    ok('hovering the mark before it shows that one, not the newer', s.t === 1500 && s.box && s.box.at === 1500 && s.box.focus, s);
    await page.locator('#h-transcript').hover();
    await sleep(400);
    s = await state(page);
    ok('leaving the mark goes back to the picked moment and takes the box away', s.t === 6000 && s.box === null && s.picked.includes('page selector at the bottom'), s);

    // Ask 2: the arrow keys move the pick through every row.
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    s = await state(page);
    ok('ArrowDown picks the next row (a mark) and shows its box', s.picked.includes('“Page selector”') && s.t === 8000 && s.box && s.box.at === 8000 && s.box.focus && s.focused, s);
    await page.keyboard.press('Home');
    await sleep(400);
    s = await state(page);
    ok('Home picks the first row, the page opened', s.picked.includes('opened') && s.t === 0, s);
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    await page.keyboard.press('ArrowUp');
    await sleep(300);
    s = await state(page);
    ok('ArrowUp goes back', s.picked.includes('opened') && s.t === 0, s);
    // Play, then hover and leave: the replay plays on from where it was.
    await page.locator('#play').click();
    await sleep(300);
    await row(page, '300 × 56 px').hover();
    await sleep(300);
    const during = await state(page);
    await page.locator('#h-transcript').hover();
    await sleep(300);
    s = await state(page);
    ok('hovering pauses on the mark; leaving plays on', !during.playing && during.t === 1500 && s.playing && s.t < 2500, { during, s });
    await page.locator('#play').click();

    if (BUNDLE) {
      const rec = await fromBundle(BUNDLE);
      await save(page, rec);
      await page.goto(url(`recordings.html?id=${rec.id}`));
      await page.locator('#replay iframe').waitFor();
      await sleep(800);
      // Just after the first scroll the recording has: what it brought into view.
      const scroll = rec.observations.find((o) => o.kind === 'scroll' && typeof o.endMs === 'number');
      if (scroll) {
        await page.evaluate((t) => {
          const seek = document.getElementById('seek');
          seek.value = String(t);
          seek.dispatchEvent(new Event('input'));
        }, Math.round(scroll.endMs + 500));
        await sleep(800);
        await page.screenshot({ path: join(OUT, 'bundle-after-scroll.png') });
        s = await state(page);
        console.log(`bundle: at ${s.t} ms after the scroll at ${scroll.atMs} ms; stage ${s.stage.w}×${s.stage.h}, ${s.stage.transform}`);
      }
      const markRows = page.locator('#transcript > li.mark');
      const n = Math.min(3, await markRows.count());
      for (let i = 0; i < n; i += 1) {
        await markRows.nth(i).hover();
        await sleep(800);
        s = await state(page);
        console.log(`bundle: hover mark ${i + 1} "${(await markRows.nth(i).textContent()).trim()}" box ${JSON.stringify(s.box)}`);
        await page.screenshot({ path: join(OUT, `bundle-hover-mark-${i + 1}.png`) });
      }
    }
  } finally {
    await context.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed; screenshots in ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
