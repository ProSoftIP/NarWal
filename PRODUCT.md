# Product

<!-- impeccable:product-schema 1 -->

Written for board #16767 from the repository and the maintainers' brief. Facts
marked *(inferred)* come from the brief and the code, not from an answer.

## Platform

web

## Stack

Existing codebase: a Chrome/Edge extension (Manifest V3) built with esbuild.
Extension pages are plain HTML, one shared `ui.css`, vanilla JS. No framework.
Fonts: the system stack or one bundled open font (brief constraint). Pages run
under a strict CSP: no network, no inline scripts, inline styles allowed.

## Users

The maintainers, daily *(from the brief)*: they record narrated walkthroughs of
a web app, then open the Saved recordings page to find a recording, set its
purpose, check what it captured, read the transcript, replay it, and export the
bundle for an AI agent or a colleague. Secondary: anyone who installs NarWal
to report a bug, hand over a process or review a page with a client (README).

## Product Purpose

NarWal records one browser tab (page capture, microphone, clicks, scrolls,
marks) into a durable local recording and exports a text-first bundle an AI
agent can read without video. The Saved recordings page is the library and
the detail view of one recording. Success: the user finds the right recording
in seconds, trusts what it holds, and gets the bundle out.

## Positioning

The output is text with times, not a video. Marks are explicit (right-click).
Everything stays on the computer unless the user chooses OpenAI for the
transcript. A neighbouring product (Loom, a screen recorder) cannot claim
agent-readable output or local-only evidence.

## Operating Context

- The page is an extension page opened from the popup or the recorder strip.
- Typical library: tens of recordings, nine today, most under three minutes,
  titles are page titles (sometimes long), one page per recording is common.
- One recording is selected at a time. Its detail shows: status line, purpose
  (editable, 1000 chars), gaps (often none), pages (URL, frame, events,
  attached), microphone parts with an audio player, transcript (timed lines,
  a status line such as "improved on this computer"), replay.
- Related surfaces that must share the visual language: the popup (400 px
  wide, teal Start button, checklist cards), the recorder strip (one line at
  the bottom of the recorded page: REC, time, live transcript, Stop), the
  Options page (model picker, `model.html`), and the Replay page (stage plus
  transcript, notes and gaps side panel).

## Capabilities and Constraints

- Keep every piece of information the page shows today: status, length, page
  title, Open, Export bundle, purpose, gaps, pages, audio, transcript, replay.
- Hide what is empty (Matt: "there's no point having a box that says there's
  nothing here").
- Plain HTML/CSS, respects `prefers-color-scheme`, keyboard and screen-reader
  sane.
- The narwhal mark stays (`packages/extension/app/logo/narwal.svg`).
- Status values seen in code: recording, stopped, interrupted, "from a bundle
  file"; a stop reason may follow the status.
- Transcript can be absent, pending, failed, or improved locally; buttons
  "Improve the transcript", "Get the transcript from OpenAI", "Try again".

## Brand Commitments

Name: NarWal (capital N, capital W). Mark: the red folded narwhal (#C90723 / #FC4722)
with a white eye. The popup already uses a teal (#0e7a6e-ish) primary button
and green check icons *(incumbent, not confirmed as binding)*. Voice: plain
English, short sentences, no jargon (README and popup copy).

## Evidence on Hand

- Current page screenshot: board attachment 26043
  (`narwal-saved-recordings-light-current.png`).
- README screenshots in `docs/images/` (popup, strip, page while recording).
- Shape of the data for mocks: nine recordings over three days, the selected
  one 0:36 long, 1 page, 4 navigations, 73 chunks, one microphone part
  (36 s, 35 chunks), four transcript lines.

## Product Principles

1. The recording is evidence; the interface should make trust visible
   (what was captured, what is missing, when).
2. Text first: the transcript and timeline are the product, the replay is
   support.
3. Daily tool for two people: density and speed over ceremony.
4. Nothing leaves the computer; the interface should never imply a cloud.
5. Show only what exists.

## Accessibility & Inclusion

Keyboard operable throughout, visible focus, semantic landmarks and tables,
contrast at WCAG AA in both schemes *(brief: "keyboard and screen-reader sane")*.
