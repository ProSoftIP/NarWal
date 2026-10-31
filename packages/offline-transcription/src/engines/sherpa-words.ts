// Words from a sherpa-onnx transducer result (board #16608).
//
// Parakeet TDT returns subword tokens, each with a start time (its encoder
// frame) and a duration (the frames the TDT joiner skipped). A token that
// begins with a space starts a new word; the others continue the word before
// them. A word ends where its last token's duration ends.

import type { FinalEngineWord } from '../final-pass.ts';

export interface SherpaOfflineResult {
  text?: string;
  tokens?: string[];
  /** Seconds from the start of the audio, one per token. */
  timestamps?: number[];
  /** Seconds, one per token (TDT models only). */
  durations?: number[];
}

/** Longest duration a word's last token may claim; a TDT duration can cover a following pause. */
const MAX_TAIL_S = 0.4;

export function sherpaWords(result: SherpaOfflineResult): FinalEngineWord[] {
  const tokens = result.tokens ?? [];
  const starts = result.timestamps ?? [];
  const durations = result.durations ?? [];
  const words: FinalEngineWord[] = [];
  let current: FinalEngineWord | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const start: number = starts[i] ?? current?.end ?? 0;
    const end = start + Math.min(MAX_TAIL_S, Math.max(0, durations[i] ?? 0));
    // "of$123" in the model's own text: an amount after a word is a word of its own.
    const startsWord = !current || /^\s/.test(token) || (token.startsWith('$') && /[a-z]$/i.test(current.text));
    if (startsWord) {
      if (current?.text) words.push(current);
      current = { text: token.trim(), start, end };
    } else if (current) {
      current.text += token;
      current.end = Math.max(current.end, end);
    }
  }
  if (current?.text) words.push(current);
  return words;
}
