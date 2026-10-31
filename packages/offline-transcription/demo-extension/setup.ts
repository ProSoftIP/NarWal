// Setup page of the proof extension (board #16544): explicit model download,
// readiness, integrity check, repair and removal. The product UI is slice
// #16551; this page only proves the behaviour behind it.

import { MODELS } from '../src/models.ts';
import type { ModelStatus } from '../src/model-store.ts';
import { PROOF_MODELS, getOffline, runSelftest } from './selftest.ts';

declare const chrome: { runtime: { sendMessage(message: unknown): Promise<any> } };

const { transcriber } = getOffline();
const root = document.getElementById('models')!;
const summary = document.getElementById('summary')!;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

const STATE_TEXT: Record<string, string> = {
  missing: 'Not downloaded',
  downloading: 'Downloading',
  ready: 'Ready',
  corrupt: 'Damaged',
  failed: 'Download failed',
};

function render(status: ModelStatus): void {
  const manifest = MODELS[status.id];
  let card = document.getElementById(`model-${status.id}`);
  if (!card) {
    card = document.createElement('section');
    card.className = 'model';
    card.id = `model-${status.id}`;
    card.innerHTML = `<h2></h2><div class="meta"></div><progress max="1" value="0"></progress><div><span class="state"></span> <span class="detail meta"></span></div><p></p>`;
    const buttons = card.querySelector('p')!;
    const actions: [string, string, () => Promise<unknown>][] = [
      ['download', 'Download', () => transcriber.models.install(status.id, { onProgress: render })],
      ['check', 'Check files', () => transcriber.models.verify(status.id)],
      ['repair', 'Repair', () => transcriber.models.repair(status.id, { onProgress: render })],
      ['remove', 'Remove', () => transcriber.models.remove(status.id)],
    ];
    for (const [name, label, action] of actions) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.action = name;
      button.addEventListener('click', async () => {
        try {
          await action();
        } catch {
          // The failed state and its reason are rendered from the status below.
        }
        await refresh();
      });
      buttons.append(button);
    }
    root.append(card);
  }
  card.querySelector('h2')!.textContent = manifest.label;
  card.querySelector('.meta')!.textContent = `${megabytes(status.bytesTotal)} · ${manifest.licence}`;
  (card.querySelector('progress') as HTMLProgressElement).value = status.bytesTotal ? status.bytesDone / status.bytesTotal : 0;
  const state = card.querySelector('.state') as HTMLElement;
  state.dataset.state = status.state;
  state.textContent = STATE_TEXT[status.state] + (status.state === 'ready' && status.verified ? ' (verified)' : '');
  card.querySelector('.detail')!.textContent =
    status.state === 'downloading'
      ? `${megabytes(status.bytesDone)} of ${megabytes(status.bytesTotal)}`
      : status.state === 'corrupt'
        ? `Failed the integrity check: ${status.badFiles.join(', ')}. Repair downloads only these files.`
        : status.state === 'failed'
          ? (status.error?.message ?? '')
          : '';
}

async function refresh(): Promise<void> {
  for (const id of PROOF_MODELS) render(await transcriber.models.status(id));
  const ui = await transcriber.uiModel(PROOF_MODELS);
  const ledger = await getOffline().engineNetworkLedger();
  const blocked = [...ledger.vosk, ...ledger.whisper, ...ledger.live].filter((attempt) => attempt.outcome === 'blocked').length;
  summary.textContent = `Offline option: ${ui.state}. Cross-origin isolated: ${crossOriginIsolated}. Network requests refused inside the engines: ${blocked}.`;
}

/** Runs a check in the offscreen document (the context that hosts the engines during a recording). */
async function runInOffscreen(name: string, args?: unknown): Promise<unknown> {
  const created = await chrome.runtime.sendMessage({ target: 'sw', command: 'ensure-offscreen' });
  if (!created?.ok) throw new Error(`offscreen document: ${created?.error}`);
  const reply = await chrome.runtime.sendMessage({ target: 'offscreen', name, args });
  if (!reply?.ok) throw new Error(reply?.error ?? 'no reply from the offscreen document');
  return reply.result;
}

Object.assign(globalThis, { NARWAL_SELFTEST: { run: runSelftest, runInOffscreen, refresh } });
void refresh();
