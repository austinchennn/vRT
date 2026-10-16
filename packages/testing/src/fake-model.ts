import {
  Emitter,
  type AudioChunk,
  type Capabilities,
  type EventOf,
  type EventType,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSession,
  type RespondOptions,
  type SessionConfig,
} from '@vrealtime/core';
import { VirtualClock } from './clock.js';

/** One scripted event, `at` milliseconds of virtual time after `connect()`. */
export interface ScriptStep {
  at: number;
  event: RealtimeEvent;
}

export type Command =
  | { type: 'connect'; config: SessionConfig }
  | { type: 'update'; config: Partial<SessionConfig> }
  | { type: 'sendAudio'; chunk: AudioChunk }
  | { type: 'commitAudio' }
  | { type: 'clearAudio' }
  | { type: 'sendText'; text: string }
  | { type: 'respond'; options?: RespondOptions }
  | { type: 'cancel' }
  | { type: 'truncate'; itemId: string; audioEndMs: number }
  | { type: 'submitToolResult'; callId: string; output: unknown; options?: { respond?: boolean } }
  | { type: 'close' };

export type CapabilityOverrides = { [K in keyof Capabilities]?: Capabilities[K] extends object ? Partial<Capabilities[K]> : Capabilities[K] };

export interface FakeModelOptions {
  capabilities?: CapabilityOverrides;
  /** Events every new session replays on virtual time. */
  script?: readonly ScriptStep[];
  /** Shared virtual clock; one is created when omitted. */
  clock?: VirtualClock;
  /** Reacts to each command, e.g. answering `respond()` with a scripted response. */
  onCommand?: (command: Command, session: FakeSession) => void;
  /** Makes `connect()` reject. */
  connectError?: Error;
}

export const FULL_CAPABILITIES: Capabilities = {
  input: { audio: true, text: true, formats: [{ encoding: 'pcm16', sampleRate: 24000, channels: 1 }] },
  output: { audio: true, text: true, formats: [{ encoding: 'pcm16', sampleRate: 24000, channels: 1 }] },
  turnDetection: { server: true, semantic: true, manual: true },
  inputTranscription: true,
  tools: { calls: true, argumentStreaming: true, autoReplyAfterResult: true },
  truncate: true,
  midSessionUpdate: { instructions: true, tools: true },
};

export function mergeCapabilities(overrides: CapabilityOverrides = {}): Capabilities {
  const merged: Record<string, unknown> = { ...FULL_CAPABILITIES };
  for (const [key, value] of Object.entries(overrides)) {
    const base = FULL_CAPABILITIES[key as keyof Capabilities];
    merged[key] = typeof base === 'object' && !Array.isArray(base) ? { ...base, ...(value as object) } : value;
  }
  return merged as unknown as Capabilities;
}

/**
 * A session that replays scripted events and records every command. Like real
 * providers, `cancel()` ends the open response as `cancelled`, and with server
 * turn detection a scripted `input.speech.start` ends it as `interrupted`; in
 * both cases that response's remaining scripted events are dropped. Those
 * endings are delivered on the clock (at the current time), never re-entrantly.
 */
export class FakeSession implements RealtimeSession {
  readonly capabilities: Capabilities;
  readonly commands: Command[] = [];
  readonly clock: VirtualClock;
  config: SessionConfig;
  closed = false;
  #emitter = new Emitter<RealtimeEvent>((error) => { throw error; });
  #pending = new Map<number, RealtimeEvent>();
  #openResponse: string | undefined;
  #onCommand: FakeModelOptions['onCommand'];

  constructor(config: SessionConfig, options: { capabilities: Capabilities; clock: VirtualClock; script: readonly ScriptStep[]; onCommand?: FakeModelOptions['onCommand'] }) {
    this.config = config;
    this.capabilities = options.capabilities;
    this.clock = options.clock;
    this.#onCommand = options.onCommand;
    for (const step of options.script) this.schedule(step.event, step.at);
    this.#record({ type: 'connect', config });
  }

  /** The response that started and has not ended yet. */
  get openResponse(): string | undefined {
    return this.#openResponse;
  }

  /** Schedules an event `delayMs` from the current virtual time. */
  schedule(event: RealtimeEvent, delayMs = 0): void {
    const id = this.clock.setTimeout(() => {
      this.#pending.delete(id);
      this.emit(event);
    }, delayMs);
    this.#pending.set(id, event);
  }

  /** Emits immediately, tracking the open response like a provider would. */
  emit(event: RealtimeEvent): void {
    if (this.closed) return;
    if (event.type === 'input.speech.start' && this.capabilities.turnDetection.server && this.#openResponse !== undefined) {
      this.#end(this.#openResponse, 'interrupted', false);
    }
    if (event.type === 'response.start') this.#openResponse = event.responseId;
    if (event.type === 'response.end' && event.responseId === this.#openResponse) this.#openResponse = undefined;
    this.#emitter.emit(event);
  }

  commandsOf<T extends Command['type']>(type: T): Extract<Command, { type: T }>[] {
    return this.commands.filter((command): command is Extract<Command, { type: T }> => command.type === type);
  }

  on<T extends EventType>(type: T, listener: (event: EventOf<T>) => void): () => void {
    return this.#emitter.on(type, listener as (event: Extract<RealtimeEvent, { type: T }>) => void);
  }

  async update(config: Partial<SessionConfig>): Promise<void> {
    this.#assertOpen();
    this.config = { ...this.config, ...config };
    this.#record({ type: 'update', config });
  }

  sendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#record({ type: 'sendAudio', chunk });
  }

  commitAudio(): void {
    this.#assertOpen();
    this.#record({ type: 'commitAudio' });
  }

  clearAudio(): void {
    this.#assertOpen();
    this.#record({ type: 'clearAudio' });
  }

  sendText(text: string): void {
    this.#assertOpen();
    this.#record({ type: 'sendText', text });
  }

  respond(options?: RespondOptions): void {
    this.#assertOpen();
    this.#record(options === undefined ? { type: 'respond' } : { type: 'respond', options });
  }

  cancel(): void {
    this.#assertOpen();
    this.#record({ type: 'cancel' });
    if (this.#openResponse !== undefined) this.#end(this.#openResponse, 'cancelled', true);
  }

  truncate(itemId: string, audioEndMs: number): void {
    this.#assertOpen();
    this.#record({ type: 'truncate', itemId, audioEndMs });
  }

  submitToolResult(callId: string, output: unknown, options?: { respond?: boolean }): void {
    this.#assertOpen();
    this.#record(options === undefined ? { type: 'submitToolResult', callId, output } : { type: 'submitToolResult', callId, output, options });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.#record({ type: 'close' });
    this.closed = true;
    for (const id of this.#pending.keys()) this.clock.clearTimeout(id);
    this.#pending.clear();
  }

  #end(responseId: string, status: 'cancelled' | 'interrupted', deferred: boolean): void {
    for (const [id, event] of this.#pending) {
      if ('responseId' in event && event.responseId === responseId) {
        this.clock.clearTimeout(id);
        this.#pending.delete(id);
      }
    }
    this.#openResponse = undefined;
    const end: RealtimeEvent = { type: 'response.end', responseId, status };
    if (deferred) this.schedule(end);
    else this.#emitter.emit(end);
  }

  #record(command: Command): void {
    this.commands.push(command);
    this.#onCommand?.(command, this);
  }

  #assertOpen(): void {
    if (this.closed) throw new Error('FakeSession is closed');
  }
}

export interface FakeModel extends RealtimeModel {
  readonly clock: VirtualClock;
  readonly sessions: FakeSession[];
  /** The most recently connected session; throws if none. */
  readonly session: FakeSession;
}

export function fakeModel(options: FakeModelOptions = {}): FakeModel {
  const capabilities = mergeCapabilities(options.capabilities);
  const clock = options.clock ?? new VirtualClock();
  const sessions: FakeSession[] = [];
  return {
    provider: 'fake',
    id: 'fake-realtime',
    capabilities,
    clock,
    sessions,
    get session() {
      const last = sessions.at(-1);
      if (last === undefined) throw new Error('fakeModel: no session connected yet');
      return last;
    },
    async connect(config, connectOptions) {
      connectOptions?.signal?.throwIfAborted();
      if (options.connectError) throw options.connectError;
      const session = new FakeSession(config, {
        capabilities,
        clock,
        script: options.script ?? [],
        ...(options.onCommand ? { onCommand: options.onCommand } : {}),
      });
      sessions.push(session);
      return session;
    },
  };
}
