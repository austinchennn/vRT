/**
 * Microphone resampler used inside the capture AudioWorklet: Float32 at the
 * device rate → fixed-size PCM16 frames at the protocol rate. Self-contained
 * (embedded with `toString()`); integer position math, so no drift.
 */
export class CaptureResampler {
  inRate: number;
  outRate: number;
  frameSamples: number;
  pos = 0;
  prev = 0;
  frame: Int16Array;
  n = 0;

  constructor(inRate: number, outRate: number, frameSamples: number) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.frameSamples = frameSamples;
    this.frame = new Int16Array(frameSamples);
  }

  /** Returns every frame completed by this input block. */
  push(input: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    if (input.length === 0) return frames;
    const last = (input.length - 1) * this.outRate;
    for (; this.pos <= last; this.pos += this.inRate) {
      const i = Math.floor(this.pos / this.outRate);
      const rem = this.pos - i * this.outRate;
      const a = i < 0 ? this.prev : input[i]!;
      const b = rem === 0 ? a : input[i + 1]!;
      let s = a + ((b - a) * rem) / this.outRate;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.n++] = s < 0 ? s * 32768 : s * 32767;
      if (this.n === this.frameSamples) {
        frames.push(this.frame);
        this.frame = new Int16Array(this.frameSamples);
        this.n = 0;
      }
    }
    this.pos -= input.length * this.outRate;
    this.prev = input[input.length - 1]!;
    return frames;
  }
}
