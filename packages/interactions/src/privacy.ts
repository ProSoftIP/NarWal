// rrweb recording options that keep typed values, excluded regions and the
// recorder UI out of snapshots and mutations (board #16543).
//
// The content script spreads these into rrweb's record() options. rrweb
// fixes block and mask selectors when recording starts, so the user picks
// excluded regions before recording (see picker.ts).

import { EXCLUDE_ATTR, PrivacyPolicy, UI_SELECTOR } from './dom.ts';

/** Fixed-width mask: hides the value and its length. */
export const MASKED_VALUE = '••••••••';

export interface RrwebPrivacyOptions {
  blockSelector: string;
  maskAllInputs: true;
  maskInputFn: (text: string) => string;
  maskTextSelector: string;
  maskTextFn: (text: string) => string;
}

/**
 * Options for rrweb's record():
 * - excluded regions and the recorder UI are blocked: rrweb keeps only an
 *   empty placeholder of the same size, and ignores their mutations;
 * - every form value is replaced by a fixed mask (rrweb's default mask
 *   keeps the value's length);
 * - text the user types into editable content is masked in snapshots and
 *   mutations.
 */
export function rrwebPrivacyOptions(exclusions: readonly string[] = []): RrwebPrivacyOptions {
  const policy = new PrivacyPolicy(exclusions);
  return {
    blockSelector: `${UI_SELECTOR},${policy.excludeSelector}`,
    maskAllInputs: true,
    maskInputFn: (text) => (text ? MASKED_VALUE : ''),
    maskTextSelector: '[contenteditable]:not([contenteditable="false"])',
    maskTextFn: (text) => text.replace(/\S/g, '*'),
  };
}

export { EXCLUDE_ATTR, PrivacyPolicy };
