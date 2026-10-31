// Saved recordings: reopen any recording from local chunks, including one
// that was interrupted, and show its pages, microphone audio and every
// labelled gap. Replays one page at a time with rrweb.
//
// Board #16589: a bundle the user saved from a file (replay page, Save) has no
// local chunks. It is listed here from the recording library and opens in the
// replay page, where it can be corrected, annotated and exported again.
//
// Board #16783: laid out as Tiles B. The open recording (the newest when none
// is asked for) has a status bar and tiles; a tile is drawn only when the
// recording has something for it. The library below is grouped by day and
// searched by title, site and the words said.
//
// Board #16839: a click anywhere on a row selects it, and the tiles show it;
// up and down move the selection, Enter opens it like the row's Open.
//
// Board #17003: a recording can be deleted for good, from its row or several
// at once from their checkboxes, after one confirm that names each one and
// its length. The list and the space used follow without a reload.
//
// Board #27484: sharing is one file. Open a shared recording (or a .narwal.zip
// dropped on this page) hands the file to the replay page, which replays it
// and offers Save; each Export says to send the file and open it that way.
import { Replayer } from 'rrweb';
import * as store from '../store/db.js';
import { analyze, rrwebEventsOf } from '../shared/analyze.js';
import { HIDDEN_STYLE_RULES, markHiddenAreas } from '../shared/hidden-regions.js';
import { bundleRecordingId, writeBundle } from '../export/bundle.js';
import { transcriptRefresh } from '../export/refresh.js';
import { bundleValidator, deriveAgentFiles } from '../../../bundle/src/index.ts';
import { editRecording, readLayer, setPurpose } from '../../../edits/src/index.ts';
import { IdbLibraryStorage, RecordingLibrary } from '../../../library/src/index.ts';
import { checkPurpose, countPurpose } from '../shared/purpose.js';
import { NOT_EXPORTED, askPurpose, exportWithPurpose, readLibraryPurpose, saveLibraryPurpose } from './purpose-ask.js';
import { clockTime, duration, toWorker } from './sw.js';
import { afterTranscriptBusy, afterTranscriptNext, afterTranscriptStatus } from '../shared/ui-status.js';
import { formatClock } from '../../../recorder-ui/src/transcript.js';
import { improvingPercent } from '../../../recorder-ui/src/strip-model.js';
import { drawIcons, icon } from './icons.js';
import { SHARED_REPLAY_URL, handOver, onFileDrop } from './shared-file.js';
import { bytesText, recordingsBytes } from '../store/usage.js';
import { activeRevision, dayLabel, flowOf, groupByDay, hostOf, markAt, marksOf, matches, mmss, routeText, routesOf, searchText, stageFit, transcriptWord } from './tiles-model.js';
import { guardThisPage } from './page-guard.js';

// A new build in the folder waits while this page is in use (board #17009).
guardThisPage();

const $ = (id) => document.getElementById(id);
let db = null;
let replayer = null;
let shown = null; // the recording open in the tiles
let selected = null; // the row marked in the library: the one asked for, before it has loaded
let opening = 0; // counts opens: a later open wins over one still loading
let current = null; // what the tiles show of the open recording: { meta, rec, routes, marks }
let transcriptTimer = null;
// The transcript row the user picked ({ kind, atMs, text }, board #16844): it
// stays picked when the transcript is drawn again.
let picked = null;

const SCOPE_TEXT = { any: 'Page and microphone', page: 'Page', frame: 'Part of the page', audio: 'Microphone' };
const REASON_TEXT = {
  'recovery-truncated': 'Nothing was saved here.',
  'restricted-page': 'This page cannot be recorded by an extension.',
  'lost-messages': 'Some page events did not arrive.',
  'mic-denied': 'The microphone was blocked.',
  'mic-device-lost': 'No microphone was available.',
  'mic-track-ended': 'The microphone stopped (blocked or unplugged).',
  'recorder-error': 'The audio recorder failed.',
};
const STATUS_TEXT = { recording: 'Recording', stopped: 'Stopped', interrupted: 'Interrupted' };
const STOP_TEXT = { user: 'by you', 'tab-closed': 'when the tab closed', interrupted: 'without Stop' };
const WORD_TEXT = { improved: 'improved on this computer', OpenAI: 'made by OpenAI', live: 'live' };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'onclick') node.onclick = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function cell(tr, text, className) {
  const td = el('td', { class: className });
  if (text instanceof Node) td.append(text);
  else td.textContent = text ?? '';
  tr.append(td);
  return td;
}

/** A small icon button; `name` is what it does, `describedBy` the row it does it to. */
function iconButton(name, iconName, onclick, describedBy) {
  return el('button', { class: 'ib', type: 'button', 'aria-label': name, title: name, 'aria-describedby': describedBy, onclick }, icon(iconName));
}

const statusText = (status, stopReason) => {
  const word = STATUS_TEXT[status] || status;
  if (!stopReason || stopReason === 'user') return word;
  return `${word} (${STOP_TEXT[stopReason] || stopReason})`;
};

/** Everything saved for one recording, analysed. */
export async function load(id) {
  db = db || (await store.openDb());
  const meta = await store.getRecording(db, id);
  if (!meta) return null;
  const [eventChunks, audioChunks] = await Promise.all([store.readChunks(db, id, 'events'), store.readChunks(db, id, 'audio')]);
  return { ...analyze({ meta, eventChunks, audioChunks }), eventChunks, audioChunks };
}

// Choices with a transcript job after Stop: OpenAI's (board #16588) and the
// improved transcript on this computer (board #16603).
const AFTER_STOP = new Set(['openai', 'offline']);

/** True while this recording's transcript is made after Stop. */
async function transcriptComing(meta) {
  if (!AFTER_STOP.has(meta.transcription)) return false;
  const reply = await toWorker('transcript-state', { id: meta.id }).catch(() => null);
  return afterTranscriptBusy(reply && reply.afterTranscript);
}

/** Why Export waits, in plain words. */
function comingText(meta) {
  return meta.transcription === 'offline' ? 'The transcript is still being improved on this computer.' : 'The transcript is still coming from OpenAI.';
}

/**
 * Export pressed on the strip or the popup while the transcript after Stop is
 * still being made (board #16622): waits for it here, saying how far it is,
 * so the press is not lost. Returns when no transcript job runs.
 */
async function untilTranscriptReady(meta) {
  if (!AFTER_STOP.has(meta.transcription)) return;
  for (;;) {
    const reply = await toWorker('transcript-state', { id: meta.id }).catch(() => null);
    const job = reply && reply.afterTranscript;
    if (!afterTranscriptBusy(job)) return;
    $('export-status').textContent =
      meta.transcription === 'offline'
        ? `The transcript is still being improved on this computer (${improvingPercent(job)}%). The bundle downloads when it is ready.`
        : 'The transcript is still coming from OpenAI. The bundle downloads when it is ready.';
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Writes a stopped recording as a bundle (docs/bundle-schema.md), adds it to
 * the recording library once, and returns the packed archive. Explicit only:
 * the user presses Export; the bytes go nowhere but a download.
 *
 * A transcript made after an earlier export (OpenAI, Try again) is added to
 * the library copy first, so every export carries the transcript the
 * recording has. `transcriptKept` is true when the copy could not take it.
 */
export async function exportRecording(id) {
  const rec = await load(id);
  if (!rec) throw new Error('That recording is not saved on this computer.');
  // A bundle made now would leave without the transcript.
  if (await transcriptComing(rec.meta)) throw new Error(`${comingText(rec.meta)} Export when it is ready.`);
  const manifest = chrome.runtime.getManifest();
  const history = await store.readTranscriptHistory(db, id);
  const { files, manifest: bundleManifest } = await writeBundle({
    // The purpose as last saved: the replay page may have changed it on the library copy.
    meta: { ...rec.meta, purpose: await readPurpose(id) },
    eventChunks: rec.eventChunks,
    audioChunks: rec.audioChunks,
    history,
    producer: { name: 'narwal-extension', version: manifest.version },
    environment: environmentOf(),
  });
  const library = await openLibrary();
  const saved = await recordedCopy(library, bundleManifest.recordingId);
  const copy = saved ? await refreshSaved(library, saved.id, files) : { id: (await library.save(files)).id, transcriptKept: false };
  const exported = await library.exportBundle(copy.id);
  return { ...exported, manifest: bundleManifest, files, transcriptKept: copy.transcriptKept };
}

/**
 * Gives the library copy of an earlier export the transcript the recording
 * has now (export/refresh.js). A copy the user corrected or annotated in the
 * replay page is left as it is, and so is one whose captured files this
 * version of NarWal writes differently: the library takes added layers only.
 */
async function refreshSaved(library, id, files) {
  for (let attempt = 1; ; attempt += 1) {
    const { recording, files: stored } = await library.read(id);
    const verdict = transcriptRefresh(stored, files);
    if (verdict !== 'refresh') return { id, transcriptKept: verdict === 'edited' };
    try {
      await library.update(id, files, { expectedRevision: recording.revision });
      return { id, transcriptKept: false };
    } catch (err) {
      if (err && err.code === 'update-refused') return { id, transcriptKept: true };
      // Another write landed after the read (replay page): decide again from the newer tree.
      if (!err || err.code !== 'recording-conflict' || attempt >= 3) throw err;
    }
  }
}

/** The library copy of a recording made here. Not a copy saved from a file: that one may hold another person's edits. */
async function recordedCopy(library, recordingId) {
  return (await library.list()).find((r) => r.origin.kind === 'recorded' && r.recordingId === recordingId) || null;
}

/**
 * What the recording is for (manifest.purpose, board #16594): kept with the
 * local recording, and on its library copy once there is one, where the
 * replay page may also have changed it.
 */
async function readPurpose(id) {
  const library = await openLibrary();
  const copy = await recordedCopy(library, bundleRecordingId(id));
  if (copy) return readLayer(await library.readFiles(copy.id)).purpose;
  return (await store.getRecording(db, id))?.purpose ?? null;
}

export async function savePurpose(id, text) {
  const checked = checkPurpose(text);
  if (!checked.ok) throw new Error(checked.message);
  // The library copy first: it is what readPurpose and export read, so a failed
  // write there leaves both copies as they were.
  const library = await openLibrary();
  const copy = await recordedCopy(library, bundleRecordingId(id));
  if (copy) await editRecording(library, copy.id, (layer) => setPurpose(layer, checked.purpose ?? ''));
  db = db || (await store.openDb());
  await store.updateRecording(db, id, { purpose: checked.purpose });
  return checked.purpose;
}

let libraryOpen = null;
function openLibrary() {
  libraryOpen = libraryOpen || IdbLibraryStorage.open().then((storage) =>
    RecordingLibrary.open({ storage, productVersion: chrome.runtime.getManifest().version, validate: bundleValidator, derive: deriveAgentFiles }));
  return libraryOpen;
}

/** Library recordings that came from a bundle file, newest first. They have no local chunks. */
export async function listImported() {
  const library = await openLibrary();
  return (await library.list()).filter((r) => r.origin.kind === 'imported');
}

/** A recording saved from a file, packed again with its corrections and notes. */
export async function exportImported(id) {
  return (await openLibrary()).exportBundle(id);
}

function environmentOf() {
  const brand = (navigator.userAgentData?.brands || []).find((b) => /Chrom/.test(b.brand) && !/Not/.test(b.brand));
  const version = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return {
    browser: brand ? brand.brand : 'Chromium',
    browserVersion: version ? version[1] : 'unknown',
    platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
  };
}

// The modal that asks what the recording is for (board #17002, purpose-ask.js).
const askHere = () =>
  askPurpose({ dialog: $('purpose-ask'), field: $('purpose-ask-text'), confirm: $('purpose-ask-ok'), cancel: $('purpose-ask-cancel'), message: $('purpose-ask-error'), count: $('purpose-ask-count') });

/** The purpose of a recording made here, for exportWithPurpose: saved with savePurpose, shown in the open tile. */
const recordedPurpose = (id) => ({
  read: () => readPurpose(id),
  ask: askHere,
  save: async (text) => {
    const purpose = await savePurpose(id, text);
    if (id === shown) {
      $('purpose').value = purpose ?? '';
      purposeCount();
      $('purpose-status').textContent = '';
    }
  },
});

/** The purpose of a recording saved from a file: its library edit layer, as the replay page keeps it. */
const importedPurpose = (id) => ({
  read: async () => readLibraryPurpose(await openLibrary(), id),
  ask: askHere,
  save: async (text) => saveLibraryPurpose(await openLibrary(), id, text),
});

/** After each Export: how the file reaches someone else's NarWal (board #27484). */
const SHARE_HINT = 'Send this file; they open it in NarWal with Open a shared recording.';

/**
 * Downloads the bundle `pack` writes. With `purpose` (board #17002), a
 * recording with no purpose is asked for one first; Cancel downloads nothing.
 */
async function download(pack, b, purpose = null) {
  b.disabled = true;
  const note = $('export-status');
  // The last export's note would read as this one's while the purpose is asked.
  note.textContent = '';
  try {
    const packed = await exportWithPurpose({
      purpose,
      pack: () => {
        note.textContent = 'Exporting…';
        return pack();
      },
    });
    if (!packed) {
      note.textContent = NOT_EXPORTED;
      return;
    }
    const { fileName, bytes, transcriptKept } = packed;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    note.textContent = `${transcriptKept ? `Saved ${fileName}. It keeps the transcript and the changes it had: the newer transcript is not in it.` : `Saved ${fileName}.`} ${SHARE_HINT}`;
  } catch (err) {
    note.textContent = `Could not export: ${String((err && err.message) || err)}`;
  } finally {
    b.disabled = false;
  }
}

// Export waits for the OpenAI transcript (board #16588), and so does Delete
// (board #17003): the recorder writes the transcript into the recording.
function holdExport(meta, held) {
  for (const b of document.querySelectorAll('button[data-export], button[data-delete]')) {
    if ((b.dataset.export || b.dataset.delete) !== meta.id) continue;
    b.disabled = held;
    b.title = held ? comingText(meta) : b.getAttribute('aria-label') || '';
  }
}

/** Holds a listed recording's Export until its transcript job ends. Stops when the list is drawn again. */
async function watchExport(meta) {
  // The row's button: the status bar's is drawn again when another recording opens.
  const b = document.querySelector(`#list button[data-export="${CSS.escape(meta.id)}"]`);
  if (!b) return;
  const coming = await transcriptComing(meta);
  if (!b.isConnected) return;
  holdExport(meta, coming);
  if (coming) setTimeout(() => watchExport(meta), 1000);
}

export async function list() {
  db = db || (await store.openDb());
  return store.listRecordings(db);
}

/** Rows drawn for the library, kept for the search and the keys: { tr, text, id, open, body }. */
let listed = [];
// Rows ticked for Delete, by row key: a recording's id, `lib:<id>` for one saved from a file.
const ticked = new Set();

/** The checkbox in front of a row: ticks it for Delete selected. */
function tickBox(key, titleId, disabled) {
  const box = el('input', { type: 'checkbox', 'aria-labelledby': titleId, title: disabled ? 'Stop the recording first' : 'Select', disabled });
  box.checked = !disabled && ticked.has(key);
  box.onchange = () => {
    if (box.checked) ticked.add(key);
    else ticked.delete(key);
    showTicked();
  };
  return box;
}

async function renderList() {
  const local = await list();
  // Words said, for the search and the Transcript column. One read per recording, all local.
  const histories = await Promise.all(local.map((r) => store.readTranscriptHistory(db, r.id).catch(() => null)));
  const rows = [];
  const coming = [];
  local.forEach((r, i) => {
    const titleId = `row-${r.id}`;
    const tr = el('tr', { 'data-id': r.id });
    const live = r.status === 'recording';
    cell(tr, tickBox(r.id, titleId, live), 'pick');
    cell(tr, new Date(r.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'm');
    cell(tr, r.title || r.url, 't').id = titleId;
    cell(tr, hostOf(r.url), 'm site');
    cell(tr, r.stoppedAt ? duration(r.stoppedAt - r.startedAt) : 'recording', 'r');
    cell(tr, el('span', { class: r.status === 'recording' ? 'chip busy' : 'chip', text: statusText(r.status, r.stopReason) }));
    const word = transcriptWord(histories[i]);
    cell(tr, el('span', { class: word ? 'chip' : 'chip none', text: word || 'no transcript' }));
    const open = () => openRecording(r.id, { focus: true });
    const actions = cell(tr, iconButton('Open', 'open', open, titleId), 'acts');
    if (r.status !== 'recording') {
      const b = iconButton('Export bundle', 'download', () => download(() => exportRecording(r.id), b, recordedPurpose(r.id)), titleId);
      b.dataset.export = r.id;
      actions.append(b);
    }
    const ms = r.stoppedAt ? r.stoppedAt - r.startedAt : 0;
    const row = { at: r.startedAt, ms, tr, id: r.id, key: r.id, title: r.title || r.url, live, open, text: searchText({ title: r.title, url: r.url, history: histories[i] }) };
    const del = iconButton('Delete', 'trash', () => askDelete([row]), titleId);
    del.classList.add('danger');
    del.dataset.delete = r.id;
    if (live) {
      del.disabled = true;
      del.title = 'Stop the recording first';
    }
    actions.append(del);
    if (!live && afterTranscriptBusy(r.afterTranscript)) {
      for (const b of actions.querySelectorAll('button[data-export], button[data-delete]')) b.disabled = true;
      coming.push(r);
    }
    rows.push(row);
  });
  let imported = [];
  try {
    imported = await listImported();
  } catch (err) {
    // The recordings made here are still listed.
    $('export-status').textContent = `Could not list recordings saved from files: ${String((err && err.message) || err)}`;
  }
  for (const r of imported) {
    const titleId = `lib-${r.id}`;
    const tr = el('tr');
    tr.dataset.libraryId = r.id;
    const key = `lib:${r.id}`;
    cell(tr, tickBox(key, titleId, false), 'pick');
    cell(tr, new Date(r.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'm');
    cell(tr, r.title, 't').id = titleId;
    cell(tr, 'from a bundle file', 'm site');
    cell(tr, duration(r.durationMs), 'r');
    cell(tr, el('span', { class: 'chip', text: r.status === 'interrupted' ? 'Interrupted' : 'Saved from a file' }));
    cell(tr, '');
    const open = () => {
      location.href = `replay.html?id=${encodeURIComponent(r.id)}`;
    };
    const actions = cell(tr, iconButton('Open', 'open', open, titleId), 'acts');
    const b = iconButton('Export bundle', 'download', () => download(() => exportImported(r.id), b, importedPurpose(r.id)), titleId);
    // It has no tiles here: Replay is where it is shown.
    const row = { at: Date.parse(r.createdAt), ms: r.durationMs || 0, tr, id: null, libraryId: r.id, key, title: r.title, live: false, open, text: String(r.title || '').toLowerCase() };
    const del = iconButton('Delete', 'trash', () => askDelete([row]), titleId);
    del.classList.add('danger');
    actions.append(b, del);
    rows.push(row);
  }
  // Newest first, whichever way the recording got here, in runs of one day.
  rows.sort((a, b) => b.at - a.at);
  const table = $('list');
  for (const old of table.querySelectorAll('tbody')) old.remove();
  listed = [];
  for (const group of groupByDay(rows, (row) => row.at)) {
    const body = el('tbody');
    const head = el('th', { scope: 'rowgroup', colspan: '8' }, group.label, el('span', { class: 'sub' }));
    body.append(el('tr', { class: 'day' }, head));
    for (const item of group.items) {
      const row = { ...item, body };
      row.tr.tabIndex = -1;
      row.tr.onclick = (e) => {
        // Open, Export and links in the row do their own thing.
        if (e.target.closest('button, a, input')) return;
        pickRow(row);
      };
      row.tr.ondblclick = (e) => {
        if (!e.target.closest('button, a, input')) row.open();
      };
      row.tr.onkeydown = (e) => rowKey(e, row);
      body.append(row.tr);
      listed.push(row);
    }
    table.append(body);
  }
  $('list-empty').hidden = rows.length > 0;
  table.hidden = rows.length === 0;
  $('search').closest('.filters').hidden = rows.length === 0;
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  const bytes = await recordingsBytes({ db }).catch(() => null);
  $('lib-sub').textContent = rows.length
    ? `${rows.length} recording${rows.length === 1 ? '' : 's'}${total ? ` · ${duration(total)}` : ''}${bytes !== null ? ` · ${bytesText(bytes)} on this computer` : ''}`
    : '';
  // A ticked row that is gone (deleted, or deleted on another page) is no longer ticked.
  const keys = new Set(rows.map((row) => row.key));
  for (const key of ticked) if (!keys.has(key)) ticked.delete(key);
  markCurrentRow();
  filterList();
  for (const meta of coming) watchExport(meta);
}

/** Shows the rows whose title, site or words have every word typed in the search. */
function filterList() {
  const query = $('search').value;
  let shownRows = 0;
  const perBody = new Map();
  for (const row of listed) {
    const hit = matches(query, row.text);
    row.tr.hidden = !hit;
    if (hit) shownRows += 1;
    perBody.set(row.body, (perBody.get(row.body) || 0) + (hit ? 1 : 0));
  }
  for (const [body, n] of perBody) {
    body.hidden = n === 0;
    body.querySelector('tr.day .sub').textContent = `${n}`;
  }
  $('shown').textContent = !listed.length ? '' : query.trim() ? `Showing ${shownRows} of ${listed.length}` : '';
  tabStop();
  showTicked();
}

const visibleRows = () => listed.filter((row) => !row.tr.hidden && !row.body.hidden);

/** The bar for the ticked rows and the box that ticks every row shown. Ticked rows a search hides stay ticked, and are counted. */
function showTicked() {
  const n = listed.filter((row) => ticked.has(row.key)).length;
  $('picked-bar').hidden = n === 0;
  $('picked-count').textContent = n ? `${n} selected` : '';
  const tickable = visibleRows().filter((row) => !row.live);
  const on = tickable.filter((row) => ticked.has(row.key)).length;
  const all = $('pick-all');
  all.disabled = tickable.length === 0;
  all.checked = tickable.length > 0 && on === tickable.length;
  all.indeterminate = on > 0 && on < tickable.length;
}

$('pick-all').onchange = () => {
  const tick = $('pick-all').checked;
  for (const row of visibleRows()) {
    if (row.live) continue;
    if (tick) ticked.add(row.key);
    else ticked.delete(row.key);
    const box = row.tr.querySelector('td.pick input');
    if (box) box.checked = tick;
  }
  showTicked();
};
$('unpick').onclick = () => {
  ticked.clear();
  for (const box of document.querySelectorAll('#list td.pick input')) box.checked = false;
  showTicked();
};
$('delete-picked').onclick = () => askDelete(listed.filter((row) => ticked.has(row.key)));

/**
 * One confirm for one or several recordings: each by name and length. Resolves
 * true for Delete; Cancel, Escape and a click outside resolve false.
 */
function confirmDelete(rows) {
  const dialog = $('confirm-delete');
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  $('confirm-title').textContent =
    rows.length === 1 ? 'Delete this recording?' : `Delete ${rows.length} recordings${total ? ` (${duration(total)} in all)` : ''}?`;
  $('confirm-list').replaceChildren(
    ...rows.map((row) => el('li', {}, el('span', { class: 't', text: row.title || 'Untitled', title: row.title || '' }), el('span', { class: 'm', text: row.ms ? duration(row.ms) : 'no length' }))),
  );
  $('confirm-go').replaceChildren(icon('trash'), rows.length === 1 ? 'Delete recording' : `Delete ${rows.length} recordings`);
  return new Promise((resolve) => {
    const finish = (yes) => {
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(yes);
    };
    $('confirm-go').onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.onclick = (e) => {
      // A click on the backdrop reaches the dialog itself, outside its box.
      const box = dialog.getBoundingClientRect();
      const outside = e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
      if (e.target === dialog && outside) finish(false);
    };
    dialog.showModal();
    // Cancel has the focus: Enter alone never deletes.
    $('confirm-cancel').focus();
  });
}

let deleting = false;

/** Delete on a row or Delete selected: asks once, then deletes each recording and draws the list again. */
async function askDelete(rows) {
  rows = rows.filter((row) => !row.live);
  if (!rows.length || deleting) return;
  if (!(await confirmDelete(rows))) return;
  deleting = true;
  const note = $('export-status');
  note.textContent = rows.length === 1 ? 'Deleting…' : `Deleting ${rows.length} recordings…`;
  try {
    const before = await recordingsBytes({ db }).catch(() => null);
    const { deleted, failed } = await deleteRows(rows);
    const after = await recordingsBytes({ db }).catch(() => null);
    const freed = before !== null && after !== null && before > after ? ` ${bytesText(before - after)} freed.` : '';
    const lead = deleted.length === 1 ? `Deleted ${deleted[0].title || 'the recording'}.` : deleted.length ? `Deleted ${deleted.length} recordings.` : '';
    const left = failed.length ? ` Not deleted: ${failed.map((f) => `${f.row.title || 'a recording'} (${f.message})`).join('; ')}.` : '';
    note.textContent = `${lead}${deleted.length ? freed : ''}${left}`.trim();
  } finally {
    deleting = false;
  }
}

/** Deletes each row's recording. Returns { deleted: rows, failed: [{ row, message }] }; one failure does not stop the rest. */
async function deleteRows(rows) {
  const deleted = [];
  const failed = [];
  for (const row of rows) {
    try {
      if (row.id) await deleteRecording(row.id);
      else await deleteImported(row.libraryId);
      deleted.push(row);
      ticked.delete(row.key);
    } catch (err) {
      failed.push({ row, message: String((err && err.message) || err) });
    }
  }
  const gone = new Set(deleted.map((row) => row.id).filter(Boolean));
  if (gone.has(shown) || gone.has(selected)) closeDetail();
  await renderList();
  // The tiles show the newest recording left, as when the page opens.
  if (!shown) {
    const [newest] = await list();
    if (newest) await openRecording(newest.id);
  }
  return { deleted, failed };
}

/**
 * Deletes a recording made here for good: its copy in the recording library
 * (and any in the library's trash), then its chunks and entry, which the
 * recorder removes (sw/main.js delete-recording). The copy goes to the trash
 * first, so a refusal (still recording, transcript still being made) puts it back.
 */
export async function deleteRecording(id) {
  const library = await openLibrary();
  const recordingId = bundleRecordingId(id);
  const mine = (r) => r.origin.kind === 'recorded' && r.recordingId === recordingId;
  const live = (await library.list()).filter(mine);
  for (const copy of live) await library.delete(copy.id);
  const reply = await toWorker('delete-recording', { id }).catch((err) => ({ ok: false, message: String((err && err.message) || err) }));
  if (!reply || !reply.ok) {
    for (const copy of live) await library.restore(copy.id).catch(() => {});
    throw new Error((reply && (reply.message || reply.error)) || 'the recorder did not answer');
  }
  for (const copy of (await library.listTrash()).filter(mine)) await library.purge(copy.id, { confirm: true });
}

/** Deletes a recording saved from a file for good. The file itself is not touched. */
export async function deleteImported(libraryId) {
  const library = await openLibrary();
  const record = await library.get(libraryId);
  if (record.deletedAt === null) await library.delete(libraryId);
  await library.purge(libraryId, { confirm: true });
}

/** The tiles of a recording that is deleted go away; a load still on its way is dropped. */
function closeDetail() {
  opening += 1;
  shown = null;
  selected = null;
  current = null;
  picked = null;
  hover = null;
  clearTimeout(transcriptTimer);
  stopClock();
  if (replayer) replayer.destroy();
  replayer = null;
  $('replay').replaceChildren();
  for (const player of $('audio').querySelectorAll('audio')) URL.revokeObjectURL(player.src);
  $('audio').replaceChildren();
  $('detail').hidden = true;
}

function markCurrentRow() {
  for (const row of listed) {
    if (row.id && row.id === selected) row.tr.setAttribute('aria-current', 'true');
    else row.tr.removeAttribute('aria-current');
  }
  tabStop();
}

/** One row takes Tab into the list: the marked one while it is listed, else the first one listed. */
function tabStop(focused = null) {
  const visible = listed.filter((row) => !row.tr.hidden && !row.body.hidden);
  const stop = focused || visible.find((row) => row.tr === document.activeElement) || visible.find((row) => row.id && row.id === selected) || visible[0];
  for (const row of listed) row.tr.tabIndex = row === stop ? 0 : -1;
}

/** A click on a row: a recording made here opens in the tiles; one saved from a file opens in Replay. */
function pickRow(row) {
  if (row.id) openRecording(row.id);
  else row.open();
}

/** Up and down move the selection (Home and End to the ends), Enter opens the row. */
function rowKey(e, row) {
  if (e.target !== row.tr || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    row.open();
    return;
  }
  const visible = listed.filter((r) => !r.tr.hidden && !r.body.hidden);
  const at = visible.indexOf(row);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: visible.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = visible[Math.max(0, Math.min(visible.length - 1, to))];
  if (!next || next === row) return;
  tabStop(next);
  next.tr.focus();
  // A recording saved from a file is only focused: opening it leaves this page.
  if (next.id) openRecording(next.id);
}

/** The status bar: title, state and when, the counts the recording has, Export and Open in Replay. */
async function renderBar(rec, routes, marks) {
  const { meta } = rec;
  $('detail-title').replaceChildren(el('span', { class: 'tt', text: meta.title || meta.url }));
  const status = $('detail-status');
  status.replaceChildren(el('b', { text: STATUS_TEXT[meta.status] || meta.status }));
  if (meta.stopReason) status.append(` ${STOP_TEXT[meta.stopReason] || `(${meta.stopReason})`}`);
  status.append(` · ${dayLabel(meta.startedAt)} `, el('b', { text: clockTime(meta.startedAt) }));

  const history = await store.readTranscriptHistory(db, meta.id).catch(() => null);
  const word = transcriptWord(history);
  const tops = rec.documents.filter((d) => d.isTop).length;
  const stats = [
    ['Length', meta.stoppedAt ? duration(meta.stoppedAt - meta.startedAt) : 'recording'],
    ['Pages', tops],
    ['Frames', rec.documents.length - tops],
    ['Route changes', Math.max(0, routes.length - 1)],
    ['Marks', marks.length],
    ['Saved chunks', rec.eventChunks.length + rec.audioChunks.length],
    ['Transcript', word, 'word'],
  ].filter(([, v]) => v);
  $('stats').replaceChildren(...stats.map(([k, v, c]) => el('div', {}, el('dt', { text: k }), el('dd', { class: c, text: String(v) }))));

  const acts = $('detail-acts');
  acts.replaceChildren();
  const copy = await openLibrary().then((library) => recordedCopy(library, bundleRecordingId(meta.id))).catch(() => null);
  if (shown !== meta.id) return;
  if (copy) acts.append(el('a', { class: 'hbtn', href: `replay.html?id=${encodeURIComponent(copy.id)}` }, icon('open'), 'Open in Replay'));
  if (meta.status !== 'recording') {
    const b = el('button', { class: 'hbtn primary', type: 'button' }, icon('download'), 'Export bundle');
    b.onclick = () => download(() => exportRecording(meta.id), b, recordedPurpose(meta.id));
    b.dataset.export = meta.id;
    acts.append(b);
  }
}

async function openRecording(id, { focus = false } = {}) {
  const mine = ++opening;
  // The row is marked at once; the tiles follow when the recording has loaded.
  selected = id;
  markCurrentRow();
  const rec = await load(id);
  if (mine !== opening) return;
  if (!rec) {
    selected = shown;
    markCurrentRow();
    return;
  }
  const { meta } = rec;
  shown = meta.id;
  clearTimeout(transcriptTimer);
  picked = null;
  hover = null;
  const routes = routesOf({ meta, documents: rec.documents, navigations: rec.navigations, observations: rec.observations });
  const marks = marksOf(rec.observations);
  current = { meta, rec, routes, marks };
  $('detail').hidden = false;
  markCurrentRow();
  $('purpose-status').textContent = '';
  $('purpose').value = (await readPurpose(id).catch(() => meta.purpose)) ?? '';
  purposeCount();
  await renderBar(rec, routes, marks);
  if (mine !== opening) return;

  const gaps = $('gaps').querySelector('tbody');
  gaps.replaceChildren();
  $('gaps-tile').hidden = rec.gaps.length === 0;
  $('gaps-sub').textContent = rec.gaps.length ? String(rec.gaps.length) : '';
  for (const g of rec.gaps) {
    const tr = gaps.insertRow();
    cell(tr, clockTime(g.from), 'm');
    cell(tr, g.to ? clockTime(g.to) : 'end', 'm');
    cell(tr, SCOPE_TEXT[g.scope] || g.scope);
    cell(tr, `${REASON_TEXT[g.reason] || g.reason}${g.detail ? ` (${g.detail})` : ''}`);
  }

  const docs = $('docs').querySelector('tbody');
  docs.replaceChildren();
  $('pages-tile').hidden = rec.documents.length === 0;
  $('pages-sub').textContent = rec.documents.length ? String(rec.documents.length) : '';
  for (const d of rec.documents) {
    const tr = docs.insertRow();
    const key = d.documentId || d.doc;
    const urlCell = cell(tr, `${hostOf(d.url)}${routeText(d.url)}` || d.url, 'u');
    urlCell.title = d.url;
    urlCell.id = `doc-${key}`;
    cell(tr, d.isTop ? 'top' : `frame ${d.frameId}`, 'm');
    cell(tr, String(d.rrEvents), 'r');
    cell(tr, d.attachments.map((a) => a.reason).join(', '), 'm');
    cell(tr, iconButton('Replay', 'replay', () => showDocument(key), urlCell.id), 'acts');
  }

  const audio = $('audio');
  audio.replaceChildren();
  $('mic-tile').hidden = rec.audio.length === 0;
  const heard = rec.audio.reduce((sum, s) => sum + Math.max(0, s.endAt - s.startAt), 0);
  $('mic-sub').textContent = rec.audio.length ? `${rec.audio.length === 1 ? '1 part' : `${rec.audio.length} parts`} · ${duration(heard)}` : '';
  for (const s of rec.audio) {
    const player = el('audio', { controls: true, preload: 'metadata', 'aria-label': `Microphone part ${s.segment + 1}` });
    player.src = URL.createObjectURL(new Blob(s.chunks.map((c) => c.data), { type: 'audio/webm' }));
    audio.append(el('div', { class: 'part' }, player, el('p', { text: `Part ${s.segment + 1} · ${clockTime(s.startAt)} – ${clockTime(s.endAt)} · ${s.chunks.length} chunks` })));
  }

  setupPlayer(rec, routes, marks);
  await renderTranscript(meta);
  if (focus && mine === opening) {
    scrollTo({ top: 0 });
    $('detail-title').focus({ preventScroll: true });
  }
}

// The improved transcript on this computer (board #16603) in plain words.
function localJobText(job) {
  switch (job.state) {
    case 'improving':
      return `Improving the transcript on this computer (${improvingPercent(job)}%)… The live transcript is shown until it is ready.`;
    case 'done':
      return job.activated ? 'This transcript was improved on this computer after the recording.' : 'An improved transcript is saved. The transcript below is the one you had.';
    case 'partial':
      return `Only part of the transcript was improved: ${job.detail}.`;
    default:
      return `The transcript was not improved: ${job.detail}. The live transcript is kept.`;
  }
}

// The OpenAI job (board #16588) in plain words; '' when there is none.
function jobText(job, local) {
  if (!job) return '';
  if (local) return localJobText(job);
  switch (job.state) {
    case 'uploading':
      return `Getting the transcript from OpenAI${job.total > 1 ? ` (part ${Math.min(job.done + 1, job.total)} of ${job.total})` : ''}…`;
    case 'done':
      return job.activated ? 'OpenAI made this transcript after the recording.' : 'A new OpenAI transcript is saved. The transcript below is the one you had.';
    case 'partial':
      return `OpenAI made only part of the transcript: ${job.detail}.`;
    case 'no-key':
      return 'No OpenAI key is saved. Save your key in the NarWal popup, then get the transcript here.';
    default:
      return job.next === 'after-fix' ? `No transcript: ${job.detail}. Put that right, then get the transcript here.` : `No transcript: ${job.detail}.`;
  }
}

/**
 * The active transcript and, for a recording made with OpenAI, how its
 * transcript is coming along, with a button to get it (again). Each press
 * sends the narration audio to OpenAI once. A recording made on this computer
 * shows how its improved transcript is coming along, with a button to make
 * one when it has none (board #16603).
 *
 * The route changes and marks stand between the spoken lines (board #16783).
 * Every row can be picked (board #16844): the replay shows that moment and
 * stays there, and the arrow keys move through the rows. Hovering a mark
 * shows its box on the replay until the pointer leaves.
 */
async function renderTranscript(meta) {
  clearTimeout(transcriptTimer);
  const history = await store.readTranscriptHistory(db, meta.id);
  const active = activeRevision(history);
  const openai = meta.transcription === 'openai';
  const local = meta.transcription === 'offline';
  const reply = openai || local ? await toWorker('transcript-state', { id: meta.id }).catch(() => null) : null;
  const job = afterTranscriptStatus(reply && reply.afterTranscript);
  // What may be asked next: Try again only when the same job can work now.
  const next = afterTranscriptNext(reply && reply.afterTranscript);
  if (shown !== meta.id) return;
  const busy = afterTranscriptBusy(job);
  holdExport(meta, busy);

  $('transcript-status').textContent = jobText(job, local) || (active ? '' : openai ? 'No transcript yet.' : 'No transcript.');
  const get = $('transcript-get');
  const failed = job && (job.state === 'failed' || job.state === 'partial');
  // An offline recording has a transcript to improve until one was made after the recording.
  const improved = history.revisions.some((r) => r.source === 'after-recording' && r.provider === 'browser-local');
  const has = local ? improved : Boolean(active);
  // A failure that asking again cannot put right (no narration audio) has no button.
  get.hidden = !(openai || local) || meta.status === 'recording' || busy || (failed ? next === 'never' : has);
  get.textContent = failed && next === 'retry' ? 'Try again' : local ? 'Improve the transcript' : 'Get the transcript from OpenAI';
  get.disabled = false;
  get.onclick = async () => {
    get.disabled = true;
    const started = await toWorker('transcribe', { id: meta.id }).catch((err) => ({ ok: false, message: String(err && err.message) }));
    if (!started || !started.ok) $('transcript-status').textContent = `${local ? 'The transcript was not improved' : 'No transcript'}: ${(started && (started.message || started.error)) || 'the recorder did not answer'}.`;
    await renderTranscript(meta);
  };

  const here = current && current.meta.id === meta.id ? current : { routes: [], marks: [] };
  const segments = active ? active.segments : [];
  const flow = flowOf({ routes: here.routes, marks: here.marks, segments });
  const word = transcriptWord(history);
  const said = flow.filter((r) => r.kind === 'line').length;
  $('transcript-sub').textContent = [word && WORD_TEXT[word], said && `${said} line${said === 1 ? '' : 's'}`, here.marks.length && `${here.marks.length} mark${here.marks.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const rows = flow.map(flowRow);
  $('transcript').replaceChildren(...rows);
  const again = picked && rows.find((li) => sameRow(li.row, picked));
  if (again) markPicked(again);
  else if (rows.length) rows[0].tabIndex = 0;
  showNow(playerTime());
  // Shown as it goes, while this recording stays open.
  if (busy) transcriptTimer = setTimeout(() => shown === meta.id && renderTranscript(meta), 1000);
}

function flowRow(row) {
  const time = formatClock(row.atMs);
  const li = el('li', { role: 'option', 'aria-selected': 'false', tabIndex: -1, 'data-at': row.atMs, class: row.kind === 'line' ? null : row.kind });
  li.row = row;
  if (row.kind === 'route') {
    li.append(el('span', { text: time }), el('span', { class: 'what' }, icon('route', 12), row.first ? 'opened ' : 'went to ', el('code', { text: row.text, title: row.url })));
    return li;
  }
  li.append(el('span', { class: 'at', text: time }));
  if (row.kind === 'mark') {
    li.append(el('p', { class: 'what' }, icon('marker', 13), row.text));
    li.addEventListener('mouseenter', () => previewMark(row.mark));
    li.addEventListener('mouseleave', endPreview);
  } else li.append(el('p', { class: 'what', text: row.text }));
  return li;
}

const sameRow = (a, b) => a.kind === b.kind && a.atMs === b.atMs && a.text === b.text;

/** Draws `li` as the picked row: the only one selected and the one Tab reaches. */
function markPicked(li) {
  for (const other of $('transcript').children) {
    other.setAttribute('aria-selected', String(other === li));
    other.tabIndex = other === li ? 0 : -1;
  }
}

/** Picks a transcript row: the replay shows its moment, paused, and a mark's box. */
function pick(li, { focus = true } = {}) {
  hover = null;
  picked = li.row;
  markPicked(li);
  if (focus) li.focus({ preventScroll: true });
  li.scrollIntoView({ block: 'nearest' });
  player.focus = li.row.mark || null;
  seek(li.row.atMs, { play: false });
}

/**
 * Hovering a mark shows its moment and its box; `hover.back` is where the
 * replay was, so leaving goes back there.
 */
let hover = null;

function previewMark(mark) {
  if (!current || !player.docs.length) return;
  if (!hover) hover = { back: { t: playerTime(), playing: player.playing, focus: player.focus } };
  hover.mark = mark;
  player.focus = mark;
  seek(mark.atMs, { play: false });
}

function endPreview() {
  if (!hover) return;
  const { back } = hover;
  hover = null;
  player.focus = back.focus;
  seek(back.t, { play: back.playing });
}

$('transcript').addEventListener('click', (event) => {
  const li = event.target.closest('#transcript > li');
  if (li) pick(li);
});
$('transcript').addEventListener('keydown', (event) => {
  const li = event.target.closest('#transcript > li');
  if (!li) return;
  const rows = [...$('transcript').children];
  const at = rows.indexOf(li);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1, Enter: at, ' ': at }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
  if (next) pick(next);
});

const purposeCount = countPurpose($('purpose'), $('purpose-count'));

$('save-purpose').onclick = async () => {
  const id = shown;
  const status = $('purpose-status');
  try {
    const purpose = await savePurpose(id, $('purpose').value);
    if (id === shown) {
      $('purpose').value = purpose ?? '';
      purposeCount();
      status.textContent = purpose ? 'Saved.' : 'Removed.';
    }
  } catch (err) {
    status.textContent = `Not saved: ${String((err && err.message) || err)}`;
  }
};

/**
 * Replay one browser document's rrweb stream. Returns the event count. Plays
 * at once unless `at` (ms into the stream) is given: then it shows that
 * moment, paused.
 */
export function replay(rec, documentKey, { at = null } = {}) {
  const events = rrwebEventsOf(rec.entries, documentKey);
  if (replayer) replayer.destroy();
  replayer = null;
  $('replay').replaceChildren();
  if (!events.some((e) => e.type === 2)) {
    $('replay').append(el('p', { class: 'say', text: 'This page has no full snapshot to replay.' }));
    return 0;
  }
  // The class marks only this in-memory copy; export reads the store again.
  replayer = new Replayer(markHiddenAreas(events), {
    root: $('replay'),
    skipInactive: true,
    mouseTail: false,
    insertStyleRules: HIDDEN_STYLE_RULES,
  });
  replayer.on('resize', fitStage);
  // The first size is set while the replayer is made, before anyone listens.
  const first = events.find((e) => e.type === 4 && e.data && e.data.width);
  if (first) fitStage(first.data);
  if (at === null) replayer.play();
  else replayer.pause(Math.max(0, at));
  return events.length;
}

// The replay tile (board #16783): one track for the whole recording. The top
// page's documents play one after another; a frame plays alone from Pages.
// `focus` is the mark hovered or picked in the transcript (board #16844).
const player = { docs: [], key: null, from: 0, total: 0, playing: false, frame: 0, viewport: null, fit: null, focus: null };

function playerTime() {
  if (!replayer || !current) return 0;
  return Math.min(player.total, player.from + replayer.getCurrentTime());
}

function setupPlayer(rec, routes, marks) {
  stopClock();
  const startedAt = rec.meta.startedAt;
  const end = rec.meta.stoppedAt ?? Math.max(startedAt, ...rec.documents.map((d) => d.lastEventAt || 0));
  player.total = Math.max(0, end - startedAt);
  player.docs = rec.documents
    .filter((d) => d.isTop && d.firstSnapshotAt)
    .map((d) => ({ key: d.documentId || d.doc, fromMs: Math.max(0, d.firstSnapshotAt - startedAt) }))
    .sort((a, b) => a.fromMs - b.fromMs);
  player.key = null;
  player.playing = false;
  player.focus = null;
  const seekBar = $('seek');
  seekBar.max = String(Math.max(1, Math.round(player.total)));
  const pct = (ms) => `${Math.min(100, (ms / Math.max(1, player.total)) * 100).toFixed(2)}%`;
  $('ticks').replaceChildren(
    ...routes.slice(1).map((r) => el('i', { style: `left:${pct(r.atMs)}` })),
    ...marks.map((m) => el('i', { class: 'mark', style: `left:${pct(m.atMs)}` })),
  );
  const routeTimes = routes.slice(1).map((r) => mmss(r.atMs));
  const sub = [];
  if (marks.length) sub.push(`${marks.length === 1 ? 'mark' : `${marks.length} marks`} at ${marks.slice(0, 3).map((m) => mmss(m.atMs)).join(', ')}${marks.length > 3 ? '…' : ''}`);
  if (routeTimes.length) sub.push(`route change${routeTimes.length === 1 ? '' : 's'} at ${routeTimes.slice(0, 3).join(', ')}${routeTimes.length > 3 ? '…' : ''}`);
  $('replay-sub').textContent = sub.join(' · ');
  const playable = player.docs.length > 0;
  $('play').disabled = !playable;
  seekBar.disabled = !playable;
  if (!playable) {
    if (replayer) replayer.destroy();
    replayer = null;
    $('replay').replaceChildren(el('p', { class: 'say', text: rec.documents.length ? 'This recording has no full page snapshot to replay.' : 'No page was recorded.' }));
    showNow(0);
    return;
  }
  // Opens on the first mark: the moment the person pointed at.
  seek(marks.length ? marks[0].atMs : 0);
}

function docAt(t) {
  let found = player.docs[0];
  for (const d of player.docs) if (d.fromMs <= t + 1) found = d;
  return found;
}

/** Shows (or plays from) a moment of the recording, switching page when it is on another one. */
function seek(t, { play = player.playing } = {}) {
  if (!current || !player.docs.length) return;
  const at = Math.max(0, Math.min(player.total, t));
  const doc = docAt(at);
  mount(doc.key);
  if (!replayer) return;
  const offset = Math.max(0, at - player.from);
  if (play) replayer.play(offset);
  else replayer.pause(offset);
  setPlaying(play);
  showNow(at);
}

/** Replays one document (a row in Pages) from its start, paused. */
function showDocument(key) {
  if (!current) return;
  mount(key, { force: true });
  if (!replayer) return;
  replayer.pause(0);
  setPlaying(false);
  showNow(player.from);
  $('replay-tile').scrollIntoView({ block: 'nearest' });
}

function mount(key, { force = false } = {}) {
  if (!force && player.key === key && replayer) return;
  replay(current.rec, key, { at: 0 });
  player.key = key;
  if (!replayer) return;
  player.from = Math.max(0, replayer.getMetaData().startTime - current.meta.startedAt);
  replayer.on('finish', () => {
    if (!player.playing) return;
    const next = player.docs.find((d) => d.fromMs > player.from + 1);
    if (next && player.key !== next.key) seek(next.fromMs, { play: true });
    else setPlaying(false);
  });
  fitStage(player.viewport);
}

/**
 * Scales the recorded window into the stage, whole (board #16844): a window
 * taller than it is wide was cut off at the bottom, so a scroll there could
 * not be seen. The stage is at most 80% of this window high.
 */
function fitStage(size) {
  if (size && size.width && size.height) player.viewport = { width: size.width, height: size.height };
  const v = player.viewport;
  const stage = $('stage');
  const wrapper = $('replay').querySelector('.replayer-wrapper');
  if (!v || !wrapper) return;
  const fit = stageFit(v, stage.clientWidth, Math.max(360, innerHeight * 0.8));
  stage.style.aspectRatio = 'auto';
  stage.style.height = `${fit.height}px`;
  wrapper.style.left = `${fit.left}px`;
  wrapper.style.transform = `scale(${fit.scale})`;
  player.fit = fit;
  showMark(playerTime());
}

new ResizeObserver(() => fitStage(null)).observe($('stage'));
addEventListener('resize', () => fitStage(null));

function setPlaying(on) {
  player.playing = on;
  const b = $('play');
  b.replaceChildren(icon(on ? 'pause' : 'play', 14));
  b.setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) startClock();
  else stopClock();
}

function startClock() {
  cancelAnimationFrame(player.frame);
  const tick = () => {
    showNow(playerTime());
    if (player.playing) player.frame = requestAnimationFrame(tick);
  };
  player.frame = requestAnimationFrame(tick);
}

function stopClock() {
  cancelAnimationFrame(player.frame);
}

/** The clock, the slider, the mark drawn over the page and the transcript row of this moment. */
function showNow(t) {
  const seekBar = $('seek');
  if (document.activeElement !== seekBar || player.playing) seekBar.value = String(Math.round(t));
  const text = `${mmss(t)} / ${mmss(player.total)}`;
  $('clock').textContent = text;
  seekBar.setAttribute('aria-valuetext', `${mmss(t)} of ${mmss(player.total)}`);
  showMark(t);
  let now = null;
  for (const li of $('transcript').children) {
    li.classList.remove('now');
    if (Number(li.dataset.at) <= t + 1 && !li.classList.contains('route')) now = li;
  }
  if (now) now.classList.add('now');
}

/**
 * Draws the box of a mark over the replay for a few seconds from when it was
 * made. The mark hovered or picked in the transcript is drawn stronger.
 */
function showMark(t) {
  const box = $('mark-box');
  const fit = player.fit;
  const mark = current && fit && player.viewport ? markAt(current.marks, t, player.key, player.focus) : null;
  if (!mark) {
    box.hidden = true;
    return;
  }
  const { scale, left } = fit;
  Object.assign(box.style, { left: `${left + mark.box.x * scale - 3}px`, top: `${mark.box.y * scale - 3}px`, width: `${mark.box.w * scale + 6}px`, height: `${mark.box.h * scale + 6}px` });
  box.classList.toggle('focus', mark === player.focus);
  box.dataset.at = String(mark.atMs);
  box.hidden = false;
}

$('play').onclick = () => {
  if (!replayer) return;
  if (player.playing) {
    replayer.pause();
    setPlaying(false);
    return;
  }
  const t = playerTime();
  seek(t >= player.total - 50 ? 0 : t, { play: true });
};
$('seek').addEventListener('input', () => seek(Number($('seek').value), { play: false }));
$('search').addEventListener('input', filterList);

/**
 * A page opened for one recording (`?id=`) shows it. With `&export=1` (Export
 * on the strip or in the popup, board #16602) it exports it first: the same
 * Export bundle as its row, so the transcript rules of #16588 hold. A
 * transcript still on its way is waited for (board #16622). A recording with
 * no purpose is asked for one in the modal here (board #17002).
 */
async function showAsked(params) {
  const id = params.get('id');
  if (!id) return;
  if (params.get('export') === '1') {
    // Once: a reload of this page does not download the bundle again.
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
    const meta = await store.getRecording(db, id);
    const listedButton = document.querySelector(`#list button[data-export="${CSS.escape(id)}"]`);
    // The purpose is asked first, while the person looks at this page (board
    // #17002); a transcript still on its way is waited for after the answer.
    const pack = async () => {
      if (meta) {
        await untilTranscriptReady(meta);
        $('export-status').textContent = 'Exporting…';
      }
      return exportRecording(id);
    };
    await download(pack, listedButton || document.createElement('button'), meta ? recordedPurpose(id) : null);
  }
  // A recording that is not here: the list is still shown.
  if (await store.getRecording(db, id)) await openRecording(id);
}

/** With no recording asked for, the newest one made here is open. */
async function showNewest() {
  if (opening) return;
  const [newest] = await list();
  if (newest && !opening) await openRecording(newest.id);
}

/** Open a shared recording: the replay page shows the file and offers Save. */
async function openShared(file) {
  const note = $('export-status');
  note.textContent = `Opening ${file.name}…`;
  try {
    await handOver(file);
    location.href = SHARED_REPLAY_URL;
  } catch (err) {
    note.textContent = `Could not open ${file.name}: ${String((err && err.message) || err)}`;
  }
}

$('open-shared').onclick = () => $('shared-file').click();
$('shared-file').onchange = () => {
  const file = $('shared-file').files?.[0];
  $('shared-file').value = '';
  if (file) openShared(file);
};
onFileDrop(document, openShared);

drawIcons();
setPlaying(false);
renderList()
  .then(() => showAsked(new URLSearchParams(location.search)))
  .then(() => showNewest());
globalThis.narwalViewer = { load, list, listImported, replay, openRecording, exportRecording, exportImported, savePurpose, deleteRecording, deleteImported, usedBytes: () => recordingsBytes({ db }) };
