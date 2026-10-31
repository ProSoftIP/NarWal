# AssemblyAI live transcription (board #16546)

Slice I of map #16531. The AssemblyAI live adapter behind the shared contract in
`../contract.ts`, using each user's own key and no NarWal server.
Research and sources: `research/cloud-transcription/README.md` (#16540).

## Where each piece runs

| Piece | Context | Holds |
|---|---|---|
| `mintAssemblyAiToken(fetch, key)` (`token.ts`) | Service worker, with host permission for `https://streaming.assemblyai.com/*` | The user's key. It goes in the `Authorization` header, never in a URL. `credentials: 'omit'`. |
| `AssemblyAiLiveAdapter` (`adapter.ts`) | Offscreen document, next to the microphone | Only the temporary token. The adapter refuses a raw key. |
| Page and content scripts | Page | Nothing. They never receive a key or a token. |

The key store (`../key-store.ts`, `chrome.storage.local` with `TRUSTED_CONTEXTS`) and
the reconnect, replay and gap driver (`../live-session.ts`) come from #16545. The live
session calls `getCredential()` once per connection. Wire it like this:

```ts
getCredential: async () => {
  const result = await mintAssemblyAiToken(fetch, await keyStore.get('assemblyai'));
  if (!result.ok) throw new ProviderErrorException(result.error);
  return result.credential;
},
createAdapter: () => new AssemblyAiLiveAdapter({ speechModel }),
```

## Behaviour

- **Token**: 60 s redemption window. The window covers only the socket opening; a
  session can run for up to 3 h. The adapter refuses a token with less than 5 s left
  (`token-expired`, retryable), so the session mints a new one.
- **Audio**: 16 kHz mono `pcm_s16le`, reframed into 100 ms binary messages. AssemblyAI
  accepts 50 to 1000 ms per message. The tail at `finish()` is padded with silence to 50 ms.
- **Pacing**: audio sent never exceeds 1.2× the elapsed time plus one frame (100 ms),
  measured on `performance.now`, so a system clock jump cannot burst or stall it. AssemblyAI closes a session with
  3007 when audio arrives faster than real time, and a reconnect replay would do that.
  A 60 s backlog takes about 5 minutes to drain at 1.2×, so the session decides when to
  stop replaying and record a gap.
- **Interim and final**: every `Turn` for one `turn_order` shares one `segmentKey`.
  Interim text joins the live `words`, so revised words show. `transcript` holds only
  finalized words. Without `format_turns`, `end_of_turn` is final. With `format_turns`,
  only the formatted copy is final. A turn finalized once is never revised.
- **Timing**: word `start` and `end` are milliseconds from the first byte on that
  connection. They become session time as `audioOriginMs + ms`.
  `lastFinalEndMs` is where a replay starts.
- **finish()**: sends the queued audio at the paced rate, then `ForceEndpoint` and
  `Terminate`. It waits for `Termination` and the close, or for the timeout (10 s after
  the backlog drains). A turn still waiting for its formatted copy is promoted to final,
  so no words are lost. `usage` reports `session_duration_seconds`, because AssemblyAI
  bills socket open time.
- **abort()**: sends `Terminate`, closes at once and drops interim turns.
- **start() failure**: rejects with `AssemblyAiConnectError` (`.error` is the
  `ProviderError`). It emits no `error` event. If the server sends an `Error` frame
  before closing, its text is used, because the close reason is cut at 123 bytes.

## Models, language and limits

| | |
|---|---|
| Language | English only in v1 (q3533). |
| Default model | `universal-streaming-english`: $0.15/h, `format_turns` on. |
| Optional model | `universal-3-6-pro`: $0.45/h. It formats final turns itself, so no `format_turns` is sent. |
| Not offered | `universal-streaming-multilingual` and `universal-3-5-pro`: not English-only v1. |
| Billing | Socket open time, not audio sent. Pausing a recording without closing the socket still costs money. |
| Session maximum | 3 h, or `max_session_duration_seconds` on the token. Close 3008 is a retryable timeout, so the session opens a new connection. |
| Rate | Free plan: 5 new sessions/min. Paid: 100+/min. Close 3009 or "Too many concurrent sessions" is a retryable rate limit. |
| Idle | No `inactivity_timeout` by default. The socket stays open, and billed, until `finish()` or `abort()`. |

## Errors

| Signal | Kind | Retry |
|---|---|---|
| Token HTTP 401/403, or 404 `{"detail":"Invalid API key"}` (seen live) | auth | no |
| Token HTTP 402, or "balance", "disabled" or "billing" in the reason | quota | no |
| Token HTTP 429 (`Retry-After` honoured) · close 3009 | rate-limit | yes |
| Token HTTP 400/422 · close 3007 · 3006 bad message | input | no |
| Socket 1008 after a successful mint (seen live: "Unauthorized Connection: Invalid API key") | auth | yes: the session mints again, and a bad key then fails the mint |
| 3006 inactivity · 3008 maximum duration | timeout | yes |
| 1011 · 3005 · token 5xx | provider | yes |
| 1006 or another unexpected close | network | yes |

## Evidence

| Claim | Status |
|---|---|
| Token request shape; HTTP 404 and 422 bodies for an invalid key or a missing parameter | LIVE, with an invalid key only (2026-10-13) |
| Socket `?token=` auth path; Error frame then close 1008 for a bad token, and how the adapter classifies it | LIVE, with an invalid token only (2026-10-13) |
| A valid key mints a token with no server; the socket returns words with session-clock timing | LIVE (2026-10-13, Node `WebSocket`, free-plan key): the smoke below minted a token with no server, the socket reported `universal-streaming-english`, and 12 s of AssemblyAI's public `wildfires.mp3` sample gave 2 final segments (30 words, first word 800 ms, last word end 12 240 ms) and 13 s of billed session time. `VERDICT=PASS` |
| Socket opened from a `chrome-extension://` origin, and the service worker's CORS exemption | **UNTESTED**. Proved by the first in-extension recording (#16542 wiring). |
| Interim/final revisions, timing units, token expiry, errors, pacing, finish and abort | FIXTURE (`test/assemblyai/`) |

## Smoke test

```sh
cd packages/transcription
ffmpeg -i narration.m4a -ac 1 -ar 16000 -c:a pcm_s16le /tmp/speech.wav   # non-sensitive scripted speech
node scripts/assemblyai-smoke.ts --audio /tmp/speech.wav                  # dry run, sends nothing
ASSEMBLYAI_API_KEY=… node scripts/assemblyai-smoke.ts --audio /tmp/speech.wav --live
```

The smoke runs the product code: `mintAssemblyAiToken` with `fetch`, then
`AssemblyAiLiveAdapter` over a browser-style WebSocket with no custom headers. It
prints the final segments on the session clock, the reported model, usage and
`VERDICT=PASS|FAIL|UNTESTED|DRY-RUN`. It never prints the key or the token. A few
seconds of audio costs well under one US cent.

## Tests

```sh
cd packages/transcription
node --test test/assemblyai/token.test.ts
node --test test/assemblyai/normalizer.test.ts
node --test test/assemblyai/adapter.test.ts
```
