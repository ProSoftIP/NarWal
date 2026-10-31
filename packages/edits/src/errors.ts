// Why an edit was refused. `code` is stable and machine-readable; `message` is
// for a person. Nothing is written when an edit is refused.

export type EditErrorCode =
  | 'no-transcript' // the recording has no transcript revision to correct
  | 'unknown-revision'
  | 'unknown-segment'
  | 'word-range' // empty, or outside the segment's words
  | 'overlap' // an active correction already covers some of these words
  | 'text-too-long'
  | 'note-empty'
  | 'credential' // the text looks like a key or token
  | 'anchor-outside' // a note time outside the recording
  | 'unknown-edit'
  | 'edit-inactive' // the edit is already superseded or retracted
  | 'wrong-edit-type'
  | 'revision-limit'
  | 'undecided' // a retranscription conflict has no decision
  | 'cannot-keep' // a conflict that has no single place in the new revision
  | 'nothing-to-resolve'
  | 'invalid-bundle'; // the edited tree failed bundle validation (a bug, or a damaged tree)

export class EditError extends Error {
  readonly code: EditErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: EditErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EditError';
    this.code = code;
    this.detail = detail;
  }
}
