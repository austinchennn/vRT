import type { AudioFormat, Capabilities, RealtimeModel, SessionConfig } from '@vrealtime/core';
import { createCompatibleModel, type SocketFactory } from '@vrealtime/openai-compatible';

export { fetchSocket } from '@vrealtime/openai-compatible';
export type { ProviderSocket, SocketFactory } from '@vrealtime/openai-compatible';

export const BOSON_REALTIME_URL = 'wss://api.boson.ai/v1/realtime';

export interface BosonOptions {
  /** Defaults to `process.env.BOSON_API_KEY` where `process` exists. */
  apiKey?: string;
  model?: string;
  voice?: string;
  /** `null` for manual turns via `commitAudio()`. */
  turnDetection?: 'server' | 'semantic' | null;
  /** Transcribe user speech (`higgs-stt-3.1`); on by default. */
  transcription?: boolean | { language?: string };
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  url?: string;
  /** Custom socket for runtimes whose `WebSocket` cannot set headers (e.g. Cloudflare Workers). */
  socket?: SocketFactory;
}

const PCM = (sampleRate: 8000 | 16000 | 24000 | 48000): AudioFormat => ({ encoding: 'pcm16', sampleRate, channels: 1 });

export const BOSON_CAPABILITIES: Capabilities = {
  input: { audio: true, text: true, formats: [PCM(8000), PCM(16000), PCM(24000), PCM(48000), { encoding: 'pcmu' }, { encoding: 'opus', frameMs: 20 }] },
  output: { audio: true, text: true, formats: [PCM(24000)] },
  turnDetection: { server: true, semantic: true, manual: true },
  inputTranscription: true,
  tools: { calls: true, argumentStreaming: true, autoReplyAfterResult: false },
  truncate: true,
  midSessionUpdate: { instructions: true, tools: true },
};

const EXTENSIONS = ['conversation.context.summarized', 'session.idle_timeout', 'session.max_duration_reached'];

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['BOSON_API_KEY'];
}

/** Boson Higgs Realtime (OpenAI Realtime GA compatible). */
export function boson(options: BosonOptions = {}): RealtimeModel {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new Error('boson: missing apiKey (or BOSON_API_KEY)');
  const model = options.model ?? 'higgs-realtime';
  const defaults: SessionConfig = {
    turnDetection: options.turnDetection === undefined ? 'semantic' : options.turnDetection,
    inputTranscription: options.transcription ?? true,
    inputFormat: options.inputFormat ?? PCM(24000),
    outputFormat: options.outputFormat ?? PCM(24000),
    ...(options.voice !== undefined ? { voice: options.voice } : {}),
  };
  return createCompatibleModel({
    provider: 'boson',
    id: model,
    model,
    url: options.url ?? BOSON_REALTIME_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    capabilities: BOSON_CAPABILITIES,
    defaults,
    transcriptionModel: 'higgs-stt-3.1',
    extensions: EXTENSIONS,
    ...(options.socket ? { socket: options.socket } : {}),
  });
}
