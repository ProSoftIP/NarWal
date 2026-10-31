// Unit tests for the local timing and revision contract (board #16544):
// src/contract.ts against the shared cloud contract
// (packages/transcription/src/contract.ts). The local types must accept
// everything a cloud adapter produces, so one consumer reads both, and the
// shapes a revision is made of must be the same type in both files. The
// `Proofs` tuple makes `tsc` prove that; the tests then run cloud values
// through the local consumers. test/shared-contract.test.ts covers the other
// direction at run time (local revisions into the shared history).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cloud from '../../transcription/src/contract.ts';
import { FINAL_MODEL, LIVE_MODEL, LOCAL_PROVIDER, localError, providerSecondsToSessionMs } from '../src/contract.ts';
import type {
  AdapterEvent,
  AudioFormat,
  CloudGapReason,
  CloudProviderId,
  ErrorKind,
  GapReason,
  LocalGapReason,
  LocalLiveAdapter,
  LocalLiveOptions,
  LocalProviderId,
  ProviderError,
  ProviderId,
  RevisionTiming,
  TimingQuality,
  TranscriptGap,
  TranscriptRevision,
  TranscriptSegment,
  TranscriptWord,
} from '../src/contract.ts';
import { MODELS, transformersRuntime } from '../src/models.ts';
import { FINAL_CHAIN } from '../src/tier.ts';
import { LiveRevisionCollector, RevisionSet, toBundleRevision } from '../src/revisions.ts';
import { UiTranscriptTracker } from '../src/status.ts';

// --- compile-time proof ---------------------------------------------------------------

type Assignable<From, To> = [From] extends [To] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Each entry is computed by the compiler. The tuple below must hold exactly
 * these literals, so a local type that stops accepting its cloud twin (or a
 * check that stops discriminating) is a `tsc` error in this file.
 */
type Proofs = [
  // Everything a cloud adapter emits is valid for a local consumer.
  word: Assignable<cloud.TranscriptWord, TranscriptWord>,
  segment: Assignable<cloud.TranscriptSegment, TranscriptSegment>,
  gap: Assignable<cloud.TranscriptGap, TranscriptGap>,
  error: Assignable<cloud.ProviderError, ProviderError>,
  event: Assignable<cloud.AdapterEvent, AdapterEvent>,
  revision: Assignable<cloud.TranscriptRevision, TranscriptRevision>,
  errorKind: Assignable<cloud.ErrorKind, ErrorKind>,
  // What a revision is made of is the same type in both contracts, so a local
  // revision is a shared revision and the reverse.
  providers: Same<ProviderId, cloud.ProviderId>,
  gapReasons: Same<GapReason, cloud.GapReason>,
  timingQuality: Same<TimingQuality, cloud.TimingQuality>,
  revisionTiming: Same<RevisionTiming, NonNullable<cloud.TranscriptRevision['timing']>>,
  wordShape: Same<TranscriptWord, cloud.TranscriptWord>,
  segmentShape: Same<TranscriptSegment, cloud.TranscriptSegment>,
  gapShape: Same<TranscriptGap, cloud.TranscriptGap>,
  revisionShape: Same<TranscriptRevision, cloud.TranscriptRevision>,
  audioFormat: Same<AudioFormat, cloud.AudioFormat>,
  // The local split of the shared unions leaves nothing out and adds nothing.
  cloudProviders: Same<CloudProviderId, Exclude<cloud.ProviderId, LocalProviderId>>,
  cloudGapReasons: Same<CloudGapReason, Exclude<cloud.GapReason, LocalGapReason>>,
  // The local adapter has the cloud adapter's surface, minus the credential.
  adapterSurface: Same<keyof LocalLiveAdapter, keyof cloud.LiveTranscriptionAdapter>,
  sessionOptions: Same<keyof LocalLiveOptions, Exclude<keyof cloud.LiveSessionOptions, 'credential'>>,
  optionsWithoutCredential: Same<LocalLiveOptions, Omit<cloud.LiveSessionOptions, 'credential'>>,
  // A handler for local events is a valid handler for a cloud adapter.
  handler: Assignable<(event: AdapterEvent) => void, Parameters<cloud.LiveTranscriptionAdapter['start']>[1]>,
  // Local only, by design: the `backlog` event and the `model` error kind.
  // These three are false; a cloud consumer cannot take local events or errors.
  eventBack: Assignable<AdapterEvent, cloud.AdapterEvent>,
  errorBack: Assignable<ProviderError, cloud.ProviderError>,
  errorKindBack: Assignable<ErrorKind, cloud.ErrorKind>,
];

const PROOFS: Proofs = [
  // cloud → local
  true, true, true, true, true, true, true,
  // same type
  true, true, true, true, true, true, true, true, true,
  // the split of the unions
  true, true,
  // adapter surface
  true, true, true,
  // handler
  true,
  // local only
  false, false, false,
];

// --- cloud values, typed by the cloud contract ----------------------------------------------

const cloudWords: cloud.TranscriptWord[] = [
  { text: 'open', startMs: 10_120, endMs: 10_400, confidence: 0.98 },
  { text: 'settings', startMs: 10_440, endMs: 10_990 },
];

function cloudSegment(overrides: Partial<cloud.TranscriptSegment> = {}): cloud.TranscriptSegment {
  return {
    provider: 'deepgram',
    model: 'nova-3',
    connectionId: 'c1',
    segmentKey: 'c1:0',
    kind: 'final',
    startMs: 10_000,
    endMs: 11_000,
    text: 'open settings',
    words: cloudWords,
    endOfUtterance: true,
    ...overrides,
  };
}

const cloudGap: cloud.TranscriptGap = { provider: 'deepgram', startMs: 11_000, endMs: 14_500, reason: 'disconnected', detail: 'close code 1006' };
const cloudError: cloud.ProviderError = { provider: 'deepgram', kind: 'network', retryable: true, code: '1006', message: 'socket closed', retryAfterMs: 500 };

const cloudEvents: cloud.AdapterEvent[] = [
  { type: 'state', state: 'connecting' },
  { type: 'state', state: 'open' },
  { type: 'segment', segment: cloudSegment({ kind: 'interim', text: 'open', words: [cloudWords[0]], endOfUtterance: false }) },
  { type: 'segment', segment: cloudSegment() },
  { type: 'usage', provider: 'deepgram', audioSeconds: 11, basis: 'audio sent' },
  { type: 'error', error: cloudError },
  { type: 'gap', gap: cloudGap },
  { type: 'state', state: 'closed' },
];

const cloudRevision: cloud.TranscriptRevision = {
  revisionId: 'r1',
  provider: 'openai',
  model: 'whisper-1',
  createdAtMs: Date.UTC(2026, 9, 13, 12, 0, 0),
  source: 'after-recording',
  segments: [cloudSegment({ provider: 'openai', model: 'whisper-1', connectionId: 'file', segmentKey: 'file:0' })],
  gaps: [{ ...cloudGap, provider: 'openai', reason: 'rate-limited' }],
};

// --- tests ------------------------------------------------------------------------------------

test('the compiler checked every type relation in Proofs', () => {
  // The values are fixed by the types; this guards the count, so a relation
  // cannot be dropped from the list without the tuple and this test changing.
  assert.equal(PROOFS.length, 25);
  assert.equal(PROOFS.filter((holds) => holds).length, 22);
});

test('cloud values are accepted where the local types are expected, unchanged', () => {
  // Plain typed assignments: no cast. `tsc` rejects them if a local type narrows.
  const word: TranscriptWord = cloudWords[0];
  const segment: TranscriptSegment = cloudSegment();
  const gap: TranscriptGap = cloudGap;
  const error: ProviderError = cloudError;
  const events: AdapterEvent[] = cloudEvents;
  const revision: TranscriptRevision = cloudRevision;
  const format: AudioFormat = { kind: 'pcm_s16le', sampleRate: 16_000, channels: 1 } satisfies cloud.AudioFormat;

  assert.equal(word, cloudWords[0]);
  assert.equal(segment.timing, undefined, 'a cloud segment carries no timing field: absent means aligned');
  assert.equal(gap, cloudGap);
  assert.equal(error.retryAfterMs, 500);
  assert.equal(events, cloudEvents);
  assert.equal(revision.timing, undefined);
  assert.equal(revision.supersedes, undefined);
  assert.equal(format.kind, 'pcm_s16le');
});

test('the backlog event and the model error kind are local only', () => {
  // @ts-expect-error the cloud contract has no backlog event
  const backlog: cloud.AdapterEvent = { type: 'backlog', behind: true, lagMs: 5000 } satisfies AdapterEvent;
  // @ts-expect-error the cloud contract has no model error kind
  const kind: cloud.ErrorKind = 'model' satisfies ErrorKind;
  // @ts-expect-error so a local model error is not a cloud provider error
  const error: cloud.ProviderError = localError('model-missing', 'not installed', 'model');
  assert.deepEqual([backlog.type, kind, error.kind], ['backlog', 'model', 'model']);
});

test('local values are valid values of the shared contract: provider, gap reasons, timing, supersedes', () => {
  // Plain typed assignments in the other direction: no cast.
  const provider: cloud.ProviderId = LOCAL_PROVIDER;
  const reasons: cloud.GapReason[] = ['model-missing', 'model-corrupt', 'engine-failed', 'engine-behind', 'not-transcribed'] satisfies LocalGapReason[];
  const segment: TranscriptSegment = { ...cloudSegment(), provider: LOCAL_PROVIDER, model: FINAL_MODEL, timing: 'approximate' };
  const local: TranscriptRevision = {
    revisionId: 'r2',
    provider: LOCAL_PROVIDER,
    model: FINAL_MODEL,
    createdAtMs: 2_000,
    source: 'after-recording',
    segments: [segment],
    gaps: reasons.map((reason, index) => ({ provider: LOCAL_PROVIDER, startMs: 20_000 + index * 100, endMs: 20_050 + index * 100, reason })),
    timing: { quality: 'mixed', method: 'whisper-dtw', correctionMs: -150 },
    supersedes: 'r1',
  };
  const shared: cloud.TranscriptRevision = local;

  assert.equal(provider, 'browser-local');
  assert.equal(shared, local);
  assert.equal(shared.segments[0].timing, 'approximate');
  assert.equal(shared.timing?.quality, 'mixed');
  assert.equal(shared.supersedes, 'r1');
  assert.deepEqual(
    shared.gaps.map((gap) => gap.reason),
    reasons,
  );
});

test('a cloud adapter can drive the local consumers with its own events', async () => {
  const collector = new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 1_000, model: 'nova-3' });
  const tracker = new UiTranscriptTracker();
  const seen: AdapterEvent['type'][] = [];
  const states: string[] = [];

  // A stand-in typed by the cloud interface: `start` takes the local handler.
  const adapter: Pick<cloud.LiveTranscriptionAdapter, 'start'> = {
    async start(_options, onEvent) {
      for (const event of cloudEvents) onEvent(event);
    },
  };
  await adapter.start({ credential: { kind: 'api-key', key: 'test' }, language: 'en', audioOriginMs: 10_000, connectionId: 'c1' }, (event: AdapterEvent) => {
    seen.push(event.type);
    collector.onEvent(event);
    tracker.onEvent(event);
    states.push(tracker.get().state);
  });

  assert.equal(seen.length, cloudEvents.length);
  assert.deepEqual(states, ['connecting', 'live', 'live', 'live', 'live', 'live', 'live', 'disconnected']);
  const revision = collector.revision();
  assert.deepEqual(revision.segments, [cloudSegment()], 'the final segment only, untouched');
  assert.deepEqual(revision.gaps, [cloudGap]);
});

test('a cloud revision is stored and written to the draft bundle shape without loss', () => {
  const set = new RevisionSet();
  set.add(cloudRevision);
  assert.deepEqual(set.get('r1'), cloudRevision);

  assert.deepEqual(toBundleRevision(cloudRevision, { extensions: false }), {
    revisionId: 'r1',
    source: 'after-recording',
    provider: 'openai',
    model: 'whisper-1',
    language: 'en',
    createdAt: '2026-10-13T12:00:00.000Z',
    segments: [
      {
        id: 's1',
        startMs: 10_000,
        endMs: 11_000,
        text: 'open settings',
        words: [
          { text: 'open', startMs: 10_120, endMs: 10_400, confidence: 0.98 },
          { text: 'settings', startMs: 10_440, endMs: 10_990 },
        ],
      },
    ],
    gaps: [{ startMs: 11_000, endMs: 14_500, reason: 'rate-limited' }],
  });
});

test('with extensions a cloud revision reads as aligned and keeps its gap reason and detail', () => {
  const file = toBundleRevision(cloudRevision);
  assert.equal(file.segments[0].timing, 'aligned');
  assert.deepEqual(file.gaps, [{ startMs: 11_000, endMs: 14_500, reason: 'rate-limited', detail: 'close code 1006' }]);
  assert.equal('timing' in file, false, 'no revision timing was invented');
  assert.equal('supersedes' in file, false);
});

test('every cloud gap reason passes through toBundleRevision unchanged', () => {
  const reasons: cloud.GapReason[] = ['connect-failed', 'disconnected', 'provider-error', 'rate-limited', 'auth-failed', 'user-stopped-provider'];
  const revision: cloud.TranscriptRevision = { ...cloudRevision, gaps: reasons.map((reason, index) => ({ provider: 'deepgram', startMs: index * 100, endMs: index * 100 + 50, reason })) };
  assert.deepEqual(
    toBundleRevision(revision).gaps.map((gap) => gap.reason),
    reasons,
  );
});

test('providerSecondsToSessionMs gives the same session time as the cloud function', () => {
  const origins = [0, 1, 12_345, 3_599_999, -250];
  const seconds = [0, 0.0004, 0.0005, 0.0015, 0.4995, 1, 1.0005, 2.675, 12.3456, 59.9996, 3600.25, -0.0005, -1.2345, 1e-9];
  for (const origin of origins) {
    for (const value of seconds) {
      const local = providerSecondsToSessionMs(origin, value);
      assert.equal(local, cloud.providerSecondsToSessionMs(origin, value), `origin ${origin}, ${value} s`);
      assert.ok(Number.isInteger(local), `origin ${origin}, ${value} s is a whole millisecond`);
    }
  }
});

test('providerSecondsToSessionMs adds the audio origin to engine seconds, rounded to the millisecond', () => {
  assert.equal(providerSecondsToSessionMs(0, 0), 0);
  assert.equal(providerSecondsToSessionMs(0, 1.5), 1500);
  assert.equal(providerSecondsToSessionMs(30_000, 1.5), 31_500);
  assert.equal(providerSecondsToSessionMs(30_000, 0.0306), 30_031);
  assert.equal(providerSecondsToSessionMs(30_000, 0.0294), 30_029);
  assert.equal(providerSecondsToSessionMs(30_000, 0), 30_000, 'the first sample is at the origin');
});

test('localError fills every field of a provider error', () => {
  assert.deepEqual(localError('model-missing', 'The live model is not installed.', 'model'), {
    provider: 'browser-local',
    kind: 'model',
    retryable: false,
    code: 'model-missing',
    message: 'The live model is not installed.',
  });
  assert.deepEqual(localError('engine-stalled', 'no result for 10 s', 'provider', true), {
    provider: 'browser-local',
    kind: 'provider',
    retryable: true,
    code: 'engine-stalled',
    message: 'no result for 10 s',
  });
});

test('localError defaults to a provider error that is not retryable, with no retry delay', () => {
  const error = localError('engine-failed', 'worker crashed');
  assert.equal(error.kind, 'provider');
  assert.equal(error.retryable, false);
  assert.equal(error.provider, LOCAL_PROVIDER);
  assert.equal('retryAfterMs' in error, false);
  assert.equal(localError('x', 'y', 'timeout').retryable, false, 'a kind alone does not make it retryable');
});

test('localError returns a new object each call', () => {
  const first = localError('engine-failed', 'a');
  const second = localError('engine-failed', 'a');
  assert.notEqual(first, second);
  first.message = 'changed';
  assert.equal(second.message, 'a');
});

test('the contract names the pinned models: one live, and the final chain of each tier (board #16603)', () => {
  assert.equal(MODELS[LIVE_MODEL].role, 'live');
  assert.equal(MODELS[FINAL_MODEL].role, 'final');
  const finals = [...new Set([...FINAL_CHAIN.webgpu, ...FINAL_CHAIN.wasm])];
  for (const id of finals) assert.equal(MODELS[id].role, 'final', id);
  // Nothing is pinned that neither a tier nor the proof extension runs. Since
  // #16609 no tier runs base.en (FINAL_MODEL); the proof extension still does.
  assert.deepEqual(Object.keys(MODELS).sort(), [...new Set([LIVE_MODEL, FINAL_MODEL, ...finals])].sort());
  assert.equal(FINAL_CHAIN.wasm.at(-1), 'moonshine-base-q8');
  assert.equal(transformersRuntime('moonshine-base-q8').wordTimes, 'none', 'Moonshine gives text only; the pass spreads its words');
  assert.equal(new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 0 }).revision().model, LIVE_MODEL);
  assert.equal(new LiveRevisionCollector({ revisionId: 'r1', createdAtMs: 0 }).revision().provider, LOCAL_PROVIDER);
});
