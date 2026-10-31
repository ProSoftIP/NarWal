// Transcript corrections (docs/bundle-schema.md §8.2). A correction replaces
// the text of some words of one segment of one revision. It carries no times
// of its own: the corrected text keeps the time span of the words it replaced,
// and is never split into invented per-word times. The revision file is never
// touched.

import type { TranscriptRevision, TranscriptSegment } from '../../bundle/src/types.ts';
import { EditError } from './errors.ts';
import { activeEdits, findRevision, idSource, TEXT_LIMITS } from './layer.ts';
import type { Correction, EditLayer, EditPlan } from './layer.ts';
import type { Edit } from '../../bundle/src/types.ts';

/** Whitespace runs become one space; ends are trimmed. Transcript text is one line. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Active corrections on one segment of one revision. */
export function segmentCorrections(layer: EditLayer, revisionId: string, segmentId: string): Correction[] {
  return activeEdits(layer.edits).filter(
    (edit): edit is Correction => edit.type === 'correction' && edit.revisionId === revisionId && edit.segmentId === segmentId,
  );
}

/** One run of displayed text and the time it stands on. */
export interface TextPiece {
  text: string;
  startMs: number;
  endMs: number;
  /** `heard`: the engine's own text. `corrected`: the user's text. */
  source: 'heard' | 'corrected';
  /**
   * `word`: the engine's time for this one word. `span`: the time of the
   * original words (or segment) this text stands for; the words inside it
   * have no times of their own.
   */
  timing: 'word' | 'span';
  /** Corrected pieces: the original words this text replaced. */
  heard?: string;
  editId?: string;
}

export interface CorrectedSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  /** What the user reads: the same text the agent view shows (§9). */
  text: string;
  corrected: boolean;
  /** The engine's text, when corrected. */
  heard?: string;
  /** The engine marked this segment's times as estimates. */
  approximate: boolean;
  pieces: TextPiece[];
}

/**
 * Applies active corrections to one segment, as the agent view does, and
 * says which time each run of text stands on.
 */
export function correctedSegment(segment: TranscriptSegment, corrections: readonly Correction[]): CorrectedSegment {
  const base = {
    segmentId: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    approximate: segment.timing === 'approximate',
  };
  const span = (text: string, source: TextPiece['source'], extra: Partial<TextPiece> = {}): TextPiece => ({
    text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    source,
    timing: 'span',
    ...extra,
  });
  const heardWords = (from: number, to: number): TextPiece[] =>
    segment.words.slice(from, to).map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs, source: 'heard', timing: 'word' }));

  if (corrections.length === 0) {
    const pieces = segment.words.length > 0 ? heardWords(0, segment.words.length) : [span(segment.text, 'heard')];
    return { ...base, text: segment.text, corrected: false, pieces };
  }
  const whole = corrections.find((c) => c.wordStart === undefined || c.wordEnd === undefined);
  if (whole) {
    return { ...base, text: whole.text, corrected: true, heard: segment.text, pieces: [span(whole.text, 'corrected', { heard: segment.text, editId: whole.id })] };
  }
  const sorted = [...corrections].sort((a, b) => a.wordStart! - b.wordStart!);
  const pieces: TextPiece[] = [];
  let i = 0;
  for (const c of sorted) {
    pieces.push(...heardWords(i, c.wordStart!));
    const replaced = segment.words.slice(c.wordStart!, c.wordEnd!);
    pieces.push({
      text: c.text,
      startMs: replaced[0]!.startMs,
      endMs: replaced[replaced.length - 1]!.endMs,
      source: 'corrected',
      timing: 'span',
      heard: replaced.map((word) => word.text).join(' '),
      editId: c.id,
    });
    i = c.wordEnd!;
  }
  pieces.push(...heardWords(i, segment.words.length));
  const text = pieces
    .map((piece) => piece.text)
    .filter((piece) => piece !== '')
    .join(' ');
  return { ...base, text, corrected: true, heard: segment.text, pieces };
}

/** Every segment of a revision with its active corrections applied. */
export function correctedTranscript(layer: EditLayer, revisionId: string): CorrectedSegment[] {
  const revision = findRevision(layer, revisionId);
  return revision.segments.map((segment) => correctedSegment(segment, segmentCorrections(layer, revisionId, segment.id)));
}

/**
 * The smallest word range that turns `words` into `tokens`, or null when they
 * are the same. A pure insertion takes in the word before it (or after, at the
 * start), because a correction must replace at least one word.
 */
export function wordDiff(words: readonly string[], tokens: readonly string[]): { wordStart: number; wordEnd: number; text: string } | null {
  const n = words.length;
  const m = tokens.length;
  let prefix = 0;
  while (prefix < n && prefix < m && words[prefix] === tokens[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && words[n - 1 - suffix] === tokens[m - 1 - suffix]) suffix += 1;
  if (prefix === n && prefix === m) return null;
  let wordStart = prefix;
  let wordEnd = n - suffix;
  let replacement = tokens.slice(prefix, m - suffix);
  if (wordStart === wordEnd) {
    if (wordStart > 0) {
      wordStart -= 1;
      replacement = [words[wordStart]!, ...replacement];
    } else {
      wordEnd += 1;
      replacement = [...replacement, words[0]!];
    }
  }
  return { wordStart, wordEnd, text: replacement.join(' ') };
}

function requireSegment(revision: TranscriptRevision, segmentId: string): TranscriptSegment {
  const segment = revision.segments.find((candidate) => candidate.id === segmentId);
  if (!segment) {
    throw new EditError('unknown-segment', `Revision "${revision.revisionId}" has no segment "${segmentId}"`, {
      revisionId: revision.revisionId,
      segmentId,
    });
  }
  return segment;
}

function requireRevisionId(layer: EditLayer, revisionId: string | undefined): string {
  const id = revisionId ?? layer.activeRevision;
  if (id === null) throw new EditError('no-transcript', 'This recording has no transcript to correct');
  return id;
}

function checkText(text: string): void {
  if (text.length > TEXT_LIMITS.correction) {
    throw new EditError('text-too-long', `A correction holds at most ${TEXT_LIMITS.correction} characters`, { length: text.length });
  }
}

const covers = (c: Pick<Correction, 'wordStart' | 'wordEnd'>): [number, number] => [c.wordStart ?? 0, c.wordEnd ?? Number.MAX_SAFE_INTEGER];

/** Throws `overlap` when `range` shares a word with an active correction other than `except`. */
export function assertNoOverlap(
  existing: readonly Correction[],
  range: Pick<Correction, 'wordStart' | 'wordEnd' | 'segmentId'>,
  except?: string,
): void {
  const [start, end] = covers(range);
  const hit = existing.find((c) => c.id !== except && c.segmentId === range.segmentId && covers(c)[0] < end && start < covers(c)[1]);
  if (hit) {
    throw new EditError('overlap', `Correction "${hit.id}" already covers some of these words; change that one instead`, {
      editId: hit.id,
    });
  }
}

export interface CorrectionInput {
  /** Default: the active revision. */
  revisionId?: string;
  segmentId: string;
  /** Both or neither. Neither replaces the whole segment text. */
  wordStart?: number;
  wordEnd?: number;
  /** May be empty, to remove the words. */
  text: string;
  /** An active correction this one replaces. */
  supersedes?: string;
}

/** Adds one correction with an explicit word range. */
export function addCorrection(layer: EditLayer, input: CorrectionInput, at: string): { plan: EditPlan; editId: string } {
  const revisionId = requireRevisionId(layer, input.revisionId);
  const segment = requireSegment(findRevision(layer, revisionId), input.segmentId);
  const text = normalizeText(input.text);
  checkText(text);
  const ranged = input.wordStart !== undefined || input.wordEnd !== undefined;
  if (ranged) {
    const { wordStart, wordEnd } = input;
    if (
      !Number.isInteger(wordStart) ||
      !Number.isInteger(wordEnd) ||
      (wordStart as number) < 0 ||
      (wordEnd as number) <= (wordStart as number) ||
      (wordEnd as number) > segment.words.length
    ) {
      throw new EditError('word-range', `Words [${wordStart}, ${wordEnd}) are not a range of segment "${segment.id}"`, {
        wordStart,
        wordEnd,
        words: segment.words.length,
      });
    }
  }
  const existing = segmentCorrections(layer, revisionId, segment.id);
  if (input.supersedes !== undefined && !existing.some((c) => c.id === input.supersedes)) {
    throw new EditError('edit-inactive', `"${input.supersedes}" is not an active correction of this segment`, { editId: input.supersedes });
  }
  const range = ranged ? { wordStart: input.wordStart as number, wordEnd: input.wordEnd as number } : {};
  assertNoOverlap(existing, { segmentId: segment.id, ...range }, input.supersedes);
  const id = idSource(layer)('c');
  const correction: Correction = {
    id,
    type: 'correction',
    revisionId,
    segmentId: segment.id,
    ...range,
    text,
    createdAt: at,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  };
  return { plan: { edits: [correction] }, editId: id };
}

/**
 * Sets what the user reads for one segment to `text`, as typed in an editor.
 * The new text is compared with the engine's words; the smallest differing
 * word range becomes one correction, so the words around it keep their own
 * times. Earlier corrections on the segment are superseded or retracted, never
 * rewritten. Text equal to what is shown changes nothing; text equal to what
 * was heard removes the corrections.
 */
export function correctSegment(
  layer: EditLayer,
  input: { revisionId?: string; segmentId: string; text: string },
  at: string,
): { plan: EditPlan; editIds: string[] } {
  const revisionId = requireRevisionId(layer, input.revisionId);
  const segment = requireSegment(findRevision(layer, revisionId), input.segmentId);
  const text = normalizeText(input.text);
  checkText(text);
  const existing = segmentCorrections(layer, revisionId, segment.id);
  if (text === normalizeText(correctedSegment(segment, existing).text)) return { plan: { edits: [] }, editIds: [] };

  let next: Pick<Correction, 'wordStart' | 'wordEnd' | 'text'> | null;
  if (segment.words.length === 0) {
    next = text === normalizeText(segment.text) ? null : { text };
  } else {
    const diff = wordDiff(
      segment.words.map((word) => word.text),
      text === '' ? [] : text.split(' '),
    );
    next = diff && { wordStart: diff.wordStart, wordEnd: diff.wordEnd, text: diff.text };
  }

  const newId = idSource(layer);
  const edits: Edit[] = [];
  const replaced = next && existing.length === 1 ? existing[0]!.id : undefined;
  for (const c of existing) {
    if (c.id !== replaced) edits.push({ id: newId('x'), type: 'retract', target: c.id, createdAt: at });
  }
  if (next) {
    edits.push({
      id: newId('c'),
      type: 'correction',
      revisionId,
      segmentId: segment.id,
      ...next,
      createdAt: at,
      ...(replaced === undefined ? {} : { supersedes: replaced }),
    });
  }
  return { plan: { edits }, editIds: edits.map((edit) => edit.id) };
}
