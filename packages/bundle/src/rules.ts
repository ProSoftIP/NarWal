// Container rules every NarWal reader shares (docs/bundle-schema.md §11): file paths,
// file types and credentials. One copy: the validator here and packages/library both
// import this module, so a bundle the library stores is one the validator accepts.
// No Node APIs: it runs in the extension too.

export const MAX_PATH_CHARS = 200;

const SEGMENT = /^[A-Za-z0-9._-]+$/;
// Device names Windows resolves in any directory, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Returns why `path` is unsafe, or null when it is a safe relative file path. */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0) return 'empty name';
  if (path.length > MAX_PATH_CHARS) return 'name too long';
  if (path.includes('\\')) return 'backslash';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'drive letter';
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return 'empty segment';
    if (segment === '.' || segment === '..') return 'relative segment';
    if (!SEGMENT.test(segment)) return 'character outside A-Z a-z 0-9 . _ -';
    if (segment.endsWith('.')) return 'trailing dot';
    if (WINDOWS_RESERVED.test(segment)) return 'reserved device name';
  }
  return null;
}

// File types a bundle may hold. Markup and script files have no place in a
// bundle; an unknown type is refused, not stored.
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['json', 'jsonl', 'md', 'webm']);

/** The lower-case extension of the last path segment, or '' when it has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// Credentials. A key is refused when its name contains a credential word, so
// "refresh_token", "client_secret" and "x-api-key" are caught as well.
const CREDENTIAL_KEY = /api[-_]?key|authorization|access[-_]?token|token|secret|password|cookie/i;
// `sk-` must start a word: "risk-", "desk-" and "task-" in ordinary text are not keys.
const CREDENTIAL_VALUE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/;
// Case-sensitive: "bearer of bad news" is a sentence, "Bearer abc" is a header value.
const BEARER = 'Bearer ';

/** True for an object key that names a credential. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key);
}

/** True for a JSON string value shaped like an API key or a bearer token. */
export function isCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE.test(value) || value.startsWith(BEARER);
}

/** True for free text (a Markdown file) that holds something shaped like an API key. */
export function holdsCredentialText(text: string): boolean {
  return CREDENTIAL_VALUE.test(text);
}
