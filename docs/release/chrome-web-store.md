# Chrome Web Store listing

The text to paste into the Chrome Web Store developer dashboard for NarWal
(boards #16955 and #27493). Publisher: ProSoft IP. Every claim here is what
the current build does; change this file in the same pull request as a
change that makes a claim untrue.

Upload `packages/extension/release/narwal-<version>-store.zip` from
`npm run release` (see [CHECKLIST.md](CHECKLIST.md)).

## Store listing tab

**Name** (from the manifest): NarWal

**Short description** (the manifest `description`, 100 characters; the
store allows 132):

> Record a narrated walkthrough of one tab: page evidence and your microphone, saved on this computer.

**Category:** Productivity → Workflow & Planning. (Second choice: Developer
Tools.)

**Language:** English.

**Detailed description:**

```text
NarWal records a narrated walkthrough of one browser tab. You talk while you
click through a website; NarWal saves what the page did and what you said,
together, on your computer. Then you or an AI agent can replay it and see
exactly what you meant.

Use it to report a bug, review a change, ask for an edit on a page, or show
a colleague how something works, without writing it all down.

WHAT IT RECORDS
• The page: its structure, your clicks, scrolling, route changes, and the
  windows the tab opens. What you type into fields is masked, never saved.
• Your microphone, from the moment you press Start.
• Marks: right-click a part of the page while you talk, and the mark is
  saved with that moment.
• A transcript of what you said.

WHERE YOUR VOICE IS TURNED INTO TEXT
• On this computer (the default). Pick a speech model, such as Parakeet TDT
  0.6b, and download it once. After that, the transcript works with no
  internet and the audio does not leave your computer.
• OpenAI Whisper, if you choose it and give your own OpenAI API key. Only
  the narration audio is sent, after you press Stop.

WHAT YOU GET
• Saved recordings: every recording, searchable, kept in your browser.
• Replay: the page plays back in step with your voice and the transcript.
  Replay never contacts the recorded site.
• Edit the transcript, and say what the recording is for.
• Export one bundle file (.narwal.zip) to share or to give to an AI agent.
  The bundle explains itself to the agent that opens it.

PRIVATE BY DESIGN
• NarWal sends nothing to us. It has no account, no analytics and no
  tracking.
• Recordings stay in your browser on this computer. Export one to share
  it.
• It records only the tab you start, and the windows that tab opens. Other
  tabs are never recorded.

Removing the extension deletes the recordings it holds. Export the
recordings you want to keep first.

OPEN SOURCE
NarWal is open source under the MIT licence. Read the code, report a
problem or suggest a change at https://github.com/ProSoftIP/NarWal

NarWal is made by ProSoft IP. Privacy policy:
https://prosoftip.com/narwal/privacy
```

**Graphic assets** (in [images/](images/)):

| Asset | File | Size |
| --- | --- | --- |
| Store icon | `store-icon-128.png` | 128x128 PNG, 96x96 art, 16 px transparent edge |
| Screenshot 1 | `store-1-replay.jpg` | 1280x800 JPEG |
| Screenshot 2 | `store-2-mark.jpg` | 1280x800 JPEG |
| Screenshot 3 | `store-3-saved.jpg` | 1280x800 JPEG |
| Screenshot 4 | `store-4-model.jpg` | 1280x800 JPEG |
| Screenshot 5 | `store-5-choice.jpg` | 1280x800 JPEG |
| Small promo tile | `promo-small-440x280.jpg` | 440x280 JPEG (required) |
| Marquee promo tile | `promo-marquee-1400x560.jpg` | 1400x560 JPEG (optional) |

`packages/extension/branding/store-images.mjs` makes the icon and the
screenshots from the current build, and `branding/promo-tiles.mjs` makes the
two promo tiles; each header says how.

**Official URL:** none (prosoftip.com is not yet a verified site in Search
Console). **Homepage URL:** https://prosoftip.com/. **Support URL:**
https://prosoftip.com/contact.php.

## Privacy practices tab

### Single purpose

```text
NarWal records a narrated walkthrough of one browser tab — the page's
activity and the user's microphone, with a transcript — and saves it on the
user's computer to replay or export as one file.
```

### Permission justifications

**offscreen**

```text
The recorder runs in an offscreen document. It holds the microphone stream,
writes the recording to the browser's storage and makes the live transcript.
It must keep running while the popup is closed, and a Manifest V3 service
worker cannot use the microphone or keep the recording in memory.
```

**scripting**

```text
When the user presses Start, NarWal injects its recorder script into the
recorded tab, and into each page that tab goes to and each window it opens.
The script records the page structure, clicks and scrolling (field values
are masked), and shows the recording bar. It is injected only into the tab the
user chose to record.
```

**tabs**

```text
NarWal needs the recorded tab's ID, URL and title to label the recording,
to know when the tab goes to a new page, and to find the windows and popups
the recorded tab opens (by their opener tab) so it can follow them. It does
not read or record other tabs.
```

**webNavigation**

```text
NarWal follows the recorded tab from page to page and into its frames. The
webNavigation events tell it when a page in that tab has loaded, so the
recorder script is injected again and the recording has no gap.
```

**storage**

```text
chrome.storage.local keeps the user's settings (the chosen transcript
provider, speech model and microphone) and, only if the user enters one,
their own OpenAI API key. chrome.storage.session keeps the state of the
running recording so the service worker can resume it after it restarts.
```

**unlimitedStorage**

```text
Recordings (page events and microphone audio) and downloaded speech models
are kept in IndexedDB on the user's computer. An hour of recording is about
57 MB and a speech model is 41 MB to about 660 MB, which is more than the
default storage quota allows.
```

**alarms**

```text
While a recording runs, an alarm every 30 seconds checks that the recorder
is still running and recovers it if the browser stopped it, so a long
recording is not lost. No alarm runs when NarWal is not recording.
```

**Host permission (`<all_urls>`)**

```text
The user can record a walkthrough of any website they choose, so NarWal
cannot list the sites in advance. The host permission lets it inject the
recorder into the tab the user starts recording on, the pages that tab goes
to and the windows it opens (which can be on other domains, such as a
sign-in popup). NarWal does nothing on a page until the user presses Start
in that tab, and it refuses to record any other tab. It also downloads the
speech models from huggingface.co and ccoreilly.github.io, and, if the user
chooses OpenAI, sends the audio to api.openai.com.
```

### Remote code

**Are you using remote code?** No.

```text
All JavaScript and WebAssembly is in the package. NarWal downloads speech
model files (model weights and tokenizer data, not code) from huggingface.co
and ccoreilly.github.io when the user asks for a model. Each file is pinned
to a fixed URL and checked against its SHA-256 before use.
```

### Data usage

Tick these, because the narration audio and the user's key go to OpenAI when
the user chooses OpenAI for the transcript:

- **Personal communications**: the narration audio.
- **Authentication information**: the user's own OpenAI API key, sent to
  OpenAI only.

Leave the rest unticked. Page content, user activity and web history are
recorded but stay on the computer; the Chrome Web Store's data policy counts
only data that leaves the device. Say so in the justification field if the
form asks.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

**Privacy policy URL:** https://prosoftip.com/narwal/privacy (published
17 October 2026 from [privacy-policy.html](privacy-policy.html)).

### Data use disclosure (for reviewers and the description)

| What | Where it goes | When |
| --- | --- | --- |
| Recordings: page events, marks, microphone audio, transcript | The browser's IndexedDB on the user's computer | Always; deleted when the user removes NarWal |
| Settings, the OpenAI key if entered | `chrome.storage.local` on the user's computer | When the user sets them |
| Speech model files | Downloaded from `huggingface.co` (redirected to its CDN, `*.hf.co`) and `ccoreilly.github.io`; kept in IndexedDB | Only when the user downloads a model |
| Narration audio and the user's OpenAI key | `api.openai.com` (`/v1/audio/transcriptions`) | Only when the user chose OpenAI, after Stop |
| Anything | ProSoft IP | Never |

The extension's network guard refuses every other host. Deepgram and
AssemblyAI are not in the build.

## Distribution tab

- **Visibility:** Unlisted for the first release (see the checklist), then
  Public.
- **Regions:** All regions.
- **Pricing:** Free. NarWal is open source (MIT); there is no paid
  version.

## Test instructions for the reviewer

```text
No account or sign-in is needed.
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
