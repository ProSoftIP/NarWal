// The start surface, for an extension page (the toolbar popup): Start at
// the top with what blocks it (board #16601), the three readiness checks, the transcript choice with its plain-language
// explanation, and the first-use instructions with "Start now" and
// "Don't show instructions again" (board #16531 comment 108056).
//
// The page is built once and patched after that, so a status change (a
// download percentage, for one) never takes focus or typed text away.

import { adoptCss, h, ratingBar, replaceKeepingFocus, stateIcon } from './dom.js';
import { startFlow } from './flow.js';
import { INSTRUCTION_STEPS } from './gestures.js';
import { narwalLogo } from './logo.js';
import { IDLE_STATUS } from './port.js';
import { PRIVACY_NOTES, PROVIDERS, PURPOSE_FIELD, formatDownloadSize, providerById } from './providers.js';
import { readiness } from './readiness.js';
import { exportWaiting, improvingPercent } from './strip-model.js';
import { START_CSS } from './styles.js';
import { formatClock } from './transcript.js';
import { mountMicPanel } from './mic-panel.js';

const STATE_WORDS = { ok: 'Ready', todo: 'To do', busy: 'Working', blocked: 'Blocked', note: 'Note' };
const ACTIVE_PHASES = new Set(['starting', 'recording', 'stopping']);

/**
 * @param {Object} options
 * @param {HTMLElement} options.root
 * @param {import('./port.js').RecorderPort} options.port
 * @param {ReturnType<import('./prefs.js').createPrefs>} options.prefs
 * @param {() => void} [options.onStarted] called after the recorder accepted Start (a popup closes itself here)
 * @param {() => number} [options.now] monotonic milliseconds
 * @param {string[]} [options.choices] the transcript choices to offer, by id (default: all of PROVIDERS)
 * @param {{onFix: (state:'prompt'|'denied') => Promise<void>|void, media?: MediaDevices}} [options.microphone]
 *   the microphone picker and test bar under Start (board #16785); left out when not given
 * @param {{href: string, id?: string}} [options.library] Saved recordings as a secondary button at the
 *   top, beside the name (board #17006); left out when not given
 */
export function mountStartView({ root, port, prefs, onStarted, now, choices: offered, microphone, library }) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const clock = now || (() => view.performance.now());
  adoptCss(doc, START_CSS);

  /** @type {import('./port.js').RecorderStatus} */
  let status = IDLE_STATUS;
  const providers = offered ? PROVIDERS.filter((p) => offered.includes(p.id)) : PROVIDERS;
  // A stored choice that is not offered (any more) falls back to the first one.
  const offeredChoice = (id) => (providers.some((p) => p.id === id) ? id : providers[0].id);
  let transcription = providers[0].id;
  let flow = { view: 'setup', skipInstructions: false };
  let anchor = { elapsedMs: 0, at: clock() };
  let shownView = '';
  let destroyed = false;

  const fail = (error) => {
    errorLine.textContent = `That did not work: ${error && error.message ? error.message : 'unknown error'}`;
    errorLine.hidden = false;
  };
  const act = (run) => {
    errorLine.hidden = true;
    return Promise.resolve().then(run).catch(fail);
  };
  const button = (cls, label, onClick, extra = {}) =>
    h(doc, 'button', { class: `nw-btn ${cls}`.trim(), type: 'button', text: label, on: { click: onClick }, ...extra });

  // ---- setup view ---------------------------------------------------
  const banner = h(doc, 'div', { class: 'nw-banner', hidden: true });
  const checkList = h(doc, 'ul', { class: 'nw-checks' });

  /** @type {Map<string, {radio:HTMLInputElement, body:HTMLElement, size:HTMLElement, form:HTMLElement|null, input:HTMLInputElement|null, saved:HTMLElement|null, pick:HTMLElement|null}>} */
  const choiceParts = new Map();
  const choices = h(doc, 'fieldset', { class: 'nw-choices' }, h(doc, 'legend', {}, h(doc, 'h2', { class: 'nw-legend', text: 'Transcript' })));
  for (const provider of providers) {
    const radio = h(doc, 'input', {
      type: 'radio',
      name: 'nw-transcription',
      value: provider.id,
      id: `nw-choice-${provider.id}`,
      'aria-describedby': `nw-choice-body-${provider.id}`,
      on: {
        change: () => {
          transcription = provider.id;
          render();
          act(() => prefs.update({ transcription }));
        },
      },
    });
    const size = h(doc, 'p', { hidden: true });
    const body = h(
      doc,
      'div',
      { class: 'nw-choice-body', id: `nw-choice-body-${provider.id}` },
      h(doc, 'p', { text: provider.explain }),
      h(doc, 'p', { text: provider.setup }),
      size,
    );
    let form = null;
    let input = null;
    let saved = null;
    let pick = null;
    if (provider.needs === 'model') {
      // The speech model this choice uses, with its measured bars (board #16611).
      pick = h(doc, 'div', { class: 'nw-model-pick', hidden: true });
      body.append(pick);
    }
    if (provider.needs === 'key') {
      input = h(doc, 'input', {
        type: 'password',
        id: `nw-key-${provider.id}`,
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        'data-key': `key-${provider.id}`,
      });
      form = h(
        doc,
        'form',
        {
          class: 'nw-key',
          on: {
            submit: (event) => {
              event.preventDefault();
              const key = input.value.trim();
              if (!key) {
                fail(new Error('paste the key first'));
                input.focus();
                return;
              }
              // The key leaves this page here and is not kept in it.
              input.value = '';
              act(() => port.saveKey(provider.id, key));
            },
          },
        },
        h(doc, 'label', { for: `nw-key-${provider.id}`, text: provider.keyLabel }),
        h(doc, 'div', { class: 'nw-key-row' }, input, h(doc, 'button', { class: 'nw-btn', type: 'submit', text: 'Save key' })),
      );
      saved = h(
        doc,
        'div',
        { class: 'nw-key-saved', hidden: true },
        h(doc, 'span', { text: 'Key saved in this browser.' }),
        button('', 'Remove key', () => act(() => port.removeKey(provider.id)), {
          'aria-label': `Remove ${provider.label} key`,
          'data-key': `remove-${provider.id}`,
        }),
      );
      body.append(form, saved);
    }
    choiceParts.set(provider.id, { radio, body, size, form, input, saved, pick });
    choices.append(
      h(
        doc,
        'div',
        { class: 'nw-choice' },
        h(
          doc,
          'label',
          { class: 'nw-choice-head', for: radio.id },
          radio,
          h(doc, 'span', { class: 'nw-choice-label', text: provider.label }),
          h(doc, 'span', { class: 'nw-tag', text: provider.tag }),
        ),
        body,
      ),
    );
  }

  // ---- hidden areas (board #16592) ------------------------------------
  // Only when the port can pick: the user hides parts of the page before
  // Start. The port opens the picker in the page (the popup closes).
  const canPick = typeof port.pickRegions === 'function';
  const hideText = h(doc, 'p', { class: 'nw-hide-text' });
  const hideButton = button('', 'Hide areas', () => act(() => port.pickRegions()), { 'data-key': 'hide-areas' });
  const hideSection = h(
    doc,
    'section',
    { class: 'nw-section', hidden: true, 'aria-labelledby': 'nw-hide-title' },
    h(doc, 'h2', { id: 'nw-hide-title', text: 'Hidden areas' }),
    h(doc, 'div', { class: 'nw-hide' }, hideText, hideButton),
  );

  const purposeCount = h(doc, 'p', { class: 'nw-purpose-count', text: `0 / ${PURPOSE_FIELD.maxLength}` });
  const purposeInput = h(doc, 'textarea', {
    id: 'nw-purpose',
    rows: '2',
    maxlength: String(PURPOSE_FIELD.maxLength),
    placeholder: PURPOSE_FIELD.placeholder,
    'aria-describedby': 'nw-purpose-hint',
    on: { input: () => (purposeCount.textContent = `${purposeInput.value.length} / ${PURPOSE_FIELD.maxLength}`) },
  });
  const purpose = h(
    doc,
    'section',
    { class: 'nw-section nw-purpose' },
    h(doc, 'label', { for: 'nw-purpose', text: PURPOSE_FIELD.label }),
    purposeInput,
    purposeCount,
    h(doc, 'p', { class: 'nw-purpose-hint', id: 'nw-purpose-hint', text: PURPOSE_FIELD.hint }),
  );

  const startButton = button('nw-primary', 'Start recording', () => onStartPressed(), { 'aria-describedby': 'nw-why', 'data-key': 'start' });
  const why = h(doc, 'p', { class: 'nw-why', id: 'nw-why', role: 'status', 'aria-live': 'polite' });
  const errorLine = h(doc, 'p', { class: 'nw-error', role: 'alert', hidden: true });
  // The microphone picker and test bar sit right under Start (board #16785).
  // Its blocked and not-asked states are the Microphone check below, so the
  // one line shows only when the microphone can be used.
  const micSlot = h(doc, 'div', { class: 'nw-mic-slot', hidden: !microphone });
  const micPanel = microphone
    ? mountMicPanel({ root: micSlot, prefs, compact: true, onFix: microphone.onFix, media: microphone.media, now: clock })
    : null;
  // Start is the top control (board #16601); the reason it is blocked shows
  // right under it, and the checks follow.
  const setup = h(
    doc,
    'div',
    { class: 'nw-setup' },
    h(doc, 'div', { class: 'nw-go' }, startButton, why),
    micSlot,
    banner,
    h(doc, 'section', { class: 'nw-section' }, h(doc, 'h2', { text: 'Before you start' }), checkList),
    h(doc, 'section', { class: 'nw-section' }, choices),
    hideSection,
    purpose,
    h(
      doc,
      'section',
      { class: 'nw-section' },
      h(doc, 'ul', { class: 'nw-notes' }, ...PRIVACY_NOTES.map((text) => h(doc, 'li', { text }))),
    ),
    h(doc, 'div', { class: 'nw-actions' }, button('nw-quiet', 'How recording works', () => dispatch({ type: 'show-instructions' }))),
  );

  // ---- instructions view --------------------------------------------
  const instructionsTitle = h(doc, 'h2', { text: 'How recording works', tabindex: '-1' });
  const skipBox = h(doc, 'input', {
    type: 'checkbox',
    id: 'nw-skip',
    on: { change: () => dispatch({ type: 'set-skip', value: skipBox.checked }) },
  });
  const startNow = button('nw-primary', 'Start now', () => dispatch({ type: 'start-now' }), { 'aria-describedby': 'nw-why-now' });
  const whyNow = h(doc, 'p', { class: 'nw-why', id: 'nw-why-now' });
  const instructions = h(
    doc,
    'div',
    { class: 'nw-instructions', hidden: true },
    instructionsTitle,
    h(doc, 'div', { class: 'nw-go' }, startNow, whyNow),
    h(
      doc,
      'ol',
      { class: 'nw-steps' },
      ...INSTRUCTION_STEPS.map((step) =>
        h(
          doc,
          'li',
          { class: 'nw-step', 'data-step': step.id },
          h(doc, 'span', { class: 'nw-step-title', text: step.title }),
          h(doc, 'span', { class: 'nw-step-body', text: step.body }),
        ),
      ),
    ),
    h(doc, 'label', { class: 'nw-skip', for: 'nw-skip' }, skipBox, h(doc, 'span', { text: "Don't show instructions again" })),
    h(doc, 'div', { class: 'nw-actions' }, button('', 'Back', () => dispatch({ type: 'back' }))),
  );

  // ---- recording view -----------------------------------------------
  const activeTitle = h(doc, 'h2', { tabindex: '-1' });
  const activeTime = h(doc, 'div', { class: 'nw-active-time', role: 'timer', 'aria-label': 'Recording time' });
  const activeText = h(doc, 'p');
  const stopButton = button('nw-danger', 'Stop recording', () => {
    if (status.phase === 'recording') act(() => port.stop());
  });
  const active = h(doc, 'div', { class: 'nw-active', hidden: true }, activeTitle, activeTime, activeText, stopButton);

  const main = h(
    doc,
    'main',
    { class: 'nw-start', lang: 'en' },
    h(
      doc,
      'header',
      { class: 'nw-head' },
      narwalLogo(doc, 32),
      h(
        doc,
        'div',
        { class: 'nw-brand' },
        h(doc, 'h1', { text: 'NarWal' }),
        h(doc, 'span', { class: 'nw-tagline', text: 'Record a narrated walkthrough of this tab' }),
      ),
      library && h(doc, 'a', { class: 'nw-btn nw-head-link', href: library.href, target: '_blank', id: library.id, text: 'Saved recordings' }),
    ),
    setup,
    instructions,
    active,
    errorLine,
  );
  root.replaceChildren(main);

  // ---- behaviour ----------------------------------------------------
  const ready = () => readiness(status, transcription);

  function runCheckAction(id) {
    if (id === 'request-mic') return act(() => port.requestMic());
    if (id === 'refresh') return act(() => port.refresh());
    if (id === 'download-model') return act(() => port.downloadModel());
    if (id === 'pick-regions' && canPick) return act(() => port.pickRegions());
    if (id === 'focus-key') {
      const part = choiceParts.get(transcription);
      if (part && part.input) part.input.focus();
    }
    return undefined;
  }

  function onStartPressed() {
    const state = ready();
    if (!state.canStart) {
      // Start is not a dead end: take the user to the thing to fix.
      const blocker = state.firstBlocker;
      const target = blocker && checkList.querySelector(`[data-key="check-${blocker.id}"]`);
      if (blocker && blocker.action && blocker.action.id === 'focus-key') runCheckAction('focus-key');
      else if (target) target.focus();
      return;
    }
    dispatch({ type: 'start-pressed' });
  }

  function dispatch(event) {
    const result = startFlow(flow, event, { canStart: ready().canStart });
    flow = result.state;
    render();
    for (const effect of result.effects) {
      if (effect.type === 'save-skip') act(() => prefs.update({ skipInstructions: effect.value }));
      if (effect.type === 'start') {
        // The test bar lets go of the microphone before the recording opens it.
        if (micPanel) micPanel.stopTest();
        act(async () => {
          await port.start({ transcription, purpose: purposeInput.value.trim() });
          if (onStarted) onStarted();
        });
      }
    }
  }

  function renderChecks(state) {
    replaceKeepingFocus(
      checkList,
      state.checks.map((check) =>
        h(
          doc,
          'li',
          { class: `nw-check nw-check-${check.state}`, 'data-check': check.id, 'data-state': check.state },
          stateIcon(doc, check.state),
          h(
            doc,
            'span',
            { class: 'nw-check-title' },
            h(doc, 'span', { class: 'nw-sr', text: `${STATE_WORDS[check.state]}: ` }),
            check.title,
          ),
          check.detail ? h(doc, 'span', { class: 'nw-check-detail', text: check.detail }) : null,
          check.progress !== undefined
            ? h(doc, 'progress', { class: 'nw-progress', max: '1', value: String(check.progress), 'aria-label': 'Speech model download' })
            : null,
          check.action
            ? button('nw-check-action', check.action.label, () => runCheckAction(check.action.id), { 'data-key': `check-${check.id}` })
            : null,
        ),
      ),
    );
  }

  function renderChoices() {
    for (const provider of providers) {
      const part = choiceParts.get(provider.id);
      const selected = provider.id === transcription;
      part.radio.checked = selected;
      part.body.hidden = !selected;
      if (provider.needs === 'model') {
        const size = formatDownloadSize(status.model && status.model.bytesTotal);
        part.size.hidden = !size;
        part.size.textContent = size ? `The download is ${size}.` : '';
        renderModelPick(part.pick, status.model && status.model.choice);
      }
      if (part.form) {
        const hasKey = Boolean(status.keys && status.keys[provider.id]);
        // Do not hide a field the user is typing in.
        const typing = doc.activeElement === part.input && part.input.value !== '';
        part.form.hidden = hasKey && !typing;
        part.saved.hidden = !hasKey;
      }
    }
  }

  function renderModelPick(pick, choice) {
    pick.hidden = !choice;
    if (!choice) return;
    const key = `${choice.id}|${choice.accuracySteps}|${choice.speedSteps}|${choice.recommended}`;
    if (pick.dataset.for === key) return;
    pick.dataset.for = key;
    pick.dataset.model = choice.id;
    replaceKeepingFocus(pick, [
      h(doc, 'span', { class: 'nw-model-name', text: `Model: ${choice.name}${choice.recommended ? ' (recommended)' : ''}` }),
      h(doc, 'span', { text: 'Accuracy' }),
      ratingBar(doc, 'Accuracy', choice.accuracySteps),
      h(doc, 'span', { text: 'Speed' }),
      ratingBar(doc, 'Speed', choice.speedSteps),
      port.chooseModel ? button('', 'Choose model', () => act(() => port.chooseModel()), { 'data-key': 'choose-model' }) : null,
    ]);
  }

  function renderHidden() {
    hideSection.hidden = !canPick || !(status.tab && status.tab.ok);
    if (hideSection.hidden) return;
    const n = status.hidden || 0;
    const lost = status.hiddenLost || 0;
    const text = lost
      ? `${lost === 1 ? '1 hidden area' : `${lost} hidden areas`} could not be found on the page. Pick the areas to hide again before you start.`
      : n === 0
        ? 'Nothing hidden. Text shown on the page is recorded. To leave out an area, such as account details, hide it before you start.'
        : `${n === 1 ? '1 area' : `${n} areas`} of this page will be left out of the recording.`;
    if (hideText.textContent !== text) hideText.textContent = text;
    const label = n === 0 && !lost ? 'Hide areas' : 'Change hidden areas';
    if (hideButton.textContent !== label) hideButton.textContent = label;
  }

  function renderBanner() {
    const done = status.phase === 'saved' || status.phase === 'failed';
    banner.hidden = !done;
    if (!done) return;
    const job = status.phase === 'saved' && status.transcription === 'offline' ? status.afterTranscript : null;
    const improving = job && job.state === 'improving' ? ` Improving the transcript on this computer (${improvingPercent(job)}%)…` : '';
    const text =
      status.phase === 'saved'
        ? `Your last recording is saved on this computer.${improving}`
        : `The last recording stopped: ${status.error || 'something went wrong'}.`;
    // Export the recording just saved at once (board #16602). With a transcript
    // on its way (#16588, #16603) the press is kept: the recordings page it
    // opens exports when the transcript is ready, and says so (board #16622).
    const canExport = status.phase === 'saved' && Boolean(status.recordingId);
    const waiting = canExport && exportWaiting(status);
    const key = `${status.phase}|${status.recordingId || ''}|${status.error || ''}|${waiting}|${improving}`;
    if (banner.dataset.for === key) return;
    banner.dataset.for = key;
    const id = status.recordingId;
    banner.replaceChildren(
      h(doc, 'span', { class: 'nw-banner-text', text }),
      canExport
        ? button('nw-primary', waiting ? 'Export when the transcript is ready' : 'Export', () => act(() => port.exportRecording(id)), { 'data-key': 'export' })
        : null,
      id ? button('', 'Open recording', () => act(() => port.openRecording(id))) : null,
    );
  }

  function renderActive() {
    const provider = providerById(status.transcription);
    activeTitle.textContent =
      status.phase === 'stopping' ? 'Saving the recording' : status.phase === 'starting' ? 'Starting' : status.elsewhere ? 'Recording another tab' : 'Recording this tab';
    activeTime.textContent = formatClock(elapsed());
    const mic = status.phase === 'recording' && status.micLive === false ? ' Your microphone is not being recorded; the page still is.' : '';
    activeText.textContent =
      status.phase === 'stopping'
        ? 'The recording is being saved on this computer.'
        : `The bar at the bottom of the page has the same Stop button${provider && provider.timing === 'live' ? ' and the transcript' : ''}.${mic}`;
    stopButton.hidden = status.phase === 'starting';
    stopButton.setAttribute('aria-disabled', String(status.phase === 'stopping'));
  }

  const elapsed = () => (status.phase === 'recording' ? anchor.elapsedMs + (clock() - anchor.at) : anchor.elapsedMs);

  function render() {
    if (destroyed) return;
    const state = ready();
    const next = ACTIVE_PHASES.has(status.phase) ? 'active' : flow.view;
    setup.hidden = next !== 'setup';
    instructions.hidden = next !== 'instructions';
    active.hidden = next !== 'active';

    renderBanner();
    renderChecks(state);
    renderChoices();
    renderHidden();
    const reason = state.canStart ? '' : state.firstBlocker ? `${state.firstBlocker.title}.` : '';
    startButton.setAttribute('aria-disabled', String(!state.canStart));
    startNow.setAttribute('aria-disabled', String(!state.canStart));
    if (why.textContent !== reason) why.textContent = reason;
    whyNow.textContent = reason;
    skipBox.checked = flow.skipInstructions;
    if (next === 'active') renderActive();

    if (next !== shownView) {
      const first = shownView === '';
      shownView = next;
      // Move focus with the view, so keyboard and screen reader users land in it.
      if (!first) {
        if (next === 'instructions') instructionsTitle.focus();
        else if (next === 'active') activeTitle.focus();
        else startButton.focus();
      }
    }
  }

  const ticker = view.setInterval(() => {
    if (status.phase === 'recording' && !active.hidden) activeTime.textContent = formatClock(elapsed());
  }, 500);

  const unsubscribe = port.subscribe((event) => {
    if (event.type !== 'status') return;
    status = event.status;
    anchor = { elapsedMs: status.elapsedMs || 0, at: clock() };
    render();
  });

  const loaded = Promise.all([port.getStatus(), prefs.get()])
    .then(([first, stored]) => {
      if (destroyed) return;
      status = first;
      anchor = { elapsedMs: status.elapsedMs || 0, at: clock() };
      transcription = offeredChoice(stored.transcription);
      flow = { view: 'setup', skipInstructions: stored.skipInstructions };
      render();
    })
    .catch(fail);
  render();

  return {
    /** Resolves when the first status and the stored choices are shown. */
    loaded,
    /** The microphone panel, when there is one. */
    microphone: micPanel,
    destroy() {
      destroyed = true;
      if (micPanel) micPanel.destroy();
      unsubscribe();
      view.clearInterval(ticker);
      root.replaceChildren();
    },
  };
}
