// The parts of sherpa-onnx's wasm/asr wrapper the Parakeet worker uses (board #16608).

import type { SherpaModule } from './sherpa-onnx-asr-wasm.js';

export interface OfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

export class OfflineRecognizer {
  handle: number;
  constructor(config: unknown, module: SherpaModule);
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): unknown;
  free(): void;
}
