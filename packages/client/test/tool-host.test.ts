import { describe, expect, it, vi } from 'vitest';
import { EpochGate } from '../src/epoch-gate.js';
import { ToolHost, type ClientTool, type PendingCall, type ToolOutcome } from '../src/tool-host.js';
import { flush } from './support/fake-socket.js';

const call = (callId: string, epoch: number, name = 'tool'): PendingCall => ({ callId, name, args: { callId }, turnId: `turn-${epoch}`, epoch });

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function host(tools: Record<string, ClientTool>) {
  const gate = new EpochGate();
  const outcomes: [string, ToolOutcome][] = [];
  const tools$ = new ToolHost(tools, gate, (c, outcome) => outcomes.push([c.callId, outcome]));
  return { gate, outcomes, host: tools$, close: (epoch: number) => gate.close(epoch) && tools$.cancelClosed() };
}

describe('EpochGate', () => {
  it('tracks the newest observed epoch and closes epochs cumulatively', () => {
    const gate = new EpochGate();
    gate.observe(3);
    gate.observe(1);
    expect(gate.observed).toBe(3);
    expect(gate.isClosed(0)).toBe(false);
    expect(gate.close(2)).toBe(true);
    expect([gate.isClosed(1), gate.isClosed(2), gate.isClosed(3)]).toEqual([true, true, false]);
    expect(gate.close(2)).toBe(false);
    expect(gate.close(1)).toBe(false);
  });
});

describe('ToolHost', () => {
  it('runs calls one at a time, in arrival order', async () => {
    const order: string[] = [];
    const first = deferred();
    const { host: tools, outcomes } = host({
      tool: { parameters: {}, run: async ({ callId }) => { order.push(`${callId}:start`); if (callId === 'a') await first.promise; order.push(`${callId}:end`); return callId; } },
    });
    tools.submit(call('a', 1));
    tools.submit(call('b', 1));
    await flush();
    expect(order).toEqual(['a:start']);
    first.resolve(undefined);
    await flush();
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(outcomes).toEqual([['a', { ok: true, output: 'a' }], ['b', { ok: true, output: 'b' }]]);
  });

  it('answers a call from a closed epoch at once and never runs it', () => {
    const run = vi.fn();
    const { host: tools, outcomes, gate } = host({ tool: { parameters: {}, run } });
    gate.close(1);
    tools.submit(call('a', 1));
    expect(outcomes).toEqual([['a', { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' }]]);
    expect(run).not.toHaveBeenCalled();
  });

  it('never starts a call whose epoch closes after it was queued but before it starts', async () => {
    const run = vi.fn();
    const { host: tools, outcomes, close } = host({ tool: { parameters: {}, run } });
    tools.submit(call('a', 1));
    close(1);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(outcomes).toEqual([['a', { ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' }]]);
  });

  it('settles a running call INTERRUPTED at once, aborts its signal and drops its late result', async () => {
    const finish = deferred<string>();
    const signals = new Map<string, AbortSignal>();
    const { host: tools, outcomes, close } = host({ tool: { parameters: {}, run: (_args, context) => { signals.set(context.callId, context.signal); return finish.promise; } } });
    tools.submit(call('a', 1));
    tools.submit(call('b', 1));
    tools.submit(call('c', 2));
    await flush();
    close(1);
    await flush();
    expect(signals.get('a')?.aborted).toBe(true);
    finish.resolve('too late');
    await flush();
    expect(outcomes.map(([id, outcome]) => [id, outcome.ok ? outcome.output : outcome.message])).toEqual([
      ['b', 'Interrupted before it started'],
      ['a', 'Interrupted while running'],
      ['c', 'too late'],
    ]);
  });

  it('reports unknown tools, including names inherited from Object, and tool errors as FAILED', async () => {
    const { host: tools, outcomes } = host({
      sync: { parameters: {}, run: () => { throw new Error('sync boom'); } },
      async: { parameters: {}, run: async () => { throw new Error('async boom'); } },
    });
    for (const name of ['missing', 'toString', 'sync', 'async']) tools.submit(call(name, 1, name));
    await flush();
    expect(outcomes.map(([, outcome]) => (outcome.ok ? 'ok' : `${outcome.code}:${outcome.message}`))).toEqual([
      'FAILED:Unknown client tool: missing',
      'FAILED:Unknown client tool: toString',
      'FAILED:sync boom',
      'FAILED:async boom',
    ]);
  });

  it('passes the call identity and a live signal to the tool', async () => {
    const run = vi.fn();
    const { host: tools } = host({ tool: { parameters: {}, run } });
    tools.submit(call('a', 4));
    await flush();
    expect(run).toHaveBeenCalledWith({ callId: 'a' }, expect.objectContaining({ callId: 'a', turnId: 'turn-4', epoch: 4 }));
    expect(run.mock.calls[0]![1].signal.aborted).toBe(false);
  });
});
