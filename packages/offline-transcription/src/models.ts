// Pinned model files for the offline option (board #16544).
//
// Model weights are data: the extension downloads them once, on an explicit
// user action, from the hosts below, and checks every file against the size
// and SHA-256 pinned here. A file that does not match is never stored and
// never reaches a runtime. The runtimes themselves (Kaldi and ONNX Runtime
// WebAssembly, sherpa-onnx WebAssembly) ship inside the extension package.

export type ModelId = 'vosk-small-en-us' | FinalModelId;

/**
 * The models a final pass can run: Whisper, Moonshine since #16609 and
 * Parakeet since #16608. Which one runs on a machine is chosen in one place:
 * `FINAL_CHAIN` in `tier.ts` (board #16603).
 */
export type FinalModelId =
  | 'whisper-base.en-q8'
  | 'whisper-small.en-q8'
  | 'whisper-large-v3-turbo'
  | 'moonshine-base-q8'
  | 'parakeet-tdt-0.6b-v2-int8';

/**
 * The runtime that loads a model. Each worker loads only the entries of its
 * own engine: the Whisper worker only `transformers.js` ones, the sherpa-onnx
 * worker only `sherpa-onnx` ones (board #16608).
 */
export type ModelEngine = 'vosk' | 'transformers.js' | 'sherpa-onnx';

export interface ModelFile {
  /** Path inside the model, also the storage key. */
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** How the Whisper worker loads a `transformers.js` final model. */
export interface TransformersRuntimeSpec {
  /** The repository name the runtime asks for; its requests are answered from the pinned files. */
  repo: string;
  /** transformers.js dtype per ONNX file. */
  dtype: { encoder_model: string; decoder_model_merged: string };
  /** `webgpu` runs only where `tier.ts` finds a WebGPU adapter. */
  device: 'wasm' | 'webgpu';
  /**
   * `none`: the model returns text without word times (Moonshine); the final
   * pass spreads the words over each span's speech. Default `model`.
   */
  wordTimes?: 'model' | 'none';
}

/**
 * What was measured for a model on Matt's 113 s reading passage (boards
 * #16603, #16608, #16609, #16611). The model picker (picker.ts, board #16611)
 * draws its accuracy and speed bars from these numbers only.
 */
export interface ModelMeasured {
  /**
   * Word error rate, in percent, with the #16603 scorer: in the extension (the
   * final pass over speech spans) where it could run there; `werSetup` says
   * where it ran.
   */
  werPassagePct: number;
  /** Where `werPassagePct` ran, e.g. 'in the extension, browser wasm'. */
  werSetup: string;
  /**
   * Set when the numbers come from another recording of the passage than the
   * 113 s one every other model ran on; says which. The picker marks the model.
   */
  otherTake?: string;
  /** The same passage run natively over the whole file (#16603); null when not run. */
  werNativePct: number | null;
  /** Compute seconds per audio second (x the audio length); null for a live model. */
  rtf: number | null;
  /** Where `rtf` ran, e.g. 'browser wasm, 4 threads'. */
  rtfSetup: string | null;
  /** Memory in MB; null when not measured. */
  peakMemoryMb: number | null;
  /** What `peakMemoryMb` is, e.g. 'browser RSS rise during the pass'. */
  memorySetup: string | null;
  /** Where the numbers are recorded. */
  source: string;
}

/** How the sherpa-onnx worker loads a `sherpa-onnx` transducer model (board #16608). */
export interface SherpaRuntimeSpec {
  /** sherpa-onnx `modelType`. */
  modelType: 'nemo_transducer';
  /** Paths in `files`. */
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  device: 'wasm';
}

interface ManifestBase {
  id: ModelId;
  role: 'live' | 'final';
  label: string;
  licence: string;
  files: ModelFile[];
  measured?: ModelMeasured;
}

/** `runtime` is the spec of the manifest's own engine. */
export type ModelManifest = ManifestBase &
  (
    | { engine: 'vosk'; runtime?: undefined }
    | { engine: 'transformers.js'; runtime: TransformersRuntimeSpec }
    | { engine: 'sherpa-onnx'; runtime: SherpaRuntimeSpec }
  );

const WHISPER_LICENCE = 'MIT (OpenAI Whisper); the ONNX conversion repository carries no licence tag';

/** Pinned files of one Hugging Face repository at one commit. */
const pinnedRepo = (repo: string, revision: string) => (path: string, bytes: number, sha256: string): ModelFile => ({
  path,
  url: `https://huggingface.co/${repo}/resolve/${revision}/${path}`,
  bytes,
  sha256,
});

const BASE_REPO = 'onnx-community/whisper-base.en_timestamped';
const baseFile = pinnedRepo(BASE_REPO, 'fa239a41836c3305f6beec180e5940f3823ff5b8');
const SMALL_REPO = 'onnx-community/whisper-small.en_timestamped';
const smallFile = pinnedRepo(SMALL_REPO, '8085393831131554ad978a4e438295a734d3d2c0');
const TURBO_REPO = 'onnx-community/whisper-large-v3-turbo_timestamped';
const turboFile = pinnedRepo(TURBO_REPO, 'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a');
const MOONSHINE_REPO = 'onnx-community/moonshine-base-ONNX';
const moonshineFile = pinnedRepo(MOONSHINE_REPO, 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad');

const Q8 = { encoder_model: 'q8', decoder_model_merged: 'q8' };

// k2-fsa's int8 export of NVIDIA Parakeet TDT 0.6B v2 for sherpa-onnx (board #16608).
const PARAKEET_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const parakeetFile = pinnedRepo(PARAKEET_REPO, '1ab9323565ddb038682214b292f588070a538ce2');

export const VOSK_ARCHIVE = 'model.tar.gz';

export const MODELS: Record<ModelId, ModelManifest> = {
  'vosk-small-en-us': {
    id: 'vosk-small-en-us',
    role: 'live',
    engine: 'vosk',
    label: 'Live text (Vosk small English 0.15)',
    licence: 'Apache-2.0',
    measured: { werPassagePct: 45.3, werSetup: 'in the extension, live text', werNativePct: null, rtf: null, rtfSetup: null, peakMemoryMb: null, memorySetup: null, source: 'docs/validation/wer-16603' },
    files: [
      {
        path: VOSK_ARCHIVE,
        url: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz',
        bytes: 41184862,
        sha256: 'f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8',
      },
    ],
  },
  'whisper-base.en-q8': {
    id: 'whisper-base.en-q8',
    role: 'final',
    engine: 'transformers.js',
    label: 'Final text (Whisper base.en, 8-bit)',
    licence: WHISPER_LICENCE,
    runtime: { repo: BASE_REPO, dtype: Q8, device: 'wasm' },
    measured: { werPassagePct: 20.1, werSetup: 'in the extension, browser wasm', werNativePct: 28.6, rtf: 0.16, rtfSetup: 'browser wasm, 4 threads', peakMemoryMb: 673, memorySetup: 'browser RSS rise during the pass', source: 'docs/validation/accuracy-16621, #16609' },
    files: [
      baseFile('config.json', 2197, 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1'),
      baseFile('generation_config.json', 1556, '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120'),
      baseFile('preprocessor_config.json', 339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'),
      baseFile('tokenizer.json', 2405679, '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0'),
      baseFile('tokenizer_config.json', 282662, '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c'),
      baseFile('onnx/encoder_model_quantized.onnx', 23159173, '9b4d25507aef3d3a8d718695b8adcb0488e66aad8e884333c3fa73a1c3baa906'),
      baseFile('onnx/decoder_model_merged_quantized.onnx', 53712196, 'afa8065a5f023f6e524417f9459cc09969023dd38149cd4dce16628b2c3a1773'),
    ],
  },
  'whisper-small.en-q8': {
    id: 'whisper-small.en-q8',
    role: 'final',
    engine: 'transformers.js',
    label: 'Final text (Whisper small.en, 8-bit)',
    licence: WHISPER_LICENCE,
    runtime: { repo: SMALL_REPO, dtype: Q8, device: 'wasm' },
    measured: { werPassagePct: 9.0, werSetup: 'in the extension, browser wasm', werNativePct: 9.8, rtf: 0.55, rtfSetup: 'browser wasm, 4 threads', peakMemoryMb: 1340, memorySetup: 'browser RSS rise during the pass', source: 'docs/validation/accuracy-16621, #16609' },
    files: [
      smallFile('config.json', 2203, '8825c4174cb86f94d9fa67614942f8aa17bfbbdf2fae5426d4adfd0bc5893c43'),
      smallFile('generation_config.json', 1956, '5490747ca976d6b3765280a0697d66489020c2afa6e754244d9cd093e1639331'),
      smallFile('preprocessor_config.json', 339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'),
      smallFile('tokenizer.json', 2405679, '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0'),
      smallFile('tokenizer_config.json', 282662, '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c'),
      smallFile('onnx/encoder_model_quantized.onnx', 92240508, 'f37219c0fb60c10c8ad3a986119c805e99622e946864f0fa8e3e0c393126e3e0'),
      smallFile('onnx/decoder_model_merged_quantized.onnx', 156794981, 'f0e6480e2bd279b223a82b20a203d4b9f87d437712983687080c3c7dcc677b80'),
    ],
  },
  // WebGPU only: 4-bit weights with half-precision activations (q4f16). On Matt's
  // passage (#16603) it scored 6.0% WER natively against 6.4% for fp16/q4, at 564 MB not 1.6 GB.
  'whisper-large-v3-turbo': {
    id: 'whisper-large-v3-turbo',
    role: 'final',
    engine: 'transformers.js',
    label: 'Final text (Whisper large-v3-turbo, WebGPU)',
    licence: WHISPER_LICENCE,
    runtime: { repo: TURBO_REPO, dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, device: 'webgpu' },
    // Matt's own run (#16621): not the 113 s recording the others ran on, but his
    // separate 120 s take of the passage (rec_49bbce68) on his Mac, the final pass
    // on WebGPU in the extension, build e636478. That build predates
    // whisper-words.ts: 4 of its 22 errors were amounts split into pieces
    // ("$12 ,345"). Speed is Stop to the finished revision, model load included,
    // so it does not compare with the others' pass-only speeds. Memory is native.
    measured: {
      werPassagePct: 9.4,
      werSetup: "in the extension, WebGPU, Matt's Mac",
      otherTake: "a different take: Matt's separate 120-second recording of the same passage (rec_49bbce68), on build e636478, before amounts split into pieces were joined",
      werNativePct: 6.0,
      rtf: 0.15,
      rtfSetup: "in the extension, WebGPU, Matt's Mac, on that different take, counted from Stop to the finished text, model load included",
      peakMemoryMb: 3109,
      memorySetup: 'native CPU peak RSS (not measured on WebGPU)',
      source: 'docs/validation/accuracy-16621, docs/validation/wer-16603',
    },
    files: [
      turboFile('config.json', 1330, '32c02d1dfb9a93ff236cdcf0f741f8f3a4cedb437c407a361a022451ac009131'),
      turboFile('generation_config.json', 3797, '8568ddf83476167b4607014956b87142763fa6923e71259a606734beb39bdfc8'),
      turboFile('preprocessor_config.json', 340, '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711'),
      turboFile('tokenizer.json', 2480645, 'b3c8202bbf06d8ee4232c5984baa563784ac4737e2e7fdc42fa180200d3cfcdb'),
      turboFile('tokenizer_config.json', 282843, '844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389'),
      turboFile('onnx/encoder_model_q4f16.onnx', 370035242, '65261f977474ce30e46ed2c2b885e8ef68ef917941f78af48b098b86fad1adaa'),
      turboFile('onnx/decoder_model_merged_q4f16.onnx', 193566135, '617e5b4f91ca190c43fa4d3bd2e671cfbee19c9a6ac4890f0a4bbaf658f00cf4'),
    ],
  },
  // The fast fallback (#16609). On Matt's passage it scored 9.4% WER natively at 0.05 x
  // audio length, against 28.6% at 0.14 for base.en. It is fed VAD spans of
  // 20 s or less (a whole 113 s file gave 99.6%) and gives no word times.
  'moonshine-base-q8': {
    id: 'moonshine-base-q8',
    role: 'final',
    engine: 'transformers.js',
    label: 'Final text (Moonshine base, 8-bit)',
    licence: 'MIT (Useful Sensors Moonshine; the ONNX conversion repository is tagged MIT)',
    runtime: { repo: MOONSHINE_REPO, dtype: Q8, device: 'wasm', wordTimes: 'none' },
    measured: { werPassagePct: 11.1, werSetup: 'in the extension, browser wasm', werNativePct: 9.4, rtf: 0.06, rtfSetup: 'browser wasm, 4 threads', peakMemoryMb: 677, memorySetup: 'browser RSS rise during the pass', source: 'docs/validation/picker-16611, #16609' },
    files: [
      moonshineFile('config.json', 922, 'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1'),
      moonshineFile('generation_config.json', 147, 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44'),
      moonshineFile('preprocessor_config.json', 128, 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679'),
      moonshineFile('tokenizer.json', 3761754, '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f'),
      moonshineFile('tokenizer_config.json', 135735, 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15'),
      moonshineFile('onnx/encoder_model_quantized.onnx', 20513063, '1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751'),
      moonshineFile('onnx/decoder_model_merged_quantized.onnx', 42498870, 'cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3'),
    ],
  },
  // WebAssembly tier, first choice (#16608): 5.1% WER on Matt's passage natively, 5.6% in the
  // extension with context at span cuts (#16621); token times from the TDT decoder.
  'parakeet-tdt-0.6b-v2-int8': {
    id: 'parakeet-tdt-0.6b-v2-int8',
    role: 'final',
    engine: 'sherpa-onnx',
    label: 'Final text (Parakeet TDT 0.6B v2, 8-bit)',
    licence: 'CC-BY-4.0 (NVIDIA Parakeet TDT 0.6B v2; sherpa-onnx int8 export by k2-fsa)',
    measured: {
      werPassagePct: 5.6,
      werSetup: 'in the extension, browser wasm',
      werNativePct: 5.1,
      rtf: 0.32,
      rtfSetup: 'browser wasm, 1 thread, one core',
      peakMemoryMb: 1319,
      memorySetup: 'browser RSS rise during the pass',
      source: 'docs/validation/accuracy-16621, docs/validation/parakeet-16608',
    },
    runtime: {
      modelType: 'nemo_transducer',
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
      device: 'wasm',
    },
    files: [
      parakeetFile('tokens.txt', 9384, 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d'),
      parakeetFile('encoder.int8.onnx', 652184296, 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab'),
      parakeetFile('decoder.int8.onnx', 7257753, 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e'),
      parakeetFile('joiner.int8.onnx', 1739080, '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2'),
    ],
  },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

/** Hosts a model download may contact, including the Hugging Face CDN redirect. */
export const MODEL_DOWNLOAD_HOSTS = ['huggingface.co', '*.hf.co', 'ccoreilly.github.io'];

export function modelBytes(id: ModelId): number {
  return MODELS[id].files.reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Storage key of a model file. It is a URL because the Cache API needs one;
 * `.invalid` never resolves, so the key can never turn into a request.
 */
export function storageKey(id: ModelId, path: string): string {
  return `https://narwal-models.invalid/${id}/${path}`;
}

/** Every model a final pass can run, whatever its engine. */
export const FINAL_MODEL_IDS = MODEL_IDS.filter((id): id is FinalModelId => MODELS[id].role === 'final');

export function isFinalModel(id: string): id is FinalModelId {
  return (FINAL_MODEL_IDS as string[]).includes(id);
}

/** True when the model runs only on a WebGPU adapter. */
export function needsWebGpu(id: ModelId): boolean {
  return MODELS[id].runtime?.device === 'webgpu';
}

/** The final models the Whisper worker loads: `engine: 'transformers.js'` only. */
export const TRANSFORMERS_MODEL_IDS = FINAL_MODEL_IDS.filter((id) => MODELS[id].engine === 'transformers.js');

export function isTransformersModel(id: string): id is FinalModelId {
  return (TRANSFORMERS_MODEL_IDS as string[]).includes(id);
}

/** How the Whisper worker loads a `transformers.js` final model. */
export function transformersRuntime(id: FinalModelId): TransformersRuntimeSpec {
  const manifest = MODELS[id];
  if (manifest?.engine !== 'transformers.js') throw new Error(`${id} does not run on transformers.js`);
  return manifest.runtime;
}

/** The final models the sherpa-onnx worker loads: `engine: 'sherpa-onnx'` only (board #16608). */
export function isSherpaModel(id: string): id is FinalModelId {
  return isFinalModel(id) && MODELS[id].engine === 'sherpa-onnx';
}

/** How the sherpa-onnx worker loads a `sherpa-onnx` final model. */
export function sherpaRuntime(id: FinalModelId): SherpaRuntimeSpec {
  const manifest = MODELS[id];
  if (manifest?.engine !== 'sherpa-onnx') throw new Error(`${id} does not run on sherpa-onnx`);
  return manifest.runtime;
}

/**
 * The URL the Vosk worker is told to load. It carries the hash, so a new pinned
 * archive is extracted again instead of reusing an older extracted copy.
 */
export function voskLoadUrl(): string {
  const file = MODELS['vosk-small-en-us'].files[0];
  return `https://narwal-models.invalid/vosk-small-en-us/${file.sha256.slice(0, 16)}/${VOSK_ARCHIVE}`;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
