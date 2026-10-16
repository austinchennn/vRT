import type { AudioChunk, Vad, VadFactory } from '@vrealtime/core';

export type { Vad, VadFactory } from '@vrealtime/core';

export interface EnergyVadOptions {
  /** Absolute floor for speech, in dBFS. Default -50. */
  thresholdDb?: number;
  /** Speech must also be this far above the adaptive noise floor. Default 10 dB. */
  marginDb?: number;
  /** Voiced audio needed before `start`. Default 120 ms. */
  minSpeechMs?: number;
  /** Silence needed before `end`. Default 600 ms. */
  minSilenceMs?: number;
}

const SILENCE_DB = -100;

function rmsDb(chunk: AudioChunk): number | undefined {
  if (chunk.format.encoding !== 'pcm16') return undefined;
  const n = chunk.data.byteLength >> 1;
  if (n === 0) return undefined;
  const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB;
}

/**
 * Energy VAD with hysteresis and an adaptive noise floor. PCM16 only; other
 * encodings are ignored. Cheap enough for the audio hot path (~1 µs per 20 ms chunk).
 */
export function energyVad(options: EnergyVadOptions = {}): VadFactory {
  const thresholdDb = options.thresholdDb ?? -50;
  const marginDb = options.marginDb ?? 10;
  const minSpeechMs = options.minSpeechMs ?? 120;
  const minSilenceMs = options.minSilenceMs ?? 600;

  return (): Vad => {
    let speaking = false;
    let voicedMs = 0;
    let silentMs = 0;
    let noiseDb: number | undefined;
    return {
      get speaking() {
        return speaking;
      },
      reset() {
        speaking = false;
        voicedMs = 0;
        silentMs = 0;
        noiseDb = undefined;
      },
      process(chunk) {
        const db = rmsDb(chunk);
        if (db === undefined || chunk.format.encoding !== 'pcm16') return undefined;
        const ms = chunk.durationMs ?? ((chunk.data.byteLength >> 1) / chunk.format.sampleRate) * 1000;
        // The floor starts at or below the threshold (the stream may begin mid-speech), drops
        // quickly to quiet audio, rises slowly while idle and is frozen while speaking.
        const floor = noiseDb ?? Math.min(db, thresholdDb);
        noiseDb = db < floor ? floor + (db - floor) * 0.3 : speaking ? floor : floor + (db - floor) * 0.1;
        const voiced = db > thresholdDb && db > floor + marginDb;
        if (!speaking) {
          voicedMs = voiced ? voicedMs + ms : 0;
          if (voicedMs >= minSpeechMs) {
            speaking = true;
            silentMs = 0;
            return 'start';
          }
          return undefined;
        }
        silentMs = voiced ? 0 : silentMs + ms;
        if (silentMs >= minSilenceMs) {
          speaking = false;
          voicedMs = 0;
          return 'end';
        }
        return undefined;
      },
    };
  };
}
