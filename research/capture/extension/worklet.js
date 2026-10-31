// NarWal capture probe — counts captured microphone frames (board #16538).
// Posts the running frame count about once a second so the offscreen document
// can compare the audio sample clock with performance.now().
class FrameCounter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.nextPost = sampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.frames += input[0].length;
      if (this.frames >= this.nextPost) {
        this.port.postMessage({ frames: this.frames });
        this.nextPost += sampleRate;
      }
    }
    return true;
  }
}

registerProcessor('narwal-frame-counter', FrameCounter);
