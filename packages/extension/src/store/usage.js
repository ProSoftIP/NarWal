// Space the recordings take on this computer (board #17003): the chunks of
// every recording made here and every bundle in the recording library,
// including its trash. Shown in the popup and on Saved recordings, so a
// delete shows the space it freed. Counted from the sizes saved with the
// data, not navigator.storage.estimate(): that also counts the speech models
// and lags behind a delete.
import * as store from './db.js';
import { IdbLibraryStorage } from '../../../library/src/index.ts';

export async function recordingsBytes({ db = null, storage = null } = {}) {
  const [local, records] = await Promise.all([
    store.savedBytes(db || (await store.openDb())),
    (storage ? Promise.resolve(storage) : IdbLibraryStorage.open()).then((s) => s.listRecords()),
  ]);
  return local.total + records.reduce((sum, r) => sum + (Number.isFinite(r.bytes) ? r.bytes : 0), 0);
}

/** 0 -> "nothing", 12_300 -> "12 KB", 4_250_000 -> "4.3 MB", 48_400_000 -> "48 MB", 1_900_000_000 -> "1.9 GB". */
export function bytesText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'nothing';
  if (bytes < 1e3) return `${Math.round(bytes)} bytes`;
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) {
    const mb = bytes / 1e6;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
