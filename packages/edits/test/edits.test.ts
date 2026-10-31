import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../bundle/src/agent-view.ts';
import { memorySource } from '../../bundle/src/memory-source.ts';
import { validateBundle } from '../../bundle/src/validate.ts';
import {
  activeNotes,
  addCorrection,
  addNote,
  applyPlan,
  correctedSegment,
  correctedTranscript,
  correctSegment,
  editNote,
  EditError,
  readLayer,
  retractEdit,
  segmentCorrections,
  setPurpose,
  wordDiff,
} from '../src/index.ts';
import type { EditLayer, EditPlan } from '../src/index.ts';
import { decode, fixtureFiles, isCaptured } from './helpers.ts';

const AT = '2026-10-13T21:00:00.000Z';

async function applied(plan: EditPlan) {
  const before = await fixtureFiles();
  const after = await applyPlan(before, plan);
  return { before, after, layer: readLayer(after) };
}

const refused = (code: string) => (error: unknown) => error instanceof EditError && error.code === code;

test('the fixture reads as the agent view reads it', async () => {
  const layer = readLayer(await fixtureFiles());
  assert.equal(layer.activeRevision, 'r2');
  assert.deepEqual(
    layer.revisions.map((r) => r.revisionId),
    ['r1', 'r2'],
  );
  const s2 = correctedTranscript(layer, 'r2').find((segment) => segment.segmentId === 's2')!;
  assert.equal(s2.text, 'and this total is wrong');
  assert.equal(s2.heard, 'and this toll is wrong');
  assert.deepEqual(
    activeNotes(layer).map((note) => note.id),
    ['n2'],
  );
});

test('wordDiff finds the smallest changed range; an insertion takes in a neighbour', () => {
  const words = ['and', 'this', 'toll', 'is', 'wrong'];
  assert.equal(wordDiff(words, words), null);
  assert.deepEqual(wordDiff(words, ['and', 'this', 'total', 'is', 'wrong']), { wordStart: 2, wordEnd: 3, text: 'total' });
  assert.deepEqual(wordDiff(words, ['and', 'this', 'is', 'wrong']), { wordStart: 2, wordEnd: 3, text: '' });
  assert.deepEqual(wordDiff(words, ['and', 'this', 'toll', 'really', 'is', 'wrong']), { wordStart: 2, wordEnd: 3, text: 'toll really' });
  assert.deepEqual(wordDiff(words, ['so', 'and', 'this', 'toll', 'is', 'wrong']), { wordStart: 0, wordEnd: 1, text: 'so and' });
  assert.deepEqual(wordDiff(words, []), { wordStart: 0, wordEnd: 5, text: '' });
});

test('a correction stands on the time of the words it replaced, never on invented word times', async () => {
  const layer = readLayer(await fixtureFiles());
  const { plan } = correctSegment(layer, { segmentId: 's4', text: 'The export button does not work at all' }, AT);
  assert.deepEqual(plan.edits, [
    { id: 'c3', type: 'correction', revisionId: 'r2', segmentId: 's4', wordStart: 4, wordEnd: 5, text: 'not work at all', createdAt: AT },
  ]);
  const { layer: after } = await applied(plan);
  const s4 = correctedTranscript(after, 'r2').find((segment) => segment.segmentId === 's4')!;
  assert.equal(s4.text, 'The export button does not work at all');
  assert.equal(s4.heard, 'The export button does nothing');
  assert.equal(s4.startMs, 61000);
  assert.equal(s4.endMs, 64500);
  assert.deepEqual(
    s4.pieces.map((p) => [p.text, p.startMs, p.endMs, p.timing]),
    [
      ['The', 61000, 61700, 'word'],
      ['export', 61700, 62400, 'word'],
      ['button', 62400, 63100, 'word'],
      ['does', 63100, 63800, 'word'],
      // Four words on the one span "nothing" had: no per-word times are made up.
      ['not work at all', 63800, 64500, 'span'],
    ],
  );
  assert.equal(s4.pieces[4]!.heard, 'nothing');
});

test('a whole-segment correction keeps the segment span and says what was heard', () => {
  const segment = { id: 's9', startMs: 100, endMs: 900, text: 'mumble', words: [] };
  const result = correctedSegment(segment, [
    { id: 'c9', type: 'correction', revisionId: 'r1', segmentId: 's9', text: 'the totals', createdAt: AT },
  ]);
  assert.deepEqual(result.pieces, [
    { text: 'the totals', startMs: 100, endMs: 900, source: 'corrected', timing: 'span', heard: 'mumble', editId: 'c9' },
  ]);
});

test('editing a corrected segment supersedes its correction; reverting to what was heard retracts it', async () => {
  const layer = readLayer(await fixtureFiles());
  const same = correctSegment(layer, { segmentId: 's2', text: '  and this   total is wrong ' }, AT);
  assert.deepEqual(same.plan.edits, []);

  const changed = correctSegment(layer, { segmentId: 's2', text: 'and this total is right' }, AT);
  assert.deepEqual(changed.plan.edits, [
    { id: 'c3', type: 'correction', revisionId: 'r2', segmentId: 's2', wordStart: 2, wordEnd: 5, text: 'total is right', createdAt: AT, supersedes: 'c2' },
  ]);
  const { layer: afterChange } = await applied(changed.plan);
  assert.equal(correctedTranscript(afterChange, 'r2')[1]!.text, 'and this total is right');

  const reverted = correctSegment(layer, { segmentId: 's2', text: 'and this toll is wrong' }, AT);
  assert.deepEqual(reverted.plan.edits, [{ id: 'x2', type: 'retract', target: 'c2', createdAt: AT }]);
  const { layer: afterRevert } = await applied(reverted.plan);
  const s2 = correctedTranscript(afterRevert, 'r2')[1]!;
  assert.equal(s2.text, 'and this toll is wrong');
  assert.equal(s2.corrected, false);
  // The correction on r1 is that revision's own; nothing on r2 touches it.
  assert.equal(correctedTranscript(afterRevert, 'r1')[1]!.text, 'and this total is wrong');
});

test('two corrections on one segment: the next edit keeps one and retracts the other', async () => {
  const layer = readLayer(await fixtureFiles());
  const first = addCorrection(layer, { segmentId: 's3', wordStart: 0, wordEnd: 1, text: 'Those' }, AT);
  const second = addCorrection(readLayer(await applyPlan(await fixtureFiles(), first.plan)), { segmentId: 's3', wordStart: 4, wordEnd: 6, text: 'add up' }, AT);
  const both = await applyPlan(await applyPlan(await fixtureFiles(), first.plan), second.plan);
  const twice = readLayer(both);
  assert.equal(correctedTranscript(twice, 'r2')[2]!.text, 'Those four numbers should add up');

  const next = correctSegment(twice, { segmentId: 's3', text: 'These four numbers should add up' }, AT);
  assert.deepEqual(
    next.plan.edits.map((e) => [e.type, e.type === 'retract' ? e.target : e.id]),
    [
      ['retract', 'c3'],
      ['retract', 'c4'],
      ['correction', 'c5'],
    ],
  );
  const final = readLayer(await applyPlan(both, next.plan));
  assert.equal(correctedTranscript(final, 'r2')[2]!.text, 'These four numbers should add up');
});

test('refusals: overlap, bad range, unknown segment and revision, long text', async () => {
  const layer = readLayer(await fixtureFiles());
  assert.throws(() => addCorrection(layer, { segmentId: 's2', wordStart: 1, wordEnd: 3, text: 'that total' }, AT), refused('overlap'));
  assert.throws(() => addCorrection(layer, { segmentId: 's2', text: 'whole' }, AT), refused('overlap'));
  assert.throws(() => addCorrection(layer, { segmentId: 's2', wordStart: 3, wordEnd: 3, text: 'x' }, AT), refused('word-range'));
  assert.throws(() => addCorrection(layer, { segmentId: 's2', wordStart: 4, wordEnd: 6, text: 'x' }, AT), refused('word-range'));
  assert.throws(() => addCorrection(layer, { segmentId: 's2', wordStart: 4, text: 'x' }, AT), refused('word-range'));
  assert.throws(() => addCorrection(layer, { segmentId: 's7', text: 'x' }, AT), refused('unknown-segment'));
  assert.throws(() => addCorrection(layer, { revisionId: 'r9', segmentId: 's1', text: 'x' }, AT), refused('unknown-revision'));
  assert.throws(() => addCorrection(layer, { segmentId: 's1', wordStart: 0, wordEnd: 1, text: 'x', supersedes: 'c1' }, AT), refused('edit-inactive'));
  assert.throws(() => correctSegment(layer, { segmentId: 's1', text: 'x'.repeat(2001) }, AT), refused('text-too-long'));
  const empty: EditLayer = { ...layer, activeRevision: null, revisions: [] };
  assert.throws(() => correctSegment(empty, { segmentId: 's1', text: 'x' }, AT), refused('no-transcript'));
  // Superseding the correction it overlaps is the way to change it.
  const replaced = addCorrection(layer, { segmentId: 's2', wordStart: 1, wordEnd: 3, text: 'that total', supersedes: 'c2' }, AT);
  const after = readLayer(await applyPlan(await fixtureFiles(), replaced.plan));
  assert.deepEqual(
    segmentCorrections(after, 'r2', 's2').map((c) => c.id),
    ['c3'],
  );
});

test('notes: anchored to session time, changed by supersede, removed by retract', async () => {
  const layer = readLayer(await fixtureFiles());
  const added = addNote(layer, { atMs: 62000, endMs: 64500, text: '  Export does nothing\non click  ' }, AT);
  assert.deepEqual(added.plan.edits, [{ id: 'n4', type: 'note', atMs: 62000, endMs: 64500, text: 'Export does nothing\non click', createdAt: AT }]);
  const instant = addNote(layer, { atMs: 80000, endMs: null, text: 'end' }, AT);
  assert.equal('endMs' in instant.plan.edits[0]!, false);

  assert.throws(() => addNote(layer, { atMs: -1, text: 'x' }, AT), refused('anchor-outside'));
  assert.throws(() => addNote(layer, { atMs: 80001, text: 'x' }, AT), refused('anchor-outside'));
  assert.throws(() => addNote(layer, { atMs: 500, endMs: 400, text: 'x' }, AT), refused('anchor-outside'));
  assert.throws(() => addNote(layer, { atMs: Number.NaN, text: 'x' }, AT), refused('anchor-outside'));
  assert.throws(() => addNote(layer, { atMs: 500, text: ' \n ' }, AT), refused('note-empty'));
  assert.throws(() => addNote(layer, { atMs: 500, text: 'x'.repeat(10001) }, AT), refused('text-too-long'));

  assert.deepEqual(editNote(layer, 'n2', { text: 'Same on mobile' }, AT).plan.edits, []);
  const edited = editNote(layer, 'n2', { endMs: 71000 }, AT);
  assert.deepEqual(edited.plan.edits, [{ id: 'n4', type: 'note', atMs: 70300, endMs: 71000, text: 'Same on mobile', createdAt: AT, supersedes: 'n2' }]);
  assert.throws(() => editNote(layer, 'n1', { text: 'x' }, AT), refused('edit-inactive'));
  assert.throws(() => editNote(layer, 'c2', { text: 'x' }, AT), refused('wrong-edit-type'));
  assert.throws(() => retractEdit(layer, 'x1', AT), refused('wrong-edit-type'));
  assert.throws(() => retractEdit(layer, 'n3', AT), refused('edit-inactive'));
  assert.throws(() => retractEdit(layer, 'n9', AT), refused('unknown-edit'));

  const removed = retractEdit(layer, 'n2', AT);
  const after = readLayer(await applyPlan(await fixtureFiles(), removed.plan));
  assert.deepEqual(activeNotes(after), []);
  assert.throws(() => retractEdit(after, 'n2', AT), refused('edit-inactive'));
});

test('writing a plan adds layers only: captured bytes, revisions and old edits are kept', async () => {
  const layer = readLayer(await fixtureFiles());
  const correction = correctSegment(layer, { segmentId: 's4', text: 'The export button does not work' }, AT);
  const note = addNote(readLayer(await applyPlan(await fixtureFiles(), correction.plan)), { atMs: 63000, text: 'Export broken' }, AT);
  const { before, after } = await applied({ edits: [...correction.plan.edits, ...note.plan.edits] });

  for (const [path, bytes] of before) {
    if (isCaptured(path) || path.startsWith('transcript/')) assert.deepEqual(after.get(path), bytes, path);
  }
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  const oldEdits = decode(before.get('edits.jsonl'));
  const newEdits = decode(after.get('edits.jsonl'));
  assert.ok(newEdits.startsWith(oldEdits));
  assert.equal(newEdits.slice(oldEdits.length).trim().split('\n').length, 2);

  const result = await validateBundle(memorySource(after));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.filter((w) => w.code === 'W_AGENT_STALE'),
    [],
    'agent exports regenerated',
  );
  const view = buildAgentView(result.bundle!);
  const md = decode(after.get('agent/walkthrough.md'));
  assert.match(md, /The export button does not work/);
  assert.match(md, /Export broken/);
  assert.equal(view.transcript!.correctionsApplied, 2);
});

test('an edits.jsonl without a final newline still gets one record per line', async () => {
  const files = await fixtureFiles();
  const raw = decode(files.get('edits.jsonl'));
  const trimmed = await applyPlan(files, { edits: [] });
  trimmed.set('edits.jsonl', new TextEncoder().encode(raw.trimEnd()));
  const plan = addNote(readLayer(trimmed), { atMs: 1000, text: 'start' }, AT).plan;
  // Without a refreshed manifest entry the input tree does not validate; the plan writes a fresh one.
  const after = await applyPlan(trimmed, plan);
  assert.equal(decode(after.get('edits.jsonl')), `${raw.trimEnd()}\n${JSON.stringify(plan.edits[0])}\n`);
});

test('a plan that would break the bundle is refused and nothing comes back', async () => {
  const files = await fixtureFiles();
  const bad: EditPlan = { edits: [{ id: 'c9', type: 'correction', revisionId: 'r2', segmentId: 's2', wordStart: 2, wordEnd: 3, text: 'x', createdAt: AT }] };
  await assert.rejects(applyPlan(files, bad), refused('invalid-bundle'));
  await assert.rejects(applyPlan(files, { edits: [], activeRevision: 'r9' }), refused('invalid-bundle'));
});

test('purpose: set, changed and removed through the manifest; README.md and AGENTS.md follow it', async () => {
  const files = await fixtureFiles();
  const layer = readLayer(files);
  assert.equal(layer.purpose, "Review of yesterday's dashboard changes; each thing I point at is a change request");
  assert.equal(setPurpose(layer, `  ${layer.purpose}\n`).plan.edits.length, 0);
  assert.equal(setPurpose(layer, layer.purpose!).plan.purpose, undefined, 'the same text changes nothing');

  const changed = await applyPlan(files, setPurpose(layer, '  Each box is a layout bug  ').plan);
  assert.equal(readLayer(changed).purpose, 'Each box is a layout bug');
  assert.deepEqual(changed.get('edits.jsonl'), files.get('edits.jsonl'));
  assert.match(decode(changed.get('agent/walkthrough.md')).split('\n')[2], /^- purpose="Each box is a layout bug"/);
  assert.equal(JSON.parse(decode(changed.get('agent/walkthrough.json'))).purpose, 'Each box is a layout bug');
  for (const path of ['README.md', 'AGENTS.md']) assert.match(decode(changed.get(path)), /^purpose="Each box is a layout bug"$/m, path);
  const result = await validateBundle(memorySource(changed));
  assert.deepEqual([...result.errors, ...result.warnings], []);

  const removed = await applyPlan(changed, setPurpose(readLayer(changed), '   ').plan);
  assert.equal('purpose' in JSON.parse(decode(removed.get('manifest.json'))), false);
  assert.match(decode(removed.get('README.md')), /No purpose was given/);

  assert.throws(() => setPurpose(layer, 'x'.repeat(1001)), refused('text-too-long'));
  assert.throws(() => setPurpose(layer, `use ${['sk', 'fixturefixturefixture000'].join('-')}`), refused('credential'));
  assert.throws(() => setPurpose(layer, 'Bearer not-a-real-token'), refused('credential'));
});
