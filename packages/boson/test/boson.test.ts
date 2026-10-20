import type { RealtimeError, RealtimeEvent, RealtimeSession } from '@vrealtime/core';
import { fromBase64, isRealtimeError, toBase64 } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { BOSON_REALTIME_URL, boson, type ProviderSocket } from '../src/index.js';
import { TRANSCRIPT_MEMORY, MAX_APPEND_BYTES } from '@vrealtime/openai-compatible';

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class MockSocket implements ProviderSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  closedWith: [number | undefined, string | undefined] | undefined;
  #listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
    this.readyState = 3;
    this.#fire('close', { code: code ?? 1000, reason: reason ?? '' });
  }
  open() {
    this.readyState = 1;
    this.#fire('open', {});
  }
  server(message: Record<string, unknown>) {
    this.#fire('message', { data: JSON.stringify(message) });
  }
  drop(code: number, reason: string) {
    this.readyState = 3;
    this.#fire('close', { code, reason });
  }
  sentOf(type: string) {
    return this.sent.filter((m) => m['type'] === type);
  }
  #fire(type: string, event: Parameters<Listener>[0]) {
    for (const listener of this.#listeners[type] ?? []) listener(event);
  }
}

async function connect(options: Parameters<typeof boson>[0] = {}, config: Parameters<ReturnType<typeof boson>['connect']>[0] = {}) {
  let socket!: MockSocket;
  const model = boson({ apiKey: 'sk-test', socket: (url, headers) => (socket = new MockSocket(url, headers)), ...options });
  const pending = model.connect(config);
  socket.open();
  const session = await pending;
  const events: RealtimeEvent[] = [];
  const types: RealtimeEvent['type'][] = ['session.ready', 'input.speech.start', 'input.speech.end', 'input.transcript', 'response.start', 'output.text', 'output.transcript', 'output.audio', 'tool.call.delta', 'tool.call', 'response.end', 'error', 'extension'];
  for (const type of types) session.on(type, (event) => events.push(event));
  return { model, socket, session: session as RealtimeSession, events };
}

const pcm24 = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;

describe('boson connect', () => {
  it('connects with bearer auth and sends session.update with the model and config', async () => {
    const { socket, model } = await connect({ voice: 'v1' }, {
      instructions: 'be nice',
      tools: [{ name: 'paint', description: 'paint it', parameters: { type: 'object' } }],
      turnDetection: 'server',
    });
    expect(socket.url).toBe(BOSON_REALTIME_URL);
    expect(socket.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(model.provider).toBe('boson');
    expect(socket.sent).toEqual([{
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'higgs-realtime',
        instructions: 'be nice',
        tools: [{ type: 'function', name: 'paint', description: 'paint it', parameters: { type: 'object' } }],
        tool_choice: 'auto',
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: { type: 'server_vad' }, transcription: { model: 'higgs-stt-3.1' } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'v1' },
        },
      },
    }]);
  });

  it('defaults to semantic VAD and supports manual turns', async () => {
    expect((await connect()).socket.sent[0]!['session'].audio.input.turn_detection).toEqual({ type: 'semantic_vad' });
    expect((await connect({ turnDetection: null })).socket.sent[0]!['session'].audio.input.turn_detection).toBeNull();
  });

  it('rejects when the socket closes before opening, and on abort', async () => {
    let socket!: MockSocket;
    const model = boson({ apiKey: 'k', socket: (url, headers) => (socket = new MockSocket(url, headers)) });
    const pending = model.connect({});
    socket.drop(4001, 'unauthorized');
    await expect(pending).rejects.toThrow(/closed before open/);
    const controller = new AbortController();
    const aborted = model.connect({}, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(socket.closedWith).toEqual([1000, 'aborted']);
  });

  it('requires an api key', () => {
    const env = (globalThis as any).process.env;
    const saved = env.BOSON_API_KEY;
    delete env.BOSON_API_KEY;
    expect(() => boson()).toThrow(/apiKey/);
    env.BOSON_API_KEY = 'from-env';
    expect(() => boson({ socket: () => new MockSocket('', {}) })).not.toThrow();
    if (saved === undefined) delete env.BOSON_API_KEY;
    else env.BOSON_API_KEY = saved;
  });

  it('declares accurate capabilities', () => {
    const { capabilities } = boson({ apiKey: 'k' });
    expect(capabilities.tools.autoReplyAfterResult).toBe(false);
    expect(capabilities.truncate).toBe(true);
    expect(capabilities.input.formats.map((f) => f.encoding)).toEqual(['pcm16', 'pcm16', 'pcm16', 'pcm16', 'pcmu', 'opus']);
  });
});

describe('boson commands', () => {
  it('maps every session command', async () => {
    const { socket, session } = await connect();
    socket.sent.length = 0;
    session.commitAudio();
    session.clearAudio();
    session.sendText('hello');
    session.respond();
    session.respond({ instructions: 'short', toolChoice: { name: 'paint' } });
    session.cancel();
    session.truncate('item_1', 1234.4);
    session.submitToolResult('call_1', { ok: 1 });
    session.submitToolResult('call_2', 'text', { respond: false });
    await session.update({ instructions: 'new' });
    expect(socket.sent).toEqual([
      { type: 'input_audio_buffer.commit' },
      { type: 'input_audio_buffer.clear' },
      { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
      { type: 'response.create' },
      { type: 'response.create', response: { instructions: 'short', tool_choice: { type: 'function', name: 'paint' } } },
      { type: 'response.cancel' },
      { type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 1234 },
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":1}' } },
      { type: 'response.create' },
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_2', output: 'text' } },
      { type: 'session.update', session: { type: 'realtime', instructions: 'new' } },
    ]);
  });

  it('passes PCM16 and Opus through as base64, splitting appends over 1 MiB', async () => {
    const { socket, session } = await connect({ inputFormat: { encoding: 'opus', frameMs: 20 } });
    socket.sent.length = 0;
    const opus = new Uint8Array([1, 2, 3]);
    session.sendAudio({ data: opus, format: { encoding: 'opus', frameMs: 20 } });
    expect(socket.sent).toEqual([{ type: 'input_audio_buffer.append', audio: toBase64(opus) }]);

    const pcm = await connect();
    pcm.socket.sent.length = 0;
    const big = new Uint8Array(MAX_APPEND_BYTES * 2 + 10).map((_, i) => i & 0xff);
    pcm.session.sendAudio({ data: big, format: pcm24 });
    const appends = pcm.socket.sentOf('input_audio_buffer.append');
    expect(appends).toHaveLength(3);
    for (const append of appends) expect(JSON.stringify(append).length).toBeLessThan(1024 * 1024);
    const joined = appends.flatMap((a) => Array.from(fromBase64(a['audio'])));
    expect(joined).toEqual(Array.from(big));
  });

  it('resamples PCM16 rate mismatches and reports unconvertible formats', async () => {
    const { socket, session, events } = await connect();
    socket.sent.length = 0;
    session.sendAudio({ data: new Uint8Array(960), format: { encoding: 'pcm16', sampleRate: 48000, channels: 1 } });
    expect(fromBase64(socket.sent[0]!['audio']).byteLength).toBe(480);
    session.sendAudio({ data: new Uint8Array(10), format: { encoding: 'pcmu' } });
    expect(events.at(-1)).toMatchObject({ type: 'error', recoverable: true });
  });
});

describe('boson events', () => {
  it('normalizes a full response with audio, transcripts and a tool call', async () => {
    const { socket, events } = await connect();
    const audio = new Uint8Array(960).fill(1);
    // Boson's real order, per the recorded session in boson-ai/higgs-realtime-tutorial
    // (test/fixtures/three-turn.json): no event on connect, `session.created` acks the
    // first session.update, the user transcript lands after response.created and twice.
    const part = { response_id: 'resp_1', item_id: 'a1', output_index: 0, content_index: 0 };
    const call = { type: 'function_call', id: 'f1', call_id: 'call_1', name: 'paint' };
    const fixtures = [
      { type: 'session.created', session: { id: 'sess_1', object: 'realtime.session', model: 'higgs-realtime' } },
      { type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 100 },
      { type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 900 },
      { type: 'input_audio_buffer.committed', previous_item_id: null, item_id: 'u1' },
      { type: 'conversation.item.added', previous_item_id: null, item: { id: 'u1', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', audio: '' }] } },
      { type: 'response.created', response: { id: 'resp_1', object: 'realtime.response', status: 'in_progress', output: [], usage: null, metadata: null } },
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', content_index: 0, transcript: 'make it red' },
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', content_index: 0, transcript: 'make it red' },
      { type: 'response.output_item.added', response_id: 'resp_1', output_index: 0, item: { id: 'a1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'conversation.item.added', previous_item_id: 'u1', item: { id: 'a1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', ...part, part: { type: 'audio', audio: null, transcript: '' } },
      { type: 'response.output_audio_transcript.delta', ...part, delta: 'Sure' },
      { type: 'response.output_audio.delta', ...part, delta: toBase64(audio) },
      // Undocumented extension in the recording; must be tolerated.
      { type: 'response.output_audio_transcript.length', ...part, delta: 'Sure', length_ms: 20 },
      { type: 'response.output_audio_transcript.done', ...part, transcript: 'Sure' },
      { type: 'response.output_audio.done', ...part },
      { type: 'response.content_part.done', ...part, part: { type: 'audio', audio: null, transcript: 'Sure' } },
      { type: 'response.output_item.done', response_id: 'resp_1', output_index: 0, item: { id: 'a1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'audio', transcript: 'Sure' }] } },
      { type: 'response.output_item.added', response_id: 'resp_1', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', response_id: 'resp_1', item_id: 'f1', output_index: 1, call_id: 'call_1', delta: '{"color"' },
      { type: 'response.function_call_arguments.done', response_id: 'resp_1', item_id: 'f1', output_index: 1, call_id: 'call_1', name: 'paint', arguments: '{"color":"red"}' },
      { type: 'response.output_item.done', response_id: 'resp_1', output_index: 1, item: { ...call, arguments: '{"color":"red"}', status: 'completed' } },
      {
        type: 'response.done',
        response: {
          id: 'resp_1', object: 'realtime.response', status: 'completed', status_details: null, output: [], metadata: null,
          usage: { total_tokens: 100, input_tokens: 84, output_tokens: 16, input_token_details: { cached_tokens: 0 } },
        },
      },
    ];
    for (const fixture of fixtures) socket.server(fixture);
    expect(events).toEqual([
      { type: 'session.ready', sessionId: 'sess_1' },
      { type: 'input.speech.start', atMs: 100 },
      { type: 'input.speech.end', atMs: 900 },
      { type: 'response.start', responseId: 'resp_1' },
      { type: 'input.transcript', itemId: 'u1', text: 'make it red', final: true },
      { type: 'output.transcript', responseId: 'resp_1', itemId: 'a1', delta: 'Sure' },
      { type: 'output.audio', responseId: 'resp_1', itemId: 'a1', chunk: { data: audio, format: pcm24, durationMs: 20 } },
      { type: 'tool.call.delta', responseId: 'resp_1', callId: 'call_1', name: 'paint', argumentsDelta: '{"color"' },
      { type: 'tool.call', responseId: 'resp_1', callId: 'call_1', name: 'paint', arguments: { color: 'red' } },
      { type: 'response.end', responseId: 'resp_1', status: 'done', usage: { inputTokens: 84, outputTokens: 16, cachedInputTokens: 0 } },
    ]);
  });

  it('emits session.ready once, on the session.created ack of the first session.update', async () => {
    const { socket, session, events } = await connect();
    expect(socket.sentOf('session.update')).toHaveLength(1);
    expect(events).toEqual([]);
    socket.server({ type: 'session.created', session: { id: 'sess_b', object: 'realtime.session' } });
    expect(events).toEqual([{ type: 'session.ready', sessionId: 'sess_b' }]);
    // Later updates are acked with session.updated and must not re-announce readiness.
    await session.update({ instructions: 'later' });
    socket.server({ type: 'session.updated', session: { id: 'sess_b', object: 'realtime.session' } });
    expect(events).toHaveLength(1);
  });

  it('emits one final transcript per user item although Boson repeats completed', async () => {
    const { socket, events } = await connect();
    const completed = (itemId: string, transcript: string) =>
      socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript });
    completed('u1', 'Hi. My name is Sam.');
    completed('u1', 'Hi. My name is Sam.');
    completed('u2', 'What is my name?');
    completed('u2', 'What is my name?');
    expect(events).toEqual([
      { type: 'input.transcript', itemId: 'u1', text: 'Hi. My name is Sam.', final: true },
      { type: 'input.transcript', itemId: 'u2', text: 'What is my name?', final: true },
    ]);
    // Memory is bounded: only the most recent items are remembered.
    for (let i = 0; i < TRANSCRIPT_MEMORY; i++) completed(`x${i}`, 'x');
    events.length = 0;
    completed('u1', 'evicted');
    completed(`x${TRANSCRIPT_MEMORY - 1}`, 'x');
    expect(events).toEqual([{ type: 'input.transcript', itemId: 'u1', text: 'evicted', final: true }]);
  });

  it('maps Boson close codes to provider-neutral error codes', async () => {
    const closeError = async (code: number, ...before: Record<string, unknown>[]) => {
      const { socket, events } = await connect();
      for (const message of before) socket.server(message);
      socket.drop(code, '');
      const last = events.at(-1);
      expect(last).toMatchObject({ type: 'error', recoverable: false });
      const error = (last as { error: Error }).error;
      expect(isRealtimeError(error)).toBe(true);
      const { message, code: errorCode, retryable, provider, providerCode } = error as RealtimeError;
      return { message, code: errorCode, retryable, provider, providerCode };
    };
    expect(await closeError(1013)).toMatchObject({ code: 'overloaded', retryable: true, provider: 'boson', providerCode: '1013' });
    expect(await closeError(3000)).toMatchObject({ code: 'auth', retryable: false, providerCode: '3000' });
    const quota = { type: 'error', error: { type: 'insufficient_quota', code: null, message: 'Spending cap reached', param: null } };
    expect(await closeError(4429, quota)).toEqual({
      code: 'quota',
      retryable: false,
      provider: 'boson',
      providerCode: '4429',
      message: 'boson connection closed (4429): Spending cap reached',
    });
    expect(await closeError(1000, { type: 'session.idle_timeout', seconds_idle: 300 })).toMatchObject({
      code: 'session_limit',
      retryable: true,
      message: 'boson connection closed (1000): session.idle_timeout',
    });
    expect(await closeError(1000, { type: 'session.max_duration_reached', max_duration_sec: 3600 }, { type: 'response.done', response: { id: 'r', status: 'cancelled' } }))
      .toMatchObject({ code: 'session_limit', message: expect.stringContaining('session.max_duration_reached') });
    expect(await closeError(1000)).toEqual({ code: 'connection', retryable: true, provider: 'boson', providerCode: '1000', message: 'boson connection closed (1000)' });
  });

  it('maps a handshake the provider refuses by its close code', async () => {
    let socket!: MockSocket;
    const model = boson({ apiKey: 'k', socket: (url, headers) => (socket = new MockSocket(url, headers)) });
    const pending = model.connect({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.drop(3000, 'invalid key');
    await expect(pending).rejects.toMatchObject({ name: 'RealtimeError', code: 'auth', providerCode: '3000' });
  });

  it('maps error events by type and keeps the provider code and payload', async () => {
    const { socket, events } = await connect();
    const raw = (type: string, code: string | null) => ({ type: 'error', error: { type, code, message: `${type} message`, param: null } });
    socket.server(raw('insufficient_quota', 'monthly_cap_reached'));
    socket.server(raw('rate_limit_error', null));
    socket.server(raw('voice_output_task_ongoing', null));
    socket.server(raw('something_new', null));
    const errors = events.map((e) => (e as Extract<RealtimeEvent, { type: 'error' }>).error as RealtimeError);
    expect(errors.map((e) => [e.code, e.providerCode])).toEqual([
      ['quota', 'monthly_cap_reached'],
      ['rate_limited', 'rate_limit_error'],
      ['invalid_request', 'voice_output_task_ongoing'],
      ['provider', 'something_new'],
    ]);
    expect(errors[0]!.cause).toEqual(raw('insufficient_quota', 'monthly_cap_reached').error);
  });

  it('maps text-only responses', async () => {
    const { socket, events } = await connect();
    socket.server({ type: 'response.created', response: { id: 'resp_t', status: 'in_progress' } });
    socket.server({ type: 'response.output_text.delta', response_id: 'resp_t', item_id: 't1', output_index: 0, content_index: 0, delta: 'Hello' });
    socket.server({ type: 'response.output_text.done', response_id: 'resp_t', output_index: 0, content_index: 0, text: 'Hello' });
    socket.server({ type: 'response.done', response: { id: 'resp_t', status: 'completed' } });
    expect(events).toEqual([
      { type: 'response.start', responseId: 'resp_t' },
      { type: 'output.text', responseId: 'resp_t', delta: 'Hello' },
      { type: 'response.end', responseId: 'resp_t', status: 'done' },
    ]);
  });

  it('maps response statuses', async () => {
    const { socket, events } = await connect();
    socket.server({ type: 'response.done', response: { id: 'a', status: 'cancelled', status_details: { reason: 'turn_detected' } } });
    socket.server({ type: 'response.done', response: { id: 'b', status: 'cancelled', status_details: { reason: 'client_cancelled' } } });
    socket.server({ type: 'response.done', response: { id: 'c', status: 'failed' } });
    socket.server({ type: 'response.done', response: { id: 'd', status: 'incomplete' } });
    expect(events.map((e) => (e as { status?: string }).status)).toEqual(['interrupted', 'cancelled', 'failed', 'done']);
  });

  it('keeps malformed tool arguments as the raw string', async () => {
    const { socket, events } = await connect();
    socket.server({ type: 'response.function_call_arguments.done', response_id: 'r', call_id: 'c', name: 'x', arguments: '{bad' });
    expect(events[0]).toMatchObject({ type: 'tool.call', arguments: '{bad' });
  });

  it('surfaces errors with the right recoverable flag', async () => {
    const { socket, events, session } = await connect();
    socket.server({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'no response' } });
    expect(events[0]).toMatchObject({ type: 'error', recoverable: true, error: { message: 'no response', code: 'invalid_request', providerCode: 'response_cancel_not_active' } });
    socket.server('not json' as never);
    socket.drop(1011, 'server error');
    expect(events.at(-1)).toMatchObject({ type: 'error', recoverable: false });
    expect((events.at(-1) as { error: Error }).error.message).toContain('1011');
    const count = events.length;
    await session.close();
    expect(events).toHaveLength(count);
  });

  it('surfaces Boson extension events without breaking the stream', async () => {
    const { socket, events } = await connect();
    socket.server({ type: 'conversation.context.summarized', summary: 's' });
    socket.server({ type: 'session.idle_timeout' });
    socket.server({ type: 'session.max_duration_reached' });
    socket.server({ type: 'response.created', response: { id: 'r' } });
    expect(events.map((e) => (e.type === 'extension' ? e.name : e.type))).toEqual([
      'conversation.context.summarized', 'session.idle_timeout', 'session.max_duration_reached', 'response.start',
    ]);
  });

  it('a closed session sends nothing', async () => {
    const { socket, session } = await connect();
    await session.close();
    expect(socket.closedWith).toEqual([1000, 'closed by client']);
    const before = socket.sent.length;
    session.sendText('x');
    session.sendAudio({ data: new Uint8Array(2), format: pcm24 });
    expect(socket.sent).toHaveLength(before);
  });
});
