import {
  startSession,
  type AgentDefinition,
  type AgentEvent,
  type AgentSession,
  type AudioFormat,
  type Clock,
  type ToolResult,
} from '@vrealtime/core';
import {
  Inbox,
  Outbox,
  decodeAudioFrame,
  decodeClientMessage,
  encodeAudioFrame,
  encodeMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type Unsequenced,
  type WireAudioFormat,
} from '@vrealtime/protocol';

/**
 * The only socket surface the server needs. Runtimes with event-style sockets
 * (browsers, Deno, Workers, `ws`) can pass the socket as-is; callback-style
 * runtimes (Bun) call `connection.receive()` and `connection.closed()` instead.
 */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet sent; enables backpressure when present. */
  readonly bufferedAmount?: number;
  addEventListener?(type: 'message' | 'close', listener: (event: { data?: unknown }) => void): void;
}

export interface AttachOptions {
  /** How long a session survives without a socket, waiting for a resume. Default 30 s. */
  resumeWindowMs?: number;
  /** Close a socket that sent nothing (not even `ping`) for this long. Default 45 s. */
  heartbeatTimeoutMs?: number;
  /** Queue outgoing frames while `bufferedAmount` exceeds this. Default 256 KiB. */
  highWaterMark?: number;
  /** Receives `context` messages and `hello.context` from the app. */
  onContext?: (context: unknown, session: AgentSession) => void;
  clock?: Clock;
}

export interface Connection {
  /** Feed one incoming WebSocket message (text or binary). */
  receive(data: unknown): void;
  /** Tell the server the socket closed. */
  closed(): void;
  readonly sessionId: string | undefined;
}

const PCM24: AudioFormat = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
const FLUSH_INTERVAL_MS = 10;
const OUTPUT = 2;
const INPUT = 1;

const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function toCoreFormat(format: WireAudioFormat | undefined): AudioFormat | undefined {
  if (format === undefined) return undefined;
  if (format.encoding === 'pcmu') return { encoding: 'pcmu' };
  if (format.encoding === 'opus') return { encoding: 'opus', frameMs: 20 };
  const rate = format.sampleRate;
  return rate === 8000 || rate === 16000 || rate === 24000 || rate === 48000 ? { encoding: 'pcm16', sampleRate: rate, channels: 1 } : undefined;
}

export function toWireFormat(format: AudioFormat): WireAudioFormat {
  return format.encoding === 'pcm16' ? { encoding: 'pcm16', sampleRate: format.sampleRate } : { encoding: format.encoding };
}

function sameFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && (a.encoding !== 'pcm16' || (b.encoding === 'pcm16' && a.sampleRate === b.sampleRate));
}

/** Use the app's format when the model takes it as-is (pass-through), otherwise 24 kHz PCM16. */
function negotiate(requested: WireAudioFormat | undefined, supported: readonly AudioFormat[]): AudioFormat {
  const format = toCoreFormat(requested);
  if (format && supported.some((s) => sameFormat(s, format))) return format;
  return supported.find((s) => sameFormat(s, PCM24)) ?? supported[0] ?? PCM24;
}

interface Outgoing {
  data: string | Uint8Array;
  /** Set for audio (and its `audio.start`), so an interruption can drop it before it is sent. */
  epoch?: number;
}

/** One agent session and everything that must survive a reconnect. */
class LiveSession {
  readonly id = crypto.randomUUID();
  readonly outbox = new Outbox<ServerMessage>();
  readonly inbox = new Inbox();
  session!: AgentSession;
  input: AudioFormat = PCM24;
  output: AudioFormat = PCM24;
  socket: SocketConnection | undefined;
  expiry: unknown;
  #audioSeq = 0;
  #audioItem: string | undefined;
  #queue: Outgoing[] = [];
  #flushTimer: unknown;

  constructor(private readonly hub: Hub) {}

  bind(agentSession: AgentSession): void {
    this.session = agentSession;
    agentSession.on('turn.state', (e) => this.send({ type: 'turn.state', turnId: e.turnId, epoch: e.epoch, state: e.state }));
    agentSession.on('transcript', (e) => this.send({ type: 'transcript', role: e.role, itemId: e.itemId, text: e.text, final: e.final }));
    agentSession.on('text', (e) => this.send({ type: 'text', responseId: e.responseId, delta: e.delta }));
    agentSession.on('audio', (e) => this.#audio(e));
    agentSession.on('tool.call', (e) => this.send({ type: 'tool.call', callId: e.callId, epoch: e.epoch, turnId: e.turnId, name: e.name, arguments: e.arguments }));
    agentSession.on('tool.call.delta', (e) => this.send({ type: 'tool.call.delta', callId: e.callId, epoch: e.epoch, name: e.name, preview: { argumentsDelta: e.argumentsDelta } }));
    agentSession.on('tool.preview', (e) => this.send({ type: 'tool.call.delta', callId: e.callId, epoch: e.epoch, name: e.name, preview: e.preview }));
    agentSession.on('interrupted', (e) => {
      this.#dropAudio(e.epoch);
      this.send({ type: 'interrupted', epoch: e.epoch });
    });
    agentSession.on('error', (e) => this.send({ type: 'error', code: 'AGENT_ERROR', message: e.error.message, recoverable: e.recoverable }));
    agentSession.on('closed', () => {
      this.hub.forget(this);
      this.socket?.close(1000, 'session closed');
    });
  }

  send(message: Unsequenced<ServerMessage>, epoch?: number): void {
    const stamped = this.outbox.stamp(message);
    this.#write(encodeMessage(stamped), epoch);
  }

  /** Re-sends everything after the client's last seen seq. False when that is no longer possible. */
  resend(lastSeen: number): boolean {
    const missed = this.outbox.resendFrom(lastSeen);
    if (missed === undefined) return false;
    for (const message of missed) this.#write(encodeMessage(message));
    return true;
  }

  detach(): void {
    this.socket = undefined;
    this.#queue = [];
    this.#audioItem = undefined;
  }

  flush(): void {
    this.#flushTimer = undefined;
    const socket = this.socket;
    if (!socket) {
      this.#queue = [];
      return;
    }
    while (this.#queue.length > 0 && !socket.congested()) socket.send(this.#queue.shift()!.data);
    if (this.#queue.length > 0) this.#scheduleFlush();
  }

  #audio(event: Extract<AgentEvent, { type: 'audio' }>): void {
    if (!this.socket) return;
    if (event.itemId !== this.#audioItem) {
      this.#audioItem = event.itemId;
      this.send({ type: 'audio.start', itemId: event.itemId, responseId: event.responseId, epoch: event.epoch }, event.epoch);
    }
    this.#write(encodeAudioFrame(OUTPUT, this.#audioSeq++, event.chunk.data), event.epoch);
  }

  /** Frames keep their order: once anything is queued, everything queues behind it. */
  #write(data: string | Uint8Array, epoch?: number): void {
    const socket = this.socket;
    if (!socket) return;
    if (this.#queue.length === 0 && !socket.congested()) {
      socket.send(data);
      return;
    }
    this.#queue.push(epoch === undefined ? { data } : { data, epoch });
    this.#scheduleFlush();
  }

  #dropAudio(closedEpoch: number): void {
    this.#queue = this.#queue.filter((item) => item.epoch === undefined || item.epoch > closedEpoch);
    this.#audioItem = undefined;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer === undefined) this.#flushTimer = this.hub.clock.setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }
}

class SocketConnection implements Connection {
  #live: LiveSession | undefined;
  #starting: Promise<void> | undefined;
  #pending: ClientMessage[] = [];
  #closed = false;
  #lastSeen: number;
  #heartbeat: unknown;
  #ackScheduled = false;

  constructor(private readonly hub: Hub, private readonly socket: WebSocketLike) {
    this.#lastSeen = hub.clock.now();
    this.#checkHeartbeat();
    socket.addEventListener?.('message', (event) => this.receive(event.data));
    socket.addEventListener?.('close', () => this.closed());
  }

  get sessionId(): string | undefined {
    return this.#live?.id;
  }

  congested(): boolean {
    return (this.socket.bufferedAmount ?? 0) > this.hub.highWaterMark;
  }

  send(data: string | Uint8Array): void {
    if (!this.#closed) this.socket.send(data);
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.socket.close(code, reason);
    this.closed();
  }

  receive(data: unknown): void {
    if (this.#closed) return;
    this.#lastSeen = this.hub.clock.now();
    if (typeof data !== 'string') {
      this.#receiveAudio(data);
      return;
    }
    const decoded = decodeClientMessage(data);
    if (!decoded.ok) {
      this.#error(decoded.error.code, decoded.error.message, true);
      return;
    }
    const message = decoded.message;
    if (message.type === 'ping') {
      this.#sendDirect({ type: 'pong' });
      return;
    }
    if (message.type === 'hello') {
      void this.#hello(message);
      return;
    }
    if (this.#starting || !this.#live) {
      if (this.#starting) this.#pending.push(message);
      else this.#error('NO_SESSION', 'Send hello first', false);
      return;
    }
    this.#handle(this.#live, message);
  }

  closed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.hub.clock.clearTimeout(this.#heartbeat);
    const live = this.#live;
    if (live?.socket === this) {
      live.detach();
      this.hub.park(live);
    }
  }

  #receiveAudio(data: unknown): void {
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
    const frame = bytes && decodeAudioFrame(bytes);
    if (!frame || frame.kind !== INPUT) {
      this.#error('MALFORMED', 'Invalid audio frame', true);
      return;
    }
    const live = this.#live;
    if (live && !this.#starting) live.session.sendAudio({ data: frame.payload, format: live.input });
  }

  async #hello(hello: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    if (this.#live || this.#starting) {
      this.#error('DUPLICATE_HELLO', 'hello was already received', true);
      return;
    }
    if (hello.sessionId !== undefined) {
      this.#resume(hello);
      return;
    }
    const live = new LiveSession(this.hub);
    const supported = this.hub.agent.model.capabilities;
    live.input = negotiate(hello.input, supported.input.formats);
    live.output = negotiate(hello.output, supported.output.formats);
    this.#starting = (async () => {
      const session = await startSession(this.hub.agent, {
        clientTools: hello.tools,
        config: { inputFormat: live.input, outputFormat: live.output },
        clock: this.hub.clock,
      });
      live.bind(session);
    })();
    try {
      await this.#starting;
    } catch (error) {
      this.#starting = undefined;
      this.#error('START_FAILED', error instanceof Error ? error.message : String(error), false);
      this.close(1011, 'session start failed');
      return;
    }
    this.#starting = undefined;
    if (this.#closed) {
      // The socket went away while the model was connecting; park so a resume can still find it.
      this.hub.adopt(live);
      this.hub.park(live);
      return;
    }
    this.hub.adopt(live);
    this.#bind(live);
    if (hello.context !== undefined) this.hub.options.onContext?.(hello.context, live.session);
    live.send({ type: 'ready', sessionId: live.id, input: toWireFormat(live.input), output: toWireFormat(live.output) });
    live.resend(0); // anything the session emitted before the socket was bound
    for (const message of this.#pending.splice(0)) this.#handle(live, message);
  }

  #resume(hello: Extract<ClientMessage, { type: 'hello' }>): void {
    const live = this.hub.find(hello.sessionId!);
    if (!live) {
      this.#error('RESUME_FAILED', 'Unknown or expired session', false);
      this.close(4404, 'unknown session');
      return;
    }
    live.socket?.close(4000, 'replaced by a newer connection');
    this.#bind(live);
    if (live.session.closed) return;
    live.send({ type: 'ready', sessionId: live.id, input: toWireFormat(live.input), output: toWireFormat(live.output), resumedFrom: live.inbox.lastSeq });
    if (!live.resend(hello.resumeFrom ?? 0)) {
      this.#error('RESUME_FAILED', 'Missed messages are no longer available', false);
      void live.session.close();
      return;
    }
    if (hello.context !== undefined) this.hub.options.onContext?.(hello.context, live.session);
  }

  #bind(live: LiveSession): void {
    this.hub.unpark(live);
    this.#live = live;
    live.socket = this;
  }

  #handle(live: LiveSession, message: ClientMessage): void {
    if (message.type === 'ack') {
      live.outbox.ack(message.upTo);
      return;
    }
    if (!live.inbox.accept(message)) {
      this.#scheduleAck(live);
      return;
    }
    const session = live.session;
    switch (message.type) {
      case 'text':
        session.sendText(message.text);
        break;
      case 'interrupt':
        session.interrupt(message.reason);
        break;
      case 'playback':
        session.playback(message.itemId, message.playedMs);
        break;
      case 'tool.result': {
        const result: ToolResult = message.ok
          ? { ok: true, output: message.output }
          : { ok: false, code: message.code, message: message.message };
        session.submitClientToolResult(message.callId, result);
        break;
      }
      case 'context':
        this.hub.options.onContext?.(message.context, session);
        break;
    }
    this.#scheduleAck(live);
  }

  #scheduleAck(live: LiveSession): void {
    if (this.#ackScheduled) return;
    this.#ackScheduled = true;
    queueMicrotask(() => {
      this.#ackScheduled = false;
      if (live.socket === this) live.send({ type: 'ack', upTo: live.inbox.lastSeq });
    });
  }

  #sendDirect(message: Unsequenced<ServerMessage>): void {
    if (this.#live?.socket === this) this.#live.send(message);
    else this.send(encodeMessage({ v: PROTOCOL_VERSION, seq: 0, ...message } as ServerMessage));
  }

  #error(code: string, message: string, recoverable: boolean): void {
    this.#sendDirect({ type: 'error', code, message, recoverable });
  }

  #checkHeartbeat(): void {
    const timeout = this.hub.heartbeatTimeoutMs;
    this.#heartbeat = this.hub.clock.setTimeout(() => {
      if (this.#closed) return;
      if (this.hub.clock.now() - this.#lastSeen >= timeout) this.close(4408, 'heartbeat timeout');
      else this.#checkHeartbeat();
    }, Math.max(1, timeout / 3));
  }
}

/** Shares sessions between sockets, so a reconnecting app can resume. */
export class Hub {
  readonly clock: Clock;
  readonly highWaterMark: number;
  readonly heartbeatTimeoutMs: number;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(readonly agent: AgentDefinition, readonly options: AttachOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.highWaterMark = options.highWaterMark ?? 256 * 1024;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  }

  attach(socket: WebSocketLike): Connection {
    return new SocketConnection(this, socket);
  }

  /** Live sessions, connected or waiting for a resume. */
  get size(): number {
    return this.#sessions.size;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((live) => live.session.close()));
    this.#sessions.clear();
  }

  /** @internal */
  adopt(live: LiveSession): void {
    this.#sessions.set(live.id, live);
  }

  /** @internal */
  find(id: string): LiveSession | undefined {
    return this.#sessions.get(id);
  }

  /** @internal */
  forget(live: LiveSession): void {
    this.unpark(live);
    this.#sessions.delete(live.id);
  }

  /** @internal Keeps a socketless session for `resumeWindowMs`, then closes it. */
  park(live: LiveSession): void {
    this.unpark(live);
    live.expiry = this.clock.setTimeout(() => {
      live.expiry = undefined;
      if (!live.socket) void live.session.close();
    }, this.options.resumeWindowMs ?? 30_000);
  }

  /** @internal */
  unpark(live: LiveSession): void {
    if (live.expiry !== undefined) this.clock.clearTimeout(live.expiry);
    live.expiry = undefined;
  }
}

const hubs = new WeakMap<AgentDefinition, Hub>();

/**
 * Serves `agent` over one WebSocket using protocol v1. Sockets attached for the
 * same agent share a hub, so a reconnecting app can resume its session.
 * Options apply when the agent's hub is first created.
 */
export function attach(agent: AgentDefinition, socket: WebSocketLike, options?: AttachOptions): Connection {
  let hub = hubs.get(agent);
  if (!hub) {
    hub = new Hub(agent, options);
    hubs.set(agent, hub);
  }
  return hub.attach(socket);
}
