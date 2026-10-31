// Shared fixtures for the OpenAI adapter tests (board #16547). No test here reaches the network.

import { readFileSync } from 'node:fs';

import type { BatchTranscriptionRequest, UploadConsent } from '../../src/contract.ts';
import { encodeWavPcm16 } from '../../src/openai/audio.ts';

export const FAKE_KEY = 'sk-fixture-key-not-real';
export const CREDENTIAL = { kind: 'api-key' as const, key: FAKE_KEY };
export const RECORDING_ID = 'rec-1';

export const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/openai/${name}`, import.meta.url), 'utf8'));

export const consent = (grantedAtMs = 1000, overrides: Partial<UploadConsent> = {}): UploadConsent => ({
  provider: 'openai',
  recordingId: RECORDING_ID,
  grantedAtMs,
  scope: 'narration-audio',
  ...overrides,
});

export const request = (audio: Blob, overrides: Partial<BatchTranscriptionRequest> = {}): BatchTranscriptionRequest => ({
  recordingId: RECORDING_ID,
  audio,
  audioOriginMs: 0,
  consent: consent(),
  language: 'en',
  ...overrides,
});

export const webm = (bytes = 1000) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' });

/** Silent 16-bit mono WAV. At 1000 Hz one second is 2000 bytes, so limits are easy to reason about. */
export const wav = (seconds: number, sampleRate = 1000) => encodeWavPcm16(new Int16Array(seconds * sampleRate), sampleRate);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface Upload {
  authorization: string | null;
  file: File;
  fields: Record<string, string[]>;
}

/**
 * A stand-in for `fetch`. Each call takes the next reply; a function reply
 * sees the upload. Every call is recorded for assertions.
 */
export function fakeFetch(replies: Array<Response | Error | ((upload: Upload) => Response)>) {
  const uploads: Upload[] = [];
  const queue = [...replies];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const fields: Record<string, string[]> = {};
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') (fields[name] ??= []).push(value);
    }
    const upload = {
      authorization: new Headers(init?.headers).get('authorization'),
      file: form.get('file') as File,
      fields,
    };
    uploads.push(upload);
    const reply = queue.shift();
    if (reply === undefined) throw new Error('fakeFetch: no reply left');
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(upload) : reply;
  }) as typeof globalThis.fetch;
  return { fetch, uploads };
}

/** Timing knobs that make retries instant and exact. */
export function instant() {
  const sleeps: number[] = [];
  return {
    sleeps,
    options: {
      sleep: async (ms: number) => void sleeps.push(ms),
      random: () => 1,
      now: () => 1_700_000_000_000,
      newRevisionId: () => 'openai-test',
    },
  };
}

/** A verbose_json body with one segment; word times are seconds from the start of the upload. */
export const verbose = (words: Array<[string, number, number]>, duration: number) => ({
  task: 'transcribe',
  language: 'english',
  duration,
  text: words.map(([word]) => word).join(' '),
  segments: words.length
    ? [{ id: 0, start: words[0][1], end: words[words.length - 1][2], text: ` ${words.map(([word]) => word).join(' ')}.` }]
    : [],
  words: words.map(([word, start, end]) => ({ word, start, end })),
  usage: { type: 'duration', seconds: Math.ceil(duration) },
});
