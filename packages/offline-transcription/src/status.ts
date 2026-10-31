// What the recorder UI shows for the offline option (board #16544, for the
// provider selection UI of #16551). The offline option has no API key.

import type { AdapterEvent } from './contract.ts';
import type { ModelStatus } from './model-store.ts';

export type UiModelState = 'missing' | 'downloading' | 'ready' | 'failed';

export interface UiOfflineModel {
  state: UiModelState;
  bytesDone: number;
  bytesTotal: number;
  /** Stable code for `failed`: `model-corrupt`, `download-failed`, `hash-mismatch`, `aborted`. */
  reasonCode?: string;
  reason?: string;
}

/** Folds the live and final model into the one state the UI shows. */
export function uiOfflineModel(statuses: ModelStatus[]): UiOfflineModel {
  const bytesDone = statuses.reduce((sum, status) => sum + status.bytesDone, 0);
  const bytesTotal = statuses.reduce((sum, status) => sum + status.bytesTotal, 0);
  const corrupt = statuses.find((status) => status.state === 'corrupt');
  if (corrupt) {
    return { state: 'failed', bytesDone, bytesTotal, reasonCode: 'model-corrupt', reason: 'A downloaded model file is damaged. Repair downloads it again.' };
  }
  if (statuses.some((status) => status.state === 'downloading')) return { state: 'downloading', bytesDone, bytesTotal };
  const failed = statuses.find((status) => status.state === 'failed');
  if (failed) {
    return { state: 'failed', bytesDone, bytesTotal, reasonCode: failed.error?.code ?? 'download-failed', reason: failed.error?.message ?? 'The download did not finish.' };
  }
  if (statuses.length > 0 && statuses.every((status) => status.state === 'ready')) return { state: 'ready', bytesDone, bytesTotal };
  return { state: 'missing', bytesDone, bytesTotal };
}

export type UiTranscriptState = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export interface UiTranscript {
  state: UiTranscriptState;
  /** `catching-up`, `model-missing`, `model-corrupt`, `engine-failed`, `stopped` or empty. */
  reasonCode: string;
  reason: string;
  lagMs: number;
}

const REASONS: Record<string, string> = {
  'model-missing': 'The offline model is not downloaded. Recording continues; transcribe later.',
  'model-corrupt': 'The offline model is damaged. Recording continues; repair the model, then transcribe.',
  'engine-failed': 'Offline transcription stopped. Recording continues; transcribe later.',
  stopped: 'Stopped.',
};

/** Folds a live session's events into the transcript state the UI shows. */
export class UiTranscriptTracker {
  private current: UiTranscript = { state: 'disconnected', reasonCode: '', reason: '', lagMs: 0 };
  private wasOpen = false;
  private lastError = '';

  onEvent = (event: AdapterEvent): void => {
    if (event.type === 'error') {
      this.lastError = event.error.kind === 'model' ? event.error.code : 'engine-failed';
    } else if (event.type === 'backlog') {
      if (this.current.state !== 'live') return;
      this.current = event.behind
        ? { state: 'live', reasonCode: 'catching-up', reason: `Catching up (${Math.round(event.lagMs / 1000)} s behind). Nothing is lost.`, lagMs: event.lagMs }
        : { state: 'live', reasonCode: '', reason: '', lagMs: event.lagMs };
    } else if (event.type === 'state') {
      if (event.state === 'connecting') {
        this.current = { state: this.wasOpen || this.lastError ? 'reconnecting' : 'connecting', reasonCode: this.lastError, reason: '', lagMs: 0 };
      } else if (event.state === 'open') {
        this.wasOpen = true;
        this.lastError = '';
        this.current = { state: 'live', reasonCode: '', reason: '', lagMs: 0 };
      } else if (event.state === 'closed') {
        const code = this.lastError || 'stopped';
        this.current = { state: 'disconnected', reasonCode: code, reason: REASONS[code] ?? REASONS.stopped, lagMs: 0 };
      }
    }
  };

  get(): UiTranscript {
    return this.current;
  }
}
