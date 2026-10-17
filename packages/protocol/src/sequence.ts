import { PROTOCOL_VERSION, TRANSIENT_TYPES } from './messages.js';

type Envelope = { v: typeof PROTOCOL_VERSION; seq: number };
type Message = Envelope & { type: string };
/** A message before `Outbox.stamp` assigns its envelope. */
export type Unsequenced<M extends Message> = M extends unknown ? Omit<M, 'v' | 'seq'> : never;

/**
 * Outgoing side: assigns `seq`, keeps unacknowledged messages and returns them
 * for resend after a reconnect. Transient messages (ack, ping, pong) get `seq: 0`
 * and are not kept.
 */
export class Outbox<M extends Message> {
  #seq = 0;
  #unacked: M[] = [];
  readonly #limit: number;
  /** Highest seq removed by ACK or eviction; peers behind it cannot fully resume (§5.4). */
  #removedThrough = 0;

  constructor(limit = 1024) {
    this.#limit = limit;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  get pending(): number {
    return this.#unacked.length;
  }

  stamp(message: Unsequenced<M>): M {
    const transient = TRANSIENT_TYPES.has((message as { type: string }).type);
    const full = { v: PROTOCOL_VERSION, seq: transient ? 0 : ++this.#seq, ...message } as unknown as M;
    if (!transient) {
      this.#unacked.push(full);
      if (this.#unacked.length > this.#limit) this.#removedThrough = this.#unacked.shift()!.seq;
    }
    return full;
  }

  /** The peer has everything up to and including `upTo`. */
  ack(upTo: number): void {
    let drop = 0;
    while (drop < this.#unacked.length && this.#unacked[drop]!.seq <= upTo) drop++;
    if (drop > 0) {
      this.#removedThrough = this.#unacked[drop - 1]!.seq;
      this.#unacked.splice(0, drop);
    }
  }

  /**
   * Messages after `lastSeen` for resend, or undefined when the resume cannot be honored:
   * some of them were already dropped, or `lastSeen` is ahead of anything sent.
   */
  resendFrom(lastSeen: number): M[] | undefined {
    if (lastSeen < this.#removedThrough || lastSeen > this.#seq) return undefined;
    return this.#unacked.filter((message) => message.seq > lastSeen);
  }
}

/**
 * Incoming side: drops duplicates and tracks the resume point (`lastSeq`),
 * which is what a reconnecting peer reports as `resumeFrom`.
 */
export class Inbox {
  #lastSeq: number;

  constructor(lastSeq = 0) {
    this.#lastSeq = lastSeq;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /**
   * True when the message is new and should be handled. `seq: 0` marks a message
   * outside the resumable stream (transient types, or errors sent before a session
   * exists): always handled, never deduplicated.
   */
  accept(message: { type: string; seq: number }): boolean {
    if (message.seq === 0 || TRANSIENT_TYPES.has(message.type)) return true;
    if (message.seq <= this.#lastSeq) return false;
    this.#lastSeq = message.seq;
    return true;
  }
}
