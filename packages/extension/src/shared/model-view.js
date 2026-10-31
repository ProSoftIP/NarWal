// The offline speech model's state for the start view, from the stored files
// and the download page's last report. Pure, so the unit tests run it on
// Node 20 without the TypeScript model store.

export const DOWNLOAD_KEY = 'modelDownload';
// model.html writes progress at least this often while it downloads.
export const DOWNLOAD_HEARTBEAT_MS = 5000;

/**
 * {state, bytesDone, bytesTotal, reason?, final?} -> the start view's model
 * shape. `state` is the live model's: Start needs only one, Parakeet or Vosk
 * (#16617). `final` is the models after Vosk, the first in the list (board
 * #16603), shown as a note, never a blocker. `choice` is the picker's row of
 * the model the choice uses (board #16611).
 */
export function toViewModel(ui, choice = null) {
  return {
    state: ui.state,
    bytesDone: ui.bytesDone,
    bytesTotal: ui.bytesTotal,
    ...(ui.state === 'failed' && ui.reason ? { error: ui.reason } : {}),
    ...(ui.final ? { final: { state: ui.final.state, bytesDone: ui.final.bytesDone, bytesTotal: ui.final.bytesTotal } } : {}),
    ...(choice ? { choice: choiceView(choice) } : {}),
  };
}

/** A picker row (offline-transcription picker.ts) -> what the start view names. */
export function choiceView(row) {
  return { id: row.id, name: row.name, accuracySteps: row.accuracySteps, speedSteps: row.speedSteps, recommended: row.recommended };
}

/**
 * What to show from the stored files and the download page's last report.
 * A report older than three heartbeats is from a page that was closed. The
 * page downloads the live model first, so once it is stored a report is about
 * the final models.
 */
export function combineModelState(stored, report, nowMs) {
  if (!report) return stored;
  const fresh = nowMs - report.at < DOWNLOAD_HEARTBEAT_MS * 3;
  if (stored.state === 'ready') {
    if (!stored.final || stored.final.state === 'ready') return stored;
    const bytes = report.final || report;
    if (report.state === 'downloading' && fresh) return { ...stored, final: { state: 'downloading', bytesDone: bytes.bytesDone, bytesTotal: bytes.bytesTotal } };
    if (report.state === 'failed') return { ...stored, final: { ...stored.final, state: 'failed' } };
    return stored;
  }
  if (report.state === 'downloading' && fresh) return report;
  if (report.state === 'failed' && stored.state !== 'failed') return report;
  return stored;
}
