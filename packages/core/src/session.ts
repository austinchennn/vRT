import type { AgentDefinition, ToolCallInfo, Turn, TurnMetrics, TurnState } from './agent.js';
import { pcm16DurationMs, type AudioChunk } from './audio.js';
import { Emitter } from './emitter.js';
import type { EventOf, RealtimeEvent } from './events.js';
import type { Capabilities, RealtimeSession, SessionConfig, ToolSpec } from './model.js';
import { validateToolArgs, type Tool, type ToolResult } from './tool.js';
import { ToolStreams, type ToolStreamEvent } from './tool-stream.js';
import type { Vad } from './vad.js';

/** Time source and timers; injectable so tests run on virtual time. */
export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type InterruptReason = 'speech' | 'user' | 'keyboard';

/** Events an `AgentSession` emits to its edge (server attachment, tests, custom transports). */
export type AgentEvent =
  | { type: 'ready'; sessionId: string }
  | { type: 'turn.state'; turnId: string; epoch: number; state: TurnState }
  | { type: 'transcript'; role: 'user' | 'agent'; itemId: string; text: string; final: boolean }
  | { type: 'text'; responseId: string; epoch: number; delta: string }
  | { type: 'audio'; responseId: string; itemId: string; epoch: number; chunk: AudioChunk }
  /** A client tool to run in the app; answer with `submitClientToolResult`. */
  | { type: 'tool.call'; callId: string; epoch: number; turnId: string; name: string; arguments: unknown }
  /** Streaming arguments from the model. */
  | { type: 'tool.call.delta'; callId: string; epoch: number; name: string; argumentsDelta: string }
  /** Progress a running server tool reported through `context.emit`. */
  | { type: 'tool.preview'; callId: string; epoch: number; name: string; preview: unknown }
  /**
   * One step of a tool call's lifecycle, server or client (spec/protocol.md §7.5):
   * `start`, argument fragments, `arguments-complete`, progress, then exactly one
   * of `settled`, `cancelled` or `failed`.
   */
  | ToolStreamEvent
  | { type: 'tool.result'; callId: string; epoch: number; name: string; result: ToolResult }
  | { type: 'interrupted'; epoch: number; reason: InterruptReason }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'closed' };

export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export interface TranscriptItem {
  role: 'user' | 'agent';
  itemId: string;
  text: string;
  /** Set when the text was cut to what the user heard. */
  truncated?: boolean;
}

export interface StartSessionOptions {
  /** Tools declared by the connecting app; offered to the model when `clientTools` is `'accept'`. */
  clientTools?: readonly ToolSpec[];
  /** Extra session config, e.g. the audio formats an edge negotiated. */
  config?: Partial<SessionConfig>;
  /** Attached to the session for tools and hooks, e.g. the authenticated principal. */
  data?: unknown;
  signal?: AbortSignal;
  clock?: Clock;
}

const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = 30_000;
const FINISHED_RESPONSES_KEPT = 64;
const TRAILING_AUDIO_KEPT = 16;

interface CallRecord {
  callId: string;
  providerCallId: string;
  name: string;
  args: unknown;
  epoch: number;
  turn: Turn;
  responseId: string | undefined;
  where: 'server' | 'client';
  tool: Tool<never, unknown> | undefined;
  status: 'queued' | 'running' | 'settled';
  controller: AbortController;
  timer?: unknown;
  resolveClient?: (result: ToolResult) => void;
}

interface ResponseRecord {
  epoch: number;
  ended: boolean;
  calls: Set<string>;
}

interface AudioItem {
  responseId: string;
  receivedMs: number;
  /** Trailing audio only: the user took the floor after its response ended. */
  cut?: boolean;
}

export function toModelOutput(result: ToolResult): unknown {
  return result.ok ? result.output : { error: { code: result.code, message: result.message } };
}

/**
 * The L2 runtime: a small turn state machine over one `RealtimeSession`.
 *
 * Interrupt guarantees (docs/ARCHITECTURE.md §4.2):
 * 1. Every interruption closes the current epoch. Tool calls run one at a time in
 *    arrival order and are gated on their epoch right before they start, so no
 *    call from a closed epoch ever starts; running non-async calls are aborted.
 * 2. Every call gets exactly one result; cancelled calls resolve as `INTERRUPTED`
 *    and anything a cancelled call returns later is ignored.
 * 3. On interruption the model transcript is truncated to the milliseconds the
 *    edge reported as played (`playback()`), or rewritten locally when the model
 *    cannot truncate. This also covers audio the user talks over after its
 *    response already ended, as models generate far faster than real time.
 * 4. The runtime never applies part of a call: a call either runs to completion
 *    under its own control or does not run.
 */
export class AgentSession {
  readonly agent: AgentDefinition;
  readonly capabilities: Capabilities;
  /** Data the edge attached (e.g. the authenticated principal); passed to tools and hooks. */
  readonly data: unknown;
  readonly #model: RealtimeSession;
  readonly #clock: Clock;
  readonly #emitter: Emitter<AgentEvent>;
  readonly #serverTools: ReadonlyMap<string, Tool<never, unknown>>;
  #clientToolNames: Set<string>;
  readonly #unsubscribe: (() => void)[] = [];
  /** Runtime turn detection, only when the model has none. */
  readonly #vad: Vad | undefined;

  #epoch = 0;
  #turnCount = 0;
  #turn: Turn | undefined;
  #metrics: TurnMetrics = { toolCalls: 0 };
  #speechEndAt: number | undefined;
  #turnStartedAt = 0;

  #openResponse: string | undefined;
  #awaitingResponse = false;
  #discardNextResponse = false;
  readonly #responses = new Map<string, ResponseRecord>();
  /** Recently finished responses; late events for them are stale, never live. */
  readonly #finished = new Set<string>();

  readonly #calls = new Map<string, CallRecord>();
  /** Provider identifiers are scoped to a response; public identities never expose or reuse them. */
  readonly #callIds = new Map<string, Map<string, string>>();
  readonly #queue: CallRecord[] = [];
  #pumping = false;
  readonly #streams: ToolStreams;

  readonly #audioItems = new Map<string, AudioItem>();
  /**
   * Audio of turns that ended while the edge may still be playing it: a response
   * often ends long before the user has heard it all. Oldest first, as played.
   */
  readonly #trailingAudio = new Map<string, AudioItem>();
  readonly #played = new Map<string, number>();
  readonly #interruptedItems = new Set<string>();
  readonly #transcript: TranscriptItem[] = [];
  readonly #transcriptIndex = new Map<string, TranscriptItem>();
  /** Full agent text of interrupted items, so repeated truncation always cuts from the original. */
  readonly #untruncated = new Map<string, string>();
  readonly #turnAgentItems = new Set<string>();
  #closed = false;

  constructor(agent: AgentDefinition, model: RealtimeSession, options: { clientTools?: readonly ToolSpec[]; clock?: Clock; data?: unknown } = {}) {
    this.agent = agent;
    this.data = options.data;
    this.#model = model;
    this.capabilities = model.capabilities;
    this.#clock = options.clock ?? systemClock;
    // A throwing edge listener must not break dispatch, and must not loop back through `error`.
    this.#emitter = new Emitter<AgentEvent>((error) => this.#hook(() => agent.hooks?.onError?.(toError(error), true)));
    this.#streams = new ToolStreams((event) => this.#emitter.emit(event));
    this.#serverTools = new Map(Object.entries(agent.tools ?? {}));
    this.#clientToolNames = new Set(acceptedClientTools(agent, options.clientTools).map((spec) => spec.name));
    this.#vad = agent.vad && !this.capabilities.turnDetection.server && agent.turnDetection !== null ? agent.vad() : undefined;
    this.#listen();
  }

  // ── Public surface for edges ────────────────────────────────────────────

  get epoch(): number {
    return this.#epoch;
  }

  get turn(): Turn | undefined {
    return this.#turn;
  }

  get state(): TurnState {
    return this.#turn?.state ?? 'idle';
  }

  /** Conversation as the runtime knows it, aligned with what the user heard. */
  get transcript(): readonly TranscriptItem[] {
    return this.#transcript;
  }

  get closed(): boolean {
    return this.#closed;
  }

  on<T extends AgentEventType>(type: T, listener: (event: AgentEventOf<T>) => void): () => void {
    return this.#emitter.on(type, listener);
  }

  /** Hot path: forwarded synchronously (and run through the runtime VAD, if any). */
  sendAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    this.#model.sendAudio(chunk);
    const vad = this.#vad?.process(chunk);
    if (vad === 'start') {
      this.#interrupt('speech', false);
      this.#speechEndAt = undefined;
      this.#ensureTurn('listening');
    } else if (vad === 'end') {
      this.commitAudio();
    }
  }

  /** Manual turn end (or the edge's own VAD): commits buffered audio and asks for a reply. */
  commitAudio(): void {
    if (this.#closed) return;
    this.interrupt('user');
    this.#speechEndAt = this.#clock.now();
    this.#ensureTurn('thinking');
    this.#model.commitAudio();
    this.#requestResponse();
  }

  sendText(text: string): void {
    if (this.#closed) return;
    this.interrupt('user');
    this.#speechEndAt = this.#clock.now();
    this.#ensureTurn('thinking');
    this.#appendTranscript('user', `text-${this.#turnCount}`, text);
    this.#model.sendText(text);
    this.#requestResponse();
  }

  /** Edge report of how much of an audio item the user actually heard. */
  playback(itemId: string, playedMs: number): void {
    if (this.#closed) return;
    this.#played.set(itemId, playedMs);
    if (this.#interruptedItems.has(itemId)) this.#truncate(itemId);
    else this.#resolveTrailing(itemId, playedMs);
  }

  /**
   * Interrupts the agent: closes the epoch, cancels the response, truncates to
   * what was heard and resolves every pending call of the closed epoch.
   * With nothing in flight there is no epoch to close and no `interrupted` event,
   * but audio of an ended response that the edge may still be playing is still
   * truncated to what `playback()` reports as heard.
   */
  interrupt(reason: InterruptReason = 'user'): void {
    this.#interrupt(reason, reason === 'speech' && this.capabilities.turnDetection.server);
  }

  #interrupt(reason: InterruptReason, providerCancels: boolean): void {
    if (this.#closed) return;
    if (!this.#isResponding()) {
      this.#cutTrailingAudio();
      return;
    }
    const startedAt = this.#clock.now();
    const closedEpoch = this.#epoch;
    this.#epoch++;

    // Decide what belongs to the closed epoch before calling into the model: a model may
    // end its response synchronously inside cancel(), and that must not hide anything here.
    const interruptedItems = [...this.#audioItems].filter(([, item]) => this.#responses.get(item.responseId)?.epoch === closedEpoch).map(([itemId]) => itemId);
    const interruptedCalls = [...this.#calls.values()].filter(
      (record) => record.epoch === closedEpoch && record.status !== 'settled' && !(record.status === 'running' && record.tool?.async),
    );

    const responseId = this.#openResponse;
    if (responseId !== undefined) {
      this.#openResponse = undefined;
      if (!providerCancels) this.#model.cancel();
    } else if (this.#awaitingResponse && !providerCancels) {
      this.#discardNextResponse = true;
    }
    this.#awaitingResponse = false;

    for (const itemId of interruptedItems) {
      this.#interruptedItems.add(itemId);
      this.#truncate(itemId);
    }
    for (const record of interruptedCalls) {
      record.controller.abort(new Error('Interrupted'));
      this.#settle(record, { ok: false, code: 'INTERRUPTED', message: `Interrupted by ${reason}` });
    }
    for (let i = this.#queue.length - 1; i >= 0; i--) if (this.#queue[i]!.status !== 'queued') this.#queue.splice(i, 1);
    this.#streams.interrupted(closedEpoch);

    this.#emitter.emit({ type: 'interrupted', epoch: closedEpoch, reason });
    this.#metrics.interruptLatencyMs = this.#clock.now() - startedAt;
    this.#endTurn(true);
    // Audio of the turn's earlier, already ended responses may still be playing too.
    this.#cutTrailingAudio();
  }

  /** Delivers the app's result for a client tool call. Late or duplicate results are ignored. */
  submitClientToolResult(callId: string, result: ToolResult): void {
    const record = this.#calls.get(callId);
    if (record?.where === 'client' && record.status === 'running') record.resolveClient?.(result);
  }

  /** Replaces the client tool set, e.g. when an app reconnects with different tools. */
  async setClientTools(tools: readonly ToolSpec[]): Promise<void> {
    const accepted = acceptedClientTools(this.agent, tools);
    this.#clientToolNames = new Set(accepted.map((spec) => spec.name));
    if (this.capabilities.midSessionUpdate.tools) await this.#model.update({ tools: [...serverToolSpecs(this.agent), ...accepted] });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#calls.values()) {
      if (record.status === 'settled') continue;
      record.controller.abort(new Error('Session closed'));
      record.status = 'settled';
      if (record.timer !== undefined) this.#clock.clearTimeout(record.timer);
    }
    this.#queue.length = 0;
    this.#streams.clear();
    this.#callIds.clear();
    for (const off of this.#unsubscribe) off();
    await this.#model.close();
    this.#emitter.emit({ type: 'closed' });
    this.#emitter.clear();
  }

  // ── Model events ────────────────────────────────────────────────────────

  #listen(): void {
    const on = <T extends RealtimeEvent['type']>(type: T, listener: (event: EventOf<T>) => void) =>
      this.#unsubscribe.push(this.#model.on(type, (event) => {
        if (!this.#closed) listener(event);
      }));

    on('session.ready', (event) => this.#emitter.emit({ type: 'ready', sessionId: event.sessionId }));
    on('input.speech.start', () => {
      this.interrupt('speech');
      this.#speechEndAt = undefined;
      this.#ensureTurn('listening');
    });
    on('input.speech.end', () => {
      this.#speechEndAt = this.#clock.now();
      this.#ensureTurn('thinking');
      if (this.capabilities.turnDetection.server && this.agent.turnDetection !== null) this.#awaitingResponse = true;
    });
    on('input.transcript', (event) => {
      if (event.final) this.#appendTranscript('user', event.itemId, event.text);
      this.#emitter.emit({ type: 'transcript', role: 'user', itemId: event.itemId, text: event.text, final: event.final });
      const turn = this.#turn;
      if (turn) this.#hook(() => this.agent.hooks?.onTranscript?.(event.text, event.final, turn));
    });
    on('response.start', (event) => this.#onResponseStart(event.responseId));
    on('output.text', (event) => {
      const epoch = this.#liveEpoch(event.responseId);
      if (epoch === undefined) return;
      this.#setState('speaking');
      this.#emitter.emit({ type: 'text', responseId: event.responseId, epoch, delta: event.delta });
    });
    on('output.transcript', (event) => {
      if (this.#liveEpoch(event.responseId) === undefined) return;
      const item = this.#appendTranscript('agent', event.itemId, event.delta, true);
      this.#turnAgentItems.add(event.itemId);
      this.#emitter.emit({ type: 'transcript', role: 'agent', itemId: event.itemId, text: item.text, final: false });
    });
    on('output.audio', (event) => {
      const epoch = this.#liveEpoch(event.responseId);
      if (epoch === undefined) return;
      const item = this.#audioItems.get(event.itemId) ?? { responseId: event.responseId, receivedMs: 0 };
      item.receivedMs += chunkDurationMs(event.chunk);
      this.#audioItems.set(event.itemId, item);
      if (this.#metrics.timeToFirstAudioMs === undefined && this.#speechEndAt !== undefined) {
        this.#metrics.timeToFirstAudioMs = this.#clock.now() - this.#speechEndAt;
      }
      this.#setState('speaking');
      this.#emitter.emit({ type: 'audio', responseId: event.responseId, itemId: event.itemId, epoch, chunk: event.chunk });
    });
    on('tool.call.delta', (event) => {
      const epoch = this.#liveEpoch(event.responseId);
      const turn = this.#turn;
      if (epoch === undefined || !turn) return;
      const callId = this.#publicCallId(event.responseId, event.callId);
      // Issued calls keep their records until the response ends, even after a
      // stream tombstone is evicted. No argument fragment may follow issuance.
      if (this.#calls.has(callId)) return;
      this.#emitter.emit({ type: 'tool.call.delta', callId, epoch, name: event.name, argumentsDelta: event.argumentsDelta });
      this.#streams.delta({ callId, name: event.name, epoch, turnId: turn.id, responseId: event.responseId }, event.argumentsDelta);
    });
    on('tool.call', (event) => this.#onToolCall(event));
    on('response.end', (event) => {
      this.#onResponseEnd(event);
      // Whatever the outcome, calls the response started but never issued are over.
      this.#streams.responseEnded(event.responseId);
    });
    on('error', (event) => this.#reportError(event.error, event.recoverable));
  }

  #onResponseStart(responseId: string): void {
    if (this.#discardNextResponse) {
      this.#discardNextResponse = false;
      this.#responses.set(responseId, { epoch: -1, ended: false, calls: new Set() });
      this.#model.cancel();
      return;
    }
    this.#awaitingResponse = false;
    this.#openResponse = responseId;
    this.#ensureTurn('thinking');
    this.#responses.set(responseId, { epoch: this.#epoch, ended: false, calls: new Set() });
  }

  #onResponseEnd(event: EventOf<'response.end'>): void {
    const response = this.#responses.get(event.responseId);
    if (this.#openResponse === event.responseId) this.#openResponse = undefined;
    if (event.status === 'failed') this.#reportError(new Error(`Response ${event.responseId} failed`), true);
    if (response === undefined || response.epoch !== this.#epoch) {
      this.#forgetResponse(event.responseId);
      return;
    }
    response.ended = true;
    if (event.status === 'cancelled' || event.status === 'interrupted') {
      // The provider stopped the response on its own (e.g. its VAD heard speech first).
      this.#openResponse = event.responseId;
      this.#interrupt('speech', true);
      this.#forgetResponse(event.responseId);
      return;
    }
    if (event.status === 'failed' && response.calls.size === 0) {
      this.#forgetResponse(event.responseId);
      this.#endTurn(false);
      return;
    }
    this.#continueAfter(event.responseId);
  }

  #onToolCall(event: EventOf<'tool.call'>): void {
    const response = this.#responses.get(event.responseId);
    const epoch = response?.epoch ?? (this.#finished.has(event.responseId) ? -1 : this.#epoch);
    const where = this.#serverTools.has(event.name) ? 'server' : 'client';
    const callId = response ? this.#publicCallId(event.responseId, event.callId) : `call-${crypto.randomUUID()}`;
    if (this.#calls.has(callId)) return;
    const turn = this.#ensureTurn('acting');
    const record: CallRecord = {
      callId,
      providerCallId: event.callId,
      name: event.name,
      args: event.arguments,
      epoch,
      turn,
      responseId: response ? event.responseId : undefined,
      where,
      tool: this.#serverTools.get(event.name),
      status: 'queued',
      controller: new AbortController(),
    };
    this.#calls.set(record.callId, record);
    response?.calls.add(record.callId);
    if (epoch !== this.#epoch) {
      this.#settle(record, { ok: false, code: 'INTERRUPTED', message: 'Issued by an interrupted turn' });
      return;
    }
    this.#streams.complete({ callId: record.callId, name: record.name, epoch, turnId: turn.id, responseId: record.responseId }, record.args);
    this.#metrics.toolCalls++;
    if (this.#metrics.timeToFirstToolCallMs === undefined && this.#speechEndAt !== undefined) {
      this.#metrics.timeToFirstToolCallMs = this.#clock.now() - this.#speechEndAt;
    }
    this.#setState('acting');
    this.#queue.push(record);
    void this.#pump();
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let record = this.#queue.shift(); record !== undefined; record = this.#queue.shift()) {
        if (record.status !== 'queued') continue;
        try {
          await this.#execute(record);
        } catch (error) {
          this.#settle(record, { ok: false, code: 'FAILED', message: toError(error).message });
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #execute(record: CallRecord): Promise<void> {
    const decision = await this.agent.hooks?.beforeToolCall?.(this.#callInfo(record));
    if (!this.#gate(record)) return;
    if (decision && decision.action === 'reject') {
      this.#settle(record, { ok: false, code: 'REJECTED', message: decision.message });
      return;
    }
    if (decision && decision.action === 'rewrite') record.args = decision.arguments;

    if (record.where === 'client') {
      if (!this.#clientToolNames.has(record.name)) {
        this.#settle(record, { ok: false, code: 'FAILED', message: `Unknown tool: ${record.name}` });
        return;
      }
      record.status = 'running';
      // Client calls are awaited so the queue stays strictly ordered across both kinds.
      await this.#runClient(record);
      return;
    }

    const tool = record.tool!;
    let args = record.args;
    if (tool.validate) {
      const checked = await validateToolArgs(tool.validate, args);
      if (!this.#gate(record)) return;
      if (!checked.ok) {
        this.#settle(record, checked);
        return;
      }
      args = checked.value;
    }
    record.status = 'running';
    const context = {
      signal: record.controller.signal,
      callId: record.callId,
      turnId: record.turn.id,
      epoch: record.epoch,
      data: this.data,
      emit: (preview: unknown) => {
        if (record.status !== 'running') return;
        this.#emitter.emit({ type: 'tool.preview', callId: record.callId, epoch: record.epoch, name: record.name, preview });
        this.#streams.progress(record.callId, preview);
      },
    };
    const run = Promise.resolve()
      .then(() => tool.run(args as never, context))
      .then((output): ToolResult => ({ ok: true, output }), (error): ToolResult => ({ ok: false, code: 'FAILED', message: toError(error).message }))
      .then((result) => this.#settle(record, result));
    // Async tools may outlive their turn, so they never hold up the queue.
    if (!tool.async) await Promise.race([run, abortPromise(record.controller.signal)]);
  }

  #runClient(record: CallRecord): Promise<void> {
    return new Promise((resolve) => {
      record.resolveClient = (result) => {
        this.#settle(record, result);
        resolve();
      };
      record.controller.signal.addEventListener('abort', () => resolve(), { once: true });
      const timeoutMs = this.agent.clientToolTimeoutMs ?? DEFAULT_CLIENT_TOOL_TIMEOUT_MS;
      record.timer = this.#clock.setTimeout(() => {
        record.resolveClient?.({ ok: false, code: 'TIMEOUT', message: `No result within ${timeoutMs} ms` });
      }, timeoutMs);
      this.#emitter.emit({ type: 'tool.call', callId: record.callId, epoch: record.epoch, turnId: record.turn.id, name: record.name, arguments: record.args });
    });
  }

  /** The epoch gate: re-checked after every await before a call may start. */
  #gate(record: CallRecord): boolean {
    if (this.#closed || record.status !== 'queued') return false;
    if (record.epoch === this.#epoch) return true;
    this.#settle(record, { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' });
    return false;
  }

  #settle(record: CallRecord, result: ToolResult): void {
    if (record.status === 'settled' || this.#closed) return;
    record.status = 'settled';
    if (record.timer !== undefined) this.#clock.clearTimeout(record.timer);
    const live = record.epoch === this.#epoch;
    const idle = this.#turn === undefined;
    this.#model.submitToolResult(record.providerCallId, toModelOutput(result), { respond: false });
    this.#emitter.emit({ type: 'tool.result', callId: record.callId, epoch: record.epoch, name: record.name, result });
    this.#streams.settle(record.callId, result);
    if (record.responseId === undefined || !this.#responses.has(record.responseId)) this.#calls.delete(record.callId);
    this.#hook(() => this.agent.hooks?.afterToolCall?.(this.#callInfo(record), result));
    if (live && record.responseId !== undefined) this.#continueAfter(record.responseId);
    else if (!live && (result.ok || result.code !== 'INTERRUPTED') && idle) {
      // A late async result: let the model tell the user about it.
      this.#ensureTurn('thinking');
      this.#requestResponse(true);
    }
  }

  /** After a live response ends and all its calls settled: reply with the results, or end the turn. */
  #continueAfter(responseId: string): void {
    const response = this.#responses.get(responseId);
    if (!response?.ended) return;
    for (const callId of response.calls) if (this.#calls.get(callId)?.status !== 'settled') return;
    const hadCalls = response.calls.size > 0;
    this.#forgetResponse(responseId);
    if (!hadCalls) {
      this.#endTurn(false);
      return;
    }
    this.#setState('thinking');
    this.#requestResponse(true);
  }

  #requestResponse(afterToolResults = false): void {
    this.#awaitingResponse = true;
    if (afterToolResults && this.capabilities.tools.autoReplyAfterResult) return;
    this.#model.respond();
  }

  #forgetResponse(responseId: string): void {
    this.#callIds.delete(responseId);
    const response = this.#responses.get(responseId);
    if (!response) return;
    for (const callId of response.calls) {
      const record = this.#calls.get(callId);
      if (record?.status === 'settled') this.#calls.delete(callId);
    }
    this.#responses.delete(responseId);
    this.#finished.add(responseId);
    if (this.#finished.size > FINISHED_RESPONSES_KEPT) this.#finished.delete(this.#finished.values().next().value!);
  }

  // ── Turns, transcript, truncation ───────────────────────────────────────

  #publicCallId(responseId: string, providerCallId: string): string {
    let ids = this.#callIds.get(responseId);
    if (!ids) { ids = new Map(); this.#callIds.set(responseId, ids); }
    let id = ids.get(providerCallId);
    if (!id) { id = `call-${crypto.randomUUID()}`; ids.set(providerCallId, id); }
    return id;
  }

  #ensureTurn(state: TurnState): Turn {
    if (this.#turn) {
      if (this.#turn.state !== state) this.#setState(state);
      return this.#turn;
    }
    this.#epoch++;
    this.#turnCount++;
    this.#turnStartedAt = this.#clock.now();
    this.#metrics = { toolCalls: 0 };
    this.#turn = { id: `turn-${crypto.randomUUID()}`, epoch: this.#epoch, state, interrupted: false, startedAt: this.#turnStartedAt };
    const turn = this.#turn;
    this.#hook(() => this.agent.hooks?.onTurnStart?.(turn));
    this.#emitState();
    return this.#turn;
  }

  #setState(state: TurnState): void {
    const turn = this.#turn ?? this.#ensureTurn(state);
    if (turn.state === state) return;
    turn.state = state;
    this.#emitState();
  }

  #emitState(): void {
    const turn = this.#turn;
    if (turn) this.#emitter.emit({ type: 'turn.state', turnId: turn.id, epoch: this.#epoch, state: turn.state });
  }

  #endTurn(interrupted: boolean): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    this.#awaitingResponse = false;
    turn.interrupted = interrupted;
    turn.state = 'idle';
    this.#finalizeAgentTranscript();
    this.#emitter.emit({ type: 'turn.state', turnId: turn.id, epoch: this.#epoch, state: 'idle' });
    const metrics = this.#metrics;
    this.#hook(() => this.agent.hooks?.onTurnEnd?.(turn, metrics));
  }

  #isResponding(): boolean {
    const state = this.#turn?.state;
    return state === 'thinking' || state === 'speaking' || state === 'acting' || this.#openResponse !== undefined;
  }

  /** The epoch of a live response, or undefined when its output must be dropped. */
  #liveEpoch(responseId: string): number | undefined {
    const epoch = this.#responses.get(responseId)?.epoch;
    return epoch === this.#epoch ? epoch : undefined;
  }

  #appendTranscript(role: 'user' | 'agent', itemId: string, text: string, delta = false): TranscriptItem {
    let item = this.#transcriptIndex.get(itemId);
    if (!item) {
      item = { role, itemId, text: '' };
      this.#transcript.push(item);
      this.#transcriptIndex.set(itemId, item);
    }
    item.text = delta ? item.text + text : text;
    return item;
  }

  #finalizeAgentTranscript(): void {
    for (const itemId of this.#turnAgentItems) {
      if (this.#interruptedItems.has(itemId)) continue;
      const item = this.#transcriptIndex.get(itemId);
      if (item) this.#emitter.emit({ type: 'transcript', role: 'agent', itemId, text: item.text, final: true });
    }
    this.#turnAgentItems.clear();
    for (const [itemId, audio] of this.#audioItems) {
      if (this.#interruptedItems.has(itemId)) continue;
      this.#audioItems.delete(itemId);
      this.#trailingAudio.set(itemId, audio);
    }
    while (this.#trailingAudio.size > TRAILING_AUDIO_KEPT) this.#trailingAudio.delete(this.#trailingAudio.keys().next().value!);
  }

  /** The user took the floor: trailing audio was heard only as far as the edge reports. */
  #cutTrailingAudio(): void {
    for (const [itemId, audio] of this.#trailingAudio) {
      audio.cut = true;
      const played = this.#played.get(itemId);
      if (played !== undefined) this.#resolveTrailing(itemId, played);
    }
  }

  /**
   * A report on trailing audio: heard in full, it is done with. Cut short after the
   * user took the floor, it becomes an interrupted item and is truncated like one.
   */
  #resolveTrailing(itemId: string, playedMs: number): void {
    const audio = this.#trailingAudio.get(itemId);
    if (!audio) return;
    const heardAll = Math.round(playedMs) >= Math.round(audio.receivedMs);
    if (!heardAll && !audio.cut) return;
    this.#trailingAudio.delete(itemId);
    if (heardAll) return;
    this.#audioItems.set(itemId, audio);
    this.#interruptedItems.add(itemId);
    this.#truncate(itemId);
  }

  #truncate(itemId: string): void {
    const played = this.#played.get(itemId);
    const audio = this.#audioItems.get(itemId);
    if (played === undefined || audio === undefined) return;
    const audioEndMs = Math.max(0, Math.min(Math.round(played), Math.round(audio.receivedMs)));
    if (this.capabilities.truncate) this.#model.truncate(itemId, audioEndMs);
    const item = this.#transcriptIndex.get(itemId);
    if (!item || audio.receivedMs <= 0) return;
    // Keep the share of the text that was heard, so the local transcript matches the user's experience.
    const full = this.#untruncated.get(itemId) ?? item.text;
    this.#untruncated.set(itemId, full);
    item.text = full.slice(0, Math.round(full.length * (audioEndMs / audio.receivedMs)));
    item.truncated = true;
    this.#emitter.emit({ type: 'transcript', role: 'agent', itemId, text: item.text, final: true });
  }

  #callInfo(record: CallRecord): ToolCallInfo {
    return { callId: record.callId, name: record.name, arguments: record.args, where: record.where, risk: record.tool?.risk ?? 'low', turn: record.turn, data: this.data };
  }

  #hook(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (!this.#closed) this.#emitter.emit({ type: 'error', error: toError(error), recoverable: true });
    }
  }

  #reportError(error: Error, recoverable: boolean): void {
    this.#hook(() => this.agent.hooks?.onError?.(error, recoverable));
    if (!this.#closed) this.#emitter.emit({ type: 'error', error, recoverable });
  }
}

/** Connects the agent's model and returns a running session. */
export async function startSession(agent: AgentDefinition, options: StartSessionOptions = {}): Promise<AgentSession> {
  const config: SessionConfig = {
    instructions: agent.instructions,
    tools: [...serverToolSpecs(agent), ...acceptedClientTools(agent, options.clientTools)],
    ...(agent.voice !== undefined ? { voice: agent.voice } : {}),
    ...(agent.turnDetection !== undefined ? { turnDetection: agent.turnDetection } : {}),
    ...options.config,
  };
  const model = await agent.model.connect(config, options.signal ? { signal: options.signal } : undefined);
  return new AgentSession(agent, model, options);
}

export function serverToolSpecs(agent: AgentDefinition): ToolSpec[] {
  return Object.entries(agent.tools ?? {}).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters }));
}

function acceptedClientTools(agent: AgentDefinition, tools: readonly ToolSpec[] | undefined): ToolSpec[] {
  if (agent.clientTools !== 'accept' || !tools) return [];
  const serverNames = new Set(Object.keys(agent.tools ?? {}));
  return tools.filter((spec) => !serverNames.has(spec.name));
}

function chunkDurationMs(chunk: AudioChunk): number {
  if (chunk.durationMs !== undefined) return chunk.durationMs;
  if (chunk.format.encoding === 'pcm16') return pcm16DurationMs(chunk.data.byteLength, chunk.format.sampleRate);
  if (chunk.format.encoding === 'pcmu') return chunk.data.byteLength / 8;
  return 0;
}

function abortPromise(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
