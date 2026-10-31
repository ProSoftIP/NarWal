// The chosen transcription for the recording in progress (board #16570).
// "On this computer" (offline) runs Vosk live on the microphone PCM tap; the
// strip reads its state and new text through the offscreen status reply.
// OpenAI is after-recording: nothing runs while recording. Deepgram and
// AssemblyAI are not offered in v1 (Matt, q3549 correction 2026-10-13
// 22:23Z: "I meant open ai or on this computer").
//
// Final segments and gaps are saved as they arrive, so a restarted recorder
// loses only the words that were still interim. Stop turns them into one
// immutable live revision in the recording's transcript history
// (transcription/src/revisions.ts), the same history OpenAI adds to.
import { UiTranscriptTracker } from '../../../offline-transcription/src/status.ts';
import { LiveRevisionCollector } from '../../../offline-transcription/src/revisions.ts';
import { LOCAL_PROVIDER } from '../../../offline-transcription/src/contract.ts';
import { addRevision } from '../../../transcription/src/revisions.ts';

const SAMPLE_RATE = 16000;
// A jump in the PCM clock larger than this starts a new engine session, so
// text never lands at the wrong time.
const DISCONTINUITY_MS = 2000;
// Audio held while the engine loads its model (100 ms blocks, 5 minutes).
const MAX_PENDING_BLOCKS = 3000;
// Events kept for the strip. Superseded interim text is dropped, so this
// holds about this many final lines and gaps.
const MAX_EVENTS = 5000;

const OFF_DETAIL = 'This choice is not available yet. Choose On this computer or OpenAI.';

/**
 * @param {object} deps
 * @param {(fn: (chunk: {pcm: Int16Array, startMs: number}) => void) => () => void} deps.addPcmConsumer
 * @param {() => Promise<{startLive: Function}>} deps.openOffline  the OfflineTranscriber, created once
 * @param {object} deps.store  persistence for one recording's transcript (see main.js):
 *   nextEntrySeq(id), putEntry(id, seq, entry), readEntries(id) for the lines
 *   saved while recording; updateHistory(id, change) applies a pure change to
 *   the saved TranscriptHistory and returns the new one
 * @param {() => number} [deps.now]  epoch ms, for revision timestamps
 * @param {string} [deps.boot]  unique per offscreen document
 * @param {(err: unknown, where: string) => void} [deps.onError]
 */
export function createTranscriptHost({ addPcmConsumer, openOffline, store, now = Date.now, boot = crypto.randomUUID().slice(0, 8), onError = () => {} }) {
  let rec = null;
  let epochs = 0;

  function uiState() {
    if (!rec) return undefined;
    if (rec.choice === 'openai') return { state: 'after-recording' };
    if (rec.choice !== 'offline') return { state: 'off', detail: OFF_DETAIL };
    // No engine session yet (before the first audio, after "Try again") or
    // one still loading its model.
    if (!rec.stopping && (!rec.session || !rec.session.seen)) return { state: rec.connections > 0 ? 'reconnecting' : 'connecting' };
    const t = rec.tracker.get();
    if (t.state === 'live' && t.reasonCode === 'catching-up') return { state: 'behind', detail: t.reason };
    return t.reason ? { state: t.state, detail: t.reason } : { state: t.state };
  }

  function push(r, event) {
    r.seq += 1;
    if (event.type === 'segment') {
      // A newer version of the same line replaces the interim one.
      const key = event.segment.segmentKey;
      for (let i = r.log.length - 1; i >= 0; i -= 1) {
        const old = r.log[i].event;
        if (old.type === 'segment' && old.segment.segmentKey === key) {
          if (old.segment.kind === 'interim') r.log.splice(i, 1);
          break;
        }
      }
    }
    r.log.push({ seq: r.seq, event });
    if (r.log.length > MAX_EVENTS) r.log.splice(0, r.log.length - MAX_EVENTS);
  }

  function save(own, entry) {
    const seq = own.saveSeq++;
    own.saved.push(entry);
    own.writes = own.writes
      .then(() => store.putEntry(own.id, seq, entry))
      .catch((err) => {
        own.saveFailed = true;
        onError(err, 'save');
      });
  }

  function onEvent(own, holder, event) {
    if (own !== rec) return;
    holder.seen = true;
    // A session that is finishing still adds its last text; only the newest
    // session sets the state the strip shows.
    if (holder === own.session) own.tracker.onEvent(event);
    if (event.type === 'segment') {
      const s = event.segment;
      push(own, { type: 'segment', segment: { segmentKey: s.segmentKey, kind: s.kind, startMs: s.startMs, endMs: s.endMs, text: s.text } });
      if (s.kind === 'final' && s.text) save(own, { type: 'segment', segment: s });
    } else if (event.type === 'gap') {
      addGap(own, event.gap);
    }
  }

  function addGap(own, gap) {
    push(own, { type: 'gap', gap: { startMs: gap.startMs, endMs: gap.endMs, reason: gap.reason } });
    save(own, { type: 'gap', gap });
  }

  // Starts an engine session whose first sample is `originMs`. Audio that
  // arrives while the model loads waits in `pending`.
  function openSession(own, originMs) {
    own.connections += 1;
    const connectionId = `${own.id}.${boot}.${own.connections}`;
    const holder = { originMs, endMs: originMs, live: null, failed: false, seen: false, done: false, pending: [] };
    own.session = holder;
    own.tracker = new UiTranscriptTracker();
    holder.ready = openOffline()
      .then((transcriber) => transcriber.startLive({ language: 'en', audioOriginMs: originMs, connectionId }, (event) => holder.done || onEvent(own, holder, event)))
      .then(
        (live) => {
          holder.live = live;
          for (const data of holder.pending) live.sendAudio(data);
          holder.pending = [];
        },
        (err) => {
          // startLive reports a missing model or a broken engine as events;
          // a rejection means the engine code itself could not load.
          holder.failed = true;
          holder.seen = true;
          holder.pending = [];
          if (own === rec && holder === own.session) {
            own.tracker.onEvent({ type: 'error', error: { kind: 'provider', code: 'engine-failed', message: String((err && err.message) || err) } });
            own.tracker.onEvent({ type: 'state', state: 'closed' });
          }
          onError(err, 'start');
        },
      );
  }

  // Ends one engine session. Its unfinished audio becomes a gap.
  async function closeSession(own, holder) {
    if (own.session === holder) own.session = null;
    await holder.ready;
    if (holder.failed) {
      if (holder.endMs > holder.originMs) addGap(own, { provider: LOCAL_PROVIDER, startMs: holder.originMs, endMs: holder.endMs, reason: 'engine-failed', detail: 'the offline engine did not load' });
    } else {
      try {
        await holder.live.finish();
      } catch (err) {
        onError(err, 'finish');
      }
    }
    holder.done = true;
  }

  function retire(own) {
    const holder = own.session;
    if (!holder) return Promise.resolve();
    const closing = closeSession(own, holder);
    own.closing.add(closing);
    return closing.finally(() => own.closing.delete(closing));
  }

  function onPcm(own, chunk) {
    if (own !== rec || own.stopping) return;
    if (own.firstMs === null) {
      own.firstMs = chunk.startMs;
      if (own.resumeFromMs !== null && chunk.startMs - own.resumeFromMs > DISCONTINUITY_MS) {
        addGap(own, { provider: LOCAL_PROVIDER, startMs: own.resumeFromMs, endMs: chunk.startMs, reason: 'engine-failed', detail: 'recorder restarted' });
      }
    }
    if (own.session && chunk.startMs - own.session.endMs > DISCONTINUITY_MS) void retire(own);
    if (!own.session) openSession(own, chunk.startMs);
    const holder = own.session;
    holder.endMs = chunk.startMs + (chunk.pcm.length / SAMPLE_RATE) * 1000;
    if (holder.failed) return;
    const pcm = chunk.pcm;
    const data = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    if (holder.live) holder.live.sendAudio(data);
    else {
      holder.pending.push(data);
      if (holder.pending.length > MAX_PENDING_BLOCKS) holder.pending.shift();
    }
  }

  async function finishRecording(own) {
    if (own.unsubscribe) own.unsubscribe();
    await retire(own);
    await Promise.all([...own.closing]);
    await own.writes;
    let history = null;
    if (own.choice === 'offline' && own.firstMs !== null) {
      // Every saved entry of this recording, so a resumed recorder's revision
      // also holds what the earlier recorder saved.
      const entries = await store.readEntries(own.id).catch((err) => (onError(err, 'entries'), []));
      const seen = new Set(entries.map(entryKey));
      for (const e of own.saved) if (!seen.has(entryKey(e))) entries.push(e);
      // The history gives the revision its ID.
      const collector = new LiveRevisionCollector({ revisionId: 'live', createdAtMs: now() });
      for (const e of entries) collector.onEvent(e);
      const revision = collector.revision();
      history = await store.updateHistory(own.id, (h) => addRevision(h, revision, { activate: h.activeRevision === null }));
    }
    return {
      choice: own.choice,
      activeRevision: history ? history.activeRevision : null,
      revisions: history ? history.revisions.map((r) => ({ revisionId: r.revisionId, source: r.source, provider: r.provider, model: r.model, createdAt: r.createdAt, segments: r.segments.length, gaps: r.gaps.length })) : [],
      ...(own.saveFailed ? { saveError: true } : {}),
    };
  }

  return {
    /** A recording starts (or a restarted recorder resumes it) with this choice. */
    async start({ recordingId, choice, resume }) {
      if (rec) await this.stop();
      epochs += 1;
      const own = {
        id: recordingId,
        choice: choice || 'offline',
        epoch: `${boot}.${epochs}`,
        seq: 0,
        log: [],
        tracker: new UiTranscriptTracker(),
        session: null,
        closing: new Set(),
        connections: 0,
        firstMs: null,
        resumeFromMs: null,
        stopping: false,
        saved: [],
        saveSeq: 0,
        writes: Promise.resolve(),
        saveFailed: false,
        unsubscribe: null,
        stopped: null,
      };
      rec = own;
      if (own.choice !== 'offline') return;
      own.saveSeq = await store.nextEntrySeq(recordingId);
      if (resume) {
        const before = await store.readEntries(recordingId);
        own.resumeFromMs = before.reduce((at, e) => Math.max(at, (e.segment || e.gap).endMs), 0) || null;
      }
      if (own !== rec) return;
      own.unsubscribe = addPcmConsumer((chunk) => onPcm(own, chunk));
    },

    /** The strip's "Try again": a new session on the same provider. */
    async retry() {
      const own = rec;
      if (!own || own.choice !== 'offline' || own.stopping) return { ok: false, error: 'nothing to retry' };
      if (uiState().state !== 'disconnected') return { ok: true, transcript: uiState() };
      // The next PCM block opens the new session at its own time; the old
      // one finishes alongside and records its untranscribed audio as a gap.
      void retire(own);
      return { ok: true, transcript: uiState() };
    },

    /**
     * Ends the live session and saves the live revision. Returns the
     * recording's transcript summary for its meta (`meta.transcript`).
     */
    async stop() {
      const own = rec;
      if (!own) return null;
      if (own.stopped) return own.stopped;
      own.stopping = true;
      own.stopped = finishRecording(own);
      return own.stopped;
    },

    /** The status reply's transcript fields; events after `cursor`. */
    status(cursor) {
      const own = rec;
      if (!own) return {};
      let after = -1;
      if (typeof cursor === 'string') {
        const cut = cursor.lastIndexOf(':');
        if (cursor.slice(0, cut) === own.epoch) after = Number(cursor.slice(cut + 1));
      }
      const transcriptEvents = own.log.filter((e) => e.seq > after).map((e) => e.event);
      return { transcription: own.choice, transcript: uiState(), transcriptEvents, transcriptCursor: `${own.epoch}:${own.seq}` };
    },

    get recordingId() {
      return rec ? rec.id : null;
    },
  };
}

function entryKey(e) {
  const x = e.segment || e.gap;
  return `${e.type}:${x.segmentKey || ''}:${x.startMs}:${x.endMs}`;
}
