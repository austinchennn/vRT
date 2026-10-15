type Listener = (event: never) => void;

/**
 * Typed, synchronous event emitter for `{ type }` unions. Listener lists are
 * copy-on-write, so `emit` iterates a stable snapshot without allocating and
 * listeners may subscribe or unsubscribe while an event is dispatching.
 */
export class Emitter<E extends { readonly type: string }> {
  #listeners = new Map<string, readonly Listener[]>();
  #onListenerError: (error: unknown) => void;

  /** A throwing listener never stops dispatch; by default its error is rethrown in a microtask. */
  constructor(onListenerError?: (error: unknown) => void) {
    this.#onListenerError = onListenerError ?? ((error) => queueMicrotask(() => { throw error; }));
  }

  on<T extends E['type']>(type: T, listener: (event: Extract<E, { type: T }>) => void): () => void {
    const current = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, [...current, listener as Listener]);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const list = this.#listeners.get(type);
      if (!list) return;
      const index = list.indexOf(listener as Listener);
      if (index === -1) return;
      if (list.length === 1) this.#listeners.delete(type);
      else this.#listeners.set(type, [...list.slice(0, index), ...list.slice(index + 1)]);
    };
  }

  emit(event: E): void {
    const list = this.#listeners.get(event.type);
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) {
      try {
        (list[i] as (event: E) => void)(event);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }

  has(type: E['type']): boolean {
    return this.#listeners.has(type);
  }

  clear(): void {
    this.#listeners.clear();
  }
}
