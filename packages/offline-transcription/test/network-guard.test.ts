// Unit tests for the network guard of the offline engine workers (board
// #16544): src/network-guard.ts, installed on a stand-in worker scope. A worker
// may load its own packaged files and what `serve` answers from the model
// store; every other request is refused and recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installNetworkGuard } from '../src/network-guard.ts';
import type { NetworkAttempt, NetworkGuardOptions } from '../src/network-guard.ts';

const ORIGIN = 'https://extension.test';
const HREF = `${ORIGIN}/workers/whisper-worker.js`;

/** A worker scope with stand-ins that record every call that reaches them. */
function fakeScope() {
  const fetched: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  const constructed: string[] = [];
  const opened: unknown[][] = [];
  const beacons: string[] = [];
  const realResponse = new Response('from the real fetch');
  class FakeXhr {
    open(...args: unknown[]): string {
      opened.push(args);
      return 'opened';
    }
  }
  const scope = {
    location: { origin: ORIGIN, href: HREF },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push({ input, init });
      return realResponse;
    }) as typeof fetch,
    WebSocket: class {
      constructor(url: string | URL) {
        constructed.push(`WebSocket ${url}`);
      }
    },
    EventSource: class {
      constructor(url: string | URL) {
        constructed.push(`EventSource ${url}`);
      }
    },
    WebTransport: class {
      constructor(url: string | URL) {
        constructed.push(`WebTransport ${url}`);
      }
    },
    XMLHttpRequest: FakeXhr,
    navigator: {
      sendBeacon(url: string, _data?: unknown): boolean {
        beacons.push(url);
        return true;
      },
    },
  };
  return { scope, fetched, constructed, opened, beacons, realResponse };
}

function guarded(options?: NetworkGuardOptions) {
  const fake = fakeScope();
  const guard = installNetworkGuard(fake.scope, options);
  return { ...fake, guard };
}

const blocked = (api: NetworkAttempt['api'], url: string): NetworkAttempt => ({ api, url, outcome: 'blocked' });

const refusal = (api: string, url: string) => (error: unknown) => {
  assert.ok(error instanceof TypeError, `expected a TypeError, got ${String(error)}`);
  assert.ok(error.message.includes(`${api} to ${url} refused`), error.message);
  return true;
};

// --- fetch ---------------------------------------------------------------------------

test('an own-origin fetch reaches the real fetch unchanged and is recorded own-origin', async () => {
  const { scope, guard, fetched, realResponse } = guarded();
  const init: RequestInit = { method: 'GET', cache: 'force-cache' };
  const response = await scope.fetch(`${ORIGIN}/ort/ort-wasm-simd-threaded.wasm`, init);
  assert.equal(response, realResponse);
  assert.deepEqual(fetched, [{ input: `${ORIGIN}/ort/ort-wasm-simd-threaded.wasm`, init }]);
  assert.equal(fetched[0].init, init);
  assert.deepEqual(guard.attempts, [{ api: 'fetch', url: `${ORIGIN}/ort/ort-wasm-simd-threaded.wasm`, outcome: 'own-origin' }]);
});

test('a relative URL, a URL object and a Request are resolved against the worker location', async () => {
  const { scope, guard, fetched } = guarded();
  await scope.fetch('vosk.wasm');
  await scope.fetch('/ort/ort.wasm');
  await scope.fetch(new URL(`${ORIGIN}/a.bin`));
  await scope.fetch(new Request(`${ORIGIN}/b.bin`));
  assert.deepEqual(
    guard.attempts.map((attempt) => [attempt.url, attempt.outcome]),
    [
      [`${ORIGIN}/workers/vosk.wasm`, 'own-origin'],
      [`${ORIGIN}/ort/ort.wasm`, 'own-origin'],
      [`${ORIGIN}/a.bin`, 'own-origin'],
      [`${ORIGIN}/b.bin`, 'own-origin'],
    ],
  );
  assert.equal(fetched.length, 4);
  assert.equal(fetched[0].input, 'vosk.wasm', 'the real fetch gets the caller\'s own argument');
});

test('a request that serve answers is recorded local-store and never reaches the real fetch', async () => {
  const modelUrl = 'https://huggingface.co/onnx-community/whisper-base.en_timestamped/resolve/main/config.json';
  const asked: URL[] = [];
  const local = new Response('{"from":"model store"}');
  const { scope, guard, fetched } = guarded({
    serve: async (url) => {
      asked.push(url);
      return url.href === modelUrl ? local : undefined;
    },
  });

  const response = await scope.fetch(modelUrl);

  assert.equal(response, local);
  assert.equal(await response.text(), '{"from":"model store"}');
  assert.deepEqual(guard.attempts, [{ api: 'fetch', url: modelUrl, outcome: 'local-store' }]);
  assert.equal(fetched.length, 0);
  assert.ok(asked[0] instanceof URL);
  assert.equal(asked[0].href, modelUrl);
});

test('serve can answer an own-origin URL too; the real fetch is not called for it', async () => {
  const local = new Response('local');
  const { scope, guard, fetched } = guarded({ serve: async (url) => (url.pathname === '/models/model.tar.gz' ? local : undefined) });
  assert.equal(await scope.fetch('/models/model.tar.gz'), local);
  assert.equal(fetched.length, 0);
  assert.equal(guard.attempts[0].outcome, 'local-store');
});

test('a request serve does not answer falls through to the origin check', async () => {
  const { scope, guard, fetched, realResponse } = guarded({ serve: async () => undefined });
  assert.equal(await scope.fetch('/ort/ort.wasm'), realResponse);
  await assert.rejects(scope.fetch('https://huggingface.co/other/model.onnx'), refusal('fetch', 'https://huggingface.co/other/model.onnx'));
  assert.deepEqual(guard.attempts, [
    { api: 'fetch', url: `${ORIGIN}/ort/ort.wasm`, outcome: 'own-origin' },
    blocked('fetch', 'https://huggingface.co/other/model.onnx'),
  ]);
  assert.equal(fetched.length, 1);
});

test('a fetch to any other host is refused, recorded blocked and never sent', async () => {
  const { scope, guard, fetched } = guarded();
  const targets: [RequestInfo | URL, string][] = [
    ['https://api.deepgram.com/v1/listen', 'https://api.deepgram.com/v1/listen'],
    [new URL('https://huggingface.co/x/resolve/main/model.onnx'), 'https://huggingface.co/x/resolve/main/model.onnx'],
    [new Request('https://telemetry.test/collect', { method: 'POST', body: 'x' }), 'https://telemetry.test/collect'],
    ['//cdn.test/ort.wasm', 'https://cdn.test/ort.wasm'],
    ['http://extension.test/workers/whisper-worker.js', 'http://extension.test/workers/whisper-worker.js'],
    ['https://extension.test:8443/a', 'https://extension.test:8443/a'],
    ['https://extension.test.evil.test/a', 'https://extension.test.evil.test/a'],
    ['https://user@extension.test.evil.test/a', 'https://user@extension.test.evil.test/a'],
  ];
  for (const [input, url] of targets) {
    const call = scope.fetch(input);
    assert.ok(call instanceof Promise, 'fetch reports the refusal as a rejection, as fetch does');
    await assert.rejects(call, refusal('fetch', url));
  }
  assert.deepEqual(
    guard.attempts,
    targets.map(([, url]) => blocked('fetch', url)),
  );
  assert.equal(fetched.length, 0);
});

test('a serve that throws does not let the request through', async () => {
  const { scope, fetched } = guarded({
    serve: async () => {
      throw new Error('model store unavailable');
    },
  });
  await assert.rejects(scope.fetch('https://huggingface.co/x/config.json'), /model store unavailable/);
  await assert.rejects(scope.fetch('/ort/ort.wasm'), /model store unavailable/);
  assert.equal(fetched.length, 0);
});

// --- data: and blob: URLs -----------------------------------------------------------------

const INLINE = ['data:application/octet-stream;base64,AAEC', 'blob:https://extension.test/0b0c7d5e-5a3c-4d7a-9a51-0d3f2a6f8e11'];

test("inlineUrls 'reject' refuses data: and blob: fetches", async () => {
  const { scope, guard, fetched } = guarded({ inlineUrls: 'reject', serve: async () => new Response('never for inline URLs') });
  for (const url of INLINE) {
    await assert.rejects(scope.fetch(url), (error: unknown) => error instanceof TypeError && /inline URL fetch is disabled/.test(error.message));
  }
  assert.equal(fetched.length, 0);
  assert.deepEqual(guard.attempts, [], 'an inline URL is not a network attempt');
});

for (const options of [{ inlineUrls: 'pass' } as const, {}]) {
  test(`inlineUrls ${options.inlineUrls ? "'pass'" : 'unset'} lets data: and blob: fetches through`, async () => {
    const { scope, guard, fetched, realResponse } = guarded(options);
    for (const url of INLINE) assert.equal(await scope.fetch(url), realResponse);
    assert.deepEqual(
      fetched.map((call) => call.input),
      INLINE,
    );
    assert.deepEqual(guard.attempts, [], 'an inline URL is not a network attempt');
  });
}

test("inlineUrls 'reject' still allows own-origin files and still blocks other hosts", async () => {
  const { scope, guard } = guarded({ inlineUrls: 'reject' });
  await scope.fetch('/ort/ort.wasm');
  await assert.rejects(scope.fetch('https://cdn.test/ort.wasm'));
  assert.deepEqual(
    guard.attempts.map((attempt) => attempt.outcome),
    ['own-origin', 'blocked'],
  );
});

// --- WebSocket, EventSource, WebTransport, sendBeacon ---------------------------------------

test('WebSocket, EventSource and WebTransport to another host are refused and recorded', () => {
  const { scope, guard, constructed } = guarded();
  assert.throws(() => new scope.WebSocket('wss://api.deepgram.com/v1/listen'), refusal('websocket', 'wss://api.deepgram.com/v1/listen'));
  assert.throws(() => new scope.EventSource('https://events.test/stream'), refusal('eventsource', 'https://events.test/stream'));
  assert.throws(() => new scope.WebTransport('https://transport.test:4433/session'), refusal('webtransport', 'https://transport.test:4433/session'));
  assert.throws(() => new scope.WebSocket(new URL('wss://streaming.assemblyai.com/v3/ws')), refusal('websocket', 'wss://streaming.assemblyai.com/v3/ws'));
  assert.deepEqual(guard.attempts, [
    blocked('websocket', 'wss://api.deepgram.com/v1/listen'),
    blocked('eventsource', 'https://events.test/stream'),
    blocked('webtransport', 'https://transport.test:4433/session'),
    blocked('websocket', 'wss://streaming.assemblyai.com/v3/ws'),
  ]);
  assert.deepEqual(constructed, [], 'no real connection object was created');
});

test('a socket to the own host is refused as well: an engine has no use for one', () => {
  const { scope, guard, constructed } = guarded();
  assert.throws(() => new scope.WebSocket('wss://extension.test/socket'), TypeError);
  assert.throws(() => new scope.EventSource('/events'), TypeError);
  assert.deepEqual(
    guard.attempts.map((attempt) => [attempt.api, attempt.outcome]),
    [
      ['websocket', 'blocked'],
      ['eventsource', 'blocked'],
    ],
  );
  assert.deepEqual(constructed, []);
});

test('sendBeacon is refused and recorded', () => {
  const { scope, guard, beacons } = guarded();
  assert.throws(() => scope.navigator.sendBeacon('https://telemetry.test/collect', 'payload'), refusal('beacon', 'https://telemetry.test/collect'));
  assert.deepEqual(guard.attempts, [blocked('beacon', 'https://telemetry.test/collect')]);
  assert.deepEqual(beacons, []);
});

test('the guard adds no API the scope did not have', async () => {
  const fetched: unknown[] = [];
  const scope: { location: { origin: string; href: string }; fetch: typeof fetch; [key: string]: unknown } = {
    location: { origin: ORIGIN, href: HREF },
    fetch: (async (input: RequestInfo | URL) => {
      fetched.push(input);
      return new Response('ok');
    }) as typeof fetch,
  };
  const guard = installNetworkGuard(scope);
  assert.deepEqual(Object.keys(scope).sort(), ['fetch', 'location']);
  await scope.fetch('/a');
  await assert.rejects(scope.fetch('https://other.test/a'), TypeError);
  assert.deepEqual(
    guard.attempts.map((attempt) => attempt.outcome),
    ['own-origin', 'blocked'],
  );
  assert.equal(fetched.length, 1);
});

// --- XMLHttpRequest ----------------------------------------------------------------------------

test('XMLHttpRequest.open to another host is refused, recorded and never opened', () => {
  const { scope, guard, opened } = guarded();
  const xhr = new scope.XMLHttpRequest();
  assert.throws(() => xhr.open('GET', 'https://cdn.test/model.bin', true), refusal('xhr', 'https://cdn.test/model.bin'));
  assert.throws(() => xhr.open('POST', new URL('https://telemetry.test/collect')), refusal('xhr', 'https://telemetry.test/collect'));
  assert.throws(() => xhr.open('GET', '//cdn.test/x'), refusal('xhr', 'https://cdn.test/x'));
  assert.deepEqual(guard.attempts, [blocked('xhr', 'https://cdn.test/model.bin'), blocked('xhr', 'https://telemetry.test/collect'), blocked('xhr', 'https://cdn.test/x')]);
  assert.deepEqual(opened, []);
});

test('XMLHttpRequest.open to an own-origin file is passed on with its arguments and recorded', () => {
  const { scope, guard, opened } = guarded();
  const xhr = new scope.XMLHttpRequest();
  assert.equal(xhr.open('GET', 'vosk.data', true), 'opened');
  assert.deepEqual(opened, [['GET', 'vosk.data', true]]);
  assert.deepEqual(guard.attempts, [{ api: 'xhr', url: `${ORIGIN}/workers/vosk.data`, outcome: 'own-origin' }]);
});

test('XMLHttpRequest.open of a data: or blob: URL is passed on and is not a network attempt', () => {
  const { scope, guard, opened } = guarded();
  const xhr = new scope.XMLHttpRequest();
  for (const url of INLINE) xhr.open('GET', url);
  assert.equal(opened.length, 2);
  assert.deepEqual(guard.attempts, []);
});

// --- the attempt log -----------------------------------------------------------------------------

test('the attempt log keeps every attempt of every API in order', async () => {
  const local = new Response('model');
  const { scope, guard } = guarded({ serve: async (url) => (url.host === 'huggingface.co' ? local : undefined) });
  await scope.fetch('/ort/ort.wasm');
  await scope.fetch('https://huggingface.co/x/config.json');
  await assert.rejects(scope.fetch('https://cdn.test/a'));
  assert.throws(() => new scope.WebSocket('wss://cdn.test/s'));
  new scope.XMLHttpRequest().open('GET', '/vosk.data');
  assert.throws(() => scope.navigator.sendBeacon('https://cdn.test/b'));
  assert.deepEqual(
    guard.attempts.map((attempt) => `${attempt.api} ${attempt.outcome} ${attempt.url}`),
    [
      `fetch own-origin ${ORIGIN}/ort/ort.wasm`,
      'fetch local-store https://huggingface.co/x/config.json',
      'fetch blocked https://cdn.test/a',
      'websocket blocked wss://cdn.test/s',
      `xhr own-origin ${ORIGIN}/vosk.data`,
      'beacon blocked https://cdn.test/b',
    ],
  );
});

test('two guards on two scopes keep separate logs', async () => {
  const first = guarded();
  const second = guarded();
  await first.scope.fetch('/a');
  assert.equal(first.guard.attempts.length, 1);
  assert.equal(second.guard.attempts.length, 0);
});
