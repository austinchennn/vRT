import { RealtimeError, defineAgent, startSession, tool, type AgentEvent, type AudioChunk, type Tool } from '@vrealtime/core';
import { energyVad } from '@vrealtime/vad';
import { describe, expect, it, vi } from 'vitest';
import { SentenceBuffer, cascade, trimHistory, type ChatMessage, type SttModel, type TextModel, type TextPart, type TextRequest, type TtsModel } from '../src/index.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pcm16k = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;
const pcm24k = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;

/** An LLM whose turns are scripted per call; records every request. */
function scriptedLlm(turns: ((request: TextRequest) => TextPart[])[]) {
  const requests: TextRequest[] = [];
  const llm: TextModel = {
    id: 'scripted',
    async *stream(request, { signal }) {
      requests.push(structuredClone({ ...request, messages: request.messages }));
      const parts = turns[requests.length - 1]?.(request) ?? [{ type: 'text', delta: 'Okay.' }];
      for (const part of parts) {
        if (signal.aborted) return;
        await Promise.resolve();
        yield part;
      }
    },
  };
  return { llm, requests };
}

/** 10 ms of 24 kHz audio per character, in one chunk per sentence; optionally gated. */
function fakeTts(gate?: Promise<void>): TtsModel & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    format: pcm24k,
    async *synthesize(text) {
      spoken.push(text);
      if (gate) await gate;
      yield new Uint8Array(text.length * 480);
    },
  };
}

const stt = (text: string): SttModel => ({ sampleRate: 16000, transcribe: vi.fn(async () => text) });

function tone(amplitude: number, ms = 20): AudioChunk {
  const n = (16000 * ms) / 1000;
  const data = new Uint8Array(n * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(amplitude * Math.sin(i / 3)), true);
  return { data, format: pcm16k };
}

async function agentWith(model: ReturnType<typeof cascade>, tools?: Record<string, Tool<never, unknown>>) {
  const session = await startSession(defineAgent({ model, instructions: 'be nice', ...(tools ? { tools } : {}) }));
  const events: AgentEvent[] = [];
  for (const type of ['turn.state', 'transcript', 'audio', 'text', 'tool.result', 'interrupted', 'error'] as const) session.on(type, (e) => events.push(e));
  return { session, events };
}

describe('SentenceBuffer', () => {
  it('splits on sentence ends as text streams in, merging very short sentences', () => {
    const buffer = new SentenceBuffer(12);
    expect(buffer.push('Hi. How are')).toEqual([]);
    // "I am fine." is too short on its own, and "3.14" is not a sentence end.
    expect(buffer.push(' you today? I am fine. The value is 3.14 ok')).toEqual(['Hi. How are you today?']);
    expect(buffer.flush()).toBe('I am fine. The value is 3.14 ok');
  });

  it('handles CJK punctuation and line breaks', () => {
    const buffer = new SentenceBuffer(4);
    expect(buffer.push('你好，很高兴见到你。今天天气不错！\nNext line')).toEqual(['你好，很高兴见到你。', '今天天气不错！']);
    expect(buffer.flush()).toBe('Next line');
  });
});

describe('cascade', () => {
  it('declares capabilities from its parts', () => {
    const { llm } = scriptedLlm([]);
    expect(cascade({ llm }).capabilities).toMatchObject({ input: { audio: false }, output: { audio: false }, turnDetection: { server: false, manual: false }, truncate: false });
    const full = cascade({ llm, stt: stt('x'), tts: fakeTts(), vad: energyVad() }).capabilities;
    expect(full).toMatchObject({ input: { audio: true }, output: { audio: true, formats: [pcm24k] }, turnDetection: { server: true, manual: true }, truncate: true, tools: { autoReplyAfterResult: false } });
  });

  it('answers a text turn: streamed sentences become audio with an aligned transcript', async () => {
    const { llm, requests } = scriptedLlm([() => [{ type: 'text', delta: 'Hello there, friend. ' }, { type: 'text', delta: 'How are you doing today?' }, { type: 'finish', usage: { inputTokens: 3, outputTokens: 9 } }]]);
    const tts = fakeTts();
    const { session, events } = await agentWith(cascade({ llm, tts }));
    session.sendText('hi');
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    expect(tts.spoken).toEqual(['Hello there, friend.', 'How are you doing today?']);
    expect(requests[0]).toMatchObject({ instructions: 'be nice', messages: [{ role: 'user', content: 'hi' }] });
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(2);
    expect(session.transcript.at(-1)).toMatchObject({ role: 'agent', text: 'Hello there, friend. How are you doing today?' });
    expect(events.filter((e) => e.type === 'turn.state').map((e) => (e as { state: string }).state)).toEqual(['thinking', 'speaking', 'idle']);
  });

  it('answers in text without a tts', async () => {
    const { llm } = scriptedLlm([() => [{ type: 'text', delta: 'Plain ' }, { type: 'text', delta: 'text.' }]]);
    const { session, events } = await agentWith(cascade({ llm }));
    session.sendText('hi');
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Plain ', 'text.']);
  });

  it('runs a voice turn: VAD-segmented audio is transcribed and answered', async () => {
    const recognizer = stt('what time is it');
    const { llm, requests } = scriptedLlm([() => [{ type: 'text', delta: 'It is noon right now.' }]]);
    const { session, events } = await agentWith(cascade({ llm, stt: recognizer, tts: fakeTts(), vad: energyVad({ minSpeechMs: 60, minSilenceMs: 200 }) }));
    for (const chunk of [...Array(5).fill(tone(0)), ...Array(10).fill(tone(9000)), ...Array(12).fill(tone(0))]) session.sendAudio(chunk);
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    const audio = (recognizer.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    // Pre-roll keeps audio from before the VAD fired: more than the 10 voiced chunks.
    expect(audio.byteLength).toBeGreaterThan(10 * 640);
    expect(events).toContainEqual({ type: 'transcript', role: 'user', itemId: 'cascade-user-1', text: 'what time is it', final: true, revision: 1 });
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: 'what time is it' }]);
  });

  it('passes transcription vocabulary to the stt', async () => {
    const recognizer = stt('open chapter three');
    const { llm } = scriptedLlm([() => [{ type: 'text', delta: 'Opening it now, one moment.' }]]);
    const model = cascade({ llm, stt: recognizer, tts: fakeTts() });
    const session = await model.connect({ inputTranscription: { language: 'en', vocabulary: ['vdoc', 'Q3 plan'] } });
    session.sendAudio(tone(9000));
    session.commitAudio();
    await vi.waitFor(() => expect(recognizer.transcribe).toHaveBeenCalled());
    expect((recognizer.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ language: 'en', vocabulary: ['vdoc', 'Q3 plan'] });
  });

  it('keeps at most maxUtteranceMs of an utterance for a batch stt', async () => {
    const recognizer = stt('long');
    const { llm } = scriptedLlm([]);
    const session = await cascade({ llm, stt: recognizer, maxUtteranceMs: 100 }).connect({});
    const errors: unknown[] = [];
    session.on('error', (e) => errors.push(e.error));
    for (let i = 0; i < 8; i++) session.sendAudio(tone(9000));
    session.commitAudio();
    await vi.waitFor(() => expect(recognizer.transcribe).toHaveBeenCalled());
    expect(((recognizer.transcribe as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array).byteLength).toBe(5 * 640);
    expect(errors).toMatchObject([{ code: 'transcription' }]);
  });

  it('round-trips a tool call: the result feeds the next request', async () => {
    const { llm, requests } = scriptedLlm([
      () => [{ type: 'tool-call-delta', callId: 'c1', name: 'weather', argumentsDelta: '{"city"' }, { type: 'tool-call', callId: 'c1', name: 'weather', arguments: { city: 'Paris' } }],
      () => [{ type: 'text', delta: 'It is sunny in Paris.' }],
    ]);
    const weather = tool({ description: 'w', parameters: { type: 'object' }, run: ({ city }: { city: string }) => ({ city, sky: 'sunny' }) }) as Tool<never, unknown>;
    const { session } = await agentWith(cascade({ llm, tts: fakeTts() }), { weather });
    session.sendText('weather in paris?');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(['weather']);
    expect(requests[1]!.messages).toEqual<ChatMessage[]>([
      { role: 'user', content: 'weather in paris?' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name: 'weather', arguments: { city: 'Paris' } }] },
      { role: 'tool', callId: 'c1', name: 'weather', output: { city: 'Paris', sky: 'sunny' } },
    ]);
  });

  it('an interruption mid-speech stops the pipeline and truncates history to what was heard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { llm, requests } = scriptedLlm([
      () => [{ type: 'text', delta: 'The first sentence is here. ' }, { type: 'text', delta: 'The second sentence never plays.' }],
      () => [{ type: 'text', delta: 'Sure.' }],
    ]);
    const tts = fakeTts();
    const slowSecond: TtsModel = {
      format: pcm24k,
      async *synthesize(text, options) {
        if (text.startsWith('The second')) await gate;
        yield* tts.synthesize(text, options);
      },
    };
    const { session, events } = await agentWith(cascade({ llm, tts: slowSecond }));
    session.sendText('talk');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'audio')).toHaveLength(1));
    const first = events.find((e) => e.type === 'audio') as Extract<AgentEvent, { type: 'audio' }>;
    session.playback(first.itemId, 140);
    session.interrupt();
    release();
    await flush();
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(1);
    session.sendText('go on');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    // 140 ms of a 270 ms sentence ("The first sentence is here.", 10 ms per character) was heard.
    expect(requests[1]!.messages[1]).toEqual({ role: 'assistant', content: 'The first sent' });
  });

  it('speech over the agent interrupts it, like a provider with server VAD', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { llm } = scriptedLlm([() => [{ type: 'text', delta: 'A long answer that keeps going.' }]]);
    const { session, events } = await agentWith(cascade({ llm, stt: stt('stop'), tts: fakeTts(gate), vad: energyVad({ minSpeechMs: 60, minSilenceMs: 200 }) }));
    session.sendText('tell me');
    await vi.waitFor(() => expect(session.state).toBe('thinking'));
    for (const chunk of Array(5).fill(tone(9000))) session.sendAudio(chunk);
    release();
    await flush();
    expect(events.filter((e) => e.type === 'interrupted')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(0);
    expect(session.state).toBe('listening');
  });

  it('reports LLM failures as a failed response', async () => {
    const llm: TextModel = {
      async *stream() {
        yield { type: 'text', delta: 'partial ' };
        throw new Error('rate limited');
      },
    };
    const { session, events } = await agentWith(cascade({ llm }));
    session.sendText('hi');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error' && e.error.message === 'rate limited')).toBe(true));
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    // A plain error from the text model becomes a `provider` RealtimeError that keeps it as the cause.
    const error = events.find((e) => e.type === 'error')!;
    expect(error).toMatchObject({ error: { name: 'RealtimeError', code: 'provider', provider: 'cascade', cause: { message: 'rate limited' } } });
  });

  it('keeps the code of a RealtimeError its text model throws', async () => {
    const llm: TextModel = {
      async *stream() {
        throw new RealtimeError('quota', 'out of credits', { provider: 'anthropic' });
      },
    };
    const { session, events } = await agentWith(cascade({ llm }));
    session.sendText('hi');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ error: { code: 'quota', provider: 'anthropic', retryable: false } });
  });

  it('sends the whole history while a session is short', async () => {
    const { llm, requests } = scriptedLlm([]);
    const session = await cascade({ llm }).connect({});
    for (const text of ['one', 'two', 'three']) {
      session.sendText(text);
      session.respond();
      await vi.waitFor(() => expect(requests).toHaveLength(['one', 'two', 'three'].indexOf(text) + 1));
      await flush();
    }
    expect(requests[2]!.messages).toEqual<ChatMessage[]>([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'Okay.' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'Okay.' },
      { role: 'user', content: 'three' },
    ]);
  });

  it('sends only the recent history within the budget, and keeps memory bounded', async () => {
    const { llm, requests } = scriptedLlm([]);
    const session = await cascade({ llm, history: { maxMessages: 4, maxStoredMessages: 6 } }).connect({});
    for (let i = 1; i <= 10; i++) {
      session.sendText(`turn ${i}`);
      session.respond();
      await vi.waitFor(() => expect(requests).toHaveLength(i));
      await flush();
    }
    // Starts on a user message: 3 messages, not an assistant reply plus 3.
    expect(requests[9]!.messages).toEqual<ChatMessage[]>([
      { role: 'user', content: 'turn 9' },
      { role: 'assistant', content: 'Okay.' },
      { role: 'user', content: 'turn 10' },
    ]);
    expect((session as unknown as { history: ChatMessage[] }).history.length).toBeLessThanOrEqual(6);
  });

  it('trims by approximate tokens and lets a hook replace the strategy', async () => {
    const { llm, requests } = scriptedLlm([]);
    const long = 'x'.repeat(800);
    const session = await cascade({ llm, history: { maxTokens: 150 } }).connect({});
    for (const text of [long, 'short']) {
      session.sendText(text);
      session.respond();
      await vi.waitFor(() => expect(requests).toHaveLength(text === long ? 1 : 2));
      await flush();
    }
    expect(requests[1]!.messages).toEqual([{ role: 'user', content: 'short' }]);

    const processed = scriptedLlm([]);
    const hooked = await cascade({ llm: processed.llm, history: { process: (messages) => messages.filter((m) => m.role === 'user') } }).connect({});
    hooked.sendText('a');
    hooked.respond();
    await vi.waitFor(() => expect(processed.requests).toHaveLength(1));
    await flush();
    hooked.sendText('b');
    hooked.respond();
    await vi.waitFor(() => expect(processed.requests).toHaveLength(2));
    expect(processed.requests[1]!.messages).toEqual([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  });
});

describe('trimHistory', () => {
  const call = (id: string): ChatMessage => ({ role: 'assistant', content: '', toolCalls: [{ callId: id, name: 'f', arguments: {} }] });
  const result = (id: string): ChatMessage => ({ role: 'tool', callId: id, name: 'f', output: 'ok' });

  it('never splits a tool call from its results', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'q' }, call('c1'), result('c1'), { role: 'assistant', content: 'done' }, { role: 'user', content: 'again' }, call('c2'), result('c2'), result('c2b')];
    (messages[5] as Extract<ChatMessage, { role: 'assistant' }>).toolCalls!.push({ callId: 'c2b', name: 'f', arguments: {} });
    for (let max = 1; max <= messages.length; max++) {
      const kept = trimHistory(messages, { maxMessages: max });
      expect(kept[0]!.role).not.toBe('tool');
      for (const message of kept) {
        if (message.role !== 'tool') continue;
        expect(kept.some((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.callId === message.callId))).toBe(true);
      }
    }
    // Too small for the last turn: it still starts at the last place it can, with its pair.
    expect(trimHistory(messages, { maxMessages: 2 })).toEqual(messages.slice(4));
    expect(trimHistory(messages, { maxMessages: 4 })).toEqual(messages.slice(4));
    expect(trimHistory(messages, { maxMessages: 7 })).toEqual(messages.slice(4));
    expect(trimHistory(messages, { maxMessages: 8 })).toEqual(messages);
  });

  it('keeps a tool result that arrives after a later user message with its call', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'q' }, call('c1'), { role: 'user', content: 'still there?' }, result('c1')];
    // The user message in between is not a valid start: it would orphan the result.
    expect(trimHistory(messages, { maxMessages: 3 })).toEqual(messages.slice(1));
    expect(trimHistory(messages, { maxMessages: 2 })).toEqual(messages);
  });

  it('drops tool results whose call is already gone', () => {
    const messages: ChatMessage[] = [result('gone'), { role: 'assistant', content: 'hi' }, { role: 'user', content: 'q' }];
    expect(trimHistory(messages, {})).toEqual(messages.slice(2));
    expect(trimHistory([result('gone'), { role: 'assistant', content: 'hi' }], {})).toEqual([{ role: 'assistant', content: 'hi' }]);
  });
});


it('preserves assistant text and tool results across stop-reason continuations', async () => {
  const { llm, requests } = scriptedLlm([
    () => [{ type: 'text', delta: 'Partial answer' }, { type: 'finish', stopReason: 'max_tokens', rawStopReason: 'max_tokens', usage: { outputTokens: 2 } }],
    () => [{ type: 'text', delta: ' still working' }, { type: 'finish', stopReason: 'pause' }],
    () => [{ type: 'tool-call', callId: 'read-1', name: 'read', arguments: {} }, { type: 'finish', stopReason: 'tool_calls' }],
    () => [{ type: 'text', delta: 'Done' }, { type: 'finish', stopReason: 'completed' }],
  ]);
  const onTurnEnd = vi.fn();
  const session = await startSession(defineAgent({ model: cascade({ llm }), instructions: '', tools: { read: tool({ description: '', parameters: {}, run: () => 'document' }) as Tool<never, unknown> }, hooks: { onTurnEnd } }));
  session.sendText('finish');
  await vi.waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
  expect(requests).toHaveLength(4);
  expect(requests[1]!.messages).toEqual([{ role: 'user', content: 'finish' }, { role: 'assistant', content: 'Partial answer' }]);
  expect(requests[3]!.messages).toContainEqual({ role: 'tool', callId: 'read-1', name: 'read', output: 'document' });
  expect(onTurnEnd.mock.calls[0]![1]).toMatchObject({ continuations: 3, stopReason: 'completed', usage: { outputTokens: 2 } });
  await session.close();
});

it('passes normalized and raw finish reasons after audio finishes', async () => {
  const { llm } = scriptedLlm([() => [{ type: 'text', delta: 'Partial.' }, { type: 'finish', stopReason: 'max_tokens', rawStopReason: 'provider_limit' }]]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = await cascade({ llm, tts: fakeTts(gate) }).connect({});
  const ended = vi.fn();
  session.on('response.end', ended);
  session.sendText('go');
  session.respond();
  await flush();
  expect(ended).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(ended).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'max_tokens', rawStopReason: 'provider_limit' })));
  await session.close();
});
