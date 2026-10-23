/**
 * A Vosk server (https://alphacephei.com/vosk/server) as a streaming cascade stt:
 * `cascade({ stt: voskStt({ url: 'ws://localhost:2700' }), llm, tts })`. It hears each
 * utterance as it is spoken and revises its guess. The shapes match `@vrealtime/cascade`'s
 * `StreamingSttModel` without depending on it.
 */
type Pcm16Rate = 8000 | 16000 | 24000 | 48000;
type Pcm16Format = { encoding: 'pcm16'; sampleRate: Pcm16Rate; channels: 1 };
type SttResult = { text: string; final: boolean };

/** What the adapter needs of a WebSocket; the global `WebSocket` fits. */
export interface VoskSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export interface VoskOptions {
  /** The vosk-server WebSocket endpoint, e.g. `ws://localhost:2700`. */
  url: string;
  /** Rate the audio is sent at; the cascade resamples to it. Default 16 kHz. */
  sampleRate?: Pcm16Rate;
  /** Opens the socket. Default: the global `WebSocket`. */
  socket?: (url: string) => VoskSocket;
}

const OPEN = 1;
/** Audio written before the socket opens is held up to this long, then dropped. */
const PENDING_MS = 10_000;
/** vosk-server compares this message as a string, spacing included. */
const EOF = '{"eof" : 1}';

const join = (parts: readonly string[]) => parts.filter(Boolean).join(' ');

/** Speech to text on a Vosk server: one connection per utterance. */
export function voskStt(options: VoskOptions) {
  const sampleRate = options.sampleRate ?? 16000;
  const connect = options.socket ?? ((url: string) => new WebSocket(url) as unknown as VoskSocket);
  return {
    mode: 'stream' as const,
    sampleRate,
    open(_format: Pcm16Format, call: { signal: AbortSignal; language?: string; vocabulary?: readonly string[] }) {
      const socket = connect(options.url);
      socket.binaryType = 'arraybuffer';
      const queue: (SttResult | Error | null)[] = [];
      let wake: (() => void) | undefined;
      const push = (item: SttResult | Error | null) => {
        queue.push(item);
        wake?.();
      };
      // Vosk finishes a segment at each pause and starts the next one empty:
      // the utterance so far is every finished segment plus the current guess.
      const segments: string[] = [];
      let pending: (string | Uint8Array)[] = [];
      let pendingBytes = 0;
      let ended = false;
      let done = false;
      const finish = (item: SttResult | Error | null) => {
        if (done) return;
        done = true;
        if (item) push(item);
        push(null);
        socket.close();
      };
      const send = (data: string | Uint8Array) => {
        if (done) return;
        if (socket.readyState === OPEN) socket.send(data);
        else if (typeof data === 'string' || pendingBytes + data.byteLength <= (sampleRate * 2 * PENDING_MS) / 1000) {
          pending.push(data);
          pendingBytes += typeof data === 'string' ? 0 : data.byteLength;
        }
      };

      socket.addEventListener('open', () => {
        if (done) return socket.close();
        socket.send(JSON.stringify({ config: { sample_rate: sampleRate, words: 0 } }));
        for (const data of pending) socket.send(data);
        pending = [];
      });
      socket.addEventListener('message', (event) => {
        let message: { partial?: string; text?: string };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        if (typeof message.text === 'string') {
          // After the end of the audio, the next result is the last one.
          if (ended) return finish({ text: join([...segments, message.text]), final: true });
          segments.push(message.text);
          push({ text: join(segments), final: false });
        } else if (typeof message.partial === 'string' && !ended) {
          push({ text: join([...segments, message.partial]), final: false });
        }
      });
      socket.addEventListener('error', () => finish(new Error('vosk: connection failed')));
      socket.addEventListener('close', () => finish(new Error('vosk: connection closed before the final result')));
      call.signal.addEventListener('abort', () => finish(null), { once: true });
      if (call.signal.aborted) finish(null);

      return {
        write(audio: Uint8Array): void {
          if (!ended) send(audio);
        },
        end(): void {
          if (ended) return;
          ended = true;
          send(EOF);
        },
        results: {
          async *[Symbol.asyncIterator](): AsyncGenerator<SttResult> {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
              const item = queue.shift()!;
              if (item === null) return;
              if (item instanceof Error) throw item;
              yield item;
            }
          },
        },
      };
    },
  };
}
