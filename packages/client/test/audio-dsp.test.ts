import { describe, expect, it } from 'vitest';
import { CaptureResampler } from '../src/capture.js';
import { PlaybackRing } from '../src/ring.js';

describe('PlaybackRing', () => {
  it('plays items in order, counts played samples per item and pads underruns with silence', () => {
    const ring = new PlaybackRing(8);
    ring.push(new Float32Array([0.1, 0.2, 0.3]), 'a');
    ring.push(new Float32Array([0.4]), 'a');
    ring.push(new Float32Array([0.5, 0.6]), 'b');
    const out = new Float32Array(4);
    ring.pull(out);
    expect(Array.from(out).map((v) => +v.toFixed(1))).toEqual([0.1, 0.2, 0.3, 0.4]);
    ring.pull(out);
    expect(Array.from(out).map((v) => +v.toFixed(1))).toEqual([0.5, 0.6, 0, 0]);
    expect(ring.played).toEqual({ a: 4, b: 2 });
  });

  it('wraps around and reports dropped samples when full', () => {
    const ring = new PlaybackRing(4);
    expect(ring.push(new Float32Array([1, 2, 3]), 'a')).toBe(0);
    ring.pull(new Float32Array(2));
    expect(ring.push(new Float32Array([4, 5, 6, 7]), 'b')).toBe(1);
    const out = new Float32Array(4);
    ring.pull(out);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it('flush drops buffered audio and returns what was heard', () => {
    const ring = new PlaybackRing(16);
    ring.push(new Float32Array(10).fill(1), 'a');
    ring.pull(new Float32Array(3));
    expect(ring.flush()).toEqual({ a: 3 });
    const out = new Float32Array(2).fill(9);
    ring.pull(out);
    expect(Array.from(out)).toEqual([0, 0]);
    expect(ring.size).toBe(0);
  });

  it('flush reports 0 for an item still queued that never started playing', () => {
    const ring = new PlaybackRing(16);
    ring.push(new Float32Array(4).fill(1), 'a');
    ring.push(new Float32Array(4).fill(1), 'b');
    ring.pull(new Float32Array(3));
    expect(ring.flush()).toEqual({ a: 3, b: 0 });
    expect(ring.flush()).toEqual({});
  });

  it('works when rebuilt from its own source (as inside the worklet)', () => {
    const Rebuilt = new Function(`return (${PlaybackRing.toString()})`)() as typeof PlaybackRing;
    const ring = new Rebuilt(4);
    ring.push(new Float32Array([1]), 'x');
    ring.pull(new Float32Array(1));
    expect(ring.played).toEqual({ x: 1 });
  });
});

describe('CaptureResampler', () => {
  it('converts 48 kHz float to 24 kHz PCM16 frames of a fixed size', () => {
    const r = new CaptureResampler(48000, 24000, 480);
    const block = new Float32Array(128).fill(0.5);
    const frames: Int16Array[] = [];
    for (let i = 0; i < 30; i++) frames.push(...r.push(block));
    // 30 × 128 = 3840 input samples → 1920 output → 4 full frames.
    expect(frames).toHaveLength(4);
    expect(frames.every((f) => f.length === 480 && f.every((s) => s === 16383))).toBe(true);
  });

  it('clamps out-of-range input and handles 44.1 kHz without drift', () => {
    const r = new CaptureResampler(44100, 24000, 240);
    const frames: Int16Array[] = [];
    for (let i = 0; i < 441; i++) frames.push(...r.push(new Float32Array(100).fill(i % 2 ? 2 : -2)));
    // 1 s of input → 24000 samples → exactly 100 frames (±1 for the held-back last sample).
    expect(Math.abs(frames.length - 100)).toBeLessThanOrEqual(1);
    expect(frames[0]!.every((s) => s === 32767 || s === -32768 || Math.abs(s) <= 32767)).toBe(true);
  });

  it('works when rebuilt from its own source', () => {
    const Rebuilt = new Function(`return (${CaptureResampler.toString()})`)() as typeof CaptureResampler;
    expect(new Rebuilt(24000, 24000, 2).push(new Float32Array([0, 1]))).toHaveLength(1);
  });
});
