// One error type for the library and the bundle code. `code` is stable and
// machine-readable; `message` is for a person.

export type NarwalErrorCode =
  // archive container
  | 'archive-too-large'
  | 'archive-malformed'
  | 'archive-unsupported'
  | 'archive-too-many-entries'
  | 'entry-too-large'
  | 'entry-path-unsafe'
  | 'entry-duplicate'
  | 'entry-overlap'
  | 'entry-ratio'
  | 'entry-corrupt'
  | 'total-too-large'
  // bundle contents
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'schema-unsupported'
  | 'file-unlisted'
  | 'file-missing'
  | 'file-mismatch'
  | 'file-type-refused'
  | 'file-invalid-json'
  | 'credential-refused'
  | 'validation-failed'
  // library
  | 'recording-not-found'
  | 'recording-state'
  | 'recording-conflict'
  | 'update-refused'
  | 'duplicate-import'
  | 'confirmation-required'
  | 'storage-newer'
  | 'storage-full'
  | 'storage-migration-missing';

export class NarwalError extends Error {
  readonly code: NarwalErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: NarwalErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'NarwalError';
    this.code = code;
    this.detail = detail;
  }
}
