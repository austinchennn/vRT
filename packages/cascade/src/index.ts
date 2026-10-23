import {
  BoundedMap,
  Emitter,
  Pcm16Resampler,
  RealtimeError,
  pcm16DurationMs,
  type AudioChunk,
  type AudioFormat,
  type Capabilities,
  type EventOf,
  type EventType,
  type Pcm16Rate,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSession,
  type RespondOptions,
  type SessionConfig,
  type StopReason,
  type ToolSpec,
  type Usage,
  type Vad,
  type VadFactory,
} from '@vrealtime/core';
import { MAX_MESSAGES, MAX_TOKENS, trimHistory, type HistoryLimits } from './history.js';
import { SentenceBuffer } from './sentences.js';
import { StreamingTranscription, type Pcm16Format, type SttModel, type SttOptions, type StreamingLimits, type StreamingSttModel } from './stt.js';

export { estimateTokens, trimHistory, type HistoryLimits } from './history.js';
export { SentenceBuffer } from './sentences.js';
export type { Pcm16Format, SttModel, SttOptions, SttResult, SttStream, StreamingLimits, StreamingSttModel, TranscriptionUpdate } from './stt.js';

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: { callId: string; name: string; arguments: unknown }[] }
  | { role: 'tool'; callId: string; name: string; output: unknown };

export interface TextRequest {
  instructions?: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  toolChoice?: RespondOptions['toolChoice'];
  temperature?: number;
}

export type TextPart =
  | { type: 'text'; delta: string }
  | { type: 'tool-call-delta'; callId: string; name: string; argumentsDelta: string }
  | { type: 'tool-call'; callId: string; name: string; arguments: unknown }
  | { type: 'finish'; usage?: Usage; stopReason?: StopReason; rawStopReason?: string };

/** Any streaming text LLM (see `@vrealtime/ai-sdk` for every AI SDK provider). */
export interface TextModel {
  readonly id?: string;
  stream(request: TextRequest, options: { signal: AbortSignal }): AsyncIterable<TextPart>;
}

/** Text to speech; yields audio in `format` as it is synthesized. */
export interface TtsModel {
  readonly format: AudioFormat;
  synthesize(text: string, options: { voice?: string; signal: AbortSignal }): AsyncIterable<Uint8Array>;
}

export interface CascadeOptions {
  /**
   * Needed for audio input. A batch `SttModel` transcribes each utterance once it ends;
   * a `StreamingSttModel` (`mode: 'stream'`) also reports revised guesses while it is
   * spoken. Either way only the final transcript joins the conversation and can start a reply.
   */
  stt?: SttModel | StreamingSttModel;
  llm: TextModel;
  /** Without it the agent answers in text only. */
  tts?: TtsModel;
  /** Turn detection; with it the cascade behaves like a model with server VAD. */
  vad?: VadFactory;
  /** Audio kept from before speech is detected, so the first syllable is not lost. Default 300 ms. */
  prerollMs?: number;
  /** Longest utterance kept; audio past it is dropped until the utterance ends. Default 120 s. */
  maxUtteranceMs?: number;
  /** Bounds for a streaming stt. */
  streaming?: StreamingLimits;
  /** How much of the conversation is sent to the llm and kept in memory; instructions are always sent. */
  history?: HistoryLimits;
}

interface Segment {
  text: string;
  startMs: number;
  endMs: number;
}

interface ActiveResponse {
  id: string;
  itemId: string;
  controller: AbortController;
  assistant: Extract<ChatMessage, { role: 'assistant' }>;
  segments: Segment[];
  audioMs: number;
}

const KEPT_ITEMS = 16;
const MAX_UTTERANCE_MS = 120_000;

const isStreaming = (stt: SttModel | StreamingSttModel): stt is StreamingSttModel => (stt as StreamingSttModel).mode === 'stream';

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function chunkMs(data: Uint8Array, format: AudioFormat): number {
  if (format.encoding === 'pcm16') return pcm16DurationMs(data.byteLength, format.sampleRate);
  if (format.encoding === 'pcmu') return data.byteLength / 8;
  return 0;
}

export function cascadeCapabilities(options: CascadeOptions): Capabilities {
  const pcm = (sampleRate: Pcm16Rate): AudioFormat => ({ encoding: 'pcm16', sampleRate, channels: 1 });
  return {
    input: { audio: !!options.stt, text: true, formats: options.stt ? [pcm(options.stt.sampleRate ?? 16000), pcm(8000), pcm(16000), pcm(24000), pcm(48000)] : [] },
    output: { audio: !!options.tts, text: true, formats: options.tts ? [options.tts.format] : [] },
    turnDetection: { server: !!options.vad && !!options.stt, semantic: false, manual: !!options.stt },
    inputTranscription: !!options.stt,
    tools: { calls: true, argumentStreaming: true, autoReplyAfterResult: false },
    truncate: !!options.tts,
    midSessionUpdate: { instructions: true, tools: true },
  };
}

export class CascadeSession implements RealtimeSession {
  readonly capabilities: Capabilities;
  readonly #options: CascadeOptions;
  #config: SessionConfig;
  readonly #emitter = new Emitter<RealtimeEvent>();
  /** The conversation as the LLM sees it. */
  readonly history: ChatMessage[] = [];
  readonly #vad: Vad | undefined;
  readonly #inputFormat: Pcm16Format;
  #resampler: Pcm16Resampler | undefined;
  #utterance: Uint8Array[] = [];
  #utteranceMs = 0;
  /** Inside an utterance: since speech started, or since the first audio without a vad. */
  #inUtterance = false;
  /** The utterance ran past `maxUtteranceMs`; the rest of it is dropped. */
  #overflow = false;
  readonly #streaming: StreamingTranscription | undefined;
  #preroll: Uint8Array[] = [];
  #prerollMs = 0;
  #inputMs = 0;
  #pending: Promise<void> = Promise.resolve();
  #response: ActiveResponse | undefined;
  readonly #items = new BoundedMap<string, ActiveResponse>(KEPT_ITEMS);
  #responseCount = 0;
  #userCount = 0;
  /** Bumped when the user starts speaking: replies requested before that are dropped. */
  #speechEpoch = 0;
  #closed = false;
  readonly #lifetime = new AbortController();

  constructor(options: CascadeOptions, config: SessionConfig) {
    this.#options = options;
    this.#config = config;
    this.capabilities = cascadeCapabilities(options);
    this.#inputFormat = { encoding: 'pcm16', sampleRate: options.stt?.sampleRate ?? 16000, channels: 1 };
    this.#vad = options.vad && options.stt && config.turnDetection !== null ? options.vad() : undefined;
    if (options.stt && isStreaming(options.stt)) {
      this.#streaming = new StreamingTranscription(
        options.stt,
        this.#inputFormat,
        options.streaming ?? {},
        (update) => this.#emit({ type: 'input.transcript', itemId: update.itemId, text: update.text, final: update.final, revision: update.revision }),
        (error) => this.#emit({ type: 'error', error, recoverable: true }),
      );
    }
  }

  on<T extends EventType>(type: T, listener: (event: EventOf<T>) => void): () => void {
    return this.#emitter.on(type, listener as (event: Extract<RealtimeEvent, { type: T }>) => void);
  }

  /** @internal */
  announceReady(): void {
    this.#emit({ type: 'session.ready', sessionId: crypto.randomUUID() });
  }

  async update(config: Partial<SessionConfig>): Promise<void> {
    this.#config = { ...this.#config, ...config };
  }

  sendAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    if (!this.#options.stt) {
      this.#emit({ type: 'error', error: new RealtimeError('unsupported', 'cascade: audio input needs an stt model', { provider: 'cascade' }), recoverable: true });
      return;
    }
    if (chunk.format.encoding !== 'pcm16') {
      this.#emit({ type: 'error', error: new RealtimeError('unsupported', `cascade: ${chunk.format.encoding} input is not supported, send PCM16`, { provider: 'cascade' }), recoverable: true });
      return;
    }
    let data = chunk.data;
    if (chunk.format.sampleRate !== this.#inputFormat.sampleRate) {
      if (this.#resampler?.from !== chunk.format.sampleRate) this.#resampler = new Pcm16Resampler(chunk.format.sampleRate, this.#inputFormat.sampleRate);
      data = this.#resampler.process(data);
    }
    const ms = pcm16DurationMs(data.byteLength, this.#inputFormat.sampleRate);
    this.#inputMs += ms;
    const vad = this.#vad;
    if (!vad) {
      if (!this.#inUtterance) this.#begin([]);
      this.#capture(data, ms);
      return;
    }
    const event = vad.process({ data, format: this.#inputFormat, durationMs: ms });
    if (event === 'start') {
      this.#begin(this.#preroll);
      this.#preroll = [];
      this.#prerollMs = 0;
    }
    if (vad.speaking || event === 'end') {
      this.#capture(data, ms);
    } else {
      this.#preroll.push(data);
      this.#prerollMs += ms;
      const limit = this.#options.prerollMs ?? 300;
      while (this.#prerollMs > limit && this.#preroll.length > 1) {
        this.#prerollMs -= pcm16DurationMs(this.#preroll.shift()!.byteLength, this.#inputFormat.sampleRate);
      }
    }
    if (event === 'start') {
      this.#emit({ type: 'input.speech.start', atMs: Math.round(this.#inputMs) });
      // Like a provider's server VAD: speaking over the agent stops it, and a reply that
      // was requested but has not started yet is dropped.
      this.#speechEpoch++;
      if (this.#response) this.#stop('interrupted');
    } else if (event === 'end') {
      this.#emit({ type: 'input.speech.end', atMs: Math.round(this.#inputMs) });
      this.#transcribe(true);
    }
  }

  commitAudio(): void {
    this.#transcribe(false);
  }

  clearAudio(): void {
    this.#streaming?.discard();
    this.#reset();
    this.#preroll = [];
    this.#prerollMs = 0;
  }

  sendText(text: string): void {
    this.#after(() => {
      this.#remember({ role: 'user', content: text });
    });
  }

  respond(options?: RespondOptions): void {
    const epoch = this.#speechEpoch;
    this.#after(() => {
      if (epoch === this.#speechEpoch) this.#start(options);
    });
  }

  cancel(): void {
    if (this.#response) this.#stop('cancelled');
  }

  /** Cuts the assistant message to the sentences (and share of a sentence) the user heard. */
  truncate(itemId: string, audioEndMs: number): void {
    const response = this.#items.get(itemId);
    if (!response) return;
    const heard: string[] = [];
    for (const segment of response.segments) {
      if (segment.endMs <= audioEndMs) {
        heard.push(segment.text);
        continue;
      }
      if (segment.startMs < audioEndMs) {
        const share = (audioEndMs - segment.startMs) / (segment.endMs - segment.startMs);
        heard.push(segment.text.slice(0, Math.round(segment.text.length * share)));
      }
      break;
    }
    response.assistant.content = heard.join(' ').trim();
  }

  submitToolResult(callId: string, output: unknown, options?: { respond?: boolean }): void {
    this.#after(() => {
      const name = this.#toolName(callId);
      this.#remember({ role: 'tool', callId, name, output });
    });
    if (options?.respond !== false) this.respond();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#response?.controller.abort();
    this.#response = undefined;
    this.#streaming?.close();
    this.#lifetime.abort();
  }

  #emit(event: RealtimeEvent): void {
    if (!this.#closed) this.#emitter.emit(event);
  }

  /** Keeps history updates in order behind pending transcriptions. */
  #after(run: () => void | Promise<void>): void {
    this.#pending = this.#pending.then(run).catch((error) => {
      this.#emit({ type: 'error', error: RealtimeError.from(error, 'provider', { provider: 'cascade' }), recoverable: true });
    });
  }

  #sttOptions(): Omit<SttOptions, 'signal'> {
    const transcription = typeof this.#config.inputTranscription === 'object' ? this.#config.inputTranscription : {};
    return {
      ...(transcription.language ? { language: transcription.language } : {}),
      ...(transcription.vocabulary?.length ? { vocabulary: transcription.vocabulary } : {}),
    };
  }

  /** Starts an utterance with the audio heard just before it. */
  #begin(preroll: readonly Uint8Array[]): void {
    this.#reset();
    this.#inUtterance = true;
    this.#streaming?.open(`cascade-user-${++this.#userCount}`, this.#sttOptions(), this.#lifetime.signal);
    for (const chunk of preroll) this.#capture(chunk, pcm16DurationMs(chunk.byteLength, this.#inputFormat.sampleRate));
  }

  #capture(data: Uint8Array, ms: number): void {
    if (this.#utteranceMs + ms > (this.#options.maxUtteranceMs ?? MAX_UTTERANCE_MS)) {
      if (!this.#overflow) this.#emit({ type: 'error', error: new RealtimeError('transcription', 'cascade: utterance too long, the rest of it is dropped', { provider: 'cascade' }), recoverable: true });
      this.#overflow = true;
      return;
    }
    this.#utteranceMs += ms;
    if (this.#streaming) this.#streaming.write(data);
    else this.#utterance.push(data);
  }

  #reset(): void {
    this.#utterance = [];
    this.#utteranceMs = 0;
    this.#inUtterance = false;
    this.#overflow = false;
  }

  #transcribe(autoRespond: boolean): void {
    const audio = concat(this.#utterance);
    this.#reset();
    if (this.#streaming) {
      // Its updates were reported as they came; the final one joins the conversation in order.
      const final = this.#streaming.end();
      if (final) this.#after(async () => this.#heard(await final, autoRespond));
      return;
    }
    const stt = this.#options.stt as SttModel | undefined;
    if (!stt || audio.byteLength === 0) return;
    const itemId = `cascade-user-${++this.#userCount}`;
    this.#after(async () => {
      const text = (await stt.transcribe(audio, this.#inputFormat, { signal: this.#lifetime.signal, ...this.#sttOptions() })).trim();
      if (this.#closed || !text) return;
      this.#emit({ type: 'input.transcript', itemId, text, final: true, revision: 1 });
      this.#heard(text, autoRespond);
    });
  }

  #heard(text: string | undefined, autoRespond: boolean): void {
    if (this.#closed || !text) return;
    this.#remember({ role: 'user', content: text });
    if (autoRespond && !this.#vad?.speaking) this.#start();
  }

  /** Adds to the history, dropping the oldest messages past `maxStoredMessages`. */
  #remember(message: ChatMessage): void {
    this.history.push(message);
    const limits = this.#options.history;
    const max = limits?.maxStoredMessages ?? 2 * (limits?.maxMessages ?? MAX_MESSAGES);
    if (this.history.length <= max) return;
    const kept = trimHistory(this.history, { maxMessages: max });
    this.history.splice(0, this.history.length - kept.length);
  }

  /** What the next request sends: the recent history within the budget. */
  #window(): ChatMessage[] {
    const limits = this.#options.history;
    if (limits?.process) return [...limits.process(this.history)];
    return trimHistory(this.history, { maxMessages: limits?.maxMessages ?? MAX_MESSAGES, maxTokens: limits?.maxTokens ?? MAX_TOKENS });
  }

  #toolName(callId: string): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i]!;
      if (message.role !== 'assistant') continue;
      const call = message.toolCalls?.find((c) => c.callId === callId);
      if (call) return call.name;
    }
    return '';
  }

  #start(options?: RespondOptions): void {
    if (this.#closed) return;
    if (this.#response) {
      this.#emit({ type: 'error', error: new RealtimeError('invalid_request', 'cascade: a response is already in progress', { provider: 'cascade' }), recoverable: true });
      return;
    }
    const id = `cascade-response-${++this.#responseCount}`;
    const response: ActiveResponse = {
      id,
      itemId: `${id}-item`,
      controller: new AbortController(),
      assistant: { role: 'assistant', content: '' },
      segments: [],
      audioMs: 0,
    };
    const messages = this.#window();
    this.#remember(response.assistant);
    this.#response = response;
    this.#items.set(response.itemId, response);
    this.#emit({ type: 'response.start', responseId: id });
    void this.#run(response, messages, options);
  }

  async #run(response: ActiveResponse, messages: ChatMessage[], options: RespondOptions | undefined): Promise<void> {
    const { signal } = response.controller;
    const tts = this.#config.modalities === 'text' ? undefined : this.#options.tts;
    const sentences = new SentenceBuffer();
    let speaking = Promise.resolve();
    const speak = (text: string) => {
      speaking = speaking.then(() => this.#speak(response, text, tts!));
    };
    let usage: Usage | undefined;
    let stopReason: StopReason | undefined;
    let rawStopReason: string | undefined;
    try {
      const request: TextRequest = {
        messages,
        tools: this.#config.tools ?? [],
        ...(this.#config.instructions !== undefined ? { instructions: options?.instructions ?? this.#config.instructions } : {}),
        ...(options?.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(this.#config.temperature !== undefined ? { temperature: this.#config.temperature } : {}),
      };
      for await (const part of this.#options.llm.stream(request, { signal })) {
        if (signal.aborted) return;
        switch (part.type) {
          case 'text':
            response.assistant.content += part.delta;
            if (tts) for (const sentence of sentences.push(part.delta)) speak(sentence);
            else this.#emit({ type: 'output.text', responseId: response.id, delta: part.delta });
            break;
          case 'tool-call-delta':
            this.#emit({ type: 'tool.call.delta', responseId: response.id, callId: part.callId, name: part.name, argumentsDelta: part.argumentsDelta });
            break;
          case 'tool-call':
            (response.assistant.toolCalls ??= []).push({ callId: part.callId, name: part.name, arguments: part.arguments });
            this.#emit({ type: 'tool.call', responseId: response.id, callId: part.callId, name: part.name, arguments: part.arguments });
            break;
          case 'finish':
            usage = part.usage;
            stopReason = part.stopReason;
            rawStopReason = part.rawStopReason;
            break;
        }
      }
      if (tts) {
        const rest = sentences.flush();
        if (rest) speak(rest);
        await speaking;
      }
    } catch (error) {
      if (signal.aborted) return;
      this.#response = undefined;
      // An stt, llm or tts model that already speaks RealtimeError keeps its code.
      this.#emit({ type: 'error', error: RealtimeError.from(error, 'provider', { provider: 'cascade' }), recoverable: true });
      this.#emit({ type: 'response.end', responseId: response.id, status: 'failed', stopReason: 'failed' });
      return;
    }
    if (signal.aborted || this.#response !== response) return;
    this.#response = undefined;
    this.#emit({ type: 'response.end', responseId: response.id, status: 'done', stopReason: stopReason ?? (response.assistant.toolCalls?.length ? 'tool_calls' : 'completed'), ...(rawStopReason !== undefined ? { rawStopReason } : {}), ...(usage ? { usage } : {}) });
  }

  async #speak(response: ActiveResponse, text: string, tts: TtsModel): Promise<void> {
    const { signal } = response.controller;
    if (signal.aborted) return;
    const startMs = response.audioMs;
    let announced = false;
    for await (const data of tts.synthesize(text, { signal, ...(this.#config.voice !== undefined ? { voice: this.#config.voice } : {}) })) {
      if (signal.aborted) return;
      if (!announced) {
        // The transcript follows the audio: a sentence appears when it starts playing.
        announced = true;
        this.#emit({ type: 'output.transcript', responseId: response.id, itemId: response.itemId, delta: (startMs > 0 ? ' ' : '') + text });
      }
      const durationMs = chunkMs(data, tts.format);
      response.audioMs += durationMs;
      this.#emit({ type: 'output.audio', responseId: response.id, itemId: response.itemId, chunk: { data, format: tts.format, durationMs } });
    }
    response.segments.push({ text, startMs, endMs: response.audioMs });
  }

  #stop(status: 'cancelled' | 'interrupted'): void {
    const response = this.#response;
    if (!response) return;
    this.#response = undefined;
    response.controller.abort();
    // Until the edge reports what was played, keep what was synthesized, not what was generated.
    if (this.#options.tts && this.#config.modalities !== 'text') response.assistant.content = response.segments.map((s) => s.text).join(' ');
    this.#emit({ type: 'response.end', responseId: response.id, status, stopReason: 'cancelled' });
  }
}

/** STT + any text LLM + TTS as one `RealtimeModel`; agents and edges do not change. */
export function cascade(options: CascadeOptions): RealtimeModel {
  return {
    provider: 'cascade',
    id: options.llm.id ?? 'cascade',
    capabilities: cascadeCapabilities(options),
    async connect(config, connectOptions) {
      connectOptions?.signal?.throwIfAborted();
      const session = new CascadeSession(options, config);
      // Announce after connect() returns, once the caller has subscribed.
      setTimeout(() => session.announceReady(), 0);
      return session;
    },
  };
}
