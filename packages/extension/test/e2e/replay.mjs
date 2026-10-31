// Board #16549: replay e2e. Loads app/ (built with --test) into Playwright's
// Chromium and replays the known-timing bundle (packages/replay/test/
// known-timing.ts) from the library and from a picked file, then a malicious
// bundle. Checks:
//   seek     every seek shows the page of that instant (PAGE_TOLERANCE_MS) and
//            the narration at its true media time (AUDIO_SYNC_TOLERANCE_MS),
//            before and after the navigation and across every gap
//   play     page and narration stay in step while playing through the
//            navigation and through the pause
//   hostile  recorded scripts and handlers never run, nothing reaches
//            extension storage, and no request reaches the recorded site,
//            with or without its cookie
//   edit     board #16550: a library recording is corrected, annotated and
//            switched to a newer transcript that conflicts with a correction;
//            every seek check still holds afterwards (capture untouched)
//   keep     board #16589: an opened file is saved only on Save; the saved
//            copy is listed in Saved recordings, takes a correction and a
//            note, survives a browser restart and exports a valid bundle; a
//            changed file saves nothing and a hostile bundle stays inert
//   share    board #27484: a bundle exported in one browser profile, whose
//            Export says how to share it, opens in a second profile from
//            Open a shared recording on Saved recordings and from a drop on
//            the replay page, replays, and is kept only on Save
// Usage: node test/e2e/replay.mjs [seek|play|hostile|edit|keep|share ...]   HEADED=1 to watch.
// SHOT_DIR=<dir> saves screenshots of the edit and keep scenarios there.
// Local only: one browser, one local server, no network.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleValidator } from '../../../bundle/src/index.ts';
import { packBundle, unpackBundle } from '../../../library/src/index.ts';
import { addRetranscription, applyPlan, readLayer } from '../../../edits/src/index.ts';
import { AUDIO_SYNC_TOLERANCE_MS, PAGE_TOLERANCE_MS } from '../../../replay/src/index.ts';
import { DURATION_MS, MIC_LOSS, NAVIGATION_MS, PAUSE, UTTERANCES, expectedTick, knownTimingFiles, trueSessionMs, wordsOf } from '../../../replay/test/known-timing.ts';

const APP = fileURLToPath(new URL('../../app', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Checks {
  constructor() {
    this.list = [];
  }
  ok(label, pass, got) {
    this.list.push({ label, pass: !!pass, ...(pass ? {} : { got }) });
  }
}

/** Media seconds the fixture's narration plays at session `t` (its own truth, not the fit). */
function trueMediaSec(t) {
  let lo = 0;
  let hi = 40000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (trueSessionMs(mid) < t) lo = mid;
    else hi = mid;
  }
  return lo / 1000;
}

const inLoss = (t) => [PAUSE, MIC_LOSS].some((l) => t >= l.startMs && t < l.endMs);

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'narwal-replay-e2e-'));
  const b = {
    context: null,
    url: null,
    async start() {
      b.context = await chromium.launchPersistentContext(dir, {
        channel: 'chromium',
        headless: !process.env.HEADED,
        args: [`--disable-extensions-except=${APP}`, `--load-extension=${APP}`, '--autoplay-policy=no-user-gesture-required'],
        viewport: { width: 1400, height: 900 },
      });
      let sw = b.context.serviceWorkers()[0];
      if (!sw) sw = await b.context.waitForEvent('serviceworker');
      const id = new URL(sw.url()).host;
      b.url = (path) => `chrome-extension://${id}/${path}`;
    },
    /** Closes the browser and starts it again on the same profile, as a user's restart does. */
    async restart() {
      await b.context.close();
      await b.start();
    },
    async close() {
      await b.context.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  await b.start();
  return b;
}

async function openReplay(b, query = '') {
  const page = await b.context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(b.url(`replay.html${query}`));
  await page.waitForFunction(() => globalThis.__narwalReplayReady === true);
  return { page, errors };
}

async function waitForPlayer(page) {
  await page.waitForFunction(() => globalThis.__narwalReplay?.player);
  // Narration is decodable before any seek check reads its position.
  await page.waitForFunction(() => {
    const a = document.getElementById('audio');
    return !a.getAttribute('src') || a.readyState >= 1;
  });
}

/** Seeks and reads back what is on screen, in one task so nothing moves between reads. */
function seekAndRead(page, t) {
  return page.evaluate((at) => {
    const { player } = globalThis.__narwalReplay;
    player.seek(at);
    const state = player.state();
    const doc = player.frame?.contentDocument ?? null;
    const overlay = document.querySelector('.narwal-replay-gap');
    const active = document.querySelector('#transcript button[aria-current="true"]');
    return {
      t: state.t,
      docKey: state.page?.docKey ?? null,
      tick: state.page ? (doc?.querySelector('#tick')?.textContent ?? null) : null,
      docName: state.page ? (doc?.querySelector('#doc')?.textContent ?? null) : null,
      overlay: overlay.hidden ? null : overlay.textContent,
      banner: document.querySelector('.narwal-replay-banner').hidden ? null : document.querySelector('.narwal-replay-banner').textContent,
      mediaSec: state.audio?.mediaSec ?? null,
      audioAt: document.getElementById('audio').currentTime,
      audioPaused: document.getElementById('audio').paused,
      utterance: active?.textContent ?? null,
      markers: [...document.querySelectorAll('.narwal-replay-markers [data-observation]')].map((m) => m.className),
      clock: document.getElementById('clock').textContent,
    };
  }, t);
}

/** Seek checks shared by the library and the file paths. */
async function seekChecks(c, page, label) {
  const shownTimes = [
    5,
    1000 + PAGE_TOLERANCE_MS,
    2000 - PAGE_TOLERANCE_MS,
    5000,
    8500,
    NAVIGATION_MS - PAGE_TOLERANCE_MS,
    NAVIGATION_MS + 60,
    13000 - PAGE_TOLERANCE_MS,
    13000 + PAGE_TOLERANCE_MS,
    15400,
    PAUSE.startMs - PAGE_TOLERANCE_MS,
    PAUSE.endMs,
    PAUSE.endMs + PAGE_TOLERANCE_MS,
    MIC_LOSS.startMs + 700,
    27000 - PAGE_TOLERANCE_MS,
    DURATION_MS - 1,
  ];
  // Backwards too: a seek back rebuilds the earlier page.
  for (const t of [...shownTimes, ...[...shownTimes].reverse()].filter((x) => x >= 10)) {
    const r = await seekAndRead(page, t);
    const doc = t < NAVIGATION_MS ? 'd1' : 'd2';
    c.ok(`${label}: ${t} ms shows ${doc} "${expectedTick(t)}"`, r.docKey === doc && r.tick === expectedTick(t) && r.overlay === null, r);
  }
  for (const [t, why] of [
    [NAVIGATION_MS + 20, 'changing to the next one'],
    [PAUSE.startMs + 500, 'Recording was paused'],
  ]) {
    const r = await seekAndRead(page, t);
    c.ok(`${label}: ${t} ms hides the page and says why`, r.tick === null && r.overlay?.includes(why), r);
    c.ok(`${label}: ${t} ms has no narration`, r.mediaSec === null || !inLoss(t), r);
  }
  const lost = await seekAndRead(page, MIC_LOSS.startMs + 700);
  c.ok(`${label}: lost microphone keeps the page and labels the narration gap`, lost.tick === expectedTick(MIC_LOSS.startMs + 700) && lost.mediaSec === null && /No narration: The microphone stopped/.test(lost.banner ?? ''), lost);

  let worst = 0;
  const audioTimes = [];
  for (let t = 500; t < DURATION_MS; t += 1250) if (!inLoss(t)) audioTimes.push(t);
  for (const t of audioTimes) {
    const r = await seekAndRead(page, t);
    const err = Math.abs(r.audioAt - trueMediaSec(t)) * 1000;
    worst = Math.max(worst, err);
    if (err > AUDIO_SYNC_TOLERANCE_MS) c.ok(`${label}: narration at ${t} ms`, false, { ...r, trueMediaSec: trueMediaSec(t), errMs: err });
  }
  c.ok(`${label}: narration seeks within ${AUDIO_SYNC_TOLERANCE_MS} ms of true media time (worst ${worst.toFixed(1)} ms, ${audioTimes.length} seeks)`, worst <= AUDIO_SYNC_TOLERANCE_MS, worst);

  const said = await seekAndRead(page, 15000);
  c.ok(`${label}: transcript line at 15 s is the corrected one`, said.utterance?.includes('the next page after the navigation'), said);
  const click = await seekAndRead(page, 5000);
  c.ok(`${label}: click marker drawn at 5 s`, click.markers.some((m) => m.includes('narwal-marker-click')), click.markers);
  const region = await seekAndRead(page, 15400);
  c.ok(`${label}: region marker drawn on the second page`, region.markers.some((m) => m.includes('narwal-marker-region')), region.markers);
  const none = await seekAndRead(page, 13000);
  c.ok(`${label}: no first-page marker on the second page`, none.markers.length === 0, none.markers);

  // Clicking a transcript line seeks to it.
  await page.click('#transcript li:nth-child(3) button');
  const after = await page.evaluate(() => globalThis.__narwalReplay.player.time);
  c.ok(`${label}: clicking a transcript line seeks to its start`, after === 26000, after);
}

/**
 * The known-timing bundle (its c1 reads "next" for the heard "second" in s2)
 * after a retranscription that hears "secant" there: stored, not active.
 */
async function conflictingBundle() {
  const files = knownTimingFiles();
  const segments = UTTERANCES.map((u, i) => {
    const text = u.id === 's2' ? u.text.replace('second', 'secant') : u.text;
    return {
      provider: 'openai', model: 'gpt-4o-transcribe', connectionId: 'upload-1', segmentKey: `k${i}`, kind: 'final',
      startMs: u.startMs, endMs: u.endMs, text, words: wordsOf(u.startMs, u.endMs, text), endOfUtterance: true,
    };
  });
  const revision = { revisionId: 'job-1', provider: 'openai', model: 'gpt-4o-transcribe', createdAtMs: Date.parse('2026-10-13T20:05:00.000Z'), source: 'after-recording', segments, gaps: [], supersedes: 'r1' };
  const result = addRetranscription(readLayer(files), revision, { at: '2026-10-13T20:05:00.000Z' });
  if (result.activated) throw new Error('fixture: the retranscription was expected to conflict');
  return applyPlan(files, result.plan);
}

/**
 * The known-timing bundle with a first page that tries every way to run a
 * script or reach `site`: what a hostile sender could put in a bundle.
 */
function hostileFiles(site) {
  const u = (path) => `${site.origin}${path}`;
  let id = 100;
  const node = (tagName, attributes = {}, childNodes = []) => ({ type: 2, id: id++, tagName, attributes, childNodes });
  const textNode = (textContent, extra = {}) => ({ type: 3, id: id++, textContent, ...extra });
  const pwn = "top.__pwned='script';try{chrome.storage.local.set({pwned:1})}catch(e){};fetch('" + u('/fetch') + "',{credentials:'include'})";
  const head = [
    node('meta', { 'http-equiv': 'refresh', content: `0;url=${u('/refresh')}` }),
    node('base', { href: u('/base/') }),
    node('link', { rel: 'stylesheet', href: u('/style.css') }),
    node('link', { rel: 'preload', as: 'image', href: u('/preload.png') }),
    node('link', { rel: 'prefetch', href: u('/prefetch') }),
    node('script', { src: u('/script.js') }),
    node('script', {}, [textNode(pwn)]),
    node('style', {}, [
      textNode(`@import url(${u('/import.css')}); body{background:url(${u('/bg.png')})} @font-face{font-family:x;src:url(${u('/font.woff')})} p{font-family:x}`, { isStyle: true }),
    ]),
  ];
  const body = [
    node('img', { src: u('/img.png'), onerror: pwn, onload: pwn }),
    node('img', { srcset: `${u('/srcset.png')} 2x` }),
    node('picture', {}, [node('source', { srcset: u('/source.png') })]),
    node('video', { poster: u('/poster.png'), src: u('/video.webm'), autoplay: '' }),
    node('audio', { src: u('/audio.webm'), autoplay: '' }),
    node('object', { data: u('/object') }),
    node('embed', { src: u('/embed') }),
    node('iframe', { src: u('/frame.html') }),
    node('iframe', { srcdoc: `<script>${pwn}</script><img src="${u('/srcdoc.png')}">` }),
    node('input', { type: 'image', src: u('/input.png') }),
    node('div', { style: `background-image:url(${u('/div.png')})` }),
    node('a', { href: `javascript:${pwn}`, id: 'js-link' }, [textNode('link')]),
    node('form', { action: u('/form'), method: 'post', id: 'form' }, [node('input', { name: 'x', value: '1' })]),
    node('svg', { xmlns: 'http://www.w3.org/2000/svg' }, [node('image', { href: u('/svg.png') })]),
    node('div', { onclick: pwn, onmouseover: pwn, id: 'handler' }, [textNode('hover me')]),
  ];
  return knownTimingFiles({ head, body });
}

const scenarios = {
  async edit(b, c) {
    const archive = await packBundle(await conflictingBundle());
    const boot = await openReplay(b);
    const id = await boot.page.evaluate(async (bytes) => {
      const { recording } = await globalThis.__narwalLibrary.importBundle(new Uint8Array(bytes), { fileName: 'edit.narwal.zip' });
      return recording.id;
    }, [...archive]);
    await boot.page.close();
    const { page, errors } = await openReplay(b, `?id=${encodeURIComponent(id)}`);
    await waitForPlayer(page);
    const model = () => page.evaluate(() => {
      const m = globalThis.__narwalReplay.model;
      return { revision: m.transcript?.revisionId, utterances: m.utterances, notes: m.notes, spans: m.spans, markers: m.markers, gaps: m.gaps };
    });
    const before = await model();
    const lines = () => page.locator('#transcript button[data-index]').allTextContents();

    // A newer transcript is waiting, not shown: the user's correction holds.
    const waiting = await page.locator('#waiting').textContent();
    c.ok('conflicting retranscription is listed, not shown', (await page.locator('#waiting').isVisible()) && waiting.includes('You wrote "next" for "second". The newer transcript says "secant".'), waiting);
    c.ok('active transcript is still the corrected r1', before.revision === 'r1' && (await lines())[1].includes('the next page after the navigation'), await lines());

    // Correct a line: Edit, type, Enter.
    await page.click('#transcript li:nth-child(1) button[aria-label^="Edit"]');
    await page.fill('#transcript li:nth-child(1) input', 'the first page begins here');
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'replay-edit-conflict-light.png'), fullPage: true });
    await page.press('#transcript li:nth-child(1) input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#transcript button[data-index="0"]')?.textContent.includes('begins'));
    const edited = await model();
    const s1 = edited.utterances[0];
    c.ok('corrected line shows the new text and keeps what was heard', s1.text === 'the first page begins here' && s1.heard === 'the first page starts here' && s1.corrected, s1);
    c.ok('corrected line keeps its captured times', JSON.stringify(edited.utterances.map((u) => [u.segmentId, u.startMs, u.endMs])) === JSON.stringify(before.utterances.map((u) => [u.segmentId, u.startMs, u.endMs])), edited.utterances);

    // A note at the playhead, then removed.
    await page.evaluate(() => globalThis.__narwalReplay.player.seek(5000));
    await page.fill('#note-text', 'check this heading');
    await page.click('#add-note');
    await page.waitForFunction(() => globalThis.__narwalReplay.model.notes.some((n) => n.text === 'check this heading'));
    const noted = await model();
    const note = noted.notes.find((n) => n.text === 'check this heading');
    c.ok('note is anchored at the playhead', note?.atMs === 5000 && note.endMs === null, noted.notes);
    c.ok('note form is cleared', (await page.inputValue('#note-text')) === '');
    const time = await page.evaluate(() => globalThis.__narwalReplay.player.time);
    c.ok('an edit keeps the replay position', time === 5000, time);
    await page.click('#notes button[aria-label="Remove note at 0:05.0"]');
    await page.waitForFunction(() => !globalThis.__narwalReplay.model.notes.some((n) => n.text === 'check this heading'));
    c.ok('removed note is gone; the fixture note stays', (await model()).notes.map((n) => n.text).join('|') === 'the marked heading');

    // What the recording is for (#16594): shown, edited and saved into the manifest.
    c.ok('no purpose given is shown', (await page.textContent('#purpose-text')) === 'No purpose given.' && (await page.isVisible('#purpose-form')));
    await page.fill('#purpose-input', 'Each mark is a change request');
    c.ok('the purpose field counts its characters', (await page.textContent('#purpose-count')) === '29 / 1000', await page.textContent('#purpose-count'));
    await page.click('#save-purpose');
    await page.waitForFunction(() => document.querySelector('#purpose-text')?.textContent.includes('Each mark is a change request'));
    const stored = await page.evaluate(async (id) => JSON.parse(new TextDecoder().decode(await globalThis.__narwalLibrary.readFile(id, 'manifest.json'))).purpose, id);
    c.ok('purpose is saved in the manifest', stored === 'Each mark is a change request', stored);

    // Capture is unchanged: every seek check passes on the edited recording.
    const after = await model();
    c.ok('pages, markers and gaps unchanged by edits', JSON.stringify([after.spans, after.markers, after.gaps]) === JSON.stringify([before.spans, before.markers, before.gaps]));
    await seekChecks(c, page, 'edited');

    // Switch, keeping the user's text on the newer words.
    await page.selectOption('#waiting select', 'keep-mine');
    await page.click('#waiting button');
    await page.waitForFunction(() => globalThis.__narwalReplay.model.transcript?.revisionId === 'r2');
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'replay-edit-switched-light.png'), fullPage: true });
    const switched = await model();
    const s2 = switched.utterances[1];
    c.ok('after keep-mine the newer transcript is shown with the user\'s word', s2.revisionId === 'r2' && s2.text === 'the next page after the navigation' && s2.heard === 'the secant page after the navigation', s2);
    c.ok('the earlier line correction is carried to the newer transcript', switched.utterances[0].text === 'the first page begins here', switched.utterances[0]);
    c.ok('nothing is waiting after the switch', !(await page.locator('#waiting').isVisible()));
    c.ok('utterance times unchanged by the switch', JSON.stringify(switched.utterances.map((u) => [u.startMs, u.endMs])) === JSON.stringify(before.utterances.map((u) => [u.startMs, u.endMs])));

    // Reopened from the library: the same state.
    await page.reload();
    await page.waitForFunction(() => globalThis.__narwalReplayReady === true);
    await waitForPlayer(page);
    const reopened = await model();
    c.ok('reopened recording keeps edits and the chosen transcript', reopened.revision === 'r2' && reopened.utterances[0].text === 'the first page begins here' && reopened.utterances[1].text === 'the next page after the navigation', reopened.utterances);
    c.ok('edit: no page errors', errors.length === 0, errors);
    await page.close();
  },

  async keep(b, c, fx) {
    const archive = await packBundle(knownTimingFiles());
    const file = join(fx.dir, 'received.narwal.zip');
    await writeFile(file, archive);
    const saved = (page) => page.evaluate(async () => (await globalThis.__narwalLibrary.list()).map((r) => ({ id: r.id, origin: r.origin, title: r.title })));
    const reopen = async (page) => {
      await page.waitForFunction(() => globalThis.__narwalReplayReady === true);
      await waitForPlayer(page);
    };

    // Opening a file shows it and offers to save it; nothing is stored yet.
    let { page, errors } = await openReplay(b);
    await page.setInputFiles('#file', file);
    await waitForPlayer(page);
    await page.waitForSelector('#keep button');
    const offer = await page.locator('#keep').textContent();
    c.ok('keep: an opened file offers Save', offer.includes('open for viewing only') && (await page.locator('#keep button').textContent()) === 'Save to Saved recordings', offer);
    c.ok('keep: opening a file stores nothing', (await saved(page)).length === 0, await saved(page));
    c.ok('keep: an unsaved file cannot be edited', (await page.locator('#transcript button[aria-label^="Edit"]').count()) === 0 && !(await page.locator('#note-form').isVisible()));
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'replay-opened-file-save-offer-light.png'), fullPage: true });

    // A file changed after export is refused whole: nothing replays, nothing is offered or stored.
    const changed = Uint8Array.from(archive);
    const at = Math.floor(archive.length / 2);
    changed[at] ^= 0xff;
    const bad = join(fx.dir, 'changed.narwal.zip');
    await writeFile(bad, changed);
    const refused = await openReplay(b);
    await refused.page.setInputFiles('#file', bad);
    await refused.page.waitForSelector('#error:not([hidden])');
    c.ok('keep: a changed file is refused with a reason', at > 0 && (await refused.page.locator('#error').textContent()).length > 0 && !(await refused.page.locator('#player').isVisible()), await refused.page.locator('#error').textContent());
    c.ok('keep: a refused file offers no Save and stores nothing', !(await refused.page.locator('#keep').isVisible()) && (await saved(refused.page)).length === 0);
    await refused.page.close();

    // Save: the bundle becomes a library recording and opens as one.
    await page.click('#keep button');
    await page.waitForURL(/\?id=/);
    await reopen(page);
    const id = new URL(page.url()).searchParams.get('id');
    const list = await saved(page);
    c.ok('keep: Save adds one recording, marked as from this file', list.length === 1 && list[0].id === id && list[0].origin.kind === 'imported' && list[0].origin.fileName === 'received.narwal.zip', list);
    c.ok('keep: the saved copy has no Save offer', !(await page.locator('#keep').isVisible()));
    await seekChecks(c, page, 'kept');

    // The recipient corrects a line and adds a note.
    await page.click('#transcript li:nth-child(1) button[aria-label^="Edit"]');
    await page.fill('#transcript li:nth-child(1) input', 'the first page opens here');
    await page.press('#transcript li:nth-child(1) input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#transcript button[data-index="0"]')?.textContent.includes('opens'));
    await page.evaluate(() => globalThis.__narwalReplay.player.seek(5000));
    await page.fill('#note-text', 'recipient note');
    await page.click('#add-note');
    await page.waitForFunction(() => globalThis.__narwalReplay.model.notes.some((n) => n.text === 'recipient note'));
    c.ok('keep: the saved copy takes a correction and a note', true);
    c.ok('keep: no page errors before the restart', errors.length === 0, errors);

    // Browser restart: still listed in Saved recordings, with the edits.
    await b.restart();
    const viewer = await b.context.newPage();
    await viewer.goto(b.url('recordings.html'));
    const row = viewer.locator(`#list tbody tr[data-library-id="${id}"]`);
    await row.waitFor();
    const cells = await row.locator('td').allTextContents();
    // Columns: select (board #17003), Started, Recording, Site, Length, Status, Transcript, actions (board #16783).
    c.ok('keep: after a restart Saved recordings lists the saved bundle', cells[2] === list[0].title && cells[3] === 'from a bundle file' && cells[5] === 'Saved from a file', cells);
    if (process.env.SHOT_DIR) await viewer.screenshot({ path: join(process.env.SHOT_DIR, 'saved-recordings-bundle-row-light.png'), fullPage: true });

    // Export from that row: a valid bundle that carries the recipient's edits.
    // A bundle with no purpose is asked for one first (board #17002).
    const keptPurpose = 'Each correction and note is for the person who recorded it';
    const answerIfAsked = async () => {
      await viewer.waitForFunction(() => document.getElementById('purpose-ask').open || /^(Exporting|Saved|Could not)/.test(document.getElementById('export-status').textContent), null, { timeout: 30000 });
      if (!(await viewer.evaluate(() => document.getElementById('purpose-ask').open))) return false;
      await viewer.fill('#purpose-ask-text', keptPurpose);
      await viewer.click('#purpose-ask-ok');
      return true;
    };
    const [download, askedPurpose] = await Promise.all([viewer.waitForEvent('download'), row.getByRole('button', { name: 'Export bundle' }).click().then(answerIfAsked)]);
    const exported = new Uint8Array(await readFile(await download.path()));
    let check = null;
    try {
      check = await unpackBundle(exported, { validate: bundleValidator });
    } catch (err) {
      check = { error: String(err) };
    }
    const edits = check.files?.get('edits.jsonl') ? new TextDecoder().decode(check.files.get('edits.jsonl')).trim().split('\n').map((l) => JSON.parse(l)) : [];
    c.ok('keep: the saved bundle exports again as a valid bundle', !check.error && download.suggestedFilename().endsWith('.narwal.zip'), check.error);
    if (askedPurpose) {
      const purpose = check.files ? JSON.parse(new TextDecoder().decode(check.files.get('manifest.json'))).purpose : null;
      c.ok('keep: a saved bundle with no purpose is asked for one, and the export carries the answer (#17002)', purpose === keptPurpose, purpose);
    }
    c.ok('keep: the export carries the correction and the note', edits.some((e) => e.type === 'correction' && e.segmentId === 's1' && e.text === 'opens') && edits.some((e) => e.type === 'note' && e.atMs === 5000 && e.text === 'recipient note'), edits);

    // Open from the row: the replay page, with the edits.
    await Promise.all([viewer.waitForURL(/replay\.html\?id=/), row.getByRole('button', { name: 'Open' }).click()]);
    await reopen(viewer);
    const kept = await viewer.evaluate(() => {
      const m = globalThis.__narwalReplay.model;
      return { first: m.utterances[0].text, notes: m.notes.map((n) => n.text) };
    });
    c.ok('keep: after a restart the saved bundle reopens with its edits', new URL(viewer.url()).searchParams.get('id') === id && kept.first === 'the first page opens here' && kept.notes.includes('recipient note'), kept);
    if (process.env.SHOT_DIR) await viewer.screenshot({ path: join(process.env.SHOT_DIR, 'replay-saved-bundle-edited-light.png'), fullPage: true });

    // The same file again, now that the saved copy has edits: no second copy.
    await viewer.setInputFiles('#file', file);
    await viewer.waitForSelector('#keep button');
    const again = await viewer.locator('#keep').textContent();
    c.ok('keep: the same file again points to the saved copy', again.includes('already in Saved recordings') && (await viewer.locator('#keep button').textContent()) === 'Open the saved copy', again);
    c.ok('keep: a file opened over a saved recording cannot edit it', (await viewer.locator('#transcript button[aria-label^="Edit"]').count()) === 0 && !(await viewer.locator('#note-form').isVisible()));
    await viewer.click('#keep button');
    await viewer.waitForURL(/\?id=/);
    await reopen(viewer);
    c.ok('keep: Open the saved copy opens it; still one recording', new URL(viewer.url()).searchParams.get('id') === id && (await saved(viewer)).length === 1, viewer.url());
    await viewer.close();

    // A hostile bundle, saved: the import boundary of the hostile scenario holds for the saved copy.
    const site = fx.site;
    site.hits.length = 0;
    const control = await b.context.newPage();
    await control.goto(`${site.origin}/login`);
    await control.close();
    c.ok('keep control: the counter sees an ordinary page load', site.hits.length === 1, site.hits);
    site.hits.length = 0;
    const hostile = join(fx.dir, 'hostile-kept.narwal.zip');
    await writeFile(hostile, await packBundle(hostileFiles(site)));
    const h = await openReplay(b);
    await h.page.setInputFiles('#file', hostile);
    await waitForPlayer(h.page);
    await h.page.click('#keep button');
    await h.page.waitForURL(/\?id=/);
    await reopen(h.page);
    for (const t of [100, 3000, 9000]) await seekAndRead(h.page, t);
    await h.page.evaluate(() => globalThis.__narwalReplay.player.play());
    await sleep(1500);
    await h.page.evaluate(() => globalThis.__narwalReplay.player.pause());
    const listPage = await b.context.newPage();
    await listPage.goto(b.url('recordings.html'));
    await listPage.locator('#list tbody tr[data-library-id]').nth(1).waitFor();
    const seen = await h.page.evaluate(async () => {
      const frame = globalThis.__narwalReplay.player.frame;
      return {
        sandbox: frame?.getAttribute('sandbox') ?? null,
        topPwned: globalThis.__pwned ?? null,
        framePwned: frame?.contentWindow?.__pwned ?? null,
        storage: await chrome.storage.local.get(null),
        scripts: frame?.contentDocument ? frame.contentDocument.querySelectorAll('script').length : -1,
      };
    });
    const listPwned = await listPage.evaluate(() => globalThis.__pwned ?? null);
    c.ok('keep: a saved hostile bundle is listed and still replays in the sandbox', (await saved(h.page)).length === 2 && seen.sandbox === 'allow-same-origin' && seen.scripts === 0, seen);
    c.ok('keep: no recorded script ran after saving', seen.topPwned === null && seen.framePwned === null && listPwned === null && !('pwned' in seen.storage), seen);
    c.ok('keep: zero requests reached the recorded site after saving', site.hits.length === 0, site.hits);
    c.ok('keep: no page errors with the hostile bundle', h.errors.length === 0, h.errors);
    await h.page.close();
    await listPage.close();
    const after = await b.context.newPage();
    await after.goto(`${site.origin}/after`);
    await after.close();
    c.ok('keep control: the counter still counts afterwards', site.hits.length === 1 && site.hits[0].path === '/after', site.hits);
    site.hits.length = 0;
  },

  async share(b, c, fx) {
    const SHARE_HINT = 'Send this file; they open it in NarWal with Open a shared recording.';
    // The sender: a bundle saved in their NarWal, exported from Saved recordings.
    const sent = join(fx.dir, 'to-send.narwal.zip');
    await writeFile(sent, await packBundle(knownTimingFiles()));
    const sender = await openReplay(b);
    await sender.page.setInputFiles('#file', sent);
    await waitForPlayer(sender.page);
    await Promise.all([sender.page.waitForURL(/\?id=/), sender.page.click('#keep button')]);
    const list = await b.context.newPage();
    await list.goto(b.url('recordings.html'));
    const row = list.locator('#list tbody tr[data-library-id]');
    await row.waitFor();
    const answerIfAsked = async () => {
      await list.waitForFunction(() => document.getElementById('purpose-ask').open || /^(Exporting|Saved|Could not)/.test(document.getElementById('export-status').textContent), null, { timeout: 30000 });
      if (!(await list.evaluate(() => document.getElementById('purpose-ask').open))) return;
      await list.fill('#purpose-ask-text', 'A walkthrough for the person it is sent to');
      await list.click('#purpose-ask-ok');
    };
    const [download] = await Promise.all([list.waitForEvent('download'), row.getByRole('button', { name: 'Export bundle' }).click().then(answerIfAsked)]);
    await list.waitForFunction(() => /^(Saved|Could not)/.test(document.getElementById('export-status').textContent));
    const note = await list.locator('#export-status').textContent();
    c.ok('share: Export says in one line how to share the file', note.startsWith(`Saved ${download.suggestedFilename()}.`) && note.endsWith(SHARE_HINT), note);
    if (process.env.SHOT_DIR) await list.screenshot({ path: join(process.env.SHOT_DIR, 'saved-recordings-share-hint-light.png') });
    const exported = join(fx.dir, download.suggestedFilename());
    await download.saveAs(exported);
    c.ok('share: the sender has an Open a shared recording button on Saved recordings', await list.getByRole('button', { name: 'Open a shared recording' }).isVisible());
    c.ok('share: sender: no page errors', sender.errors.length === 0, sender.errors);

    // The recipient: another browser profile with an empty NarWal.
    const other = await launch();
    try {
      const popup = await other.context.newPage();
      await popup.goto(other.url('popup.html'));
      const popupLink = await popup.locator('#open-shared').evaluate((a) => ({ text: a.textContent, href: a.getAttribute('href'), target: a.target }));
      c.ok('share: the popup links to Open a shared recording', popupLink.text === 'Open a shared recording' && popupLink.href === 'replay.html' && popupLink.target === '_blank', popupLink);
      await popup.close();

      const viewer = await other.context.newPage();
      const errors = [];
      viewer.on('pageerror', (err) => errors.push(String(err)));
      await viewer.goto(other.url('recordings.html'));
      const chooser = viewer.waitForEvent('filechooser');
      await viewer.getByRole('button', { name: 'Open a shared recording' }).click();
      await (await chooser).setFiles(exported);
      await viewer.waitForURL(/replay\.html$/);
      await viewer.waitForFunction(() => globalThis.__narwalReplayReady === true);
      await waitForPlayer(viewer);
      await viewer.waitForSelector('#keep button');
      const library = () => viewer.evaluate(async () => (await globalThis.__narwalLibrary.list()).length);
      c.ok('share: the picked file lands on its replay, offering Save', (await viewer.locator('#keep button').textContent()) === 'Save to Saved recordings' && (await viewer.locator('#title').textContent()).length > 0);
      c.ok('share: opening it stores nothing until Save', (await library()) === 0);
      c.ok('share: the handed-over file is not kept after the replay page took it', (await viewer.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('narwal-shared-open');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const count = await new Promise((resolve) => {
          const req = db.transaction('files').objectStore('files').count();
          req.onsuccess = () => resolve(req.result);
        });
        db.close();
        return count;
      })) === 0);
      await seekChecks(c, viewer, 'shared');
      if (process.env.SHOT_DIR) await viewer.screenshot({ path: join(process.env.SHOT_DIR, 'replay-shared-recording-light.png'), fullPage: true });

      // A reload of that address shows the library and the open tile, not an error.
      await viewer.reload();
      await viewer.waitForFunction(() => globalThis.__narwalReplayReady === true);
      c.ok('share: a reload after opening shows the Open a shared recording tile', (await viewer.locator('#open-shared').isVisible()) && !(await viewer.locator('#error').isVisible()));
      if (process.env.SHOT_DIR) await viewer.screenshot({ path: join(process.env.SHOT_DIR, 'replay-open-shared-tile-light.png'), fullPage: true });

      // The same file dropped on the replay page.
      const bytes = [...(await readFile(exported))];
      await viewer.evaluate(({ bytes, name }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/zip' }));
        for (const type of ['dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }, { bytes, name: download.suggestedFilename() });
      await waitForPlayer(viewer);
      await viewer.waitForSelector('#keep button');
      c.ok('share: a dropped file replays and offers Save', (await viewer.locator('#keep button').textContent()) === 'Save to Saved recordings' && !(await viewer.locator('#open-shared').isVisible()));

      // Save keeps it in the recipient's Saved recordings.
      await Promise.all([viewer.waitForURL(/\?id=/), viewer.click('#keep button')]);
      await viewer.waitForFunction(() => globalThis.__narwalReplayReady === true);
      await waitForPlayer(viewer);
      c.ok('share: Save keeps one copy on the recipient\'s computer', (await library()) === 1);
      await viewer.goto(other.url('recordings.html'));
      const kept = viewer.locator('#list tbody tr[data-library-id]');
      await kept.waitFor();
      c.ok('share: the recipient\'s Saved recordings lists it', (await kept.locator('td').nth(3).textContent()) === 'from a bundle file');
      c.ok('share: recipient: no page errors', errors.length === 0, errors);
    } finally {
      await other.close();
    }
  },

  async seek(b, c, fx) {
    // Locally recorded: in the extension's library.
    const archive = await packBundle(knownTimingFiles());
    const lib = await openReplay(b);
    const imported = await lib.page.evaluate(async (bytes) => {
      const { recording } = await globalThis.__narwalLibrary.importBundle(new Uint8Array(bytes), { fileName: 'known-timing.narwal.zip' });
      return recording.id;
    }, [...archive]);
    await lib.page.reload();
    await lib.page.waitForFunction(() => globalThis.__narwalReplayReady === true);
    const listed = await lib.page.locator('#list tbody tr').count();
    c.ok('library lists the recording', listed === 1, listed);
    await lib.page.click('#list tbody button');
    await lib.page.waitForURL(/\?id=/);
    await lib.page.waitForFunction(() => globalThis.__narwalReplayReady === true);
    await waitForPlayer(lib.page);
    c.ok('library recording opens by id', lib.page.url().endsWith(`?id=${encodeURIComponent(imported)}`), lib.page.url());
    await seekChecks(c, lib.page, 'library');
    c.ok('library: no page errors', lib.errors.length === 0, lib.errors);
    await lib.page.close();

    // Imported: a picked file, replayed without saving.
    const file = join(fx.dir, 'known-timing.narwal.zip');
    await writeFile(file, archive);
    const picked = await openReplay(b);
    await picked.page.setInputFiles('#file', file);
    await waitForPlayer(picked.page);
    await seekChecks(c, picked.page, 'file');
    c.ok('file: no page errors', picked.errors.length === 0, picked.errors);
    await picked.page.close();
  },

  async play(b, c, fx) {
    const file = join(fx.dir, 'known-timing.narwal.zip');
    await writeFile(file, await packBundle(knownTimingFiles()));
    const { page, errors } = await openReplay(b);
    await page.setInputFiles('#file', file);
    await waitForPlayer(page);

    for (const [from, ms, what] of [
      [10800, 2600, 'through the navigation'],
      [19300, 2900, 'through the pause'],
    ]) {
      await page.evaluate((t) => {
        const { player } = globalThis.__narwalReplay;
        player.seek(t);
        player.play();
      }, from);
      const samples = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        samples.push(
          await page.evaluate(() => {
            const { player } = globalThis.__narwalReplay;
            const state = player.state();
            const audio = document.getElementById('audio');
            return {
              t: player.time,
              shown: state.page ? (player.frame?.contentDocument?.querySelector('#tick')?.textContent ?? null) : null,
              overlay: !document.querySelector('.narwal-replay-gap').hidden,
              mediaSec: state.audio?.mediaSec ?? null,
              audioAt: audio.currentTime,
              audioPaused: audio.paused,
            };
          }),
        );
        await sleep(40);
      }
      await page.evaluate(() => globalThis.__narwalReplay.player.pause());

      // Page: the tick shown puts the page within [N s, N+1 s); its distance from the clock is the page error.
      let pageWorst = 0;
      let pageSamples = 0;
      for (const s of samples) {
        if (s.shown === null) continue;
        const n = Number(s.shown.split(' ')[1]);
        const err = s.t < n * 1000 ? n * 1000 - s.t : s.t >= (n + 1) * 1000 ? s.t - (n + 1) * 1000 : 0;
        pageWorst = Math.max(pageWorst, err);
        pageSamples++;
      }
      // While playing, rrweb runs on its own timer and is corrected only beyond AUDIO_SYNC_TOLERANCE_MS.
      c.ok(`play ${what}: page within ${AUDIO_SYNC_TOLERANCE_MS} ms of the clock (worst ${pageWorst.toFixed(1)} ms, ${pageSamples} samples)`, pageSamples > 20 && pageWorst <= AUDIO_SYNC_TOLERANCE_MS, { pageWorst, pageSamples });

      // Narration: after it has had AUDIO_SETTLE (400 ms) to start, it stays within the tolerance of its true time.
      let audioWorst = 0;
      let audioSamples = 0;
      const audioErrors = [];
      let startedAt = null;
      for (const s of samples) {
        if (s.mediaSec === null || s.audioPaused) {
          startedAt = null;
          continue;
        }
        startedAt ??= s.t;
        if (s.t - startedAt < 450) continue;
        const err = (s.audioAt - trueMediaSec(s.t)) * 1000;
        audioErrors.push([Math.round(s.t), Math.round(err)]);
        audioWorst = Math.max(audioWorst, Math.abs(err));
        audioSamples++;
      }
      c.ok(`play ${what}: narration within ${AUDIO_SYNC_TOLERANCE_MS} ms of its true time (worst ${audioWorst.toFixed(1)} ms, ${audioSamples} samples)`, audioSamples > 10 && audioWorst <= AUDIO_SYNC_TOLERANCE_MS, { audioWorst, audioSamples, audioErrors });
      const gapSeen = samples.some((s) => s.overlay && s.shown === null);
      c.ok(`play ${what}: the gap is shown while playing`, gapSeen, samples.filter((s) => s.overlay).length);
      if (what === 'through the pause') {
        const silent = samples.filter((s) => s.t > PAUSE.startMs + 100 && s.t < PAUSE.endMs - 100);
        c.ok('play through the pause: narration is silent in the pause', silent.length > 5 && silent.every((s) => s.audioPaused), silent.slice(0, 3));
        c.ok('play through the pause: page comes back after it', samples.some((s) => s.t > PAUSE.endMs + 100 && s.shown === expectedTick(s.t)), samples.at(-1));
      } else {
        c.ok('play through the navigation: both pages were shown', samples.some((s) => s.shown && s.t < NAVIGATION_MS) && samples.some((s) => s.shown && s.t > NAVIGATION_MS + 100), samples.length);
      }
    }
    c.ok('play: no page errors', errors.length === 0, errors);
    await page.close();
  },

  async hostile(b, c, fx) {
    // The "recorded site": a local server that counts every request. A real
    // tab visits it first so the browser holds its cookie, as a signed-in user would.
    const site = fx.site;
    const control = await b.context.newPage();
    await control.goto(`${site.origin}/login`);
    const cookies = await b.context.cookies(site.origin);
    c.ok('control: the site set a session cookie', cookies.some((k) => k.name === 'session'), cookies);
    await control.close();
    c.ok('control: the counter sees an ordinary page load', site.hits.length === 1, site.hits);
    site.hits.length = 0;

    const archive = await packBundle(hostileFiles(site));
    const file = join(fx.dir, 'hostile.narwal.zip');
    await writeFile(file, archive);

    const { page, errors } = await openReplay(b);
    await page.evaluate(() => {
      globalThis.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => globalThis.__violations.push(e.blockedURI));
    });
    await page.setInputFiles('#file', file);
    await waitForPlayer(page);
    for (const t of [100, 3000, 9000]) await seekAndRead(page, t);
    await page.evaluate(() => globalThis.__narwalReplay.player.play());
    await sleep(1500);
    // Try the handlers and the link the way a viewer might.
    const frameEl = page.frameLocator('.replayer-wrapper iframe');
    await frameEl.locator('#handler').hover({ timeout: 2000 }).catch(() => {});
    await frameEl.locator('#js-link').click({ timeout: 2000, force: true }).catch(() => {});
    await page.evaluate(() => globalThis.__narwalReplay.player.pause());
    await sleep(1000);

    const seen = await page.evaluate(async () => {
      const { player } = globalThis.__narwalReplay;
      const frame = player.frame;
      const doc = frame?.contentDocument;
      return {
        sandbox: frame?.getAttribute('sandbox') ?? null,
        topPwned: globalThis.__pwned ?? null,
        framePwned: frame?.contentWindow?.__pwned ?? null,
        storage: await chrome.storage.local.get('pwned'),
        scripts: doc ? doc.querySelectorAll('script').length : -1,
        // rrweb writes the frame with document.open(), which gives it this page's URL.
        frameUrl: frame?.contentWindow?.location.href ?? null,
        frameDoc: doc?.querySelector('#doc')?.textContent ?? null,
        notices: [...document.querySelectorAll('#notices p')].map((p) => p.textContent),
        violations: globalThis.__violations,
        stillHere: location.pathname,
      };
    });
    const storageAll = await page.evaluate(() => chrome.storage.local.get(null));
    c.ok('hostile: replay frame sandbox is exactly allow-same-origin', seen.sandbox === 'allow-same-origin', seen.sandbox);
    c.ok('hostile: no recorded script or handler ran in the extension page', seen.topPwned === null, seen.topPwned);
    c.ok('hostile: no recorded script ran in the replay frame', seen.framePwned === null, seen.framePwned);
    c.ok('hostile: nothing was written to extension storage', !('pwned' in seen.storage) && !('pwned' in storageAll), storageAll);
    c.ok('hostile: recorded scripts are inert in the rebuilt page', seen.scripts === 0, seen.scripts);
    c.ok('hostile: the replay frame was not navigated', seen.frameUrl === page.url() && seen.frameDoc === 'first page', { url: seen.frameUrl, doc: seen.frameDoc });
    c.ok('hostile: the replay page was not navigated', seen.stillHere === '/replay.html', seen.stillHere);
    c.ok('hostile: zero requests reached the recorded site', site.hits.length === 0, site.hits);
    c.ok('hostile: the missing files are shown, not silent', seen.notices.some((n) => /files are not loaded: replay never contacts the recorded site/.test(n)), seen.notices);
    c.ok('hostile: no page errors', errors.length === 0, errors);
    await page.close();
    // The counter is still live: the zero above is a measurement.
    const after = await b.context.newPage();
    await after.goto(`${site.origin}/after`);
    await after.close();
    c.ok('control: the counter still counts after the hostile replay', site.hits.length === 1 && site.hits[0].path === '/after' && site.hits[0].cookie, site.hits);
  },
};

async function startSite() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url, cookie: /session=/.test(req.headers.cookie ?? '') });
    if (req.url === '/login') res.setHeader('set-cookie', 'session=secret; Path=/; HttpOnly; SameSite=Lax');
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>site</title>ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(scenarios);
  const dir = await mkdtemp(join(tmpdir(), 'narwal-replay-files-'));
  const site = await startSite();
  const results = { ticket: 16549, ranAt: new Date().toISOString(), node: process.version, headless: !process.env.HEADED, tolerances: { PAGE_TOLERANCE_MS, AUDIO_SYNC_TOLERANCE_MS }, scenarios: {} };
  let failed = 0;
  try {
    for (const name of names) {
      const fn = scenarios[name];
      if (!fn) throw new Error(`unknown scenario ${name}`);
      const started = Date.now();
      const c = new Checks();
      const b = await launch();
      try {
        await fn(b, c, { dir, site });
        results.scenarios[name] = { ms: Date.now() - started, checks: c.list };
      } catch (err) {
        results.scenarios[name] = { ms: Date.now() - started, error: String(err && err.stack), checks: c.list };
        failed += 1;
        console.log(`ERROR ${name}: ${err.message}`);
      } finally {
        await b.close();
      }
      for (const ch of results.scenarios[name].checks) {
        if (!ch.pass) failed += 1;
        console.log(`${ch.pass ? 'PASS' : 'FAIL'} ${name}: ${ch.label}${ch.pass ? '' : ` got=${JSON.stringify(ch.got)}`}`);
      }
    }
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(RESULTS, { recursive: true });
  const out = join(RESULTS, `replay-${results.ranAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
  const total = Object.values(results.scenarios).reduce((n, s) => n + s.checks.length, 0);
  console.log(`wrote ${out}`);
  console.log(failed ? `E2E FAILED: ${failed} failing of ${total} checks` : `E2E PASSED: ${total} checks`);
  process.exitCode = failed ? 1 : 0;
}

await main();
