/**
 * Provider-neutral error categories. Adapters map their provider's error types and
 * close codes onto these, so an app handles "out of credits" or "try again later"
 * the same way on every model; the provider's own code stays in `providerCode`.
 */
export type RealtimeErrorCode =
  /** Credentials missing, invalid or expired. */
  | 'auth'
  /** Billing refused: credits exhausted, a spending cap reached, a contract ended. */
  | 'quota'
  /** Too many requests; retry with backoff. */
  | 'rate_limited'
  /** The provider is at capacity, e.g. concurrent sessions; retry later. */
  | 'overloaded'
  /** The provider rejected a request or the session config. */
  | 'invalid_request'
  /** A limit the provider enforces ended the session: idle timeout, maximum duration. */
  | 'session_limit'
  /** The connection to the provider dropped unexpectedly. */
  | 'connection'
  /** Transcribing the user's speech failed; the conversation goes on. */
  | 'transcription'
  /** Input the model cannot take, e.g. an audio format it cannot convert. */
  | 'unsupported'
  /** Anything else the provider reported. */
  | 'provider';

const RETRYABLE: ReadonlySet<RealtimeErrorCode> = new Set(['rate_limited', 'overloaded', 'session_limit', 'connection', 'provider']);

export interface RealtimeErrorOptions {
  provider?: string | undefined;
  /** The provider's own code, e.g. `insufficient_quota`, or a close code such as `4429`. */
  providerCode?: string | undefined;
  /** Overrides the default for `code`. */
  retryable?: boolean | undefined;
  /** The underlying error, or the provider's raw payload. */
  cause?: unknown;
}

/**
 * An error from a realtime model. `retryable` says whether trying again unchanged
 * (a new request, a reconnect) can succeed; the `recoverable` flag of the `error`
 * event says whether the current session goes on.
 */
export class RealtimeError extends Error {
  override name = 'RealtimeError';
  readonly code: RealtimeErrorCode;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly providerCode: string | undefined;

  constructor(code: RealtimeErrorCode, message: string, options: RealtimeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.provider = options.provider;
    this.providerCode = options.providerCode;
  }

  /** `error` itself when it already is a `RealtimeError`; otherwise a `code` error that keeps `error` as its cause. */
  static from(error: unknown, code: RealtimeErrorCode, options: Omit<RealtimeErrorOptions, 'cause'> = {}): RealtimeError {
    if (isRealtimeError(error)) return error;
    return new RealtimeError(code, error instanceof Error ? error.message : String(error), { ...options, cause: error });
  }
}

/** True for a `RealtimeError`, including one from another copy of `@vrealtime/core`. */
export function isRealtimeError(error: unknown): error is RealtimeError {
  return error instanceof Error && error.name === 'RealtimeError' && typeof (error as { code?: unknown }).code === 'string';
}
