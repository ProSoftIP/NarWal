// Groups recorder entries into bounded 'events' chunks. The recorder calls
// flush() on a timer (about once a second) and add() flushes early when a
// chunk reaches maxBytes, so nothing waits for Stop to be saved. Writes run
// one at a time in sequence order. A failed write is reported once through
// onError with the lost chunk; later adds keep working so the caller decides
// whether to stop.

export function approxBytes(entry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 1024;
  }
}

export function createBatcher({ write, onError, startSeq = 0, maxBytes = 512 * 1024 }) {
  let entries = [];
  let bytes = 0;
  let seq = startSeq;
  let chain = Promise.resolve();
  const totals = { chunks: 0, entries: 0, bytes: 0, failed: 0 };

  function flush() {
    if (!entries.length) return chain;
    const chunk = {
      seq: seq++,
      startAt: entries[0].t,
      endAt: entries[entries.length - 1].t,
      count: entries.length,
      bytes,
      entries,
    };
    entries = [];
    bytes = 0;
    chain = chain.then(async () => {
      try {
        await write(chunk);
        totals.chunks += 1;
        totals.entries += chunk.count;
        totals.bytes += chunk.bytes;
      } catch (err) {
        totals.failed += 1;
        if (onError) onError(err, chunk);
      }
    });
    return chain;
  }

  function add(entry) {
    entries.push(entry);
    bytes += approxBytes(entry);
    if (bytes >= maxBytes) flush();
  }

  return { add, flush, totals: () => ({ ...totals, buffered: entries.length }), nextSeq: () => seq };
}
