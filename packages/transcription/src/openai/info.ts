// What the user is told before an OpenAI upload: timing, cost and limits (board #16547).
// Prices and limits were read on OPENAI_WHISPER_INFO.checkedOn; they are list values, not a quote.

import { OPENAI_MAX_UPLOAD_BYTES, OPENAI_TIMED_MODEL } from './api.ts';

export const OPENAI_WHISPER_INFO = {
  provider: 'openai',
  model: OPENAI_TIMED_MODEL,
  /** The audio is uploaded after the recording stops. This adapter has no live mode. */
  timing: 'after-recording',
  liveTranscript: false,
  wordTimestamps: true,
  usdPerAudioMinute: 0.006,
  maxUploadBytes: OPENAI_MAX_UPLOAD_BYTES,
  /** whisper-1 requests per minute: free tier, then the first paid tier. */
  requestsPerMinute: { free: 3, paid: 2500 },
  checkedOn: '2026-10-13',
  sources: [
    'https://developers.openai.com/api/docs/guides/speech-to-text',
    'https://developers.openai.com/api/docs/pricing',
    'https://developers.openai.com/api/docs/guides/rate-limits',
  ],
} as const;

/** List-price estimate. Overlap between uploads is billed twice, so pass the uploaded total. */
export function estimateOpenAiCostUsd(uploadedAudioMs: number): number {
  return (Math.max(0, uploadedAudioMs) / 60_000) * OPENAI_WHISPER_INFO.usdPerAudioMinute;
}

const formatUsd = (usd: number) => (usd > 0 && usd < 0.01 ? 'less than $0.01' : `about $${usd.toFixed(2)}`);

const formatMinutes = (ms: number) => {
  const minutes = ms / 60_000;
  return minutes < 1 ? 'under 1 minute' : `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
};

export interface OpenAiUploadSummary {
  /** Length of the narration, when known before the upload. */
  durationMs: number | null;
  /** Audio that will be sent, overlap included. */
  uploadedAudioMs: number | null;
  uploads: number;
  /** True when the recording already has an OpenAI transcript. */
  retranscription: boolean;
}

/**
 * Lines for the consent prompt. They state that the transcript arrives after
 * the upload; nothing here offers live output.
 */
export function describeOpenAiUpload(summary: OpenAiUploadSummary) {
  const { usdPerAudioMinute, requestsPerMinute } = OPENAI_WHISPER_INFO;
  const length = summary.durationMs === null ? 'this recording' : `${formatMinutes(summary.durationMs)} of narration`;
  const cost =
    summary.uploadedAudioMs === null
      ? `OpenAI charges your key $${usdPerAudioMinute} per minute of audio.`
      : `OpenAI charges your key ${formatUsd(estimateOpenAiCostUsd(summary.uploadedAudioMs))} for ${length} ($${usdPerAudioMinute} per minute of audio).`;
  return {
    title: summary.retranscription ? 'Transcribe again with OpenAI' : 'Transcribe with OpenAI',
    timing:
      'Works after you stop recording. Your narration audio is uploaded to OpenAI, and the transcript with word timing arrives when the upload finishes. There is no live transcript with this option.',
    upload:
      summary.uploads > 1
        ? `The audio is sent in ${summary.uploads} parts, one at a time, because OpenAI accepts at most 25 MB per file.`
        : 'The audio is sent as one file. OpenAI accepts at most 25 MB per file.',
    cost: summary.retranscription
      ? `${cost} This is charged again each time you transcribe again.`
      : cost,
    limits: `OpenAI limits free-tier keys to ${requestsPerMinute.free} uploads per minute. NarWal waits and retries when OpenAI asks it to.`,
    scope: 'Only the narration audio is uploaded. The page capture stays on this device.',
    revision: summary.retranscription
      ? 'The new transcript is saved as a new revision. The recording, earlier transcripts and your corrections are kept.'
      : 'The transcript is saved as a new revision. The recording is not changed.',
  };
}
