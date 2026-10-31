// A retranscription arriving after the user corrected the transcript.
// Fixture: r2 is active, and the user's c2 there reads "total" for the heard
// "toll" in s2. The test adds a second correction (s4) before the new run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReplay } from '../../replay/src/load.ts';
import { NarwalError } from '../../library/src/errors.ts';
import {
  addNote,
  addRetranscription,
  applyPlan,
  correctedTranscript,
  correctSegment,
  editRecording,
  EditError,
  readLayer,
  resolveRetranscription,
  segmentCorrections,
  waitingRevisions,
} from '../src/index.ts';
import type { RecordingLibrary } from '../../library/src/library.ts';
import { clockAt, decode, fixtureFiles, isCaptured, openLibrary, providerRevision } from './helpers.ts';

const now = clockAt('2026-10-13T21:00:00.000Z');
const later = clockAt('2026-10-13T21:30:00.000Z');
const refused = (code: string) => (error: unknown) => error instanceof EditError && error.code === code;

/** The new run heard "tool" where r2 heard "toll": the user's "total" now stands on other words. */
const heardTool = providerRevision({
  1: [['and', 45000, 45580], ['this', 45580, 46160], ['tool', 46160, 46740], ['is', 46740, 47320], ['wrong', 47320, 47900]],
});

async function correctedRecording(): Promise<{ library: RecordingLibrary; id: string; original: Map<string, Uint8Array> }> {
  const original = await fixtureFiles();
  const library = await openLibrary();
  const { id } = await library.save(original);
  await editRecording(library, id, (layer, at) => correctSegment(layer, { segmentId: 's4', text: 'The export button does not work' }, at), { now });
  return { library, id, original };
}

const text = async (files: Map<string, Uint8Array>, segmentId: string) => {
  const { model } = await loadReplay(files);
  return model.utterances.find((u) => u.segmentId === segmentId)!;
};

test('a retranscription that conflicts with a correction is stored but not shown; corrections stay', async () => {
  const { library, id, original } = await correctedRecording();
  const before = await library.readFiles(id);

  const { result, files } = await editRecording(library, id, (layer, at) => addRetranscription(layer, heardTool, { at }), { now: later });

  // The explicit result: what was carried, and what needs the user.
  assert.equal(result.revisionId, 'r3');
  assert.equal(result.activated, false);
  assert.equal(result.notActivated, 'conflicts');
  assert.deepEqual(
    result.items.map((item) => [item.correction.id, item.outcome, item.reason ?? null]),
    [
      ['c2', 'conflict', 'text-changed'],
      ['c3', 'carried', null],
    ],
  );
  assert.deepEqual(
    result.conflicts.map((item) => ({ id: item.correction.id, mine: item.correction.text, heard: item.originalText, now: item.revisionText, target: item.target })),
    [{ id: 'c2', mine: 'total', heard: 'toll', now: 'tool', target: { segmentId: 's2', wordStart: 2, wordEnd: 3 } }],
  );

  // Stored: the new revision file, and c3 carried onto it ready for the switch.
  assert.ok(files.has('transcript/r3.json'));
  const layer = readLayer(files);
  assert.equal(layer.activeRevision, 'r2');
  assert.deepEqual(segmentCorrections(layer, 'r3', 's4'), [
    { id: 'c4', type: 'correction', revisionId: 'r3', segmentId: 's4', wordStart: 4, wordEnd: 5, text: 'not work', createdAt: '2026-10-13T21:30:00.000Z', carriedFrom: 'c3' },
  ]);
  assert.deepEqual(segmentCorrections(layer, 'r3', 's2'), []);

  // Not overwritten: the user still reads their corrected transcript.
  const s2 = await text(files, 's2');
  assert.equal(s2.revisionId, 'r2');
  assert.equal(s2.text, 'and this total is wrong');
  assert.equal((await text(files, 's4')).text, 'The export button does not work');
  // Nothing earlier changed.
  for (const [path, bytes] of before) {
    if (isCaptured(path) || path.startsWith('transcript/')) assert.deepEqual(files.get(path), bytes, path);
  }
  assert.ok(decode(files.get('edits.jsonl')).startsWith(decode(original.get('edits.jsonl'))));

  // The waiting revision is part of the bundle: it survives export and import.
  const exported = await library.exportBundle(id);
  const other = await openLibrary();
  const imported = await other.importBundle(exported.bytes);
  const waiting = waitingRevisions(readLayer(await other.readFiles(imported.recording.id)));
  assert.deepEqual(
    waiting.map((w) => [w.revisionId, w.provider, w.incomplete, w.conflicts.map((c) => [c.correction.id, c.reason])]),
    [['r3', 'openai', false, [['c2', 'text-changed']]]],
  );
});

test('resolving with keep-mine puts the user\'s text on the new words and switches', async () => {
  const { library, id } = await correctedRecording();
  await editRecording(library, id, (layer, at) => addRetranscription(layer, heardTool, { at }), { now: later });

  await assert.rejects(
    editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', {}, at), { now }),
    (error: unknown) => refused('undecided')(error) && JSON.stringify((error as EditError).detail) === '{"corrections":["c2"]}',
  );

  const { result, files } = await editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'keep-mine' }, at), { now: later });
  assert.deepEqual(result.kept, ['c2']);
  // c3 was carried when r3 arrived; it is not carried twice.
  assert.deepEqual(
    result.plan.edits.map((e) => e.id),
    ['c5'],
  );
  const layer = readLayer(files);
  assert.equal(layer.activeRevision, 'r3');
  const s2 = await text(files, 's2');
  assert.equal(s2.revisionId, 'r3');
  assert.equal(s2.text, 'and this total is wrong');
  assert.equal(s2.heard, 'and this tool is wrong');
  assert.equal((await text(files, 's4')).text, 'The export button does not work');
  assert.deepEqual(
    segmentCorrections(layer, 'r3', 's2').map((c) => [c.id, c.text, c.carriedFrom]),
    [['c5', 'total', 'c2']],
  );
  // r1 and r2 keep their own corrections.
  assert.equal(correctedTranscript(layer, 'r2')[1]!.text, 'and this total is wrong');
  assert.equal(correctedTranscript(layer, 'r1')[1]!.text, 'and this total is wrong');
  assert.deepEqual(waitingRevisions(layer), []);
});

test('resolving with take-new switches to the new words; the old correction stays on its revision', async () => {
  const { library, id } = await correctedRecording();
  await editRecording(library, id, (layer, at) => addRetranscription(layer, heardTool, { at }), { now: later });
  const { result, files } = await editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'take-new' }, at), { now: later });
  assert.deepEqual(result.taken, ['c2']);
  assert.deepEqual(result.plan.edits, []);
  const s2 = await text(files, 's2');
  assert.equal(s2.revisionId, 'r3');
  assert.equal(s2.text, 'and this tool is wrong');
  assert.equal(s2.corrected, false);
  const layer = readLayer(files);
  assert.deepEqual(
    segmentCorrections(layer, 'r2', 's2').map((c) => c.id),
    ['c2'],
  );
  const view = decode(files.get('agent/walkthrough.json'));
  assert.match(view, /"correctionsOnOtherRevisions": [1-9]/);
});

// Review of NarWal#23: "Switch" and "Add note" at once (or two tabs). The note
// was built from a tree read while r2 was active; written after the switch to
// r3, it passed the layer check and put activeRevision back to r2.
test('an edit built before a switch to the new revision does not undo the switch', async () => {
  const { library, id } = await correctedRecording();
  await editRecording(library, id, (layer, at) => addRetranscription(layer, heardTool, { at }), { now: later });

  // Tab A reads while r2 is active and builds a note on that tree.
  const stale = await library.read(id);
  assert.equal(readLayer(stale.files).activeRevision, 'r2');
  const noted = await applyPlan(stale.files, addNote(readLayer(stale.files), { atMs: 1000, text: 'stale tab' }, '2026-10-13T21:40:00.000Z').plan);
  // Tab B takes the new words.
  await editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'take-new' }, at), { now: later });
  const switched = await library.read(id);
  assert.equal(readLayer(switched.files).activeRevision, 'r3');

  // Tab A's write is refused and nothing changes.
  await assert.rejects(
    library.update(id, noted, { expectedRevision: stale.recording.revision }),
    (error: unknown) => error instanceof NarwalError && error.code === 'recording-conflict',
  );
  const after = await library.read(id);
  assert.equal(after.recording.revision, switched.recording.revision);
  assert.deepEqual(after.files, switched.files);

  // Through editRecording the switch lands between the note's read and its
  // write: the note is built again on the switched tree, and r3 stays active.
  const { library: racing, id: rid } = await correctedRecording();
  await editRecording(racing, rid, (layer, at) => addRetranscription(layer, heardTool, { at }), { now: later });
  let builds = 0;
  let switchedFirst = false;
  const tabA = {
    read: (key: string) => racing.read(key),
    update: async (key: string, files: Map<string, Uint8Array>, options?: { expectedRevision?: number }) => {
      if (!switchedFirst) {
        switchedFirst = true;
        await editRecording(racing, rid, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'take-new' }, at), { now: later });
      }
      return racing.update(key, files, options);
    },
  } as unknown as RecordingLibrary;
  const { result, files } = await editRecording(tabA, rid, (layer, at) => (builds++, addNote(layer, { atMs: 1000, text: 'racing tab' }, at)), { now: later });
  assert.equal(builds, 2);
  const stored = readLayer(await racing.readFiles(rid));
  assert.equal(stored.activeRevision, 'r3');
  assert.deepEqual(readLayer(files), stored);
  assert.ok(stored.edits.some((e) => e.id === result.noteId && e.type === 'note'));
});

test('a retranscription that agrees with every correction carries them and becomes active', async () => {
  const { library, id } = await correctedRecording();
  const { result, files } = await editRecording(library, id, (layer, at) => addRetranscription(layer, providerRevision(), { at }), { now: later });
  assert.equal(result.activated, true);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    result.plan.edits.map((e) => [e.id, e.type === 'correction' ? e.carriedFrom : null]),
    [
      ['c4', 'c2'],
      ['c5', 'c3'],
    ],
  );
  assert.equal(readLayer(files).activeRevision, 'r3');
  assert.equal((await text(files, 's2')).text, 'and this total is wrong');
  assert.equal((await text(files, 's4')).text, 'The export button does not work');
});

test('a revision that already says what the user wrote is redundant, not a conflict', async () => {
  const { library, id } = await correctedRecording();
  const heardTotal = providerRevision({
    1: [['and', 45000, 45580], ['this', 45580, 46160], ['total', 46160, 46740], ['is', 46740, 47320], ['wrong', 47320, 47900]],
  });
  const { result, files } = await editRecording(library, id, (layer, at) => addRetranscription(layer, heardTotal, { at }), { now: later });
  assert.equal(result.activated, true);
  assert.deepEqual(
    result.items.map((item) => [item.correction.id, item.outcome]),
    [
      ['c2', 'redundant'],
      ['c3', 'carried'],
    ],
  );
  const s2 = await text(files, 's2');
  assert.equal(s2.text, 'and this total is wrong');
  assert.equal(s2.corrected, false);
});

test('a revision with a gap is stored but does not replace what the user reads', async () => {
  const { library, id } = await correctedRecording();
  const partial = providerRevision({}, { gaps: [{ provider: 'openai', startMs: 60000, endMs: 70000, reason: 'provider-error', detail: 'upload 2 failed' }] });
  const { result, files } = await editRecording(library, id, (layer, at) => addRetranscription(layer, partial, { at }), { now: later });
  assert.equal(result.activated, false);
  assert.equal(result.notActivated, 'incomplete');
  const layer = readLayer(files);
  assert.equal(layer.activeRevision, 'r2');
  assert.deepEqual(
    waitingRevisions(layer).map((w) => [w.revisionId, w.incomplete, w.conflicts.length]),
    [['r3', true, 0]],
  );
  // The user may still switch to it on purpose.
  const { files: switched } = await editRecording(library, id, (l, at) => resolveRetranscription(l, 'r3', {}, at), { now });
  assert.equal(readLayer(switched).activeRevision, 'r3');
});

test('keep-mine is refused where the corrected words are gone; take-new is the way on', async () => {
  const { library, id } = await correctedRecording();
  const silent = providerRevision({ 1: [['and', 45000, 45580], ['this', 45580, 46160], ['is', 46740, 47320], ['wrong', 47320, 47900]] });
  const { result } = await editRecording(library, id, (layer, at) => addRetranscription(layer, silent, { at }), { now: later });
  assert.deepEqual(
    result.conflicts.map((c) => [c.correction.id, c.reason]),
    [['c2', 'no-words']],
  );
  await assert.rejects(
    editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'keep-mine' }, at), { now }),
    refused('cannot-keep'),
  );
  const { files } = await editRecording(library, id, (layer, at) => resolveRetranscription(layer, 'r3', { c2: 'take-new' }, at), { now });
  assert.equal((await text(files, 's2')).text, 'and this is wrong');
});

test('refusals: unknown supersedes, resolving the active revision, the revision limit', async () => {
  const layer = readLayer(await fixtureFiles());
  const at = '2026-10-13T21:30:00.000Z';
  assert.throws(() => addRetranscription(layer, providerRevision({}, { supersedes: 'r9' }), { at }), refused('unknown-revision'));
  assert.throws(() => resolveRetranscription(layer, 'r2', {}, at), refused('nothing-to-resolve'));
  assert.throws(() => resolveRetranscription(layer, 'r9', {}, at), refused('unknown-revision'));
  const full = { ...layer, revisions: Array.from({ length: 32 }, (_, i) => ({ ...layer.revisions[0]!, revisionId: `r${i + 1}` })) };
  assert.throws(() => addRetranscription(full, providerRevision(), { at }), refused('revision-limit'));
});
