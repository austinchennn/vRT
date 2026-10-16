import { connect, type ClientEvent } from '@vrealtime/client';
import { defineAgent } from '@vrealtime/core';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accentColorTool } from '../tools.js';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A model that replies to "make it <color>" by speaking and calling set_accent_color `toolDelayMs` later. */
function colorModel(toolDelayMs: (color: string) => number) {
  let lastText = '';
  let turn = 0;
  return fakeModel({
    capabilities: { tools: { autoReplyAfterResult: false } },
    onCommand(command, session) {
      if (command.type === 'sendText') lastText = command.text;
      if (command.type !== 'respond') return;
      const id = `r${++turn}`;
      const color = /make it (\w+)/.exec(lastText)?.[1];
      lastText = '';
      session.schedule({ type: 'response.start', responseId: id });
      session.schedule({ type: 'output.audio', responseId: id, itemId: `${id}-a`, chunk: { data: new Uint8Array(960), format: pcm } });
      if (color) {
        session.schedule({ type: 'tool.call', responseId: id, callId: `${id}-c`, name: 'set_accent_color', arguments: { color } }, toolDelayMs(color));
        session.schedule({ type: 'response.end', responseId: id, status: 'done' }, toolDelayMs(color) + 1);
      } else {
        session.schedule({ type: 'output.transcript', responseId: id, itemId: `${id}-a`, delta: 'Done.' }, 1);
        session.schedule({ type: 'response.end', responseId: id, status: 'done' }, 2);
      }
    },
  });
}

describe('M0 end to end', () => {
  it('connects, runs an app-side tool, and never applies a tool after an interruption', async () => {
    const model = colorModel((color) => (color === 'blue' ? 500 : 10));
    running = await serve(defineAgent({ model, instructions: 'test', clientTools: 'accept' }), { port: 0, clock: model.clock, onListening: () => {} });

    let color = 'initial';
    const session = await connect(running.url.replace('http', 'ws'), {
      tools: { set_accent_color: accentColorTool((c: string) => { color = c; }) },
    });
    const events: ClientEvent[] = [];
    for (const type of ['state', 'transcript', 'tool.result', 'interrupted'] as const) session.on(type, (e) => events.push(e));
    expect(model.session.config.tools?.map((t) => t.name)).toEqual(['set_accent_color']);

    // 1. A client tool call applies live, then the agent answers with the result.
    session.sendText('make it red');
    await vi.waitFor(() => expect(model.session.commandsOf('respond')).toHaveLength(1));
    model.clock.advance(20);
    await vi.waitFor(() => expect(color).toBe('red'));
    await vi.waitFor(() => expect(model.session.commandsOf('respond')).toHaveLength(2));
    expect(model.session.commandsOf('submitToolResult')[0]).toMatchObject({ callId: 'r1-c', output: { applied: 'red' } });
    model.clock.advance(5);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'transcript', role: 'agent', text: 'Done.', final: true })));

    // 2. Interrupt while the agent is speaking, before its tool call lands: nothing changes afterwards.
    session.sendText('make it blue');
    await vi.waitFor(() => expect(model.session.commandsOf('respond')).toHaveLength(3));
    model.clock.advance(1);
    await vi.waitFor(() => expect(session.state).toBe('speaking'));
    session.interrupt();
    await vi.waitFor(() => expect(model.session.commandsOf('cancel')).toHaveLength(1));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));
    model.clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(color).toBe('red');
    expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(1);

    await session.close();
  });
});
