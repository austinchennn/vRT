import { cascade, type StreamingSttModel, type TextModel, type TextRequest } from '@vrealtime/cascade';
import type { RealtimeEvent } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { voskStt, type VoskSocket } from '../src/index.js';

const pcm16k = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A vosk-server stand-in: records what is sent and replays what the test says. */
class FakeVosk implements VoskSocket {
  readyState = 0;
  binaryType = 'blob';
  readonly sent: (string | number)[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : data.byteLength);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.#fire('close', {});
  }

  open(): void {
    this.readyState = 1;
    this.#fire('open', {});
  }

  reply(message: object): void {
    this.#fire('message', { data: JSON.stringify(message) });
  }

  fail(): void {
    this.#fire('error', {});
  }

  #fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function setup() {
  const sockets: FakeVosk[] = [];
  const urls: string[] = [];
  const stt = voskStt({ url: 'ws://vosk.test:2700', socket: (url) => { urls.push(url); const s = new FakeVosk(); sockets.push(s); return s; } });
  return { stt, sockets, urls };
}

async function collect(results: AsyncIterable<{ text: string; final: boolean }>) {
  const out: { text: string; final: boolean }[] = [];
  try {
    for await (const r of results) out.push(r);
  } catch (error) {
    return { out, error: error as Error };
  }
  return { out, error: undefined };
}

describe('voskStt', () => {
  it('is a streaming stt the cascade accepts', () => {
    const stt: StreamingSttModel = voskStt({ url: 'ws://x' });
    expect(stt).toMatchObject({ mode: 'stream', sampleRate: 16000 });
  });

  it('sends its config first, holds audio until the socket opens, and ends with the exact eof message', () => {
    const { stt, sockets, urls } = setup();
    const stream = stt.open(pcm16k, { signal: new AbortController().signal });
    const socket = sockets[0]!;
    expect(urls).toEqual(['ws://vosk.test:2700']);
    expect(socket.binaryType).toBe('arraybuffer');
    stream.write(new Uint8Array(640));
    expect(socket.sent).toEqual([]);
    socket.open();
    stream.write(new Uint8Array(320));
    stream.end();
    stream.write(new Uint8Array(320));
    expect(socket.sent).toEqual([JSON.stringify({ config: { sample_rate: 16000, words: 0 } }), 640, 320, '{"eof" : 1}']);
  });

  it('reports the whole utterance each time: finished segments plus the current guess', async () => {
    const { stt, sockets } = setup();
    const stream = stt.open(pcm16k, { signal: new AbortController().signal });
    const socket = sockets[0]!;
    socket.open();
    const results = collect(stream.results);
    socket.reply({ partial: '' });
    socket.reply({ partial: 'turn on' });
    socket.reply({ partial: 'turn on the lights' });
    // A pause: Vosk finishes the segment and starts the next one empty.
    socket.reply({ text: 'turn on the lights' });
    socket.reply({ partial: 'and then said it' });
    socket.reply({ partial: 'and then set a timer' });
    stream.end();
    socket.reply({ partial: 'ignored after the end' });
    socket.reply({ text: 'and then set a timer for ten' });
    const { out, error } = await results;
    expect(error).toBeUndefined();
    expect(out).toEqual([
      { text: '', final: false },
      { text: 'turn on', final: false },
      { text: 'turn on the lights', final: false },
      { text: 'turn on the lights', final: false },
      { text: 'turn on the lights and then said it', final: false },
      { text: 'turn on the lights and then set a timer', final: false },
      { text: 'turn on the lights and then set a timer for ten', final: true },
    ]);
    expect(socket.closed).toBe(true);
  });

  it('fails when the connection drops or errors before the final result', async () => {
    const { stt, sockets } = setup();
    const dropped = stt.open(pcm16k, { signal: new AbortController().signal });
    sockets[0]!.open();
    const a = collect(dropped.results);
    sockets[0]!.close();
    expect((await a).error?.message).toMatch(/closed before the final result/);

    const errored = stt.open(pcm16k, { signal: new AbortController().signal });
    const b = collect(errored.results);
    sockets[1]!.fail();
    expect((await b).error?.message).toMatch(/connection failed/);
  });

  it('closes the connection and ends quietly when the cascade aborts the utterance', async () => {
    const { stt, sockets } = setup();
    const controller = new AbortController();
    const stream = stt.open(pcm16k, { signal: controller.signal });
    sockets[0]!.open();
    const results = collect(stream.results);
    sockets[0]!.reply({ partial: 'hel' });
    controller.abort();
    sockets[0]!.reply({ text: 'hello' });
    const { out, error } = await results;
    expect(error).toBeUndefined();
    expect(out).toEqual([{ text: 'hel', final: false }]);
    expect(sockets[0]!.closed).toBe(true);
  });

  it('drops audio past 10 s while the socket is still connecting', () => {
    const { stt, sockets } = setup();
    const stream = stt.open(pcm16k, { signal: new AbortController().signal });
    for (let i = 0; i < 12; i++) stream.write(new Uint8Array(32000));
    stream.end();
    sockets[0]!.open();
    expect(sockets[0]!.sent.filter((s) => s === 32000)).toHaveLength(10);
    expect(sockets[0]!.sent.at(-1)).toBe('{"eof" : 1}');
  });

  it('drives a cascade turn: guesses are shown, the final one is answered', async () => {
    const { stt, sockets } = setup();
    const requests: TextRequest[] = [];
    const llm: TextModel = { async *stream(request) { requests.push(request); yield { type: 'text', delta: 'Done.' }; } };
    const session = await cascade({ llm, stt }).connect({});
    const transcripts: Extract<RealtimeEvent, { type: 'input.transcript' }>[] = [];
    session.on('input.transcript', (e) => transcripts.push(e));
    session.sendAudio({ data: new Uint8Array(640), format: pcm16k });
    const socket = sockets[0]!;
    socket.open();
    socket.reply({ partial: 'lights' });
    socket.reply({ partial: 'lights on' });
    session.commitAudio();
    socket.reply({ text: 'lights on please' });
    await flush();
    session.respond();
    await flush();
    expect(transcripts.map(({ revision, text, final }) => ({ revision, text, final }))).toEqual([
      { revision: 1, text: 'lights', final: false },
      { revision: 2, text: 'lights on', final: false },
      { revision: 3, text: 'lights on please', final: true },
    ]);
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: 'lights on please' }]);
    await session.close();
  });
});
