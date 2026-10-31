// The offline transcription option as one object (board #16544).
//
// The capture layer (offscreen document) owns the audio. It hands live audio
// to `startLive` and the captured recording to `finalize`; neither call can
// slow or stop capture. Nothing here contacts a network host except
// `models.install` / `models.repair`, which the user starts.

import type { AdapterEvent, LocalLiveOptions } from './contract.ts';
import { runFinalPass } from './final-pass.ts';
import type { FinalEngine, FinalPassConfig, FinalPassRequest, FinalPassResult } from './final-pass.ts';
import { LocalLiveSession } from './live-session.ts';
import type { LiveEngineFactory, LiveSessionConfig } from './live-session.ts';
import type { ModelStore } from './model-store.ts';
import type { ModelId } from './models.ts';
import { uiOfflineModel } from './status.ts';
import type { UiOfflineModel } from './status.ts';

export interface OfflineTranscriberDeps {
  models: ModelStore;
  createLiveEngine: LiveEngineFactory;
  /** Loads the named final model (models.ts); the default model when none is named. */
  getFinalEngine: (model?: string) => Promise<FinalEngine>;
  live?: Partial<Omit<LiveSessionConfig, 'createEngine'>>;
  final?: Partial<Omit<FinalPassConfig, 'getEngine'>>;
}

export class OfflineTranscriber {
  readonly models: ModelStore;
  private readonly deps: OfflineTranscriberDeps;

  constructor(deps: OfflineTranscriberDeps) {
    this.deps = deps;
    this.models = deps.models;
  }

  /**
   * Starts live transcription. Resolves once the engine is ready, or at once
   * with a session that only records gaps when the model is missing, corrupt
   * or cannot start. It does not download anything.
   */
  async startLive(options: LocalLiveOptions, onEvent: (event: AdapterEvent) => void, overrides: Partial<Omit<LiveSessionConfig, 'createEngine'>> = {}): Promise<LocalLiveSession> {
    const session = new LocalLiveSession({ ...this.deps.live, ...overrides, createEngine: this.deps.createLiveEngine });
    await session.start(options, onEvent);
    return session;
  }

  /**
   * Final pass or retry over captured audio, with `model` or the default final
   * model. Rejects with ModelError when that model is missing or corrupt.
   */
  finalize(request: FinalPassRequest, model?: string): Promise<FinalPassResult> {
    const chosen = model ?? this.deps.final?.model;
    return runFinalPass({ ...this.deps.final, model: chosen, getEngine: () => this.deps.getFinalEngine(chosen) }, request);
  }

  /** The model state the recorder UI shows for the offline option: the models this machine's tier uses. */
  async uiModel(ids?: ModelId[]): Promise<UiOfflineModel> {
    return uiOfflineModel(await this.models.statusAll(ids));
  }
}
