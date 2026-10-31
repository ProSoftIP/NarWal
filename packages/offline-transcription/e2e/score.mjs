// Scoring for the e2e run (board #16544): word error rate and word start
// error against the fixture's reference words.

const normalise = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Edit-distance alignment. Returns the error counts and the matched (reference index, hypothesis index) pairs. */
export function align(reference, hypothesis) {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  const cost = new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i += 1) cost[i * cols] = i;
  for (let j = 0; j < cols; j += 1) cost[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitute = cost[(i - 1) * cols + j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      cost[i * cols + j] = Math.min(substitute, cost[(i - 1) * cols + j] + 1, cost[i * cols + j - 1] + 1);
    }
  }
  const pairs = [];
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = reference.length;
  let j = hypothesis.length;
  while (i > 0 || j > 0) {
    const here = cost[i * cols + j];
    if (i > 0 && j > 0 && here === cost[(i - 1) * cols + j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1)) {
      if (reference[i - 1] === hypothesis[j - 1]) pairs.push([i - 1, j - 1]);
      else substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === cost[(i - 1) * cols + j] + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return { substitutions, deletions, insertions, pairs: pairs.reverse() };
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

/**
 * @param reference fixture words `{w, s, e}` in seconds
 * @param revision a transcript revision (segments with words in session ms)
 * @param range optional `{startMs, endMs}`: score only reference words inside it
 */
export function scoreRevision(reference, revision, range) {
  const refWords = reference.filter((word) => !range || (word.s * 1000 >= range.startMs && word.e * 1000 <= range.endMs));
  const ref = refWords.map((word) => normalise(word.w).join(''));
  const hypWords = revision.segments
    .flatMap((segment) => segment.words)
    .filter((word) => !range || (word.endMs > range.startMs && word.startMs < range.endMs))
    .flatMap((word) => normalise(word.text).map((text) => ({ text, startMs: word.startMs, endMs: word.endMs })));
  const { substitutions, deletions, insertions, pairs } = align(ref, hypWords.map((word) => word.text));
  const startErrors = pairs.map(([r, h]) => hypWords[h].startMs - refWords[r].s * 1000);
  const sortedSigned = [...startErrors].sort((a, b) => a - b);
  const sortedAbs = startErrors.map(Math.abs).sort((a, b) => a - b);
  let monotonic = true;
  let inside = true;
  for (const segment of revision.segments) {
    let previous = segment.startMs;
    for (const word of segment.words) {
      if (word.startMs < previous || word.endMs < word.startMs) monotonic = false;
      if (word.startMs < segment.startMs || word.endMs > segment.endMs) inside = false;
      previous = word.startMs;
    }
  }
  return {
    referenceWords: ref.length,
    hypothesisWords: hypWords.length,
    wer: ref.length ? Math.round(((substitutions + deletions + insertions) / ref.length) * 1000) / 1000 : null,
    substitutions,
    deletions,
    insertions,
    matchedWords: pairs.length,
    startBiasMs: sortedSigned.length ? Math.round(quantile(sortedSigned, 0.5)) : null,
    startAbsMedianMs: sortedAbs.length ? Math.round(quantile(sortedAbs, 0.5)) : null,
    startAbsP90Ms: sortedAbs.length ? Math.round(quantile(sortedAbs, 0.9)) : null,
    startsWithin250Ms: sortedAbs.length ? Math.round((sortedAbs.filter((error) => error <= 250).length / sortedAbs.length) * 1000) / 1000 : null,
    wordsMonotonic: monotonic,
    wordsInsideSegments: inside,
  };
}

/**
 * Visible latency: for each reference word matched in the final text, the time
 * from the end of the spoken word to the first moment the live text (interim
 * or final) held that many words. `visible` is `[{atMs, words}]` on the audio
 * clock.
 */
export function visibleLatency(reference, revision, visible) {
  const ref = reference.map((word) => normalise(word.w).join(''));
  const hyp = revision.segments.flatMap((segment) => normalise(segment.text));
  const { pairs } = align(ref, hyp);
  const latencies = [];
  for (const [r, h] of pairs) {
    const shown = visible.find((entry) => entry.words >= h + 1);
    if (shown) latencies.push(Math.round(shown.atMs - reference[r].e * 1000));
  }
  const sorted = latencies.sort((a, b) => a - b);
  return { words: sorted.length, p50Ms: quantile(sorted, 0.5), p90Ms: quantile(sorted, 0.9), maxMs: sorted.length ? sorted[sorted.length - 1] : null };
}
