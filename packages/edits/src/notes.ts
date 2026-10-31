// Written notes and retractions (docs/bundle-schema.md §8.2). A note is the
// user's own text anchored to a session time (and optionally a span); it is
// never shown as narration. Changing or removing a note appends a record; the
// old one stays in the file.

import type { Edit } from '../../bundle/src/types.ts';
import { EditError } from './errors.ts';
import { activeEdits, idSource, TEXT_LIMITS } from './layer.ts';
import type { EditLayer, EditPlan, Note } from './layer.ts';

export interface NoteInput {
  /** Session ms from recording start. */
  atMs: number;
  /** End of the span the note is about; absent or null for an instant. */
  endMs?: number | null;
  text: string;
}

function checkNote(layer: EditLayer, input: NoteInput): { atMs: number; endMs: number | null; text: string } {
  // Trim the ends only: line breaks inside a note are the user's.
  const text = input.text.trim();
  if (text === '') throw new EditError('note-empty', 'A note needs some text');
  if (text.length > TEXT_LIMITS.note) {
    throw new EditError('text-too-long', `A note holds at most ${TEXT_LIMITS.note} characters`, { length: text.length });
  }
  const { atMs } = input;
  const endMs = input.endMs ?? null;
  const inside = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms <= layer.durationMs;
  if (!inside(atMs) || (endMs !== null && (!inside(endMs) || endMs < atMs))) {
    throw new EditError('anchor-outside', 'A note must sit inside the recording, and its end must not be before its start', {
      atMs,
      endMs,
      durationMs: layer.durationMs,
    });
  }
  return { atMs, endMs, text };
}

function noteRecord(id: string, checked: { atMs: number; endMs: number | null; text: string }, at: string, supersedes?: string): Note {
  return {
    id,
    type: 'note',
    atMs: checked.atMs,
    ...(checked.endMs === null ? {} : { endMs: checked.endMs }),
    text: checked.text,
    createdAt: at,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

export function addNote(layer: EditLayer, input: NoteInput, at: string): { plan: EditPlan; noteId: string } {
  const checked = checkNote(layer, input);
  const id = idSource(layer)('n');
  return { plan: { edits: [noteRecord(id, checked, at)] }, noteId: id };
}

function requireActive(layer: EditLayer, id: string): Edit {
  const edit = layer.edits.find((candidate) => candidate.id === id);
  if (!edit) throw new EditError('unknown-edit', `This recording has no edit "${id}"`, { editId: id });
  if (edit.type === 'retract') throw new EditError('wrong-edit-type', `"${id}" is a retraction, which cannot be changed`, { editId: id });
  if (!activeEdits(layer.edits).some((candidate) => candidate.id === id)) {
    throw new EditError('edit-inactive', `"${id}" was already changed or removed`, { editId: id });
  }
  return edit;
}

/** Replaces an active note; fields not given keep their current values. */
export function editNote(
  layer: EditLayer,
  noteId: string,
  change: Partial<NoteInput>,
  at: string,
): { plan: EditPlan; noteId: string } {
  const old = requireActive(layer, noteId);
  if (old.type !== 'note') throw new EditError('wrong-edit-type', `"${noteId}" is not a note`, { editId: noteId });
  const checked = checkNote(layer, {
    atMs: change.atMs ?? old.atMs,
    endMs: change.endMs === undefined ? (old.endMs ?? null) : change.endMs,
    text: change.text ?? old.text,
  });
  if (checked.text === old.text && checked.atMs === old.atMs && checked.endMs === (old.endMs ?? null)) {
    return { plan: { edits: [] }, noteId };
  }
  const id = idSource(layer)('n');
  return { plan: { edits: [noteRecord(id, checked, at, noteId)] }, noteId: id };
}

/** Takes an active note or correction out of what the user and the agent read. */
export function retractEdit(layer: EditLayer, editId: string, at: string): { plan: EditPlan; retractId: string } {
  requireActive(layer, editId);
  const id = idSource(layer)('x');
  return { plan: { edits: [{ id, type: 'retract', target: editId, createdAt: at }] }, retractId: id };
}

/** Active notes, in time order. */
export function activeNotes(layer: EditLayer): Note[] {
  return activeEdits(layer.edits)
    .filter((edit): edit is Note => edit.type === 'note')
    .sort((a, b) => a.atMs - b.atMs);
}
