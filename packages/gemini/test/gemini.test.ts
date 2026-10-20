import { defineAgent, fromBase64, startSession, toBase64, tool, type AgentEvent, type RealtimeEvent, type Tool } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { GEMINI_CAPABILITIES, GEMINI_LIVE_URL, gemini, type ProviderSocket } from '../src/index.js';

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class MockSocket implements ProviderSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  closedWith: [number | undefined, string | undefined] | undefined;
  #listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    if (this.autoSetup && 'setup' in this.sent.at(-1)!) queueMicrotask(() => this.server({ setupComplete: {} }));
  }
  autoSetup = true;
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
    this.drop(code ?? 1000, reason ?? '');
  }
  drop(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const l of this.#listeners['close'] ?? []) l({ code, reason });
  }
  open() {
    this.readyState = 1;
    for (const l of this.#listeners['open'] ?? []) l({});
  }
  server(message: Record<string, unknown>) {
    for (const l of this.#listeners['message'] ?? []) l({ data: JSON.stringify(message) });
  }
  ofKey(key: string) {
    return this.sent.filter((m) => key in m).map((m) => m[key]);
  }
}

const audioPart = (bytes: number) => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: toBase64(new Uint8Array(bytes)) } });

async function connect(options: Parameters<typeof gemini>[0] = {}, config: Parameters<ReturnType<typeof gemini>['connect']>[0] = {}) {
  let socket!: MockSocket;
  const model = gemini({ apiKey: 'g-key', socket: (url) => (socket = new MockSocket(url)), ...options });
  const pending = model.connect(config);
  await Promise.resolve();
  socket.open();
  const session = await pending;
  const events: RealtimeEvent[] = [];
  const types: RealtimeEvent['type'][] = ['session.ready', 'input.speech.start', 'input.transcript', 'response.start', 'output.text', 'output.transcript', 'output.audio', 'tool.call', 'response.end', 'error', 'extension'];
  for (const type of types) session.on(type, (e) => events.push(e));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { model, socket, session, events };
}

describe('gemini connect', () => {
  it('sends setup with model, voice, instructions, tools and transcription, then waits for setupComplete', async () => {
    const { socket, model } = await connect({ voice: 'Kore' }, {
      instructions: 'be brief',
      tools: [{ name: 'paint', description: 'Paint', parameters: { type: 'object', properties: { color: { type: 'string' } } } }],
    });
    expect(model.provider).toBe('gemini');
    expect(socket.url).toBe(`${GEMINI_LIVE_URL}?key=g-key`);
    expect(socket.sent[0]).toEqual({
      setup: {
        model: 'models/gemini-3.8-live',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
        systemInstruction: { parts: [{ text: 'be brief' }] },
        tools: [{ functionDeclarations: [{ name: 'paint', description: 'Paint', parametersJsonSchema: { type: 'object', properties: { color: { type: 'string' } } } }] }],
        realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  });

  it('maps transcription language and vocabulary', async () => {
    const { socket } = await connect({}, { inputTranscription: { language: 'zh-CN', vocabulary: ['vdoc', '第三章'] } });
    expect(socket.sent[0]!['setup'].inputAudioTranscription).toEqual({ languageCodes: ['zh-CN'], customVocabulary: ['vdoc', '第三章'] });
  });

  it('rejects when the socket closes before setupComplete', async () => {
    let socket!: MockSocket;
    const model = gemini({ apiKey: 'k', socket: (url) => (socket = new MockSocket(url)) });
    const pending = model.connect({});
    await Promise.resolve();
    socket.autoSetup = false;
    socket.open();
    socket.drop(1008, 'API key not valid');
    await expect(pending).rejects.toThrow(/1008: API key not valid/);
    // Gemini's close codes are not mapped yet: the close stays a `connection` error with its code.
    await expect(pending).rejects.toMatchObject({ name: 'RealtimeError', code: 'connection', provider: 'gemini', providerCode: '1008' });
  });

  it('text modality and manual turns change the setup', async () => {
    const { socket } = await connect({ turnDetection: null }, { modalities: 'text' });
    expect(socket.sent[0]!['setup']).toMatchObject({ generationConfig: { responseModalities: ['TEXT'] }, realtimeInputConfig: { automaticActivityDetection: { disabled: true } } });
    expect(socket.sent[0]!['setup'].outputAudioTranscription).toBeUndefined();
  });

  it('declares its gaps so the runtime fills them in', () => {
    expect(GEMINI_CAPABILITIES.truncate).toBe(false);
    expect(GEMINI_CAPABILITIES.tools.autoReplyAfterResult).toBe(true);
    expect(GEMINI_CAPABILITIES.midSessionUpdate).toEqual({ instructions: false, tools: false });
  });
});

describe('gemini input', () => {
  it('sends audio as realtimeInput with the PCM rate in the MIME type', async () => {
    const { socket, session, events } = await connect();
    socket.sent.length = 0;
    session.sendAudio({ data: new Uint8Array([1, 2, 3, 4]), format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } });
    expect(socket.sent).toEqual([{ realtimeInput: { audio: { data: toBase64(new Uint8Array([1, 2, 3, 4])), mimeType: 'audio/pcm;rate=24000' } } }]);
    session.sendAudio({ data: new Uint8Array(2), format: { encoding: 'pcmu' } });
    expect(events.at(-1)).toMatchObject({ type: 'error', recoverable: true });
  });

  it('manual turns wrap audio in activityStart / activityEnd and do not double-trigger a reply', async () => {
    const { socket, session } = await connect({ turnDetection: null });
    socket.sent.length = 0;
    const chunk = { data: new Uint8Array(2), format: { encoding: 'pcm16', sampleRate: 16000, channels: 1 } } as const;
    session.sendAudio(chunk);
    session.sendAudio(chunk);
    session.commitAudio();
    session.respond();
    expect(socket.sent.map((m) => Object.keys(m.realtimeInput ?? m.clientContent ?? {})[0])).toEqual(['activityStart', 'audio', 'audio', 'activityEnd']);
  });

  it('sends text as a complete client turn on respond()', async () => {
    const { socket, session } = await connect();
    socket.sent.length = 0;
    session.sendText('hello');
    expect(socket.sent).toEqual([]);
    session.respond();
    session.respond();
    expect(socket.ofKey('clientContent')).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'hello' }] }], turnComplete: true },
      { turnComplete: true },
    ]);
  });

  it('rejects mid-session config changes it cannot apply', async () => {
    const { session } = await connect();
    await expect(session.update({ instructions: 'x' })).rejects.toThrow(/after setup/);
    await expect(session.update({ instructions: 'x' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.update({ inputFormat: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } })).resolves.toBeUndefined();
  });
});

describe('gemini output', () => {
  it('synthesizes responses from serverContent: transcripts, audio, usage', async () => {
    const { socket, events } = await connect();
    socket.server({ serverContent: { inputTranscription: { text: 'make it ' } } });
    socket.server({ serverContent: { inputTranscription: { text: 'red' } } });
    socket.server({ serverContent: { modelTurn: { parts: [audioPart(960)] }, outputTranscription: { text: 'Sure' } } });
    socket.server({ serverContent: { modelTurn: { parts: [{ text: 'thinking...', thought: true }] } } });
    socket.server({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 5, responseTokenCount: 7 } });
    const types = events.map((e) => e.type);
    expect(types).toEqual(['session.ready', 'input.transcript', 'input.transcript', 'input.transcript', 'response.start', 'output.audio', 'output.transcript', 'response.end']);
    expect(events[3]).toEqual({ type: 'input.transcript', itemId: 'gemini-user-1', text: 'make it red', final: true });
    expect(events[5]).toMatchObject({ responseId: 'gemini-response-1', itemId: 'gemini-response-1-audio', chunk: { durationMs: 20, format: { sampleRate: 24000 } } });
    expect(fromBase64(toBase64((events[5] as { chunk: { data: Uint8Array } }).chunk.data)).byteLength).toBe(960);
    expect(events.at(-1)).toEqual({ type: 'response.end', responseId: 'gemini-response-1', status: 'done', usage: { inputTokens: 5, outputTokens: 7 } });
  });

  it('maps interrupted to speech start plus an interrupted response', async () => {
    const { socket, events } = await connect();
    socket.server({ serverContent: { modelTurn: { parts: [audioPart(96)] } } });
    socket.server({ serverContent: { interrupted: true } });
    expect(events.slice(-2)).toEqual([
      { type: 'input.speech.start', atMs: 0 },
      { type: 'response.end', responseId: 'gemini-response-1', status: 'interrupted' },
    ]);
  });

  it('cancel() ends the turn locally and drops the rest of it', async () => {
    const { socket, session, events } = await connect();
    socket.server({ serverContent: { modelTurn: { parts: [audioPart(96)] } } });
    session.cancel();
    socket.server({ serverContent: { modelTurn: { parts: [audioPart(96)] } } });
    socket.server({ toolCall: { functionCalls: [{ id: 'late', name: 'paint', args: {} }] } });
    socket.server({ serverContent: { turnComplete: true } });
    socket.server({ serverContent: { modelTurn: { parts: [audioPart(96)] } } });
    expect(events.filter((e) => e.type !== 'session.ready').map((e) => [e.type, (e as { status?: string }).status ?? (e as { responseId?: string }).responseId])).toEqual([
      ['response.start', 'gemini-response-1'],
      ['output.audio', 'gemini-response-1'],
      ['response.end', 'cancelled'],
      ['response.start', 'gemini-response-2'],
      ['output.audio', 'gemini-response-2'],
    ]);
    socket.sent.length = 0;
    session.submitToolResult('late', { ok: true });
    expect(socket.sent).toEqual([]);
  });

  it('surfaces extension messages and connection loss', async () => {
    const { socket, events } = await connect();
    socket.server({ goAway: { timeLeft: '10s' } });
    socket.server({ sessionResumptionUpdate: { newHandle: 'h', resumable: true } });
    socket.drop(1011, 'internal');
    expect(events.slice(-3).map((e) => (e.type === 'extension' ? e.name : e.type))).toEqual(['goAway', 'sessionResumptionUpdate', 'error']);
    expect(events.at(-1)).toMatchObject({ recoverable: false, error: { code: 'connection', retryable: true, providerCode: '1011' } });
  });
});

describe('gemini with the agent runtime', () => {
  it('runs a tool round trip: the call ends the response, the result goes back, Gemini continues', async () => {
    let socket!: MockSocket;
    const model = gemini({ apiKey: 'k', socket: (url) => (socket = new MockSocket(url)) });
    const agent = defineAgent({ model, instructions: 'test', tools: { paint: tool({ description: 'p', parameters: {}, run: ({ color }: { color: string }) => `painted ${color}` }) as Tool<never, unknown> } });
    const pending = startSession(agent);
    await Promise.resolve();
    socket.open();
    const session = await pending;
    const states: string[] = [];
    session.on('turn.state', (e: Extract<AgentEvent, { type: 'turn.state' }>) => states.push(e.state));

    session.sendText('paint it red');
    socket.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'paint', args: { color: 'red' } }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.ofKey('toolResponse')).toEqual([{ functionResponses: [{ id: 'fc1', name: 'paint', response: { result: 'painted red' } }] }]);
    expect(socket.ofKey('clientContent')).toHaveLength(1);

    socket.server({ serverContent: { modelTurn: { parts: [audioPart(96)] }, outputTranscription: { text: 'Done' } } });
    socket.server({ serverContent: { turnComplete: true } });
    expect(states).toEqual(['thinking', 'acting', 'thinking', 'speaking', 'idle']);
    expect(session.transcript.at(-1)).toMatchObject({ role: 'agent', text: 'Done' });
  });
});
