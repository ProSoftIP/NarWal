export { EditError } from './errors.ts';
export type { EditErrorCode } from './errors.ts';
export { activeEdits, applyPlan, EDITS_PATH, EMPTY_PLAN, findRevision, isEmptyPlan, MAX_REVISIONS, readLayer, TEXT_LIMITS } from './layer.ts';
export type { Correction, EditLayer, EditPlan, Note } from './layer.ts';
export {
  addCorrection,
  correctedSegment,
  correctedTranscript,
  correctSegment,
  normalizeText,
  segmentCorrections,
  wordDiff,
} from './corrections.ts';
export type { CorrectedSegment, CorrectionInput, TextPiece } from './corrections.ts';
export { activeNotes, addNote, editNote, retractEdit } from './notes.ts';
export type { NoteInput } from './notes.ts';
export { setPurpose } from './purpose.ts';
export { addRetranscription, resolveRetranscription, waitingRevisions } from './retranscription.ts';
export type { CarryItem, ConflictDecision, RetranscriptionResult, WaitingRevision } from './retranscription.ts';
export { editRecording } from './recording.ts';
export type { EditOptions, EditOutcome } from './recording.ts';
