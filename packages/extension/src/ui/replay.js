// Board #16549: replay a NarWal bundle with its page, narration, transcript and
// markers in step. Opens recordings from the local library (?id=<library id>)
// or a .narwal.zip file the user picks.
//
// Board #16589: an opened file is replayed first and saved only when the user
// presses Save. Saving goes through the library's import (packages/library
// importBundle), which checks the whole archive again as untrusted and stores
// nothing when a check fails. A saved bundle is a library recording: it is
// listed in Saved recordings and can be corrected, annotated and exported.
//
// Board #16550: a library recording can be corrected and annotated here.
// Corrections, notes and the choice of transcript are added as layers
// (packages/edits); the captured page, audio and transcript files are never
// changed, so replay stays on the captured timeline.
//
// Board #27484: a file someone sent opens from the Open a shared recording
// tile, the header link, a drop anywhere on the page, or Saved recordings,
// which hands the picked file over (src/ui/shared-file.js, ?shared=1).
//
// Board #16783: laid out as tiles (app/tiles.css). A tile with nothing in it
// (no notes to show or add, nothing missing) is not drawn.
//
// Every bundle is untrusted: it is validated in full before anything is drawn,
// all its text is set with textContent, the page is rebuilt by rrweb in a frame
// sandboxed without scripts, and this page's content security policy blocks
// every network load (packages/replay/src/sandbox.ts).
import { Replayer } from 'rrweb';
import { bundleValidator, deriveAgentFiles } from '../../../bundle/src/index.ts';
import { HIDDEN_STYLE_RULES, markHiddenAreas } from '../shared/hidden-regions.js';
import { IdbLibraryStorage, RecordingLibrary, sha256Hex, unpackBundle } from '../../../library/src/index.ts';
import { ReplayPlayer, clock, describeGap, describeWindow, listedGaps, loadReplay } from '../../../replay/src/index.ts';
import { addNote, correctSegment, editRecording, readLayer, resolveRetranscription, retractEdit, setPurpose, waitingRevisions } from '../../../edits/src/index.ts';
import { countPurpose } from '../shared/purpose.js';
import { drawIcons } from './icons.js';
import { onFileDrop, takeHandedOver } from './shared-file.js';
import { guardThisPage } from './page-guard.js';

// A new build in the folder waits while this page is in use (board #17009).
guardThisPage();

const $ = (id) => document.getElementById(id);
let player = null;
let audioUrl = null;
/** Set when the open recording is in the library: only those can be edited. */
let editing = null;
/** The library, once it has opened. Saving an opened file needs it. */
let library = null;
/** Set when the open recording is a picked file that is not saved: its archive bytes and file name. */
let opened = null;

/** Applies one edit to the open recording and replays it again at the same time. */
async function change(build) {
  if (!editing) return;
  showError('');
  try {
    const t = player?.time ?? 0;
    const { files } = await editRecording(editing.library, editing.id, build);
    await replay(files);
    player?.seek(t);
  } catch (err) {
    showError(err?.message ?? String(err));
  }
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value ?? '';
  if (className) node.className = className;
  return node;
}

async function openLibrary() {
  const storage = await IdbLibraryStorage.open();
  return RecordingLibrary.open({ storage, productVersion: chrome.runtime.getManifest().version, validate: bundleValidator, derive: deriveAgentFiles });
}

/**
 * The library recording this file already is, in the list or the trash: the
 * same bundle contents, or saved from this same file and edited since.
 */
async function findSaved(bytes, contentSha256) {
  if (!library) return null;
  const archiveSha256 = await sha256Hex(bytes);
  const all = [...(await library.list()), ...(await library.listTrash())];
  const found = all.find((r) => r.contentSha256 === contentSha256 || (r.origin.kind === 'imported' && r.origin.archiveSha256 === archiveSha256));
  return found ? { id: found.id, inTrash: found.deletedAt !== null } : null;
}

const openSaved = (id) => {
  location.search = `?id=${encodeURIComponent(id)}`;
};

/**
 * The offer under the title of an opened file: save it, or go to the copy
 * that is already saved. `existing` is that copy ({ id, inTrash }), if any.
 */
function renderKeep(existing = null) {
  const box = $('keep');
  box.replaceChildren();
  box.hidden = !opened || !library;
  if (box.hidden) return;
  const act = (label, run) => {
    const b = text('button', label);
    b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      showError('');
      try {
        await run();
      } catch (err) {
        if (err?.code === 'duplicate-import') renderKeep({ id: err.detail.id, inTrash: err.detail.inTrash });
        else {
          showError(err?.message ?? String(err));
          b.disabled = false;
        }
      }
    };
    return b;
  };
  if (!existing) {
    box.append(
      text('span', 'This file is open for viewing only. Save it to keep it on this computer, correct the transcript and add notes.'),
      act('Save to Saved recordings', async () => {
        const { recording } = await library.importBundle(opened.bytes, { fileName: opened.fileName });
        openSaved(recording.id);
      }),
    );
  } else if (existing.inTrash) {
    box.append(
      text('span', 'This recording is in the trash on this computer.'),
      act('Restore it and open it', async () => {
        await library.restore(existing.id);
        openSaved(existing.id);
      }),
    );
  } else {
    box.append(
      text('span', 'This recording is already in Saved recordings. Open the saved copy to correct the transcript and add notes.'),
      act('Open the saved copy', async () => openSaved(existing.id)),
    );
  }
}

async function renderLibrary(library) {
  const body = $('list').querySelector('tbody');
  body.replaceChildren();
  const recordings = await library.list();
  $('library-empty').hidden = recordings.length > 0;
  for (const r of recordings) {
    const tr = document.createElement('tr');
    tr.append(
      text('td', new Date(r.createdAt).toLocaleString()),
      text('td', r.title),
      text('td', clock(r.durationMs)),
    );
    const open = document.createElement('td');
    const b = text('button', 'Replay', 'btn');
    b.type = 'button';
    b.onclick = () => openSaved(r.id);
    open.append(b);
    tr.append(open);
    body.append(tr);
  }
}

function notices(model, warnings) {
  const out = [];
  let missing = 0;
  const origins = new Set();
  for (const page of model.pages.values()) {
    missing += page.missing.count;
    for (const o of page.missing.origins) origins.add(o);
  }
  if (missing > 0) {
    const from = [...origins].slice(0, 5).join(', ');
    out.push(`${missing} image, style, font or frame file${missing === 1 ? ' is' : 's are'} not loaded: replay never contacts the recorded site${from ? ` (${from})` : ''}.`);
  }
  if (model.frames.length > 0) {
    out.push(`${model.frames.length} embedded frame${model.frames.length === 1 ? ' is' : 's are'} not drawn inside the page.`);
  }
  if (!model.audio) out.push('This recording has no narration.');
  if (!model.transcript) out.push('This recording has no transcript.');
  else if (model.transcript.approximate) out.push('Some transcript times are approximate.');
  if (warnings.length > 0) out.push(`The bundle has ${warnings.length} warning${warnings.length === 1 ? '' : 's'}; it still replays.`);
  return out;
}

function renderTimeline(model) {
  const line = $('timeline');
  line.replaceChildren();
  const pct = (ms) => `${(ms / model.durationMs) * 100}%`;
  for (const gap of model.gaps) {
    const band = document.createElement('div');
    band.className = 'band';
    band.dataset.effect = gap.effect;
    band.title = `${clock(gap.startMs)}–${clock(gap.endMs)} ${describeGap(gap)}`;
    band.style.left = pct(gap.startMs);
    band.style.width = pct(Math.max(gap.endMs - gap.startMs, model.durationMs / 500));
    line.append(band);
  }
  const head = document.createElement('div');
  head.className = 'playhead';
  line.append(head);
  // Which window was in front, one band per stretch, numbered (board #16754).
  const strip = $('windows');
  strip.replaceChildren();
  strip.hidden = model.windows.length === 0;
  for (const f of model.focus) {
    const w = model.windows.find((x) => x.key === f.window);
    const band = text('div', String(w?.number ?? ''), 'band');
    band.dataset.window = String(w?.number ?? '');
    band.title = `${clock(f.fromMs)}–${clock(f.toMs)} ${describeWindow(model.windows, f.window)}`;
    band.style.left = pct(f.fromMs);
    band.style.width = pct(f.toMs - f.fromMs);
    strip.append(band);
  }
  line.onclick = strip.onclick = (event) => {
    const box = line.getBoundingClientRect();
    player.seek(((event.clientX - box.left) / box.width) * model.durationMs);
  };
}

function renderTranscript(model) {
  const list = $('transcript');
  list.replaceChildren();
  $('transcript-source').textContent = model.transcript ? `${model.transcript.provider} · ${model.transcript.model}` : 'none';
  model.utterances.forEach((u, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.index = String(i);
    b.append(text('span', `${u.approximate ? '≈' : ''}${clock(u.startMs)}`, u.approximate ? 'when approx' : 'when'), text('span', u.text));
    if (u.corrected && u.heard !== undefined) b.title = `Heard: ${u.heard}`;
    if (u.corrected) b.append(text('span', ' (edited)', 'edited'));
    b.onclick = () => player.seek(u.startMs);
    li.append(b);
    if (editing) li.append(editButton(li, u));
    list.append(li);
  });
  const notes = $('notes');
  notes.replaceChildren(...model.notes.map((n) => {
    const li = document.createElement('li');
    const b = text('button', `${clock(n.atMs)}${n.endMs === null ? '' : `–${clock(n.endMs)}`} ${n.text}`);
    b.type = 'button';
    b.onclick = () => player.seek(n.atMs);
    li.append(b);
    if (editing) {
      const remove = text('button', 'Remove', 'small');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove note at ${clock(n.atMs)}`);
      remove.onclick = () => change((layer, at) => retractEdit(layer, n.id, at));
      li.append(remove);
    }
    return li;
  }));
  notes.hidden = model.notes.length === 0;
  $('note-form').hidden = !editing;
  $('notes-tile').hidden = model.notes.length === 0 && !editing;
}

/** Turns one utterance into a text box. Saving compares it with what was heard (packages/edits correctSegment). */
function editButton(li, u) {
  const edit = text('button', 'Edit', 'small');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit text at ${clock(u.startMs)}`);
  edit.onclick = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = u.text;
    input.maxLength = 2000;
    input.setAttribute('aria-label', `Text at ${clock(u.startMs)}`);
    const save = text('button', 'Save', 'small');
    save.type = 'button';
    save.onclick = () => change((layer, at) => correctSegment(layer, { revisionId: u.revisionId, segmentId: u.segmentId, text: input.value }, at));
    const cancel = text('button', 'Cancel', 'small');
    cancel.type = 'button';
    cancel.onclick = () => renderTranscript(player.model);
    input.onkeydown = (event) => {
      if (event.key === 'Enter') save.click();
      if (event.key === 'Escape') cancel.click();
    };
    const form = document.createElement('div');
    form.className = 'edit-row';
    form.append(input, save, cancel);
    if (u.heard !== undefined) form.append(text('div', `Heard: ${u.heard}`, 'note'));
    li.replaceChildren(form);
    input.focus();
  };
  return edit;
}

/**
 * A newer transcript the user has not switched to, because it would change
 * words they corrected (or it is missing audio). Each conflict needs a choice.
 */
function renderWaiting(files) {
  const box = $('waiting');
  box.replaceChildren();
  const waiting = editing ? waitingRevisions(readLayer(files)) : [];
  box.hidden = waiting.length === 0;
  for (const w of waiting) {
    const section = document.createElement('div');
    section.className = 'waiting-revision';
    const why = w.conflicts.length > 0
      ? `${w.conflicts.length} of your corrections ${w.conflicts.length === 1 ? 'is' : 'are'} on words it hears differently`
      : 'It is missing some of the audio';
    section.append(text('p', `A newer transcript (${w.provider}, ${w.model}) is not shown yet. ${why}.`));
    const choices = new Map();
    for (const c of w.conflicts) {
      const row = document.createElement('div');
      row.className = 'conflict';
      const heard = c.originalText ? `"${c.originalText}"` : 'the whole line';
      const now = c.revisionText ? `"${c.revisionText}"` : 'nothing';
      row.append(text('p', `You wrote "${c.correction.text}" for ${heard}. The newer transcript says ${now}.`));
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Choice for "${c.correction.text}"`);
      const keepable = c.reason === 'text-changed' && c.target !== undefined;
      for (const [value, label] of [['', 'Choose…'], ['keep-mine', 'Keep my text'], ['take-new', 'Use the newer words']]) {
        const option = text('option', label);
        option.value = value;
        if (value === 'keep-mine' && !keepable) option.disabled = true;
        select.append(option);
      }
      choices.set(c.correction.id, select);
      row.append(select);
      section.append(row);
    }
    const go = text('button', 'Switch to the newer transcript');
    go.type = 'button';
    go.onclick = () => {
      const decisions = Object.fromEntries([...choices].map(([id, select]) => [id, select.value]).filter(([, v]) => v !== ''));
      change((layer, at) => resolveRetranscription(layer, w.revisionId, decisions, at));
    };
    section.append(go);
    box.append(section);
  }
}

$('add-note').onclick = () => {
  const input = $('note-text');
  if (!player) return;
  const atMs = Math.round(player.time);
  change((layer, at) => addNote(layer, { atMs, text: input.value }, at)).then(() => {
    if ($('error').hidden) input.value = '';
  });
};

/** What the recording is for (manifest.purpose, board #16594); editable when it is in the library. */
function renderPurpose(files) {
  const purpose = readLayer(files).purpose;
  $('purpose-text').textContent = purpose ? `What it is for: ${purpose}` : 'No purpose given.';
  $('purpose-input').value = purpose ?? '';
  purposeCount();
  $('purpose-form').hidden = !editing;
}

const purposeCount = countPurpose($('purpose-input'), $('purpose-count'));

$('save-purpose').onclick = () => change((layer) => setPurpose(layer, $('purpose-input').value));

function renderGaps(model) {
  const body = $('gaps').querySelector('tbody');
  body.replaceChildren();
  const gaps = listedGaps(model);
  for (const gap of gaps) {
    const tr = document.createElement('tr');
    tr.append(text('td', clock(gap.startMs)), text('td', clock(gap.endMs)), text('td', describeGap(gap)));
    tr.onclick = () => player.seek(gap.startMs);
    body.append(tr);
  }
  $('gaps-tile').hidden = gaps.length === 0;
}

let lastUtterance = -2;
function onUpdate(state) {
  $('clock').textContent = clock(state.t);
  const seek = $('seek');
  if (document.activeElement !== seek) seek.value = String(Math.round(state.t));
  const head = $('timeline').querySelector('.playhead');
  if (head && player) head.style.left = `${(state.t / player.model.durationMs) * 100}%`;
  $('add-note').textContent = `Add note at ${clock(state.t)}`;
  const shownWindow = player ? describeWindow(player.model.windows, state.window) : '';
  if ($('window').textContent !== shownWindow) $('window').textContent = shownWindow;
  $('window').hidden = !shownWindow;
  if (state.utterance !== lastUtterance) {
    lastUtterance = state.utterance;
    for (const b of $('transcript').querySelectorAll('button[data-index]')) {
      const active = Number(b.dataset.index) === state.utterance;
      b.setAttribute('aria-current', String(active));
      if (active) b.scrollIntoView({ block: 'nearest' });
    }
  }
  $('play').textContent = player?.playing ? 'Pause' : 'Play';
}

// rrweb calls play() on recorded <video>/<audio> without handling the promise.
// Their files are never loaded (no network), so these refusals are expected.
function ignoreMediaRefusal(event) {
  const name = event.reason?.name;
  if (name === 'AbortError' || name === 'NotSupportedError') event.preventDefault();
}

/** rrweb in its default sandbox (allow-same-origin only). Never UNSAFE_replayCanvas. */
function createReplayer(events, root) {
  // Areas hidden before recording show as striped boxes, not blank page (board #16592).
  const replayer = new Replayer(markHiddenAreas(events), {
    root,
    insertStyleRules: HIDDEN_STYLE_RULES,
    speed: 1,
    skipInactive: false,
    mouseTail: false,
    showWarning: false,
    showDebug: false,
    triggerFocus: false,
    pauseAnimation: true,
    UNSAFE_replayCanvas: false,
  });
  // Each rebuild opens the frame's document again, which drops its listeners.
  const listen = () => replayer.iframe.contentWindow?.addEventListener('unhandledrejection', ignoreMediaRefusal);
  replayer.on('fullsnapshot-rebuilded', listen);
  listen();
  return replayer;
}

async function replay(files) {
  showError('');
  const { model, audio, warnings } = await loadReplay(files);
  player?.destroy();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  const audioEl = $('audio');
  if (audio && model.audio) {
    audioUrl = URL.createObjectURL(new Blob([audio], { type: model.audio.mediaType }));
    audioEl.src = audioUrl;
  } else audioEl.removeAttribute('src');

  $('library').hidden = true;
  $('open-shared').hidden = true;
  $('player').hidden = false;
  $('title').textContent = model.title;
  $('facts').replaceChildren(
    text('b', clock(model.durationMs)),
    ` long · ${model.utterances.length} transcript line${model.utterances.length === 1 ? '' : 's'} · ${model.notes.length} note${model.notes.length === 1 ? '' : 's'}`,
  );
  renderPurpose(files);
  $('notices').replaceChildren(...notices(model, warnings).map((n) => text('p', n, 'note')));
  $('seek').max = String(model.durationMs);
  renderTimeline(model);
  renderTranscript(model);
  renderWaiting(files);
  renderGaps(model);
  lastUtterance = -2;
  player = new ReplayPlayer({ model, stage: $('stage'), audio: audio && model.audio ? audioEl : null, createReplayer, onUpdate });
  onUpdate(player.state());
  if (NARWAL_TEST) globalThis.__narwalReplay = { player, model, warnings };
}

$('play').onclick = () => {
  if (!player) return;
  if (player.playing) player.pause();
  else player.play();
  onUpdate(player.state());
};
$('seek').oninput = () => player?.seek(Number($('seek').value));
document.addEventListener('keydown', (event) => {
  const t = event.target;
  if (!player || t instanceof HTMLInputElement || t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (event.key === ' ') {
    event.preventDefault();
    $('play').click();
  }
});

/** Replays a picked or dropped .narwal.zip for viewing only, with the offer to save it. */
async function openFile(bytes, fileName) {
  // A picked file is not the library recording that was open: edits must not reach that one.
  const was = editing;
  try {
    const checked = await unpackBundle(bytes);
    editing = null;
    await replay(checked.files);
    opened = { bytes, fileName };
    // When the library cannot be read here, Save still checks for a saved copy.
    renderKeep(await findSaved(bytes, checked.contentSha256).catch(() => null));
  } catch (err) {
    // The recording that was open is still on screen.
    editing = was;
    showError(err?.message ?? String(err));
  }
}

async function openPicked(file) {
  try {
    await openFile(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (err) {
    showError(err?.message ?? String(err));
  }
}

$('file').onchange = () => {
  const file = $('file').files?.[0];
  $('file').value = '';
  if (file) openPicked(file);
};
$('pick-shared').onclick = () => $('file').click();
onFileDrop(document, openPicked);

/** The file Saved recordings handed over (?shared=1). The address drops it, so a reload shows the library. */
async function openHandedOver() {
  history.replaceState(null, '', location.pathname);
  try {
    const handed = await takeHandedOver();
    if (handed) await openFile(handed.bytes, handed.fileName);
    else showError('The shared recording did not reach this page. Choose it again with Open a shared recording.');
  } catch (err) {
    showError(err?.message ?? String(err));
  }
}

async function start() {
  const params = new URLSearchParams(location.search);
  try {
    library = await openLibrary();
    if (NARWAL_TEST) globalThis.__narwalLibrary = library;
    const id = params.get('id');
    if (id) {
      editing = { library, id };
      await replay(await library.readFiles(id));
    }
    else await renderLibrary(library);
  } catch (err) {
    showError(err?.message ?? String(err));
  }
  if (params.get('shared') === '1') await openHandedOver();
  if (NARWAL_TEST) globalThis.__narwalReplayReady = true;
}

drawIcons();
start();
