/** Monotonic absolute deadlines; successful operations cancel their timers. */
export async function until<T>(operation: Promise<T>, end: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${stage}`)), Math.max(0, end - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A process/peer may fail before a consumer starts waiting.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
