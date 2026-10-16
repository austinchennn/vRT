/**
 * M2 acceptance: the same agent and the same app code on Boson, OpenAI, Gemini and
 * cascade. Each provider is simulated at its own wire protocol, so the adapters,
 * runtime, server and client all run for real.
 */
import { connect, type ClientEvent } from '@vrealtime/client';
import { cascade, type TextModel, type TtsModel } from '@vrealtime/cascade';
import { boson } from '@vrealtime/boson';
import { defineAgent, toBase64, type RealtimeModel } from '@vrealtime/core';
import { gemini } from '@vrealtime/gemini';
import { openai } from '@vrealtime/openai';
import type { ProviderSocket } from '@vrealtime/openai-compatible';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accentColorTool } from '../tools.js';

const ACK = 'Okay, changing it now.';
const DONE = 'Done.';
const AUDIO = toBase64(new Uint8Array(960));

/** Late tool calls are released by the test after it has interrupted the agent. */
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const colorIn = (text: string) => /make it (\w+)/.exec(text)?.[1];

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** Base for simulated provider sockets: already open, replies asynchronously like a network. */
abstract class SimSocket implements ProviderSocket {
  readyState = 1;
  #listeners: Record<string, Listener[]> = {};
  constructor(protected readonly late: Promise<void>) {}
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  close() {
    this.readyState = 3;
  }
  send(data: string) {
    const message = JSON.parse(data) as Record<string, any>;
    setTimeout(() => this.receive(message), 1);
  }
  protected emit(message: Record<string, unknown>) {
    if (this.readyState !== 1) return;
    for (const listener of this.#listeners['message'] ?? []) listener({ data: JSON.stringify(message) });
  }
  protected abstract receive(message: Record<string, any>): void;
}

/** OpenAI Realtime GA protocol (Boson and OpenAI). */
class OpenAISim extends SimSocket {
  #text = '';
  #afterTool = false;
  #responses = 0;
  #open: string | undefined;

  protected receive(message: Record<string, any>) {
    switch (message['type']) {
      case 'session.update':
        if (this.#responses === 0 && !this.#open) {
          this.emit({ type: 'session.created', session: { id: 'sess' } });
          this.emit({ type: 'session.updated', session: { id: 'sess' } });
        }
        return;
      case 'conversation.item.create':
        if (message['item'].type === 'function_call_output') this.#afterTool = true;
        else this.#text = message['item'].content[0].text;
        return;
      case 'response.cancel':
        if (this.#open) this.emit({ type: 'response.done', response: { id: this.#open, status: 'cancelled', status_details: { reason: 'client_cancelled' } } });
        this.#open = undefined;
        return;
      case 'response.create':
        void this.#respond();
    }
  }

  async #respond() {
    const id = `resp_${++this.#responses}`;
    const item = `item_${this.#responses}`;
    this.#open = id;
    this.emit({ type: 'response.created', response: { id } });
    const color = this.#afterTool ? undefined : colorIn(this.#text);
    this.#afterTool = false;
    this.emit({ type: 'response.output_audio_transcript.delta', response_id: id, item_id: item, delta: color ? ACK : DONE });
    this.emit({ type: 'response.output_audio.delta', response_id: id, item_id: item, delta: AUDIO });
    if (color) {
      if (color === 'blue') await this.late;
      this.emit({ type: 'response.output_item.added', response_id: id, item: { type: 'function_call', call_id: `call_${id}`, name: 'set_accent_color' } });
      this.emit({ type: 'response.function_call_arguments.done', response_id: id, call_id: `call_${id}`, name: 'set_accent_color', arguments: JSON.stringify({ color }) });
    }
    if (this.#open === id) this.emit({ type: 'response.done', response: { id, status: 'completed' } });
    if (this.#open === id) this.#open = undefined;
  }
}

/** Gemini Live BidiGenerateContent protocol. */
class GeminiSim extends SimSocket {
  protected receive(message: Record<string, any>) {
    if (message['setup']) {
      this.emit({ setupComplete: {} });
      return;
    }
    if (message['clientContent']?.turnComplete) {
      void this.#turn(colorIn(message['clientContent'].turns?.[0]?.parts?.[0]?.text ?? ''));
      return;
    }
    if (message['toolResponse']) void this.#turn(undefined);
  }

  async #turn(color: string | undefined) {
    this.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: AUDIO } }] }, outputTranscription: { text: color ? ACK : DONE } } });
    if (color) {
      if (color === 'blue') await this.late;
      this.emit({ toolCall: { functionCalls: [{ id: `fc_${color}`, name: 'set_accent_color', args: { color } }] } });
      return;
    }
    this.emit({ serverContent: { turnComplete: true } });
  }
}

/** Cascade parts: a scripted LLM and a TTS producing 24 kHz PCM16. */
function cascadeParts(late: Promise<void>): { llm: TextModel; tts: TtsModel } {
  return {
    llm: {
      async *stream(request, { signal }) {
        const last = request.messages.at(-1)!;
        const color = last.role === 'user' ? colorIn(last.content) : undefined;
        if (!color) {
          yield { type: 'text', delta: DONE };
          return;
        }
        yield { type: 'text', delta: `${ACK} ` };
        if (color === 'blue') await late;
        if (signal.aborted) return;
        yield { type: 'tool-call', callId: `call_${color}`, name: 'set_accent_color', arguments: { color } };
      },
    },
    tts: {
      format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 },
      async *synthesize() {
        yield new Uint8Array(960);
      },
    },
  };
}

const MODELS: Record<string, (late: Promise<void>) => RealtimeModel> = {
  boson: (late) => boson({ apiKey: 'test', socket: () => new OpenAISim(late) }),
  openai: (late) => openai({ apiKey: 'test', socket: () => new OpenAISim(late) }),
  gemini: (late) => gemini({ apiKey: 'test', socket: () => new GeminiSim(late) }),
  cascade: (late) => cascade(cascadeParts(late)),
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** The app code, identical for every model. */
async function scenario(model: RealtimeModel, late: { release: () => void }) {
  running = await serve(defineAgent({
    model,
    instructions: 'You are a friendly voice assistant. When asked to change colors, call set_accent_color.',
    clientTools: 'accept',
  }), { port: 0, onListening: () => {} });

  let color = 'initial';
  const session = await connect(running.url.replace('http', 'ws'), {
    tools: { set_accent_color: accentColorTool((c: string) => { color = c; }) },
  });
  const events: ClientEvent[] = [];
  for (const type of ['transcript', 'tool.result', 'interrupted'] as const) session.on(type, (e) => events.push(e));

  session.sendText('make it red');
  await vi.waitFor(() => expect(color).toBe('red'), { timeout: 3000 });
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'transcript', role: 'agent', text: DONE, final: true })), { timeout: 3000 });
  await vi.waitFor(() => expect(session.state).toBe('idle'));

  session.sendText('make it blue');
  await vi.waitFor(() => expect(session.state).toBe('speaking'), { timeout: 3000 });
  session.interrupt();
  expect(events.some((e) => e.type === 'interrupted')).toBe(true); // reported locally, at once
  // Release the late tool call only once the server has ended the interrupted turn, so it is dropped there.
  await vi.waitFor(() => expect(session.state).toBe('idle'));
  late.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.close();

  return {
    color,
    toolResults: events.filter((e) => e.type === 'tool.result').map((e) => (e as Extract<ClientEvent, { type: 'tool.result' }>).result),
    agentLines: events.filter((e): e is Extract<ClientEvent, { type: 'transcript' }> => e.type === 'transcript' && e.final).map((e) => e.text),
    interruptions: events.filter((e) => e.type === 'interrupted').length,
  };
}

describe('M2 acceptance: one agent, four models', () => {
  const outcomes: Record<string, unknown> = {};

  for (const [name, make] of Object.entries(MODELS)) {
    it(`runs the scenario on ${name}`, async () => {
      const late = hold();
      outcomes[name] = await scenario(make(late.promise), late);
      expect(outcomes[name]).toEqual({
        color: 'red',
        toolResults: [{ ok: true, output: { applied: 'red' } }],
        agentLines: [ACK, DONE],
        interruptions: 1,
      });
    });
  }

  it('all four behave identically for the app', () => {
    expect(Object.keys(outcomes)).toEqual(['boson', 'openai', 'gemini', 'cascade']);
    const [first, ...rest] = Object.values(outcomes);
    for (const outcome of rest) expect(outcome).toEqual(first);
  });
});
