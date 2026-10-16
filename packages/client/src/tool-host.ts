import type { EpochGate } from './epoch-gate.js';

export type FailureCode = 'INTERRUPTED' | 'REJECTED' | 'INVALID' | 'TIMEOUT' | 'FAILED';
export type ToolOutcome = { ok: true; output: unknown } | { ok: false; code: FailureCode; message: string };

export interface ClientToolContext {
  /** Aborted when the call's turn is interrupted. */
  signal: AbortSignal;
  callId: string;
  /** The agent turn that issued the call; group edits by it (e.g. undo a whole turn). */
  turnId: string;
  epoch: number;
}

/** A tool that runs in the app. Calls run one at a time, in arrival order. */
export interface ClientTool {
  description?: string;
  /** JSON Schema for the arguments, as the model sees it. */
  parameters: { readonly [key: string]: unknown };
  run(args: any, context: ClientToolContext): unknown;
}

/** A `tool.call` waiting for its one result. */
export interface PendingCall {
  callId: string;
  name: string;
  args: unknown;
  turnId: string;
  epoch: number;
}

const BEFORE_START: ToolOutcome = { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' };
const WHILE_RUNNING: ToolOutcome = { ok: false, code: 'INTERRUPTED', message: 'Interrupted while running' };
const failed = (error: unknown): ToolOutcome => ({ ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) });

/**
 * Runs a session's app-side tools (spec/protocol.md §7): one call at a time, in
 * arrival order, behind the epoch gate, with exactly one outcome per call.
 */
export class ToolHost {
  readonly #tools: Readonly<Record<string, ClientTool>>;
  readonly #gate: Pick<EpochGate, 'isClosed'>;
  readonly #settle: (call: PendingCall, outcome: ToolOutcome) => void;
  #queue: PendingCall[] = [];
  #running: { call: PendingCall; controller: AbortController } | undefined;
  #pumping = false;

  /** `settle` receives each call's one outcome. */
  constructor(tools: Readonly<Record<string, ClientTool>>, gate: Pick<EpochGate, 'isClosed'>, settle: (call: PendingCall, outcome: ToolOutcome) => void) {
    this.#tools = tools;
    this.#gate = gate;
    this.#settle = settle;
  }

  /** Queues a call. A call from a closed epoch is answered INTERRUPTED at once and never runs. */
  submit(call: PendingCall): void {
    if (this.#gate.isClosed(call.epoch)) {
      this.#settle(call, BEFORE_START);
      return;
    }
    this.#queue.push(call);
    void this.#pump();
  }

  /** Applies newly closed epochs: aborts the running call and answers their queued calls INTERRUPTED. */
  cancelClosed(): void {
    if (this.#running && this.#gate.isClosed(this.#running.call.epoch)) this.#running.controller.abort();
    const stale = this.#queue.filter((call) => this.#gate.isClosed(call.epoch));
    this.#queue = this.#queue.filter((call) => !this.#gate.isClosed(call.epoch));
    for (const call of stale) this.#settle(call, BEFORE_START);
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let call = this.#queue.shift(); call !== undefined; call = this.#queue.shift()) this.#settle(call, await this.#run(call));
    } finally {
      this.#pumping = false;
    }
  }

  #run(call: PendingCall): Promise<ToolOutcome> {
    if (this.#gate.isClosed(call.epoch)) return Promise.resolve(BEFORE_START);
    const tool = Object.hasOwn(this.#tools, call.name) ? this.#tools[call.name] : undefined;
    if (!tool) return Promise.resolve({ ok: false, code: 'FAILED', message: `Unknown client tool: ${call.name}` });
    const controller = new AbortController();
    const running = { call, controller };
    this.#running = running;
    return new Promise<ToolOutcome>((resolve) => {
      let started = false;
      // The first outcome wins: an abort settles the call at once and a later tool result is dropped.
      controller.signal.addEventListener('abort', () => resolve(started ? WHILE_RUNNING : BEFORE_START), { once: true });
      // Tools never start inside the message handler that delivered the call.
      queueMicrotask(() => {
        // Check and start in one step: an interrupt may have landed since this was queued.
        if (controller.signal.aborted || this.#gate.isClosed(call.epoch)) {
          resolve(BEFORE_START);
          return;
        }
        started = true;
        let result: unknown;
        try {
          result = tool.run(call.args, { signal: controller.signal, callId: call.callId, turnId: call.turnId, epoch: call.epoch });
        } catch (error) {
          resolve(failed(error));
          return;
        }
        Promise.resolve(result).then((output) => resolve({ ok: true, output }), (error: unknown) => resolve(failed(error)));
      });
    }).finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
  }
}
