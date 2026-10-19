import { fakeModel, type CapabilityOverrides, type FakeSession } from '@vrealtime/testing';
import { describe, expect, it } from 'vitest';
import { defineAgent, startSession, tool, type Hooks, type Tool, type ToolStreamEvent } from '../src/index.js';
import { ToolStreams } from '../src/tool-stream.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const TERMINAL = new Set(['settled', 'cancelled', 'failed']);

/** Each call's phases, in order. */
function phases(events: readonly ToolStreamEvent[]): Record<string, string[]> {
  const byCall: Record<string, string[]> = {};
  for (const event of events) (byCall[event.callId] ??= []).push(event.phase);
  return byCall;
}

/** The ordering rules of spec/protocol.md §7.5, for every call. */
function expectWellFormed(events: readonly ToolStreamEvent[]): void {
  for (const [callId, list] of Object.entries(phases(events))) {
    expect(list[0], callId).toBe('start');
    expect(list.filter((p) => TERMINAL.has(p)), callId).toHaveLength(1);
    expect(TERMINAL.has(list.at(-1)!), callId).toBe(true);
    const complete = list.indexOf('arguments-complete');
    expect(list.filter((p) => p === 'arguments-complete').length, callId).toBeLessThanOrEqual(1);
    list.forEach((phase, i) => {
      if (phase === 'arguments-delta' && complete !== -1) expect(i, `${callId}: delta after complete`).toBeLessThan(complete);
      if (phase === 'progress') expect(complete !== -1 && i > complete, `${callId}: progress before complete`).toBe(true);
    });
  }
}

describe('ToolStreams', () => {
  const call = (callId: string, responseId = 'r1') => ({ callId, name: 'edit', epoch: 1, turnId: 't1', responseId });

  function streams() {
    const events: ToolStreamEvent[] = [];
    return { events, tracker: new ToolStreams((event) => events.push(event)) };
  }

  it('orders a streamed call: start, fragments, complete, progress, one terminal', () => {
    const { events, tracker } = streams();
    tracker.progress('c1', 'too early');
    tracker.delta(call('c1'), '{"a":');
    tracker.delta(call('c1'), '1}');
    tracker.complete(call('c1'), { a: 1 });
    tracker.delta(call('c1'), 'late fragment');
    tracker.progress('c1', { step: 1 });
    tracker.settle('c1', { ok: true, output: 'done' });
    tracker.progress('c1', 'after the end');
    tracker.settle('c1', { ok: true, output: 'again' });
    expect(events.map((e) => e.phase)).toEqual(['start', 'arguments-delta', 'arguments-delta', 'arguments-complete', 'progress', 'settled']);
    expect(events.at(-1)).toMatchObject({ callId: 'c1', name: 'edit', epoch: 1, turnId: 't1', result: { ok: true, output: 'done' } });
  });

  it('ends an interrupted call as cancelled, issued or not, and never reopens it', () => {
    const { events, tracker } = streams();
    tracker.delta(call('partial'), '{');
    tracker.complete(call('issued'), {});
    tracker.interrupted(1);
    tracker.settle('issued', { ok: false, code: 'INTERRUPTED', message: 'stop' });
    tracker.delta(call('partial'), 'late');
    tracker.complete(call('partial'), {});
    expect(phases(events)).toEqual({ partial: ['start', 'arguments-delta', 'cancelled'], issued: ['start', 'arguments-complete', 'cancelled'] });
  });

  it('fails calls a response started but never issued when it ends', () => {
    const { events, tracker } = streams();
    tracker.delta(call('c1', 'r1'), '{"a"');
    tracker.delta(call('c2', 'r2'), '{');
    tracker.complete(call('c3', 'r1'), {});
    tracker.responseEnded('r1');
    expect(phases(events)).toEqual({ c1: ['start', 'arguments-delta', 'failed'], c2: ['start', 'arguments-delta'], c3: ['start', 'arguments-complete'] });
    expect(events.find((e) => e.phase === 'failed')).toMatchObject({ callId: 'c1', message: expect.any(String) });
  });

  it('emits nothing for a call it never saw start, and nothing after clear()', () => {
    const { events, tracker } = streams();
    tracker.settle('unknown', { ok: true, output: 1 });
    tracker.delta(call('c1'), '{');
    tracker.clear();
    tracker.settle('c1', { ok: true, output: 1 });
    expect(events.map((e) => e.phase)).toEqual(['start', 'arguments-delta']);
  });
});

describe('tool streams in a session', () => {
  async function setup(options: { tools?: Record<string, Tool<never, unknown>>; hooks?: Hooks; capabilities?: CapabilityOverrides; clientTools?: string[] } = {}) {
    const model = fakeModel(options.capabilities ? { capabilities: options.capabilities } : {});
    const agent = defineAgent({ model, instructions: 'test', clientTools: 'accept', ...(options.tools ? { tools: options.tools } : {}), ...(options.hooks ? { hooks: options.hooks } : {}) });
    const session = await startSession(agent, { clock: model.clock, clientTools: (options.clientTools ?? []).map((name) => ({ name, description: name, parameters: {} })) });
    const events: ToolStreamEvent[] = [];
    session.on('tool.stream', (event) => events.push(event));
    return { session, fake: model.session, events };
  }

  function respond(fake: FakeSession, responseId = 'r1') {
    fake.emit({ type: 'input.speech.start', atMs: 0 });
    fake.emit({ type: 'input.speech.end', atMs: 300 });
    fake.emit({ type: 'response.start', responseId });
  }

  it('follows a streamed server tool from its first fragment to its result, with progress', async () => {
    const search = tool({
      description: 'search',
      parameters: {},
      run: (_args, context) => {
        context.emit({ found: 1 });
        return 'ok';
      },
    }) as Tool<never, unknown>;
    const { fake, events } = await setup({ tools: { search } });
    respond(fake);
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'search', argumentsDelta: '{"q":' });
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'search', argumentsDelta: '"x"}' });
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'search', arguments: { q: 'x' } });
    await flush();
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-delta', 'arguments-delta', 'arguments-complete', 'progress', 'settled'] });
    expect(events[0]!.callId).not.toBe('c1');
    expect(events[0]).toMatchObject({ name: 'search', turnId: expect.any(String), epoch: expect.any(Number) });
    expect(events.at(-1)).toMatchObject({ phase: 'settled', result: { ok: true, output: 'ok' } });
    expectWellFormed(events);
  });

  it('drops late fragments of issued calls after stream tombstones are evicted', async () => {
    const probe = tool({ description: 'probe', parameters: {}, run: () => null }) as Tool<never, unknown>;
    const { session, fake, events } = await setup({ tools: { probe } });
    try {
      respond(fake);
      for (let i = 0; i < 257; i++) {
        // Calls run one at a time, so the next settled event is this call's.
        const settled = new Promise<void>((resolve) => {
          const off = session.on('tool.stream', (event) => {
            if (event.phase === 'settled') { off(); resolve(); }
          });
        });
        fake.emit({ type: 'tool.call', responseId: 'r1', callId: `c${i}`, name: 'probe', arguments: {} });
        await settled;
      }
      const first = events[0]!.callId;
      fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c0', name: 'probe', argumentsDelta: 'late' });
      expect(phases(events)[first]).toEqual(['start', 'arguments-complete', 'settled']);
      // The response is still live: a distinct collecting call must not be suppressed.
      fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'fresh', name: 'probe', argumentsDelta: '{' });
      const fresh = events.at(-1)!.callId;
      expect(fresh).not.toBe(first);
      expect(phases(events)[fresh]).toEqual(['start', 'arguments-delta']);
    } finally {
      await session.close();
    }
  });

  it('gives a model without argument streaming start, complete and a terminal phase', async () => {
    const { session, fake, events } = await setup({ clientTools: ['paint'], capabilities: { tools: { argumentStreaming: false } } });
    respond(fake);
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: { color: 'red' } });
    await flush();
    session.submitClientToolResult(events[0]!.callId, { ok: true, output: 'painted' });
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-complete', 'settled'] });
    expect(events[1]).toMatchObject({ phase: 'arguments-complete', arguments: { color: 'red' } });
  });

  it('cancels a call interrupted while its arguments stream, and ignores the call when it arrives late', async () => {
    const { session, fake, events } = await setup({ clientTools: ['paint'] });
    respond(fake);
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'paint', argumentsDelta: '{"co' });
    session.interrupt('user');
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'paint', argumentsDelta: 'lor"}' });
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: { color: 'x' } });
    await flush();
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-delta', 'cancelled'] });
  });

  it('cancels an issued call when its turn is interrupted, and ignores its late result', async () => {
    const { session, fake, events } = await setup({ clientTools: ['paint'] });
    respond(fake);
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: {} });
    await flush();
    session.interrupt('user');
    session.submitClientToolResult(events[0]!.callId, { ok: true, output: 'too late' });
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-complete', 'cancelled'] });
  });

  it('fails a call whose response ends before its arguments are complete', async () => {
    const { fake, events } = await setup({ clientTools: ['paint'] });
    respond(fake);
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'paint', argumentsDelta: '{"color":' });
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'failed' });
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-delta', 'failed'] });
  });

  it('settles a rejected call with its failure code', async () => {
    const { fake, events } = await setup({ clientTools: ['unlock'], hooks: { beforeToolCall: () => ({ action: 'reject', message: 'needs confirmation' }) } });
    respond(fake);
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'unlock', arguments: {} });
    await flush();
    expect(events.at(-1)).toMatchObject({ phase: 'settled', result: { ok: false, code: 'REJECTED' } });
  });

  it('keeps an async server tool open across an interruption until it settles', async () => {
    let finish!: (value: string) => void;
    const send = tool({ description: 'send', parameters: {}, async: true, run: () => new Promise<string>((resolve) => { finish = resolve; }) }) as Tool<never, unknown>;
    const { session, fake, events } = await setup({ tools: { send } });
    respond(fake);
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'send', arguments: {} });
    await flush();
    session.interrupt('user');
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-complete'] });
    finish('sent');
    await flush();
    expect(phases(events)).toEqual({ [events[0]!.callId]: ['start', 'arguments-complete', 'settled'] });
  });

  it('emits nothing more once the session closes', async () => {
    const { session, fake, events } = await setup({ clientTools: ['paint'] });
    respond(fake);
    fake.emit({ type: 'tool.call.delta', responseId: 'r1', callId: 'c1', name: 'paint', argumentsDelta: '{' });
    await session.close();
    expect(events.map((e) => e.phase)).toEqual(['start', 'arguments-delta']);
  });
});
