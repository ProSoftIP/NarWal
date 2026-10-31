// Converts AssemblyAI Universal Streaming v3 server messages from ONE connection
// into contract events on NarWal's session clock (board #16546).
// Source (read 2026-10-13): https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket

import type { AdapterEvent, TranscriptSegment, TranscriptWord } from '../contract.ts';
import { providerMsToSessionMs } from '../contract.ts';
import { classifyAssemblyAiError } from './stream.ts';

interface AssemblyAiWord {
  text: string;
  /** Milliseconds from the first audio byte of this connection. */
  start: number;
  end: number;
  confidence?: number;
  word_is_final?: boolean;
}

export interface NormalizerOptions {
  /** True when the socket was opened with format_turns=true. */
  formatTurns?: boolean;
  /** Model the request named; used until Begin reports the applied one. */
  requestedModel?: string;
}

/**
 * Revision rules:
 * - every Turn message for one `turn_order` shares a segmentKey, so a later
 *   message replaces the earlier one in the transcript store;
 * - without format_turns, the message with `end_of_turn: true` is final;
 * - with format_turns, the unformatted end-of-turn copy stays interim and the
 *   formatted copy that follows is final. If the socket closes between the two,
 *   `flushPendingTurns()` promotes the unformatted copy so `finish()` loses no words.
 */
export class AssemblyAiNormalizer {
  private model: string;
  private readonly audioOriginMs: number;
  private readonly connectionId: string;
  private readonly formatTurns: boolean;
  private sessionId: string | undefined;
  /** End-of-turn segments still waiting for their formatted copy. */
  private readonly awaitingFormat = new Map<number, TranscriptSegment>();
  private readonly finalized = new Set<number>();
  private lastFinalEnd: number;

  constructor(audioOriginMs: number, connectionId: string, options: NormalizerOptions = {}) {
    this.audioOriginMs = audioOriginMs;
    this.connectionId = connectionId;
    this.formatTurns = options.formatTurns ?? false;
    this.model = options.requestedModel ?? 'unknown';
    this.lastFinalEnd = audioOriginMs;
  }

  /** Model AssemblyAI reported in Begin (or the requested one before Begin). */
  get reportedModel(): string {
    return this.model;
  }

  get providerSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Session-clock end of the last final segment's audio; replay starts here. */
  get lastFinalEndMs(): number {
    return this.lastFinalEnd;
  }

  handle(message: Record<string, unknown>): AdapterEvent[] {
    switch (message.type) {
      case 'Begin': {
        const configuration = message.configuration as { speech_model?: unknown; model?: unknown } | undefined;
        const applied = configuration?.model ?? configuration?.speech_model;
        if (typeof applied === 'string' && applied !== '') this.model = applied;
        if (typeof message.id === 'string') this.sessionId = message.id;
        return [{ type: 'state', state: 'open' }];
      }
      case 'Turn':
        return this.turn(message);
      case 'Termination':
        return [
          {
            type: 'usage',
            provider: 'assemblyai',
            // AssemblyAI bills socket open time, not audio sent.
            audioSeconds: Number(message.session_duration_seconds ?? 0),
            basis: 'session-duration-seconds',
          },
        ];
      case 'Error': {
        const code = typeof message.error_code === 'number' ? message.error_code : undefined;
        return [{ type: 'error', error: classifyAssemblyAiError(code, String(message.error ?? '')) }];
      }
      default:
        // SpeechStarted, Heartbeat, SpeakerRevision: not part of the transcript contract.
        return [];
    }
  }

  /** Promotes end-of-turn segments whose formatted copy never arrived. */
  flushPendingTurns(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    for (const [order, segment] of [...this.awaitingFormat.entries()].sort((a, b) => a[0] - b[0])) {
      events.push({ type: 'segment', segment: this.markFinal(order, segment) });
    }
    this.awaitingFormat.clear();
    return events;
  }

  private turn(message: Record<string, unknown>): AdapterEvent[] {
    const order = Number(message.turn_order);
    if (!Number.isInteger(order) || order < 0) return [];
    // A connection never revises a turn it already finalized.
    if (this.finalized.has(order)) return [];
    const raw = Array.isArray(message.words) ? (message.words as AssemblyAiWord[]) : [];
    const words: TranscriptWord[] = raw
      .filter((word) => typeof word?.text === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end))
      .map((word) => ({
        text: word.text,
        startMs: providerMsToSessionMs(this.audioOriginMs, word.start),
        endMs: providerMsToSessionMs(this.audioOriginMs, word.end),
        ...(typeof word.confidence === 'number' ? { confidence: word.confidence } : {}),
      }));
    const endOfTurn = message.end_of_turn === true;
    // `transcript` holds only the turn's finalized words; an interim display
    // also wants the words still being revised, so it joins `words` instead.
    const joined = words.map((word) => word.text).join(' ');
    const transcript = String(message.transcript ?? '').trim();
    const text = endOfTurn ? transcript || joined : joined || transcript;
    if (words.length === 0 && text === '') return [];
    const formatted = message.turn_is_formatted === true;
    const segment: TranscriptSegment = {
      provider: 'assemblyai',
      model: this.model,
      connectionId: this.connectionId,
      segmentKey: `${this.connectionId}:${order}`,
      kind: 'interim',
      startMs: words[0]?.startMs ?? this.audioOriginMs,
      endMs: words.at(-1)?.endMs ?? this.audioOriginMs,
      text,
      words,
      endOfUtterance: false,
    };
    if (endOfTurn && (!this.formatTurns || formatted)) {
      this.awaitingFormat.delete(order);
      return [{ type: 'segment', segment: this.markFinal(order, segment) }];
    }
    if (endOfTurn) this.awaitingFormat.set(order, segment);
    return [{ type: 'segment', segment }];
  }

  private markFinal(order: number, segment: TranscriptSegment): TranscriptSegment {
    this.finalized.add(order);
    this.lastFinalEnd = Math.max(this.lastFinalEnd, segment.endMs);
    return { ...segment, kind: 'final', endOfUtterance: true };
  }
}
