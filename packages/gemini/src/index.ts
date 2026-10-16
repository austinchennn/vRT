import {
  Emitter,
  fromBase64,
  pcm16DurationMs,
  toBase64,
  type AudioChunk,
  type AudioFormat,
  type Capabilities,
  type EventOf,
  type EventType,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSession,
  type RespondOptions,
  type SessionConfig,
  type Usage,
} from '@vrealtime/core';
import type { ProviderSocket, SocketFactory } from '@vrealtime/openai-compatible';

export type { ProviderSocket, SocketFactory } from '@vrealtime/openai-compatible';

export const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export interface GeminiOptions {
  /** Defaults to `process.env.GEMINI_API_KEY` where `process` exists. Sent as the `key` query parameter. */
  apiKey?: string;
  /** Default `gemini-3.8-live`. */
  model?: string;
  /** A prebuilt voice name, e.g. `Kore`. */
  voice?: string;
  /** `server` (default) uses Gemini's automatic activity detection; `null` sends manual `activityStart` / `activityEnd`. */
  turnDetection?: 'server' | 'semantic' | null;
  /** Transcribe user speech; on by default. Agent speech is always transcribed. */
  transcription?: boolean;
  url?: string;
  socket?: SocketFactory;
}

const PCM = (sampleRate: 8000 | 16000 | 24000 | 48000): AudioFormat => ({ encoding: 'pcm16', sampleRate, channels: 1 });
const OPEN = 1;
/** Keep each `realtimeInput` message well under provider frame limits. */
const MAX_AUDIO_BYTES = 256 * 1024;
const EXTENSIONS = ['toolCallCancellation', 'goAway', 'sessionResumptionUpdate'] as const;

export const GEMINI_CAPABILITIES: Capabilities = {
  // 16 kHz is native; other PCM16 rates are resampled by the API when the MIME rate says so.
  input: { audio: true, text: true, formats: [PCM(16000), PCM(8000), PCM(24000), PCM(48000)] },
  output: { audio: true, text: true, formats: [PCM(24000)] },
  turnDetection: { server: true, semantic: false, manual: true },
  inputTranscription: true,
  tools: { calls: true, argumentStreaming: false, autoReplyAfterResult: true },
  truncate: false,
  midSessionUpdate: { instructions: false, tools: false },
};

const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as ProviderSocket;

type Json = Record<string, any>;

export function setupMessage(model: string, config: SessionConfig): Json {
  const setup: Json = { model: model.startsWith('models/') ? model : `models/${model}` };
  const generationConfig: Json = { responseModalities: [config.modalities === 'text' ? 'TEXT' : 'AUDIO'] };
  if (config.voice !== undefined) generationConfig['speechConfig'] = { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };
  if (config.temperature !== undefined) generationConfig['temperature'] = config.temperature;
  setup['generationConfig'] = generationConfig;
  if (config.instructions) setup['systemInstruction'] = { parts: [{ text: config.instructions }] };
  if (config.tools && config.tools.length > 0) {
    setup['tools'] = [{ functionDeclarations: config.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
  }
  setup['realtimeInputConfig'] = { automaticActivityDetection: { disabled: config.turnDetection === null } };
  if (config.inputTranscription !== false) setup['inputAudioTranscription'] = {};
  if (config.modalities !== 'text') setup['outputAudioTranscription'] = {};
  return { setup };
}

function usageOf(metadata: Json | undefined): Usage | undefined {
  if (!metadata) return undefined;
  return { inputTokens: metadata['promptTokenCount'], outputTokens: metadata['responseTokenCount'] };
}

function rateOf(mimeType: string | undefined): number {
  const rate = /rate=(\d+)/.exec(mimeType ?? '')?.[1];
  return rate ? Number(rate) : 24000;
}

export class GeminiSession implements RealtimeSession {
  readonly capabilities = GEMINI_CAPABILITIES;
  #socket: ProviderSocket;
  #config: SessionConfig;
  #emitter = new Emitter<RealtimeEvent>();
  #closed = false;
  #closing = false;
  #responseCount = 0;
  #response: string | undefined;
  /** After a local `cancel()`, the rest of the current model turn is dropped. */
  #dropping = false;
  #userItem = 0;
  #userText = '';
  #pendingTexts: string[] = [];
  #activityOpen = false;
  #activityJustEnded = false;
  #usage: Json | undefined;
  readonly #callNames = new Map<string, string>();
  /** Calls the server or a local cancel already discarded; their results are not sent. */
  readonly #discardedCalls = new Set<string>();
  readonly #turnCalls: string[] = [];
  #onSetup: ((error?: Error) => void) | undefined;

  constructor(socket: ProviderSocket, config: SessionConfig) {
    this.#socket = socket;
    this.#config = config;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', (event) => this.#onClose(event.code, event.reason));
  }

  /** @internal Resolves on `setupComplete`. */
  waitForSetup(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#onSetup = (error) => (error ? reject(error) : resolve());
    });
  }

  on<T extends EventType>(type: T, listener: (event: EventOf<T>) => void): () => void {
    return this.#emitter.on(type, listener as (event: Extract<RealtimeEvent, { type: T }>) => void);
  }

  async update(config: Partial<SessionConfig>): Promise<void> {
    const unsupported = Object.keys(config).filter((key) => key !== 'inputFormat');
    if (unsupported.length > 0) throw new Error(`gemini: cannot change ${unsupported.join(', ')} after setup`);
    if (config.inputFormat) this.#config = { ...this.#config, inputFormat: config.inputFormat };
  }

  sendAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    if (chunk.format.encoding !== 'pcm16') {
      this.#emit({ type: 'error', error: new Error(`gemini: ${chunk.format.encoding} input is not supported, send PCM16`), recoverable: true });
      return;
    }
    if (this.#config.turnDetection === null && !this.#activityOpen) {
      this.#activityOpen = true;
      this.#send({ realtimeInput: { activityStart: {} } });
    }
    const mimeType = `audio/pcm;rate=${chunk.format.sampleRate}`;
    for (let offset = 0; offset < chunk.data.byteLength; offset += MAX_AUDIO_BYTES) {
      this.#send({ realtimeInput: { audio: { data: toBase64(chunk.data.subarray(offset, offset + MAX_AUDIO_BYTES)), mimeType } } });
    }
  }

  commitAudio(): void {
    if (this.#config.turnDetection === null) {
      if (!this.#activityOpen) return;
      this.#activityOpen = false;
      this.#activityJustEnded = true;
      this.#send({ realtimeInput: { activityEnd: {} } });
    } else {
      this.#send({ realtimeInput: { audioStreamEnd: true } });
    }
  }

  /** Gemini cannot drop buffered input; this is a no-op. */
  clearAudio(): void {}

  sendText(text: string): void {
    this.#pendingTexts.push(text);
  }

  /** Sends pending text as a complete user turn. Gemini replies on its own after `activityEnd` and tool results. */
  respond(_options?: RespondOptions): void {
    if (this.#pendingTexts.length === 0 && this.#activityJustEnded) {
      this.#activityJustEnded = false;
      return;
    }
    this.#activityJustEnded = false;
    const turns = this.#pendingTexts.splice(0).map((text) => ({ role: 'user', parts: [{ text }] }));
    this.#send({ clientContent: turns.length > 0 ? { turns, turnComplete: true } : { turnComplete: true } });
  }

  /** Gemini has no cancel: the current turn ends here and its remaining output is dropped. */
  cancel(): void {
    const response = this.#response;
    if (response === undefined) return;
    this.#dropping = true;
    for (const callId of this.#turnCalls) this.#discardedCalls.add(callId);
    this.#response = undefined;
    this.#emit({ type: 'response.end', responseId: response, status: 'cancelled' });
  }

  /** Unsupported (`capabilities.truncate` is false); the runtime rewrites its transcript instead. */
  truncate(): void {}

  submitToolResult(callId: string, output: unknown): void {
    if (this.#discardedCalls.delete(callId)) return;
    const name = this.#callNames.get(callId) ?? '';
    this.#callNames.delete(callId);
    const response = typeof output === 'object' && output !== null && !Array.isArray(output) ? output : { result: output };
    this.#send({ toolResponse: { functionResponses: [{ id: callId, name, response }] } });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    this.#socket.close(1000, 'closed by client');
  }

  #send(message: Json): void {
    if (this.#closed || this.#socket.readyState !== OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  #emit(event: RealtimeEvent): void {
    this.#emitter.emit(event);
  }

  #onClose(code: number | undefined, reason: string | undefined): void {
    const expected = this.#closing;
    this.#closed = true;
    const error = new Error(`gemini connection closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})`);
    if (this.#onSetup) {
      this.#onSetup(error);
      this.#onSetup = undefined;
      return;
    }
    if (!expected) this.#emit({ type: 'error', error, recoverable: false });
  }

  #openResponse(): string {
    if (this.#response === undefined) {
      this.#finishUserTranscript();
      this.#response = `gemini-response-${++this.#responseCount}`;
      this.#turnCalls.length = 0;
      this.#emit({ type: 'response.start', responseId: this.#response });
    }
    return this.#response;
  }

  #endResponse(status: 'done' | 'interrupted'): void {
    const response = this.#response;
    if (response === undefined) return;
    this.#response = undefined;
    const usage = usageOf(this.#usage);
    this.#usage = undefined;
    this.#emit({ type: 'response.end', responseId: response, status, ...(usage ? { usage } : {}) });
  }

  #finishUserTranscript(): void {
    if (!this.#userText) return;
    this.#emit({ type: 'input.transcript', itemId: `gemini-user-${this.#userItem}`, text: this.#userText, final: true });
    this.#userText = '';
  }

  #onMessage(raw: unknown): void {
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
    else return;
    let message: Json;
    try {
      message = JSON.parse(text) as Json;
    } catch {
      this.#emit({ type: 'error', error: new Error('Unparseable Gemini message'), recoverable: true });
      return;
    }
    if (message['usageMetadata']) this.#usage = message['usageMetadata'];

    if (message['setupComplete']) {
      this.#onSetup?.();
      this.#onSetup = undefined;
      // Setup completes inside connect(), before anyone can subscribe; announce on the next tick.
      setTimeout(() => this.#emit({ type: 'session.ready', sessionId: crypto.randomUUID() }), 0);
      return;
    }
    if (message['serverContent']) {
      this.#onServerContent(message['serverContent']);
      return;
    }
    if (message['toolCall']) {
      this.#onToolCall(message['toolCall']['functionCalls'] ?? []);
      return;
    }
    for (const name of EXTENSIONS) {
      if (!message[name]) continue;
      if (name === 'toolCallCancellation') for (const id of message[name]['ids'] ?? []) this.#discardedCalls.add(id);
      this.#emit({ type: 'extension', name, data: message[name] });
      return;
    }
  }

  #onServerContent(content: Json): void {
    if (content['inputTranscription']?.text) {
      if (!this.#userText) this.#userItem++;
      this.#userText += content['inputTranscription'].text;
      this.#emit({ type: 'input.transcript', itemId: `gemini-user-${this.#userItem}`, text: this.#userText, final: false });
    }
    if (content['interrupted']) {
      // Barge-in: Gemini's activity detection heard the user over the agent.
      this.#dropping = false;
      for (const callId of this.#turnCalls) this.#discardedCalls.add(callId);
      this.#emit({ type: 'input.speech.start', atMs: 0 });
      this.#endResponse('interrupted');
      return;
    }
    if (!this.#dropping) {
      const parts: Json[] = content['modelTurn']?.parts ?? [];
      const outputText: string | undefined = content['outputTranscription']?.text;
      if (parts.length > 0 || outputText) {
        const responseId = this.#openResponse();
        const itemId = `${responseId}-audio`;
        for (const part of parts) {
          if (part['thought']) continue;
          const inline = part['inlineData'];
          if (inline?.data && String(inline.mimeType ?? '').startsWith('audio/pcm')) {
            const data = fromBase64(inline.data);
            const sampleRate = rateOf(inline.mimeType) as 8000 | 16000 | 24000 | 48000;
            const chunk: AudioChunk = { data, format: PCM(sampleRate), durationMs: pcm16DurationMs(data.byteLength, sampleRate) };
            this.#emit({ type: 'output.audio', responseId, itemId, chunk });
          } else if (typeof part['text'] === 'string') {
            this.#emit({ type: 'output.text', responseId, delta: part['text'] });
          }
        }
        if (outputText) this.#emit({ type: 'output.transcript', responseId, itemId, delta: outputText });
      }
    }
    if (content['turnComplete']) {
      this.#finishUserTranscript();
      if (this.#dropping) {
        this.#dropping = false;
        this.#usage = undefined;
      } else {
        this.#endResponse('done');
      }
    }
  }

  #onToolCall(calls: Json[]): void {
    if (this.#dropping) {
      for (const call of calls) this.#discardedCalls.add(call['id']);
      return;
    }
    const responseId = this.#openResponse();
    for (const call of calls) {
      this.#callNames.set(call['id'], call['name']);
      this.#turnCalls.push(call['id']);
      this.#emit({ type: 'tool.call', responseId, callId: call['id'], name: call['name'], arguments: call['args'] ?? {} });
    }
    // Gemini continues after the tool responses; that continuation is a new response.
    this.#endResponse('done');
  }
}

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['GEMINI_API_KEY'] ?? env?.['GOOGLE_API_KEY'];
}

/** Gemini Live API (BidiGenerateContent over WebSocket). */
export function gemini(options: GeminiOptions = {}): RealtimeModel {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new Error('gemini: missing apiKey (or GEMINI_API_KEY)');
  const model = options.model ?? 'gemini-3.8-live';
  const url = new URL(options.url ?? GEMINI_LIVE_URL);
  url.searchParams.set('key', apiKey);
  return {
    provider: 'gemini',
    id: model,
    capabilities: GEMINI_CAPABILITIES,
    async connect(config, connectOptions) {
      const signal = connectOptions?.signal;
      signal?.throwIfAborted();
      const merged: SessionConfig = {
        turnDetection: options.turnDetection === undefined ? 'server' : options.turnDetection,
        inputTranscription: options.transcription ?? true,
        inputFormat: PCM(16000),
        outputFormat: PCM(24000),
        ...(options.voice !== undefined ? { voice: options.voice } : {}),
        ...config,
      };
      const socket = await (options.socket ?? defaultSocket)(url.toString(), {});
      const session = new GeminiSession(socket, merged);
      const ready = session.waitForSetup();
      const onAbort = () => socket.close(1000, 'aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const sendSetup = () => socket.send(JSON.stringify(setupMessage(model, merged)));
      if (socket.readyState === OPEN) sendSetup();
      else socket.addEventListener('open', sendSetup);
      try {
        await ready;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      signal?.throwIfAborted();
      return session;
    },
  };
}
