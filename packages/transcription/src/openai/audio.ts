// Cutting narration audio into time ranges for upload (board #16547).
// A compressed file (WebM/Opus from MediaRecorder) cannot be cut at a byte offset, so audio
// over the upload limit is decoded to 16 kHz mono PCM and cut as WAV on sample boundaries.

import { UploadRefused } from './api.ts';

/** Audio that can be cut by time. `slice` returns a complete, uploadable file for the range. */
export interface PreparedAudio {
  durationMs: number;
  /** Byte rate of a slice, without `headerBytes`. */
  bytesPerSecond: number;
  headerBytes: number;
  slice(startMs: number, endMs: number): Blob;
}

/** Makes over-limit audio sliceable. Called only when the file does not fit one upload. */
export type AudioSlicer = (audio: Blob, signal: AbortSignal) => Promise<PreparedAudio>;

const WAV_HEADER_BYTES = 44;
/** Speech models work at 16 kHz mono; this rate keeps 12 minutes of audio under 25 MB. */
export const UPLOAD_SAMPLE_RATE = 16_000;

function wavHeader(dataBytes: number, sampleRate: number, channels: number): ArrayBuffer {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  const blockAlign = channels * 2;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Blob {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return new Blob([wavHeader(data.byteLength, sampleRate, 1), data], { type: 'audio/wav' });
}

interface WavLayout {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataBytes: number;
}

/** Reads the RIFF chunk list. Only 16-bit PCM is sliceable without decoding. */
async function readWavLayout(audio: Blob): Promise<WavLayout> {
  const refuse = (why: string) => new UploadRefused('unsupported-type', `Cannot slice this WAV file: ${why}`);
  // `fmt ` and `data` are near the start; metadata chunks before them are small.
  const head = new DataView(await audio.slice(0, 65_536).arrayBuffer());
  const tag = (offset: number) =>
    String.fromCharCode(head.getUint8(offset), head.getUint8(offset + 1), head.getUint8(offset + 2), head.getUint8(offset + 3));
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw refuse('not a RIFF/WAVE file');

  let format: { sampleRate: number; channels: number } | null = null;
  let offset = 12;
  while (offset + 8 <= head.byteLength) {
    const id = tag(offset);
    const size = head.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      if (offset + 24 > head.byteLength) break;
      if (head.getUint16(offset + 8, true) !== 1 || head.getUint16(offset + 22, true) !== 16) {
        throw refuse('only 16-bit PCM is supported');
      }
      format = { channels: head.getUint16(offset + 10, true), sampleRate: head.getUint32(offset + 12, true) };
    } else if (id === 'data') {
      if (!format || format.channels < 1 || format.sampleRate < 1) throw refuse('no format before the audio data');
      const dataOffset = offset + 8;
      // A streamed WAV can declare more data than was written; trust the bytes that exist.
      return { ...format, dataOffset, dataBytes: Math.min(size, audio.size - dataOffset) };
    }
    offset += 8 + size + (size % 2);
  }
  throw refuse('no audio data found');
}

/** Slices a 16-bit PCM WAV file by time without reading its audio into memory. */
export const wavPcmSlicer: AudioSlicer = async (audio) => {
  const { sampleRate, channels, dataOffset, dataBytes } = await readWavLayout(audio);
  const blockAlign = channels * 2;
  const frames = Math.floor(dataBytes / blockAlign);
  return {
    durationMs: Math.floor((frames * 1000) / sampleRate),
    bytesPerSecond: sampleRate * blockAlign,
    headerBytes: WAV_HEADER_BYTES,
    slice(startMs, endMs) {
      const first = Math.min(frames, Math.max(0, Math.floor((startMs * sampleRate) / 1000)));
      const last = Math.min(frames, Math.max(first, Math.ceil((endMs * sampleRate) / 1000)));
      const bytes = (last - first) * blockAlign;
      const start = dataOffset + first * blockAlign;
      return new Blob([wavHeader(bytes, sampleRate, channels), audio.slice(start, start + bytes)], { type: 'audio/wav' });
    },
  };
};

/** Averages channels to mono and converts float samples to 16-bit PCM. */
export function toMonoPcm16(channels: Float32Array[]): Int16Array {
  const length = channels[0]?.length ?? 0;
  const samples = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    const value = Math.max(-1, Math.min(1, sum / channels.length));
    samples[index] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return samples;
}

/** The part of the Web Audio API this module uses; an offscreen document has it, a service worker does not. */
export interface AudioDecoderContext {
  decodeAudioData(data: ArrayBuffer): Promise<{
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }>;
}

/**
 * Slicer for any container the browser can decode (WebM/Opus, Ogg, MP4). The
 * context must run at UPLOAD_SAMPLE_RATE: `decodeAudioData` resamples to the
 * context's rate. In an offscreen document:
 *   createDecodingSlicer(() => new OfflineAudioContext(1, 1, UPLOAD_SAMPLE_RATE))
 * Preparing holds the decoded audio and its PCM copies in memory: about 8 MB
 * per minute of mono narration at the peak (1 GB for two hours), and about
 * 2 MB per minute after that, until the last part is sent.
 */
export function createDecodingSlicer(createContext: () => AudioDecoderContext): AudioSlicer {
  return async (audio, signal) => {
    const encoded = await audio.arrayBuffer();
    signal.throwIfAborted();
    const decoded = await createContext().decodeAudioData(encoded);
    signal.throwIfAborted();
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) channels.push(decoded.getChannelData(channel));
    return wavPcmSlicer(encodeWavPcm16(toMonoPcm16(channels), UPLOAD_SAMPLE_RATE), signal);
  };
}
