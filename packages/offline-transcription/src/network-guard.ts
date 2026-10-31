// Network guard for the offline engine workers (board #16544).
//
// An engine worker may load its own packaged files and nothing else. Every
// other request is refused and recorded, so "no cloud traffic" is a property
// the worker enforces, not a habit of the code it runs. Model files come from
// the verified local store through `serve`.

export interface NetworkAttempt {
  api: 'fetch' | 'xhr' | 'websocket' | 'eventsource' | 'webtransport' | 'beacon';
  url: string;
  /** `own-origin`: a packaged file. `local-store`: served from the model store. `blocked`: refused. */
  outcome: 'own-origin' | 'local-store' | 'blocked';
}

export interface NetworkGuardOptions {
  /** Answers a request from local storage; undefined falls through to the origin check. */
  serve?: (url: URL) => Promise<Response | undefined>;
  /** `data:` and `blob:` URLs are not network. `reject` makes a runtime use its own decoder. */
  inlineUrls?: 'pass' | 'reject';
}

export interface NetworkGuard {
  attempts: NetworkAttempt[];
}

interface GuardedScope {
  location: { origin: string; href: string };
  fetch: typeof fetch;
  [key: string]: unknown;
}

export function installNetworkGuard(scope: GuardedScope, options: NetworkGuardOptions = {}): NetworkGuard {
  const attempts: NetworkAttempt[] = [];
  const origin = scope.location.origin;
  const realFetch = scope.fetch.bind(scope);
  const refuse = (api: NetworkAttempt['api'], url: string): never => {
    attempts.push({ api, url, outcome: 'blocked' });
    throw new TypeError(`NarWal offline engine: ${api} to ${url} refused (offline engines make no network requests)`);
  };
  const resolve = (input: unknown): URL => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    return new URL(raw, scope.location.href);
  };

  scope.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolve(input);
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      if (options.inlineUrls === 'reject') throw new TypeError('inline URL fetch is disabled in this worker');
      return realFetch(input, init);
    }
    const served = await options.serve?.(url);
    if (served) {
      attempts.push({ api: 'fetch', url: url.href, outcome: 'local-store' });
      return served;
    }
    if (url.origin !== origin) return refuse('fetch', url.href);
    attempts.push({ api: 'fetch', url: url.href, outcome: 'own-origin' });
    return realFetch(input, init);
  }) as typeof fetch;

  const refusing = (api: NetworkAttempt['api']) =>
    function Refused(url: unknown) {
      refuse(api, String(url));
    };
  if ('WebSocket' in scope) scope.WebSocket = refusing('websocket');
  if ('EventSource' in scope) scope.EventSource = refusing('eventsource');
  if ('WebTransport' in scope) scope.WebTransport = refusing('webtransport');
  const xhr = scope.XMLHttpRequest as { prototype: { open: (...args: unknown[]) => void } } | undefined;
  if (xhr) {
    const open = xhr.prototype.open;
    xhr.prototype.open = function guardedOpen(this: unknown, ...args: unknown[]) {
      const url = resolve(args[1]);
      if (url.protocol !== 'data:' && url.protocol !== 'blob:') {
        if (url.origin !== origin) refuse('xhr', url.href);
        attempts.push({ api: 'xhr', url: url.href, outcome: 'own-origin' });
      }
      return open.apply(this, args);
    };
  }
  const nav = scope.navigator as { sendBeacon?: unknown } | undefined;
  if (nav && typeof nav.sendBeacon === 'function') {
    try {
      Object.defineProperty(nav, 'sendBeacon', { value: (url: unknown) => refuse('beacon', String(url)) });
    } catch {
      // Not configurable here; the extension CSP still blocks it.
    }
  }
  return { attempts };
}
