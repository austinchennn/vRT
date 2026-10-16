import type { AudioFormat, Capabilities, RealtimeModel, SessionConfig } from '@vrealtime/core';
import { createCompatibleModel, type SocketFactory } from '@vrealtime/openai-compatible';

export { fetchSocket } from '@vrealtime/openai-compatible';
export type { ProviderSocket, SocketFactory } from '@vrealtime/openai-compatible';

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export interface OpenAIOptions {
  /** Defaults to `process.env.OPENAI_API_KEY` where `process` exists. */
  apiKey?: string;
  /** Default `gpt-realtime-2`. */
  model?: string;
  voice?: string;
  /** `null` for manual turns via `commitAudio()`. Default `semantic`. */
  turnDetection?: 'server' | 'semantic' | null;
  /** Transcribe user speech; on by default. */
  transcription?: boolean | { language?: string };
  /** Default `gpt-4o-transcribe`. */
  transcriptionModel?: string;
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  url?: string;
  /** Custom socket, e.g. `fetchSocket()` on Cloudflare Workers. */
  socket?: SocketFactory;
}

const PCM24: AudioFormat = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

export const OPENAI_CAPABILITIES: Capabilities = {
  input: { audio: true, text: true, formats: [PCM24, { encoding: 'pcmu' }] },
  output: { audio: true, text: true, formats: [PCM24, { encoding: 'pcmu' }] },
  turnDetection: { server: true, semantic: true, manual: true },
  inputTranscription: true,
  tools: { calls: true, argumentStreaming: true, autoReplyAfterResult: false },
  truncate: true,
  midSessionUpdate: { instructions: true, tools: true },
};

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['OPENAI_API_KEY'];
}

/** OpenAI Realtime (GA). */
export function openai(options: OpenAIOptions = {}): RealtimeModel {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new Error('openai: missing apiKey (or OPENAI_API_KEY)');
  const model = options.model ?? 'gpt-realtime-2';
  const defaults: SessionConfig = {
    turnDetection: options.turnDetection === undefined ? 'semantic' : options.turnDetection,
    inputTranscription: options.transcription ?? true,
    inputFormat: options.inputFormat ?? PCM24,
    outputFormat: options.outputFormat ?? PCM24,
    ...(options.voice !== undefined ? { voice: options.voice } : {}),
  };
  const url = new URL(options.url ?? OPENAI_REALTIME_URL);
  url.searchParams.set('model', model);
  return createCompatibleModel({
    provider: 'openai',
    id: model,
    model,
    url: url.toString(),
    headers: { Authorization: `Bearer ${apiKey}` },
    capabilities: OPENAI_CAPABILITIES,
    defaults,
    transcriptionModel: options.transcriptionModel ?? 'gpt-4o-transcribe',
    ...(options.socket ? { socket: options.socket } : {}),
  });
}

export { openaiStt, openaiTts, pcm16ToWav } from './speech.js';
export type { SpeechOptions, SttOptions, TtsOptions } from './speech.js';
