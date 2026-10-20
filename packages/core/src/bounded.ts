/**
 * Insertion-ordered collections that forget their oldest entries past `limit`.
 * Long-lived sessions keep per-item and per-call memory in these, so it stays
 * bounded however long a session runs. Updating an existing key keeps its place.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly limit: number;
  readonly #onEvict: ((key: K, value: V) => void) | undefined;

  /** `onEvict` runs for every entry dropped to stay within `limit`, not for `delete()` or `clear()`. */
  constructor(limit: number, onEvict?: (key: K, value: V) => void) {
    super();
    this.limit = limit;
    this.#onEvict = onEvict;
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    while (this.size > this.limit) {
      const [oldest, evicted] = this.entries().next().value as [K, V];
      super.delete(oldest);
      this.#onEvict?.(oldest, evicted);
    }
    return this;
  }
}

export class BoundedSet<T> extends Set<T> {
  readonly limit: number;
  readonly #onEvict: ((value: T) => void) | undefined;

  /** `onEvict` runs for every value dropped to stay within `limit`, not for `delete()` or `clear()`. */
  constructor(limit: number, onEvict?: (value: T) => void) {
    super();
    this.limit = limit;
    this.#onEvict = onEvict;
  }

  override add(value: T): this {
    super.add(value);
    while (this.size > this.limit) {
      const oldest = this.values().next().value as T;
      super.delete(oldest);
      this.#onEvict?.(oldest);
    }
    return this;
  }
}
