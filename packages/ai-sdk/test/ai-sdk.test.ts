import { cascade, type ChatMessage, type TextPart } from '@vrealtime/cascade';
import { defineAgent, startSession, tool, type Tool } from '@vrealtime/core';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { aiSdk, toModelMessages } from '../src/index.js';

type StreamPart = Parameters<typeof convertArrayToReadableStream>[0][number];

const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
};

function mockModel(...turns: StreamPart[][]) {
  return new MockLanguageModelV4({
    modelId: 'mock-llm',
    doStream: turns.map((parts) => ({ stream: convertArrayToReadableStream(parts) })) as never,
  });
}

const textTurn = (...deltas: string[]): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
  { type: 'text-end', id: 't' },
  { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
] as StreamPart[];

const toolTurn: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id: 'call_1', toolName: 'weather' },
  { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"Paris"}' },
  { type: 'tool-input-end', id: 'call_1' },
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'weather', input: '{"city":"Paris"}' },
  { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
] as StreamPart[];

async function collect(iterable: AsyncIterable<TextPart>) {
  const parts: TextPart[] = [];
  for await (const part of iterable) parts.push(part);
  return parts;
}

describe('toModelMessages', () => {
  it('maps user, assistant (text + tool calls) and tool messages', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name: 'weather', arguments: { city: 'Paris' } }] },
      { role: 'tool', callId: 'c1', name: 'weather', output: { sky: 'sunny' } },
      { role: 'assistant', content: 'Sunny.' },
    ];
    expect(toModelMessages(history)).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: 'Paris' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { type: 'json', value: { sky: 'sunny' } } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Sunny.' }] },
    ]);
  });
});

describe('aiSdk', () => {
  it('streams text and usage, passing instructions and messages', async () => {
    const model = mockModel(textTurn('Hello', ' world.'));
    const llm = aiSdk(model);
    expect(llm.id).toBe('mock-llm');
    const parts = await collect(llm.stream({ instructions: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools: [] }, { signal: new AbortController().signal }));
    expect(parts).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world.' },
      { type: 'finish', usage: { inputTokens: 11, outputTokens: 7 } },
    ]);
    const prompt = model.doStreamCalls[0]!.prompt;
    expect(prompt[0]).toMatchObject({ role: 'system', content: 'be brief' });
    expect(prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  });

  it('reports input tokens read from the prompt cache', async () => {
    const cached = { ...usage, inputTokens: { total: 11, noCache: 7, cacheRead: 4, cacheWrite: undefined } };
    const turn = [...textTurn('Hi.').slice(0, -1), { type: 'finish', usage: cached, finishReason: { unified: 'stop', raw: 'stop' } }] as StreamPart[];
    const parts = await collect(aiSdk(mockModel(turn)).stream({ messages: [{ role: 'user', content: 'hi' }], tools: [] }, { signal: new AbortController().signal }));
    expect(parts.at(-1)).toEqual({ type: 'finish', usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 4 } });
  });

  it('declares tools from JSON Schema without executing them and streams tool calls', async () => {
    const model = mockModel(toolTurn);
    const parts = await collect(aiSdk(model).stream({
      messages: [{ role: 'user', content: 'weather in paris' }],
      tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      toolChoice: { name: 'weather' },
    }, { signal: new AbortController().signal }));
    expect(parts.slice(0, 2)).toEqual([
      { type: 'tool-call-delta', callId: 'call_1', name: 'weather', argumentsDelta: '{"city":"Paris"}' },
      { type: 'tool-call', callId: 'call_1', name: 'weather', arguments: { city: 'Paris' } },
    ]);
    const call = model.doStreamCalls[0]!;
    expect(call.tools).toEqual([expect.objectContaining({ type: 'function', name: 'weather', inputSchema: expect.objectContaining({ required: ['city'] }) })]);
    expect(call.toolChoice).toEqual({ type: 'tool', toolName: 'weather' });
  });

  it('surfaces provider errors', async () => {
    const model = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('overloaded') }] as StreamPart[]);
    await expect(collect(aiSdk(model).stream({ messages: [{ role: 'user', content: 'x' }], tools: [] }, { signal: new AbortController().signal }))).rejects.toThrow('overloaded');
  });

  it('drives a full agent turn through cascade with a tool round trip', async () => {
    const model = mockModel(toolTurn, textTurn('It is sunny in Paris.'));
    const run = vi.fn(({ city }: { city: string }) => ({ city, sky: 'sunny' }));
    const session = await startSession(defineAgent({
      model: cascade({ llm: aiSdk(model) }),
      instructions: 'You report weather.',
      tools: { weather: tool({ description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } }, run }) as Tool<never, unknown> },
    }));
    const text: string[] = [];
    session.on('text', (e) => text.push(e.delta));
    session.sendText('weather in paris?');
    await vi.waitFor(() => expect(text.join('')).toBe('It is sunny in Paris.'));
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    expect(run).toHaveBeenCalledWith({ city: 'Paris' }, expect.anything());
    const second = model.doStreamCalls[1]!.prompt;
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', output: { type: 'json', value: { city: 'Paris', sky: 'sunny' } } }] });
  });
});
