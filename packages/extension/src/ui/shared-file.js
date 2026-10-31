// Board #27484: Open a shared recording. A .narwal.zip someone sent is picked
// (or dropped) on Saved recordings and replayed on the replay page, which
// offers Save. A picked file cannot ride a navigation, so its bytes wait here,
// in this extension's IndexedDB, for the replay page to take them once
// (`replay.html?shared=1`). Taking deletes them; nothing else is kept.

const DB_NAME = 'narwal-shared-open';
const STORE = 'files';
const KEY = 'next';

/** The replay page that takes a handed-over file. */
export const SHARED_REPLAY_URL = 'replay.html?shared=1';

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs `act(store)` in one transaction; resolves with what it returns once the transaction completes. */
async function inStore(idb, act) {
  const db = await openDb(idb);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const read = act(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(read);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps a picked file for the replay page, replacing one that was never taken. */
export async function handOver(file, idb = indexedDB) {
  const bytes = await file.arrayBuffer();
  await inStore(idb, (store) => {
    store.put({ fileName: file.name, bytes }, KEY);
  });
}

/** The handed-over file ({ fileName, bytes: Uint8Array }), or null; it is deleted as it is read. */
export async function takeHandedOver(idb = indexedDB) {
  const got = await inStore(idb, (store) => {
    const req = store.get(KEY);
    store.delete(KEY);
    return req;
  });
  const value = got.result;
  return value ? { fileName: value.fileName, bytes: new Uint8Array(value.bytes) } : null;
}

/**
 * Calls `open(file)` with a file dropped anywhere on the page. Other drags
 * (text, links) are left to the browser.
 */
export function onFileDrop(target, open) {
  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  target.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) open(file);
  });
}
