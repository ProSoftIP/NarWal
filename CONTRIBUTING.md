# Contributing to NarWal

Thank you for helping. NarWal is a browser extension that records a narrated
walkthrough of one tab and keeps it on the user's computer. Bug reports,
ideas and pull requests are welcome.

By sending a contribution you agree that it is licensed under the
[MIT licence](LICENSE.md), the same as the rest of NarWal.

## Reporting a bug

Open an issue with:

- the browser and its version (`edge://version` or `chrome://version`) and
  the operating system;
- the NarWal version (the popup's footer, or `edge://extensions`);
- what you did, what you expected and what happened instead.

**Do not attach a recording or a bundle (`.narwal.zip`) of a real page.** A
bundle holds the page, your voice and the transcript. If a bundle is the
only way to show the problem, record a public page such as
<https://example.com/>, check its `agent/walkthrough.md` first, and say that
you checked it.

A security problem is not a bug report: follow [SECURITY.md](SECURITY.md)
instead.

## Setting up

You need Node 22.18 or later and npm. The repository is a set of npm
packages under `packages/`; each installs on its own. The extension bundles
the others, and `packages/offline-transcription` builds the speech engines
it ships:

```sh
cd packages/offline-transcription && npm ci && cd ../extension
npm ci
npm run build      # packages/extension/app is now a loadable extension folder
```

Load `packages/extension/app` with **Load unpacked** in `edge://extensions`
or `chrome://extensions` (Developer mode on). After a change, run
`npm run build` again and press **Reload** on the extension.

The TypeScript packages use erasable syntax only and run with Node directly,
with no build step.

## Testing

Run the tests of each package you changed:

```sh
cd packages/<package> && npm ci && npm test
```

`npm run typecheck` exists in the TypeScript packages. `packages/extension`,
`packages/recorder-ui` and `packages/offline-transcription` also have
`npm run e2e`, which drives a real browser with Playwright's Chromium and a
fake microphone (`npx playwright install chromium` once). On Linux without
Chromium's system libraries, install them with
`npx playwright install-deps chromium`.

Add a test with each change in behaviour. A bug fix comes with the test that
failed before it.

## Sending a pull request

- Keep one change per pull request, and explain why in the description.
- Write the commit subject as `type(scope): what changed`, for example
  `fix(extension): keep the strip above the page's own footer`. Types:
  `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Do not change the version in `package.json` or `app/manifest.json`; the
  maintainers bump it when they release (see
  [`packages/extension/README.md`](packages/extension/README.md), "Version
  and releases").
- Match the code around you: its naming, comment density and style.
- Do not commit build output (`app/dist/`, `release/`), downloaded models,
  recordings, bundles or screenshots of real pages.

## Privacy rules every change keeps

NarWal's promise is in the store listing and the
[privacy policy](docs/release/privacy-policy.html). A change must not break
it:

- **Nothing goes to us.** No analytics, telemetry, crash reporting, remote
  configuration or update checks.
- **No new network host** without a reason a user benefits from. Today
  NarWal talks only to the speech model hosts pinned in
  `packages/offline-transcription/src/models.ts` and, when the user chooses
  it, `api.openai.com`; the speech engine workers refuse every request
  outside the extension (`packages/offline-transcription/src/network-guard.ts`).
  A pull request that
  adds a host, a permission or a new kind of stored or sent data updates the
  privacy policy, [`docs/release/chrome-web-store.md`](docs/release/chrome-web-store.md)
  and [`docs/release/edge-add-ons.md`](docs/release/edge-add-ons.md) in the
  same pull request.
- **No remote code.** Every script and WebAssembly file ships in the
  package. Downloaded speech models are data, pinned to a URL and a SHA-256.
- **Typed text stays masked**, and values in web addresses stay removed. A
  change to capture keeps the tests in `packages/interactions` passing.
- **Only the tab the user started**, and the windows it opens, are recorded.
- **No real data in the repository.** Fixtures and screenshots use the local
  test sites under `test/e2e/site/` or invented content.

## Code of conduct

Be kind and assume good intent. Criticise code, not people. The maintainers
may remove comments, issues or pull requests that are abusive, and block
people who post them.
