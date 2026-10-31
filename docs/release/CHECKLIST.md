# NarWal release checklist

How to release NarWal to the Chrome Web Store and Microsoft Edge Add-ons
(board #16955). The publisher is **ProSoft IP** (Matt, console 2026-10-17
13:40Z: "ProSoft IP for both").

The kit in this folder:

| File | What it is |
| --- | --- |
| [chrome-web-store.md](chrome-web-store.md) | Chrome listing text, single purpose, permission justifications, remote code, data use, reviewer instructions |
| [edge-add-ons.md](edge-add-ons.md) | What Edge Partner Center asks differently, and its certification notes |
| [privacy-policy.html](privacy-policy.html) | The privacy policy page, one self-contained file |
| [images/](images/) | Five 1280x800 screenshots, the 128 px store icon, Edge's 300 px logo, the 440x280 and 1400x560 promo tiles |
| [submit-wizard.sh](submit-wizard.sh) | Walks a person through sections 1, 5 and 6 in the terminal: what to click, what to paste (it copies the text), and it waits after each step |

Store submission is a human step: this kit does not submit anything.

To do sections 1, 5 and 6 step by step, run `docs/release/submit-wizard.sh`
from the repository root. It opens each page, copies the text to paste, and
waits for you. It does not register, pay or submit anything.

## 0. Open source (once, board #27493)

The repository is prepared for the public: MIT licence (`LICENSE.md`),
outsider README, `CONTRIBUTING.md`, `SECURITY.md`, a clean full-history
secret scan (`.gitleaks.toml` lists the two measured false positives), and
no customer data, internal hosts or internal paths in the tree. The listing
links to the public source, so make the repository public **before** the
store submission.

- [ ] **Publish without the old history.** The tree is clean, but earlier
      commits still hold customer data that was removed from it. Do not
      flip the private repository public. Move every tool and checkout
      first: once a new public repository holds the name
      `ProSoftIP/NarWal`, a routine push from an old clone would upload the
      old history to it. So stop the release pipeline, block pushes from
      every old clone, rename the private repository to
      `ProSoftIP/NarWal-private` as the archive, create the public
      `ProSoftIP/NarWal`, push the current `main` as a single fresh commit,
      then re-clone every checkout from it and delete the old ones.
      Development continues in the public repository.
- [ ] **Bring the release over.** A fresh history has no tags or GitHub
      releases, so `releases/latest` (README, install guide) is a 404 and
      `version.mjs bump --since v<version>` has no tag. The first run of
      the release pipeline on the fresh commit publishes `v<version>`
      (`npm run github-release` in `packages/extension`).
- [ ] **GitHub settings on the public repository:** Security → enable
      private vulnerability reporting (SECURITY.md points to it); enable
      secret scanning and push protection; About → website
      `https://prosoftip.com/narwal/privacy`, topics.

## 1. Before the first submission (once)

- [ ] **Chrome Web Store developer account.** Register at
      <https://chrome.google.com/webstore/devconsole> with **the ProSoft IP
      Google account** (the one that owns prosoftip.com), not a personal
      account: the account that publishes an item owns it, and moving an
      item to another account later is a support request. One-time
      registration fee: **US$5**. The account needs 2-Step Verification.
      Fill in the publisher name (ProSoft IP), a contact email that someone
      reads (info@prosoftip.com) and verify it.
- [ ] **Trader status (EU Digital Services Act).** The dashboard asks
      whether the publisher is a trader. ProSoft IP publishes as a business,
      so answer "trader" and give the business address, email and phone it
      asks for; the store shows them on the listing in the EU.
- [ ] **Microsoft Partner Center, Microsoft Edge program.** Register at
      <https://partner.microsoft.com/dashboard/microsoftedge/> with the
      ProSoft IP Microsoft account, as a company account. No fee. Company
      accounts are verified by Microsoft, which can take a few business
      days.
- [x] **Publish the privacy policy** at
      <https://prosoftip.com/narwal/privacy>. Done 17 October 2026 (board
      #16969): the text of [privacy-policy.html](privacy-policy.html) in the
      prosoftip.com page design, plus the data-use table from
      [chrome-web-store.md](chrome-web-store.md). Both stores check that the
      URL opens. If this policy changes, change the prosoftip.com
      page in the same release.
- [x] **Fix the GitHub link (#16960).** Done 18 October 2026 (NarWal PR
      #57, in 1.0.0): the popup and Saved recordings link to
      <https://prosoftip.com/> ("ProSoft IP"), not the private
      `github.com/ProSoftIP/NarWal`, where a store user got a 404.
- [x] **Model licences.** Checked 19 October 2026 (board #17242) at the
      revisions pinned in `packages/offline-transcription/src/models.ts`.
      Every speech model allows NarWal's use. NarWal downloads the models at
      the user's request; it does not ship them.
      `dist/runtime/THIRD-PARTY-NOTICES.txt` lists them.
      - **Whisper base.en, small.en, large-v3-turbo**
        (`onnx-community/*_timestamped`): the repositories have no licence
        tag and no licence file. Each model card names its base model
        (`openai/whisper-base.en`, `openai/whisper-small.en`,
        `openai/whisper-large-v3-turbo`) and says it is that model "with
        ONNX weights to be compatible with Transformers.js": the same weights
        in another file format, with no terms of its own. OpenAI releases
        Whisper's code and weights under MIT (github.com/openai/whisper,
        README "License"). On Hugging Face, `openai/whisper-base.en` and
        `openai/whisper-small.en` are tagged Apache-2.0 and
        `openai/whisper-large-v3-turbo` MIT. Both licences allow use and
        redistribution with the notice.
      - **Moonshine base** (`onnx-community/moonshine-base-ONNX`): MIT,
        and the conversion is tagged MIT.
      - **Parakeet TDT 0.6B v2**
        (`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`): NVIDIA's
        model is CC-BY-4.0 and the k2-fsa export is tagged CC-BY-4.0. It
        needs attribution, which the notices give (NVIDIA, the licence, the
        change made).
      - **Vosk small English 0.15**: Apache-2.0
        (<https://alphacephei.com/vosk/models>).

      The notices name MIT for Whisper base.en and small.en; Hugging Face
      shows Apache-2.0 for the same two models. That is not a blocker. Name
      both the next time the notices change.

## 2. Build the package

From a clean checkout of `main`:

```sh
cd packages/offline-transcription && npm ci && cd ../extension
npm ci
npm run release
```

It needs Node 22.18 or later and gitleaks on the `PATH`.

`npm run release`:

1. builds the extension with no test hooks and writes the load-unpacked zip,
   `release/narwal-<version>.zip` (a `narwal/` folder, with the pinned
   manifest `key`);
2. writes the store zip, `release/narwal-<version>-store.zip`: manifest at
   the root, **no manifest `key`**, only the extension's own files (no
   sources, tests, fixtures, research, validation output or source maps);
   it refuses a build with test hooks, a version that differs between
   `package.json` and `manifest.json`, or a version with no `CHANGELOG.md`
   section;
3. scans the zip's contents for secrets with gitleaks
   (`release-gitleaks.toml` lists the measured false positives, each an
   exact string) and fails if gitleaks is missing or finds one;
4. prints the file count, size and SHA-256, and writes
   `release/narwal-<version>-store.zip.sha256`.

- [ ] Post the SHA-256 on the release ticket. Upload exactly that file.
- [ ] Load the store zip once by hand: unzip it to a folder, load that
      folder unpacked in a clean browser profile, record 30 seconds, stop,
      replay. (Without the `key` the folder gets a new extension ID; that is
      expected.)

## 3. Visibility: Unlisted first, then Public

- **Unlisted** (Chrome) / **Hidden** (Edge): only people with the link can
  install it; it is not in search. It goes through the same review. Use it
  for the first release, so a small group installs from the store before
  anyone else.
- **Public**: in search and category pages. Switch to Public after the
  Unlisted build has been used for real work. Changing visibility needs no
  new upload.
- **Private** (Chrome, Google Workspace domain only) is not used: ProSoft
  IP's users are outside one domain.

## 4. Review times

- **Chrome:** NarWal asks for `<all_urls>` and `scripting`, which the Chrome
  Web Store treats as broad host access: the item gets an in-depth manual
  review. Expect **a few days up to about two weeks** for the first
  submission. An update that adds a permission is reviewed again in full and
  can take as long; an update with the same permissions is usually faster.
  An update that adds a permission also disables the extension for current
  users until each one accepts the new permission.
- **Edge:** certification takes **up to 7 business days**; it is often
  faster.
- Do not resubmit while an item is in review: a new upload resets the
  queue position.
- If a store rejects the item, the email names the policy. Answer from
  [chrome-web-store.md](chrome-web-store.md): the permission justifications
  and the data-use table are written for that.

## 5. Submit (human step)

Chrome Web Store, in the developer dashboard:

- [ ] New item → upload `narwal-<version>-store.zip`.
- [ ] Store listing tab: text and images from
      [chrome-web-store.md](chrome-web-store.md).
- [ ] Privacy practices tab: single purpose, one justification per
      permission and for the host permission, remote code "No", data usage
      and the three certifications, privacy policy URL.
- [ ] Distribution tab: Unlisted, all regions, free.
- [ ] Test instructions: from [chrome-web-store.md](chrome-web-store.md).
- [ ] Submit for review. Keep "Publish automatically after review" off for
      the first release, so the publish time is chosen.

Edge Add-ons, in Partner Center:

- [ ] Create new extension → upload the **same** store zip.
- [ ] Availability: Hidden, all markets.
- [ ] Properties and Store listing: from [edge-add-ons.md](edge-add-ons.md).
- [ ] Notes for certification: from [edge-add-ons.md](edge-add-ons.md).
- [ ] Publish.

## 6. Existing users of the unpacked build

The unpacked build has a pinned ID (`gpfcnaalnaknfbeonbgaafhomonmmcdj`,
from the manifest `key`). Each store gives its item a **different** ID, and
recordings are stored under the extension's ID. So:

- [ ] Before installing from a store, each unpacked user exports the
      recordings they want to keep (Export bundle), then removes the
      unpacked build.
- [ ] After the store install, open the bundles with "Open a shared recording".

Do not run the unpacked build and a store build side by side: both work,
but they are two extensions with two separate recording libraries and the
same keyboard shortcuts.

## 7. Updates

For every update:

- [ ] Raise the version in `packages/extension/package.json` and
      `app/manifest.json` (both; the release refuses a mismatch). A store
      refuses a version that is not higher than the published one.
- [ ] Add a `## <version>` section to `packages/extension/CHANGELOG.md`.
- [ ] If the update changes what NarWal stores or sends, or adds a host or
      permission: update [privacy-policy.html](privacy-policy.html) (and
      republish it **before** the update is published),
      [chrome-web-store.md](chrome-web-store.md) and
      [edge-add-ons.md](edge-add-ons.md) in the same pull request.
- [ ] `npm run release`, post the SHA-256, upload the same zip to both
      stores.
- [ ] If the pages changed visibly, remake the images:
      `packages/extension/branding/store-images.mjs` (its header has the
      commands).

**Cadence:** release when a change is worth a review, not on every merge to
`main`: at most about once a week, and batch small fixes. Each upload is a
new review (section 4), and both stores update installed copies on their
own within a few hours to a day of publishing. A fix for a broken
recording is the exception: release it at once.

## 8. Not in this release (follow-ups)

- **Licence key / paid gate: #16959 (closed).** Matt decided on
  2026-10-18: no paid version. On 2026-10-31 (board #27493) NarWal became
  open source under MIT, so it stays free; no key
  check, licence server or payment will be built. The options are kept in
  `docs/licensing-design.md` as a record.
