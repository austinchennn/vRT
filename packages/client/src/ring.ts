/**
 * Playback ring buffer used inside the speaker AudioWorklet. It must stay
 * self-contained (no imports, no outer references): its source is embedded
 * into the worklet with `toString()`.
 */
export class PlaybackRing {
  buf: Float32Array;
  start = 0;
  size = 0;
  /** Buffered samples per item, oldest first. */
  segments: [string, number][] = [];
  /** Samples actually played per item since the last flush. */
  played: Record<string, number> = {};

  constructor(capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** Appends samples for `item`; returns how many were dropped because the ring is full. */
  push(samples: Float32Array, item: string): number {
    const cap = this.buf.length;
    const n = Math.min(samples.length, cap - this.size);
    let at = (this.start + this.size) % cap;
    for (let i = 0; i < n; i++) {
      this.buf[at] = samples[i]!;
      at = at + 1 === cap ? 0 : at + 1;
    }
    this.size += n;
    const last = this.segments[this.segments.length - 1];
    if (last && last[0] === item) last[1] += n;
    else if (n > 0) this.segments.push([item, n]);
    return samples.length - n;
  }

  /** Fills `out` with buffered audio (silence on underrun) and counts what played. */
  pull(out: Float32Array): void {
    const cap = this.buf.length;
    let i = 0;
    while (i < out.length && this.size > 0) {
      const segment = this.segments[0]!;
      const take = Math.min(out.length - i, segment[1]);
      for (let k = 0; k < take; k++) {
        out[i++] = this.buf[this.start]!;
        this.start = this.start + 1 === cap ? 0 : this.start + 1;
      }
      this.size -= take;
      this.played[segment[0]] = (this.played[segment[0]] ?? 0) + take;
      segment[1] -= take;
      if (segment[1] === 0) this.segments.shift();
    }
    for (; i < out.length; i++) out[i] = 0;
  }

  /** Drops everything buffered and returns (then resets) the played counts: 0 for an item still queued that never started. */
  flush(): Record<string, number> {
    const played = this.played;
    for (const segment of this.segments) played[segment[0]] ??= 0;
    this.start = 0;
    this.size = 0;
    this.segments = [];
    this.played = {};
    return played;
  }
}
