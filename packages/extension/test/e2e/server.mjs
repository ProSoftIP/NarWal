// Fixture server for the recorder e2e run. Serves site/ on two origins so
// cross-origin navigation is real: A = http://127.0.0.1:<port>,
// B = http://localhost:<port>. Local only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('./site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const VERBOSE = fileURLToPath(new URL('../../../transcription/fixtures/openai/verbose-short.json', import.meta.url));

// A stand-in for OpenAI's transcriptions endpoint (board #16588): answers with
// the whisper-1 fixture after `delayMs`. `fail` lists the answers of the next
// uploads instead: 401 (the key refused, with the key starred out as OpenAI
// writes it) or 429 (busy, with a Retry-After too long to wait for). It keeps
// whether the key matched and what the form held, never the key itself.
export const openai = {
  key: null,
  fail: [],
  delayMs: 0,
  uploads: [],
  reset({ key, fail = [], delayMs = 0 }) {
    Object.assign(this, { key, fail: [...fail], delayMs, uploads: [] });
  },
};

async function transcriptions(req, res) {
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = Buffer.concat(parts);
  const text = body.toString('latin1');
  const fields = Object.fromEntries([...text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)].map((m) => [m[1], m[2]]));
  const sent = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const upload = {
    keyMatched: Boolean(openai.key) && sent === openai.key,
    bytes: body.length,
    file: /name="file"; filename="([^"]+)"/.exec(text)?.[1] ?? null,
    model: fields.model ?? null,
    status: 200,
  };
  openai.uploads.push(upload);
  await new Promise((r) => setTimeout(r, openai.delayMs));
  const status = upload.keyMatched ? openai.fail.shift() : 401;
  if (status === 429) {
    upload.status = 429;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '600' }).end(JSON.stringify({ error: { message: 'Rate limit reached for whisper-1.', type: 'requests', code: 'rate_limit_exceeded' } }));
    return;
  }
  if (status) {
    upload.status = 401;
    const masked = `${sent.slice(0, 8)}${'*'.repeat(Math.max(0, sent.length - 12))}${sent.slice(-4)}`;
    const message = `Incorrect API key provided: ${masked}. You can find your API key at https://platform.openai.com/account/api-keys.`;
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(await readFile(VERBOSE));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/openai/v1/audio/transcriptions' && req.method === 'POST') {
    await transcriptions(req, res);
    return;
  }
  if (url.pathname === '/submit' && req.method === 'POST') {
    req.resume();
    req.on('end', () => res.writeHead(303, { location: '/result.html' }).end());
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
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

export async function startFixtures() {
  const servers = [createServer(handle), createServer(handle)];
  await new Promise((r) => servers[0].listen(0, '127.0.0.1', r));
  await new Promise((r) => servers[1].listen(0, '127.0.0.1', r));
  return {
    A: `http://127.0.0.1:${servers[0].address().port}`,
    B: `http://localhost:${servers[1].address().port}`,
    openai,
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}
