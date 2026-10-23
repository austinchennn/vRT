import { defineAgent, startSession, type AgentEvent, type AudioChunk, type RealtimeEvent } from '@vrealtime/core';
import { energyVad } from '@vrealtime/vad';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cascade, type CascadeOptions, type CascadeSession, type SttResult, type SttStream, type StreamingSttModel, type TextModel, type TextRequest } from '../src/index.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pcm16k = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;

function tone(amplitude: number, ms = 20): AudioChunk {
  const n = (16000 * ms) / 1000;
  const data = new Uint8Array(n * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(amplitude * Math.sin(i / 3)), true);
  return { data, format: pcm16k };
}

/** One utterance whose results the test pushes; it ignores its abort signal unless told otherwise. */
class FakeStream implements SttStream {
  readonly written: number[] = [];
  ended = false;
  /** The cascade stopped listening (`return()` on the iterator). */
  released = false;
  readonly signal: AbortSignal;
  readonly #items: (SttResult | Error | 'done')[] = [];
  #wake: (() => void) | undefined;

  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  write(audio: Uint8Array): void {
    this.written.push(audio.byteLength);
  }

  end(): void {
    this.ended = true;
  }

  push(text: string, final = false): void {
    this.#enqueue({ text, final });
  }

  fail(error: Error): void {
    this.#enqueue(error);
  }

  done(): void {
    this.#enqueue('done');
  }

  #enqueue(item: SttResult | Error | 'done'): void {
    this.#items.push(item);
    this.#wake?.();
  }

  readonly results: AsyncIterable<SttResult> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SttResult>> => {
        while (this.#items.length === 0) await new Promise<void>((resolve) => { this.#wake = resolve; });
        this.#wake = undefined;
        const item = this.#items.shift()!;
        if (item === 'done') return { done: true, value: undefined };
        if (item instanceof Error) throw item;
        return { done: false, value: item };
      },
      return: async (): Promise<IteratorResult<SttResult>> => {
        this.released = true;
        return { done: true, value: undefined };
      },
    }),
  };
}

function streamingStt() {
  const streams: FakeStream[] = [];
  const options: { language?: string; vocabulary?: readonly string[] }[] = [];
  const model: StreamingSttModel = {
    mode: 'stream',
    sampleRate: 16000,
    open(_format, { signal, ...rest }) {
      options.push(rest);
      const stream = new FakeStream(signal);
      streams.push(stream);
      return stream;
    },
  };
  return { model, streams, options };
}

function recordingLlm() {
  const requests: TextRequest[] = [];
  const llm: TextModel = {
    async *stream(request) {
      requests.push(structuredClone({ ...request, messages: request.messages }));
      yield { type: 'text', delta: 'Okay.' };
    },
  };
  return { llm, requests };
}

async function connect(options: Partial<CascadeOptions> = {}) {
  const stt = streamingStt();
  const { llm, requests } = recordingLlm();
  const session = (await cascade({ llm, stt: stt.model, ...options }).connect({ inputTranscription: { language: 'en' } })) as CascadeSession;
  const events: RealtimeEvent[] = [];
  for (const type of ['input.transcript', 'error', 'response.start'] as const) session.on(type, (e) => events.push(e));
  const transcripts = () => events.filter((e): e is Extract<RealtimeEvent, { type: 'input.transcript' }> => e.type === 'input.transcript');
  const errors = () => events.filter((e): e is Extract<RealtimeEvent, { type: 'error' }> => e.type === 'error');
  return { session, ...stt, requests, events, transcripts, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('streaming stt', () => {
  it('reports revised guesses as replacements, and only the final one joins the conversation', async () => {
    const { session, streams, options, transcripts } = await connect();
    session.sendAudio(tone(9000));
    session.sendAudio(tone(9000));
    const stream = streams[0]!;
    expect(stream.written).toEqual([640, 640]);
    expect(options[0]).toEqual({ language: 'en' });
    stream.push('what');
    stream.push('what');
    stream.push('what time');
    await flush();
    expect(session.history).toEqual([]);
    session.commitAudio();
    expect(stream.ended).toBe(true);
    stream.push('what time is it', true);
    stream.push('ignored after the final', true);
    await flush();
    expect(transcripts().map(({ revision, text, final }) => ({ revision, text, final }))).toEqual([
      { revision: 1, text: 'what', final: false },
      { revision: 2, text: 'what time', final: false },
      { revision: 3, text: 'what time is it', final: true },
    ]);
    expect(new Set(transcripts().map((t) => t.itemId))).toEqual(new Set(['cascade-user-1']));
    expect(session.history).toEqual([{ role: 'user', content: 'what time is it' }]);
    expect(stream.signal.aborted).toBe(true);
    expect(stream.released).toBe(true);
  });

  it('a guess never starts a reply: with a vad, only the final transcript does', async () => {
    const stt = streamingStt();
    const { llm, requests } = recordingLlm();
    const agent = await startSession(defineAgent({ model: cascade({ llm, stt: stt.model, vad: energyVad({ minSpeechMs: 60, minSilenceMs: 200 }) }), instructions: 'x' }));
    const events: AgentEvent[] = [];
    agent.on('transcript', (e) => events.push(e));
    for (const chunk of [...Array(3).fill(tone(0)), ...Array(10).fill(tone(9000))]) agent.sendAudio(chunk);
    const stream = stt.streams[0]!;
    // The audio from before the vad fired went to the same utterance.
    expect(stream.written.length).toBeGreaterThan(10);
    stream.push('turn on');
    await flush();
    for (const chunk of Array(12).fill(tone(0))) agent.sendAudio(chunk);
    expect(stream.ended).toBe(true);
    await flush();
    expect(requests).toHaveLength(0);
    stream.push('turn on the lights', true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: 'turn on the lights' }]);
    expect(events).toEqual([
      { type: 'transcript', role: 'user', itemId: 'cascade-user-1', text: 'turn on', final: false, revision: 1 },
      { type: 'transcript', role: 'user', itemId: 'cascade-user-1', text: 'turn on the lights', final: true, revision: 2 },
    ]);
    await agent.close();
  });

  it('an utterance with nothing recognised has no transcript; one that showed a guess ends with an empty final', async () => {
    const { session, streams, transcripts } = await connect();
    session.sendAudio(tone(9000));
    session.commitAudio();
    streams[0]!.push('', true);
    session.sendAudio(tone(9000));
    streams[1]!.push('uh');
    session.commitAudio();
    streams[1]!.push('  ', true);
    await flush();
    expect(transcripts().map(({ itemId, revision, text, final }) => ({ itemId, revision, text, final }))).toEqual([
      { itemId: 'cascade-user-2', revision: 1, text: 'uh', final: false },
      { itemId: 'cascade-user-2', revision: 2, text: '', final: true },
    ]);
    expect(session.history).toEqual([]);
  });

  it('a failed transcription is reported, retracts its guess and leaves the session working', async () => {
    const { session, streams, transcripts, errors } = await connect();
    session.sendAudio(tone(9000));
    streams[0]!.push('hel');
    session.commitAudio();
    streams[0]!.fail(new Error('stt socket closed'));
    await flush();
    expect(errors()[0]).toMatchObject({ recoverable: true, error: { code: 'transcription', provider: 'cascade', cause: { message: 'stt socket closed' } } });
    expect(transcripts().at(-1)).toMatchObject({ itemId: 'cascade-user-1', text: '', final: true, revision: 2 });
    session.sendAudio(tone(9000));
    session.commitAudio();
    streams[1]!.push('hello', true);
    await flush();
    expect(session.history).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('a stream that ends without a final result counts as failed', async () => {
    const { session, streams, errors } = await connect();
    session.sendAudio(tone(9000));
    session.commitAudio();
    streams[0]!.push('half');
    streams[0]!.done();
    await flush();
    expect(errors()[0]!.error.message).toMatch(/without a final result/);
    expect(session.history).toEqual([]);
  });

  it('keeps interleaved utterances apart and adds them to the conversation in the order spoken', async () => {
    const { session, streams, transcripts } = await connect();
    session.sendAudio(tone(9000));
    session.commitAudio();
    session.sendAudio(tone(9000));
    session.commitAudio();
    const [first, second] = streams as [FakeStream, FakeStream];
    second.push('second guess');
    second.push('second', true);
    first.push('first guess');
    await flush();
    expect(session.history).toEqual([]);
    first.push('first', true);
    await flush();
    expect(session.history).toEqual([{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }]);
    const of = (itemId: string) => transcripts().filter((t) => t.itemId === itemId).map(({ revision, text, final }) => ({ revision, text, final }));
    expect(of('cascade-user-1')).toEqual([{ revision: 1, text: 'first guess', final: false }, { revision: 2, text: 'first', final: true }]);
    expect(of('cascade-user-2')).toEqual([{ revision: 1, text: 'second guess', final: false }, { revision: 2, text: 'second', final: true }]);
  });

  it('clearAudio drops the utterance being spoken; its late results are ignored', async () => {
    const { session, streams, transcripts } = await connect();
    session.sendAudio(tone(9000));
    streams[0]!.push('never mind');
    await flush();
    session.clearAudio();
    expect(streams[0]!.signal.aborted).toBe(true);
    streams[0]!.push('never mind that', true);
    await flush();
    expect(transcripts().map(({ text, final }) => ({ text, final }))).toEqual([{ text: 'never mind', final: false }, { text: '', final: true }]);
    session.commitAudio();
    await flush();
    expect(session.history).toEqual([]);
  });

  it('drops the oldest utterance past maxUtterances', async () => {
    const { session, streams, errors } = await connect({ streaming: { maxUtterances: 2 } });
    for (let i = 0; i < 3; i++) {
      session.sendAudio(tone(9000));
      session.commitAudio();
    }
    expect(streams.map((s) => s.signal.aborted)).toEqual([true, false, false]);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.error.message).toMatch(/cascade-user-1 dropped/);
    streams[0]!.push('late', true);
    streams[1]!.push('two', true);
    streams[2]!.push('three', true);
    await flush();
    expect(session.history).toEqual([{ role: 'user', content: 'two' }, { role: 'user', content: 'three' }]);
  });

  it('gives up on a final result that never comes, leaving no timer behind', async () => {
    vi.useFakeTimers();
    const { session, streams, errors } = await connect({ streaming: { finalTimeoutMs: 500 } });
    await vi.advanceTimersByTimeAsync(0);
    session.sendAudio(tone(9000));
    session.commitAudio();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(errors()[0]!.error.message).toMatch(/no final transcription of cascade-user-1 within 500 ms/);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // A final in time clears its timer too.
    session.sendAudio(tone(9000));
    session.commitAudio();
    streams[1]!.push('in time', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.history).toEqual([{ role: 'user', content: 'in time' }]);
  });

  it('a slow or silent stt never holds up incoming audio', async () => {
    const { session, streams } = await connect();
    for (let i = 0; i < 200; i++) session.sendAudio(tone(9000));
    expect(streams).toHaveLength(1);
    expect(streams[0]!.written).toHaveLength(200);
  });

  it('drops audio past maxUtteranceMs until the utterance ends, reporting it once', async () => {
    const { session, streams, errors } = await connect({ maxUtteranceMs: 100 });
    for (let i = 0; i < 8; i++) session.sendAudio(tone(9000));
    expect(streams[0]!.written).toHaveLength(5);
    expect(errors()).toHaveLength(1);
    session.commitAudio();
    session.sendAudio(tone(9000));
    expect(streams[1]!.written).toHaveLength(1);
  });

  it('reports a model that cannot open an utterance, and tries again on the next one', async () => {
    let calls = 0;
    const stt = streamingStt();
    const model: StreamingSttModel = { mode: 'stream', open: (format, options) => (++calls === 1 ? (() => { throw new Error('no capacity'); })() : stt.model.open(format, options)) };
    const { llm } = recordingLlm();
    const session = await cascade({ llm, stt: model }).connect({});
    const errors: unknown[] = [];
    session.on('error', (e) => errors.push(e.error));
    session.sendAudio(tone(9000));
    session.sendAudio(tone(9000));
    session.commitAudio();
    expect(errors).toHaveLength(1);
    session.sendAudio(tone(9000));
    expect(stt.streams).toHaveLength(1);
  });

  it('close stops every utterance and emits nothing more; closing again is harmless', async () => {
    vi.useFakeTimers();
    const { session, streams, events } = await connect();
    session.sendAudio(tone(9000));
    session.commitAudio();
    session.sendAudio(tone(9000));
    streams[1]!.push('still talking');
    await vi.advanceTimersByTimeAsync(0);
    const before = events.length;
    await session.close();
    await session.close();
    expect(streams.every((s) => s.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    streams[0]!.push('late', true);
    streams[1]!.push('late', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(before);
    expect(session.history).toEqual([]);
  });
});
