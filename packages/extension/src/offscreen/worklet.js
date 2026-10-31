// Microphone tap (AudioWorklet). Posts the running input frame count about
// once a second, so the recorder can map audio to the page clock with
// (frames, time) pairs instead of trusting the sample clock (board #16538:
// the render clock drifted 270 ppm). When a PCM consumer is attached it also
// posts 16 kHz mono signed 16-bit blocks of 100 ms for live transcription.
const OUT_RATE = 16000;
const BLOCK = 1600;

class NarwalTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.nextPost = sampleRate;
    this.pcm = false;
    this.ratio = sampleRate / OUT_RATE;
    this.phase = 0;
    this.acc = 0;
    this.count = 0;
    this.block = new Int16Array(BLOCK);
    this.filled = 0;
    this.blockStartFrame = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.pcm === 'boolean') this.pcm = e.data.pcm;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.pcm) {
      for (let i = 0; i < channel.length; i += 1) {
        // Box filter then decimate: averages the input samples that fall in
        // each output sample, which also limits aliasing.
        this.acc += channel[i];
        this.count += 1;
        this.phase += 1;
        if (this.phase >= this.ratio) {
          this.phase -= this.ratio;
          const s = this.acc / this.count;
          this.acc = 0;
          this.count = 0;
          if (this.filled === 0) this.blockStartFrame = this.frames + i;
          this.block[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
          if (this.filled === BLOCK) {
            this.port.postMessage({ pcm: this.block, startFrame: this.blockStartFrame }, [this.block.buffer]);
            this.block = new Int16Array(BLOCK);
            this.filled = 0;
          }
        }
      }
    }
    this.frames += channel.length;
    if (this.frames >= this.nextPost) {
      this.port.postMessage({ frames: this.frames });
      this.nextPost += sampleRate;
    }
    return true;
  }
}

registerProcessor('narwal-tap', NarwalTap);
