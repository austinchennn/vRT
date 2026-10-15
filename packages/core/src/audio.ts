/** Audio encodings vRealTime can pass through without transcoding. */
export type AudioFormat =
  | { encoding: 'pcm16'; sampleRate: 8000 | 16000 | 24000 | 48000; channels: 1 }
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
