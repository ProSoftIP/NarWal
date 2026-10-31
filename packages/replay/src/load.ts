// Opens a bundle for replay: validate it in full, then build the timeline.
// The bytes may come from the local library or from an imported file; both
// are checked the same way, because both may have been edited on disk.

import { memorySource } from '../../bundle/src/memory-source.ts';
import { validateBundle } from '../../bundle/src/validate.ts';
import type { Issue, RrwebLine } from '../../bundle/src/types.ts';
import { buildReplayModel, parseRrwebStream, type ReplayModel } from './model.ts';

export interface LoadedReplay {
  model: ReplayModel;
  /** Narration bytes, or null when the bundle has none. */
  audio: Uint8Array | null;
  warnings: Issue[];
}

export class ReplayLoadError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    const first = issues[0];
    super(first ? `This recording cannot be replayed: ${first.message}${first.file ? ` (${first.file}${first.line ? `:${first.line}` : ''})` : ''}` : 'This recording cannot be replayed');
    this.name = 'ReplayLoadError';
    this.issues = issues;
  }
}

export async function loadReplay(files: ReadonlyMap<string, Uint8Array>): Promise<LoadedReplay> {
  const result = await validateBundle(memorySource(files));
  if (!result.ok || !result.bundle) throw new ReplayLoadError(result.errors);
  const { bundle } = result;
  const streams = new Map<string, RrwebLine[]>();
  for (const doc of bundle.documents) {
    const bytes = doc.rrweb ? files.get(doc.rrweb) : undefined;
    if (bytes) streams.set(doc.key, parseRrwebStream(bytes));
  }
  const audioPath = bundle.manifest.audio?.file;
  return {
    model: buildReplayModel(bundle, streams),
    audio: audioPath ? (files.get(audioPath) ?? null) : null,
    warnings: result.warnings,
  };
}
