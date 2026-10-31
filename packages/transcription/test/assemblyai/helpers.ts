// Test doubles for the AssemblyAI adapter: a fake socket and a manual clock.

import { readFileSync } from 'node:fs';
import type { AdapterEvent, TranscriptSegment } from '../../src/contract.ts';
import type { WebSocketLike } from '../../src/assemblyai/adapter.ts';

export const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/assemblyai/${name}`, import.meta.url), 'utf8'));

export const segments = (events: AdapterEvent[]): TranscriptSegment[] =>
  events.flatMap((event) => (event.type === 'segment' ? [event.segment] : []));

/** Applies interim/final replacement the way the transcript store does. */
export function settle(all: TranscriptSegment[]): TranscriptSegment[] {
  const byKey = new Map<string, TranscriptSegment>();
  for (const segment of all) byKey.set(segment.segmentKey, segment);
  return [...byKey.values()].filter((segment) => segment.kind === 'final');
}

export class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly url: string;
  readonly sent: Array<ArrayBuffer | string> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: ArrayBuffer | string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  // Server side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }

  get audioFrames(): ArrayBuffer[] {
    return this.sent.filter((data): data is ArrayBuffer => typeof data !== 'string');
  }

  get controlMessages(): string[] {
    return this.sent.filter((data): data is string => typeof data === 'string').map((data) => JSON.parse(data).type);
  }
}

/** Manual clock and timers so pacing and timeouts are deterministic. */
export class ManualClock {
  nowMs = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;

  setTimer = (callback: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const end = this.nowMs + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = Math.max(this.nowMs, due[1].at);
      due[1].callback();
    }
    this.nowMs = end;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** n milliseconds of 16 kHz mono s16le audio. */
export const pcm = (ms: number): ArrayBuffer => new ArrayBuffer(Math.round((16000 * ms) / 1000) * 2);

export const bytesToMs = (bytes: number): number => (bytes / 2 / 16000) * 1000;
