// Runs first inside the packaged Vosk worker (build.mjs prepends it).
//
// The upstream worker downloads its model itself. Here the only thing it can
// load is the archive in the verified local store, hash-checked again on the
// way in; every other request is refused and recorded.

import { MODELS, VOSK_ARCHIVE, sha256Hex, storageKey, voskLoadUrl } from '../models.ts';
import { MODEL_CACHE_NAME } from '../model-store.ts';
import { installNetworkGuard } from '../network-guard.ts';

const scope = self as unknown as Parameters<typeof installNetworkGuard>[0] & {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};
const file = MODELS['vosk-small-en-us'].files[0];
const loadUrl = voskLoadUrl();

const guard = installNetworkGuard(scope, {
  inlineUrls: 'reject',
  async serve(url) {
    if (url.href !== loadUrl) return undefined;
    const cache = await caches.open(MODEL_CACHE_NAME);
    const stored = await cache.match(storageKey('vosk-small-en-us', VOSK_ARCHIVE));
    if (!stored) return new Response('model-missing', { status: 404 });
    const data = await stored.arrayBuffer();
    if (data.byteLength !== file.bytes || (await sha256Hex(data)) !== file.sha256) return new Response('model-corrupt', { status: 409 });
    return new Response(data, { status: 200, headers: { 'content-length': String(data.byteLength) } });
  },
});

scope.addEventListener('message', (event) => {
  if (event.data?.action !== 'narwal:ledger') return;
  event.stopImmediatePropagation();
  scope.postMessage({ event: 'narwal:ledger', attempts: guard.attempts });
});
