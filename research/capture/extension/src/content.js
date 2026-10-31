// NarWal capture probe — content script (board #16538).
// Runs in every frame of the recorded tab (registered at document_start and
// executed once into already-open frames at start). Streams rrweb events and
// probe observations to the offscreen document over a runtime port. Research
// code: it measures behaviour, it is not the product recorder.
import { record } from 'rrweb';

const now = () => performance.timeOrigin + performance.now();

if (!globalThis.__narwalProbe) {
  globalThis.__narwalProbe = true;
  main();
}

// Index of this window in window.parent.frames. WindowProxy identity can be
// compared across origins, so the parent's content script can map the same
// index to its <iframe> element without postMessage (stitching child streams).
function frameIndexInParent() {
  if (window === window.top) return null;
  try {
    for (let i = 0; i < window.parent.frames.length; i += 1) if (window.parent.frames[i] === window) return i;
  } catch (err) {
    return `error: ${err && err.message}`;
  }
  return null;
}

function main() {
  const inst = crypto.randomUUID();
  const isTop = window === window.top;
  const navEntry = performance.getEntriesByType('navigation')[0];
  const boot = {
    inst,
    url: location.href,
    isTop,
    readyState: document.readyState,
    timeOrigin: performance.timeOrigin,
    navType: navEntry ? navEntry.type : null,
    injectedAt: now(),
    visibility: document.visibilityState,
    prerendering: Boolean(document.prerendering),
    frameIndex: frameIndexInParent(),
  };

  let port = null;
  let seq = 0;
  let stopRecording = null;
  let options = null;
  let ignored = false;
  let syncTimer = null;
  const pending = [];
  const PENDING_CAP = 5000;
  let dropped = 0;
  // Last messages sent, reported on each (re)attach so the analysis can name
  // what a closed port silently swallowed.
  const recent = [];

  function send(msg) {
    msg.seq = ++seq;
    msg.sent = now();
    recent.push({ seq: msg.seq, k: msg.k, type: msg.type || (msg.e ? msg.e.type : null), sent: msg.sent });
    if (recent.length > 100) recent.shift();
    if (!port) {
      msg.queued = true;
      if (pending.length >= PENDING_CAP) dropped += 1;
      else pending.push(msg);
      return;
    }
    try {
      port.postMessage(msg);
    } catch (err) {
      msg.queued = true;
      msg.postError = String(err && err.message);
      pending.push(msg);
    }
  }

  function probe(type, data) {
    send({ k: 'probe', type, url: location.href, ...data });
  }

  function connect(reason) {
    if (ignored) return;
    try {
      port = chrome.runtime.connect({ name: 'narwal-capture' });
    } catch (err) {
      // Extension context invalidated (extension reloaded/removed).
      port = null;
      return;
    }
    port.onMessage.addListener(onCommand);
    const thisPort = port;
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      if (port !== thisPort) return;
      port = null;
      // Record locally; it is flushed if this document reconnects (bfcache restore).
      pending.push({ k: 'probe', type: 'port-disconnected', err, seq: ++seq, sent: now(), queued: true });
    });
    port.postMessage({ k: 'hello', reason, boot, seq, sent: now(), pendingCount: pending.length, dropped, recent: recent.slice(), href: location.href });
    while (pending.length && port) {
      const msg = pending.shift();
      try {
        port.postMessage(msg);
      } catch (err) {
        pending.unshift(msg);
        break;
      }
    }
  }

  function onCommand(cmd) {
    if (cmd.cmd === 'ignore') {
      ignored = true;
      port.disconnect();
      port = null;
      return;
    }
    if (cmd.cmd === 'start') {
      options = cmd.options || {};
      if (stopRecording) {
        // Re-attached document (bfcache restore or recorder restart): a fresh
        // full snapshot re-bases replay for whatever happened while detached.
        record.takeFullSnapshot(true);
        probe('resnapshot', { reason: cmd.reason || 'restart' });
        return;
      }
      startRecording();
      return;
    }
    if (cmd.cmd === 'stop') {
      if (stopRecording) stopRecording();
      stopRecording = null;
      clearInterval(syncTimer);
      return;
    }
  }

  function startRecording() {
    const rrOptions = {
      emit: (e) => send({ k: 'rr', e }),
      recordCanvas: Boolean(options.recordCanvas),
      recordCrossOriginIframes: Boolean(options.recordCrossOriginIframes),
      recordAfter: options.recordAfter || 'load',
      maskAllInputs: true,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      blockClass: 'narwal-block',
      maskTextClass: 'narwal-mask',
    };
    if (options.recordCanvas) rrOptions.sampling.canvas = options.canvasFps || 4;
    try {
      stopRecording = record(rrOptions) || null;
      probe('rrweb-started', { readyState: document.readyState, recordAfter: rrOptions.recordAfter });
    } catch (err) {
      probe('rrweb-error', { message: String(err && err.message) });
    }
    syncTimer = setInterval(() => send({ k: 'sync', dnow: Date.now() }), 1000);
    if (isTop) setTimeout(census, 1500);
  }

  // Census of the surfaces rrweb cannot fully see, so the recorder can report
  // gaps instead of implying fidelity.
  function census() {
    let open = 0;
    let closed = 0;
    for (const el of document.querySelectorAll('*')) {
      const root = chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
      if (!root) continue;
      if (el.shadowRoot) open += 1;
      else closed += 1;
    }
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
      rrId: record.mirror.getId(c),
      width: c.width,
      height: c.height,
    }));
    const frames = [...document.querySelectorAll('iframe')].map((f) => {
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(f.contentDocument);
      } catch (err) {
        sameOrigin = false;
      }
      let frameIndex = null;
      for (let i = 0; i < window.frames.length; i += 1) if (window.frames[i] === f.contentWindow) frameIndex = i;
      const getFrameId = typeof chrome.runtime.getFrameId === 'function' ? 'available' : 'absent';
      return { rrId: record.mirror.getId(f), src: f.getAttribute('src'), srcdoc: f.hasAttribute('srcdoc'), sameOrigin, frameIndex, getFrameId };
    });
    probe('census', { shadow: { open, closed }, canvases, frames });
  }

  addEventListener('visibilitychange', () => probe('visibility', { state: document.visibilityState }), true);
  addEventListener('pagehide', (e) => {
    // 'detach' policy: leave the port ourselves before Chrome closes it for the
    // back/forward cache, so this and later sends queue locally and are
    // delivered on restore instead of vanishing on a closed port.
    if (e.persisted && options && options.bfcachePolicy !== 'naive' && port) {
      const old = port;
      port = null;
      try {
        old.disconnect();
      } catch (err) {
        // Already closed.
      }
    }
    probe('pagehide', { persisted: e.persisted });
  }, true);
  addEventListener('pageshow', (e) => {
    if (e.persisted) {
      // Chrome closes extension ports when a page enters the back/forward
      // cache, and the disconnect event can arrive after pageshow. Always
      // drop the old port and attach again on a restore.
      if (port) {
        try {
          port.disconnect();
        } catch (err) {
          // Already closed.
        }
        port = null;
      }
      probe('pageshow', { persisted: true });
      connect('bfcache-restore');
      return;
    }
    probe('pageshow', { persisted: false });
  }, true);
  document.addEventListener('freeze', () => probe('freeze', {}), true);
  document.addEventListener('resume', () => probe('resume', {}), true);
  addEventListener('popstate', () => probe('popstate', {}), true);
  addEventListener('hashchange', () => probe('hashchange', {}), true);
  if (globalThis.navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigatesuccess', () => probe('route', { via: 'navigation-api' }));
  }

  connect('boot');
}
