// Applies one edit to a recording in the library: read the stored tree, build
// the change from it, write the tree back through `RecordingLibrary.update`
// (which accepts only added layers). When another writer got there first, the
// change is built again from the newer tree, so no edit is lost and none is
// applied to a tree it was not made for.

import { NarwalError } from '../../library/src/errors.ts';
import type { RecordingLibrary, RecordingSummary } from '../../library/src/library.ts';
import { applyPlan, isEmptyPlan, readLayer } from './layer.ts';
import type { EditLayer, EditPlan } from './layer.ts';

export interface EditOutcome<Result> {
  recording: RecordingSummary;
  /** The tree as stored after the edit (or as read, when nothing changed). */
  files: Map<string, Uint8Array>;
  result: Result;
  /** False when the change added nothing; nothing was written. */
  changed: boolean;
}

export interface EditOptions {
  /** Wall time stamped on new records. Default: now. */
  now?: () => Date;
  /** Tries before a concurrent writer's conflict is passed on. Default 3. */
  attempts?: number;
}

/**
 * `change` builds a plan from the layer as stored now (`addNote`,
 * `correctSegment`, `addRetranscription`...); it may run more than once and
 * must not have side effects. Its refusals (`EditError`) pass through and
 * nothing is written.
 */
export async function editRecording<Result extends { plan: EditPlan }>(
  library: RecordingLibrary,
  id: string,
  change: (layer: EditLayer, at: string) => Result,
  options: EditOptions = {},
): Promise<EditOutcome<Result>> {
  const now = options.now ?? (() => new Date());
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    // One read: the revision passed to `update` is the one these files are from.
    const { recording: before, files } = await library.read(id);
    const result = change(readLayer(files), now().toISOString());
    if (isEmptyPlan(result.plan)) return { recording: before, files, result, changed: false };
    const next = await applyPlan(files, result.plan);
    try {
      const recording = await library.update(id, next, { expectedRevision: before.revision });
      return { recording, files: next, result, changed: true };
    } catch (error) {
      // Another write landed after our read: build the change again from the newer tree.
      const raced = error instanceof NarwalError && error.code === 'recording-conflict';
      if (attempt >= attempts || !raced) throw error;
    }
  }
}
