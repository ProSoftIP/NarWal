// Delivers one item to every registered consumer (live transcription and
// later features). A consumer that throws or rejects is reported and skipped;
// it never stops capture or the saving of the item.
export function fanOut(consumers, item, onError) {
  for (const consumer of consumers) {
    try {
      const result = consumer(item);
      if (result && typeof result.then === 'function') result.then(null, (err) => onError(err, consumer));
    } catch (err) {
      onError(err, consumer);
    }
  }
}
