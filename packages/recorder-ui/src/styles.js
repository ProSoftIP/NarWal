// CSS for the two surfaces, as strings: both are adopted as constructed
// style sheets (dom.js adoptCss), so no <style> element or extra file is
// needed in a recorded page or an extension page.

// The strip sits over pages we do not control. Every :host declaration is
// !important: inside a shadow tree that beats any page rule.
export const STRIP_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  z-index: 2147483647 !important;
  display: block !important;
  pointer-events: none !important;
}
@media print { :host { display: none !important; } }
[hidden] { display: none !important; }
.wrap {
  display: flex;
  flex-direction: column;
  font: 13px/1.2 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #f5f5f4;
  --line: rgba(255, 255, 255, 0.16);
  --muted: #b8b5b0;
  --accent: #ff6b5a;
}
.wrap[data-tone='warn'] { --accent: #fbbf24; }
.wrap[data-tone='busy'] { --accent: #a8a29e; }
.wrap[data-tone='done'] { --accent: #4ade80; }
.wrap[data-tone='error'] { --accent: #f87171; }
.bar {
  pointer-events: auto;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  background: #1b1e24;
  border-top: 1px solid var(--line);
  white-space: nowrap;
}
.state { display: inline-flex; align-items: center; gap: 7px; flex: none; }
.nw-logo { display: block; flex: none; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.wrap[data-tone='recording'] .dot { animation: pulse 1.6s ease-in-out infinite; }
.wrap[data-tone='error'] .dot { border-radius: 2px; }
@keyframes pulse { 50% { opacity: 0.35; } }
.badge { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); }
.time { font-variant-numeric: tabular-nums; font-weight: 600; }
.meter { position: relative; width: 44px; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255, 255, 255, 0.16); }
.meter-fill { position: absolute; inset: 0; background: #a8a29e; transform: scaleX(0); transform-origin: left center; transition: transform 0.15s linear; }
.meter[data-heard='true'] .meter-fill { background: #4ade80; }
.note {
  flex: none;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid #fbbf24;
  color: #fde68a;
}
.message { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--muted); }
.message.status { text-overflow: ellipsis; }
.message.transcript { color: #f5f5f4; }
.wrap[data-tone='warn'] .message.status { color: #fde68a; }
.wrap[data-tone='error'] .message.status { color: #fecaca; }
.wrap[data-tone='done'] .message.status { color: #f5f5f4; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.btn {
  flex: none;
  box-sizing: border-box;
  height: 24px;
  min-width: 24px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5f4;
  font: inherit;
  cursor: pointer;
}
.btn:hover { background: rgba(255, 255, 255, 0.16); }
.btn:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
.btn:disabled { opacity: 0.7; cursor: default; }
.btn.toggle.on { background: rgba(255, 255, 255, 0.22); }
.btn.stop { background: #c81e1e; border-color: #c81e1e; color: #ffffff; font-weight: 700; }
.btn.stop:hover:not(:disabled) { background: #a61b1b; }
.btn.export { background: #f5f5f4; border-color: #f5f5f4; color: #1b1e24; font-weight: 700; }
.btn.export:hover:not(:disabled) { background: #d6d3d1; }
.panel {
  pointer-events: auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  max-height: min(40vh, 320px);
  background: #1b1e24;
  border-top: 1px solid var(--line);
}
.panel-head { display: flex; align-items: baseline; gap: 10px; padding: 8px 12px 4px; }
.panel-title { font-weight: 700; }
.panel-hint { color: var(--muted); font-size: 12px; }
.log { overflow: auto; padding: 2px 12px 10px; line-height: 1.5; overscroll-behavior: contain; }
.log:focus-visible { outline: 2px solid #ffffff; outline-offset: -2px; }
.line { margin: 0; display: flex; gap: 10px; white-space: normal; }
.line-time { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.line.interim .line-text { color: var(--muted); font-style: italic; }
.line.gap .line-text { color: #fde68a; }
.line.empty { color: var(--muted); }
.narrow { display: none; }
@media (max-width: 560px) {
  .badge, .panel-hint, .wide { display: none; }
  .narrow { display: inline; }
  .bar { gap: 8px; padding: 0 8px; }
}
@media (prefers-reduced-motion: reduce) { .wrap .dot { animation: none !important; } .meter-fill { transition: none; } }
@media (forced-colors: active) {
  .bar, .panel { border-top: 1px solid CanvasText; background: Canvas; }
  .btn { border: 1px solid ButtonText; }
  .meter { border: 1px solid CanvasText; }
  .meter-fill { background: Highlight !important; }
}
`;

// The popup is in the Tiles B language of the extension pages (board #16783,
// packages/extension/app/tiles.css): tiles on a grey ground, coral Start.
export const START_CSS = `
.nw-start {
  --ink: #111318;
  --muted: #4a505b;
  --quiet: #5c6370;
  --line: #dde0e5;
  --line-2: #c3c8d0;
  --ground: #eceef1;
  --surface: #ffffff;
  --soft: #e9ecf0;
  --accent: #d4412f;
  --on-accent: #ffffff;
  --rating: #2f6f8f;
  --ok: #2e7d32;
  --todo: #a15c07;
  --blocked: #b42318;
  --busy: #1d4ed8;
  box-sizing: border-box;
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
  padding: 14px;
  color: var(--ink);
  background: var(--ground);
  font: 13.5px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .nw-start {
    --ink: #e8eaee;
    --muted: #a9b0bb;
    --quiet: #939aa7;
    --line: #252930;
    --line-2: #353a43;
    --ground: #0c0e11;
    --surface: #15181c;
    --soft: #20242a;
    --accent: #ff7a68;
    --on-accent: #1a0f0c;
    --rating: #7cc4e4;
    --ok: #7fc987;
    --todo: #f2b45a;
    --blocked: #ff8a7a;
    --busy: #93c5fd;
  }
}
.nw-start *, .nw-start *::before, .nw-start *::after { box-sizing: border-box; }
.nw-start [hidden] { display: none !important; }
.nw-start h1, .nw-start h2, .nw-start p, .nw-start ul, .nw-start ol, .nw-start fieldset { margin: 0; padding: 0; }
.nw-start ul, .nw-start ol { list-style: none; }
.nw-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.nw-head .nw-logo { display: block; flex: none; }
.nw-brand { display: flex; flex-direction: column; min-width: 0; }
/* Saved recordings: a secondary button at the top (board #17006). */
.nw-head-link { flex: none; margin-left: auto; display: inline-flex; align-items: center; text-decoration: none; }
.nw-brand h1 { line-height: 1.2; }
.nw-start h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.nw-tagline { color: var(--muted); font-size: 12.5px; }
.nw-start h2 { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); margin: 0 0 8px; }
.nw-start h2:focus { outline: none; }
.nw-start h2.nw-legend { padding: 10px 12px 0; margin-bottom: 2px; }
.nw-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nw-section { margin-bottom: 8px; }
.nw-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.nw-banner-text { flex: 1 1 100%; }
/* Each check is a small tile; short ones share a row, one with more to say takes the row. */
.nw-checks { display: flex; flex-wrap: wrap; gap: 8px; }
.nw-check { flex: 1 1 150px; display: grid; grid-template-columns: 16px 1fr; column-gap: 8px; align-content: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.nw-check:has(.nw-check-detail, .nw-check-action, .nw-progress) { flex-basis: 100%; }
.nw-check .nw-icon { margin-top: 2px; }
.nw-check-title { font-weight: 600; }
.nw-check-detail { grid-column: 2; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.nw-check-action { grid-column: 2; margin-top: 6px; justify-self: start; }
.nw-progress { grid-column: 2; width: 100%; height: 6px; margin-top: 8px; accent-color: var(--accent); }
.nw-icon-disc { fill: none; stroke: currentColor; stroke-width: 1.5; }
.nw-icon-mark { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.nw-icon-ok { color: var(--ok); }
.nw-icon-todo { color: var(--todo); }
.nw-icon-blocked { color: var(--blocked); }
.nw-icon-note { color: var(--muted); }
.nw-icon-busy { color: var(--busy); animation: nw-spin 1s linear infinite; }
.nw-icon-busy .nw-icon-disc { stroke: none; }
@keyframes nw-spin { to { transform: rotate(360deg); } }
.nw-choices { border: 1px solid var(--line); border-radius: 8px; min-width: 0; background: var(--surface); }
.nw-choices legend { float: left; width: 100%; }
.nw-choice { clear: both; }
.nw-choice + .nw-choice { border-top: 1px solid var(--line); }
.nw-choice-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; }
.nw-choice-head input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent); }
.nw-choice-label { font-weight: 600; flex: 1; }
.nw-tag { font-size: 12px; color: var(--muted); }
.nw-choice-body { padding: 0 12px 12px 38px; color: var(--muted); font-size: 12.5px; }
.nw-choice-body p + p { margin-top: 4px; }
.nw-model-pick { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 4px 10px; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--ground); }
.nw-model-name { grid-column: 1 / -1; color: var(--ink); font-weight: 600; }
.nw-model-pick .nw-btn { grid-column: 1 / -1; justify-self: start; }
.nw-rating { display: inline-flex; gap: 2px; vertical-align: middle; }
.nw-rating > span { width: 10px; height: 6px; border-radius: 2px; }
.nw-rating-on { background: var(--rating); }
.nw-rating-off { background: var(--line); }
.nw-key { margin-top: 8px; }
.nw-key label { display: block; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
.nw-key-row { display: flex; gap: 6px; }
.nw-key input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
}
.nw-purpose { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.nw-purpose label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); margin-bottom: 6px; }
.nw-purpose textarea {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  resize: vertical;
}
.nw-purpose-hint { margin-top: 4px !important; color: var(--muted); font-size: 12.5px; }
.nw-purpose-count { margin-top: 2px !important; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.nw-key-saved { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--ink); }
.nw-key-saved span { flex: 1; }
.nw-hide { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.nw-hide-text { color: var(--muted); font-size: 13px; }
.nw-notes { color: var(--muted); font-size: 12px; padding: 4px 4px 0 18px !important; list-style: disc !important; }
.nw-notes li + li { margin-top: 3px; }
.nw-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.nw-btn:hover { border-color: var(--muted); }
.nw-btn.nw-primary { height: 40px; padding: 0 16px; border-radius: 8px; border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-size: 14.5px; }
.nw-btn.nw-danger { border-color: #c81e1e; background: #c81e1e; color: #ffffff; }
.nw-btn.nw-quiet { border-color: transparent; background: none; color: var(--accent); padding: 0 4px; }
.nw-btn[aria-disabled='true'] { opacity: 0.55; cursor: not-allowed; }
.nw-start :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.nw-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nw-go { margin-bottom: 10px; }
.nw-go .nw-primary { width: 100%; }
.nw-go .nw-why:empty { min-height: 0; margin-top: 0 !important; }
.nw-why { margin-top: 6px !important; color: var(--muted); font-size: 13px; min-height: 1.45em; }
.nw-error { margin-top: 8px !important; color: var(--blocked); font-size: 13px; }
.nw-steps { counter-reset: nw-step; }
.nw-step { counter-increment: nw-step; display: grid; grid-template-columns: 22px 1fr; column-gap: 10px; padding: 7px 0; }
.nw-step::before {
  content: counter(nw-step);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--soft);
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.nw-step-title { font-weight: 600; }
.nw-step-body { grid-column: 2; color: var(--muted); font-size: 13px; }
.nw-skip { display: flex; align-items: center; gap: 8px; margin: 10px 0 14px; cursor: pointer; }
.nw-skip input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent); }
.nw-active { padding: 14px; border-radius: 8px; background: #1b1e24; color: #ffffff; }
.nw-active-time { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
.nw-active h2 { color: #b4bac5; }
.nw-active p { color: #b4bac5; margin: 4px 0 14px; }
@media (prefers-reduced-motion: reduce) { .nw-icon-busy { animation: none; } }
`;
