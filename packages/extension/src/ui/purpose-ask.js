// What the recording is for, asked before its bundle downloads (board #17002).
//
// A bundle is handed to an AI that acts on what the person put in it; without
// a purpose it can only ask the person what to do. The purpose field at Start
// (board #16594) stays optional, so Export asks for it in a modal when the
// recording has none. The modal cannot be confirmed empty, and Cancel or
// Escape stops the export: nothing downloads without a purpose.
//
// Every export runs on the recordings page (recordings.js download()): its
// row and status-bar buttons, the rows of recordings saved from a file, and
// Export on the strip or in the popup, which opens that page with `&export=1`
// (sw/main.js exportFromPage). The modal is shown there, on the page the
// person is looking at.
import { editRecording, readLayer, setPurpose } from '../../../edits/src/index.ts';
import { PURPOSE_MAX, checkPurpose } from '../shared/purpose.js';

export const PURPOSE_QUESTION = 'What is this recording for, and what should happen with each thing you pointed at?';

/** Said on the page when the person cancels the question: no bundle was made. */
export const NOT_EXPORTED = 'Not exported. The bundle needs to say what the recording is for.';

/**
 * The typed answer as the modal judges it: `ok` when it can be confirmed,
 * `purpose` the trimmed text, `message` why not (checkPurpose: too long, or
 * shaped like a key). Blank text is never ok and says nothing: the button
 * stays disabled.
 */
export function purposeAnswer(text) {
  const checked = checkPurpose(text);
  if (!checked.ok) return { ok: false, purpose: null, message: checked.message };
  if (!checked.purpose) return { ok: false, purpose: null, message: '' };
  return { ok: true, purpose: checked.purpose, message: '' };
}

/** True when the saved purpose would go into the bundle (bundle.js purposeOf leaves out a key-shaped one). */
export function hasPurpose(saved) {
  return purposeAnswer(saved).ok;
}

/**
 * Shows the modal and waits for the person. Resolves the trimmed purpose on
 * confirm, or null on Cancel or Escape. `parts` are the page's elements:
 * { dialog, field, confirm, cancel, message, count }.
 */
export function askPurpose({ dialog, field, confirm, cancel, message, count }) {
  field.value = '';
  return new Promise((resolve) => {
    let answer = null;
    const update = () => {
      const judged = purposeAnswer(field.value);
      confirm.disabled = !judged.ok;
      message.textContent = judged.message;
      if (count) count.textContent = `${field.value.length} / ${PURPOSE_MAX}`;
      return judged;
    };
    const onConfirm = () => {
      const judged = update();
      if (!judged.ok) return;
      answer = judged.purpose;
      dialog.close('confirm');
    };
    const onCancel = () => dialog.close('cancel');
    // Escape fires `cancel` and then `close` on a modal dialog: the answer stays null.
    const onClose = () => {
      field.removeEventListener('input', update);
      confirm.removeEventListener('click', onConfirm);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      resolve(answer);
    };
    field.addEventListener('input', update);
    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    update();
    dialog.showModal();
    field.focus();
  });
}

/**
 * Exports with a purpose. `purpose` is { read, ask, save } for one recording:
 * the saved purpose, the modal, and how to keep the answer. When it has none,
 * the person is asked before `pack` runs; the answer is saved first, so the
 * bundle `pack` writes carries it. Resolves pack's result, or null when the
 * person cancelled: then `pack` never ran.
 */
export async function exportWithPurpose({ purpose, pack }) {
  if (purpose && !hasPurpose(await purpose.read())) {
    const text = await purpose.ask();
    if (text === null) return null;
    await purpose.save(text);
  }
  return pack();
}

/** The purpose of a library recording (a bundle saved from a file): its edit layer, as the replay page shows it. */
export async function readLibraryPurpose(library, id) {
  return readLayer(await library.readFiles(id)).purpose;
}

/** Sets a library recording's purpose the way the replay page's Save does (edits setPurpose). */
export async function saveLibraryPurpose(library, id, text) {
  const checked = checkPurpose(text);
  if (!checked.ok) throw new Error(checked.message);
  await editRecording(library, id, (layer) => setPurpose(layer, checked.purpose ?? ''));
  return checked.purpose;
}
