// Energy voice-activity segmentation for the final pass (board #16544).
//
// Same policy the research measured (#16539, LiveChunker): 20 ms RMS windows,
// a span ends at a pause of 0.6 s, a span longer than 20 s is cut at the last
// short pause, and 0.2 s of audio is kept around speech. Silence is never
// sent to Whisper, which invents words for it.

export interface VadOptions {
  sampleRate: number;
  vadRms: number;
  pauseS: number;
  shortPauseS: number;
  maxSegS: number;
  tailS: number;
}

export const DEFAULT_VAD: VadOptions = { sampleRate: 16000, vadRms: 0.004, pauseS: 0.6, shortPauseS: 0.15, maxSegS: 20, tailS: 0.2 };

export interface SpeechSpan {
  startSample: number;
  endSample: number;
}

export class SpeechSegmenter {
  private readonly o: VadOptions;
  private readonly window: number;
  private carry = new Float32Array(0);
  private fed = 0;
  private segStart = 0;
  private lastSpeech = -1;
  private lastShortPause = -1;
  private silenceRun = 0;
  private hasSpeech = false;

  constructor(options: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD, ...options };
    this.window = Math.round(this.o.sampleRate / 50);
  }

  /** Feeds contiguous samples; returns the spans that closed. */
  push(samples: Float32Array): SpeechSpan[] {
    const out: SpeechSpan[] = [];
    let data = samples;
    if (this.carry.length) {
      data = new Float32Array(this.carry.length + samples.length);
      data.set(this.carry);
      data.set(samples, this.carry.length);
    }
    const { o, window } = this;
    let offset = 0;
    for (; offset + window <= data.length; offset += window) {
      let energy = 0;
      for (let i = offset; i < offset + window; i += 1) energy += data[i] * data[i];
      const end = this.fed + window;
      if (Math.sqrt(energy / window) > o.vadRms) {
        this.lastSpeech = end;
        this.hasSpeech = true;
        this.silenceRun = 0;
      } else {
        this.silenceRun += window;
        // The cut stays on the window grid, so the span after it also ends within maxSegS.
        if (this.hasSpeech && this.silenceRun >= o.shortPauseS * o.sampleRate) {
          this.lastShortPause = end - Math.floor(this.silenceRun / 2 / window) * window;
        }
      }
      this.fed = end;
      this.step(out);
    }
    this.carry = data.slice(offset);
    return out;
  }

  private step(out: SpeechSpan[]): void {
    const { o } = this;
    const tail = Math.floor(o.tailS * o.sampleRate);
    if (!this.hasSpeech) {
      this.segStart = Math.max(this.segStart, this.fed - tail);
      return;
    }
    if (this.fed - this.lastSpeech >= o.pauseS * o.sampleRate) {
      const end = Math.min(this.fed, this.lastSpeech + tail);
      out.push({ startSample: this.segStart, endSample: end });
      this.segStart = end;
      this.hasSpeech = false;
      this.lastShortPause = -1;
      return;
    }
    if (this.fed - this.segStart >= o.maxSegS * o.sampleRate) {
      const cut = this.lastShortPause > this.segStart + o.sampleRate ? this.lastShortPause : this.fed;
      out.push({ startSample: this.segStart, endSample: cut });
      this.segStart = cut;
      this.lastShortPause = -1;
      this.hasSpeech = this.lastSpeech > cut;
    }
  }

  /** The earliest sample a span that has not closed yet can start at. */
  get openFrom(): number {
    return this.segStart;
  }

  /** Call once after the last sample. */
  flush(): SpeechSpan[] {
    const total = this.fed + this.carry.length;
    this.carry = new Float32Array(0);
    if (!this.hasSpeech) return [];
    const end = Math.min(total, this.lastSpeech + Math.floor(this.o.tailS * this.o.sampleRate));
    this.hasSpeech = false;
    return end > this.segStart ? [{ startSample: this.segStart, endSample: end }] : [];
  }
}

/** Captured audio the final pass reads. Lets the caller keep a long recording off the heap. */
export interface PcmSource {
  readonly sampleRate: number;
  readonly lengthSamples: number;
  read(startSample: number, endSample: number): Promise<Float32Array>;
}

export function pcmSource(pcm: Float32Array, sampleRate = 16000): PcmSource {
  return {
    sampleRate,
    lengthSamples: pcm.length,
    async read(startSample, endSample) {
      return pcm.subarray(startSample, endSample);
    },
  };
}

export async function planSpeech(source: PcmSource, options: Partial<VadOptions> = {}): Promise<SpeechSpan[]> {
  const segmenter = new SpeechSegmenter({ ...options, sampleRate: source.sampleRate });
  const block = source.sampleRate * 30;
  const spans: SpeechSpan[] = [];
  for (let start = 0; start < source.lengthSamples; start += block) {
    spans.push(...segmenter.push(await source.read(start, Math.min(source.lengthSamples, start + block))));
  }
  spans.push(...segmenter.flush());
  return spans;
}
