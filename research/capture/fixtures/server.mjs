// Fixture server for the NarWal capture probe (board #16538).
// Serves the same static site on two origins so cross-origin navigation and
// cross-site iframes are real: ORIGIN_A = http://127.0.0.1:<portA>,
// ORIGIN_B = http://localhost:<portB>. Never point the probe at production.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('./site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function handler(origins) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/slow.png') {
      const ms = Math.min(Number(url.searchParams.get('ms') || 2000), 10000);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      }, ms);
      return;
    }
    if (url.pathname === '/submit' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.writeHead(303, { location: '/result.html' });
        res.end();
      });
      return;
    }
    if (url.pathname === '/origins.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      res.end(`window.NARWAL_ORIGINS = ${JSON.stringify(origins)};`);
      return;
    }
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path.startsWith('/spa/')) path = '/spa.html';
    const file = normalize(join(SITE, path));
    if (!file.startsWith(SITE)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  };
}

export async function startFixtures({ portA = 0, portB = 0 } = {}) {
  const origins = {};
  const a = createServer(handler(origins));
  const b = createServer(handler(origins));
  await new Promise((r) => a.listen(portA, '127.0.0.1', r));
  await new Promise((r) => b.listen(portB, '127.0.0.1', r));
  origins.A = `http://127.0.0.1:${a.address().port}`;
  origins.B = `http://localhost:${b.address().port}`;
  return { origins, close: () => Promise.all([a, b].map((s) => new Promise((r) => s.close(r)))) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origins } = await startFixtures({ portA: Number(process.env.PORT_A || 4801), portB: Number(process.env.PORT_B || 4802) });
  console.log(`fixtures: A=${origins.A}/  B=${origins.B}/`);
}
