// The speech model picker (board #16611): one row per model with its
// measured accuracy and speed, its download size, whether it needs WebGPU,
// and a Download or Remove button. The picked model is remembered in this
// browser profile (prefs `offlineModel`) and named in the start view.
//
// Downloads run only on a click: a row's Download button, or the start
// view's download button, which opens this page with ?download=1 to install
// the live model and the picked one (board #16603: the tier chain when
// nothing is picked, with Parakeet for the live text, #16617). Runs on a
// visible page so it continues after the popup closes, and reports its
// progress in storage.session for the popup to show.
//
// A click on a row only marks it. Use this model saves the pick and goes
// back; Back goes back and leaves the saved pick as it was (board #16623).
// Back is the tab the popup was opened on (?from=<tab id>), where the popup
// opens again if the browser allows it; with no such tab, the recordings page.
import { MODELS } from '../../../offline-transcription/src/models.ts';
import { modelsToDownload, pickerRows, shownModel, usableChoice } from '../../../offline-transcription/src/picker.ts';
import { uiOfflineModel } from '../../../offline-transcription/src/status.ts';
import { FINAL_CHAIN, LIVE_CHAIN } from '../../../offline-transcription/src/tier.ts';
import { h, ratingBar } from '../../../recorder-ui/src/dom.js';
import { formatDownloadSize } from '../../../recorder-ui/src/providers.js';
import { DOWNLOAD_HEARTBEAT_MS, DOWNLOAD_KEY, modelStore, modelsForThisComputer, prefs, storedChoice, thisComputerTier } from './model-state.js';
import { guardThisPage } from './page-guard.js';

// A new build in the folder waits while this page is in use (board #17009).
guardThisPage();

const $ = (id) => document.getElementById(id);
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;
let running = false;
/** id -> ModelStatus, every model. */
const statuses = new Map();
let rows = [];
/** The saved pick (prefs `offlineModel`), and the row marked on this page. */
let choice = null;
let pending = null;
let tier = 'wasm';

async function report(ui) {
  await chrome.storage.session.set({ [DOWNLOAD_KEY]: { ...ui, at: Date.now() } });
}

function show(ui) {
  const progress = $('progress');
  progress.hidden = ui.state !== 'downloading';
  progress.value = ui.bytesTotal ? ui.bytesDone / ui.bytesTotal : 0;
  $('state').textContent = {
    ready: 'The picked speech model is on this computer.',
    downloading: `Downloading: ${megabytes(ui.bytesDone)} of ${megabytes(ui.bytesTotal)}.`,
    failed: 'The download did not finish.',
    missing: 'The picked speech model is not downloaded yet.',
  }[ui.state];
  $('problem').hidden = ui.state !== 'failed';
  $('problem').textContent =
    ui.state !== 'failed'
      ? ''
      : ui.reasonCode === 'model-corrupt'
        ? ui.reason
        : `Check your internet connection, then try again.${ui.reason ? ` Details: ${ui.reason}` : ''}`;
  $('again').hidden = ui.state !== 'failed' || running;
}

// Leaving the tab stops a download: Back and Use this model wait for it.
function showChoose() {
  $('chosen').textContent = `Picked: ${rows.find((row) => row.id === shownModel(pending, tier)).name}`;
  $('wait').hidden = !running;
  $('back').disabled = running;
  $('use').disabled = running;
}

const speedWords = (row) => {
  if (row.rtf === null) return 'Live: the text appears while you talk.';
  const seconds = Math.round(row.rtf * 60);
  return `${row.rtf} × the audio length: about ${seconds} s for each minute of audio (${row.rtfSetup}).`;
};

const rowState = (status) => {
  if (!status) return '';
  if (status.state === 'ready') return 'Downloaded';
  if (status.state === 'downloading') return `Downloading ${status.bytesTotal ? Math.floor((status.bytesDone / status.bytesTotal) * 100) : 0}%`;
  if (status.state === 'corrupt') return 'Damaged: download again';
  if (status.state === 'failed') return 'Download failed';
  return 'Not downloaded';
};

function renderRow(row) {
  const status = statuses.get(row.id);
  const picked = row.id === shownModel(pending, tier);
  const ready = status && status.state === 'ready';
  const busy = status && status.state === 'downloading';
  const accuracyTitle = `${row.accuracyPct}% of words right (word error rate ${row.werPct}%, ${row.werSetup})`;
  const speedTitle = row.rtf === null ? 'Live' : `${row.rtf} × audio length, ${row.rtfSetup}`;
  const native = row.werNativePct !== null && row.werNativePct !== row.werPct ? ` Run natively over the whole file: word error rate ${row.werNativePct}%.` : '';
  const radio = h(doc(), 'input', {
    type: 'radio',
    name: 'model',
    value: row.id,
    id: `model-${row.id}`,
    'aria-describedby': `model-why-${row.id}`,
    disabled: !row.runnable,
    on: { change: () => pick(row.id) },
  });
  radio.checked = picked;
  const action = ready
    ? h(doc(), 'button', { type: 'button', text: 'Remove', 'data-action': 'remove', 'aria-label': `Remove ${row.name}`, disabled: running, on: { click: () => remove(row.id) } })
    : h(doc(), 'button', {
        type: 'button',
        text: busy ? 'Downloading…' : 'Download',
        'data-action': 'download',
        'aria-label': `Download ${row.name}, ${formatDownloadSize(row.bytes)}`,
        disabled: running || !row.runnable,
        on: { click: () => download([row.id]) },
      });
  const why = row.runnable
    ? row.live
      ? 'Used for the live text while you record when Parakeet is not downloaded. Picked alone, the live text is the transcript: nothing runs after Stop.'
      : [
          row.id === LIVE_CHAIN[0] ? 'Once downloaded, it also makes the live text while you record.' : '',
          row.recommended ? 'This computer runs it first when no model is picked.' : '',
        ]
          .filter(Boolean)
          .join(' ')
    : row.reason;
  return h(
    doc(),
    'div',
    { class: `model${picked ? ' picked' : ''}${row.runnable ? '' : ' cannot'}`, 'data-model': row.id, 'data-state': status ? status.state : 'missing' },
    radio,
    h(
      doc(),
      'label',
      { for: `model-${row.id}` },
      h(doc(), 'span', { class: 'model-name', text: row.name }),
      row.recommended ? h(doc(), 'span', { class: 'model-tag', text: '(recommended)' }) : null,
      row.otherTake ? h(doc(), 'span', { class: 'model-tag', 'data-take': 'other', text: '(measured on a different take)' }) : null,
      h(doc(), 'span', { class: 'badge', 'data-tier': row.tier, text: row.tier === 'webgpu' ? 'Needs WebGPU' : 'WebAssembly' }),
      row.live ? h(doc(), 'span', { class: 'badge', text: 'Live' }) : null,
    ),
    h(
      doc(),
      'div',
      { class: 'model-bars' },
      h(doc(), 'span', { text: 'Accuracy' }),
      ratingBar(doc(), 'Accuracy', row.accuracySteps, accuracyTitle),
      h(doc(), 'span', { class: 'model-value', text: `${row.werPct}% WER` }),
      h(doc(), 'span', { text: 'Speed' }),
      ratingBar(doc(), 'Speed', row.speedSteps, speedTitle),
      h(doc(), 'span', { class: 'model-value', text: row.rtf === null ? 'live' : `${row.rtf}× audio` }),
    ),
    h(doc(), 'div', { class: 'model-actions' }, action, h(doc(), 'span', { class: 'model-state', text: `${rowState(status)} · ${formatDownloadSize(row.bytes)}` })),
    h(doc(), 'p', { class: 'model-why', id: `model-why-${row.id}`, text: why, hidden: !why }),
    h(
      doc(),
      'details',
      { class: 'model-more' },
      h(doc(), 'summary', { text: 'Measured' }),
      h(
        doc(),
        'dl',
        {},
        h(doc(), 'dt', { text: 'Accuracy' }),
        h(doc(), 'dd', { text: `${accuracyTitle}, on ${row.otherTake ?? 'one 113-second English reading passage'}.${native}` }),
        h(doc(), 'dt', { text: 'Speed' }),
        h(doc(), 'dd', { text: speedWords(row) }),
        h(doc(), 'dt', { text: 'Memory' }),
        h(doc(), 'dd', { text: row.peakMemoryMb === null ? 'Not measured.' : `About ${row.peakMemoryMb} MB (${row.memorySetup}).` }),
        h(doc(), 'dt', { text: 'Runs on' }),
        h(doc(), 'dd', { text: row.tier === 'webgpu' ? 'WebGPU: a graphics adapter with half-precision shaders.' : 'WebAssembly: any computer, no graphics adapter needed.' }),
        h(doc(), 'dt', { text: 'Download' }),
        h(doc(), 'dd', { text: `${formatDownloadSize(row.bytes)}, ${MODELS[row.id].files.length} files, each checked against a pinned SHA-256.` }),
        h(doc(), 'dt', { text: 'Source' }),
        h(doc(), 'dd', { text: `${row.source}.` }),
      ),
    ),
  );
}

const doc = () => document;

// Progress comes many times a second; the rows redraw at most every 250 ms.
let redraw = null;
function renderSoon() {
  if (!redraw) redraw = setTimeout(() => ((redraw = null), render()), 250);
}

function render() {
  const box = $('models');
  const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? `${focused.closest('[data-model]')?.dataset.model}|${focused.tagName}|${focused.dataset.action || ''}` : '';
  // A re-render keeps each open "Measured" open.
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.closest('[data-model]').dataset.model));
  box.replaceChildren(h(doc(), 'legend', { class: 'sr', text: 'Speech model' }), ...rows.map(renderRow));
  showChoose();
  for (const id of open) box.querySelector(`[data-model="${CSS.escape(id)}"] details`)?.setAttribute('open', '');
  if (focusKey) {
    const [id, tag, action] = focusKey.split('|');
    const row = box.querySelector(`[data-model="${CSS.escape(id)}"]`);
    const again = row && (tag === 'INPUT' ? row.querySelector('input') : row.querySelector(`button[data-action="${action}"]`) || row.querySelector('button'));
    if (again) again.focus();
  }
}

async function readAll() {
  for (const status of await modelStore().statusAll(rows.map((row) => row.id))) statuses.set(status.id, status);
}

async function pick(id) {
  pending = id;
  render();
  show(uiOfflineModel(await modelStore().statusAll(modelsToDownload(pending, tier))));
}

async function leave() {
  const from = Number(new URLSearchParams(location.search).get('from'));
  if (Number.isInteger(from) && from > 0) {
    // The service worker closes this tab; a reply means it could not go back.
    const reply = await chrome.runtime.sendMessage({ to: 'sw', cmd: 'leave-model-page', from }).catch(() => null);
    if (reply && reply.ok) return;
  }
  location.href = 'recordings.html';
}

async function use() {
  if (running) return;
  // The start view reads the choice from the same prefs.
  if (pending !== choice) await prefs().update({ offlineModel: pending });
  choice = pending;
  await leave();
}

async function back() {
  if (running) return;
  await leave();
}

async function remove(id) {
  if (running) return;
  await modelStore().remove(id);
  statuses.set(id, (await modelStore().statusAll([id]))[0]);
  render();
  const ui = uiOfflineModel(await modelStore().statusAll(await modelsForThisComputer()));
  show(ui);
  await report(ui);
}

/** Installs the given models, or the picked set (live + picked; nothing picked: the tier chain). */
async function download(only = null) {
  if (running) return;
  running = true;
  render();
  const store = modelStore();
  const wanted = await modelsForThisComputer();
  const ids = only || wanted;
  // What the popup shows: the picked set, plus a row downloaded on its own.
  // `final`: every model after Vosk (the first id), for the note the start
  // view shows once Start is possible (board #16603).
  const shown = [...new Set([...wanted, ...ids])];
  const current = () => {
    const all = shown.map((id) => statuses.get(id));
    return { ...uiOfflineModel(all), ...(all.length > 1 ? { final: uiOfflineModel(all.slice(1)) } : {}) };
  };
  // The popup treats a report older than three heartbeats as a closed page.
  const beat = setInterval(() => report(current()), DOWNLOAD_HEARTBEAT_MS);
  let failed = null;
  try {
    for (const id of ids) {
      if (statuses.get(id).state === 'ready') continue;
      const done = await store.install(id, {
        onProgress: (status) => {
          statuses.set(id, status);
          const ui = current();
          show(ui);
          report(ui);
          renderSoon();
        },
      });
      statuses.set(id, done);
    }
  } catch (err) {
    failed = err;
  } finally {
    clearInterval(beat);
    running = false;
  }
  await readAll();
  render();
  const final = uiOfflineModel(shown.map((id) => statuses.get(id)));
  const ui = failed && final.state !== 'ready' ? { ...final, state: 'failed', reason: final.reason || String((failed && failed.message) || failed) } : final;
  show(ui);
  await report(ui);
}

async function main() {
  tier = await thisComputerTier();
  rows = pickerRows(tier);
  choice = usableChoice(await storedChoice(), tier);
  pending = choice;
  $('machine').textContent =
    tier === 'webgpu'
      ? `This computer has WebGPU: every model can run here. With no model picked it runs ${rows.find((r) => r.recommended).name} first.`
      : `This computer has no WebGPU, so a model that needs it cannot run here. With no model picked it runs ${rows.find((r) => r.recommended).name} first, then ${FINAL_CHAIN[tier].slice(1).map((id) => rows.find((r) => r.id === id).name).join(', ')}.`;
  await readAll();
  render();
  show(uiOfflineModel(await modelStore().statusAll(await modelsForThisComputer())));
  if (new URLSearchParams(location.search).get('download') === '1') await download();
}

$('again').onclick = () => download();
$('use').onclick = () => use();
$('back').onclick = () => back();
globalThis.narwalModelPage = main().then(() => true);
