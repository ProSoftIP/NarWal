// Serves the fixture pages with the bundled harness and drives them in real
// Chromium through Playwright.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { Observation } from '../src/index.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

export interface Fixture {
  browser: Browser;
  origin: string;
  open(path?: string): Promise<Page>;
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const bundle = await build({
    entryPoints: [`${here}fixtures/entry.ts`],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome116',
    logLevel: 'silent',
  });
  const js = bundle.outputFiles[0].text;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
      return;
    }
    // Same-document routes of the single-page fixture all serve page.html.
    const file = path.startsWith('/fixtures/') ? path.slice('/fixtures/'.length) : 'page.html';
    try {
      const body = await readFile(`${here}fixtures/${file.replace(/[^\w.-]/g, '')}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  return {
    browser,
    origin,
    async open(path = '/app/home') {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.goto(origin + path);
      return page;
    },
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function start(page: Page, exclusions: string[] = [], options: Record<string, number | boolean> = {}): Promise<void> {
  await page.evaluate(([e, o]) => (window as any).narwal.start(e, o), [exclusions, options] as const);
}

export function observations(page: Page): Promise<Observation[]> {
  return page.evaluate(() => (window as any).narwal.observations);
}

export async function waitFor<K extends Observation['kind']>(
  page: Page,
  kind: K,
  count = 1,
): Promise<Array<Extract<Observation, { kind: K }>>> {
  await page.waitForFunction(([k, n]) => (window as any).narwal.observations.filter((o: Observation) => o.kind === k).length >= n, [kind, count] as const, {
    timeout: 5000,
  });
  return (await observations(page)).filter((o): o is Extract<Observation, { kind: K }> => o.kind === kind);
}

/** Everything the page would hand to the bundle writer: the rrweb stream and the observations. */
export async function everything(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify([(window as any).narwal.events, (window as any).narwal.observations]));
}

export async function stop(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).narwal.stop());
}

export async function rectOf(page: Page, selector: string) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, scrollX: window.scrollX, scrollY: window.scrollY };
  });
}

export async function center(page: Page, selector: string) {
  const r = await rectOf(page, selector);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export async function pageLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).pageLog);
}

/** Asserts that every numeric field of `actual` is within `tolerance` CSS px of `expected`. */
export function near(value: object | undefined, expected: Record<string, number>, tolerance = 1): void {
  if (!value) throw new Error(`expected ${JSON.stringify(expected)}, got nothing`);
  const actual = value as Record<string, number>;
  for (const [k, v] of Object.entries(expected)) {
    if (Math.abs((actual[k] ?? NaN) - v) > tolerance) throw new Error(`${k}: ${actual[k]} is not within ${tolerance} of ${v} (${JSON.stringify(actual)})`);
  }
}
