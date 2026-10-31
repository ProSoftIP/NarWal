# @narwal/transcription

Provider adapters and the provider-neutral live session for NarWal v1.
No dependencies; TypeScript with erasable syntax only, run directly by
Node ≥ 22.18 (`npm test`).

## Deepgram live (board #16545)

| Part | File |
| --- | --- |
| Wire protocol, word normalization, close/HTTP error classes | `src/deepgram/protocol.ts` |
| Credentials: temporary grant token or direct key, key test | `src/deepgram/credentials.ts` |
| One WebSocket connection (`LiveTranscriptionAdapter`) | `src/deepgram/live-adapter.ts` |
| `createDeepgramSession()` | `src/deepgram/index.ts` |
| Reconnect, replay, gaps, finalization (any provider) | `src/live-session.ts` |
| Explicit retry of a gap from local audio | `src/gap-retry.ts` |
| Personal keys in `chrome.storage.local`, trusted contexts only | `src/key-store.ts` |
| Provider name, direct-billing and consent notices | `src/provider-identity.ts` |

Where each part runs in the extension:

- The **service worker** owns `ProviderKeyStore` and calls
  `mintDeepgramCredential` before every connection. Keys never reach a
  content script or the page.
- The **offscreen document** owns the microphone and the
  `LiveTranscriptionSession`; it asks the service worker for a credential.
- The **UI** shows `DEEPGRAM_IDENTITY.displayName`, `billingNotice` and
  `consentNotice`, and the session `status.phase`.

Behaviour:

- The provider is chosen explicitly and never switched; a gap is retried
  only with the provider that left it.
- Interim results replace each other per window (`segmentKey`); only
  finals reach a revision. Times are session ms (`audioOriginMs` + provider
  time, which restarts at 0 on every connection).
- A drop reconnects with backoff (Retry-After honoured), re-minting the
  credential each time. Audio since the last final is replayed when it is
  at most 15 s, and repeated words are dropped; otherwise the session
  resumes at live audio and records a `TranscriptGap`.
- A rejected key, exhausted quota or bad input stops the session for the
  user; `retry()` resumes explicitly. Secrets are redacted from every
  message.
- `finish()` sends `CloseStream`, keeps the flushed finals and returns a
  revision with the provider service record (API, requested and reported
  model, model version, request IDs, auth kind).

The revision maps field for field onto bundle schema §8.1
(`docs/bundle-schema.md`); the bundle writer adds segment `id`, ISO
`createdAt` and `language`, and stores only finals.

## What was tested

- API: `wss://api.deepgram.com/v1/listen`, `POST /v1/auth/grant`,
  `GET /v1/projects`. Requested model `nova-3`, `linear16` 16 kHz mono.
- Tests use recorded-shape **synthetic** fixtures (`fixtures/deepgram/`)
  and fake sockets/timers: partial→final reconciliation, CloseStream flush,
  disconnect with replay, long outage gap, rejected key, refused handshake,
  Retry-After, retries exhausted then explicit retry, pause discontinuity,
  timing offsets, key redaction.
- Live, with a wrong key (2026-10-13): `POST /v1/auth/grant` answers
  HTTP 400 `{"err_code":"BAD_REQUEST","err_msg":"Invalid credentials."}`
  (not 401); `GET /v1/projects` answers 401 with the text in `message`.
  Both classify as `auth`, so the session stops and names the key.
- **Live smoke: UNTESTED-LIVE.** Matt's decision for v1 (board q3549,
  Telegram 2026-10-13 22:18Z): "just skip the third party things for now".
  No real-key Deepgram run was made; the adapter ships on the fixture tests
  above. The reported model name and version in the fixtures are
  placeholders until a live run records them. The run is
  `DEEPGRAM_API_KEY=... node scripts/deepgram-smoke.ts --audio speech.wav --live`
  (16 kHz mono WAV; see the script header).
