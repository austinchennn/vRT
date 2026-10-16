/** Minimal typed emitter; the client depends only on the protocol package. */
export class Emitter<E extends { type: string }> {
  #listeners = new Map<string, ((event: never) => void)[]>();

  on<T extends E['type']>(type: T, listener: (event: Extract<E, { type: T }>) => void): () => void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener as (event: never) => void]);
    return () => {
      const list = this.#listeners.get(type) ?? [];
      this.#listeners.set(type, list.filter((l) => l !== listener));
    };
  }

  emit(event: E): void {
    for (const listener of this.#listeners.get(event.type) ?? []) {
      try {
        (listener as (event: E) => void)(event);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }
}
