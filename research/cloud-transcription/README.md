# Direct cloud transcription adapters: research (board #16540)

Map #16531, slice C. The question: can the NarWal extension use Deepgram, AssemblyAI and
OpenAI directly with each user's own API key, with no NarWal server, and with consistent timing?

**Answer: yes, for all three, with one condition.** Every provider call that needs the long-lived
key runs in an extension context (service worker) that has `host_permissions` for the provider.
None of these REST endpoints send browser CORS headers, so the same call from a page or content
script fails. Browser WebSocket code cannot set an `Authorization` header. Deepgram takes its
credential in `Sec-WebSocket-Protocol`. AssemblyAI takes a temporary token in the URL. The
extension mints that token itself with the user's key.

Docs read 2026-10-13. No provider keys were available to this lane, so **no live call has been
made**. Every live path below is labelled UNTESTED-LIVE. `probe/live-probe.ts` runs each one in a
single command once a key is authorized (see [Live probe](#live-probe)).

## Evidence labels

| Label | Meaning |
|---|---|
| DOC | Stated in the provider's primary documentation (quoted in [Sources](#sources)). |
| SDK | Seen only in the provider's official SDK source, not in its docs. |
| FIXTURE | Implemented in `src/` and passing `test/adapters.test.ts` against documented message shapes with synthetic values. |
| UNTESTED-LIVE | Not run against the real service. |
| INFERENCE | Our reasoning; no source states it. |

## Capability matrix

| | Deepgram (live) | AssemblyAI (live) | OpenAI (after recording) |
|---|---|---|---|
| Endpoint | `wss://api.deepgram.com/v1/listen`, `model=nova-3` (DOC). A turn-based v2 "Flux" exists; it has no smart formatting or diarization, so v1 is the fit. | `wss://streaming.assemblyai.com/v3/ws` (DOC). `speech_model` default `universal-3-6-pro`, or `universal-streaming-english` (DOC). | `POST https://api.openai.com/v1/audio/transcriptions` (DOC) |
| Key use from the extension | Service worker: `POST /v1/auth/grant` with `Authorization: Token <key>`, body `{"ttl_seconds": 30}` → `{access_token, expires_in}` (DOC). The key needs at least Member permission (DOC). | Service worker: `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60` with `Authorization: <key>` → `{token, expires_in_seconds}` (DOC). | Service worker or offscreen document: `Authorization: Bearer <key>` (DOC). |
| Short-lived credential with no NarWal server | Yes. JWT, TTL 1–3600 s; it only needs to be valid while the socket opens (DOC). FIXTURE. UNTESTED-LIVE. | Yes. Token, 1–600 s to open a socket. It can start several sessions in that window, and `max_session_duration_seconds` (60–10800) caps each one (DOC). The docs say "generate this token on your server", because they assume a developer's key. Here the key is the user's own and already in the extension, so minting in the service worker adds no exposure (INFERENCE). FIXTURE. UNTESTED-LIVE. | None. OpenAI has no short-lived token for this endpoint, so the key is sent on each upload. |
| Socket credential from browser code | `new WebSocket(url, ['bearer', jwt])` (SDK) or `['token', key]` (DOC). FIXTURE. UNTESTED-LIVE. | `?token=<temporary token>`. The docs do not offer a raw key in the URL, and `src/assemblyai.ts` refuses one. FIXTURE. UNTESTED-LIVE. | n/a (HTTPS) |
| CORS for the REST call | None. The SDK README says browsers need a proxy (DOC). An MV3 extension context with `host_permissions` is exempt (INFERENCE from Chrome extension rules). UNTESTED-LIVE. | None. Our unauthenticated probe got `OPTIONS` 405 with no `Access-Control-Allow-*` header. Same extension exemption (INFERENCE). UNTESTED-LIVE. | Not documented. Same extension exemption (INFERENCE). UNTESTED-LIVE. |
| Audio in | PCM `encoding=linear16&sample_rate=N`, or containerized audio with both params left out (DOC). WebM/Opus from MediaRecorder on v1 is not named in the docs. | Binary frames: `pcm_s16le` (default 16 kHz), `pcm_mulaw`, `opus` (one packet per frame), `ogg_opus`, `aac` (DOC). WebM is not accepted. Each frame must carry 50–1000 ms, or the session closes with 3007 (DOC). | One file of at most 25 MB: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm (DOC). |
| Interim / final | `Results` with `is_final` (this window is settled) and `speech_final` (the utterance ended). Interim results for one window share `start` (DOC). FIXTURE. | `Turn` per `turn_order`, words carry `word_is_final`. `end_of_turn` closes it. With `format_turns=true` a formatted copy follows, and only that copy is final (DOC). FIXTURE. | Final only. |
| Word timing | `words[].start/end` in **seconds** from the start of the audio **on that connection** (DOC). | `words[].start/end` in **ms** from the start of the audio stream (DOC). | `words[].start/end` in **seconds** from the start of the file, **`whisper-1` only**. The parameters are `response_format=verbose_json`, `timestamp_granularities[]=word,segment` (DOC). `gpt-transcribe` and the `gpt-4o-*` models return text only. |
| Clock on reconnect | Resets to 0. Deepgram tells clients to keep their own offset (DOC). | New session (`Begin`), so the clock starts again at 0 (INFERENCE; there is no resume feature). | Per file. Split uploads need each range's start added back (FIXTURE: `planUploadRanges`). |
| Keepalive / idle | `{"type":"KeepAlive"}` every 3–5 s. The socket closes after 10 s with no frame: 1011 NET-0001 (DOC). | `inactivity_timeout` 5–3600 s is optional; idle sessions are still billed (DOC). | n/a |
| Session maximum | Not documented for `/v1/listen` (UNCONFIRMED). | 3 h, or the token's `max_session_duration_seconds`. Then close 3008, and the extra time is billed (DOC). | n/a |
| Concurrency / rate | 150 streams on Pay As You Go. Over the limit: 429 (DOC). | Free plan: 5 new sessions/min; paid: 100+/min, with no hard cap on open sessions. Unclosed sessions keep counting (DOC). | whisper-1: Free 3 RPM, Build tier 2,500 RPM (DOC). |
| Pacing | At most 1.25× real time, so a backlog replays with delay (DOC). | At most about 1.25× real time. More than 5 min buffered ahead closes the session with 3007 (DOC). | n/a |
| Billing basis | Processed audio, per second (DOC). `Metadata.duration` reports it. | **Socket open time**, not audio sent (DOC). `Termination.session_duration_seconds` reports it. | whisper-1: $0.006/min of audio (DOC). `usage` is `{type:"duration", seconds}`. |
| List price (2026-10-13) | Nova-3 English streaming $0.0048/min on Pay As You Go; $200 free credit (DOC). | Universal-Streaming English $0.15/h; Universal-3.6 Pro $0.45/h; $50 free credit (DOC). | whisper-1 $0.006/min (DOC). |
| 30 min of narration | ≈ $0.14 | ≈ $0.08 (English) or $0.23 (3.6 Pro), plus any idle time with the socket open | ≈ $0.18 per transcription. Each retranscription costs this again. |
| Data use | Not covered here. | Not covered here. | Not used for training. Transcriptions have no abuse-monitoring or app-state retention, and are eligible for zero data retention (DOC). |

## Where each piece runs

```
 content scripts (page)        offscreen document (USER_MEDIA)          service worker
 ─────────────────────         ───────────────────────────────          ──────────────
 rrweb capture, markers   ──▶  mic → AudioWorklet → PCM 16 kHz    ◀──── short-lived credential
 NEVER sees keys/tokens        LiveTranscriptionAdapter socket          (Deepgram JWT /
                               MediaRecorder narration file             AssemblyAI token)
                                                                        reads key from storage,
                                                                        mints, classifies HTTP
                                                                        errors, OpenAI upload
```

- An offscreen document can use only `chrome.runtime`, and an extension can have only one open at a time (DOC, Chrome). It receives credentials from the service worker by runtime message.
- `minimum_chrome_version: 116`. From that version, WebSocket traffic keeps an extension service worker alive (DOC, Chrome). The sockets still belong in the offscreen document, next to the microphone.
- `host_permissions`: `https://api.deepgram.com/*`, `https://streaming.assemblyai.com/*`, `https://api.openai.com/*`. Request each one only when the user enables that provider (`optional_host_permissions`).
- One audio path for both live providers: AudioWorklet → 16 kHz mono `pcm_s16le`. AssemblyAI cannot take WebM, and Deepgram's support for WebM on v1 is not documented. With one path, word timing has the same origin for both providers.
- The narration file, for replay and for OpenAI, is MediaRecorder WebM/Opus. At 32 kbit/s, 30 minutes is about 7.2 MB, well under OpenAI's 25 MB limit (FIXTURE: `planUploadRanges`). At higher bitrates, or for longer recordings, re-encode time ranges and upload each with its own `audioOriginMs`. Slice A (#16538) owns the recording format; this is a requirement on it, not a decision.

## Key isolation

1. Keys are entered on an extension page and stored in `chrome.storage.local`, never `storage.sync`, which copies data to every browser the user signs in to (DOC, Chrome). `storage.local` is exposed to content scripts by default. At startup call `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, or keep keys in extension-origin IndexedDB, which content scripts cannot open. Chrome's docs give no version for `setAccessLevel` on `local`: slice H confirms it on the minimum Chrome version.
2. Only the service worker reads a stored key. The offscreen document gets a 30 s Deepgram JWT or a 60 s AssemblyAI token. It gets a raw key only for an OpenAI upload, or when the user explicitly selects Deepgram's direct-key mode.
3. Keys never appear in URLs, logs, error text, recordings or exported bundles. The bundle exporter (slice D/K) serializes from an allowlist, so a stray key field cannot leak. The AssemblyAI token does appear in its socket URL, but it is short-lived and minted for a single recording.
4. Provider docs warn against keys in client code (DOC, all three). That warning is about a developer shipping their own key to users. Here each user brings their own key, and the remaining risk is local: anything that can read the extension's storage can read the key. The settings page says this in plain words (INFERENCE).
5. Mint each credential for one recording. Always send `CloseStream` (Deepgram) or `Terminate` (AssemblyAI). AssemblyAI bills, and rate-limits, unclosed sessions until they time out.

## Upload consent and no silent fallback

- **Live (Deepgram, AssemblyAI):** choosing the provider before a recording is the consent: "Your narration audio streams to <provider> with your key while you record." The choice is per recording, and the strip shows which provider is active.
- **After recording (OpenAI):** each upload needs an `UploadConsent` for that recording and provider. `buildOpenAiTranscriptionForm` refuses without one (FIXTURE).
- Page capture is never uploaded for transcription; only narration audio is. Masking a page region does not redact what the user says.
- Offline transcription (slice B/G) never uploads.
- **Never switch providers on failure.** A failed or disconnected provider produces a `TranscriptGap`, keeps recording, and offers an explicit retry with the same provider. It never retries offline or with another paid provider. Within Deepgram, a grant refused for missing Member permission stops and tells the user. Using the raw key instead is a setting the user turns on, never automatic.

## Timing on the session clock

All transcripts land on NarWal's session clock: milliseconds from recording start, owned by slice A.

- Each connection records `audioOriginMs`: the session time of the first sample it sends. Provider time plus `audioOriginMs` gives session time (`providerSecondsToSessionMs` / `providerMsToSessionMs`). Provider timestamps measure audio, not wall time, so a backlog replayed faster than real time still lands at the right place (FIXTURE).
- **Reconnect:** keep a ring buffer of PCM since the end of the last final segment. On reconnect, choose one:
  - **Replay** from the end of the last final segment: no gap. `dropReplayedWords` discards repeated words, and the audio sent twice is billed twice.
  - **Resume** at live audio: `gapBetweenConnections` records the untranscribed range as a `TranscriptGap`.

  The fixture test covers both with a Deepgram clock reset. Replay is bounded by the provider's 1.25× pacing: a 60 s outage takes about 4 minutes to catch up. Past a short limit, resume and record the gap instead (the limit is set in slice H/I).
- The boundary is the end of the final segment's audio window, not its last word. Deepgram finalizes up to `start + duration` (FIXTURE).
- Deepgram's 10 s idle close: send KeepAlive whenever no audio was sent in the last 4 s, for example while the user pauses the recording.

## Errors

| Signal | Kind | Retry | User sees |
|---|---|---|---|
| Deepgram grant 401/403 · AssemblyAI token 401 · OpenAI 401/403 · AssemblyAI close 1008 (invalid token) | auth | no | Key rejected or missing permission; fix in settings |
| OpenAI `insufficient_quota` · AssemblyAI 1008 "balance" · Deepgram 402 (not documented) | quota | no | Out of credit with the provider |
| HTTP 429 · AssemblyAI 3009 or 1008 "Too many concurrent sessions" | rate-limit | backoff, honour `Retry-After` | Delay shown; transcript gap |
| Deepgram 1008 DATA-0000 · AssemblyAI 3007 / 3006 bad message · OpenAI 400/413/415 | input | no | Bug in our audio path; report it |
| Deepgram 1011 NET-0001 · AssemblyAI 3006 inactivity · 3008 max duration | timeout | yes (a new session) | Nothing, if the reconnect replays; otherwise a gap |
| Deepgram 1011 · AssemblyAI 1011/3005 · OpenAI 5xx | provider | backoff | Retry button |
| Close 1006 with no reason | network | backoff | Reconnecting |

A failed WebSocket handshake reaches browser code only as close 1006, with no status. Deepgram returns its reason in a `dg-error` header that browser code cannot read (DOC). So before a retry, the adapter mints a new credential through the service worker. That REST call returns a readable 401 or 429, which tells an auth problem from a network one. Implemented as `classify*` functions (FIXTURE).

## Proposed adapter interface

`src/contract.ts` (erasable TypeScript, no build step):

- `LiveTranscriptionAdapter`: `start(options, onEvent)`, `sendAudio(chunk)`, `finish()` (flush pending audio to finals, then close cleanly), `abort()`. One instance per connection; `options.audioOriginMs` anchors its clock.
- `BatchTranscriptionAdapter.transcribe(request, credential, signal)` → `TranscriptRevision`. The request carries `UploadConsent` and `audioOriginMs`.
- Events: `segment` (interim/final, keyed by `segmentKey` so an interim is replaced by its final), `gap`, `error` (`ProviderError` with `kind` and `retryable`), `state`, `usage` (seconds and billing basis).
- Every provider transcript becomes a new `TranscriptRevision`, never an edit. User corrections and notes (slice M) live in a separate layer, so retranscription cannot erase them.
- Provider pieces: `src/deepgram.ts`, `src/assemblyai.ts`, `src/openai.ts`. Each has request builders, a per-connection normalizer to the contract, and error classification. Slices H, I and J add the socket and fetch plumbing around them.

## Untested, and how to close each gap

| Gap | Status | Closed by |
|---|---|---|
| Deepgram grant → `['bearer', jwt]` socket | UNTESTED-LIVE; bearer form is SDK-only | `live-probe --provider deepgram --live` |
| Deepgram `['token', key]` socket | UNTESTED-LIVE | `--deepgram-auth key` |
| AssemblyAI token minted with the user's key, no server → `?token=` socket | UNTESTED-LIVE | `live-probe --provider assemblyai --live` |
| OpenAI whisper-1 word timestamps | UNTESTED-LIVE | `live-probe --provider openai --live --consent-upload` |
| Providers accept a `chrome-extension://` Origin on the WebSocket | UNTESTED; the Node probe sends no Origin | First socket in slice H/I, from the offscreen document |
| `host_permissions` exempts the service worker's grant/token/upload calls from CORS | UNTESTED (INFERENCE) | First call in slice H/I/J |
| Deepgram v1 with MediaRecorder WebM | UNCONFIRMED; not used (PCM path) | Not needed |
| Deepgram maximum connection length; whether KeepAlive idle time is billed | UNCONFIRMED | Slice O 30-minute run |
| `storage.local.setAccessLevel` on the minimum Chrome version | UNCONFIRMED version | Slice H settings page |

## Live probe

`probe/live-probe.ts` uses only `fetch` and a WebSocket with no custom headers: the same limits browser code has. By default it sends nothing (`VERDICT=DRY-RUN`). With `--live` and no key in the environment, it reports `VERDICT=UNTESTED`. A live run streams a WAV at real time and prints final-word counts, the first and last word on the clock, provider usage and classified errors. It never prints the key or token.

```sh
cd research/cloud-transcription
node probe/live-probe.ts --provider deepgram   --audio speech.wav            # dry run
DEEPGRAM_API_KEY=… node probe/live-probe.ts --provider deepgram --audio speech.wav --live
ASSEMBLYAI_API_KEY=… node probe/live-probe.ts --provider assemblyai --audio speech.wav --live
OPENAI_API_KEY=… node probe/live-probe.ts --provider openai --audio speech.wav --live --consent-upload
```

Use non-sensitive fixture speech: 16-bit mono PCM WAV, 16 kHz, a few seconds of a scripted sentence. Each live run costs under one US cent at the prices above.

## Run the fixture tests

```sh
cd research/cloud-transcription && npm test     # Node 22.18+; 18 tests
```

## Sources

Deepgram
- https://developers.deepgram.com/reference/speech-to-text/listen-streaming
- https://developers.deepgram.com/docs/using-the-sec-websocket-protocol: "Sec-WebSocket-Protocol: token, YOUR_DEEPGRAM_API_KEY"
- https://developers.deepgram.com/reference/auth/tokens/grant: TTL "Defaults to 30 seconds"; "The max TTL supported is 3600 seconds"
- https://developers.deepgram.com/guides/fundamentals/token-based-authentication: the key "needs to have at least Member permissions"
- https://github.com/deepgram/deepgram-js-sdk (README: "you must use a proxy server when making REST API calls from browsers"; `AbstractLiveClient.ts`: `["bearer", accessToken]`)
- https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio: "timestamps on your audio begin from 00:00:00 again"
- https://developers.deepgram.com/docs/audio-keep-alive and https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors
- https://developers.deepgram.com/reference/api-rate-limits and https://deepgram.com/pricing: "We bill based on the total duration of processed audio."

AssemblyAI
- https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
- https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token: "`expires_in_seconds` must be a value between `1` and `600`"; "you can use the same token to start more than one session"; "You should generate this token on your server"
- https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures and https://www.assemblyai.com/docs/streaming/rate-limits
- https://www.assemblyai.com/pricing: "Billed on WebSocket session duration — open-to-close time, not audio sent."

OpenAI
- https://developers.openai.com/api/docs/guides/speech-to-text: "Files can be up to 25 MB"; "The `timestamp_granularities[]` parameter is only supported for `whisper-1`."
- https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- https://developers.openai.com/api/docs/guides/error-codes: "Retrying billing, spend, or quota errors won't restore API access."
- https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/guides/your-data

Chrome
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
