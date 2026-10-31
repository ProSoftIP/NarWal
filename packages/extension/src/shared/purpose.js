// What the recording is for (manifest.purpose, docs/bundle-schema.md §4): the
// person's own words, checked the same way wherever they are typed (board #16594).
import { isCredentialValue } from '../../../bundle/src/rules.ts';

export const PURPOSE_MAX = 1000;

/** Trimmed purpose, or null when blank; refused when too long or shaped like a key. */
export function checkPurpose(text) {
  const purpose = String(text ?? '').trim();
  if (purpose.length > PURPOSE_MAX) return { ok: false, message: `Say what the recording is for in at most ${PURPOSE_MAX} characters.` };
  if (isCredentialValue(purpose)) return { ok: false, message: 'That looks like a key or token. Remove it: the purpose goes into the exported recording.' };
  return { ok: true, purpose: purpose || null };
}

/** "N / 1000" under a purpose field, kept current as the person types. Call the result after setting the value in code. */
export function countPurpose(field, counter) {
  const update = () => {
    counter.textContent = `${field.value.length} / ${PURPOSE_MAX}`;
  };
  field.addEventListener('input', update);
  update();
  return update;
}
