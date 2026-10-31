// NarWal capture probe harness (board #16538).
// Loads the probe extension into Playwright's Chromium, drives the fixture
// site through each scenario, and writes measurements to results/.
// Usage: node harness/run.mjs [scenario ...]   (default: all)
// Env: SOAK_SECONDS (default 120), HEADED=1 to watch, OUT=<file stem>.
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from '../fixtures/server.mjs';
import { summarise, textCaptured, documents } from './analyze.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ fakeUi = true, extraArgs = [] } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'narwal-probe-'));
  const args = [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--use-fake-device-for-media-stream',
    ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : []),
    ...extraArgs,
  ];
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args,
    // Playwright disables the back/forward cache by default; real browsers do not.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    extensionId,
    version: context.browser() ? context.browser().version() : null,
    async worker() {
      const live = context.serviceWorkers().filter((w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
      if (live.length) return live[live.length - 1];
      return context.waitForEvent('serviceworker', { timeout: 10000 });
    },
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

async function tabIdOf(browser, page) {
  const sw = await browser.worker();
  const url = page.url();
  return sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u) || tabs.find((x) => x.active);
    return t ? t.id : null;
  }, url);
}

async function startRec(browser, page, options = {}) {
  const tabId = await tabIdOf(browser, page);
  const sw = await browser.worker();
  const reply = await sw.evaluate(([id, o]) => globalThis.narwalProbe.start(id, o), [tabId, options]);
  if (!reply || !reply.ok) throw new Error(`start failed: ${JSON.stringify(reply)}`);
  return reply;
}

async function stopRec(browser) {
  const sw = await browser.worker();
  await sw.evaluate(() => globalThis.narwalProbe.stop());
  const dump = await sw.evaluate(() => globalThis.narwalProbe.dump());
  await sw.evaluate(() => globalThis.narwalProbe.closeOffscreen());
  return dump.session;
}

// Ground truth: a marker paragraph inserted in the page's main world.
async function mark(page, expected, label, note) {
  const at = await page.evaluate((l) => window.narwalFixture.mark(l), label);
  expected.push({ label, at, note });
}

// Insert a marker and navigate in the same task, so the marker is the last
// thing that happens in the old document.
async function markThenNavigate(page, expected, label, url) {
  const at = await page.evaluate(([l, u]) => {
    const t = window.narwalFixture.mark(l);
    location.href = u;
    return t;
  }, [label, url]);
  expected.push({ label, at, note: 'inserted in the same task as the navigation' });
  await page.waitForURL(url, { waitUntil: 'load' });
}

// Map each child-frame stream to the parent's <iframe> rrweb node through the
// window.frames index both sides report.
function stitch(session, parentDoc) {
  if (!parentDoc) return null;
  const census = parentDoc.probes.find((p) => p.type === 'census');
  if (!census) return null;
  const children = session.log.filter((e) => e.k === 'hello' && !e.boot.isTop && e.boot.url !== 'about:blank');
  return children.map((h) => {
    const el = census.frames.find((f) => f.frameIndex === h.boot.frameIndex);
    const srcMatches = el ? (el.srcdoc ? h.boot.url === 'about:srcdoc' : Boolean(el.src) && h.boot.url.endsWith(el.src.replace(/^https?:\/\/[^/]+/, ''))) : false;
    return { childUrl: h.boot.url, frameIndex: h.boot.frameIndex, parentIframeRrId: el ? el.rrId : null, srcMatches };
  });
}

const scenarios = {
  // Full navigations: same-origin link, cross-origin, reload, back/forward, POST-redirect.
  async navigation({ browser, origins }, bfcachePolicy = 'detach') {
    const page = await browser.context.newPage();
    const expected = [];
    const bfcacheNotUsed = [];
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (e) => bfcacheNotUsed.push(e.notRestoredExplanations.map((x) => `${x.type}:${x.reason}`)));
    await page.goto(`${origins.A}/index.html`);
    await startRec(browser, page, { recordAfter: 'load', bfcachePolicy });
    await sleep(500);
    await mark(page, expected, 'index-1');
    await markThenNavigate(page, expected, 'index-last', `${origins.A}/page2.html`);
    await mark(page, expected, 'page2-1');
    await sleep(300);
    await page.goBack({ waitUntil: 'commit' });
    await sleep(500);
    await mark(page, expected, 'after-back');
    await page.goForward({ waitUntil: 'commit' });
    await sleep(500);
    await mark(page, expected, 'after-forward');
    await page.reload({ waitUntil: 'load' });
    await mark(page, expected, 'after-reload');
    await markThenNavigate(page, expected, 'before-cross-origin', `${origins.B}/page2.html`);
    await mark(page, expected, 'cross-origin-1');
    await page.goto(`${origins.A}/form.html`);
    await page.fill('#name', 'typed-value-should-be-masked');
    await Promise.all([page.waitForURL(`${origins.A}/result.html`), page.click('#submit')]);
    await mark(page, expected, 'after-post-redirect');
    await sleep(1000);
    const session = await stopRec(browser);
    const typedLeak = textCaptured(session, 'typed-value-should-be-masked');
    await page.close();
    return { summary: summarise(session, expected), checks: { typedValueInRecording: typedLeak, bfcacheNotUsed }, session };
  },

  // Same journey, but the content script lets Chrome close the port on bfcache entry.
  async navigationNaiveBfcache(ctx) {
    return scenarios.navigation(ctx, 'naive');
  },

  // Control for navigation: back/forward with no recording active.
  async bfcacheControl({ browser, origins }) {
    const page = await browser.context.newPage();
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Page.enable');
    const notUsed = [];
    cdp.on('Page.backForwardCacheNotUsed', (e) => notUsed.push(e.notRestoredExplanations.map((x) => `${x.type}:${x.reason}`)));
    await page.goto(`${origins.A}/index.html`);
    await page.goto(`${origins.A}/page2.html`);
    await page.goBack({ waitUntil: 'commit' });
    await sleep(300);
    const persisted = await page.evaluate(() => performance.getEntriesByType('navigation')[0].type);
    await page.close();
    return { summary: { navTypeAfterBack: persisted, bfcacheNotUsed: notUsed } };
  },

  async spa({ browser, origins }) {
    const page = await browser.context.newPage();
    const expected = [];
    await page.goto(`${origins.A}/spa.html`);
    await startRec(browser, page, { recordAfter: 'load' });
    await sleep(500);
    await page.click('#route-1');
    await mark(page, expected, 'route-1');
    await page.click('#route-2');
    await mark(page, expected, 'route-2');
    await page.click('#hash');
    await mark(page, expected, 'hash');
    await page.goBack();
    await sleep(300);
    await mark(page, expected, 'popstate');
    await sleep(800);
    const session = await stopRec(browser);
    const docs = documents(session).filter((d) => d.isTop);
    const routes = session.log.filter((e) => e.k === 'probe' && e.type === 'route').map((e) => e.url);
    const rrMeta = session.log.filter((e) => e.k === 'rr' && e.e.type === 4).map((e) => e.e.data.href);
    await page.close();
    return { summary: summarise(session, expected), checks: { topDocuments: docs.length, navigationApiRoutes: routes, rrwebMetaHrefs: rrMeta }, session };
  },

  // recordAfter 'load' vs 'DOMContentLoaded' on a page whose load waits 2.5 s.
  async slowLoad({ browser, origins }) {
    const out = {};
    for (const recordAfter of ['load', 'DOMContentLoaded']) {
      const page = await browser.context.newPage();
      const expected = [];
      await page.goto(`${origins.A}/index.html`);
      await startRec(browser, page, { recordAfter });
      await sleep(300);
      await page.goto(`${origins.A}/slow.html`, { waitUntil: 'domcontentloaded' });
      await mark(page, expected, `before-load-${recordAfter}`, 'inserted after DOMContentLoaded, before load');
      await page.waitForLoadState('load');
      await mark(page, expected, `after-load-${recordAfter}`);
      await sleep(500);
      const session = await stopRec(browser);
      out[recordAfter] = summarise(session, expected);
      await page.close();
    }
    return { summary: out };
  },

  // Recorded tab hidden behind another tab; a second tab must not be captured.
  async tabSwitch({ browser, origins }) {
    const page = await browser.context.newPage();
    const expected = [];
    await page.goto(`${origins.A}/index.html`);
    await startRec(browser, page, { recordAfter: 'load' });
    await page.evaluate(() => window.narwalFixture.startTicker(200));
    await sleep(2000);
    const other = await browser.context.newPage();
    await other.goto(`${origins.A}/page2.html`);
    await other.bringToFront();
    await mark(other, expected, 'other-tab', 'must NOT be captured');
    const hiddenStart = Date.now();
    await sleep(6000);
    const hiddenVisibility = await page.evaluate(() => document.visibilityState);
    await page.bringToFront();
    const hiddenMs = Date.now() - hiddenStart;
    await sleep(2000);
    const [popup] = await Promise.all([browser.context.waitForEvent('page'), page.click('#new-tab')]);
    await popup.waitForLoadState('load');
    await mark(popup, expected, 'popup-tab', 'opened by the recorded tab; must NOT be captured');
    await sleep(1000);
    await page.evaluate(() => window.narwalFixture.stopTicker());
    const session = await stopRec(browser);
    const ticks = new Set();
    for (const e of session.log) if (e.k === 'rr') for (const m of JSON.stringify(e.e).matchAll(/tick-(\d+)/g)) ticks.add(Number(m[1]));
    const maxTick = Math.max(...ticks);
    await Promise.all([page.close(), other.close(), popup.close()]);
    return {
      summary: summarise(session, expected),
      checks: { hiddenMs, recordedTabVisibilityWhileHidden: hiddenVisibility, ticksCaptured: ticks.size, ticksMax: maxTick, tickPeriodMs: 200 },
      session,
    };
  },

  // Pages a content script cannot run in, then back to a normal page.
  async restricted({ browser, origins }) {
    const page = await browser.context.newPage();
    const expected = [];
    await page.goto(`${origins.A}/index.html`);
    await startRec(browser, page, { recordAfter: 'load' });
    await sleep(300);
    const visits = [];
    for (const url of ['chrome://version/', 'about:blank', 'data:text/html,<p>marker:data-url</p>', `view-source:${origins.A}/page2.html`, 'http://127.0.0.1:9/unreachable']) {
      let error = null;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 5000 });
      } catch (err) {
        error = err.message.split('\n')[0];
      }
      await sleep(700);
      visits.push({ url, gotoError: error });
    }
    expected.push({ label: 'data-url', note: 'data: URL in the recorded tab' });
    await page.goto(`${origins.A}/page2.html`);
    await mark(page, expected, 'back-to-fixture');
    await sleep(500);
    const session = await stopRec(browser);
    await page.close();
    return { summary: summarise(session, expected), checks: { visits }, session };
  },

  async frames({ browser, origins }) {
    const out = {};
    for (const recordCrossOriginIframes of [false, true]) {
      const page = await browser.context.newPage();
      await page.goto(`${origins.A}/index.html`);
      await startRec(browser, page, { recordAfter: 'load', recordCrossOriginIframes });
      await page.goto(`${origins.A}/frames.html`, { waitUntil: 'load' });
      await sleep(2500);
      await page.frameLocator('#cross').locator('#child').evaluate((el) => el.append(' cross-mutation'));
      await sleep(800);
      const relayMessagesSeenByPage = await page.evaluate(() => window.__relayMessages);
      const session = await stopRec(browser);
      const docs = documents(session);
      const framesDoc = docs.find((d) => d.isTop && d.url.endsWith('/frames.html'));
      // Which document streams carried a needle (text node content, not attributes).
      const streamsWith = (needle) =>
        [...new Set(session.log.filter((e) => e.k === 'rr' && JSON.stringify(e.e).includes(needle)).map((e) => docs.find((d) => d.ports.includes(e.port))).filter(Boolean).map((d) => (d.isTop ? 'top' : `frame:${d.url}`)))];
      out[`recordCrossOriginIframes=${recordCrossOriginIframes}`] = {
        frameStreams: docs.filter((d) => d.url !== 'about:blank' || d.rrEvents > 0).map((d) => ({ url: d.url, frameId: d.frameId, rrEvents: d.rrEvents })),
        sameOriginChildText: streamsWith(`"textContent":"${origins.A}"`),
        crossOriginChildText: streamsWith(`"textContent":"${origins.B}"`),
        crossOriginMutation: streamsWith('cross-mutation'),
        srcdocText: streamsWith('"textContent":"srcdoc-content"'),
        relayMessagesSeenByPage,
        census: framesDoc ? framesDoc.probes.find((p) => p.type === 'census') || null : null,
        stitching: stitch(session, framesDoc),
      };
      await page.close();
    }
    return { summary: out };
  },

  async canvas({ browser, origins }) {
    const out = {};
    for (const recordCanvas of [false, true]) {
      const page = await browser.context.newPage();
      await page.goto(`${origins.A}/canvas.html`);
      await startRec(browser, page, { recordAfter: 'load', recordCanvas, canvasFps: 4 });
      await sleep(5000);
      const session = await stopRec(browser);
      const top = documents(session).find((d) => d.isTop);
      const canvasEvents = session.log.filter((e) => e.k === 'rr' && e.e.type === 3 && e.e.data && e.e.data.source === 9).length;
      out[`recordCanvas=${recordCanvas}`] = { seconds: 5, rrEvents: top.rrEvents, rrBytes: top.rrBytes, canvasMutationEvents: canvasEvents };
      await page.close();
    }
    return { summary: out };
  },

  async shadow({ browser, origins }) {
    const page = await browser.context.newPage();
    await page.goto(`${origins.A}/shadow.html`);
    await startRec(browser, page, { recordAfter: 'load' });
    await sleep(2500);
    const session = await stopRec(browser);
    const top = documents(session).find((d) => d.isTop);
    await page.close();
    return {
      summary: {
        openShadowTextCaptured: textCaptured(session, 'open-shadow-text'),
        closedShadowTextCaptured: textCaptured(session, 'closed-shadow-text'),
        census: top.probes.find((p) => p.type === 'census') || null,
      },
    };
  },

  // Service worker stopped mid-recording: capture must not depend on it.
  async workerRestart({ browser, origins }) {
    const page = await browser.context.newPage();
    const expected = [];
    await page.goto(`${origins.A}/index.html`);
    await startRec(browser, page, { recordAfter: 'load' });
    await sleep(500);
    await mark(page, expected, 'before-sw-stop');
    const reportPage = await browser.context.newPage();
    await reportPage.goto(`chrome-extension://${browser.extensionId}/report.html`);
    const cdp = await browser.context.newCDPSession(reportPage);
    let stopResult = 'stopAllWorkers sent';
    try {
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
    } catch (err) {
      stopResult = `failed: ${err.message}`;
    }
    await reportPage.close();
    await page.bringToFront();
    await sleep(1500);
    const workersAfterStop = browser.context.serviceWorkers().length;
    await mark(page, expected, 'while-sw-stopped');
    await markThenNavigate(page, expected, 'before-nav-after-sw-stop', `${origins.A}/page2.html`);
    await mark(page, expected, 'after-nav-sw-restarted');
    await sleep(800);
    const session = await stopRec(browser);
    await page.close();
    const workerBoots = [...new Set(session.log.filter((e) => e.k === 'nav' && e.workerBoot).map((e) => e.workerBoot))].length;
    return { summary: summarise(session, expected), checks: { stopResult, workersAfterStop, distinctWorkerBootsInLog: workerBoots }, session };
  },

  // Longer run for clock drift and loss: navigation every 20 s, marker every 5 s.
  async soak({ browser, origins }) {
    const seconds = Number(process.env.SOAK_SECONDS || 120);
    const page = await browser.context.newPage();
    const expected = [];
    await page.goto(`${origins.A}/index.html`);
    await startRec(browser, page, { recordAfter: 'DOMContentLoaded' });
    const t0 = Date.now();
    let n = 0;
    const pages = ['index.html', 'page2.html', 'spa.html', 'frames.html'];
    while (Date.now() - t0 < seconds * 1000) {
      n += 1;
      await mark(page, expected, `soak-${n}`);
      if (n % 4 === 0) await page.goto(`${origins.A}/${pages[(n / 4) % pages.length]}`);
      await sleep(5000);
    }
    const session = await stopRec(browser);
    await page.close();
    const summary = summarise(session, expected);
    return { summary: { ...summary, documents: `${summary.documents.length} documents` }, session };
  },
};

// Separate browsers: microphone denied, and revoked while recording.
const permissionScenarios = {
  async micDenied({ origins }) {
    const browser = await launch({ fakeUi: false, extraArgs: ['--deny-permission-prompts'] });
    try {
      const page = await browser.context.newPage();
      const expected = [];
      await page.goto(`${origins.A}/index.html`);
      const reply = await startRec(browser, page, { recordAfter: 'load' });
      await sleep(500);
      await mark(page, expected, 'dom-without-mic');
      await sleep(500);
      const session = await stopRec(browser);
      return { summary: { startReplyAudio: reply.audio, ...summarise(session, expected) }, version: browser.version };
    } finally {
      await browser.close();
    }
  },

  async micRevoked({ origins }) {
    // context.grantPermissions refuses chrome-extension:// ("opaque origins"),
    // so the harness uses the same control a user would: the extension's row
    // in chrome://settings site details, Allow before start, Block mid-recording.
    const browser = await launch({ fakeUi: false });
    try {
      const settings = await browser.context.newPage();
      const site = encodeURIComponent(`chrome-extension://${browser.extensionId}`);
      await settings.goto(`chrome://settings/content/siteDetails?site=${site}`);
      const mic = settings.locator('site-details-permission[label="Microphone"] select');
      await mic.selectOption('allow');
      const page = await browser.context.newPage();
      const expected = [];
      await page.goto(`${origins.A}/index.html`);
      const reply = await startRec(browser, page, { recordAfter: 'load' });
      await sleep(3000);
      await mic.selectOption('block');
      const revokedAt = Date.now();
      await sleep(4000);
      await mark(page, expected, 'after-revoke');
      const session = await stopRec(browser);
      return { session, summary: { grant: 'chrome://settings site details: Allow, then Block', revokedAfterMs: 3000, observedForMs: Date.now() - revokedAt, startReplyAudio: reply.audio, ...summarise(session, expected) } };
    } finally {
      await browser.close();
    }
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const all = [...Object.keys(scenarios), ...Object.keys(permissionScenarios)];
  const run = wanted.length ? wanted : all;
  const fixtures = await startFixtures();
  const browser = await launch();
  const results = { probe: 'NarWal capture probe (board #16538)', ranAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, headless: !process.env.HEADED, scenarios: {} };
  const raw = {};
  const page0 = browser.context.pages()[0];
  results.userAgent = page0 ? await page0.evaluate(() => navigator.userAgent) : null;
  try {
    for (const name of run) {
      const fn = scenarios[name] || permissionScenarios[name];
      if (!fn) throw new Error(`unknown scenario ${name}`);
      const started = Date.now();
      process.stdout.write(`scenario ${name} ... `);
      try {
        const r = await fn({ browser, origins: fixtures.origins });
        results.scenarios[name] = { ms: Date.now() - started, ...r, session: undefined };
        if (r.session) raw[name] = r.session;
        console.log(`done ${Date.now() - started} ms`);
      } catch (err) {
        results.scenarios[name] = { error: String(err && err.stack) };
        console.log(`ERROR ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    await fixtures.close();
  }
  const stem = process.env.OUT || `results/${results.ranAt.slice(0, 10)}-chromium-${results.userAgent ? results.userAgent.match(/Chrome\/(\d+)/)?.[1] : 'x'}-${process.platform}`;
  await mkdir(join(ROOT, 'results'), { recursive: true });
  await writeFile(join(ROOT, `${stem}.json`), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(ROOT, `${stem}.raw.json`), JSON.stringify(raw));
  console.log(`wrote ${stem}.json`);
  const failed = Object.entries(results.scenarios).filter(([, v]) => v.error).map(([k]) => k);
  console.log(failed.length ? `VERDICT=ERRORS scenarios=${failed.join(',')}` : 'VERDICT=RAN');
}

await main();
