// The derived files of a bundle tree (docs/bundle-schema.md §9): agent/walkthrough.md,
// agent/walkthrough.json, README.md and AGENTS.md. NarWal writes them from the other
// files, on export and on every edit. A copy that came in with an imported zip is never
// passed on: it may say anything, so it is replaced with the generated text (#16594).

import { README_PATHS, buildAgentView, renderMarkdown, renderReadme, stableJson } from './agent-view.ts';
import { memorySource } from './memory-source.ts';
import { validateBundle } from './validate.ts';

const AGENT_MD = 'agent/walkthrough.md';
const AGENT_JSON = 'agent/walkthrough.json';
const MANIFEST_PATH = 'manifest.json';
/** Every derived path. All are written together; none is kept from the input. */
export const DERIVED_PATHS: readonly string[] = [AGENT_MD, AGENT_JSON, ...README_PATHS];

const MEDIA_TYPES: Record<string, string> = { json: 'application/json', md: 'text/markdown' };

interface ListedFile {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `files` with every derived file freshly generated and listed in the manifest. Any
 * derived file the input held is replaced, whatever it said. Captured files and user
 * layers pass through as they are. A tree that does not validate comes back unchanged,
 * so the caller's own check reports why; a tree whose derived files are already current
 * comes back as the same bytes.
 */
export async function deriveAgentFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Map<string, Uint8Array>> {
  const result = await validateBundle(memorySource(files));
  if (!result.bundle) return new Map(files);
  const view = buildAgentView(result.bundle);
  const readme = encoder.encode(renderReadme(view));
  const derived = new Map<string, Uint8Array>([
    [AGENT_MD, encoder.encode(renderMarkdown(view))],
    [AGENT_JSON, encoder.encode(stableJson(view))],
    ...README_PATHS.map((path) => [path, readme] as [string, Uint8Array]),
  ]);
  const manifestBytes = files.get(MANIFEST_PATH)!;
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as { files: ListedFile[] };
  let changed = false;
  const next = new Map(files);
  for (const [path, bytes] of derived) {
    const entry: ListedFile = {
      path,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      mediaType: MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1)]!,
    };
    const index = manifest.files.findIndex((file) => file.path === path);
    if (index === -1) {
      manifest.files.push(entry);
      changed = true;
    } else {
      const old = manifest.files[index]!;
      if (old.bytes !== entry.bytes || old.sha256 !== entry.sha256 || old.mediaType !== entry.mediaType) changed = true;
      manifest.files[index] = entry;
    }
    if (!sameBytes(files.get(path), bytes)) changed = true;
    next.set(path, bytes);
  }
  if (!changed) return next;
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  next.set(MANIFEST_PATH, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return next;
}
