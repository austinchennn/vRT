import { describe, expect, it } from 'vitest';
import { Pcm16Resampler, fromBase64, pcm16DurationMs, resamplePcm16, toBase64, type Pcm16Rate } from '../src/audio.js';

function pcm(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

function samples(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

function sine(rate: number, ms: number, hz = 440): number[] {
  return Array.from({ length: (rate * ms) / 1000 }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / rate)));
}

const RATES: Pcm16Rate[] = [8000, 16000, 24000, 48000];

describe('resampler', () => {
  it('returns the input untouched at equal rates', () => {
    const data = pcm([1, 2, 3]);
    expect(resamplePcm16(data, 24000, 24000)).toBe(data);
  });

  it('interpolates linearly when upsampling', () => {
    expect(samples(resamplePcm16(pcm([0, 100, 200]), 8000, 16000))).toEqual([0, 50, 100, 150, 200]);
  });

  it('decimates when downsampling', () => {
    expect(samples(resamplePcm16(pcm([0, 10, 20, 30, 40, 50]), 48000, 16000))).toEqual([0, 30]);
  });

  for (const from of RATES) {
    for (const to of RATES) {
      it(`streams ${from} → ${to} Hz with the right length and no seams`, () => {
        const input = sine(from, 200);
        const whole = samples(resamplePcm16(pcm(input), from, to));
        const streaming = new Pcm16Resampler(from, to);
        const pieces: number[] = [];
        const chunk = (from * 20) / 1000;
        for (let i = 0; i < input.length; i += chunk) pieces.push(...samples(streaming.process(pcm(input.slice(i, i + chunk)))));
        expect(pieces).toEqual(whole);
        expect(Math.abs(pieces.length - (to * 200) / 1000)).toBeLessThan(Math.max(1, to / from));
      });
    }
  }

  it('respects byteOffset and ignores a trailing odd byte', () => {
    const backing = new Uint8Array(9);
    backing.set(pcm([0, 100, 200, 300]), 1);
    expect(samples(resamplePcm16(backing.subarray(1), 8000, 16000))).toEqual([0, 50, 100, 150, 200, 250, 300]);
    expect(resamplePcm16(new Uint8Array(1), 8000, 16000).byteLength).toBe(0);
  });

  it('computes PCM16 duration', () => {
    expect(pcm16DurationMs(960, 24000)).toBe(20);
  });
});

describe('base64', () => {
  it('round-trips every byte value and matches the standard alphabet', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
    expect(toBase64(new TextEncoder().encode('hello?>'))).toBe('aGVsbG8/Pg==');
    expect(toBase64(new Uint8Array(0))).toBe('');
  });

  it('handles buffers larger than one encode chunk', () => {
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) & 0xff);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });

  it('throws on invalid input', () => {
    expect(() => fromBase64('not base64!')).toThrow();
  });
});
