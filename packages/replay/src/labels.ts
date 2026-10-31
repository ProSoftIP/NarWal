// Plain-language text for replay. Page text from a bundle is never put here;
// callers set every string with textContent.

import type { ReplayGap, ReplayWindow } from './model.ts';

const REASON_TEXT: Record<string, string> = {
  'restricted-page': 'This page cannot be recorded by an extension.',
  'navigation-blind-window': 'The page was changing to the next one.',
  'lost-messages': 'Some page changes did not arrive; the page may look incomplete.',
  'injection-failed': 'The recorder could not attach to this page.',
  'recorder-paused': 'Recording was paused.',
  'tab-hidden': 'The tab was hidden; page changes may be late.',
  'cross-origin-frame': 'Part of the page from another site was not recorded.',
  'closed-shadow-root': 'Part of the page was closed to the recorder.',
  'canvas-not-recorded': 'Drawings on a canvas were not recorded.',
  'mic-denied': 'The microphone was blocked.',
  'mic-track-ended': 'The microphone stopped (blocked or unplugged).',
  'mic-device-lost': 'No microphone was available.',
  'recorder-error': 'The audio recorder failed.',
  'recovery-truncated': 'Nothing was saved here.',
  'no-page-evidence': 'No page was recorded for this time.',
  'no-narration': 'No narration was recorded.',
  'connect-failed': 'The transcription service could not be reached.',
  disconnected: 'The transcription service disconnected.',
  'provider-error': 'The transcription service failed.',
  'rate-limited': 'The transcription service refused more audio for a while.',
  'auth-failed': 'The transcription service refused the key.',
  'user-stopped-provider': 'Transcription was stopped.',
  'not-transcribed': 'This audio was not transcribed.',
};

const EFFECT_TEXT: Record<ReplayGap['effect'], string> = {
  'no-page': 'No page',
  'partial-page': 'Page incomplete',
  'no-audio': 'No narration',
  'no-transcript': 'No transcript',
};

/** One line for a gap: what is missing, then why. */
export function describeGap(gap: ReplayGap): string {
  const why = REASON_TEXT[gap.reason] ?? `Reason: ${gap.reason}.`;
  return `${EFFECT_TEXT[gap.effect]}: ${why}${gap.detail ? ` (${gap.detail})` : ''}`;
}

/**
 * Which window the stage shows, e.g. `Window 2 of 2: popup opened from window 1`.
 * Empty for a recording of one window.
 */
export function describeWindow(windows: readonly ReplayWindow[], key: string | null): string {
  const w = windows.find((x) => x.key === key);
  if (!w) return '';
  const opener = windows.find((x) => x.key === w.opener);
  const kind = w.type === 'popup' ? 'popup' : 'tab';
  const how = opener ? `${kind} opened from window ${opener.number}` : `the ${kind} the recording started in`;
  return `Window ${w.number} of ${windows.length}: ${how}`;
}

/** `M:SS.t` for the replay clock. */
export function clock(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const s = Math.floor(tenths / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`;
}
