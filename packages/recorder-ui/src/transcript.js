// The live transcript as the strip shows it: settled text, the words still
// changing, and the stretches a provider never transcribed. It is a view of
// the adapter events, not the stored transcript (the bundle owns that).

export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Reasons from contract.ts GapReason and docs/bundle-schema.md §8.1. An
// unknown reason is shown as it came.
const GAP_WORDS = {
  'connect-failed': 'could not connect',
  disconnected: 'connection lost',
  'provider-error': 'provider error',
  'rate-limited': 'provider limit reached',
  'auth-failed': 'key was refused',
  'user-stopped-provider': 'transcript stopped by you',
  'not-transcribed': 'not transcribed',
};

export function createTranscript() {
  /** @type {Map<string, {segmentKey:string, kind:string, startMs:number, endMs:number, text:string}>} */
  const segments = new Map();
  /** @type {Array<{startMs:number, endMs:number, reason:string}>} */
  const gaps = [];

  return {
    /** @param {import('./port.js').RecorderEvent} event */
    apply(event) {
      if (event.type === 'segment') {
        const s = event.segment;
        const prior = segments.get(s.segmentKey);
        // A late interim must not replace text that already settled.
        if (prior && prior.kind === 'final' && s.kind !== 'final') return false;
        segments.set(s.segmentKey, s);
        return true;
      }
      if (event.type === 'gap') {
        gaps.push(event.gap);
        return true;
      }
      return false;
    },
    clear() {
      segments.clear();
      gaps.length = 0;
    },
    /** In time order. */
    lines() {
      const out = [];
      for (const s of segments.values()) {
        if (s.text && s.text.trim()) out.push({ kind: s.kind === 'final' ? 'final' : 'interim', startMs: s.startMs, endMs: s.endMs, text: s.text.trim() });
      }
      for (const g of gaps) {
        out.push({
          kind: 'gap',
          startMs: g.startMs,
          endMs: g.endMs,
          text: `No transcript from ${formatClock(g.startMs)} to ${formatClock(g.endMs)}: ${GAP_WORDS[g.reason] || g.reason}. The recording has this part.`,
        });
      }
      return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    },
    /** The newest words, for the one-line strip. */
    tail(maxChars = 240) {
      const words = this.lines()
        .filter((l) => l.kind !== 'gap')
        .map((l) => l.text)
        .join(' ');
      return words.length > maxChars ? `…${words.slice(words.length - maxChars)}` : words;
    },
  };
}
