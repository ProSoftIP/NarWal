# @narwal/bundle

Board #16541. Validator, fixtures and agent exports for the NarWal recording
bundle, schema 1.1. The specification is
[`docs/bundle-schema.md`](../../docs/bundle-schema.md); where this code and
that file disagree, the file wins and this code is the bug.

Erasable TypeScript only: Node 22.18+ runs it with no build step. The
validator uses no Node APIs (Web Crypto and `TextDecoder` only), so the
extension can import it as is.

## Use

| Command | What |
| --- | --- |
| `node bin/narwal-bundle.ts validate <dir> [--json]` | Exit 0 valid, 1 invalid, 2 usage |
| `node bin/narwal-bundle.ts export <dir> [--json]` | Agent Markdown (or JSON) of a valid bundle |
| `npm run fixtures` | Rebuild `fixtures/` from `scripts/build-fixtures.ts` |
| `npm run fixtures:check` | Fail if `fixtures/` differs from the builder |
| `node --test "test/*.test.ts"` | Tests (`npm test`) |

```ts
import { validateBundle, memorySource, buildAgentView, renderMarkdown } from '@narwal/bundle';

const result = await validateBundle(memorySource(files)); // files: Map<path, Uint8Array>
if (result.bundle) console.log(renderMarkdown(buildAgentView(result.bundle)));
```

`validateBundle` never throws on bad input. It returns `errors` and
`warnings` (`{code, message, file?, line?}`); `bundle` is present only when
there are no errors, so an importer stores nothing unless `ok`.

## Layout

| Path | What |
| --- | --- |
| `src/types.ts` | Record types for every bundle file |
| `src/limits.ts` | Bounded import limits (§11) and the supported version |
| `src/validate.ts` | `validateBundle(source)` |
| `src/agent-view.ts` | The association rule and both agent exports (§9) |
| `src/memory-source.ts`, `src/node-dir.ts` | Bundle sources: bytes in memory, or a directory (Node) |
| `bin/narwal-bundle.ts` | CLI |
| `scripts/build-fixtures.ts` | Writes every fixture; good ones must validate first |
| `fixtures/good/*`, `fixtures/bad/*` | Small bundles; `fixtures/expected.json` gives each one's exact codes and why |

`fixtures/good/dashboard-walkthrough/agent/walkthrough.md` is the example an
agent reads: narration, browser observations, user markers, notes and gaps on
one timeline, with no playback or vision.
