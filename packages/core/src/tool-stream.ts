import { BoundedSet } from './bounded.js';
import type { ToolResult } from './tool.js';

/** One step of a tool call's lifecycle. `settled`, `cancelled` and `failed` are terminal. */
export type ToolStreamStep =
  | { phase: 'start' }
  | { phase: 'arguments-delta'; delta: string }
  | { phase: 'arguments-complete'; arguments: unknown }
  | { phase: 'progress'; progress: unknown }
  /** The call has its one result; never `INTERRUPTED`, which ends a call as `cancelled`. */
  | { phase: 'settled'; result: ToolResult }
  | { phase: 'cancelled' }
  | { phase: 'failed'; message: string };

export type ToolStreamEvent = { type: 'tool.stream'; callId: string; epoch: number; turnId: string; name: string } & ToolStreamStep;

/** Which call a step belongs to. */
export interface ToolStreamCall {
  callId: string;
  name: string;
  epoch: number;
  turnId: string;
  responseId: string | undefined;
}

interface OpenCall extends ToolStreamCall {
  /** `arguments-complete` was sent: the call was issued. */
  issued: boolean;
}

/** Ended calls remembered so that late events cannot reopen them. */
const ENDED_CALLS_KEPT = 256;

/**
 * Turns what happens to each tool call into `tool.stream` events, in the order
 * spec/protocol.md §7.5 requires: `start` first, argument fragments before
 * `arguments-complete`, progress only after it, and exactly one terminal step,
 * after which the call is forgotten.
 */
export class ToolStreams {
  readonly #open = new Map<string, OpenCall>();
  readonly #ended = new BoundedSet<string>(ENDED_CALLS_KEPT);
  readonly #emit: (event: ToolStreamEvent) => void;

  constructor(emit: (event: ToolStreamEvent) => void) {
    this.#emit = emit;
  }

  /** The model generated another fragment of a call's arguments. */
  delta(call: ToolStreamCall, delta: string): void {
    const open = this.#begin(call);
    if (open && !open.issued) this.#send(open, { phase: 'arguments-delta', delta });
  }

  /** The model finished a call's arguments: the call is issued. */
  complete(call: ToolStreamCall, args: unknown): void {
    const open = this.#begin(call);
    if (!open || open.issued) return;
    open.issued = true;
    this.#send(open, { phase: 'arguments-complete', arguments: args });
  }

  /** A running server tool reported progress. */
  progress(callId: string, progress: unknown): void {
    const open = this.#open.get(callId);
    if (open?.issued) this.#send(open, { phase: 'progress', progress });
  }

  /** A call got its one result. */
  settle(callId: string, result: ToolResult): void {
    this.#end(callId, !result.ok && result.code === 'INTERRUPTED' ? { phase: 'cancelled' } : { phase: 'settled', result });
  }

  /** Epochs up to `closedEpoch` were interrupted: calls they never issued are cancelled. Issued calls end when they settle. */
  interrupted(closedEpoch: number): void {
    for (const open of [...this.#open.values()]) if (!open.issued && open.epoch <= closedEpoch) this.#end(open.callId, { phase: 'cancelled' });
  }

  /** A response ended: calls it started but never issued failed. */
  responseEnded(responseId: string): void {
    for (const open of [...this.#open.values()]) {
      if (!open.issued && open.responseId === responseId) this.#end(open.callId, { phase: 'failed', message: 'The model stopped before the arguments were complete' });
    }
  }

  /** The session closed: forget everything without emitting. */
  clear(): void {
    this.#open.clear();
    this.#ended.clear();
  }

  #begin(call: ToolStreamCall): OpenCall | undefined {
    if (this.#ended.has(call.callId)) return undefined;
    let open = this.#open.get(call.callId);
    if (!open) {
      open = { ...call, issued: false };
      this.#open.set(call.callId, open);
      this.#send(open, { phase: 'start' });
    }
    return open;
  }

  #end(callId: string, step: Extract<ToolStreamStep, { phase: 'settled' | 'cancelled' | 'failed' }>): void {
    const open = this.#open.get(callId);
    if (!open) return;
    this.#open.delete(callId);
    this.#ended.add(callId);
    this.#send(open, step);
  }

  #send(open: OpenCall, step: ToolStreamStep): void {
    this.#emit({ type: 'tool.stream', callId: open.callId, epoch: open.epoch, turnId: open.turnId, name: open.name, ...step });
  }
}
