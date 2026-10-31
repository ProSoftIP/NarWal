// A BundleSource over in-memory bytes (tests, fixture builder, extension storage reads).

import type { BundleSource } from './types.ts';

export function memorySource(files: ReadonlyMap<string, Uint8Array>): BundleSource {
  return {
    async list() {
      return [...files.keys()].sort().map((path) => ({ path, bytes: files.get(path)!.length, type: 'file' as const }));
    },
    async read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`no such file: ${path}`);
      return bytes;
    },
  };
}
