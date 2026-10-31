// Provider-neutral session rules, driven by a scripted adapter so they hold for
// every provider, not only Deepgram's close codes.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdapterEvent, LiveSessionOptions, ProviderError } from '../src/contract.ts';
import { LiveTranscriptionSession, ProviderErrorException } from '../src/live-session.ts';
import type { ServiceReportingAdapter } from '../src/live-session.ts';
import { ManualTimers, pcm, settle } from './helpers.ts';

class ScriptedAdapter implements ServiceReportingAdapter {
  readonly provider = 'assemblyai' as const;
  readonly audioFormat = { kind: 'pcm_s16le', sampleRate: 16_000, channels: 1 } as const;
  credential: LiveSessionOptions['credential'] | null = null;
  private onEvent: ((event: AdapterEvent) => void) | null = null;

  async start(options: LiveSessionOptions, onEvent: (event: AdapterEvent) => void): Promise<void> {
    this.credential = options.credential;
    this.onEvent = onEvent;
    onEvent({ type: 'state', state: 'connecting' });
    onEvent({ type: 'state', state: 'open' });
  }

  sendAudio(): void {}
  async finish(): Promise<void> {
    this.onEvent?.({ type: 'state', state: 'closed' });
  }
  abort(): void {}

  /** The provider accepted the socket, then refused the token. */
  refuseToken(): void {
    const error: ProviderError = {
      provider: 'assemblyai',
      kind: 'auth',
      retryable: true,
      code: '1008',
      message: 'Unauthorized Connection',
    };
    this.onEvent?.({ type: 'error', error });
    this.onEvent?.({ type: 'state', state: 'closed' });
  }
}

function harness(mint: (call: number) => LiveSessionOptions['credential']) {
  const timers = new ManualTimers();
  const adapters: ScriptedAdapter[] = [];
  let calls = 0;
  let ids = 0;
  const session = new LiveTranscriptionSession({
    provider: 'assemblyai',
    createAdapter: () => {
      const adapter = new ScriptedAdapter();
      adapters.push(adapter);
      return adapter;
    },
    getCredential: async () => mint(++calls),
    timers,
    reconnect: { maxAttempts: 3 },
    createId: () => `id-${++ids}`,
  });
  return { timers, adapters, session, calls: () => calls };
}

test('a token refused after open reconnects with a freshly minted credential', async () => {
  const { timers, adapters, session, calls } = harness((call) => ({ kind: 'temporary-token', token: `t${call}`, expiresAtMs: 0 }));
  session.pushAudio(pcm(0, 100));
  await settle();
  adapters[0].refuseToken();
  assert.equal(session.snapshot().status.phase, 'reconnecting');
  timers.advance(1_000);
  await settle();
  assert.equal(session.snapshot().status.phase, 'live');
  assert.equal(calls(), 2);
  assert.deepEqual(adapters[1].credential, { kind: 'temporary-token', token: 't2', expiresAtMs: 0 });
});

test('opening does not reset the attempt count, so repeated refusals stop the session', async () => {
  const { timers, adapters, session } = harness((call) => ({ kind: 'temporary-token', token: `t${call}`, expiresAtMs: 0 }));
  session.pushAudio(pcm(0, 100));
  await settle();
  for (let round = 0; round < 3; round += 1) {
    adapters.at(-1)!.refuseToken();
    assert.equal(session.snapshot().status.phase, 'reconnecting');
    timers.advance(60_000);
    await settle();
  }
  adapters.at(-1)!.refuseToken();
  assert.equal(session.snapshot().status.phase, 'stopped');
  assert.equal(adapters.length, 4);
});

test('a connection that stayed open 10 s is healthy and resets the attempt count', async () => {
  const { timers, adapters, session } = harness((call) => ({ kind: 'temporary-token', token: `t${call}`, expiresAtMs: 0 }));
  session.pushAudio(pcm(0, 100));
  await settle();
  adapters[0].refuseToken();
  timers.advance(1_000);
  await settle();
  timers.advance(10_000);
  adapters[1].refuseToken();
  assert.equal(session.snapshot().status.attempt, 1);
});

test('the mint names a bad key as non-retryable, which stops at once', async () => {
  const { timers, adapters, session } = harness((call) => {
    if (call === 1) return { kind: 'temporary-token', token: 't1', expiresAtMs: 0 };
    throw new ProviderErrorException({ provider: 'assemblyai', kind: 'auth', retryable: false, code: '401', message: 'Invalid API key' });
  });
  session.pushAudio(pcm(0, 100));
  await settle();
  adapters[0].refuseToken();
  timers.advance(1_000);
  await settle();
  assert.equal(session.snapshot().status.phase, 'stopped');
  assert.equal(session.snapshot().status.error?.retryable, false);
  assert.equal(adapters.length, 1);
});
