// Archive entry names are an allowlist, not a denylist (docs/bundle-schema.md
// §11). NarWal writes every bundle, so a name outside this shape is never
// legitimate. Trailing dots and Windows device names are refused as well: the
// same archive is unpacked with ordinary tools on any platform. The rule itself
// lives in packages/bundle/src/rules.ts, shared with the schema validator.

import { MAX_PATH_CHARS, unsafePathReason } from '../../bundle/src/rules.ts';
import { NarwalError } from './errors.ts';

export { MAX_PATH_CHARS, unsafePathReason };

export function assertSafePath(path: string): void {
  const reason = unsafePathReason(path);
  if (reason !== null) {
    throw new NarwalError('entry-path-unsafe', `Unsafe file name in bundle: ${reason}`, {
      // The raw name can hold control characters; report it JSON-escaped.
      path: JSON.stringify(path.slice(0, 120)),
      reason,
    });
  }
}

/** Two names that a case-insensitive file system would write to one file. */
export function pathCollisionKey(path: string): string {
  return path.toLowerCase();
}
