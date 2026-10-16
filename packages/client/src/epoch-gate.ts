/**
 * The client's view of interrupt epochs (spec/protocol.md §6): the newest epoch
 * observed in server messages and the newest epoch closed. Nothing that belongs
 * to a closed epoch may take effect: no tool starts, no audio plays, no preview shows.
 */
export class EpochGate {
  #observed = 0;
  #closed = -1;

  /** The newest epoch seen in `turn.state`, `audio.start` or `tool.call`. */
  get observed(): number {
    return this.#observed;
  }

  observe(epoch: number): void {
    if (epoch > this.#observed) this.#observed = epoch;
  }

  /** Closes `epoch` and every earlier one. False when they were closed already. */
  close(epoch: number): boolean {
    if (epoch <= this.#closed) return false;
    this.#closed = epoch;
    return true;
  }

  isClosed(epoch: number): boolean {
    return epoch <= this.#closed;
  }
}
