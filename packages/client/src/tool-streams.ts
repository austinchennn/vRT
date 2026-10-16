import type { ServerMessage, Unsequenced } from '@vrealtime/protocol';
import type { EpochGate } from './epoch-gate.js';

/** One step of a tool call's lifecycle, as the app sees it (spec/protocol.md §7.5). */
export type ToolStreamEvent = Unsequenced<Extract<ServerMessage, { type: 'tool.stream' }>>;

type CallIdentity = Pick<ToolStreamEvent, 'callId' | 'name' | 'turnId' | 'epoch'>;

const TERMINAL: ReadonlySet<string> = new Set(['settled', 'cancelled', 'failed']);
/** Ended calls remembered so that late or duplicate terminal steps are not reported twice. */
const ENDED_CALLS_KEPT = 256;

/**
 * The app-facing lifecycle of tool calls: steps of closed epochs are dropped, open
 * calls of an epoch closed locally end as `cancelled` at once, and each call's
 * terminal step is reported once, whether it came from the server or from a local
 * interruption.
 */
export class ToolStreamTracker {
  readonly #open = new Map<string, CallIdentity>();
  readonly #ended = new Set<string>();
  readonly #gate: Pick<EpochGate, 'isClosed'>;
  readonly #emit: (event: ToolStreamEvent) => void;

  constructor(gate: Pick<EpochGate, 'isClosed'>, emit: (event: ToolStreamEvent) => void) {
    this.#gate = gate;
    this.#emit = emit;
  }

  /** A step from the server. */
  receive(event: ToolStreamEvent): void {
    if (this.#gate.isClosed(event.epoch) || this.#ended.has(event.callId)) return;
    if (TERMINAL.has(event.phase)) this.#end(event.callId);
    else this.#open.set(event.callId, { callId: event.callId, name: event.name, turnId: event.turnId, epoch: event.epoch });
    this.#emit(event);
  }

  /** After epochs closed locally: their open calls end as cancelled now, not one round trip later. */
  cancelClosed(): void {
    for (const call of [...this.#open.values()]) {
      if (!this.#gate.isClosed(call.epoch)) continue;
      this.#end(call.callId);
      this.#emit({ type: 'tool.stream', ...call, phase: 'cancelled' });
    }
  }

  /** The session closed: forget everything without reporting. */
  clear(): void {
    this.#open.clear();
    this.#ended.clear();
  }

  #end(callId: string): void {
    this.#open.delete(callId);
    this.#ended.add(callId);
    if (this.#ended.size > ENDED_CALLS_KEPT) this.#ended.delete(this.#ended.values().next().value!);
  }
}
