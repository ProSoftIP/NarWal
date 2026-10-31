// What the recording is for (docs/bundle-schema.md §4, `manifest.purpose`):
// the person's own words, set at Start and changed later. Replacing it is the
// one manifest change an edit makes; the old text is not kept.

import { isCredentialValue } from '../../bundle/src/rules.ts';
import { EditError } from './errors.ts';
import { EMPTY_PLAN, TEXT_LIMITS } from './layer.ts';
import type { EditLayer, EditPlan } from './layer.ts';

/** Sets the purpose; blank text removes it. The same text again changes nothing. */
export function setPurpose(layer: EditLayer, text: string): { plan: EditPlan; purpose: string | null } {
  const trimmed = text.trim();
  const purpose = trimmed === '' ? null : trimmed;
  if (purpose !== null && purpose.length > TEXT_LIMITS.purpose) {
    throw new EditError('text-too-long', `What the recording is for holds at most ${TEXT_LIMITS.purpose} characters`, { length: purpose.length });
  }
  if (purpose !== null && isCredentialValue(purpose)) {
    throw new EditError('credential', 'That looks like a key or token. Remove it: the purpose is shared with the recording.');
  }
  if (purpose === layer.purpose) return { plan: EMPTY_PLAN, purpose };
  return { plan: { edits: [], purpose }, purpose };
}
