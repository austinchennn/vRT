/** Audio encodings vRealTime can pass through without transcoding. */
export type AudioFormat =
  | { encoding: 'pcm16'; sampleRate: Pcm16Rate; channels: 1 }
  | { encoding: 'opus'; frameMs: 10 | 20 | 40 | 60 }
  | { encoding: 'pcmu' };

/**
 * One chunk of audio on the hot path. `data` is passed through as-is when the
 * peer accepts `format`; adapters convert only on mismatch.
 */
export interface AudioChunk {
  data: Uint8Array;
  format: AudioFormat;
  /** Playback length, when known without decoding. */
  durationMs?: number;
}

export type Pcm16Rate = 8000 | 16000 | 24000 | 48000;

/** Playback length of mono PCM16 audio. */
export function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  return (byteLength / 2 / sampleRate) * 1000;
}

/**
 * Streaming linear resampler for mono little-endian PCM16. Keeps the last
 * sample and fractional position across chunks, so consecutive chunks join
 * without clicks. Upsampling holds back the samples after the last input
 * sample until the next chunk arrives. A trailing odd byte is ignored.
 */
export class Pcm16Resampler {
  readonly from: number;
  readonly to: number;
  /** Read position in units of 1/`to` input samples; exact integer math, so no drift across chunks. */
  #pos = 0;
  #prev = 0;

  constructor(from: Pcm16Rate, to: Pcm16Rate) {
    this.from = from;
    this.to = to;
  }

  process(chunk: Uint8Array): Uint8Array {
    const { from, to } = this;
    if (from === to) return chunk;
    const n = chunk.byteLength >> 1;
    if (n === 0) return new Uint8Array(0);
    const input = new DataView(chunk.buffer, chunk.byteOffset, n * 2);
    const last = (n - 1) * to;
    let pos = this.#pos;
    const count = pos <= last ? Math.floor((last - pos) / from) + 1 : 0;
    const out = new Uint8Array(count * 2);
    const output = new DataView(out.buffer);
    for (let k = 0; k < count; k++, pos += from) {
      const i = Math.floor(pos / to);
      const rem = pos - i * to;
      const a = i < 0 ? this.#prev : input.getInt16(i * 2, true);
      const b = rem === 0 ? a : input.getInt16((i + 1) * 2, true);
      output.setInt16(k * 2, a + Math.round(((b - a) * rem) / to), true);
    }
    this.#pos = pos - n * to;
    this.#prev = input.getInt16((n - 1) * 2, true);
    return out;
  }

  reset(): void {
    this.#pos = 0;
    this.#prev = 0;
  }
}

/** One-shot resample of a complete PCM16 buffer. */
export function resamplePcm16(data: Uint8Array, from: Pcm16Rate, to: Pcm16Rate): Uint8Array {
  return new Pcm16Resampler(from, to).process(data);
}

const BASE64_CHUNK = 0x8000;

/** Base64 without `Buffer`: works the same in Node, browsers, Deno, Bun and Workers. */
export function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + BASE64_CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/** Throws on input that is not valid base64. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
