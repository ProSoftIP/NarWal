// Real-browser run of the start view and the recording strip (board #16551
// acceptance): first use, skipped instructions, denied microphone, missing
// model and key, disconnected provider, recording, stop and saved; keyboard
// use; and the controls staying out of an rrweb recording.
//
// Usage: node test/e2e/run.mjs [--only <text>]
// Screenshots go to test/e2e/results/. Exit 1 when a check fails.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDemoServer } from '../../demo/server.mjs';

const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';

const checks = [];
const check = (name, run) => checks.push({ name, run });

await rm(RESULTS, { recursive: true, force: true });
await mkdir(RESULTS, { recursive: true });
const server = await startDemoServer();
const browser = await chromium.launch();

const shot = (page, name, options = {}) => page.screenshot({ path: `${RESULTS}${name}.png`, ...options });

async function openStart(scenario, { colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width: 400, height: 640 }, colorScheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(`${server.origin}/demo/start.html?s=${scenario}`);
  await page.evaluate(() => window.__narwal.view.loaded);
  return page;
}

async function openStrip(scenario, { shadow = 'open', mount = 'now', width = 1280, height = 720 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(`${server.origin}/demo/page.html?s=${scenario}&shadow=${shadow}${mount === 'later' ? '&mount=later' : ''}`);
  if (mount === 'now') await page.waitForFunction(() => window.__narwal.strip && (window.__narwal.strip.host.isConnected || window.__narwal.port.status().phase === 'idle'));
  return page;
}

const calls = (page) => page.evaluate(() => window.__narwal.port.calls);
const callNames = async (page) => (await calls(page)).map((c) => c[0]);
const storedPrefs = (page) => page.evaluate(() => window.__narwal.area.data['narwal.prefs.v1'] || null);
const checkState = (page, id) => page.getAttribute(`[data-check="${id}"]`, 'data-state');
const startButton = (page) => page.getByRole('button', { name: 'Start recording' });
const focusedText = (page) =>
  page.evaluate(() => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    // A button with a wide and a narrow label is named by its aria-label.
    return el ? (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim() : '';
  });

/**
 * Start stays focusable and pressable when it is blocked (aria-disabled), so
 * it can say why. Playwright will not click an aria-disabled button; a
 * keyboard user can press it, so the run does the same.
 */
async function pressBlockedStart(page) {
  await startButton(page).focus();
  await page.keyboard.press('Enter');
}

/** Presses Tab (Shift+Tab when `back`) until the focused control's text is `text`. */
async function tabTo(page, text, { back = false, limit = 40 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    if ((await focusedText(page)) === text) return;
  }
  throw new Error(`Tab never reached "${text}"; stopped on "${await focusedText(page)}"`);
}

// ---------------------------------------------------------------- start view

check('first use: Start shows the instructions; Start now records; the skip tick is saved', async () => {
  const page = await openStart('first-use');
  assert.deepEqual([await checkState(page, 'tab'), await checkState(page, 'mic'), await checkState(page, 'transcript')], ['ok', 'ok', 'ok']);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  const logo = await page.locator('.nw-head .nw-logo').boundingBox();
  assert.deepEqual([logo.width, logo.height], [32, 32], 'the NarWal logo heads the start view (board #16597)');
  const tagline = await page.locator('.nw-tagline').boundingBox();
  assert.ok(tagline.height < 25, `the tagline is one line (${tagline.height}px)`);
  const top = async (selector) => (await page.locator(selector).first().boundingBox()).y;
  const startTop = (await startButton(page).boundingBox()).y;
  assert.ok(startTop < (await top('.nw-checks')), 'Start is above the readiness checks (board #16601)');
  assert.ok(startTop < (await top('.nw-choices')) && startTop < (await top('.nw-purpose')), 'Start is above the transcript choice and the purpose');
  assert.ok(startTop < (await page.getByRole('button', { name: 'How recording works' }).boundingBox()).y, 'How recording works stays below Start');
  await shot(page, 'start-first-use-light', { fullPage: true });

  // The optional purpose (#16594) goes with Start, trimmed.
  assert.equal(await page.locator('.nw-purpose-count').textContent(), '0 / 1000');
  await page.getByLabel('What is this recording for?').fill('  Each mark is a change request  ');
  assert.equal(await page.locator('.nw-purpose-count').textContent(), '33 / 1000', 'the purpose field counts its characters');
  await startButton(page).click();
  assert.equal(await page.isVisible('.nw-instructions'), true);
  assert.equal(await page.isVisible('.nw-setup'), false);
  assert.deepEqual(await callNames(page), [], 'nothing records before Start now');
  assert.equal(await focusedText(page), 'How recording works', 'focus moves to the instructions');
  assert.equal(await page.locator('.nw-step').count(), 6);
  const steps = await page.locator('.nw-steps').innerText();
  for (const fact of ['Right-click an item to mark it', 'hold Shift and right-click', 'Alt+Shift+M', 'Hold the right mouse button and drag', 'Press Esc while you drag']) {
    assert.ok(steps.includes(fact), `instructions say: ${fact}`);
  }
  const startNowTop = (await page.getByRole('button', { name: 'Start now' }).boundingBox()).y;
  assert.ok(startNowTop < (await top('.nw-steps')) && startNowTop < (await page.getByRole('button', { name: 'Back' }).boundingBox()).y, 'Start now is above the steps and Back (board #16601)');
  await shot(page, 'start-instructions-light', { fullPage: true });

  assert.equal(await storedPrefs(page), null);
  await page.getByLabel("Don't show instructions again").check();
  assert.equal((await storedPrefs(page)).skipInstructions, true, 'saved when ticked');

  await page.getByRole('button', { name: 'Start now' }).click();
  assert.deepEqual(await calls(page), [['start', { transcription: 'offline', purpose: 'Each mark is a change request' }]]);
  assert.equal(await page.isVisible('.nw-active'), true);
  assert.equal(await page.locator('.nw-active h2').textContent(), 'Recording this tab');
  await shot(page, 'start-while-recording-light', { fullPage: true });
  await page.context().close();
});

check('first use with the keyboard only', async () => {
  const page = await openStart('first-use');
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Start recording', 'Start is the first control of the start view (board #16601)');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('.nw-instructions'), true);
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Start now', 'Start now comes right after the instructions title (board #16601)');
  await tabTo(page, 'nw-skip');
  await page.keyboard.press('Space');
  assert.equal((await storedPrefs(page)).skipInstructions, true);
  await tabTo(page, 'Start now', { back: true });
  await page.keyboard.press('Enter');
  assert.deepEqual(await callNames(page), ['start']);
  assert.equal(await focusedText(page), 'Recording this tab');
  await tabTo(page, 'Stop recording');
  await page.keyboard.press('Enter');
  assert.deepEqual(await callNames(page), ['start', 'stop']);
  assert.equal(await page.locator('.nw-active h2').textContent(), 'Saving the recording');
  await page.context().close();
});

check('skipped instructions: Start records at once; the instructions can still be opened', async () => {
  const page = await openStart('skipped');
  await page.getByRole('button', { name: 'How recording works' }).click();
  assert.equal(await page.isVisible('.nw-instructions'), true);
  assert.equal(await page.getByLabel("Don't show instructions again").isChecked(), true);
  await page.getByRole('button', { name: 'Back' }).click();
  assert.equal(await page.isVisible('.nw-setup'), true);
  assert.deepEqual(await callNames(page), []);

  await startButton(page).click();
  assert.deepEqual(await calls(page), [['start', { transcription: 'offline', purpose: '' }]]);
  assert.equal(await page.isVisible('.nw-instructions'), false);
  await page.context().close();
});

check('unticking the skip brings the instructions back', async () => {
  const page = await openStart('skipped');
  await page.getByRole('button', { name: 'How recording works' }).click();
  await page.getByLabel("Don't show instructions again").uncheck();
  assert.equal((await storedPrefs(page)).skipInstructions, false);
  await page.getByRole('button', { name: 'Back' }).click();
  await startButton(page).click();
  assert.equal(await page.isVisible('.nw-instructions'), true);
  assert.deepEqual(await callNames(page), []);
  await page.context().close();
});

check('microphone not asked yet: Allow microphone asks, then Start is ready', async () => {
  const page = await openStart('mic-prompt');
  assert.equal(await checkState(page, 'mic'), 'todo');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  await shot(page, 'start-mic-not-asked-light', { fullPage: true });
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  assert.deepEqual(await callNames(page), ['requestMic']);
  assert.equal(await checkState(page, 'mic'), 'ok');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  await page.context().close();
});

check('denied microphone: Start does not record and says why', async () => {
  const page = await openStart('mic-denied');
  assert.equal(await checkState(page, 'mic'), 'blocked');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  const why = await page.locator('#nw-why').innerText();
  assert.match(why, /[Mm]icrophone/);
  const detail = await page.locator('[data-check="mic"] .nw-check-detail').innerText();
  assert.match(detail, /no narration can be recorded/);
  await shot(page, 'start-mic-denied-light', { fullPage: true });
  await pressBlockedStart(page);
  assert.equal(await page.isVisible('.nw-instructions'), false);
  assert.deepEqual((await callNames(page)).filter((n) => n === 'start'), []);
  await page.context().close();
});

check('missing speech model: says the size, downloads on request, then Start is ready', async () => {
  const page = await openStart('model-missing');
  assert.equal(await checkState(page, 'transcript'), 'todo');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  const body = await page.locator('#nw-choice-body-offline').innerText();
  assert.match(body, /one-time download/);
  assert.match(body, /The download is about 44 MB\./);
  await shot(page, 'start-model-missing-light', { fullPage: true });

  // Start is not a dead end: it moves focus to the thing to do.
  await pressBlockedStart(page);
  assert.match(await focusedText(page), /^Download speech model/);
  assert.deepEqual(await callNames(page), [], 'no download without the user asking');

  await page.keyboard.press('Enter');
  assert.deepEqual(await callNames(page), ['downloadModel']);
  await page.waitForSelector('[data-check="transcript"][data-state="busy"]');
  assert.equal(await page.locator('.nw-progress').count(), 1);
  await page.waitForSelector('[data-check="transcript"][data-state="ok"]');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  await page.context().close();
});

check('the chosen speech model is named with its measured bars; Choose model asks the port (board #16611)', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openStart('model-chosen', { colorScheme });
    const pick = page.locator('#nw-choice-body-offline .nw-model-pick');
    assert.equal(await pick.getAttribute('data-model'), 'whisper-small.en-q8');
    assert.match(await pick.innerText(), /Model: Whisper small\.en/);
    assert.equal(await pick.getByRole('img', { name: 'Accuracy: 4 of 5' }).count(), 1);
    assert.equal(await pick.getByRole('img', { name: 'Speed: 3 of 5' }).count(), 1);
    assert.equal(await pick.locator('.nw-rating-on').count(), 7);
    await shot(page, `start-model-chosen-${colorScheme}`, { fullPage: true });
    await pick.getByRole('button', { name: 'Choose model' }).click();
    assert.deepEqual(await callNames(page), ['chooseModel']);
    await page.context().close();
  }
});

check('speech model downloading and failed states', async () => {
  const busy = await openStart('model-downloading');
  assert.match(await busy.locator('[data-check="transcript"] .nw-check-title').innerText(), /42%/);
  assert.equal(await startButton(busy).getAttribute('aria-disabled'), 'true');
  await shot(busy, 'start-model-downloading-light', { fullPage: true });
  await busy.context().close();

  const failed = await openStart('model-failed');
  assert.match(await failed.locator('[data-check="transcript"] .nw-check-detail').innerText(), /download stopped at 43%/);
  assert.equal(await failed.getByRole('button', { name: /Try the download again|Download/ }).count(), 1);
  await shot(failed, 'start-model-failed-light', { fullPage: true });
  await failed.context().close();
});

check('missing key: Start goes to the key field; the saved key does not stay in the page', async () => {
  const page = await openStart('key-missing');
  assert.equal(await page.locator('#nw-choice-deepgram').isChecked(), true);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  const body = await page.locator('#nw-choice-body-deepgram').innerText();
  assert.match(body, /your microphone audio is sent to Deepgram/);
  assert.match(body, /Deepgram charges your Deepgram account/);
  await shot(page, 'start-key-missing-light', { fullPage: true });

  await pressBlockedStart(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nw-key-deepgram');
  assert.equal(await page.getAttribute('#nw-key-deepgram', 'type'), 'password');

  const secret = 'dg-test-key-0123456789';
  await page.keyboard.type(secret);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#nw-choice-body-deepgram .nw-key-saved:not([hidden])');
  assert.deepEqual(await calls(page), [['saveKey', 'deepgram', secret.length]]);
  const leftovers = await page.evaluate((key) => {
    const inputs = [...document.querySelectorAll('input')].map((i) => i.value).join('|');
    return { inDom: document.documentElement.outerHTML.includes(key), inInputs: inputs.includes(key), inPrefs: JSON.stringify(window.__narwal.area.data).includes(key) };
  }, secret);
  assert.deepEqual(leftovers, { inDom: false, inInputs: false, inPrefs: false });
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  await shot(page, 'start-key-saved-light', { fullPage: true });

  await page.getByRole('button', { name: 'Remove Deepgram key' }).click();
  assert.deepEqual((await calls(page)).at(-1), ['removeKey', 'deepgram']);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  await page.context().close();
});

check('choosing a provider is remembered, and no provider is picked for the user', async () => {
  const page = await openStart('first-use');
  assert.equal(await page.locator('#nw-choice-offline').isChecked(), true, 'the default sends nothing anywhere');
  await page.locator('#nw-choice-assemblyai').check();
  assert.equal((await storedPrefs(page)).transcription, 'assemblyai');
  assert.equal(await page.isVisible('#nw-choice-body-assemblyai'), true);
  assert.equal(await page.isVisible('#nw-choice-body-offline'), false);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true', 'no key yet');
  // Arrow keys move through the choices like any radio group.
  await page.locator('#nw-choice-assemblyai').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal((await storedPrefs(page)).transcription, 'openai');
  await shot(page, 'start-openai-after-recording-light', { fullPage: true });
  assert.equal(await checkState(page, 'transcript'), 'note');
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false', 'OpenAI needs no key to record');
  await page.context().close();
});

check('provider chosen but the computer is offline: blocked, with the way out', async () => {
  const page = await openStart('provider-offline');
  assert.equal(await checkState(page, 'transcript'), 'blocked');
  assert.match(await page.locator('[data-check="transcript"] .nw-check-detail').innerText(), /On this computer/);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  await shot(page, 'start-provider-no-internet-light', { fullPage: true });
  await page.context().close();
});

check('a tab that cannot be recorded', async () => {
  const page = await openStart('restricted-tab');
  assert.equal(await checkState(page, 'tab'), 'blocked');
  assert.match(await page.locator('[data-check="tab"] .nw-check-detail').innerText(), /Open a website first/);
  await shot(page, 'start-tab-cannot-be-recorded-light', { fullPage: true });
  await page.context().close();
});

check('hidden areas: offered for a recordable tab, with the count (#16592)', async () => {
  const page = await openStart('skipped');
  const section = page.locator('section[aria-labelledby="nw-hide-title"]');
  assert.match(await section.innerText(), /Nothing hidden/);
  await page.getByRole('button', { name: 'Hide areas' }).click();
  assert.deepEqual(await calls(page), [['pickRegions']]);
  assert.match(await section.innerText(), /1 area of this page will be left out of the recording/);
  assert.equal(await page.locator('[data-key="hide-areas"]').innerText(), 'Change hidden areas');
  await shot(page, 'start-hidden-area-light', { fullPage: true });
  await page.context().close();
  const blocked = await openStart('restricted-tab');
  assert.equal(await blocked.locator('section[aria-labelledby="nw-hide-title"]').isHidden(), true);
  await blocked.context().close();
});

check('a hidden area the page lost blocks Start until it is picked again (#16592)', async () => {
  const page = await openStart('hidden-lost');
  assert.equal(await checkState(page, 'hidden'), 'todo');
  assert.match(await page.locator('[data-check="hidden"]').innerText(), /1 hidden area could not be found/);
  assert.match(await page.locator('section[aria-labelledby="nw-hide-title"]').innerText(), /1 hidden area could not be found on the page/);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'true');
  await shot(page, 'start-hidden-area-lost-light', { fullPage: true });
  await page.locator('[data-check="hidden"]').getByRole('button', { name: 'Pick again' }).click();
  assert.deepEqual(await calls(page), [['pickRegions']]);
  assert.equal(await page.locator('[data-check="hidden"]').count(), 0);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  await page.context().close();
});

check('saved: the start view offers Export and the recording, and is ready for another', async () => {
  const page = await openStart('saved');
  assert.match(await page.locator('.nw-banner').innerText(), /saved on this computer/);
  assert.deepEqual(await page.locator('.nw-banner button').allInnerTexts(), ['Export', 'Open recording'], 'Export first (#16602)');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  assert.deepEqual(await calls(page), [['exportRecording', 'rec-demo-1']]);
  await page.getByRole('button', { name: 'Open recording' }).click();
  assert.deepEqual((await calls(page)).at(-1), ['openRecording', 'rec-demo-1']);
  assert.equal(await startButton(page).getAttribute('aria-disabled'), 'false');
  await shot(page, 'start-saved-light', { fullPage: true });
  await page.context().close();
});

check('saved with OpenAI: Export says it waits for the transcript, and a press is kept (#16602, #16622)', async () => {
  const page = await openStart('saved-openai-uploading');
  const waiting = page.locator('[data-key="export"]');
  assert.equal(await waiting.innerText(), 'Export when the transcript is ready');
  assert.equal(await waiting.getAttribute('aria-disabled'), null, 'the press is not refused');
  // The recordings page it opens waits for the transcript, then downloads (#16622).
  await waiting.click();
  assert.deepEqual(await calls(page), [['exportRecording', 'rec-demo-1']]);
  await shot(page, 'start-saved-openai-uploading-light', { fullPage: true });
  await page.evaluate(() => window.__narwal.port.set({ afterTranscript: { state: 'done', activated: true } }));
  const ready = page.locator('[data-key="export"]');
  assert.equal(await ready.innerText(), 'Export');
  await ready.click();
  assert.deepEqual((await calls(page)).at(-1), ['exportRecording', 'rec-demo-1']);
  // A refused export says why, in words (#16622).
  await page.evaluate(() => {
    window.__narwal.port.exportRecording = async () => {
      throw new Error('not allowed from this page');
    };
  });
  await ready.click();
  assert.equal(await page.locator('.nw-error').innerText(), 'That did not work: not allowed from this page');
  await page.context().close();
});

check('dark colour scheme screenshots', async () => {
  for (const scenario of ['first-use', 'key-missing', 'mic-denied']) {
    const page = await openStart(scenario, { colorScheme: 'dark' });
    await shot(page, `start-${scenario}-dark`, { fullPage: true });
    if (scenario === 'first-use') {
      await startButton(page).click();
      await shot(page, 'start-instructions-dark', { fullPage: true });
    }
    await page.context().close();
  }
});

// --------------------------------------------------------------------- strip

const stripInfo = (page) =>
  page.evaluate(() => {
    const host = window.__narwal.strip.host;
    const root = host.shadowRoot;
    const rect = host.getBoundingClientRect();
    const bar = root.querySelector('.bar').getBoundingClientRect();
    const visible = (el) => !el.hidden && el.getClientRects().length > 0;
    return {
      connected: host.isConnected,
      parent: host.parentElement && host.parentElement.tagName,
      display: getComputedStyle(host).display,
      position: getComputedStyle(host).position,
      color: getComputedStyle(root.querySelector('.bar')).color,
      bottomGap: Math.round(window.innerHeight - rect.bottom),
      barHeight: Math.round(bar.height),
      barWidth: Math.round(bar.width),
      logo: (() => {
        const logo = root.querySelector('.state .nw-logo');
        return logo && { width: Math.round(logo.getBoundingClientRect().width), height: Math.round(logo.getBoundingClientRect().height), hidden: logo.getAttribute('aria-hidden') };
      })(),
      tone: root.querySelector('.wrap').dataset.tone,
      time: root.querySelector('.time').textContent,
      message: root.querySelector('.message-text').textContent,
      note: root.querySelector('.note').hidden ? '' : root.querySelector('.note').textContent,
      announce: root.querySelector('.sr').textContent,
      panelOpen: !root.querySelector('.panel').hidden,
      expanded: root.querySelector('.toggle').getAttribute('aria-expanded'),
      buttons: [...root.querySelectorAll('.btn')].filter(visible).map((b) => b.innerText),
      lines: [...root.querySelectorAll('.line')].map((l) => l.textContent),
      overflowing: [...root.querySelectorAll('.btn')].filter(visible).some((b) => b.getBoundingClientRect().right > window.innerWidth + 0.5),
    };
  });
const stripShot = (page, name) => shot(page, name, { clip: { x: 0, y: page.viewportSize().height - 300, width: page.viewportSize().width, height: 300 } });

check('recording: one line at the bottom, with the time, the newest words and Stop', async () => {
  const page = await openStrip('recording');
  const info = await stripInfo(page);
  assert.equal(info.parent, 'HTML');
  assert.equal(info.position, 'fixed');
  assert.notEqual(info.display, 'none', 'a page rule cannot hide the controls');
  assert.notEqual(info.color, 'rgb(255, 0, 0)', 'page colours do not leak in');
  assert.equal(info.bottomGap, 0);
  assert.ok(info.barHeight <= 40, `one line high (${info.barHeight}px)`);
  assert.equal(info.barHeight, 34, 'the logo does not make the strip taller (board #16597)');
  assert.deepEqual(info.logo, { width: 16, height: 16, hidden: 'true' }, 'the NarWal logo at 16 px, decorative');
  assert.equal(info.barWidth, 1280);
  assert.match(info.time, /^02:1\d$/);
  assert.match(info.message, /and I would expect this button to$/);
  assert.equal(info.panelOpen, false, 'the transcript is closed until asked for');
  assert.deepEqual(info.buttons, ['Transcript', 'Stop']);
  assert.equal(info.announce, '', 'transcript words are not read out by a screen reader on every change');
  // The newest words are the ones in view when the line is too long.
  const clipped = await page.evaluate(() => {
    const m = window.__narwal.strip.host.shadowRoot.querySelector('.message');
    return { scrolled: m.scrollLeft, over: m.scrollWidth - m.clientWidth };
  });
  assert.equal(Math.round(clipped.scrolled), Math.round(clipped.over));
  await shot(page, 'strip-recording-full-page');
  await stripShot(page, 'strip-recording');
  await page.context().close();
});

check('the clock runs between status updates', async () => {
  const page = await openStrip('recording');
  const before = (await stripInfo(page)).time;
  await page.waitForFunction((t) => window.__narwal.strip.host.shadowRoot.querySelector('.time').textContent !== t, before, { timeout: 5000 });
  await page.context().close();
});

check('keyboard: reach the strip with Tab, open and close the transcript, Stop, Open, Close', async () => {
  const page = await openStrip('recording');
  await page.focus('#page-button');
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Transcript', 'Tab from the last page control lands on the strip');
  const focusRing = await page.evaluate(() => {
    const b = window.__narwal.strip.host.shadowRoot.activeElement;
    const s = getComputedStyle(b);
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
  });
  assert.equal(focusRing, true, 'focus is visible');

  await page.keyboard.press('Enter');
  let info = await stripInfo(page);
  assert.equal(info.panelOpen, true);
  assert.equal(info.expanded, 'true');
  assert.equal(info.lines.length, 4);
  assert.match(info.lines[0], /^00:02So this is the payroll dashboard/);
  assert.ok(info.barHeight <= 40, 'the bar is still one line');
  await stripShot(page, 'strip-transcript-open');

  // A late word arrives while the panel is open.
  await page.evaluate(() => window.__narwal.port.emit({ type: 'segment', segment: { segmentKey: 's4', kind: 'final', startMs: 18400, endMs: 22000, text: 'And I would expect this button to open the pay run.' } }));
  await page.waitForFunction(() => /open the pay run\.$/.test(window.__narwal.strip.host.shadowRoot.querySelector('.log').textContent));

  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => window.__narwal.strip.host.shadowRoot.activeElement.className), 'btn stop');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Escape');
  info = await stripInfo(page);
  assert.equal(info.panelOpen, false);
  assert.equal(info.expanded, 'false');
  assert.equal(await focusedText(page), 'Transcript', 'Escape returns focus to the button that opened the panel');

  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Stop');
  await page.keyboard.press('Enter');
  assert.deepEqual(await callNames(page), ['stop']);
  info = await stripInfo(page);
  assert.equal(info.tone, 'busy');
  assert.deepEqual(info.buttons, ['Saving…']);
  await stripShot(page, 'strip-stopping');

  await page.evaluate(() => window.__narwal.port.set({ phase: 'saved', recordingId: 'rec-1' }));
  info = await stripInfo(page);
  assert.equal(info.tone, 'done');
  assert.equal(info.message, 'Saved on this computer.');
  assert.deepEqual(info.buttons, ['Export', 'Open recording', 'Close']);
  assert.match(info.announce, /saved on this computer/);
  await stripShot(page, 'strip-saved');

  // Export of the recording just saved comes first (#16602).
  await page.evaluate(() => window.__narwal.strip.focus());
  assert.equal(await focusedText(page), 'Export');
  await page.keyboard.press('Enter');
  assert.deepEqual((await calls(page)).at(-1), ['exportRecording', 'rec-1']);
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Open recording');
  await page.keyboard.press('Enter');
  assert.deepEqual((await calls(page)).at(-1), ['openRecording', 'rec-1']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__narwal.strip.host.isConnected), false, 'Close removes the strip');

  const leaked = await page.evaluate(() => window.__narwal.pageEvents.filter((e) => e.target === 'DIV' || ['Enter', 'Escape'].includes(e.key)));
  assert.deepEqual(leaked, [], 'page handlers saw none of the strip keys');
  await page.context().close();
});

check('mouse: a click on a control keeps focus in the page and is not seen by the page', async () => {
  const page = await openStrip('recording');
  await page.focus('#search');
  await page.keyboard.type('tech');
  await page.evaluate(() => (window.__narwal.pageEvents.length = 0));
  await page.locator('.btn.toggle').click();
  assert.equal((await stripInfo(page)).panelOpen, true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search', 'the page keeps focus');
  await page.keyboard.type('nician');
  assert.equal(await page.inputValue('#search'), 'technician');
  await page.locator('.btn.toggle').click();
  assert.equal((await stripInfo(page)).panelOpen, false);
  await page.locator('.btn.stop').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
  const seen = await page.evaluate(() => window.__narwal.pageEvents.filter((e) => e.type !== 'keydown'));
  assert.deepEqual(seen, [], 'no click or mousedown reached page handlers');
  await page.context().close();
});

check('disconnected provider: recording continues, retry is the same provider, the gap is shown', async () => {
  const page = await openStrip('disconnected');
  let info = await stripInfo(page);
  assert.equal(info.tone, 'warn');
  assert.match(info.message, /Deepgram closed the connection/);
  assert.match(info.message, /Recording continues/);
  assert.deepEqual(info.buttons, ['Try transcript again', 'Transcript', 'Stop']);
  assert.equal(info.announce, info.message, 'the problem is announced once');
  await stripShot(page, 'strip-provider-disconnected');

  // The focus shortcut goes to Stop even when Try again comes first.
  await page.evaluate(() => window.__narwal.strip.focus());
  assert.equal(await focusedText(page), 'Stop', 'focus() picks Stop while recording');

  await page.locator('.btn.toggle').click();
  info = await stripInfo(page);
  assert.match(info.lines.at(-1), /No transcript from 00:21 to 00:34: connection lost\. The recording has this part\./);
  await stripShot(page, 'strip-provider-disconnected-transcript-open');

  await page.locator('.btn.retry').click();
  assert.deepEqual(await calls(page), [['retryTranscript']], 'retry only; no other provider is started');
  info = await stripInfo(page);
  assert.match(info.message, /Connecting to Deepgram/);
  assert.equal(info.buttons.includes('Try transcript again'), false);
  await page.context().close();
});

check('every other strip state reads right and stays one line', async () => {
  const expected = {
    listening: { tone: 'recording', message: /Listening/, buttons: ['Transcript', 'Stop'] },
    connecting: { tone: 'recording', message: /Connecting to Deepgram/, buttons: ['Transcript', 'Stop'] },
    reconnecting: { tone: 'warn', message: /Recording continues/, buttons: ['Transcript', 'Stop'] },
    behind: { tone: 'recording', message: /expect this button to$/, note: 'Transcript is behind', buttons: ['Transcript', 'Stop'] },
    'after-recording': { tone: 'recording', message: /after you stop/, buttons: ['Stop'] },
    'mic-lost': { tone: 'warn', message: /Microphone stopped/, buttons: ['Transcript', 'Stop'] },
    stopping: { tone: 'busy', message: /Saving/, buttons: ['Saving…'] },
    saved: { tone: 'done', message: /^Saved on this computer\.$/, buttons: ['Export', 'Open recording', 'Close'] },
    'openai-uploading': { tone: 'busy', message: /Getting the transcript from OpenAI/, buttons: ['Export when the transcript is ready', 'Open recording', 'Close'], exportDisabled: false },
    'openai-ready': { tone: 'done', message: /The OpenAI transcript is ready/, buttons: ['Export', 'Open recording', 'Close'], exportDisabled: false },
    failed: { tone: 'error', message: /out of storage space.*part before this is saved/, buttons: ['Open recording', 'Close'] },
  };
  for (const [scenario, want] of Object.entries(expected)) {
    const page = await openStrip(scenario);
    const info = await stripInfo(page);
    assert.equal(info.tone, want.tone, scenario);
    assert.match(info.message, want.message, scenario);
    assert.deepEqual(info.buttons, want.buttons, scenario);
    if (want.note) assert.equal(info.note, want.note, scenario);
    if ('exportDisabled' in want) assert.equal(await page.evaluate(() => window.__narwal.strip.host.shadowRoot.querySelector('.btn.export').disabled), want.exportDisabled, scenario);
    assert.ok(info.barHeight <= 40, `${scenario}: one line (${info.barHeight}px)`);
    assert.equal(info.overflowing, false, scenario);
    await stripShot(page, `strip-${scenario}`);
    await page.context().close();
  }
});

check('strip: a refused Export says why on the line, until the next press (#16622)', async () => {
  const page = await openStrip('saved');
  await page.evaluate(() => {
    window.__narwal.port.exportRecording = async () => {
      throw new Error('not allowed from this page');
    };
  });
  await page.evaluate(() => window.__narwal.strip.host.shadowRoot.querySelector('.btn.export').click());
  await page.waitForFunction(() => window.__narwal.strip.host.shadowRoot.querySelector('.message-text').textContent.startsWith('That did not work'));
  let info = await stripInfo(page);
  assert.equal(info.message, 'That did not work: not allowed from this page');
  assert.equal(info.tone, 'warn');
  assert.deepEqual(info.buttons, ['Export', 'Open recording', 'Close'], 'Export can be pressed again');
  await stripShot(page, 'strip-export-refused');
  await page.evaluate(() => window.__narwal.strip.host.shadowRoot.querySelector('.btn.open').click());
  info = await stripInfo(page);
  assert.equal(info.message, 'Saved on this computer.', 'the next press clears the words');
  await page.context().close();
});

check('no recording: no strip in the page', async () => {
  const page = await openStrip('idle');
  assert.equal(await page.evaluate(() => window.__narwal.strip.host.isConnected), false);
  assert.equal(await page.locator('[data-narwal-ui]').count(), 0);
  // It appears when a recording starts.
  await page.evaluate(() => window.__narwal.port.start({ transcription: 'offline' }));
  assert.equal(await page.locator('[data-narwal-ui]').count(), 1);
  await page.context().close();
});

check('narrow window: still one line, Stop still on screen', async () => {
  const page = await openStrip('disconnected', { width: 420, height: 700 });
  const info = await stripInfo(page);
  assert.ok(info.barHeight <= 40, `one line (${info.barHeight}px)`);
  assert.equal(info.overflowing, false, 'no control is pushed off screen');
  assert.deepEqual(info.buttons, ['Try again', 'Transcript', 'Stop']);
  assert.equal(await page.getByRole('button', { name: 'Try transcript again' }).count(), 1, 'the short label keeps the full name');
  await stripShot(page, 'strip-provider-disconnected-narrow-window');
  await page.context().close();
});

check('a page that rewrites <html> does not lose the controls', async () => {
  const page = await openStrip('recording');
  await page.evaluate(() => document.documentElement.replaceChildren(document.head, document.body));
  await page.waitForFunction(() => window.__narwal.strip.host.isConnected);
  assert.deepEqual((await stripInfo(page)).buttons, ['Transcript', 'Stop']);
  await page.context().close();
});

check('the controls are closed to the page', async () => {
  const page = await openStrip('recording', { shadow: 'closed' });
  const seen = await page.evaluate(() => {
    const host = document.querySelector('[data-narwal-ui]');
    return { root: host.shadowRoot, text: host.textContent, html: host.innerHTML, inBody: document.body.innerText.includes('Stop') };
  });
  assert.deepEqual(seen, { root: null, text: '', html: '', inBody: false });
  await page.context().close();
});

// ---------------------------------------------------------- capture exclusion

const STRIP_WORDS = ['payroll dashboard, and the first thing', 'Transcript so far', 'Try transcript again', 'NarWal recording controls', 'This should collapse'];

/** Records the fixture page with real rrweb while the strip is used. */
async function recordWithStrip(mount) {
  const page = await openStrip('recording', { shadow: 'closed', mount });
  await page.addScriptTag({ url: `${server.origin}/node_modules/rrweb/dist/rrweb.umd.min.cjs` });
  await page.evaluate(async () => {
    const { RRWEB_RECORD_OPTIONS } = await import('/src/index.js');
    window.__events = [];
    window.__stop = window.rrweb.record({ emit: (event) => window.__events.push(event), ...RRWEB_RECORD_OPTIONS });
  });
  if (mount === 'later') {
    await page.evaluate(() => window.__narwal.mount());
    await page.waitForFunction(() => window.__narwal.strip.host.isConnected);
  }
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-narwal-ui]').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // Use the controls: pointer over them, a click on them, keys in them,
  // and new words arriving in them.
  await page.mouse.move(300, 200);
  await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 6 });
  await page.mouse.click(box.x + 200, box.y + box.height / 2);
  await page.evaluate(() => window.__narwal.strip.focus());
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__narwal.port.emit({ type: 'segment', segment: { segmentKey: 's9', kind: 'final', startMs: 30000, endMs: 33000, text: 'These words are only in the strip.' } }));
  await page.mouse.wheel(0, 200);
  await page.keyboard.press('Escape');
  // Use the page too: these must survive the filter.
  await page.click('#page-button');
  await page.fill('#search', 'totals');
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'added-by-page';
    p.textContent = 'Payroll run started';
    document.querySelector('main').append(p);
    // A toast library that appends to <html>, next to the controls.
    const toast = document.createElement('aside');
    toast.id = 'page-toast';
    toast.textContent = 'Saved';
    document.documentElement.insertBefore(toast, document.querySelector('[data-narwal-ui]'));
  });
  await page.evaluate(() => new Promise((done) => setTimeout(done, 700)));
  await page.evaluate(() => window.__stop());
  const result = await page.evaluate(async () => {
    const { createCaptureFilter } = await import('/src/index.js');
    const filter = createCaptureFilter();
    return { raw: window.__events, kept: window.__events.map((e) => filter(e)).filter(Boolean) };
  });
  return { page, ...result };
}

/** Every node id the events define, and every id they point at. */
function idAudit(events) {
  const defined = new Set();
  const dangling = [];
  const define = (node) => {
    defined.add(node.id);
    for (const child of node.childNodes || []) define(child);
  };
  const need = (id, where) => {
    if (typeof id === 'number' && id > 0 && !defined.has(id)) dangling.push(`${where}:${id}`);
  };
  for (const event of events) {
    if (event.type === 2) {
      defined.clear();
      define(event.data.node);
    } else if (event.type === 3) {
      const d = event.data;
      if (d.source === 0) {
        for (const add of d.adds) define(add.node);
        for (const add of d.adds) {
          need(add.parentId, 'add.parent');
          need(add.nextId, 'add.next');
        }
        for (const r of d.removes) need(r.id, 'remove');
        for (const t of d.texts) need(t.id, 'text');
        for (const a of d.attributes) need(a.id, 'attribute');
      } else if (d.positions) {
        for (const p of d.positions) need(p.id, 'position');
      } else {
        need(d.id, `source${d.source}`);
      }
    }
  }
  return dangling;
}

for (const mount of ['now', 'later']) {
  check(`rrweb recording, strip mounted ${mount === 'now' ? 'before' : 'after'} capture starts: nothing of the controls is kept`, async () => {
    const { page, raw, kept } = await recordWithStrip(mount);
    const rawText = JSON.stringify(raw);
    const keptText = JSON.stringify(kept);

    // rrweb alone (closed root + blockSelector) keeps the controls' content
    // out, but leaves a placeholder and pointer events on it.
    for (const words of [...STRIP_WORDS, 'These words are only in the strip.']) {
      assert.equal(rawText.includes(words), false, `raw events do not hold "${words}"`);
    }
    assert.equal(rawText.includes('"class":"narwal-ui"'), true, 'rrweb records a placeholder for the host: the filter is needed');

    // After the filter there is no trace at all.
    assert.equal(keptText.includes('narwal-ui'), false);
    assert.equal(/narwal/i.test(keptText), false, 'no NarWal string in what is stored');
    assert.deepEqual(idAudit(kept), [], 'no kept event points at a removed node');
    assert.ok(kept.length < raw.length || rawText.length > keptText.length, 'the filter removed something');

    // The page's own activity is all still there.
    assert.ok(keptText.includes('added-by-page'), 'page mutation kept');
    assert.ok(keptText.includes('page-toast'), 'node added next to the controls kept');
    assert.ok(kept.some((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2), 'page click kept');
    assert.ok(kept.some((e) => e.type === 3 && e.data.source === 5 && e.data.text === 'totals'), 'page input kept');
    assert.equal(raw.filter((e) => e.type === 2).length, kept.filter((e) => e.type === 2).length, 'every snapshot kept');

    // Replay what was kept: the replayed page has the page, not the controls.
    const replayed = await page.evaluate(async (events) => {
      const root = document.createElement('div');
      document.body.append(root);
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => warnings.push(args.map(String).join(' '));
      const replayer = new window.rrweb.Replayer(events, { root, showWarning: true, mouseTail: false });
      replayer.pause(events.at(-1).timestamp - events[0].timestamp);
      await new Promise((done) => setTimeout(done, 300));
      console.warn = warn;
      const doc = root.querySelector('iframe').contentDocument;
      return {
        ui: doc.querySelectorAll('[data-narwal-ui]').length,
        title: doc.querySelector('#page-title') && doc.querySelector('#page-title').textContent,
        added: Boolean(doc.querySelector('#added-by-page')),
        toastParent: doc.querySelector('#page-toast') && doc.querySelector('#page-toast').parentElement.tagName,
        htmlChildren: [...doc.documentElement.children].map((c) => c.tagName),
        warnings,
      };
    }, kept);
    assert.equal(replayed.ui, 0);
    assert.equal(replayed.title, 'Dashboard');
    assert.equal(replayed.added, true);
    assert.equal(replayed.toastParent, 'HTML');
    assert.deepEqual(replayed.warnings.filter((w) => /not found|missing|Node with id/i.test(w)), [], 'replay found every node');
    await page.context().close();
  });
}

check('interaction capture can tell a strip event from a page event', async () => {
  const page = await openStrip('recording', { shadow: 'closed' });
  await page.evaluate(async () => {
    const { isNarwalUiEvent } = await import('/src/index.js');
    window.__seen = [];
    // Capture phase on window: what a gesture recorder (board #16543) uses.
    window.addEventListener('pointerdown', (event) => window.__seen.push(isNarwalUiEvent(event)), true);
  });
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-narwal-ui]').getBoundingClientRect();
    return { x: r.x, y: r.y, height: r.height };
  });
  await page.mouse.click(box.x + 200, box.y + box.height / 2);
  await page.mouse.click(300, 200);
  assert.deepEqual(await page.evaluate(() => window.__seen), [true, false]);
  await page.context().close();
});

// ----------------------------------------------------------------------- run

let failed = 0;
let ran = 0;
for (const { name, run } of checks) {
  if (only && !name.includes(only)) continue;
  ran += 1;
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error && error.stack ? error.stack : error).split('\n').slice(0, 12).join('\n     ')}`);
  }
}
await browser.close();
await server.close();
console.log(failed ? `E2E FAILED ${failed}/${ran}` : `E2E PASSED ${ran}/${ran}`);
process.exit(failed ? 1 : 0);
