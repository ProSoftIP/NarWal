// Test doubles: a scripted WebSocket and a manual clock. No network, no real time.

import { readFileSync } from 'node:fs';

import type { PcmChunk } from '../src/live-session.ts';
import type { Timers, WebSocketLike } from '../src/socket.ts';

export const FAKE_KEY = 'dg-test-key-0123456789abcdef';

export function fixture(path: string) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));
}

export class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  protocol = '';
  readonly sent: Array<string | ArrayBuffer> = [];
  closedByClient: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedByClient = { code, reason };
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  serverOpen(): void {
    this.readyState = 1;
    this.protocol = this.protocols[0] ?? '';
    this.onopen?.({});
  }

  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  audioFrames(): ArrayBuffer[] {
    return this.sent.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
  }

  textFrames(): unknown[] {
    return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
  }
}

export class SocketRecorder {
  readonly sockets: FakeSocket[] = [];
  readonly create = (url: string, protocols: string[]) => {
    const socket = new FakeSocket(url, protocols);
    this.sockets.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket created');
    return socket;
  }
}

interface Scheduled {
  id: number;
  at: number;
  every: number | null;
  callback: () => void;
}

export class ManualTimers implements Timers {
  private clock: number;
  private nextId = 1;
  private scheduled: Scheduled[] = [];

  constructor(start = 1_000_000) {
    this.clock = start;
  }

  now(): number {
    return this.clock;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, at: this.clock + ms, every: null, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled = this.scheduled.filter((item) => item.id !== handle);
  }

  setInterval(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, at: this.clock + ms, every: ms, callback });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  /** Moves the clock forward, firing due callbacks in time order. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.scheduled.filter((item) => item.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.clock = due.at;
      if (due.every === null) this.scheduled = this.scheduled.filter((item) => item !== due);
      else due.at += due.every;
      due.callback();
    }
    this.clock = target;
  }

  pending(): number {
    return this.scheduled.length;
  }
}

/** Lets pending promise callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 16 kHz s16le mono silence of `ms` milliseconds starting at `startMs`. */
export function pcm(startMs: number, ms: number, sampleRate = 16_000): PcmChunk {
  return { data: new ArrayBuffer((sampleRate * 2 * ms) / 1000), startMs };
}

export interface WordSpec {
  word: string;
  start: number;
  end: number;
}

/** A Deepgram v1 Results message in the documented shape. Times in provider seconds. */
export function dgResults(spec: {
  start: number;
  duration: number;
  isFinal: boolean;
  speechFinal?: boolean;
  words: WordSpec[];
  requestId?: string;
}) {
  return {
    type: 'Results',
    channel_index: [0, 1],
    start: spec.start,
    duration: spec.duration,
    is_final: spec.isFinal,
    speech_final: spec.speechFinal ?? false,
    from_finalize: false,
    channel: {
      alternatives: [
        {
          transcript: spec.words.map((word) => word.word).join(' '),
          confidence: 0.9,
          words: spec.words.map((word) => ({ word: word.word.toLowerCase(), punctuated_word: word.word, start: word.start, end: word.end, confidence: 0.9 })),
        },
      ],
    },
    metadata: { request_id: spec.requestId ?? 'req-x', model_info: { name: 'general-nova-3', version: '2026-01-01.0', arch: 'nova-3' } },
  };
}
