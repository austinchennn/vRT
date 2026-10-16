import { defineAgent, startSession, tool, type AgentEvent, type AudioChunk, type Tool } from '@vrealtime/core';
import { energyVad } from '@vrealtime/vad';
import { describe, expect, it, vi } from 'vitest';
import { SentenceBuffer, cascade, type ChatMessage, type SttModel, type TextModel, type TextPart, type TextRequest, type TtsModel } from '../src/index.js';

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
    expect(events).toContainEqual({ type: 'transcript', role: 'user', itemId: 'cascade-user-1', text: 'what time is it', final: true });
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: 'what time is it' }]);
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
  });
});
