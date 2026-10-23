import { RealtimeError, type AudioFormat, type Pcm16Rate } from '@vrealtime/core';

export type Pcm16Format = Extract<AudioFormat, { encoding: 'pcm16' }>;

export interface SttOptions {
  signal: AbortSignal;
  language?: string;
  vocabulary?: readonly string[];
}

/** Speech to text for one utterance, once all of it has been heard. */
export interface SttModel {
  /** Preferred input rate; audio is resampled to it. Default 16 kHz. */
  readonly sampleRate?: Pcm16Rate;
  transcribe(audio: Uint8Array, format: Pcm16Format, options: SttOptions): Promise<string>;
}

/**
 * Speech to text that hears an utterance as it is spoken and revises its guess.
 * Chosen with `mode: 'stream'`; a model without it is a batch `SttModel`.
 */
export interface StreamingSttModel {
  readonly mode: 'stream';
  /** Preferred input rate; audio is resampled to it. Default 16 kHz. */
  readonly sampleRate?: Pcm16Rate;
  /** Opens one utterance. `options.signal` aborts when the cascade is done with it, for whatever reason. */
  open(format: Pcm16Format, options: SttOptions): SttStream;
}

/** One utterance being transcribed. */
export interface SttStream {
  /** Audio of the utterance, in order. Must return at once: buffer or drop, never block. */
  write(audio: Uint8Array): void;
  /** No more audio is coming: produce the final result. */
  end(): void;
  /**
   * Hypotheses for the whole utterance so far, each replacing the one before,
   * ending with one that is `final`. Anything after the final one is ignored.
   */
  readonly results: AsyncIterable<SttResult>;
}

export interface SttResult {
  text: string;
  final: boolean;
}

export interface StreamingLimits {
  /** Utterances transcribed at once, the one being spoken included; the oldest is dropped past it. Default 4. */
  maxUtterances?: number;
  /** How long to wait for the final result once an utterance ends. Default 10 s. */
  finalTimeoutMs?: number;
}

/** A transcription the cascade reports: `revision` grows by one per update of `itemId`. */
export interface TranscriptionUpdate {
  itemId: string;
  revision: number;
  text: string;
  final: boolean;
}

interface Utterance {
  itemId: string;
  stream: SttStream;
  controller: AbortController;
  revision: number;
  text: string;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (text: string | undefined) => void;
  final: Promise<string | undefined>;
}

/** A failure of the stt model itself; a RealtimeError it throws keeps its code. */
const failed = (cause: unknown) => RealtimeError.from(cause, 'transcription', { provider: 'cascade' });
const dropped = (message: string) => new RealtimeError('transcription', `cascade: ${message}`, { provider: 'cascade' });

/**
 * Streamed utterances of one cascade session. Each has its own cancel scope; its
 * updates are numbered here, in the order the model reports them. Once an utterance
 * has shown text it always ends with a final update, empty when it was dropped or
 * failed, so nothing is left showing a guess that will never be confirmed.
 */
export class StreamingTranscription {
  readonly #model: StreamingSttModel;
  readonly #format: Pcm16Format;
  readonly #maxUtterances: number;
  readonly #finalTimeoutMs: number;
  readonly #onUpdate: (update: TranscriptionUpdate) => void;
  readonly #onError: (error: RealtimeError) => void;
  /** Oldest first; the last one may still be receiving audio. */
  readonly #utterances = new Map<string, Utterance>();
  #open: Utterance | undefined;

  constructor(
    model: StreamingSttModel,
    format: Pcm16Format,
    limits: StreamingLimits,
    onUpdate: (update: TranscriptionUpdate) => void,
    onError: (error: RealtimeError) => void,
  ) {
    this.#model = model;
    this.#format = format;
    this.#maxUtterances = Math.max(1, limits.maxUtterances ?? 4);
    this.#finalTimeoutMs = limits.finalTimeoutMs ?? 10_000;
    this.#onUpdate = onUpdate;
    this.#onError = onError;
  }

  /** True while an utterance is receiving audio. */
  get receiving(): boolean {
    return this.#open !== undefined;
  }

  /** Utterances not settled yet. */
  get size(): number {
    return this.#utterances.size;
  }

  open(itemId: string, options: Omit<SttOptions, 'signal'>, lifetime: AbortSignal): void {
    if (this.#open) this.discard();
    const controller = new AbortController();
    let resolve!: (text: string | undefined) => void;
    const final = new Promise<string | undefined>((r) => { resolve = r; });
    let stream: SttStream;
    try {
      stream = this.#model.open(this.#format, { ...options, signal: AbortSignal.any([lifetime, controller.signal]) });
    } catch (error) {
      this.#onError(failed(error));
      return;
    }
    const utterance: Utterance = { itemId, stream, controller, revision: 0, text: '', settled: false, timer: undefined, resolve, final };
    this.#utterances.set(itemId, utterance);
    this.#open = utterance;
    while (this.#utterances.size > this.#maxUtterances) {
      const oldest = this.#utterances.values().next().value!;
      this.#fail(oldest, dropped(`transcription of ${oldest.itemId} dropped, more than ${this.#maxUtterances} utterances at once`));
    }
    void this.#consume(utterance);
  }

  write(audio: Uint8Array): void {
    const utterance = this.#open;
    if (!utterance) return;
    try {
      utterance.stream.write(audio);
    } catch (error) {
      this.#fail(utterance, failed(error));
    }
  }

  /** Ends the utterance receiving audio; resolves to its final text, or undefined when it has none. */
  end(): Promise<string | undefined> | undefined {
    const utterance = this.#open;
    if (!utterance) return undefined;
    this.#open = undefined;
    try {
      utterance.stream.end();
    } catch (error) {
      this.#fail(utterance, failed(error));
      return utterance.final;
    }
    if (!utterance.settled) {
      utterance.timer = setTimeout(() => this.#fail(utterance, dropped(`no final transcription of ${utterance.itemId} within ${this.#finalTimeoutMs} ms`)), this.#finalTimeoutMs);
    }
    return utterance.final;
  }

  /** Drops the utterance receiving audio, as when the input buffer is cleared. */
  discard(): void {
    const utterance = this.#open;
    if (utterance) this.#settle(utterance, undefined, true);
  }

  /** Stops everything, silently: the session is gone. */
  close(): void {
    for (const utterance of [...this.#utterances.values()]) this.#settle(utterance, undefined, false);
  }

  async #consume(utterance: Utterance): Promise<void> {
    try {
      for await (const result of utterance.stream.results) {
        if (utterance.settled) return;
        this.#accept(utterance, result);
        if (utterance.settled) return;
      }
      if (!utterance.settled) this.#fail(utterance, dropped(`transcription of ${utterance.itemId} ended without a final result`));
    } catch (error) {
      if (!utterance.settled) this.#fail(utterance, failed(error));
    }
  }

  #accept(utterance: Utterance, result: SttResult): void {
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (result.final) {
      // Nothing heard and nothing shown: like a batch model returning '', there is no transcript.
      if (text || utterance.revision > 0) this.#onUpdate({ itemId: utterance.itemId, revision: ++utterance.revision, text, final: true });
      this.#settle(utterance, text, false);
      return;
    }
    if (text === utterance.text) return;
    utterance.text = text;
    this.#onUpdate({ itemId: utterance.itemId, revision: ++utterance.revision, text, final: false });
  }

  #fail(utterance: Utterance, error: RealtimeError): void {
    if (utterance.settled) return;
    this.#onError(error);
    this.#settle(utterance, undefined, true);
  }

  /** `retract`: an utterance that showed text ends with an empty final update. */
  #settle(utterance: Utterance, text: string | undefined, retract: boolean): void {
    if (utterance.settled) return;
    utterance.settled = true;
    clearTimeout(utterance.timer);
    this.#utterances.delete(utterance.itemId);
    if (this.#open === utterance) this.#open = undefined;
    // Releases the model's resources; a model that ignores it is still not listened to.
    utterance.controller.abort();
    if (retract && utterance.revision > 0) this.#onUpdate({ itemId: utterance.itemId, revision: ++utterance.revision, text: '', final: true });
    utterance.resolve(text);
  }
}
