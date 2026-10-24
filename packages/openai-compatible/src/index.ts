/**
 * Shared base for providers that speak the OpenAI Realtime GA protocol
 * (Boson Higgs Realtime, OpenAI Realtime). Providers supply the endpoint, auth,
 * capabilities and their extension events; everything else lives here.
 */
import {
  BoundedMap,
  BoundedSet,
  Emitter,
  Pcm16Resampler,
  RealtimeError,
  fromBase64,
  pcm16DurationMs,
  toBase64,
  type AudioChunk,
  type AudioFormat,
  type Capabilities,
  type EventOf,
  type EventType,
  type RealtimeErrorCode,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSession,
  type RespondOptions,
  type ResponseStatus,
  type SessionConfig,
  type StopReason,
  type Usage,
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
    if (!socket) throw new RealtimeError(response.status === 401 || response.status === 403 ? 'auth' : 'connection', `WebSocket upgrade failed (HTTP ${response.status})`, { providerCode: String(response.status) });
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
  /** How the provider's errors map onto `RealtimeErrorCode`, on top of `OPENAI_ERROR_TYPES`. */
  errors?: ErrorTables;
  /**
   * Tools the provider runs itself, sent as-is next to the app's function tools
   * (Boson's `{ type: 'web_search' }`). Their `type` is a reserved tool name.
   */
  builtinTools?: readonly BuiltinTool[];
  socket?: SocketFactory;
}

/** A provider-executed tool in its wire form, e.g. `{ type: 'web_search', allowed_domains: ['example.org'] }`. */
export interface BuiltinTool {
  readonly type: string;
  readonly [option: string]: unknown;
}

/**
 * Extension events for calls the provider executes itself (`executor: "server"`).
 * They are never `tool.call`s: the app must not answer them, and the provider replies on its own.
 */
export const SERVER_TOOL_CALL = 'server_tool.call';
export const SERVER_TOOL_RESULT = 'server_tool.result';

/**
 * A provider's error vocabulary as data, so a provider differs from the base by
 * tables rather than code. Anything unmapped is `provider` (error events) or
 * `connection` (closes).
 */
export interface ErrorTables {
  /** `error.type` of an `error` event → code; merged over `OPENAI_ERROR_TYPES`. */
  errorTypes?: Readonly<Record<string, RealtimeErrorCode>>;
  /** Close code of an unexpected socket close, also before open → code. */
  closeCodes?: Readonly<Record<number, RealtimeErrorCode>>;
  /** Server events after which a normal close (1000) is a `session_limit`. */
  sessionLimitEvents?: readonly string[];
}

/** The error types of the OpenAI Realtime API, which compatible providers share. */
export const OPENAI_ERROR_TYPES: Readonly<Record<string, RealtimeErrorCode>> = {
  authentication_error: 'auth',
  insufficient_quota: 'quota',
  rate_limit_error: 'rate_limited',
  invalid_request_error: 'invalid_request',
  server_error: 'provider',
  api_error: 'provider',
};

/** One provider `input_audio_buffer.append` must stay under 1 MiB; base64 grows 4/3, so cap raw bytes (even, for PCM16). */
export const MAX_APPEND_BYTES = 785_408;
/**
 * User items remembered per session for transcription: partial text still being
 * streamed, and items whose final transcript was emitted (a repeat `completed` is dropped).
 */
export const TRANSCRIPT_MEMORY = 64;
/** Provider-executed calls remembered until their result arrives; an unanswered one cannot pin memory. */
export const SERVER_CALL_MEMORY = 64;
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

/** Function tools that would take a built-in tool's reserved name. */
export function conflictingTools(config: Partial<SessionConfig>, builtinTools: readonly BuiltinTool[] = []): string[] {
  const reserved = new Set(builtinTools.map((tool) => tool.type));
  return (config.tools ?? []).filter((tool) => reserved.has(tool.name)).map((tool) => tool.name);
}

/**
 * Translates (a partial) `SessionConfig` into a GA `session` object; only provided fields are sent.
 * Built-in tools go with every tool list, since a `tools` update replaces the whole list;
 * a function tool with a built-in's reserved name is left out.
 */
export function sessionPayload(config: Partial<SessionConfig>, options: { model?: string; transcriptionModel: string; builtinTools?: readonly BuiltinTool[] }): Record<string, unknown> {
  const session: Record<string, unknown> = { type: 'realtime' };
  if (options.model !== undefined) session['model'] = options.model;
  if (config.instructions !== undefined) session['instructions'] = config.instructions;
  if (config.modalities !== undefined) session['output_modalities'] = [config.modalities];
  if (config.temperature !== undefined) session['temperature'] = config.temperature;
  if (config.tools !== undefined) {
    const builtins = options.builtinTools ?? [];
    const reserved = new Set(builtins.map((tool) => tool.type));
    session['tools'] = [
      ...config.tools.filter((tool) => !reserved.has(tool.name)).map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })),
      ...builtins,
    ];
    // The model decides when to call any of them, built-ins included.
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

/**
 * Whether a call is run by the provider itself: marked `executor: "server"`, or (for
 * providers that omit the mark) named after one of the session's built-in tools.
 */
function isServerCall(item: Json | undefined, reserved: ReadonlySet<string>): boolean {
  return item?.['executor'] === 'server' || (item?.['executor'] === undefined && reserved.has(item?.['name']));
}

function stopReasonOf(response: Json | undefined, reserved: ReadonlySet<string>): StopReason {
  if (response?.['status'] === 'cancelled') return 'cancelled';
  if (response?.['status'] === 'failed') return 'failed';
  const reason = response?.['status_details']?.reason;
  if (reason === 'content_filter') return 'content_filter';
  if (response?.['status'] === 'incomplete') {
    return reason === 'max_output_tokens' || reason === 'max_tokens' ? 'max_tokens' : 'unknown';
  }
  if (response?.['status'] === 'completed') {
    // A provider-run call is not the app's to answer: the provider continues with its result in a response of its own.
    return response['output']?.some((item: Json) => item['type'] === 'function_call' && !isServerCall(item, reserved)) ? 'tool_calls' : 'completed';
  }
  return 'unknown';
}

function sameFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && (a.encoding !== 'pcm16' || (b.encoding === 'pcm16' && a.sampleRate === b.sampleRate));
}

function usageOf(usage: Json | null | undefined): Usage | undefined {
  if (!usage) return undefined;
  const cached = usage['input_token_details']?.['cached_tokens'];
  return { inputTokens: usage['input_tokens'], outputTokens: usage['output_tokens'], ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}) };
}

function closeCode(tables: ErrorTables | undefined, code: number | undefined): RealtimeErrorCode | undefined {
  return code === undefined ? undefined : tables?.closeCodes?.[code];
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
  readonly #errorTypes: Readonly<Record<string, RealtimeErrorCode>>;
  /** The last provider `error` event; it explains a close that follows it, e.g. billing before 4429. */
  #lastError: RealtimeError | undefined;
  /** A session-limit event the provider sent; the normal close after it is a `session_limit`. */
  #sessionLimit: string | undefined;
  readonly #callNames = new Map<string, string>();
  /** Calls the provider runs itself, by call id → name, until their result arrives. */
  readonly #serverCalls = new BoundedMap<string, string>(SERVER_CALL_MEMORY);
  /** Names of the session's built-in tools, which only the provider may call. */
  readonly #reserved: ReadonlySet<string>;
  /** Partial user transcripts by item; a transcription that fails or never completes cannot pin them. */
  readonly #userTranscripts = new BoundedMap<string, string>(TRANSCRIPT_MEMORY);
  readonly #finalTranscripts = new BoundedSet<string>(TRANSCRIPT_MEMORY);

  constructor(socket: ProviderSocket, config: SessionConfig, options: CompatibleOptions) {
    this.#socket = socket;
    this.#options = options;
    this.capabilities = options.capabilities;
    this.#errorTypes = { ...OPENAI_ERROR_TYPES, ...options.errors?.errorTypes };
    this.#reserved = new Set((options.builtinTools ?? []).map((tool) => tool.type));
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
    const conflicts = conflictingTools(config, this.#options.builtinTools);
    if (conflicts.length > 0) {
      this.#emit({ type: 'error', error: this.#error('invalid_request', `Tool name ${conflicts.join(', ')} is reserved for a built-in tool; that function tool was not sent`), recoverable: true });
    }
    this.#send({ type: 'session.update', session: sessionPayload(config, { transcriptionModel: this.#options.transcriptionModel, ...(this.#options.builtinTools ? { builtinTools: this.#options.builtinTools } : {}) }) });
  }

  sendAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    let data = chunk.data;
    if (!sameFormat(chunk.format, this.#inputFormat)) {
      // Pass-through is the norm; convert only PCM16 rate mismatches.
      if (chunk.format.encoding !== 'pcm16' || this.#inputFormat.encoding !== 'pcm16') {
        this.#emit({ type: 'error', error: this.#error('unsupported', `Cannot convert ${chunk.format.encoding} to ${this.#inputFormat.encoding}`), recoverable: true });
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

  #error(code: RealtimeErrorCode, message: string, providerCode?: string, cause?: unknown): RealtimeError {
    return new RealtimeError(code, message, { provider: this.#options.provider, providerCode, cause });
  }

  #onClose(code: number | undefined, reason: string | undefined): void {
    const expected = this.#closing;
    this.#closed = true;
    if (expected) return;
    const limited = code === 1000 && this.#sessionLimit !== undefined;
    const mapped = closeCode(this.#options.errors, code) ?? (limited ? 'session_limit' : 'connection');
    // The error event the provider sent before closing names the cause better than the close frame.
    const before = this.#lastError?.code === mapped ? this.#lastError : undefined;
    const detail = before ? `: ${before.message}` : limited ? `: ${this.#sessionLimit}` : '';
    const message = `${this.#options.provider} connection closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})${detail}`;
    this.#emit({ type: 'error', error: this.#error(mapped, message, code === undefined ? undefined : String(code), before), recoverable: false });
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Json;
    try {
      message = JSON.parse(raw) as Json;
    } catch {
      this.#emit({ type: 'error', error: this.#error('provider', 'Unparseable provider event'), recoverable: true });
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
        this.#emit({ type: 'input.transcript', itemId, text: message['transcript'] ?? '', final: true });
        return;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        // No final transcript follows; the conversation itself goes on.
        const detail = message['error'] ?? {};
        this.#userTranscripts.delete(message['item_id']);
        const error = this.#error('transcription', detail.message ?? 'Transcription failed', detail.code ?? detail.type, message);
        this.#emit({ type: 'error', error, recoverable: true });
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
        if (item?.type !== 'function_call') return;
        if (isServerCall(item, this.#reserved)) this.#serverCalls.set(item.call_id, item.name);
        else this.#callNames.set(item.call_id, item.name);
        return;
      }
      case 'conversation.item.added':
      case 'conversation.item.created':
      case 'conversation.item.done': {
        // The provider adds the result of a call it ran, then answers in a response of its own.
        const item = message['item'];
        if (item?.type !== 'function_call_output' || !this.#serverCalls.has(item.call_id)) return;
        const name = this.#serverCalls.get(item.call_id)!;
        this.#serverCalls.delete(item.call_id);
        this.#emit({ type: 'extension', name: SERVER_TOOL_RESULT, data: { callId: item.call_id, name } });
        return;
      }
      case 'response.function_call_arguments.delta':
        if (this.#serverCalls.has(message['call_id'])) return;
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
        const name = (message['name'] as string | undefined) ?? this.#callNames.get(callId) ?? this.#serverCalls.get(callId) ?? '';
        let args: unknown = message['arguments'];
        try {
          args = JSON.parse(String(message['arguments'] ?? '{}'));
        } catch {
          // Leave malformed arguments as the raw string; tool validation reports it.
        }
        // Never a tool.call: answering it (function_call_output, response.create) would make the provider reply without the result.
        if (this.#serverCalls.has(callId) || (!this.#callNames.has(callId) && this.#reserved.has(name))) {
          this.#serverCalls.set(callId, name);
          this.#emit({ type: 'extension', name: SERVER_TOOL_CALL, data: { responseId: message['response_id'], callId, name, arguments: args } });
          return;
        }
        this.#callNames.delete(callId);
        this.#emit({ type: 'tool.call', responseId: message['response_id'], callId, name, arguments: args });
        return;
      }
      case 'response.done': {
        const response = message['response'];
        const usage = usageOf(response?.usage);
        const rawStopReason = response?.status_details?.reason;
        this.#emit({ type: 'response.end', responseId: response?.id, status: responseStatus(response), stopReason: stopReasonOf(response, this.#reserved), ...(typeof rawStopReason === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawStopReason) ? { rawStopReason } : {}), ...(usage ? { usage } : {}) });
        return;
      }
      case 'error': {
        const detail = message['error'] ?? {};
        const error = this.#error(this.#errorTypes[detail.type] ?? 'provider', detail.message ?? 'Provider error', detail.code ?? detail.type, detail);
        this.#lastError = error;
        this.#emit({ type: 'error', error, recoverable: true });
        return;
      }
      default:
        if (this.#options.errors?.sessionLimitEvents?.includes(type)) this.#sessionLimit = type;
        if (this.#options.extensions?.includes(type)) this.#emit({ type: 'extension', name: type, data: message });
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
      const builtins = options.builtinTools ?? [];
      // Built-ins are offered even when the app declares no tools of its own.
      const merged: SessionConfig = { ...options.defaults, ...config, ...(builtins.length > 0 && config.tools === undefined ? { tools: [] } : {}) };
      const conflicts = conflictingTools(merged, builtins);
      if (conflicts.length > 0) {
        throw new RealtimeError('invalid_request', `${options.provider}: tool name ${conflicts.join(', ')} is reserved for a built-in tool; rename that function tool`, { provider: options.provider });
      }
      const socket = await (options.socket ?? defaultSocketFactory)(options.url, options.headers);
      if (signal?.aborted) {
        socket.close(1000, 'aborted');
        signal.throwIfAborted();
      }
      if (socket.readyState > OPEN) throw new RealtimeError('connection', `${options.provider}: connection closed before open`, { provider: options.provider });
      const session = new CompatibleSession(socket, merged, options);
      if (socket.readyState !== OPEN) await waitForOpen(socket, options, signal);
      socket.send(JSON.stringify({ type: 'session.update', session: sessionPayload(merged, { ...options, builtinTools: builtins }) }));
      return session;
    },
  };
}

function waitForOpen(socket: ProviderSocket, { provider, errors }: CompatibleOptions, signal: AbortSignal | undefined): Promise<void> {
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
    socket.addEventListener('error', () => fail(new RealtimeError('connection', `${provider}: connection failed`, { provider })));
    socket.addEventListener('close', ({ code }) => {
      // A provider may refuse the handshake with one of its close codes, e.g. an invalid key.
      fail(new RealtimeError(closeCode(errors, code) ?? 'connection', `${provider}: connection closed before open (${code ?? ''})`, {
        provider,
        providerCode: code === undefined ? undefined : String(code),
      }));
    });
  });
}

/**
 * A streamed PCM16 HTTP body as whole samples: network chunks can split a sample,
 * so an odd byte is carried to the next chunk.
 */
export async function* pcm16Chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  let carry: number | undefined;
  const reader = body.getReader();
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      let bytes = read.value;
      if (carry !== undefined) {
        const joined = new Uint8Array(bytes.byteLength + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = undefined;
      }
      if (bytes.byteLength % 2 === 1) {
        carry = bytes[bytes.byteLength - 1];
        bytes = bytes.subarray(0, bytes.byteLength - 1);
      }
      if (bytes.byteLength > 0) yield bytes;
    }
  } finally {
    reader.releaseLock();
  }
}
