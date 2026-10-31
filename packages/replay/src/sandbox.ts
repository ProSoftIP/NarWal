// Replay isolation. An imported bundle is untrusted: its page markup is data.
//
// 1. rrweb rebuilds the page in an iframe sandboxed with `allow-same-origin`
//    only (no `allow-scripts`), so no recorded script, handler or
//    `javascript:` URL runs, and the frame cannot navigate the extension page.
//    `UNSAFE_replayCanvas` would add `allow-scripts`; the player never sets it
//    and refuses an iframe with any other sandbox.
// 2. The replay page's content security policy forbids every network load.
//    The about:blank replay frame inherits it, so recorded images, styles,
//    fonts and frames are never fetched, with or without the user's cookies
//    for that site. resources.ts counts what is therefore missing.

/** Content security policy for every extension page that replays a recording. */
export const REPLAY_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The only sandbox a replay frame may have. */
export const REPLAY_SANDBOX = 'allow-same-origin';

/** Throws unless the frame is sandboxed with exactly `allow-same-origin`. */
export function assertSandboxed(frame: { getAttribute(name: string): string | null }): void {
  const tokens = (frame.getAttribute('sandbox') ?? '').trim().split(/\s+/).filter(Boolean);
  if (frame.getAttribute('sandbox') === null || tokens.length !== 1 || tokens[0] !== REPLAY_SANDBOX) {
    throw new Error(`Replay frame must be sandboxed with "${REPLAY_SANDBOX}" only; found "${frame.getAttribute('sandbox') ?? '(none)'}"`);
  }
}
