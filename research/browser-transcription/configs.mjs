// Board #16539 run configurations. Each name is one Browserbase session.
const HF = 'https://huggingface.co';
const GGML = (f) => `${HF}/ggerganov/whisper.cpp/resolve/main/${f}`;
const VOSK_SMALL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
const Q8 = { encoder_model: 'q8', decoder_model_merged: 'q8' };

const engines = {
  'tfjs-tiny-q8': { engine: 'tfjs', model: 'onnx-community/whisper-tiny.en_timestamped', dtype: Q8 },
  'tfjs-base-q8': { engine: 'tfjs', model: 'onnx-community/whisper-base.en_timestamped', dtype: Q8 },
  'tfjs-base-fp32enc': { engine: 'tfjs', model: 'onnx-community/whisper-base.en_timestamped', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
  'shout-tiny-q5': { engine: 'shout', modelUrl: GGML('ggml-tiny.en-q5_1.bin'), dtw: 'tiny.en' },
  'shout-base-q5': { engine: 'shout', modelUrl: GGML('ggml-base.en-q5_1.bin'), dtw: 'base.en' },
  'vosk-small': { engine: 'vosk', modelUrl: VOSK_SMALL },
};

export const CONFIGS = {};
for (const [k, e] of Object.entries(engines)) {
  CONFIGS[`smoke-${k}`] = { ...e, fixture: 'narration-2m', limitS: 30, cachedReload: false, offline: false };
  // Ends mid-frame (20.02 s), the case that hung the first 30-minute runs.
  CONFIGS[`edge-${k}`] = { ...e, fixture: 'narration-2m', limitS: 20.02, cachedReload: false, offline: false };
  CONFIGS[`probe-${k}`] = { ...e, fixture: 'narration-2m', skipLive: true, cachedReload: false, offline: false };
  CONFIGS[`sweep-${k}`] = { ...e, fixture: 'narration-2m' };
  CONFIGS[`long-${k}`] = { ...e, fixture: 'narration-30m', memEveryS: 60 };
  CONFIGS[`batch-${k}`] = { ...e, fixture: 'narration-30m', mode: 'batch', memEveryS: 60 };
}
