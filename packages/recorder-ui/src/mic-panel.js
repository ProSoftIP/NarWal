// The microphone picker and test bar (board #16785; Matt: "a microphone test
// bar and button in NarWal so you can check it's working (and maybe select
// which microphone you're going to use)"). One line in the popup before Start,
// a section on the Options page:
//   - a select of the audio inputs; the choice is saved (prefs.microphone) and
//     every recording uses it, or the default one with a note when it is gone;
//   - a level meter and a Test button that starts and stops it. The test reads
//     levels from an AnalyserNode only: nothing is recorded or kept;
//   - not asked, blocked and no microphone each get one sentence and the fix.
// It runs on extension pages (it needs getUserMedia and the extension's
// microphone permission), inside a .nw-start surface for the colour tokens.

import { adoptCss, h } from './dom.js';
import { HEARD_LEVEL, createSilenceWatch, measureLevel } from './mic-level.js';

const SAMPLE_MS = 100;
const VOICE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export const MIC_TEXT = Object.freeze({
  prompt: 'NarWal has not asked to use your microphone yet.',
  denied: 'The microphone is blocked for NarWal.',
  none: 'No microphone is connected. Connect one, then check again.',
  fix: { prompt: 'Allow microphone', denied: 'Open microphone settings', none: 'Check again' },
  hint: 'Test listens to the microphone and records nothing.',
  listening: 'Listening… say something.',
  hearing: 'NarWal hears you.',
  silent: (label) => `No sound from ${label}. Check it is switched on and not muted, or choose another microphone.`,
  missing: (label) => `${label} is not connected. NarWal records with the default microphone until it is back.`,
  failed: (label, name) => `The test could not use ${label} (${name}).`,
});

/**
 * The select's options for the audio inputs the browser lists. The first
 * option is the browser's default and names the device it is now.
 * @param {Array<{kind:string, deviceId:string, label:string}>} devices  enumerateDevices()
 * @param {{id:string, label:string}|null} saved  prefs.microphone
 */
export function microphoneChoices(devices, saved) {
  const inputs = (devices || []).filter((d) => d.kind === 'audioinput');
  const system = inputs.find((d) => d.deviceId === 'default');
  // 'default' and 'communications' (Windows) are aliases of real devices.
  const real = inputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const defaultName = system ? system.label.replace(/^Default\s*-\s*/i, '') : real[0] ? real[0].label : '';
  const options = [{ value: '', label: defaultName ? `Default: ${defaultName}` : 'Default microphone' }];
  real.forEach((d, i) => options.push({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  const found = Boolean(saved && real.some((d) => d.deviceId === saved.id));
  return {
    options,
    selected: found ? saved.id : '',
    missing: saved && !found ? saved.label || 'The microphone you chose' : null,
    defaultName,
    count: real.length || (system ? 1 : 0),
  };
}

/**
 * @param {Object} options
 * @param {HTMLElement} options.root  the panel is appended here
 * @param {ReturnType<import('./prefs.js').createPrefs>} options.prefs
 * @param {(state:'prompt'|'denied') => Promise<void>|void} options.onFix  ask for the microphone, or open its settings
 * @param {boolean} [options.compact]  the popup's one line
 * @param {MediaDevices} [options.media]  default: navigator.mediaDevices
 * @param {() => Promise<'granted'|'prompt'|'denied'>} [options.permission]  default: the Permissions API
 * @param {() => number} [options.now]  monotonic ms
 */
export function mountMicPanel({ root, prefs, onFix, compact = false, media, permission, now }) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const devicesApi = media || view.navigator.mediaDevices;
  const clock = now || (() => view.performance.now());
  const readPermission =
    permission ||
    (async () => {
      try {
        return (await view.navigator.permissions.query({ name: 'microphone' })).state;
      } catch {
        return 'prompt';
      }
    });
  adoptCss(doc, MIC_CSS);

  let access = 'loading';
  let choices = microphoneChoices([], null);
  let saved = null;
  let selected = '';
  let test = null; // {token, label, stream?, ctx?, timer?, watch?, state?, error?}
  let token = 0;
  let destroyed = false;

  const select = h(doc, 'select', {
    class: 'nw-mic-select',
    id: compact ? 'nw-mic-select' : 'nw-mic-select-full',
    'aria-label': 'Microphone',
    'data-key': 'mic-select',
    on: { change: () => choose(select.value) },
  });
  const fill = h(doc, 'span', { class: 'nw-meter-fill' });
  const meter = h(doc, 'span', { class: 'nw-meter', 'aria-hidden': 'true', 'data-level': '0', 'data-heard': 'false' }, fill);
  const testButton = h(doc, 'button', {
    class: 'nw-btn nw-mic-test',
    type: 'button',
    text: 'Test',
    'aria-pressed': 'false',
    'data-key': 'mic-test',
    on: { click: () => (test ? stopTest() : startTest()) },
  });
  const statusLine = h(doc, 'p', { class: 'nw-mic-status', role: 'status', 'aria-live': 'polite' });
  const row = h(doc, 'div', { class: 'nw-mic-row' }, select, meter, testButton);
  const problemText = h(doc, 'span', { class: 'nw-mic-problem-text' });
  const fixButton = h(doc, 'button', { class: 'nw-btn', type: 'button', 'data-key': 'mic-fix', on: { click: () => fix() } });
  const problem = h(doc, 'div', { class: 'nw-mic-problem', hidden: true }, problemText, fixButton);
  const panel = h(
    doc,
    'section',
    { class: `nw-mic${compact ? ' nw-mic-compact' : ''}`, 'aria-label': 'Microphone', 'data-access': access, 'data-testing': 'false' },
    compact ? null : h(doc, 'h2', { text: 'Microphone' }),
    compact ? null : h(doc, 'p', { class: 'nw-mic-intro', text: 'NarWal records your voice with this microphone. Choose one, then press Test and talk to check it hears you.' }),
    row,
    problem,
    statusLine,
  );
  root.append(panel);

  const labelOf = (id) => {
    const option = choices.options.find((o) => o.value === id);
    if (id && option) return option.label;
    return choices.defaultName || 'the default microphone';
  };

  async function refresh() {
    const [state, devices, stored] = await Promise.all([
      readPermission(),
      devicesApi && devicesApi.enumerateDevices ? devicesApi.enumerateDevices().catch(() => []) : [],
      prefs.get().catch(() => ({ microphone: null })),
    ]);
    if (destroyed) return;
    saved = stored.microphone;
    choices = microphoneChoices(devices, saved);
    access = !devicesApi ? 'none' : state !== 'granted' ? state : choices.count ? 'granted' : 'none';
    // Keep what the user is testing while the list changes under it.
    selected = test && choices.options.some((o) => o.value === selected) ? selected : choices.selected;
    if (access !== 'granted') stopTest();
    render();
  }

  function render() {
    if (destroyed) return;
    panel.dataset.access = access;
    panel.dataset.testing = String(Boolean(test && !test.error));
    const ok = access === 'granted';
    row.hidden = !ok;
    // The popup's Microphone check already says what is wrong and has the
    // fix, so its one line waits until the microphone can be used.
    panel.hidden = compact && !ok;
    problem.hidden = ok || access === 'loading' || compact;
    if (!ok && access !== 'loading') {
      problemText.textContent = MIC_TEXT[access] || MIC_TEXT.prompt;
      fixButton.textContent = MIC_TEXT.fix[access] || MIC_TEXT.fix.prompt;
    }
    const key = choices.options.map((o) => `${o.value}=${o.label}`).join('|');
    if (select.dataset.for !== key) {
      select.dataset.for = key;
      select.replaceChildren(...choices.options.map((o) => h(doc, 'option', { value: o.value, text: o.label })));
    }
    select.value = selected;
    const testing = Boolean(test && !test.error);
    testButton.textContent = testing ? 'Stop test' : 'Test';
    testButton.setAttribute('aria-pressed', String(testing));
    renderStatus();
  }

  function renderStatus() {
    let text = '';
    let tone = '';
    if (access !== 'granted') text = '';
    else if (test && test.error) {
      text = MIC_TEXT.failed(test.label, test.error);
      tone = 'warn';
    } else if (test && test.state && test.state.silent) {
      text = MIC_TEXT.silent(test.label);
      tone = 'warn';
    } else if (test) text = test.state && test.state.heard ? MIC_TEXT.hearing : MIC_TEXT.listening;
    else if (choices.missing) {
      text = MIC_TEXT.missing(choices.missing);
      tone = 'warn';
    } else if (!compact) text = MIC_TEXT.hint;
    if (statusLine.textContent !== text) statusLine.textContent = text;
    statusLine.dataset.tone = tone;
    statusLine.hidden = !text;
  }

  function showLevel(state) {
    const level = state ? state.level : 0;
    fill.style.transform = `scaleX(${level.toFixed(3)})`;
    meter.dataset.level = level.toFixed(2);
    meter.dataset.heard = String(level >= HEARD_LEVEL);
  }

  async function choose(value) {
    selected = value;
    const option = choices.options.find((o) => o.value === value);
    saved = value ? { id: value, label: option ? option.label : '' } : null;
    choices = { ...choices, selected: value, missing: null };
    render();
    await prefs.update({ microphone: saved }).catch(() => {});
    if (test) startTest();
  }

  async function startTest() {
    stopTest();
    const mine = ++token;
    const id = selected;
    test = { token: mine, label: labelOf(id) };
    render();
    let stream;
    try {
      stream = await devicesApi.getUserMedia({ audio: { ...VOICE, ...(id ? { deviceId: { exact: id } } : {}) } });
    } catch (err) {
      if (test && test.token === mine) {
        test = { token: mine, label: test.label, error: (err && err.name) || 'error' };
        render();
      }
      return;
    }
    if (destroyed || !test || test.token !== mine) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = new view.AudioContext();
    ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // A node with no path to the destination is not pulled in some builds; nothing is heard.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(analyser).connect(mute).connect(ctx.destination);
    const samples = new Float32Array(analyser.fftSize);
    const watch = createSilenceWatch(clock());
    test.stream = stream;
    test.ctx = ctx;
    test.watch = watch;
    test.state = watch.state();
    test.timer = view.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      test.state = watch.feed(measureLevel(samples).rms, clock());
      showLevel(test.state);
      renderStatus();
      panel.dataset.testing = 'true';
    }, SAMPLE_MS);
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => test && test.token === mine && stopTest());
    render();
  }

  function stopTest() {
    if (!test) return;
    const was = test;
    test = null;
    token += 1;
    if (was.timer) view.clearInterval(was.timer);
    if (was.stream) was.stream.getTracks().forEach((t) => t.stop());
    if (was.ctx) was.ctx.close().catch(() => {});
    showLevel(null);
    render();
  }

  async function fix() {
    if (access === 'none') {
      await refresh();
      return;
    }
    await onFix(access === 'denied' ? 'denied' : 'prompt');
    await refresh();
  }

  // The list follows plugged and unplugged devices and a permission change.
  const onDevices = () => refresh().catch(() => {});
  if (devicesApi && devicesApi.addEventListener) devicesApi.addEventListener('devicechange', onDevices);
  let permissionStatus = null;
  Promise.resolve()
    .then(() => view.navigator.permissions.query({ name: 'microphone' }))
    .then((status) => {
      if (destroyed) return;
      permissionStatus = status;
      status.addEventListener('change', onDevices);
    })
    .catch(() => {});
  const onHide = () => stopTest();
  view.addEventListener('pagehide', onHide);

  const loaded = refresh().catch(() => {});
  render();

  return {
    element: panel,
    /** Resolves when the device list and the saved choice are shown. */
    loaded,
    refresh,
    stopTest,
    /** For tests: what the panel shows. */
    state: () => ({ access, selected, saved, testing: Boolean(test && !test.error), level: test && test.state ? test.state : null }),
    destroy() {
      stopTest();
      destroyed = true;
      if (devicesApi && devicesApi.removeEventListener) devicesApi.removeEventListener('devicechange', onDevices);
      if (permissionStatus) permissionStatus.removeEventListener('change', onDevices);
      view.removeEventListener('pagehide', onHide);
      panel.remove();
    },
  };
}

export const MIC_CSS = `
.nw-mic[hidden], .nw-mic [hidden] { display: none !important; }
.nw-mic-compact { margin-bottom: 16px; }
.nw-mic .nw-mic-row { display: flex; align-items: center; gap: 8px; }
.nw-mic-select {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}
.nw-meter { position: relative; flex: none; width: 72px; height: 8px; border-radius: 4px; overflow: hidden; background: var(--line); }
.nw-meter-fill { position: absolute; inset: 0; background: var(--muted); transform: scaleX(0); transform-origin: left center; transition: transform 0.1s linear; }
.nw-meter[data-heard='true'] .nw-meter-fill { background: var(--ok); }
.nw-mic-test { flex: none; min-width: 84px; }
.nw-mic-status { margin-top: 6px !important; color: var(--muted); font-size: 13px; }
.nw-mic-status[data-tone='warn'] { color: var(--todo); }
.nw-mic-problem { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }
.nw-mic-problem-text { font-size: 13px; }
.nw-mic-intro { color: var(--muted); font-size: 13px; margin-bottom: 10px !important; }
.nw-mic:not(.nw-mic-compact) .nw-meter { width: 160px; }
.nw-mic:not(.nw-mic-compact) .nw-mic-select { max-width: 360px; }
@media (prefers-reduced-motion: reduce) { .nw-meter-fill { transition: none; } }
@media (forced-colors: active) {
  .nw-meter { border: 1px solid CanvasText; }
  .nw-meter-fill { background: Highlight !important; }
}
`;
