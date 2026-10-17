import type { Wire } from './report.js';

export const INPUT_PROFILE = 'server-input-validation-v1';
export const INPUT_KINDS = ['control-pre', 'control-post', 'types', 'binary-pre', 'binary-post', 'audio-before-ready', 'audio-ready'] as const;
export const INPUT_CASES = INPUT_KINDS.map(kind => `server/input/${kind}`);
export class IncompleteInput extends Error {}

/** Public model observations, not SDK codec/sequence state. Missing data is never zero. */
export function inputEffects(value: Wire): void {
  if (!Number.isInteger(value.sessions) || value.sessions < 0 || !Array.isArray(value.texts) ||
      value.texts.some((text: unknown) => typeof text !== 'string') || !Array.isArray(value.audio) ||
      value.audio.some((item: Wire) => !item || typeof item.hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(item.hex) || !item.format || typeof item.format !== 'object')) {
    throw new Error('Missing/invalid model input observations');
  }
  if (value.sessions > 1 || value.texts.length > 64 || value.audio.length > 64) throw new Error('Unexpected model observation count');
}
export function expectedInputs(value: Wire, sessions: number, texts: string[], payloads: string[], format?: Wire, allowEmpty = false): void {
  inputEffects(value);
  const audio = allowEmpty ? value.audio.filter((item: Wire) => item.hex !== '') : value.audio;
  if (value.sessions !== sessions || JSON.stringify(value.texts) !== JSON.stringify(texts) ||
      JSON.stringify(audio.map((item: Wire) => item.hex)) !== JSON.stringify(payloads) ||
      (allowEmpty && value.audio.filter((item: Wire) => item.hex === '').length > 1)) throw new Error(`Unexpected model inputs: ${JSON.stringify(value)}`);
  for (const item of value.audio) {
    if (!format || item.format.encoding !== format.encoding || item.format.sampleRate !== (format.sampleRate ?? 24000) || item.format.channels !== 1) throw new Error('Model audio format differs from negotiated input');
  }
}
