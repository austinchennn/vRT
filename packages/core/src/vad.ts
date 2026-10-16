import type { AudioChunk } from './audio.js';

/** Voice activity detection over the incoming audio stream. Stateful: one per session. */
export interface Vad {
  /** Feed one chunk; returns `start` or `end` when speech begins or ends. */
  process(chunk: AudioChunk): 'start' | 'end' | undefined;
  readonly speaking: boolean;
  reset(): void;
}

/** Creates a fresh `Vad` per session (e.g. `energyVad()` from `@vrealtime/vad`). */
export type VadFactory = () => Vad;
