# @narwal/replay

Board #16549. Synchronized replay of a NarWal bundle: page, narration,
transcript, markers and gaps on one clock. Design, tolerances and isolation:
[`docs/replay.md`](../../docs/replay.md). The extension page is
`packages/extension/app/replay.html`.

Erasable TypeScript, no build step. Only `player.ts` uses the DOM; rrweb is
passed in, so this package has no runtime dependency.

## Use

```ts
import { loadReplay, ReplayPlayer } from '@narwal/replay';

const { model, audio, warnings } = await loadReplay(files); // files: Map<path, Uint8Array>; throws ReplayLoadError when invalid
const player = new ReplayPlayer({ model, stage, audio: audioElement, createReplayer: (events, root) => new Replayer(events, { root }) });
player.seek(12_000);
player.play();
```

| Command | What |
| --- | --- |
| `npm test` | Unit tests (`node --test "test/*.test.ts"`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run e2e:replay` in `packages/extension` | Chromium: seeks, playback sync, hostile bundle |

## Layout

| Path | What |
| --- | --- |
| `src/model.ts` | `buildReplayModel`, `stateAt`: pure timeline, every seek decision testable in Node |
| `src/audio-clock.ts` | Session time to narration media time, from `clock.jsonl` |
| `src/player.ts` | `ReplayPlayer`: drives rrweb and the audio element from one clock |
| `src/load.ts` | `loadReplay`: validate, parse and build the model |
| `src/sandbox.ts` | `REPLAY_CSP`, `REPLAY_SANDBOX`, `assertSandboxed` |
| `src/resources.ts` | Counts the files a recorded page used that replay does not load |
| `src/labels.ts` | Plain-language gap text and the clock label |
| `test/known-timing.ts` | The known-timing bundle; `fixtures/known-timing.webm` is its narration |
