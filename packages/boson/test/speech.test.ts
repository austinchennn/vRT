import type { TtsModel } from '@vrealtime/cascade';
import { describe, expect, it, vi } from 'vitest';
import { bosonTts } from '../src/index.js';

function streamOf(...chunks: number[][]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

async function all(iterable: AsyncIterable<Uint8Array>) {
  const out: number[][] = [];
  for await (const chunk of iterable) out.push(Array.from(chunk));
  return out;
}

describe('bosonTts', () => {
  it('is a cascade TtsModel of 24 kHz PCM16', () => {
    const tts: TtsModel = bosonTts({ apiKey: 'k' });
    expect(tts.format).toEqual({ encoding: 'pcm16', sampleRate: 24000, channels: 1 });
  });

  it('streams /audio/speech as PCM, keeping samples whole across network chunks', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(streamOf([1, 2, 3], [4], [5, 6, 7, 8])));
    const tts = bosonTts({ apiKey: 'k', baseURL: 'https://example.test/v1/', voice: 'narrator', fetch: fetchImpl as unknown as typeof fetch });
    expect(await all(tts.synthesize('Hello.', { signal: new AbortController().signal }))).toEqual([[1, 2], [3, 4], [5, 6, 7, 8]]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/audio/speech');
    expect(init.headers).toEqual({ Authorization: 'Bearer k', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ model: 'higgs-tts-3', input: 'Hello.', voice: 'narrator', response_format: 'pcm', stream: true });
    await all(tts.synthesize('Hi.', { signal: new AbortController().signal, voice: 'session-voice' }));
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body as string)).toMatchObject({ voice: 'session-voice' });
  });

  it('reports a refused request with its status and message', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'input_too_long' } }), { status: 400 });
    const tts = bosonTts({ apiKey: 'k', fetch: fetchImpl as unknown as typeof fetch });
    await expect(all(tts.synthesize('x', { signal: new AbortController().signal }))).rejects.toThrow(/HTTP 400.*input_too_long/);
  });

  it('needs a key', () => {
    vi.stubEnv('BOSON_API_KEY', '');
    expect(() => bosonTts()).toThrow(/missing apiKey/);
    vi.unstubAllEnvs();
  });
});
