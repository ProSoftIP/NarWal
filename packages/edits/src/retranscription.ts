// A new transcript revision arriving after the user corrected the old one
// (docs/bundle-schema.md §8.1, §8.2). The comparison of corrections with the
// new revision is the one the transcription package uses
// (packages/transcription/src/revisions.ts, planCarryForward), so a
// correction is carried only to the words it was written for.
//
// What this layer adds: when any correction conflicts with the new revision,
// the new revision is stored but does not become the one the user reads. The
// user keeps their corrected transcript until they decide, per conflict,
// whether to keep their text on the new revision or take the new words.
// Nothing is dropped either way: old corrections stay on their own revision.

import type { TranscriptRevision } from '../../bundle/src/types.ts';
import type { TranscriptRevision as ProviderRevision } from '../../transcription/src/contract.ts';
import { planCarryForward, toStoredRevision } from '../../transcription/src/revisions.ts';
import type { CarryItem, StoredEdit, StoredRevision, TranscriptHistory } from '../../transcription/src/revisions.ts';
import { assertNoOverlap, segmentCorrections } from './corrections.ts';
import { EditError } from './errors.ts';
import { findRevision, idSource, MAX_REVISIONS, nextId } from './layer.ts';
import type { Correction, EditLayer, EditPlan } from './layer.ts';

export type { CarryItem } from '../../transcription/src/revisions.ts';

function history(layer: EditLayer, extra?: TranscriptRevision): TranscriptHistory {
  const revisions = extra ? [...layer.revisions, extra] : layer.revisions;
  return {
    recordingId: layer.recordingId,
    version: 0,
    revisions: revisions as StoredRevision[],
    activeRevision: layer.activeRevision,
    edits: layer.edits as StoredEdit[],
    pending: null,
    usedConsents: [],
  };
}

function plan(layer: EditLayer, from: string, to: string, extra?: TranscriptRevision): CarryItem[] {
  return planCarryForward(history(layer, extra), from, to);
}

function carried(newId: (prefix: 'c') => string, item: CarryItem, revisionId: string, at: string): Correction {
  return {
    id: newId('c'),
    type: 'correction',
    revisionId,
    ...(item.target as NonNullable<CarryItem['target']>),
    text: item.correction.text,
    createdAt: at,
    carriedFrom: item.correction.id,
  };
}

/** Planned corrections must not overlap each other or what is already on the target revision. */
function assertDisjoint(layer: EditLayer, revisionId: string, added: readonly Correction[]): void {
  const seen = new Map<string, Correction[]>();
  for (const c of added) {
    const existing = seen.get(c.segmentId) ?? segmentCorrections(layer, revisionId, c.segmentId);
    assertNoOverlap(existing, c);
    seen.set(c.segmentId, [...existing, c]);
  }
}

export interface RetranscriptionResult {
  plan: EditPlan;
  revisionId: string;
  /** False when the user stays on the revision they were reading. */
  activated: boolean;
  /**
   * Why it was not activated. `conflicts`: some corrections differ from the
   * new words. `incomplete`: the new revision has a gap (a failed upload) and
   * would drop text the user reads, as in `completeRetranscription`.
   */
  notActivated?: 'conflicts' | 'incomplete';
  /** Every active correction of the previous revision: carried, redundant or conflict. */
  items: CarryItem[];
  conflicts: CarryItem[];
}

/**
 * Stores a provider's new transcript as a new revision. Corrections that
 * match the new words are carried (new corrections with `carriedFrom`).
 * With no conflict the new revision becomes active; with any conflict, or a
 * gap, the active revision stays as it is and `conflicts` lists what the user
 * must decide (`resolveRetranscription`). A revision the provider adapter
 * should never return throws `InvalidRevision` from the transcription package.
 */
export function addRetranscription(layer: EditLayer, revision: ProviderRevision, options: { at: string; language?: string }): RetranscriptionResult {
  if (layer.revisions.length >= MAX_REVISIONS) {
    throw new EditError('revision-limit', `A recording holds at most ${MAX_REVISIONS} transcript revisions`);
  }
  if (revision.supersedes !== undefined) findRevision(layer, revision.supersedes);
  const revisionId = nextId(
    'r',
    layer.revisions.map((r) => r.revisionId),
  );
  const stored = toStoredRevision(revision, revisionId, options.language) as TranscriptRevision;
  const previous = layer.activeRevision;
  if (previous === null) {
    return { plan: { edits: [], revision: stored, activeRevision: revisionId }, revisionId, activated: true, items: [], conflicts: [] };
  }
  const items = plan(layer, previous, revisionId, stored);
  const newId = idSource(layer);
  const edits = items.filter((item) => item.outcome === 'carried').map((item) => carried(newId, item, revisionId, options.at));
  const conflicts = items.filter((item) => item.outcome === 'conflict');
  const notActivated = conflicts.length > 0 ? 'conflicts' : stored.gaps.length > 0 ? 'incomplete' : undefined;
  const activated = notActivated === undefined;
  return {
    plan: { edits, revision: stored, ...(activated ? { activeRevision: revisionId } : {}) },
    revisionId,
    activated,
    ...(notActivated ? { notActivated } : {}),
    items,
    conflicts,
  };
}

export interface WaitingRevision {
  revisionId: string;
  provider: string;
  model: string;
  createdAt: string;
  /** The revision has a gap: text the active one has may be missing. */
  incomplete: boolean;
  /** Corrections on the active revision that differ from this one. */
  conflicts: CarryItem[];
}

/**
 * Revisions newer than the one the user reads, with their conflicts. A
 * retranscription that stopped on a conflict is listed here after reopen,
 * export and import: the state lives in the bundle, not in memory.
 */
export function waitingRevisions(layer: EditLayer): WaitingRevision[] {
  const active = layer.activeRevision;
  if (active === null) return [];
  const current = findRevision(layer, active);
  return layer.revisions
    .filter((r) => r.revisionId !== active && r.createdAt > current.createdAt)
    .map((r) => ({
      revisionId: r.revisionId,
      provider: r.provider,
      model: r.model,
      createdAt: r.createdAt,
      incomplete: r.gaps.length > 0,
      conflicts: plan(layer, active, r.revisionId).filter((item) => item.outcome === 'conflict'),
    }));
}

/** Per conflicting correction ID: keep the user's text on the new words, or take the new words. */
export type ConflictDecision = 'keep-mine' | 'take-new';

/**
 * Switches the user to `revisionId` with a decision for every conflict.
 * `keep-mine` writes the user's text onto the matching words of the new
 * revision (a correction with `carriedFrom`); it needs those words to sit in
 * one segment with no correction on them yet. `take-new` writes nothing: the
 * old correction stays on its own revision. Corrections that now match are
 * carried as usual.
 */
export function resolveRetranscription(
  layer: EditLayer,
  revisionId: string,
  decisions: Readonly<Record<string, ConflictDecision>>,
  at: string,
): { plan: EditPlan; kept: string[]; taken: string[] } {
  findRevision(layer, revisionId);
  const previous = layer.activeRevision;
  if (previous === null || previous === revisionId) {
    throw new EditError('nothing-to-resolve', `Revision "${revisionId}" is already the one the user reads`, { revisionId });
  }
  const items = plan(layer, previous, revisionId);
  const undecided = items.filter((item) => item.outcome === 'conflict' && decisions[item.correction.id] === undefined);
  if (undecided.length > 0) {
    throw new EditError('undecided', 'Every conflicting correction needs a decision', {
      corrections: undecided.map((item) => item.correction.id),
    });
  }
  const newId = idSource(layer);
  const edits: Correction[] = [];
  const kept: string[] = [];
  const taken: string[] = [];
  for (const item of items) {
    if (item.outcome === 'carried') edits.push(carried(newId, item, revisionId, at));
    if (item.outcome !== 'conflict') continue;
    const decision = decisions[item.correction.id];
    if (decision === 'take-new') {
      taken.push(item.correction.id);
    } else if (decision === 'keep-mine') {
      if (item.reason !== 'text-changed' || !item.target) {
        throw new EditError('cannot-keep', `Correction "${item.correction.id}" has no single place in the new transcript (${item.reason}); take the new words, then correct them`, {
          editId: item.correction.id,
          reason: item.reason,
        });
      }
      edits.push(carried(newId, item, revisionId, at));
      kept.push(item.correction.id);
    } else {
      throw new EditError('undecided', `Decision for "${item.correction.id}" must be keep-mine or take-new`, { editId: item.correction.id });
    }
  }
  assertDisjoint(layer, revisionId, edits);
  return { plan: { edits, activeRevision: revisionId }, kept, taken };
}
