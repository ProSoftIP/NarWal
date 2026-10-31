// A sanity check on the final pass's text before it replaces the live one
// (board #16603). A model can "succeed" and still write nothing useful: no
// words, one phrase over and over (Whisper and Moonshine both loop on some
// audio), or a fraction of what was said. Such a revision is stored, but the
// live transcript stays the one the user reads.

/** Whole words, lower case; punctuation, hyphens and dashes split words. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

export interface Implausible {
  code: 'empty' | 'repetition' | 'too-few-words';
  /** Plain words, for the job's saved state. */
  message: string;
}

/** A phrase of 1 to MAX_PHRASE words repeated back to back this often is a loop. */
const MAX_PHRASE = 4;
const MIN_REPEATS = 4;
/** ...when the repeated run is at least this many words: "no, no, no, no" is speech. */
const MIN_LOOP_WORDS = 16;
/** Fewer words than this share of the live text's means the pass lost speech. */
const MIN_SHARE_OF_LIVE = 0.5;
/** Below this many live words the counts are too small to compare. */
const MIN_LIVE_WORDS = 20;

/** The longest back-to-back repeat of one short phrase: its words and the run's length in words. */
export function longestLoop(words: readonly string[]): { phrase: string; repeats: number; words: number } {
  let best = { phrase: '', repeats: 0, words: 0 };
  for (let size = 1; size <= MAX_PHRASE; size += 1) {
    for (let start = 0; start + size * 2 <= words.length; start += 1) {
      let repeats = 1;
      while (start + (repeats + 1) * size <= words.length && sameAt(words, start, start + repeats * size, size)) repeats += 1;
      if (repeats > 1 && repeats * size > best.words) best = { phrase: words.slice(start, start + size).join(' '), repeats, words: repeats * size };
      // The run is counted from its first word; starting inside it finds only shorter runs.
      if (repeats > 1) start += (repeats - 1) * size;
    }
  }
  return best;
}

function sameAt(words: readonly string[], a: number, b: number, size: number): boolean {
  for (let i = 0; i < size; i += 1) if (words[a + i] !== words[b + i]) return false;
  return true;
}

/**
 * Why the final text must not replace the live text, or null when it may.
 * `liveText` is null when there is no live transcript to compare with.
 */
export function implausibleFinal(finalText: string, liveText: string | null): Implausible | null {
  const words = wordsOf(finalText);
  if (!words.length) return { code: 'empty', message: 'the improved transcript has no words' };
  const loop = longestLoop(words);
  if (loop.repeats >= MIN_REPEATS && loop.words >= MIN_LOOP_WORDS) {
    // Never the transcript's words: the message goes to the job's saved state (ui-status.js).
    return { code: 'repetition', message: `the improved transcript repeats one phrase ${loop.repeats} times in a row` };
  }
  const live = liveText === null ? 0 : wordsOf(liveText).length;
  if (live >= MIN_LIVE_WORDS && words.length < live * MIN_SHARE_OF_LIVE) {
    return { code: 'too-few-words', message: `the improved transcript has ${words.length} words where the live one has ${live}` };
  }
  return null;
}
