# Microsoft Edge Add-ons listing

The text for Partner Center (Microsoft Edge program) for NarWal
(boards #16955 and #27493). Publisher: ProSoft IP. It is the same product and the same
package as the Chrome listing, [chrome-web-store.md](chrome-web-store.md);
this file gives only what Edge asks for differently.

Upload the same `packages/extension/release/narwal-<version>-store.zip`.

## Availability

- **Visibility:** Hidden for the first release (Edge's word for unlisted:
  only people with the link can find it), then Public.
- **Markets:** All markets.

## Properties

- **Category:** Productivity.
- **Privacy policy:** Yes, NarWal accesses personal information (the
  microphone, and the narration audio it sends to OpenAI when the user
  chooses OpenAI). URL: https://prosoftip.com/narwal/privacy (published
  17 October 2026 from [privacy-policy.html](privacy-policy.html)).
- **Website:** https://prosoftip.com/
- **Support contact:** https://prosoftip.com/contact.php or
  info@prosoftip.com
- **Mature content:** No.

## Store listing (English)

**Display name** (from the manifest): NarWal

**Short description** (the manifest `description`, 100 characters; paste it
if the form asks for one):

> Record a narrated walkthrough of one tab: page evidence and your microphone, saved on this computer.

**Description** (Edge needs 250 characters or more): use the detailed
description in [chrome-web-store.md](chrome-web-store.md) unchanged, with
one change to the first paragraph:

```text
NarWal records a narrated walkthrough of one Microsoft Edge tab. You talk
while you click through a website; NarWal saves what the page did and what
you said, together, on your computer. Then you or an AI agent can replay it
and see exactly what you meant.
```

**Search terms** (up to 7, 30 characters each, 21 words in all):

```text
screen recorder
narrated walkthrough
bug report
session replay
voice transcript
AI agent
offline transcription
```

**Extension logo:** `images/edge-logo-300.png` (300x300 PNG, transparent
background).

**Screenshots:** the same five 1280x800 images, `images/store-1-replay.jpg`
to `images/store-5-choice.jpg`.

**Small promotional tile:** `images/promo-small-440x280.jpg` (440x280).
**Large promotional tile:** `images/promo-marquee-1400x560.jpg` (1400x560).
Both optional in Edge; they are the same files as the Chrome tiles.
**YouTube video:** none.

## Notes for certification

Paste into "Notes for certification":

```text
No account or sign-in is needed. NarWal records only the tab where the user
presses Start, plus the windows that tab opens. It needs <all_urls> because
the user can record any website. The JavaScript and WebAssembly are all in
the package; speech model files (weights, not code) are downloaded from
huggingface.co and ccoreilly.github.io when the user asks and are checked
against a pinned SHA-256. Nothing is sent to the publisher.

To test:
1. Open any website, for example https://example.com/.
2. Click the NarWal toolbar button, then Start recording. Allow the
   microphone when asked (on the NarWal permission page).
3. Click a link and speak. Right-click a part of the page to mark it.
4. Press Stop on the bar at the bottom of the page.
5. Open "Saved recordings" from the popup to see and replay the recording.
The default transcript runs on the computer and needs a one-time speech
model download first: press "Download speech model" in the popup. The whole
download is about 1 GB; Start recording is enabled as soon as the first
41 MB (the live model, Vosk small) are stored.
```

The permission justifications in
[chrome-web-store.md](chrome-web-store.md#permission-justifications) answer
any certification question about a permission.
