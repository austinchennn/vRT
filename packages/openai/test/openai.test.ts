import type { RealtimeEvent } from '@vrealtime/core';
import { toBase64 } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { OPENAI_CAPABILITIES, openai, type ProviderSocket } from '../src/index.js';

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class MockSocket implements ProviderSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  #listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    for (const l of this.#listeners['open'] ?? []) l({});
  }
  server(message: Record<string, unknown>) {
    for (const l of this.#listeners['message'] ?? []) l({ data: JSON.stringify(message) });
  }
}

async function connect(options: Parameters<typeof openai>[0] = {}) {
  let socket!: MockSocket;
  const model = openai({ apiKey: 'sk-openai', socket: (url, headers) => (socket = new MockSocket(url, headers)), ...options });
  const pending = model.connect({ instructions: 'hi', voice: 'marin' });
  socket.open();
  const session = await pending;
  const events: RealtimeEvent[] = [];
  for (const type of ['session.ready', 'response.start', 'output.audio', 'tool.call', 'response.end', 'input.speech.start'] as const) session.on(type, (e) => events.push(e));
  return { model, socket, session, events };
}

describe('openai', () => {
  it('connects with the model in the URL, bearer auth and a GA session.update', async () => {
    const { socket, model } = await connect({ transcription: { language: 'en' } });
    expect(model.provider).toBe('openai');
    expect(model.id).toBe('gpt-realtime-2');
    expect(socket.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2');
    expect(socket.headers).toEqual({ Authorization: 'Bearer sk-openai' });
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2',
        instructions: 'hi',
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: { type: 'semantic_vad' }, transcription: { model: 'gpt-4o-transcribe', language: 'en' } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
        },
      },
    });
  });

  it('supports a custom model, transcription model, G.711 µ-law and manual turns', async () => {
    const { socket } = await connect({ model: 'gpt-realtime-mini', transcriptionModel: 'whisper-1', inputFormat: { encoding: 'pcmu' }, outputFormat: { encoding: 'pcmu' }, turnDetection: null });
    expect(socket.url).toContain('model=gpt-realtime-mini');
    expect(socket.sent[0]!['session'].audio).toMatchObject({
      input: { format: { type: 'audio/pcmu' }, turn_detection: null, transcription: { model: 'whisper-1' } },
      output: { format: { type: 'audio/pcmu' } },
    });
  });

  it('normalizes GA events like every OpenAI-compatible adapter', async () => {
    const { socket, events } = await connect();
    socket.server({ type: 'session.created', session: { id: 'sess_o' } });
    socket.server({ type: 'session.updated', session: { id: 'sess_o' } });
    socket.server({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10 });
    socket.server({ type: 'response.created', response: { id: 'resp_1' } });
    socket.server({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'a', delta: toBase64(new Uint8Array(480)) });
    socket.server({ type: 'response.function_call_arguments.done', response_id: 'resp_1', call_id: 'c', name: 'x', arguments: '{"a":1}' });
    socket.server({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled', status_details: { reason: 'turn_detected' } } });
    expect(events.map((e) => e.type)).toEqual(['session.ready', 'input.speech.start', 'response.start', 'output.audio', 'tool.call', 'response.end']);
    expect(events.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(events[3]).toMatchObject({ chunk: { durationMs: 10 } });
  });

  it('declares no Opus and no auto-reply after tool results', () => {
    expect(OPENAI_CAPABILITIES.input.formats.some((f) => f.encoding === 'opus')).toBe(false);
    expect(OPENAI_CAPABILITIES.tools.autoReplyAfterResult).toBe(false);
  });

  it('requires an api key', () => {
    const env = (globalThis as any).process.env;
    const saved = env.OPENAI_API_KEY;
    delete env.OPENAI_API_KEY;
    expect(() => openai()).toThrow(/OPENAI_API_KEY/);
    if (saved !== undefined) env.OPENAI_API_KEY = saved;
  });
});
