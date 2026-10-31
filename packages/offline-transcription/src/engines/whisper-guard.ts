// Imported first by the Whisper worker, before the runtime evaluates, so the
// runtime only ever sees the guarded fetch.
//
// The runtime asks for its model by Hugging Face URL. Those requests are
// answered from the verified local store (hash-checked here again); the
// network is never contacted.

import { MODELS, TRANSFORMERS_MODEL_IDS, sha256Hex, storageKey, transformersRuntime } from '../models.ts';
import type { FinalModelId, ModelFile } from '../models.ts';
import { MODEL_CACHE_NAME } from '../model-store.ts';
import { installNetworkGuard } from '../network-guard.ts';

// Every transformers.js final model, by the repository name the runtime asks
// for. A model of another engine is never served to this worker.
const byRepo = new Map<string, { id: FinalModelId; files: Map<string, ModelFile> }>(
  TRANSFORMERS_MODEL_IDS.map((id) => [transformersRuntime(id).repo, { id, files: new Map(MODELS[id].files.map((file) => [file.path, file])) }]),
);

/** Set when a pinned file was absent or failed its check during a load. */
export const modelProblems: { missing: string[]; corrupt: string[] } = { missing: [], corrupt: [] };

export const guard = installNetworkGuard(self as unknown as Parameters<typeof installNetworkGuard>[0], {
  async serve(url) {
    if (url.host !== 'huggingface.co') return undefined;
    // /<owner>/<repo>/resolve/<revision>/<path>
    const parts = url.pathname.split('/');
    const model = parts[3] === 'resolve' ? byRepo.get(`${parts[1]}/${parts[2]}`) : undefined;
    if (!model) return undefined;
    const path = parts.slice(5).join('/');
    const file = model.files.get(path);
    if (!file) return new Response('not part of the pinned model', { status: 404 });
    const cache = await caches.open(MODEL_CACHE_NAME);
    const stored = await cache.match(storageKey(model.id, path));
    if (!stored) {
      modelProblems.missing.push(path);
      return new Response('model-missing', { status: 404 });
    }
    const data = await stored.arrayBuffer();
    if (data.byteLength !== file.bytes || (await sha256Hex(data)) !== file.sha256) {
      modelProblems.corrupt.push(path);
      return new Response('model-corrupt', { status: 404 });
    }
    return new Response(data, { status: 200, headers: { 'content-length': String(data.byteLength), 'content-type': 'application/octet-stream' } });
  },
});
