import type { RealtimeEvent } from '@vrealtime/core';
import { describe, expect, it } from 'vitest';
import { VirtualClock, fakeModel, type ScriptStep } from '../src/index.js';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;

const answer: ScriptStep[] = [
  { at: 0, event: { type: 'session.ready', sessionId: 's1' } },
  { at: 100, event: { type: 'input.speech.start', atMs: 100 } },
  { at: 900, event: { type: 'input.speech.end', atMs: 900 } },
  { at: 950, event: { type: 'input.transcript', itemId: 'u1', text: 'hi', final: true } },
  { at: 1000, event: { type: 'response.start', responseId: 'r1' } },
  { at: 1100, event: { type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array(960), format: pcm } } },
  { at: 1200, event: { type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: { color: 'red' } } },
  { at: 1500, event: { type: 'response.end', responseId: 'r1', status: 'done' } },
];

async function connect(options: Parameters<typeof fakeModel>[0] = {}) {
  const model = fakeModel(options);
  const session = await model.connect({ instructions: 'test' });
  const events: { at: number; type: string }[] = [];
  const types: RealtimeEvent['type'][] = ['session.ready', 'input.speech.start', 'input.speech.end', 'input.transcript', 'response.start', 'output.audio', 'tool.call', 'response.end'];
  const ends: RealtimeEvent[] = [];
  for (const type of types) session.on(type, (event) => {
    events.push({ at: model.clock.now(), type: event.type });
    if (event.type === 'response.end') ends.push(event);
  });
  return { model, session: model.session, events, ends };
}

describe('VirtualClock', () => {
  it('runs timers in time then scheduling order, including ones added while advancing', () => {
    const clock = new VirtualClock();
    const log: string[] = [];
    clock.setTimeout(() => log.push('b'), 10);
    clock.setTimeout(() => {
      log.push('a');
      clock.setTimeout(() => log.push('a2'), 0);
    }, 5);
    clock.setTimeout(() => log.push('b2'), 10);
    const cancelled = clock.setTimeout(() => log.push('x'), 7);
    clock.clearTimeout(cancelled);
    clock.advance(9);
    expect(log).toEqual(['a', 'a2']);
    expect(clock.now()).toBe(9);
    clock.runAll();
    expect(log).toEqual(['a', 'a2', 'b', 'b2']);
  });
});

describe('fakeModel', () => {
  it('replays the script on virtual time', async () => {
    const { model, events } = await connect({ script: answer });
    expect(events).toEqual([]);
    model.clock.advance(1000);
    expect(events.map((e) => e.type)).toEqual(['session.ready', 'input.speech.start', 'input.speech.end', 'input.transcript', 'response.start']);
    model.clock.runAll();
    expect(events.at(-1)).toEqual({ at: 1500, type: 'response.end' });
  });

  it('records every command', async () => {
    const { session } = await connect();
    const chunk = { data: new Uint8Array(4), format: pcm };
    session.sendAudio(chunk);
    session.commitAudio();
    session.clearAudio();
    session.sendText('hello');
    session.respond({ toolChoice: 'none' });
    session.truncate('a1', 320);
    session.submitToolResult('c1', { ok: true }, { respond: false });
    await session.update({ voice: 'v2' });
    session.cancel();
    await session.close();
    expect(session.commands.map((c) => c.type)).toEqual([
      'connect', 'sendAudio', 'commitAudio', 'clearAudio', 'sendText', 'respond', 'truncate', 'submitToolResult', 'update', 'cancel', 'close',
    ]);
    expect(session.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 320 }]);
    expect(session.config.voice).toBe('v2');
    expect(() => session.sendText('late')).toThrow(/closed/);
  });

  it('cancel() ends the open response and drops its remaining events', async () => {
    const { model, session, events, ends } = await connect({ script: answer });
    model.clock.advance(1100);
    session.cancel();
    expect(ends).toEqual([]);
    model.clock.runAll();
    expect(ends).toEqual([{ type: 'response.end', responseId: 'r1', status: 'cancelled' }]);
    expect(events.map((e) => e.type)).not.toContain('tool.call');
  });

  it('with server VAD, speech during a response interrupts it', async () => {
    const { model, session, ends } = await connect({ script: answer });
    model.clock.advance(1050);
    session.schedule({ type: 'input.speech.start', atMs: 1060 }, 10);
    model.clock.runAll();
    expect(ends).toEqual([{ type: 'response.end', responseId: 'r1', status: 'interrupted' }]);
  });

  it('without server VAD, speech does not touch the response', async () => {
    const { model, session, ends } = await connect({ script: answer, capabilities: { turnDetection: { server: false } } });
    expect(session.capabilities.turnDetection).toEqual({ server: false, semantic: true, manual: true });
    model.clock.advance(1050);
    session.schedule({ type: 'input.speech.start', atMs: 1060 }, 10);
    model.clock.runAll();
    expect(ends).toEqual([{ type: 'response.end', responseId: 'r1', status: 'done' }]);
  });

  it('exposes capability variants for runtime fill-ins', async () => {
    const model = fakeModel({ capabilities: { truncate: false, tools: { autoReplyAfterResult: false } } });
    expect(model.capabilities.truncate).toBe(false);
    expect(model.capabilities.tools).toEqual({ calls: true, argumentStreaming: true, autoReplyAfterResult: false });
  });

  it('onCommand can script reactions', async () => {
    const { model, session, ends } = await connect({
      onCommand: (command, s) => {
        if (command.type !== 'respond') return;
        s.schedule({ type: 'response.start', responseId: 'r9' }, 50);
        s.schedule({ type: 'response.end', responseId: 'r9', status: 'done' }, 80);
      },
    });
    session.respond();
    model.clock.runAll();
    expect(ends).toHaveLength(1);
    expect(model.clock.now()).toBe(80);
  });

  it('connect honours connectError and an aborted signal', async () => {
    await expect(fakeModel({ connectError: new Error('down') }).connect({})).rejects.toThrow('down');
    await expect(fakeModel().connect({}, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('close() stops pending script events', async () => {
    const { model, session, events } = await connect({ script: answer });
    await session.close();
    model.clock.runAll();
    expect(events).toEqual([]);
  });
});
