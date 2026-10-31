// The one-line recording strip (board #16531: "a one line thing across the
// bottom of the screen"). It sits in the recorded page, so it is built to
// stay out of the way and out of the recording:
//   - one marked host element (markNarwalUi) with a closed shadow root
//     (capture-exclusion.js explains the three layers that rely on it);
//   - one line high; the transcript opens above it only on demand;
//   - a mouse click on a control does not take focus from the page;
//   - its key and pointer events stop at the host, so page shortcuts and
//     "click outside" handlers do not react to them.

import { markNarwalUi } from './capture-exclusion.js';
import { adoptCss, h } from './dom.js';
import { narwalLogo } from './logo.js';
import { HEARD_LEVEL } from './mic-level.js';
import { stripModel } from './strip-model.js';
import { STRIP_CSS } from './styles.js';
import { createTranscript, formatClock } from './transcript.js';

const PANEL_ID = 'narwal-transcript';
// The level meter reads the recorder this often while recording (board #16785).
const METER_MS = 200;
const CONTAINED_EVENTS = ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];

/**
 * @param {Object} options
 * @param {Document} options.document
 * @param {import('./port.js').RecorderPort} options.port
 * @param {'closed'|'open'} [options.shadowMode] 'open' only in tests that must look inside
 * @param {() => number} [options.now] monotonic milliseconds
 * @param {() => void} [options.onClose] called when the user closes the strip after a recording
 */
export function mountStrip({ document: doc, port, shadowMode = 'closed', now, onClose }) {
  const view = doc.defaultView;
  const clock = now || (() => view.performance.now());
  const transcript = createTranscript();

  const host = markNarwalUi(h(doc, 'div'), 'strip');
  const shadow = host.attachShadow({ mode: shadowMode });
  adoptCss(shadow, STRIP_CSS);

  const log = h(doc, 'div', { class: 'log', role: 'log', 'aria-live': 'off', tabindex: '0', 'aria-label': 'Transcript so far' });
  const panel = h(
    doc,
    'section',
    { class: 'panel', id: PANEL_ID, 'aria-label': 'Transcript', hidden: true },
    h(
      doc,
      'div',
      { class: 'panel-head' },
      h(doc, 'span', { class: 'panel-title', text: 'Transcript so far' }),
      h(doc, 'span', { class: 'panel-hint', text: 'This is a draft. It is finished after you stop.' }),
    ),
    log,
  );

  const dot = h(doc, 'span', { class: 'dot', 'aria-hidden': 'true' });
  const badge = h(doc, 'span', { class: 'badge' });
  const time = h(doc, 'span', { class: 'time', role: 'timer', 'aria-label': 'Recording time' });
  // Decorative: a silent microphone is also said in the message line.
  const meterFill = h(doc, 'span', { class: 'meter-fill' });
  const meter = h(doc, 'span', { class: 'meter', 'aria-hidden': 'true', title: 'Microphone level', hidden: true }, meterFill);
  const note = h(doc, 'span', { class: 'note', hidden: true });
  const messageText = h(doc, 'span', { class: 'message-text' });
  const message = h(doc, 'span', { class: 'message' }, messageText);
  const announcer = h(doc, 'span', { class: 'sr', role: 'status', 'aria-live': 'polite' });

  // A control that fails says so on the line, not only to a screen reader
  // (board #16622). The words stay until the next press or the next phase.
  let failure = null;
  const act = (run) => () => {
    failure = null;
    render();
    Promise.resolve()
      .then(run)
      .catch((error) => {
        const text = `That did not work: ${error && error.message ? error.message : 'unknown error'}`;
        failure = { text, phase: status.phase, recordingId: status.recordingId };
        announcer.textContent = text;
        render();
      });
  };
  const button = (cls, label, onClick) => h(doc, 'button', { class: `btn ${cls}`, type: 'button', text: label, on: { click: onClick } });
  const retry = button('retry', '', act(() => port.retryTranscript()));
  // A narrow window shows the short label, so the reason keeps some room.
  retry.append(h(doc, 'span', { class: 'wide', text: 'Try transcript again' }), h(doc, 'span', { class: 'narrow', text: 'Try again' }));
  retry.setAttribute('aria-label', 'Try transcript again');
  const toggle = button('toggle', 'Transcript', () => setPanel(panel.hidden));
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', PANEL_ID);
  // After Stop, the recording just saved can leave at once (board #16602).
  const exportButton = button('export', '', act(() => port.exportRecording(status.recordingId)));
  const exportWide = h(doc, 'span', { class: 'wide' });
  exportButton.append(exportWide, h(doc, 'span', { class: 'narrow', text: 'Export' }));
  const open = button('open', 'Open recording', act(() => port.openRecording(status.recordingId)));
  const stop = button('stop', 'Stop', act(() => port.stop()));
  const close = button('close', 'Close', () => {
    dismissed = true;
    render();
    if (onClose) onClose();
  });
  const buttons = [retry, toggle, exportButton, open, stop, close];

  const bar = h(
    doc,
    'div',
    { class: 'bar' },
    h(doc, 'span', { class: 'state' }, narwalLogo(doc, 16), dot, badge, time, meter),
    note,
    message,
    announcer,
    ...buttons,
  );
  const wrap = h(doc, 'div', { class: 'wrap', role: 'region', 'aria-label': 'NarWal recording controls', lang: 'en', dir: 'ltr' }, panel, bar);
  shadow.append(wrap);

  /** @type {import('./port.js').RecorderStatus} */
  let status = { phase: 'idle', tab: { ok: true }, mic: 'granted', model: { state: 'missing' }, keys: {} };
  let anchor = { elapsedMs: 0, at: clock() };
  let seen = false;
  let dismissed = false;
  let destroyed = false;
  let lastAnnounce = '';
  let logFrame = 0;
  let meterTimer = 0;
  let meterReading = false;

  const elapsed = () => (status.phase === 'recording' ? anchor.elapsedMs + (clock() - anchor.at) : anchor.elapsedMs);

  function setPanel(show) {
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    toggle.classList.toggle('on', show);
    if (show) {
      renderLog();
      log.scrollTop = log.scrollHeight;
    }
  }

  function renderLog() {
    logFrame = 0;
    if (panel.hidden) return;
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const lines = transcript.lines();
    const rows = lines.map((line) =>
      h(
        doc,
        'p',
        { class: `line ${line.kind}` },
        h(doc, 'span', { class: 'line-time', text: formatClock(line.startMs) }),
        h(doc, 'span', { class: 'line-text', text: line.text }),
      ),
    );
    if (rows.length === 0) rows.push(h(doc, 'p', { class: 'line empty', text: 'No words yet. They appear here as you talk.' }));
    log.replaceChildren(...rows);
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  function scheduleLog() {
    if (panel.hidden || logFrame) return;
    logFrame = view.requestAnimationFrame(renderLog);
  }

  function render() {
    if (destroyed) return;
    const model = dismissed ? null : stripModel(status, { tail: transcript.tail(), elapsedMs: elapsed() });
    if (!model) {
      if (host.isConnected) host.remove();
      return;
    }
    // In the page first: the scroll position below needs layout.
    if (!host.isConnected) doc.documentElement.append(host);
    if (failure && (failure.phase !== status.phase || failure.recordingId !== status.recordingId)) failure = null;
    const shown = failure ? { tone: 'warn', messageKind: 'status', message: failure.text } : model;
    wrap.dataset.tone = shown.tone;
    badge.textContent = model.badge;
    time.textContent = model.time;
    note.hidden = !model.note;
    note.textContent = model.note || '';
    message.className = `message ${shown.messageKind}`;
    if (messageText.textContent !== shown.message) {
      messageText.textContent = shown.message;
      message.title = shown.messageKind === 'status' ? shown.message : '';
    }
    // The newest words stay in view: scroll the clipped line to its end.
    if (model.messageKind === 'transcript') message.scrollLeft = message.scrollWidth;
    else message.scrollLeft = 0;
    if (model.announce !== lastAnnounce) {
      lastAnnounce = model.announce;
      announcer.textContent = model.announce;
    }
    retry.hidden = !model.showRetry;
    toggle.hidden = !model.showToggle;
    // While the transcript is coming, Export is still pressed: the recordings
    // page it opens exports as soon as the transcript is ready (board #16622).
    exportButton.hidden = !model.showExport;
    const exportLabel = model.exportWaiting ? 'Export when the transcript is ready' : 'Export';
    if (exportWide.textContent !== exportLabel) {
      exportWide.textContent = exportLabel;
      exportButton.setAttribute('aria-label', exportLabel);
    }
    open.hidden = !model.showOpen;
    stop.hidden = !model.showStop;
    close.hidden = !model.showClose;
    setMeter(Boolean(model.showMeter) && typeof port.micLevel === 'function');
    stop.disabled = model.stopBusy;
    stop.textContent = model.stopBusy ? 'Saving…' : 'Stop';
    if (!model.showToggle && !panel.hidden) setPanel(false);
  }

  function setMeter(show) {
    meter.hidden = !show;
    if (show && !meterTimer) meterTimer = view.setInterval(readMeter, METER_MS);
    if (!show && meterTimer) {
      view.clearInterval(meterTimer);
      meterTimer = 0;
      showLevel(null);
    }
  }

  function showLevel(reading) {
    const level = reading ? reading.level : 0;
    meterFill.style.transform = `scaleX(${level.toFixed(3)})`;
    meter.dataset.level = level.toFixed(2);
    meter.dataset.heard = String(Boolean(reading && reading.level >= HEARD_LEVEL));
  }

  function readMeter() {
    if (meterReading) return;
    meterReading = true;
    Promise.resolve()
      .then(() => port.micLevel())
      .then((reading) => {
        if (meterTimer) showLevel(reading);
      })
      .catch(() => {})
      .finally(() => (meterReading = false));
  }

  function update(next) {
    // A new recording after an earlier one in this page starts with an empty
    // transcript. The first status only tells us where we are.
    const restarted = seen && ['starting', 'recording'].includes(next.phase) && !['starting', 'recording'].includes(status.phase);
    seen = true;
    if (restarted) {
      transcript.clear();
      dismissed = false;
    }
    status = next;
    anchor = { elapsedMs: next.elapsedMs || 0, at: clock() };
    render();
    scheduleLog();
  }

  function onEvent(event) {
    if (event.type === 'status') update(event.status);
    else if (transcript.apply(event)) {
      render();
      scheduleLog();
    }
  }

  // Keys and clicks on the controls are not the page's business.
  const contain = (event) => {
    if (event.type === 'keydown' && event.key === 'Escape' && !panel.hidden) {
      setPanel(false);
      toggle.focus();
    }
    event.stopPropagation();
  };
  for (const type of CONTAINED_EVENTS) host.addEventListener(type, contain);
  // A mouse press on a control keeps focus (and any text selection) in the page.
  bar.addEventListener('mousedown', (event) => {
    if (event.target instanceof view.Element && event.target.closest('button')) event.preventDefault();
  });

  // A page that rewrites <html> removes the strip; put it back while it is needed.
  const guard = new view.MutationObserver(() => {
    if (!host.isConnected) render();
  });
  guard.observe(doc.documentElement, { childList: true });

  // A narrower window clips more of the line: keep its end in view.
  view.addEventListener('resize', render);

  const ticker = view.setInterval(() => {
    if (status.phase === 'recording' && host.isConnected) time.textContent = formatClock(elapsed());
  }, 500);

  const unsubscribe = port.subscribe(onEvent);
  port
    .getStatus()
    .then((first) => {
      if (!destroyed) update(first);
    })
    // Status events from subscribe() still arrive; the first read is not needed.
    .catch(() => {});

  return {
    host,
    /** Moves keyboard focus to the controls (for a browser-level shortcut): Stop first. */
    focus() {
      const usable = (b) => !b.hidden && !b.disabled;
      const target = usable(stop) ? stop : buttons.find(usable);
      if (target) target.focus();
      return Boolean(target);
    },
    /** @param {boolean} [show] */
    toggleTranscript(show) {
      if (toggle.hidden) return false;
      setPanel(show === undefined ? panel.hidden : show);
      return true;
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      guard.disconnect();
      view.clearInterval(ticker);
      setMeter(false);
      view.removeEventListener('resize', render);
      if (logFrame) view.cancelAnimationFrame(logFrame);
      host.remove();
    },
  };
}
