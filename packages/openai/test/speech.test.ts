import { cascade, type SttModel, type TtsModel } from '@vrealtime/cascade';
import { describe, expect, it, vi } from 'vitest';
import { openaiStt, openaiTts, pcm16ToWav } from '../src/index.js';

const pcm16k = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;

function streamOf(...chunks: number[][]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

describe('openai speech', () => {
  it('writes a valid mono PCM16 WAV header', () => {
    const wav = pcm16ToWav(new Uint8Array(8), 16000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(52);
  });

  it('transcribes through /audio/transcriptions as WAV', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'hello world' })));
    const stt = openaiStt({ apiKey: 'k', baseURL: 'https://example.test/v1/', fetch: fetchImpl as unknown as typeof fetch, language: 'en' });
    const text = await stt.transcribe(new Uint8Array(320), pcm16k, { signal: new AbortController().signal });
    expect(text).toBe('hello world');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/audio/transcriptions');
    expect(init.headers).toEqual({ Authorization: 'Bearer k' });
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-transcribe');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBeNull();
    await stt.transcribe(new Uint8Array(320), pcm16k, { signal: new AbortController().signal, vocabulary: ['vdoc', 'TipTap'] });
    expect((fetchImpl.mock.calls[1]![1].body as FormData).get('prompt')).toBe('vdoc, TipTap');
    expect((form.get('file') as File).size).toBe(364);
  });

  it('streams /audio/speech PCM and keeps samples aligned across chunks', async () => {
    const fetchImpl = vi.fn(async () => new Response(streamOf([1, 2, 3], [4, 5], [6])));
    const tts = openaiTts({ apiKey: 'k', fetch: fetchImpl as unknown as typeof fetch, instructions: 'calm' });
    const chunks: number[][] = [];
    for await (const chunk of tts.synthesize('Hi.', { voice: 'coral', signal: new AbortController().signal })) chunks.push(Array.from(chunk));
    expect(chunks).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hi.', voice: 'coral', response_format: 'pcm', instructions: 'calm' });
    expect(tts.format).toEqual({ encoding: 'pcm16', sampleRate: 24000, channels: 1 });
  });

  it('reports HTTP failures', async () => {
    const tts = openaiTts({ apiKey: 'k', fetch: (async () => new Response('bad voice', { status: 400 })) as unknown as typeof fetch });
    await expect(tts.synthesize('x', { signal: new AbortController().signal }).next()).rejects.toThrow('speech failed (HTTP 400): bad voice');
  });

  it('fits cascade as stt and tts', () => {
    const stt: SttModel = openaiStt({ apiKey: 'k' });
    const tts: TtsModel = openaiTts({ apiKey: 'k' });
    expect(cascade({ stt, tts, llm: { stream: async function* () {} } }).capabilities.output.audio).toBe(true);
  });
});
