import type { AudioChunk } from './audio.js';

/** Flat, provider-neutral events. Responses are correlated by `responseId`, not nested streams. */
export type RealtimeEvent =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'input.speech.start'; atMs: number }
  | { type: 'input.speech.end'; atMs: number }
  | { type: 'input.transcript'; itemId: string; text: string; final: boolean }
  | { type: 'response.start'; responseId: string }
  | { type: 'output.text'; responseId: string; delta: string }
  | { type: 'output.transcript'; responseId: string; itemId: string; delta: string }
  | { type: 'output.audio'; responseId: string; itemId: string; chunk: AudioChunk }
  | { type: 'tool.call.delta'; responseId: string; callId: string; name: string; argumentsDelta: string }
  | { type: 'tool.call'; responseId: string; callId: string; name: string; arguments: unknown }
  | { type: 'response.end'; responseId: string; status: ResponseStatus; usage?: Usage }
  | { type: 'error'; error: Error; recoverable: boolean };

export type ResponseStatus = 'done' | 'cancelled' | 'interrupted' | 'failed';
export type EventType = RealtimeEvent['type'];
export type EventOf<T extends EventType> = Extract<RealtimeEvent, { type: T }>;

export interface Usage {
  inputAudioMs?: number;
  outputAudioMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
