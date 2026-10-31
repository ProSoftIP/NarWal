// Static server for the demo pages and the e2e run. Local only.
// Usage: node demo/server.mjs [port]   (default 4173)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const SERVED = ['demo', 'src', join('node_modules', 'rrweb', 'dist')];

export function startDemoServer(port = 0) {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)).replace(/^[/\\]+/, '');
    if (!SERVED.some((dir) => path.startsWith(dir + sep))) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await readFile(join(ROOT, path));
      response.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startDemoServer(Number(process.argv[2]) || 4173);
  console.log(`start view: ${origin}/demo/start.html?s=first-use`);
  console.log(`strip:      ${origin}/demo/page.html?s=recording`);
}
