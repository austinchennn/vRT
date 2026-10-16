import {
  Emitter,
  Pcm16Resampler,
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
  type ToolSpec,
  type Usage,
  type Vad,
  type VadFactory,
} from '@vrealtime/core';
import { SentenceBuffer } from './sentences.js';

export { SentenceBuffer } from './sentences.js';

type Pcm16Format = Extract<AudioFormat, { encoding: 'pcm16' }>;

/** Speech to text for one utterance. */
export interface SttModel {
  /** Preferred input rate; audio is resampled to it. Default 16 kHz. */
  readonly sampleRate?: Pcm16Rate;
  transcribe(audio: Uint8Array, format: Pcm16Format, options: { signal: AbortSignal; language?: string; vocabulary?: readonly string[] }): Promise<string>;
}

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
  | { type: 'finish'; usage?: Usage };

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
  /** Needed for audio input. */
  stt?: SttModel;
  llm: TextModel;
  /** Without it the agent answers in text only. */
  tts?: TtsModel;
  /** Turn detection; with it the cascade behaves like a model with server VAD. */
  vad?: VadFactory;
  /** Audio kept from before speech is detected, so the first syllable is not lost. Default 300 ms. */
  prerollMs?: number;
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
  #preroll: Uint8Array[] = [];
  #prerollMs = 0;
  #inputMs = 0;
  #pending: Promise<void> = Promise.resolve();
  #response: ActiveResponse | undefined;
  readonly #items = new Map<string, ActiveResponse>();
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
      this.#emit({ type: 'error', error: new Error('cascade: audio input needs an stt model'), recoverable: true });
      return;
    }
    if (chunk.format.encoding !== 'pcm16') {
      this.#emit({ type: 'error', error: new Error(`cascade: ${chunk.format.encoding} input is not supported, send PCM16`), recoverable: true });
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
      this.#utterance.push(data);
      return;
    }
    const event = vad.process({ data, format: this.#inputFormat, durationMs: ms });
    if (event === 'start') {
      this.#utterance = this.#preroll;
      this.#preroll = [];
      this.#prerollMs = 0;
    }
    if (vad.speaking || event === 'end') {
      this.#utterance.push(data);
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
    this.#utterance = [];
    this.#preroll = [];
    this.#prerollMs = 0;
  }

  sendText(text: string): void {
    this.#after(() => {
      this.history.push({ role: 'user', content: text });
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
      this.history.push({ role: 'tool', callId, name, output });
    });
    if (options?.respond !== false) this.respond();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#response?.controller.abort();
    this.#response = undefined;
    this.#lifetime.abort();
  }

  #emit(event: RealtimeEvent): void {
    if (!this.#closed) this.#emitter.emit(event);
  }

  /** Keeps history updates in order behind pending transcriptions. */
  #after(run: () => void | Promise<void>): void {
    this.#pending = this.#pending.then(run).catch((error) => {
      this.#emit({ type: 'error', error: error instanceof Error ? error : new Error(String(error)), recoverable: true });
    });
  }

  #transcribe(autoRespond: boolean): void {
    const audio = concat(this.#utterance);
    this.#utterance = [];
    const stt = this.#options.stt;
    if (!stt || audio.byteLength === 0) return;
    const itemId = `cascade-user-${++this.#userCount}`;
    this.#after(async () => {
      const transcription = typeof this.#config.inputTranscription === 'object' ? this.#config.inputTranscription : {};
      const text = (await stt.transcribe(audio, this.#inputFormat, {
        signal: this.#lifetime.signal,
        ...(transcription.language ? { language: transcription.language } : {}),
        ...(transcription.vocabulary?.length ? { vocabulary: transcription.vocabulary } : {}),
      })).trim();
      if (this.#closed || !text) return;
      this.#emit({ type: 'input.transcript', itemId, text, final: true });
      this.history.push({ role: 'user', content: text });
      if (autoRespond && !this.#vad?.speaking) this.#start();
    });
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
      this.#emit({ type: 'error', error: new Error('cascade: a response is already in progress'), recoverable: true });
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
    const messages = this.history.slice();
    this.history.push(response.assistant);
    this.#response = response;
    this.#items.set(response.itemId, response);
    if (this.#items.size > KEPT_ITEMS) this.#items.delete(this.#items.keys().next().value!);
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
      this.#emit({ type: 'error', error: error instanceof Error ? error : new Error(String(error)), recoverable: true });
      this.#emit({ type: 'response.end', responseId: response.id, status: 'failed' });
      return;
    }
    if (signal.aborted || this.#response !== response) return;
    this.#response = undefined;
    this.#emit({ type: 'response.end', responseId: response.id, status: 'done', ...(usage ? { usage } : {}) });
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
    this.#emit({ type: 'response.end', responseId: response.id, status });
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
