// NarWal content script. Registered at document_start in every frame while a
// recording runs (and executed once into frames already open at Start). It
// attaches to the offscreen recorder over a port and streams rrweb events.
// Typed values are masked from the first snapshot. Nothing is sent until the
// recorder acknowledges the attach, so a port with no receiver (recorder
// restarting) never swallows evidence: it waits in a bounded local queue.
// Next to rrweb it runs the interaction capture (packages/interactions):
// masked interaction observations and the right-button markers, sent as
// `{k: 'obs'}` on the same port.
//
// Areas the user hid before Start (board #16592) apply to the top frame of
// the page they were picked on. Such a document records only after its areas
// are found again (resolveAreas); when one is lost, the whole page body is
// hidden instead. A frame inside a hidden area records nothing: the recorder
// asks the frame's parent document (`frame-hidden`) before it starts it.
import { record } from 'rrweb';
import { rrwebPrivacyOptions, startInteractionCapture } from '../../../interactions/src/index.ts';
import { PrivacyPolicy } from '../../../interactions/src/dom.ts';
import { createCaptureFilter } from '../../../recorder-ui/src/capture-exclusion.js';
import { areasForDocument, resolveAreas } from '../shared/hidden-regions.js';
import { MARK_FOCUSED, PORT_NAME } from '../shared/protocol.js';
import { showControls } from './controls.js';

const now = () => performance.timeOrigin + performance.now();
const QUEUE_CAP = 20000;
const MAX_RECONNECTS = 40;

// The command and an in-page Alt+Shift+M can both see one key press when the
// page gets the key too; the second within this window is the same press.
const KEY_MARK_DEDUPE_MS = 500;

// A top document with hidden areas checks them when the page has loaded, or
// after this long.
const AREA_WAIT_MS = 10000;

// Privacy defaults applied from the first full snapshot. maskAllInputs masks
// input, textarea and select values (passwords always) with a fixed mask that
// hides the length. Text typed into editable regions is masked too. Elements
// marked data-narwal-ui (the recording controls, the marker overlay) or
// data-narwal-exclude are never recorded: rrweb keeps an empty placeholder for
// a data-narwal-ui element, which createCaptureFilter removes before anything
// is sent (board #16551). `exclusions` are the areas the user hid on this
// page before Start (board #16592): blocked the same way.
export function rrwebOptions(exclusions = []) {
  return {
    ...rrwebPrivacyOptions(exclusions),
    recordCanvas: false,
    recordCrossOriginIframes: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last' },
  };
}
export const RRWEB_OPTIONS = rrwebOptions([]);

// rrweb 2.1.7 records the inside of a same-origin <iframe> that is itself
// blocked: serializeNodeWithId loads and serializes its contentDocument
// outside the recordChild guard. This content script's world has its own DOM
// prototypes, so here an excluded frame has no contentDocument; the page's
// own scripts see no change. The policy is on globalThis because a second
// injection of this script evaluates the module again (board #16592).
function guardFrames() {
  const proto = HTMLIFrameElement.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, 'contentDocument');
  if (globalThis.__narwalFramesGuarded || !own || !own.get) return;
  globalThis.__narwalFramesGuarded = true;
  Object.defineProperty(proto, 'contentDocument', {
    configurable: true,
    enumerable: own.enumerable,
    get() {
      const doc = own.get.call(this);
      const policy = globalThis.__narwalFramePolicy;
      return doc && policy && policy.isExcluded(this) ? null : doc;
    },
  });
}
guardFrames();

// The <iframe> or <frame> element of window.frames[index], in this document
// or an open shadow root inside it; null when it is not found.
function frameElementAt(index) {
  const win = window.frames[index];
  if (!win) return null;
  const search = (root) => {
    for (const el of root.querySelectorAll('iframe, frame')) if (el.contentWindow === win) return el;
    for (const el of root.querySelectorAll('*')) {
      const found = el.shadowRoot && search(el.shadowRoot);
      if (found) return found;
    }
    return null;
  };
  return search(document);
}

function loaded(ms) {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// One recorder per document. A document whose recorder finished (refused,
// stopped) joins again when a later recording injects this script.
if (!globalThis.__narwalRecorder) globalThis.__narwalRecorder = main();
else globalThis.__narwalRecorder.rejoin();

// Index of this window in window.parent.frames: the parent's script maps the
// same index to its <iframe> to stitch child streams (board #16538).
function frameIndexInParent() {
  if (window === window.top) return null;
  try {
    for (let i = 0; i < window.parent.frames.length; i += 1) if (window.parent.frames[i] === window) return i;
  } catch {
    return null;
  }
  return null;
}

function main() {
  const navEntry = performance.getEntriesByType('navigation')[0];
  const boot = {
    inst: crypto.randomUUID(),
    url: location.href,
    isTop: window === window.top,
    readyState: document.readyState,
    timeOrigin: performance.timeOrigin,
    navType: navEntry ? navEntry.type : null,
    injectedAt: now(),
    prerendering: Boolean(document.prerendering),
    frameIndex: frameIndexInParent(),
  };

  let port = null;
  let attached = false;
  let finished = false;
  let stopRecording = null;
  // True from the first start command until finish(): rrweb and the capture
  // run once per recording, even when rrweb record() returned nothing.
  let started = false;
  let capture = null;
  // What this document hides, once startRecording knows it; the parent of a
  // child frame waits for it before it answers `frame-hidden`.
  let policy = null;
  let policyWaiters = [];
  // Counts recordings in this document: an await in startRecording checks it.
  let generation = 0;
  let lastKeyMarkAt = -Infinity;
  let seq = 0;
  let dropped = 0;
  let reconnects = 0;
  let reconnectTimer = null;
  const queue = [];

  function send(msg) {
    if (finished) return;
    msg.seq = ++seq;
    msg.sent = now();
    if (port && attached) {
      try {
        port.postMessage(msg);
        return;
      } catch {
        // Closed under us; fall through to the queue.
      }
    }
    if (queue.length >= QUEUE_CAP) dropped += 1;
    else queue.push(msg);
  }

  const page = (type, data) => send({ k: 'page', type, url: location.href, ...data });

  function finish() {
    // Stop the capture first: it sends what is still open (an edit burst, a
    // dwell, a scroll) while the port can still deliver it.
    if (capture) capture.stop();
    capture = null;
    started = false;
    finished = true;
    generation += 1;
    policy = null;
    policyWaiters = [];
    globalThis.__narwalFramePolicy = null;
    clearTimeout(reconnectTimer);
    if (stopRecording) stopRecording();
    stopRecording = null;
    queue.length = 0;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already closed.
      }
    }
    port = null;
  }

  function connect(reason) {
    if (finished) return;
    clearTimeout(reconnectTimer);
    let p;
    try {
      p = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      // Extension reloaded or removed: this script can never deliver again.
      finish();
      return;
    }
    port = p;
    attached = false;
    p.onMessage.addListener((cmd) => onCommand(p, cmd));
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== p) return;
      port = null;
      attached = false;
      if (!finished) scheduleReconnect();
    });
    p.postMessage({ k: 'hello', reason, boot, sent: now(), queued: queue.length, dropped });
  }

  // The recorder went away (crash or restart) while this document still
  // records. Keep queueing, nudge the service worker to bring the recorder
  // back, and attach again with backoff.
  function scheduleReconnect() {
    reconnects += 1;
    if (reconnects > MAX_RECONNECTS) {
      finish();
      return;
    }
    if (reconnects === 1) chrome.runtime.sendMessage({ to: 'sw', cmd: 'sink-lost' }).catch(() => {});
    const delay = Math.min(250 * 2 ** Math.min(reconnects - 1, 5), 5000);
    reconnectTimer = setTimeout(() => connect('reconnect'), delay);
  }

  function onCommand(p, cmd) {
    if (p !== port) return;
    if (cmd.cmd === 'ignore' || cmd.cmd === 'stop') {
      finish();
      return;
    }
    if (cmd.cmd === 'frame-hidden') {
      answerFrame(p, cmd);
      return;
    }
    if (cmd.cmd === 'start') {
      attached = true;
      reconnects = 0;
      while (queue.length && port === p) {
        try {
          p.postMessage(queue[0]);
          queue.shift();
        } catch {
          attached = false;
          break;
        }
      }
      if (started) {
        // Re-attached (back/forward restore or recorder restart): a fresh
        // full snapshot re-bases replay for whatever happened meanwhile.
        if (stopRecording) record.takeFullSnapshot(true);
        page('resnapshot', { reason: cmd.reason });
        return;
      }
      started = true;
      startRecording(cmd.options || {});
      // The recorder accepted this document, so this is the recorded tab.
      showControls();
    }
  }

  function setPolicy(next) {
    policy = next;
    globalThis.__narwalFramePolicy = next;
    for (const resolve of policyWaiters.splice(0)) resolve(next);
  }

  // Is the child frame at window.frames[frameIndex] inside an area this
  // document hides? A frame that cannot be found counts as hidden.
  async function answerFrame(p, cmd) {
    const own = policy || (await new Promise((resolve) => policyWaiters.push(resolve)));
    const el = frameElementAt(cmd.frameIndex);
    try {
      p.postMessage({ k: 'frame-hidden', q: cmd.q, hidden: !el || own.isExcluded(el) });
    } catch {
      // Port closed: the recorder counts no answer as hidden.
    }
  }

  async function startRecording(options) {
    const gen = generation;
    // The areas hidden with the picker on this page (start command `hidden`).
    const areas = areasForDocument(options.hidden, { href: location.href, isTop: boot.isTop });
    let exclusions = [];
    if (areas.length) {
      await loaded(AREA_WAIT_MS);
      if (gen !== generation) return;
      const { found, lost } = resolveAreas(document, areas);
      exclusions = found.map((f) => f.selector);
      if (lost) {
        // Never fail open: the page no longer has an area the user hid, so
        // what they meant to hide may be anywhere on it.
        exclusions.push('body');
        page('hidden-areas-lost', { lost });
      }
    }
    setPolicy(new PrivacyPolicy(exclusions));
    const filter = createCaptureFilter();
    try {
      stopRecording =
        record({
          ...rrwebOptions(exclusions),
          recordAfter: options.recordAfter || 'DOMContentLoaded',
          emit: (e) => {
            const kept = filter(e);
            if (kept) send({ k: 'rr', e: kept });
          },
        }) || null;
    } catch (err) {
      page('rrweb-error', { message: String(err && err.message) });
    }
    startCapture(options, exclusions);
  }

  // Observation times are session ms: the recorder sends its start time
  // (manifest clock.originEpochMs) with the start command.
  function startCapture(options, exclusions) {
    if (capture) return;
    if (typeof options.originEpochMs !== 'number') {
      page('capture-error', { message: 'no originEpochMs in the start command' });
      return;
    }
    const origin = options.originEpochMs;
    try {
      capture = startInteractionCapture({
        doc: boot.inst,
        exclusions,
        now: () => now() - origin,
        nodeIdOf: (n) => {
          const id = record.mirror.getId(n);
          return id > 0 ? id : null;
        },
        emit: (o) => {
          if (o.kind === 'marker-element' && o.via !== 'right-click') lastKeyMarkAt = now();
          send({ k: 'obs', o });
        },
      });
    } catch (err) {
      capture = null;
      page('capture-error', { message: String(err && err.message) });
    }
  }

  // The Alt+Shift+M command reaches every frame of the tab. Only the frame
  // holding focus marks (an ancestor's focus is the <iframe> element); when
  // no frame has focus, the top frame marks the element under the pointer.
  function onMarkFocused() {
    if (!capture || finished) return;
    if (now() - lastKeyMarkAt < KEY_MARK_DEDUPE_MS) return;
    const focused = document.hasFocus();
    if (focused) {
      const active = document.activeElement;
      if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) return;
    } else if (!boot.isTop) return;
    capture.markFocused();
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.cmd === MARK_FOCUSED) onMarkFocused();
  });

  addEventListener('pagehide', (e) => {
    // Chrome closes extension ports when a page enters the back/forward
    // cache, dropping messages silently, even one posted just before the
    // port closes. Leave first, then queue (board #16538, design point 4).
    if (e.persisted && port) {
      const old = port;
      port = null;
      attached = false;
      try {
        old.disconnect();
      } catch {
        // Already closed.
      }
    }
    page('pagehide', { persisted: e.persisted });
  }, true);
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already closed.
      }
      port = null;
      attached = false;
    }
    page('pageshow', { persisted: true });
    connect('bfcache-restore');
  }, true);
  addEventListener('visibilitychange', () => page('visibility', { state: document.visibilityState }), true);
  document.addEventListener('freeze', () => page('freeze', {}), true);
  document.addEventListener('resume', () => page('resume', {}), true);
  if (globalThis.navigation && typeof navigation.addEventListener === 'function') {
    // rrweb emits no Meta event on pushState; record every same-document route.
    navigation.addEventListener('navigatesuccess', () => page('route', {}));
  }

  connect('boot');

  return {
    rejoin() {
      if (!finished) return;
      finished = false;
      reconnects = 0;
      dropped = 0;
      seq = 0;
      // A new recording: to it this document attaches for the first time.
      connect('boot');
    },
  };
}
