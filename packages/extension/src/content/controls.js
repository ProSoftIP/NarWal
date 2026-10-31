// The in-page recording controls (board #16551): the one-line strip from
// @narwal/recorder-ui, mounted in the top frame of the recorded tab once the
// recorder accepts this document. It talks to the service worker only; the
// service worker accepts the strip's commands from the recorded tab alone.
import { mountStrip } from '../../../recorder-ui/src/strip.js';
import { createExtensionPort } from '../ui/recorder-port.js';

let strip = null;
let port = null;

const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ to: 'sw', cmd, ...extra });

// Called once per recording that accepts this document. A strip left open
// from an earlier recording in this tab has stopped polling (its recording
// ended), so it is replaced, not reused.
export function showControls() {
  if (window !== window.top) return;
  if (strip) strip.destroy();
  port = createExtensionPort({ send });
  strip = mountStrip({
    document,
    port,
    onClose: () => {
      const closing = port;
      closing
        .getStatus()
        .then((status) => closing.dismiss(status.recordingId))
        .catch(() => {});
      strip.destroy();
      strip = null;
      port = null;
    },
  });
}

// Browser-level shortcut (chrome.commands) from the service worker.
if (window === window.top) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== 'strip' || !strip) return;
    if (msg.cmd === 'focus') strip.focus();
    // An OpenAI job started from the recordings page or the popup (#16598).
    if (msg.cmd === 'refresh') port.refresh().catch(() => {});
  });
}
