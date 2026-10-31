// Words from a transformers.js Whisper result with word timestamps (board #16621).
//
// The pipeline returns one chunk per word piece. A piece that begins with a
// space starts a new word; the others continue the word before them, so
// " $123" ",456" ".78" is one word, "$123,456.78". Joined with spaces, the
// pieces were "$123 ,456 .78": four of the turbo errors on Matt's recording
// and most of the gap between small.en in the extension (14.1%) and the same
// spans natively (9.4%).

import type { FinalEngineWord } from '../final-pass.ts';

export interface WhisperChunk {
  text: string;
  /** Seconds from the start of the audio; the end is null when the model gave none. */
  timestamp: [number, number | null];
}

export function whisperWords(chunks: WhisperChunk[]): FinalEngineWord[] {
  const words: FinalEngineWord[] = [];
  for (const chunk of chunks) {
    const end = chunk.timestamp[1] ?? chunk.timestamp[0];
    const last = words.at(-1);
    if (last && chunk.text && !/^\s/.test(chunk.text)) {
      last.text += chunk.text;
      last.end = Math.max(last.end, end);
    } else if (chunk.text.trim()) {
      words.push({ text: chunk.text.trim(), start: chunk.timestamp[0], end });
    }
  }
  return words;
}
