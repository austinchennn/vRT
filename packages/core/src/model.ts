import type { AudioChunk, AudioFormat } from './audio.js';
import type { EventOf, EventType } from './events.js';
import type { JsonSchema } from './tool.js';

/** What a provider does natively. The runtime fills the gaps (VAD, transcript truncation, auto-reply). */
export interface Capabilities {
  input: { audio: boolean; text: boolean; formats: readonly AudioFormat[] };
  output: { audio: boolean; text: boolean; formats: readonly AudioFormat[] };
  turnDetection: { server: boolean; semantic: boolean; manual: boolean };
  inputTranscription: boolean;
  tools: { calls: boolean; argumentStreaming: boolean; autoReplyAfterResult: boolean };
  truncate: boolean;
  midSessionUpdate: { instructions: boolean; tools: boolean };
}

/** Tool declaration as the model sees it, wherever the tool runs. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface SessionConfig {
  instructions?: string;
  tools?: readonly ToolSpec[];
  voice?: string;
  /** `null` means manual turns via `commitAudio()`. */
  turnDetection?: 'server' | 'semantic' | null;
  modalities?: 'audio' | 'text';
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  /** `vocabulary`: names and terms to bias recognition toward (e.g. words from the open document). */
  inputTranscription?: boolean | { language?: string; vocabulary?: readonly string[] };
  temperature?: number;
}

export interface RespondOptions {
  instructions?: string;
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
}

/** A provider model. Adapters implement this; nothing else in vRealTime knows provider wire formats. */
export interface RealtimeModel {
  readonly provider: string;
  readonly id: string;
  readonly capabilities: Capabilities;
  connect(config: SessionConfig, options?: { signal?: AbortSignal }): Promise<RealtimeSession>;
}

export interface RealtimeSession {
  readonly capabilities: Capabilities;
  update(config: Partial<SessionConfig>): Promise<void>;
  /** Hot path: synchronous, never awaits. */
  sendAudio(chunk: AudioChunk): void;
  commitAudio(): void;
  clearAudio(): void;
  sendText(text: string): void;
  respond(options?: RespondOptions): void;
  cancel(): void;
  /** Align the model's transcript with what the user actually heard. */
  truncate(itemId: string, audioEndMs: number): void;
  submitToolResult(callId: string, output: unknown, options?: { respond?: boolean }): void;
  on<T extends EventType>(type: T, listener: (event: EventOf<T>) => void): () => void;
  close(): Promise<void>;
}
