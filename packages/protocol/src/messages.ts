/**
 * vRealTime wire protocol v1 between an app (client) and a vRealTime server.
 * Control messages are JSON text frames; audio is binary frames (see `AudioFrameHeader`).
 * The normative definition is spec/ (protocol.md and the JSON Schemas); this is its
 * TypeScript implementation. Kept dependency-free so any app can implement it.
 */
export const PROTOCOL_VERSION = 1 as const;

export type AudioEncoding = 'pcm16' | 'opus' | 'pcmu';
export interface WireAudioFormat { encoding: AudioEncoding; sampleRate?: number }
export interface WireToolSpec { name: string; description: string; parameters: { readonly [key: string]: unknown } }

/** Binary frame layout: [kind u8][seq u32 BE][payload]. kind 1 = input audio, 2 = output audio. */
export interface AudioFrameHeader { kind: 1 | 2; seq: number }
export const AUDIO_HEADER_BYTES = 5;

interface Envelope { v: typeof PROTOCOL_VERSION; seq: number }

export type ClientMessage = Envelope & (
  /**
   * `sessionId` + `resumeFrom` (the last server seq the client handled) resume a session after a reconnect.
   * `capabilities` offers optional protocol features; `ready.capabilities` says which are in effect.
   * `auth` carries a short-lived token in the first message instead of the URL.
   */
  | { type: 'hello'; tools: WireToolSpec[]; input?: WireAudioFormat; output?: WireAudioFormat; sessionId?: string; resumeFrom?: number; capabilities?: string[]; context?: unknown; auth?: string }
  | { type: 'text'; text: string }
  | { type: 'interrupt'; epoch: number; reason: 'speech' | 'user' | 'keyboard' }
  | { type: 'playback'; itemId: string; playedMs: number }
  | { type: 'tool.result'; callId: string; epoch: number; ok: true; output: unknown }
  | { type: 'tool.result'; callId: string; epoch: number; ok: false; code: 'INTERRUPTED' | 'REJECTED' | 'INVALID' | 'TIMEOUT' | 'FAILED'; message: string }
  | { type: 'context'; context: unknown }
  | { type: 'ack'; upTo: number }
  | { type: 'ping' }
);

export type TurnStateWire = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';

export type ServerMessage = Envelope & (
  /**
   * `input`/`output` are the formats the client must send and will receive. `resumedFrom` is the last client seq the server handled.
   * `capabilities` are the optional features in effect for the session; absent means none.
   */
  | { type: 'ready'; sessionId: string; input: WireAudioFormat; output: WireAudioFormat; resumedFrom?: number; capabilities?: string[] }
  /** Binary output frames that follow belong to this item until the next `audio.start`. */
  | { type: 'audio.start'; itemId: string; responseId: string; epoch: number }
  | { type: 'turn.state'; turnId: string; epoch: number; state: TurnStateWire }
  | { type: 'transcript'; role: 'user' | 'agent'; itemId: string; text: string; final: boolean }
  | { type: 'text'; responseId: string; delta: string }
  | { type: 'tool.call.delta'; callId: string; epoch: number; name: string; preview: unknown }
  | { type: 'tool.call'; callId: string; epoch: number; turnId: string; name: string; arguments: unknown }
  | { type: 'interrupted'; epoch: number }
  | { type: 'ack'; upTo: number }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string; recoverable: boolean }
);

export type MessageType<M extends { type: string }> = M['type'];

/**
 * Per-connection messages: never stored for resend and never deduplicated; they carry `seq: 0`.
 * `audio.start` is here because the audio it announces is never resent either.
 */
export const TRANSIENT_TYPES: ReadonlySet<string> = new Set(['hello', 'ready', 'audio.start', 'ack', 'ping', 'pong']);

/** Sequenced types that carry `seq: 0` when sent before a session exists (e.g. `UNAUTHORIZED`). */
export const SESSIONLESS_TYPES: ReadonlySet<string> = new Set(['error']);
