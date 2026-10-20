/**
 * Shared base for providers that speak the OpenAI Realtime GA protocol
 * (Boson Higgs Realtime, OpenAI Realtime). Providers supply the endpoint, auth,
 * capabilities and their extension events; everything else lives here.
 */
import {
  Emitter,
  Pcm16Resampler,
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
  type ResponseStatus,
  type SessionConfig,
} from '@vrealtime/core';

/** The subset of WebSocket the adapter needs; Node 22+, Bun, Deno and browsers all provide it. */
export interface ProviderSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}

/**
 * Opens a socket with auth headers. It may return a socket that is already open.
 * The default uses the global `WebSocket` with a `headers` init (Node 22+/undici, Bun).
 */
export type SocketFactory = (url: string, headers: Record<string, string>) => ProviderSocket | Promise<ProviderSocket>;

export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => ProviderSocket)(url, { headers });

type UpgradeFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; webSocket?: (ProviderSocket & { accept(): void }) | null }>;

/**
 * Opens provider sockets through a `fetch` upgrade, for runtimes whose `WebSocket`
 * cannot send headers (Cloudflare Workers, Durable Objects).
 */
export function fetchSocket(fetchImpl: UpgradeFetch = fetch as unknown as UpgradeFetch): SocketFactory {
  return async (url, headers) => {
    const response = await fetchImpl(url.replace(/^ws/, 'http'), { headers: { ...headers, Upgrade: 'websocket' } });
    const socket = response.webSocket;
    if (!socket) throw new Error(`WebSocket upgrade failed (HTTP ${response.status})`);
    socket.accept();
    return socket;
  };
}

export interface CompatibleOptions {
  provider: string;
  id: string;
  url: string;
  headers: Record<string, string>;
  capabilities: Capabilities;
  /** Session config applied under every `connect()` config (voice, turn detection, formats...). */
  defaults: SessionConfig;
  /** Model name sent in the first `session.update`. */
  model: string;
  transcriptionModel: string;
  /** Provider-specific server events surfaced as `extension` events. */
  extensions?: readonly string[];
  /**
   * Server event that acknowledges the first `session.update` and emits `session.ready`.
   * OpenAI sends `session.created` on connect, so its ack is `session.updated` (the default).
   */
  readyOn?: 'session.created' | 'session.updated';
  /** Maps an unexpected socket close to a provider error; `undefined` keeps the generic one. */
  describeClose?: (close: CloseContext) => CloseDescription | undefined;
  socket?: SocketFactory;
}

/** What the session saw up to an unexpected socket close. */
export interface CloseContext {
  code: number | undefined;
  reason: string | undefined;
  /** Payload of the last `error` event (`type`, `code`, `message`). */
  lastError: { type?: string; code?: string; message?: string } | undefined;
  /** Type of the last extension event, e.g. `session.idle_timeout`. */
  lastExtension: string | undefined;
}

/** Attached to the close error as `code` and `providerType`, like `error` events. */
export interface CloseDescription {
  code: string;
  type?: string;
  message: string;
}

/** One provider `input_audio_buffer.append` must stay under 1 MiB; base64 grows 4/3, so cap raw bytes (even, for PCM16). */
export const MAX_APPEND_BYTES = 785_408;
/** Recent user items whose final transcript was emitted; a repeat `completed` for one of them is dropped. */
export const FINAL_TRANSCRIPT_MEMORY = 64;
const OPEN = 1;
const DEFAULT_FORMAT: AudioFormat = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

export function wireFormat(format: AudioFormat): Record<string, unknown> {
  switch (format.encoding) {
    case 'pcm16':
      return { type: 'audio/pcm', rate: format.sampleRate };
    case 'pcmu':
      return { type: 'audio/pcmu' };
    case 'opus':
      return { type: 'audio/opus' };
  }
}

/** Translates (a partial) `SessionConfig` into a GA `session` object; only provided fields are sent. */
export function sessionPayload(config: Partial<SessionConfig>, options: { model?: string; transcriptionModel: string }): Record<string, unknown> {
  const session: Record<string, unknown> = { type: 'realtime' };
  if (options.model !== undefined) session['model'] = options.model;
  if (config.instructions !== undefined) session['instructions'] = config.instructions;
  if (config.modalities !== undefined) session['output_modalities'] = [config.modalities];
  if (config.temperature !== undefined) session['temperature'] = config.temperature;
  if (config.tools !== undefined) {
    session['tools'] = config.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
    session['tool_choice'] = 'auto';
  }
  const input: Record<string, unknown> = {};
  if (config.inputFormat !== undefined) input['format'] = wireFormat(config.inputFormat);
  if (config.turnDetection !== undefined) {
    input['turn_detection'] = config.turnDetection === null ? null : { type: config.turnDetection === 'semantic' ? 'semantic_vad' : 'server_vad' };
  }
  if (config.inputTranscription !== undefined) {
    const { inputTranscription: t } = config;
    input['transcription'] = t === false ? null : {
      model: options.transcriptionModel,
      ...(typeof t === 'object' && t.language ? { language: t.language } : {}),
      ...(typeof t === 'object' && t.vocabulary?.length ? { prompt: t.vocabulary.join(', ') } : {}),
    };
  }
  const output: Record<string, unknown> = {};
  if (config.outputFormat !== undefined) output['format'] = wireFormat(config.outputFormat);
  if (config.voice !== undefined) output['voice'] = config.voice;
  const audio: Record<string, unknown> = {};
  if (Object.keys(input).length > 0) audio['input'] = input;
  if (Object.keys(output).length > 0) audio['output'] = output;
  if (Object.keys(audio).length > 0) session['audio'] = audio;
  return session;
}

function responseStatus(response: { status?: string; status_details?: { reason?: string } } | undefined): ResponseStatus {
  switch (response?.status) {
    case 'cancelled':
      return response.status_details?.reason === 'turn_detected' ? 'interrupted' : 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'done';
  }
}

function sameFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && (a.encoding !== 'pcm16' || (b.encoding === 'pcm16' && a.sampleRate === b.sampleRate));
}

type Json = Record<string, any>;

export class CompatibleSession implements RealtimeSession {
  readonly capabilities: Capabilities;
  #socket: ProviderSocket;
  #options: CompatibleOptions;
  #emitter = new Emitter<RealtimeEvent>();
  #inputFormat: AudioFormat;
  #outputFormat: AudioFormat;
  #resampler: Pcm16Resampler | undefined;
  #sessionId = '';
  #ready = false;
  #closing = false;
  #closed = false;
  #lastError: CloseContext['lastError'];
  #lastExtension: string | undefined;
  readonly #callNames = new Map<string, string>();
  readonly #userTranscripts = new Map<string, string>();
  readonly #finalTranscripts = new Set<string>();

  constructor(socket: ProviderSocket, config: SessionConfig, options: CompatibleOptions) {
    this.#socket = socket;
    this.#options = options;
    this.capabilities = options.capabilities;
    this.#inputFormat = config.inputFormat ?? DEFAULT_FORMAT;
    this.#outputFormat = config.outputFormat ?? DEFAULT_FORMAT;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', (event) => this.#onClose(event.code, event.reason));
  }

  on<T extends EventType>(type: T, listener: (event: EventOf<T>) => void): () => void {
    return this.#emitter.on(type, listener as (event: Extract<RealtimeEvent, { type: T }>) => void);
  }

  async update(config: Partial<SessionConfig>): Promise<void> {
    if (config.inputFormat) this.#setInputFormat(config.inputFormat);
    if (config.outputFormat) this.#outputFormat = config.outputFormat;
    this.#send({ type: 'session.update', session: sessionPayload(config, { transcriptionModel: this.#options.transcriptionModel }) });
  }

  sendAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    let data = chunk.data;
    if (!sameFormat(chunk.format, this.#inputFormat)) {
      // Pass-through is the norm; convert only PCM16 rate mismatches.
      if (chunk.format.encoding !== 'pcm16' || this.#inputFormat.encoding !== 'pcm16') {
        this.#emitter.emit({ type: 'error', error: new Error(`Cannot convert ${chunk.format.encoding} to ${this.#inputFormat.encoding}`), recoverable: true });
        return;
      }
      if (this.#resampler?.from !== chunk.format.sampleRate) this.#resampler = new Pcm16Resampler(chunk.format.sampleRate, this.#inputFormat.sampleRate);
      data = this.#resampler.process(data);
    }
    for (let offset = 0; offset < data.byteLength; offset += MAX_APPEND_BYTES) {
      this.#send({ type: 'input_audio_buffer.append', audio: toBase64(data.subarray(offset, offset + MAX_APPEND_BYTES)) });
    }
  }

  commitAudio(): void {
    this.#send({ type: 'input_audio_buffer.commit' });
  }

  clearAudio(): void {
    this.#send({ type: 'input_audio_buffer.clear' });
  }

  sendText(text: string): void {
    this.#send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  }

  respond(options?: RespondOptions): void {
    const response: Json = {};
    if (options?.instructions !== undefined) response['instructions'] = options.instructions;
    if (options?.toolChoice !== undefined) {
      response['tool_choice'] = typeof options.toolChoice === 'string' ? options.toolChoice : { type: 'function', name: options.toolChoice.name };
    }
    this.#send(Object.keys(response).length > 0 ? { type: 'response.create', response } : { type: 'response.create' });
  }

  cancel(): void {
    this.#send({ type: 'response.cancel' });
  }

  truncate(itemId: string, audioEndMs: number): void {
    this.#send({ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) });
  }

  submitToolResult(callId: string, output: unknown, options?: { respond?: boolean }): void {
    this.#send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: typeof output === 'string' ? output : JSON.stringify(output ?? null) },
    });
    if (options?.respond !== false) this.respond();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    this.#socket.close(1000, 'closed by client');
  }

  #setInputFormat(format: AudioFormat): void {
    this.#inputFormat = format;
    this.#resampler = undefined;
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
    if (expected) return;
    const message = `${this.#options.provider} connection closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})`;
    const described = this.#options.describeClose?.({ code, reason, lastError: this.#lastError, lastExtension: this.#lastExtension });
    const error = described
      ? Object.assign(new Error(`${message}: ${described.message}`), { code: described.code, providerType: described.type })
      : new Error(message);
    this.#emit({ type: 'error', error, recoverable: false });
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Json;
    try {
      message = JSON.parse(raw) as Json;
    } catch {
      this.#emit({ type: 'error', error: new Error('Unparseable provider event'), recoverable: true });
      return;
    }
    const type = message['type'] as string;
    switch (type) {
      case 'session.created':
      case 'session.updated':
        if (type === 'session.created') this.#sessionId = message['session']?.id ?? this.#sessionId;
        if (!this.#ready && type === (this.#options.readyOn ?? 'session.updated')) {
          this.#ready = true;
          this.#emit({ type: 'session.ready', sessionId: this.#sessionId || message['session']?.id || '' });
        }
        return;
      case 'input_audio_buffer.speech_started':
        this.#emit({ type: 'input.speech.start', atMs: message['audio_start_ms'] ?? 0 });
        return;
      case 'input_audio_buffer.speech_stopped':
        this.#emit({ type: 'input.speech.end', atMs: message['audio_end_ms'] ?? 0 });
        return;
      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = message['item_id'] as string;
        const text = (this.#userTranscripts.get(itemId) ?? '') + (message['delta'] ?? '');
        this.#userTranscripts.set(itemId, text);
        this.#emit({ type: 'input.transcript', itemId, text, final: false });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        // Boson repeats `completed` for the same item; core expects one final per item.
        const itemId = message['item_id'] as string;
        this.#userTranscripts.delete(itemId);
        if (this.#finalTranscripts.has(itemId)) return;
        this.#finalTranscripts.add(itemId);
        if (this.#finalTranscripts.size > FINAL_TRANSCRIPT_MEMORY) this.#finalTranscripts.delete(this.#finalTranscripts.values().next().value!);
        this.#emit({ type: 'input.transcript', itemId, text: message['transcript'] ?? '', final: true });
        return;
      }
      case 'response.created':
        this.#emit({ type: 'response.start', responseId: message['response']?.id });
        return;
      case 'response.output_text.delta':
      case 'response.text.delta':
        this.#emit({ type: 'output.text', responseId: message['response_id'], delta: message['delta'] ?? '' });
        return;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.#emit({ type: 'output.transcript', responseId: message['response_id'], itemId: message['item_id'], delta: message['delta'] ?? '' });
        return;
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const data = fromBase64(message['delta'] ?? '');
        const format = this.#outputFormat;
        const chunk: AudioChunk = format.encoding === 'pcm16'
          ? { data, format, durationMs: pcm16DurationMs(data.byteLength, format.sampleRate) }
          : { data, format };
        this.#emit({ type: 'output.audio', responseId: message['response_id'], itemId: message['item_id'], chunk });
        return;
      }
      case 'response.output_item.added': {
        const item = message['item'];
        if (item?.type === 'function_call') this.#callNames.set(item.call_id, item.name);
        return;
      }
      case 'response.function_call_arguments.delta':
        this.#emit({
          type: 'tool.call.delta',
          responseId: message['response_id'],
          callId: message['call_id'],
          name: this.#callNames.get(message['call_id']) ?? '',
          argumentsDelta: message['delta'] ?? '',
        });
        return;
      case 'response.function_call_arguments.done': {
        const callId = message['call_id'] as string;
        const name = (message['name'] as string | undefined) ?? this.#callNames.get(callId) ?? '';
        this.#callNames.delete(callId);
        let args: unknown = message['arguments'];
        try {
          args = JSON.parse(String(message['arguments'] ?? '{}'));
        } catch {
          // Leave malformed arguments as the raw string; tool validation reports it.
        }
        this.#emit({ type: 'tool.call', responseId: message['response_id'], callId, name, arguments: args });
        return;
      }
      case 'response.done': {
        const response = message['response'];
        const usage = response?.usage;
        this.#emit({
          type: 'response.end',
          responseId: response?.id,
          status: responseStatus(response),
          ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
        });
        return;
      }
      case 'error': {
        const detail = message['error'] ?? {};
        this.#lastError = { type: detail.type, code: detail.code, message: detail.message };
        const error = Object.assign(new Error(detail.message ?? 'Provider error'), { code: detail.code, providerType: detail.type });
        this.#emit({ type: 'error', error, recoverable: true });
        return;
      }
      default:
        if (this.#options.extensions?.includes(type)) {
          this.#lastExtension = type;
          this.#emit({ type: 'extension', name: type, data: message });
        }
    }
  }
}

export function createCompatibleModel(options: CompatibleOptions): RealtimeModel {
  return {
    provider: options.provider,
    id: options.id,
    capabilities: options.capabilities,
    async connect(config, connectOptions) {
      const signal = connectOptions?.signal;
      signal?.throwIfAborted();
      const merged: SessionConfig = { ...options.defaults, ...config };
      const socket = await (options.socket ?? defaultSocketFactory)(options.url, options.headers);
      if (signal?.aborted) {
        socket.close(1000, 'aborted');
        signal.throwIfAborted();
      }
      if (socket.readyState > OPEN) throw new Error(`${options.provider}: connection closed before open`);
      const session = new CompatibleSession(socket, merged, options);
      if (socket.readyState !== OPEN) await waitForOpen(socket, options.provider, signal);
      socket.send(JSON.stringify({ type: 'session.update', session: sessionPayload(merged, options) }));
      return session;
    },
  };
}

function waitForOpen(socket: ProviderSocket, provider: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      socket.close(1000, 'aborted');
      fail(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    socket.addEventListener('error', () => fail(new Error(`${provider}: connection failed`)));
    socket.addEventListener('close', (event) => fail(new Error(`${provider}: connection closed before open (${event.code ?? ''})`)));
  });
}
