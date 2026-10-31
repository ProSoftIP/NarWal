// A BundleSource over a directory on disk (Node only). Links and other non-regular entries are
// listed as type "other" so validation refuses them; the walk stops past the file limit.

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { LIMITS } from './limits.ts';
import type { BundleSource, SourceEntry } from './types.ts';

export function dirSource(root: string): BundleSource {
  const base = resolve(root);
  return {
    async list(): Promise<SourceEntry[]> {
      const out: SourceEntry[] = [];
      const pending = [base];
      while (pending.length > 0 && out.length <= LIMITS.files + 1) {
        const dir = pending.pop()!;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          const path = relative(base, full).split(sep).join('/');
          if (entry.isDirectory()) pending.push(full);
          else if (entry.isFile()) out.push({ path, bytes: (await lstat(full)).size, type: 'file' });
          else out.push({ path, bytes: 0, type: 'other' });
        }
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async read(path: string): Promise<Uint8Array> {
      const full = resolve(base, path);
      if (!full.startsWith(base + sep)) throw new Error(`path escapes the bundle: ${path}`);
      const info = await lstat(full);
      if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
      return new Uint8Array(await readFile(full));
    },
  };
}
