// Review of NarWal#29 (board #16588): an export made before the transcript
// arrived locked every later export out of it, because later exports pack the
// library copy of the first one. transcriptRefresh says when that copy takes
// the transcript the recording has now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptRefresh } from '../../src/export/refresh.js';

const enc = new TextEncoder();
const bytes = (text) => enc.encode(text);

function tree({ active = null, revisions = [], edits = null } = {}) {
  const files = new Map([
    ['manifest.json', bytes(JSON.stringify({ recordingId: 'rec-1', transcript: { activeRevision: active } }))],
    ['documents.json', bytes('{"documents":[]}')],
  ]);
  for (const id of revisions) files.set(`transcript/${id}.json`, bytes(JSON.stringify({ revisionId: id })));
  if (edits !== null) files.set('edits.jsonl', bytes(edits));
  return files;
}

test('exported before the transcript arrived: the copy takes it', () => {
  assert.equal(transcriptRefresh(tree(), tree({ active: 'openai-1', revisions: ['openai-1'] })), 'refresh');
});

test('a Try again revision made after the first export: the copy takes it', () => {
  const stored = tree({ active: 'openai-1', revisions: ['openai-1'] });
  assert.equal(transcriptRefresh(stored, tree({ active: 'openai-2', revisions: ['openai-1', 'openai-2'] })), 'refresh');
  // Saved but not activated (it has a gap): still added.
  assert.equal(transcriptRefresh(stored, tree({ active: 'openai-1', revisions: ['openai-1', 'openai-2'] })), 'refresh');
});

test('nothing newer: the copy is exported as it is, with or without its own edits', () => {
  const fresh = tree({ active: 'openai-1', revisions: ['openai-1'] });
  assert.equal(transcriptRefresh(tree({ active: 'openai-1', revisions: ['openai-1'] }), fresh), 'current');
  assert.equal(transcriptRefresh(tree({ active: 'openai-1', revisions: ['openai-1'], edits: '{"id":"e1"}\n' }), fresh), 'current');
  assert.equal(transcriptRefresh(tree(), tree()), 'current');
});

test('a copy the user corrected or annotated keeps what it has', () => {
  const fresh = tree({ active: 'openai-2', revisions: ['openai-1', 'openai-2'] });
  assert.equal(transcriptRefresh(tree({ active: 'openai-1', revisions: ['openai-1'], edits: '{"id":"e1"}\n' }), fresh), 'edited');
  // A revision the replay page added.
  assert.equal(transcriptRefresh(tree({ active: 'r2', revisions: ['openai-1', 'r2'] }), fresh), 'edited');
  // Edits the recording itself holds are not the user's work in the copy.
  const carried = tree({ active: 'openai-2', revisions: ['openai-1', 'openai-2'], edits: '{"id":"e1"}\n{"id":"e2"}\n' });
  assert.equal(transcriptRefresh(tree({ active: 'openai-1', revisions: ['openai-1'], edits: '{"id":"e1"}\n' }), carried), 'refresh');
});
