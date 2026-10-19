import { GLOBAL_TOOL_IDS_V1, TOOL_STREAM_V1, type ServerMessage, type Unsequenced } from '@vrealtime/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EpochGate } from '../src/epoch-gate.js';
import { connect, type ClientEvent } from '../src/index.js';
import { ToolStreamTracker, type ToolStreamEvent } from '../src/tool-streams.js';
import { FakeSocket, latest } from './support/fake-socket.js';

afterEach(() => {
  FakeSocket.instances = [];
  expect(FakeSocket.offSpec.splice(0)).toEqual([]);
});

const pcm = { encoding: 'pcm16', sampleRate: 24000 } as const;
const step = (callId: string, epoch: number, rest: Record<string, unknown>) =>
  ({ type: 'tool.stream', callId, epoch, turnId: `turn-${epoch}`, name: 'insert_table', ...rest }) as ToolStreamEvent;

describe('ToolStreamTracker', () => {
  function tracker() {
    const gate = new EpochGate();
    const events: ToolStreamEvent[] = [];
    return { gate, events, streams: new ToolStreamTracker(gate, (event) => events.push(event)) };
  }

  it('passes steps through, and reports each call ending once', () => {
    const { events, streams } = tracker();
    streams.receive(step('c1', 1, { phase: 'start' }));
    streams.receive(step('c1', 1, { phase: 'settled', ok: true }));
    streams.receive(step('c1', 1, { phase: 'settled', ok: true }));
    streams.receive(step('c1', 1, { phase: 'progress', progress: 1 }));
    expect(events.map((e) => e.phase)).toEqual(['start', 'settled']);
  });

  it('cancels open calls of a closed epoch at once, and drops later steps of that epoch', () => {
    const { gate, events, streams } = tracker();
    streams.receive(step('old', 1, { phase: 'arguments-delta', delta: '{' }));
    streams.receive(step('done', 1, { phase: 'start' }));
    streams.receive(step('done', 1, { phase: 'failed', message: 'x' }));
    streams.receive(step('new', 2, { phase: 'start' }));
    gate.close(1);
    streams.cancelClosed();
    streams.receive(step('old', 1, { phase: 'cancelled' }));
    streams.receive(step('late', 1, { phase: 'start' }));
    expect(events.map((e) => [e.callId, e.phase])).toEqual([
      ['old', 'arguments-delta'], ['done', 'start'], ['done', 'failed'], ['new', 'start'], ['old', 'cancelled'],
    ]);
    expect(events.at(-1)).toEqual({ type: 'tool.stream', callId: 'old', name: 'insert_table', turnId: 'turn-1', epoch: 1, phase: 'cancelled' });
  });

  it('forgets everything on clear() without reporting', () => {
    const { gate, events, streams } = tracker();
    streams.receive(step('c1', 1, { phase: 'start' }));
    streams.clear();
    gate.close(1);
    streams.cancelClosed();
    expect(events.map((e) => e.phase)).toEqual(['start']);
  });
});

describe('tool streams in a session', () => {
  async function start(capabilities: string[] | undefined) {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never });
    const socket = latest();
    socket.open();
    socket.server({ type: 'ready', sessionId: 's', input: pcm, output: pcm, ...(capabilities ? { capabilities } : {}) });
    const session = await pending;
    const events: ClientEvent[] = [];
    for (const type of ['tool.stream', 'tool.preview', 'interrupted'] as const) session.on(type, (event) => events.push(event));
    const send = (rest: Unsequenced<Extract<ServerMessage, { type: 'tool.stream' }>>) => socket.server(rest);
    return { session, socket, events, send };
  }

  it('offers stream and global-ID capabilities while accepting an older server', async () => {
    await start([TOOL_STREAM_V1]);
    expect(latest().ofType('hello')[0]).toMatchObject({ capabilities: [TOOL_STREAM_V1, GLOBAL_TOOL_IDS_V1] });
  });

  it('exposes the cross-session identifier guarantee only when negotiated', async () => {
    const { session } = await start([GLOBAL_TOOL_IDS_V1]);
    expect(session.capabilities.has(GLOBAL_TOOL_IDS_V1)).toBe(true);
    expect(session.capabilities.has(TOOL_STREAM_V1)).toBe(false);
    await session.close();
  });

  it('reports the lifecycle, and the 1.0 preview for fragments and progress', async () => {
    const { session, events, send } = await start([TOOL_STREAM_V1]);
    expect(session.capabilities.has(TOOL_STREAM_V1)).toBe(true);
    send(step('c1', 1, { phase: 'start' }) as never);
    send(step('c1', 1, { phase: 'arguments-delta', delta: '{"rows":' }) as never);
    send(step('c1', 1, { phase: 'arguments-complete', arguments: { rows: 2 } }) as never);
    send(step('c1', 1, { phase: 'progress', progress: { done: 1 } }) as never);
    send(step('c1', 1, { phase: 'settled', ok: true }) as never);
    expect(events.map((e) => (e.type === 'tool.stream' ? e.phase : `${e.type}:${JSON.stringify((e as { preview: unknown }).preview)}`))).toEqual([
      'start', 'arguments-delta', 'tool.preview:{"argumentsDelta":"{\\"rows\\":"}', 'arguments-complete', 'progress', 'tool.preview:{"done":1}', 'settled',
    ]);
  });

  it('cancels open calls the moment the app interrupts, before reporting the interruption, and ignores the server echo', async () => {
    const { session, socket, events, send } = await start([TOOL_STREAM_V1]);
    socket.server({ type: 'turn.state', turnId: 'turn-1', epoch: 1, state: 'acting' });
    send(step('c1', 1, { phase: 'start' }) as never);
    send(step('c1', 1, { phase: 'arguments-delta', delta: '{' }) as never);
    session.interrupt();
    send(step('c1', 1, { phase: 'cancelled' }) as never);
    send(step('c1', 1, { phase: 'arguments-delta', delta: 'late' }) as never);
    expect(events.filter((e) => e.type !== 'tool.preview').map((e) => (e.type === 'tool.stream' ? `${e.callId}:${e.phase}` : e.type))).toEqual(['c1:start', 'c1:arguments-delta', 'c1:cancelled', 'interrupted']);
  });

  it('ignores tool.stream when the server did not confirm the capability', async () => {
    const { session, events, send } = await start(undefined);
    expect(session.capabilities.size).toBe(0);
    send(step('c1', 1, { phase: 'start' }) as never);
    expect(events).toEqual([]);
  });

  it('does not report open calls as cancelled when the session closes', async () => {
    const { session, events, send } = await start([TOOL_STREAM_V1]);
    send(step('c1', 1, { phase: 'start' }) as never);
    await session.close();
    expect(events.map((e) => (e as ToolStreamEvent).phase)).toEqual(['start']);
  });
});
