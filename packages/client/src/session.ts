import {
  Inbox,
  Outbox,
  decodeAudioFrame,
  decodeServerMessage,
  encodeAudioFrame,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
  type TurnStateWire,
  type Unsequenced,
  type WireAudioFormat,
} from '@vrealtime/protocol';
import { createMicrophone, createSpeaker, type AudioSink, type AudioSource } from './audio.js';
import { Emitter } from './emitter.js';

export type FailureCode = 'INTERRUPTED' | 'REJECTED' | 'INVALID' | 'TIMEOUT' | 'FAILED';
export type ToolOutcome = { ok: true; output: unknown } | { ok: false; code: FailureCode; message: string };

export interface ClientToolContext {
  /** Aborted when the call's turn is interrupted. */
  signal: AbortSignal;
  callId: string;
  epoch: number;
}

/** A tool that runs in the app. Calls run one at a time, in arrival order. */
export interface ClientTool {
  description?: string;
  /** JSON Schema for the arguments, as the model sees it. */
  parameters: { readonly [key: string]: unknown };
  run(args: any, context: ClientToolContext): unknown;
}

/** The browser `WebSocket` surface the client uses. */
export interface ClientSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export interface ReconnectOptions {
  /** Default 8. */
  maxAttempts?: number;
  /** First retry delay, doubled per attempt. Default 250 ms. */
  baseDelayMs?: number;
  /** Default 5 s. */
  maxDelayMs?: number;
}

export interface ConnectOptions {
  tools?: Record<string, ClientTool>;
  /** `false` (default) is text-only. */
  audio?: false | { input?: 'mic' | AudioSourceFactory | false; output?: 'speaker' | AudioSink | false };
  /** App context sent with `hello` (and later with `setContext`). */
  context?: unknown;
  reconnect?: ReconnectOptions | false;
  /** Ping interval; the socket is considered dead after 2.5 intervals of silence. Default 15 s. */
  heartbeatMs?: number;
  /** Defaults to the global `WebSocket`. */
  WebSocket?: new (url: string) => ClientSocket;
}

/** Starts capture and calls `onFrame` with PCM16 frames in the negotiated format. */
export type AudioSourceFactory = (format: WireAudioFormat, onFrame: (pcm16: Uint8Array) => void) => Promise<AudioSource>;

export type ClientEvent =
  | { type: 'ready'; sessionId: string; resumed: boolean }
  | { type: 'state'; state: TurnStateWire; turnId: string; epoch: number }
  | { type: 'transcript'; role: 'user' | 'agent'; itemId: string; text: string; final: boolean }
  | { type: 'text'; responseId: string; delta: string }
  | { type: 'tool.call'; callId: string; name: string; arguments: unknown; epoch: number }
  | { type: 'tool.preview'; callId: string; name: string; epoch: number; preview: unknown }
  | { type: 'tool.result'; callId: string; name: string; epoch: number; result: ToolOutcome }
  | { type: 'interrupted'; epoch: number }
  | { type: 'error'; code: string; message: string; recoverable: boolean }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'closed'; code?: number; reason?: string };

export type ClientEventType = ClientEvent['type'];

const OPEN = 1;
const PCM24: WireAudioFormat = { encoding: 'pcm16', sampleRate: 24000 };
const ACK_EVERY = 32;
const ACK_DELAY_MS = 250;

interface PendingCall {
  callId: string;
  name: string;
  args: unknown;
  epoch: number;
}

export class ClientSession {
  readonly #url: string;
  readonly #options: ConnectOptions;
  readonly #emitter = new Emitter<ClientEvent>();
  readonly #outbox = new Outbox<ClientMessage>();
  readonly #inbox = new Inbox();
  #socket: ClientSocket | undefined;
  #sessionId: string | undefined;
  #state: TurnStateWire = 'idle';
  #epoch = 0;
  #closedEpoch = -1;
  #audioItem: { id: string; epoch: number } | undefined;
  #audioSeq = 0;
  #queue: PendingCall[] = [];
  #current: { call: PendingCall; controller: AbortController } | undefined;
  #pumping = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastMessageAt = 0;
  #unacked = 0;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;
  #giveUp = false;
  #everReady = false;
  #speaker: AudioSink | undefined;
  #mic: AudioSource | undefined;
  #input: WireAudioFormat = PCM24;
  #output: WireAudioFormat = PCM24;
  #ready: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(url: string, options: ConnectOptions = {}) {
    this.#url = url;
    this.#options = options;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get state(): TurnStateWire {
    return this.#state;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get connected(): boolean {
    return this.#socket?.readyState === OPEN && this.#everReady;
  }

  on<T extends ClientEventType>(type: T, listener: (event: Extract<ClientEvent, { type: T }>) => void): () => void {
    return this.#emitter.on(type, listener);
  }

  /** @internal Opens the first connection; resolves on `ready`. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#ready = { resolve, reject };
      this.#open();
    });
  }

  sendText(text: string): void {
    void this.#flushPlayback();
    this.#send({ type: 'text', text });
  }

  setContext(context: unknown): void {
    this.#send({ type: 'context', context });
  }

  /**
   * Stops the agent now: playback is flushed, the current epoch is closed
   * locally (queued and later calls from it return INTERRUPTED without running;
   * a running call is aborted) and the server is told.
   */
  interrupt(reason: 'user' | 'keyboard' | 'speech' = 'user'): void {
    const epoch = this.#epoch;
    this.#closeEpoch(epoch);
    this.#send({ type: 'interrupt', epoch, reason });
  }

  /** Sends one PCM16 frame in the negotiated input format (for custom capture). */
  sendAudio(pcm16: Uint8Array): void {
    const socket = this.#socket;
    if (socket?.readyState === OPEN && this.#everReady) socket.send(encodeAudioFrame(1, this.#audioSeq++, pcm16));
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    const socket = this.#socket;
    if (socket) socket.close(1000, 'client closed');
    else this.#finish(1000, 'client closed');
    await this.#stopAudio();
  }

  // ── Connection ──────────────────────────────────────────────────────────

  #open(): void {
    const Socket = this.#options.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => ClientSocket);
    const socket = new Socket(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    socket.addEventListener('open', () => this.#hello());
    socket.addEventListener('message', (event) => {
      if (this.#socket === socket) this.#receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.#socket === socket) this.#onClose(event?.code, event?.reason);
    });
  }

  #hello(): void {
    const tools = Object.entries(this.#options.tools ?? {}).map(([name, tool]) => ({ name, description: tool.description ?? '', parameters: tool.parameters }));
    const audio = this.#options.audio;
    const hello: Unsequenced<ClientMessage> = {
      type: 'hello',
      tools,
      ...(audio && audio.input ? { input: PCM24 } : {}),
      ...(audio && audio.output ? { output: PCM24 } : {}),
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId, resumeFrom: this.#inbox.lastSeq } : {}),
      ...(this.#options.context !== undefined && !this.#everReady ? { context: this.#options.context } : {}),
    };
    this.#write(this.#outbox.stamp(hello));
    this.#lastMessageAt = Date.now();
    this.#startHeartbeat();
  }

  #onClose(code?: number, reason?: string): void {
    this.#socket = undefined;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    const reconnect = this.#options.reconnect === false ? undefined : this.#options.reconnect ?? {};
    const maxAttempts = reconnect?.maxAttempts ?? 8;
    if (this.#closing || this.#giveUp || !this.#everReady || !reconnect || this.#attempt >= maxAttempts) {
      this.#finish(code, reason);
      return;
    }
    this.#attempt++;
    const delayMs = Math.min(reconnect.maxDelayMs ?? 5000, (reconnect.baseDelayMs ?? 250) * 2 ** (this.#attempt - 1));
    this.#emitter.emit({ type: 'reconnecting', attempt: this.#attempt, delayMs });
    this.#reconnectTimer = setTimeout(() => this.#open(), delayMs);
  }

  #finish(code?: number, reason?: string): void {
    this.#socket = undefined;
    clearInterval(this.#heartbeat);
    this.#closeEpoch(Number.MAX_SAFE_INTEGER);
    this.#ready?.reject(new Error(`Connection closed before ready${code !== undefined ? ` (${code})` : ''}`));
    this.#ready = undefined;
    void this.#stopAudio();
    this.#emitter.emit({ type: 'closed', ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) });
  }

  #startHeartbeat(): void {
    clearInterval(this.#heartbeat);
    const interval = this.#options.heartbeatMs ?? 15_000;
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastMessageAt > interval * 2.5) {
        this.#socket?.close(4000, 'heartbeat timeout');
        return;
      }
      this.#send({ type: 'ping' });
    }, interval);
  }

  #send(message: Unsequenced<ClientMessage>): void {
    const stamped = this.#outbox.stamp(message);
    if (this.#everReady || message.type === 'ping') this.#write(stamped);
  }

  #write(message: ClientMessage): void {
    const socket = this.#socket;
    if (socket?.readyState === OPEN) socket.send(encodeMessage(message));
  }

  // ── Incoming ────────────────────────────────────────────────────────────

  #receive(data: unknown): void {
    this.#lastMessageAt = Date.now();
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : undefined;
      const frame = bytes && decodeAudioFrame(bytes);
      if (frame?.kind === 2 && this.#audioItem && this.#audioItem.epoch > this.#closedEpoch) this.#speaker?.enqueue(this.#audioItem.id, frame.payload);
      return;
    }
    const decoded = decodeServerMessage(data);
    if (!decoded.ok) {
      this.#emitter.emit({ type: 'error', code: decoded.error.code, message: decoded.error.message, recoverable: true });
      return;
    }
    const message = decoded.message;
    if (!this.#inbox.accept(message)) return;
    if (message.seq > 0) this.#scheduleAck();
    this.#handle(message);
  }

  #handle(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
        void this.#onReady(message);
        return;
      case 'turn.state':
        this.#seeEpoch(message.epoch);
        this.#state = message.state;
        // Barge-in: the user started talking, stop speaking right away.
        if (message.state === 'listening') void this.#flushPlayback();
        this.#emitter.emit({ type: 'state', state: message.state, turnId: message.turnId, epoch: message.epoch });
        return;
      case 'transcript':
        this.#emitter.emit({ type: 'transcript', role: message.role, itemId: message.itemId, text: message.text, final: message.final });
        return;
      case 'text':
        this.#emitter.emit({ type: 'text', responseId: message.responseId, delta: message.delta });
        return;
      case 'audio.start':
        this.#seeEpoch(message.epoch);
        this.#audioItem = { id: message.itemId, epoch: message.epoch };
        return;
      case 'tool.call.delta':
        this.#emitter.emit({ type: 'tool.preview', callId: message.callId, name: message.name, epoch: message.epoch, preview: message.preview });
        return;
      case 'tool.call':
        this.#onToolCall({ callId: message.callId, name: message.name, args: message.arguments, epoch: message.epoch });
        return;
      case 'interrupted':
        this.#closeEpoch(message.epoch);
        this.#emitter.emit({ type: 'interrupted', epoch: message.epoch });
        return;
      case 'ack':
        this.#outbox.ack(message.upTo);
        return;
      case 'error':
        if (message.code === 'RESUME_FAILED') this.#giveUp = true;
        if (!message.recoverable && this.#ready) {
          this.#ready.reject(new Error(`${message.code}: ${message.message}`));
          this.#ready = undefined;
        }
        this.#emitter.emit({ type: 'error', code: message.code, message: message.message, recoverable: message.recoverable });
        return;
      case 'pong':
        return;
    }
  }

  async #onReady(message: Extract<ServerMessage, { type: 'ready' }>): Promise<void> {
    const resumed = message.resumedFrom !== undefined && this.#everReady;
    this.#sessionId = message.sessionId;
    this.#input = message.input;
    this.#output = message.output;
    this.#attempt = 0;
    if (resumed) {
      const missed = this.#outbox.resendFrom(message.resumedFrom!);
      if (missed === undefined) {
        this.#giveUp = true;
        this.#emitter.emit({ type: 'error', code: 'RESUME_FAILED', message: 'Messages sent while offline were lost', recoverable: false });
        this.#socket?.close(1000, 'resume failed');
        return;
      }
      for (const pending of missed) this.#write(pending);
    }
    const first = !this.#everReady;
    this.#everReady = true;
    if (first) await this.#startAudio();
    this.#emitter.emit({ type: 'ready', sessionId: message.sessionId, resumed });
    this.#ready?.resolve();
    this.#ready = undefined;
  }

  #scheduleAck(): void {
    if (++this.#unacked >= ACK_EVERY) {
      this.#ack();
      return;
    }
    this.#ackTimer ??= setTimeout(() => this.#ack(), ACK_DELAY_MS);
  }

  #ack(): void {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    this.#unacked = 0;
    this.#write(this.#outbox.stamp({ type: 'ack', upTo: this.#inbox.lastSeq }));
  }

  // ── Tool host with the epoch gate ───────────────────────────────────────

  #seeEpoch(epoch: number): void {
    if (epoch > this.#epoch) this.#epoch = epoch;
  }

  #onToolCall(call: PendingCall): void {
    this.#seeEpoch(call.epoch);
    this.#emitter.emit({ type: 'tool.call', callId: call.callId, name: call.name, arguments: call.args, epoch: call.epoch });
    if (call.epoch <= this.#closedEpoch) {
      this.#result(call, { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' });
      return;
    }
    this.#queue.push(call);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let call = this.#queue.shift(); call !== undefined; call = this.#queue.shift()) await this.#run(call);
    } finally {
      this.#pumping = false;
    }
  }

  async #run(call: PendingCall): Promise<void> {
    if (call.epoch <= this.#closedEpoch) {
      this.#result(call, { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' });
      return;
    }
    const tool = this.#options.tools?.[call.name];
    if (!tool) {
      this.#result(call, { ok: false, code: 'FAILED', message: `Unknown client tool: ${call.name}` });
      return;
    }
    const controller = new AbortController();
    this.#current = { call, controller };
    const aborted = new Promise<ToolOutcome>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve({ ok: false, code: 'INTERRUPTED', message: 'Interrupted while running' }), { once: true }));
    const ran = Promise.resolve()
      .then(() => tool.run(call.args, { signal: controller.signal, callId: call.callId, epoch: call.epoch }))
      .then((output): ToolOutcome => ({ ok: true, output }), (error): ToolOutcome => ({ ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }));
    const result = await Promise.race([ran, aborted]);
    this.#current = undefined;
    this.#result(call, result);
  }

  #result(call: PendingCall, result: ToolOutcome): void {
    this.#send(result.ok
      ? { type: 'tool.result', callId: call.callId, epoch: call.epoch, ok: true, output: result.output }
      : { type: 'tool.result', callId: call.callId, epoch: call.epoch, ok: false, code: result.code, message: result.message });
    this.#emitter.emit({ type: 'tool.result', callId: call.callId, name: call.name, epoch: call.epoch, result });
  }

  #closeEpoch(epoch: number): void {
    if (epoch > this.#closedEpoch) this.#closedEpoch = epoch;
    if (this.#current && this.#current.call.epoch <= this.#closedEpoch) this.#current.controller.abort();
    const stale = this.#queue.filter((call) => call.epoch <= this.#closedEpoch);
    this.#queue = this.#queue.filter((call) => call.epoch > this.#closedEpoch);
    for (const call of stale) this.#result(call, { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' });
    if (this.#audioItem && this.#audioItem.epoch <= this.#closedEpoch) this.#audioItem = undefined;
    void this.#flushPlayback();
  }

  // ── Audio ───────────────────────────────────────────────────────────────

  async #flushPlayback(): Promise<void> {
    if (!this.#speaker) return;
    const played = await this.#speaker.flush();
    for (const [itemId, playedMs] of Object.entries(played)) {
      if (playedMs > 0) this.#send({ type: 'playback', itemId, playedMs: Math.round(playedMs) });
    }
  }

  async #startAudio(): Promise<void> {
    const audio = this.#options.audio;
    if (!audio) return;
    try {
      if (audio.output === 'speaker') this.#speaker = await createSpeaker(this.#output.sampleRate ?? 24000);
      else if (audio.output) this.#speaker = audio.output;
      if (audio.input) {
        const onFrame = (pcm16: Uint8Array) => this.sendAudio(pcm16);
        this.#mic = audio.input === 'mic'
          ? await createMicrophone(this.#input.sampleRate ?? 24000, onFrame)
          : await audio.input(this.#input, onFrame);
      }
    } catch (error) {
      this.#emitter.emit({ type: 'error', code: 'AUDIO_FAILED', message: error instanceof Error ? error.message : String(error), recoverable: true });
    }
  }

  async #stopAudio(): Promise<void> {
    const mic = this.#mic;
    const speaker = this.#speaker;
    this.#mic = undefined;
    this.#speaker = undefined;
    await Promise.allSettled([mic?.stop(), speaker?.close()]);
  }
}

/**
 * Connects an app to a vRealTime server. Resolves once the session is ready.
 * With `audio`, call it from a user gesture so the browser allows playback.
 */
export async function connect(url: string, options: ConnectOptions = {}): Promise<ClientSession> {
  const session = new ClientSession(url, options);
  await session.start();
  return session;
}
