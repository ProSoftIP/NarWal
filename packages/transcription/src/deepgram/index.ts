// Deepgram live transcription for one recording: the provider-neutral session
// driving DeepgramLiveAdapter connections.

import type { LiveCredential } from '../contract.ts';
import { LiveTranscriptionSession } from '../live-session.ts';
import type { LiveSessionSnapshot, ReconnectPolicy } from '../live-session.ts';
import type { Timers, WebSocketFactory } from '../socket.ts';
import { DeepgramLiveAdapter } from './live-adapter.ts';

export { DEEPGRAM_IDENTITY } from './protocol.ts';
export { mintDeepgramCredential, testDeepgramKey } from './credentials.ts';
export type { DeepgramAuthMode } from './credentials.ts';
export { DeepgramLiveAdapter } from './live-adapter.ts';

export interface DeepgramSessionOptions {
  /** Asks the service worker for a credential; called before every connection. */
  getCredential(): Promise<LiveCredential>;
  createSocket?: WebSocketFactory;
  timers?: Timers;
  model?: string;
  sampleRate?: number;
  reconnect?: Partial<ReconnectPolicy>;
  onUpdate?(snapshot: LiveSessionSnapshot): void;
  createId?(): string;
}

export function createDeepgramSession(options: DeepgramSessionOptions): LiveTranscriptionSession {
  const sampleRate = options.sampleRate ?? 16_000;
  return new LiveTranscriptionSession({
    provider: 'deepgram',
    getCredential: options.getCredential,
    createAdapter: () =>
      new DeepgramLiveAdapter({
        createSocket: options.createSocket,
        timers: options.timers,
        model: options.model,
        sampleRate,
      }),
    sampleRate,
    reconnect: options.reconnect,
    timers: options.timers,
    onUpdate: options.onUpdate,
    createId: options.createId,
  });
}
