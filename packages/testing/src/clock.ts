interface Timer {
  id: number;
  at: number;
  run: () => void;
}

/** Deterministic virtual time. Nothing runs until `advance()`. */
export class VirtualClock {
  #now = 0;
  #nextId = 1;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  /** Schedules `run` at `delayMs` from now; timers at the same time run in scheduling order. */
  setTimeout(run: () => void, delayMs = 0): number {
    const timer = { id: this.#nextId++, at: this.#now + Math.max(0, delayMs), run };
    let index = this.#timers.length;
    while (index > 0 && this.#timers[index - 1]!.at > timer.at) index--;
    this.#timers.splice(index, 0, timer);
    return timer.id;
  }

  clearTimeout(id: number): void {
    this.#timers = this.#timers.filter((timer) => timer.id !== id);
  }

  /** Runs every timer due within `ms`, including timers scheduled while advancing. */
  advance(ms = 0): void {
    const target = this.#now + ms;
    for (let timer = this.#timers[0]; timer !== undefined && timer.at <= target; timer = this.#timers[0]) {
      this.#timers.shift();
      this.#now = timer.at;
      timer.run();
    }
    this.#now = target;
  }

  /** Advances until no timers remain (bounded to catch runaway schedules). */
  runAll(limit = 10_000): void {
    for (let i = 0; this.#timers.length > 0; i++) {
      if (i >= limit) throw new Error(`VirtualClock.runAll exceeded ${limit} timers`);
      this.advance(this.#timers[0]!.at - this.#now);
    }
  }

  get pending(): number {
    return this.#timers.length;
  }
}
