import type { AudioChunk } from './audio.js';

/** Flat, provider-neutral events. Responses are correlated by `responseId`, not nested streams. */
export type RealtimeEvent =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'input.speech.start'; atMs: number }
  | { type: 'input.speech.end'; atMs: number }
  /**
   * The user's words so far, replacing earlier text of `itemId`. A model that numbers
   * its guesses sets `revision`, starting at 1 and growing by one per event of the item.
   */
  | { type: 'input.transcript'; itemId: string; text: string; final: boolean; revision?: number }
  | { type: 'response.start'; responseId: string }
  | { type: 'output.text'; responseId: string; delta: string }
  | { type: 'output.transcript'; responseId: string; itemId: string; delta: string }
  | { type: 'output.audio'; responseId: string; itemId: string; chunk: AudioChunk }
  | { type: 'tool.call.delta'; responseId: string; callId: string; name: string; argumentsDelta: string }
  | { type: 'tool.call'; responseId: string; callId: string; name: string; arguments: unknown }
  | { type: 'response.end'; responseId: string; status: ResponseStatus; usage?: Usage }
  | { type: 'error'; error: Error; recoverable: boolean }
  /** Provider-specific event outside the normalized set (e.g. `conversation.context.summarized`). */
  | { type: 'extension'; name: string; data: unknown };

export type ResponseStatus = 'done' | 'cancelled' | 'interrupted' | 'failed';
export type EventType = RealtimeEvent['type'];
export type EventOf<T extends EventType> = Extract<RealtimeEvent, { type: T }>;

export interface Usage {
  inputAudioMs?: number;
  outputAudioMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Of `inputTokens`, how many the provider read from its prompt cache (usually billed lower). */
  cachedInputTokens?: number;
}

const USAGE_FIELDS = ['inputAudioMs', 'outputAudioMs', 'inputTokens', 'outputTokens', 'cachedInputTokens'] as const;

/** Field-by-field sum; a field is present when either side reports it. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  const sum: Usage = { ...a };
  for (const field of USAGE_FIELDS) {
    const value = b[field];
    if (value !== undefined) sum[field] = (sum[field] ?? 0) + value;
  }
  return sum;
}
