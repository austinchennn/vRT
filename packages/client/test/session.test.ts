import { createServer } from 'node:http';
import { decodeAudioFrame, encodeAudioFrame } from '@vrealtime/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type AudioSink, type ClientEvent, ClientSession, type ConnectOptions } from '../src/index.js';
import { FakeSocket, flush, latest } from './support/fake-socket.js';

/** Every control frame the client sends must be a valid client message (spec/). */
afterEach(() => {
  expect(FakeSocket.offSpec.splice(0)).toEqual([]);
});

async function start(options: ConnectOptions = {}) {
  const pending = connect('ws://test', { WebSocket: FakeSocket as never, ...options });
  const socket = latest();
  socket.open();
  socket.server({ type: 'ready', sessionId: 'sess', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 } });
  const session = await pending;
  const events: ClientEvent[] = [];
  for (const type of ['state', 'transcript', 'tool.call', 'tool.preview', 'tool.result', 'interrupted', 'error', 'reconnecting', 'closed', 'ready'] as const) {
    session.on(type, (event) => events.push(event));
  }
  return { session, socket, events };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connect', () => {
  it('sends hello with tool specs and resolves on ready', async () => {
    const { session, socket } = await start({
      tools: { paint: { description: 'Paint', parameters: { type: 'object' }, run: () => 1 } },
      context: { doc: 'x' },
    });
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.ofType('hello')).toEqual([{ v: 1, seq: 0, type: 'hello', tools: [{ name: 'paint', description: 'Paint', parameters: { type: 'object' } }], capabilities: ['tool-stream-v1'], context: { doc: 'x' } }]);
    expect(session.sessionId).toBe('sess');
    expect(session.connected).toBe(true);
  });

  it('surfaces an error sent before any session exists (seq 0)', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never });
    latest().open();
    latest().server({ type: 'error', code: 'UNAUTHORIZED', message: 'bad token', recoverable: false }, 0);
    latest().drop(4401);
    await expect(pending).rejects.toThrow('UNAUTHORIZED: bad token');
  });

  it('rejects when the socket closes before ready or the server refuses', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never, reconnect: false });
    latest().drop(1006);
    await expect(pending).rejects.toThrow(/before ready/);
    const refused = connect('ws://test', { WebSocket: FakeSocket as never });
    latest().open();
    latest().server({ type: 'error', code: 'START_FAILED', message: 'model down', recoverable: false });
    await expect(refused).rejects.toThrow(/START_FAILED/);
  });

  it('rejects an error-only handshake promptly without reconnects', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket, reconnect: false });
    const rejected = expect(pending).rejects.toThrow('WebSocket handshake failed');
    const socket = latest();
    // No close event, even when the client tries to dispose of the failed socket.
    vi.spyOn(socket, 'close').mockImplementation(() => {});
    socket.error();
    await rejected;
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'close'] as const)('retries initial handshake %s with backoff and resolves on ready', async (failure) => {
    const pending = connect('ws://test', { WebSocket: FakeSocket });
    const first = latest();
    if (failure === 'error') first.error();
    else first.drop();
    vi.advanceTimersByTime(249);
    expect(latest()).toBe(first);
    vi.advanceTimersByTime(1);
    const second = latest();
    // A late event from the first attempt cannot affect the replacement.
    first.error();
    first.open();
    expect(first.ofType('hello')).toHaveLength(0);
    second.open();
    second.server({ type: 'ready', sessionId: 'sess', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 } });
    const session = await pending;
    expect(session.connected).toBe(true);
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles error then close once and exhausts initial retries', async () => {
    const session = new ClientSession('ws://test', { WebSocket: FakeSocket, reconnect: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 } });
    const reconnecting = vi.fn();
    const closed = vi.fn();
    session.on('reconnecting', reconnecting);
    session.on('closed', closed);
    const pending = expect(session.start()).rejects.toThrow('WebSocket handshake failed');
    for (const delay of [100, 150, 150]) {
      latest().error(); // FakeSocket.close() also emits close synchronously.
      expect(closed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(delay);
    }
    latest().error();
    await pending;
    expect(reconnecting.mock.calls.map(([event]) => event.delayMs)).toEqual([100, 150, 150]);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close cancels a pending initial retry and rejects start', async () => {
    const session = new ClientSession('ws://test', { WebSocket: FakeSocket });
    const pending = expect(session.start()).rejects.toThrow('client closed');
    latest().error();
    await session.close();
    await pending;
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors maxAttempts zero on the first handshake failure', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket, reconnect: { maxAttempts: 0 } });
    const rejected = expect(pending).rejects.toThrow('WebSocket handshake failed');
    latest().error();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('cleans up a failed reconnect after an established session closes', async () => {
    const { session, socket, events } = await start();
    socket.drop();
    vi.advanceTimersByTime(250);
    const failed = latest();
    vi.spyOn(failed, 'close').mockImplementation(() => {});
    failed.error();
    expect(events.filter((event) => event.type === 'reconnecting')).toHaveLength(2);
    await session.close();
    failed.drop();
    vi.advanceTimersByTime(10_000);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores error after open and waits for close as before', async () => {
    const { session, socket, events } = await start();
    socket.error();
    expect(session.connected).toBe(true);
    expect(events).toEqual([]);
    await session.close();
  });

  it('rejects a real Node WebSocket upgrade answered with HTTP 404', async () => {
    vi.useRealTimers();
    const server = createServer();
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address() as { port: number };
      await expect(connect(`ws://127.0.0.1:${address.port}`, { reconnect: false })).rejects.toThrow('WebSocket handshake failed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('works text-only: sends text, emits transcripts and ignores audio frames', async () => {
    const { session, socket, events } = await start();
    session.sendText('hi');
    socket.server({ type: 'audio.start', itemId: 'a1', responseId: 'r1', epoch: 1 });
    socket.binary(encodeAudioFrame(2, 0, new Uint8Array(4)));
    socket.server({ type: 'transcript', role: 'agent', itemId: 'a1', text: 'Hello', final: true });
    expect(socket.ofType('text')).toMatchObject([{ seq: 1, text: 'hi' }]);
    expect(events.filter((e) => e.type === 'transcript')).toEqual([{ type: 'transcript', role: 'agent', itemId: 'a1', text: 'Hello', final: true }]);
  });
});

describe('tool host', () => {
  it('runs calls one at a time in arrival order and returns results', async () => {
    const order: string[] = [];
    const first = deferred();
    const { socket } = await start({
      tools: {
        a: { parameters: {}, run: async () => { order.push('a:start'); await first.promise; order.push('a:end'); return 'A'; } },
        b: { parameters: {}, run: () => { order.push('b'); return 'B'; } },
      },
    });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't', name: 'a', arguments: {} });
    socket.server({ type: 'tool.call', callId: 'c2', epoch: 1, turnId: 't', name: 'b', arguments: {} });
    await flush();
    expect(order).toEqual(['a:start']);
    first.resolve(undefined);
    await flush();
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    expect(socket.ofType('tool.result').map((r) => [r.callId, r.ok ? r.output : r.code])).toEqual([['c1', 'A'], ['c2', 'B']]);
  });

  it('interrupt() closes the epoch: running call aborted, queued and later calls never run', async () => {
    const run = vi.fn();
    let signal: AbortSignal | undefined;
    const { session, socket, events } = await start({
      tools: {
        slow: { parameters: {}, run: (_args, ctx) => { signal = ctx.signal; return new Promise(() => {}); } },
        fast: { parameters: {}, run },
      },
    });
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 3, state: 'acting' });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 3, turnId: 't1', name: 'slow', arguments: {} });
    socket.server({ type: 'tool.call', callId: 'c2', epoch: 3, turnId: 't1', name: 'fast', arguments: {} });
    await flush();
    session.interrupt();
    expect(socket.ofType('interrupt')).toMatchObject([{ epoch: 3, reason: 'user' }]);
    expect(signal?.aborted).toBe(true);
    socket.server({ type: 'tool.call', callId: 'c3', epoch: 3, turnId: 't1', name: 'fast', arguments: {} });
    await flush();
    expect(run).not.toHaveBeenCalled();
    const results = socket.ofType('tool.result');
    expect(results.map((r) => [r.callId, r.ok ? 'ok' : r.code])).toEqual([['c2', 'INTERRUPTED'], ['c3', 'INTERRUPTED'], ['c1', 'INTERRUPTED']]);
    expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(3);

    socket.server({ type: 'tool.call', callId: 'c4', epoch: 4, turnId: 't2', name: 'fast', arguments: { n: 1 } });
    await flush();
    expect(run).toHaveBeenCalledWith({ n: 1 }, expect.objectContaining({ callId: 'c4', turnId: 't2', epoch: 4 }));
    expect(events.filter((e) => e.type === 'tool.result').at(-1)).toMatchObject({ callId: 'c4', turnId: 't2' });
  });

  it('a server interrupted message closes the epoch too', async () => {
    const run = vi.fn();
    const gate = deferred();
    const { socket, events } = await start({ tools: { wait: { parameters: {}, run: () => gate.promise }, t: { parameters: {}, run } } });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 2, turnId: 't', name: 'wait', arguments: {} });
    socket.server({ type: 'tool.call', callId: 'c2', epoch: 2, turnId: 't', name: 't', arguments: {} });
    socket.server({ type: 'interrupted', epoch: 2 });
    gate.resolve(undefined);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
  });

  it('answers a tool that returns nothing with output null, and sends a cleared context as null', async () => {
    const { session, socket } = await start({ tools: { fire: { parameters: {}, run: () => undefined } } });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't', name: 'fire', arguments: {} });
    await flush();
    expect(socket.ofType('tool.result')[0]).toMatchObject({ callId: 'c1', ok: true, output: null });
    session.setContext(undefined);
    expect(socket.ofType('context')).toMatchObject([{ context: null }]);
  });

  it('reports unknown tools, thrown errors and previews', async () => {
    const { socket, events } = await start({ tools: { bad: { parameters: {}, run: () => { throw new Error('nope'); } } } });
    socket.server({ type: 'tool.call.delta', callId: 'c0', epoch: 1, name: 'bad', preview: { argumentsDelta: '{' } });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't', name: 'missing', arguments: {} });
    socket.server({ type: 'tool.call', callId: 'c2', epoch: 1, turnId: 't', name: 'bad', arguments: {} });
    await flush();
    expect(socket.ofType('tool.result').map((r) => (r.ok ? 'ok' : `${r.code}:${r.message}`))).toEqual(['FAILED:Unknown client tool: missing', 'FAILED:nope']);
    expect(events.find((e) => e.type === 'tool.preview')).toMatchObject({ callId: 'c0', preview: { argumentsDelta: '{' } });
  });
});

describe('epoch gate races (#22 batch B)', () => {
  const pcm = { encoding: 'pcm16', sampleRate: 24000 } as const;

  it('never starts a call whose epoch closes between queueing and running', async () => {
    const run = vi.fn();
    const { session, socket, events } = await start({ tools: { fire: { parameters: {}, run } } });
    // The interrupt lands in a microtask queued before the one that would start the tool.
    session.on('tool.call', () => queueMicrotask(() => session.interrupt()));
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 1, state: 'acting' });
    socket.server({ type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't1', name: 'fire', arguments: {} });
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(socket.ofType('tool.result')).toMatchObject([{ callId: 'c1', ok: false, code: 'INTERRUPTED', message: 'Interrupted before it started' }]);
    expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(1);
  });

  it('tells the app about a local interrupt at once, without waiting for the server', async () => {
    const { session, socket, events } = await start();
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 2, state: 'speaking' });
    session.interrupt('keyboard');
    expect(events.at(-1)).toEqual({ type: 'interrupted', epoch: 2, source: 'local' });
    expect(socket.ofType('interrupt')).toMatchObject([{ epoch: 2, reason: 'keyboard' }]);
  });

  it('reports each closed epoch once: the server confirming a local interrupt adds nothing', async () => {
    const { session, socket, events } = await start();
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 2, state: 'speaking' });
    session.interrupt();
    session.interrupt();
    socket.server({ type: 'interrupted', epoch: 2 });
    socket.server({ type: 'interrupted', epoch: 3 });
    expect(events.filter((e) => e.type === 'interrupted')).toEqual([
      { type: 'interrupted', epoch: 2, source: 'local' },
      { type: 'interrupted', epoch: 3, source: 'server' },
    ]);
  });

  it('drops previews of closed epochs, including ones that arrive after the interrupt', async () => {
    const { session, socket, events } = await start();
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 1, state: 'acting' });
    socket.server({ type: 'tool.call.delta', callId: 'c1', epoch: 1, name: 'paint', preview: { argumentsDelta: '{"co' } });
    session.interrupt();
    socket.server({ type: 'tool.call.delta', callId: 'c1', epoch: 1, name: 'paint', preview: { argumentsDelta: 'lor"' } });
    socket.server({ type: 'tool.call.delta', callId: 'c2', epoch: 2, name: 'paint', preview: { argumentsDelta: '{' } });
    expect(events.filter((e) => e.type === 'tool.preview').map((e) => (e as { callId: string }).callId)).toEqual(['c1', 'c2']);
  });

  it('applies a preview or call resent after a reconnect only once', async () => {
    const run = vi.fn();
    const { socket, events } = await start({ tools: { paint: { parameters: {}, run } } });
    const delta = { type: 'tool.call.delta', callId: 'c1', epoch: 1, name: 'paint', preview: { argumentsDelta: '{}' } } as const;
    const call = { type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't1', name: 'paint', arguments: {} } as const;
    socket.server(delta, 1);
    socket.server(call, 2);
    await flush();
    socket.drop(1006);
    vi.advanceTimersByTime(250);
    const second = latest();
    second.open();
    expect(second.ofType('hello')[0]).toMatchObject({ resumeFrom: 2 });
    second.server({ type: 'ready', sessionId: 'sess', input: pcm, output: pcm, resumedFrom: 0 });
    // A server that resends from an older point than the client reported: duplicates by seq.
    second.server(delta, 1);
    second.server(call, 2);
    await flush();
    expect(events.filter((e) => e.type === 'tool.preview')).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not report an interruption when the session closes', async () => {
    const { session, socket, events } = await start();
    socket.server({ type: 'turn.state', turnId: 't1', epoch: 1, state: 'speaking' });
    await session.close();
    expect(events.some((e) => e.type === 'interrupted')).toBe(false);
  });
});

describe('audio output', () => {
  function fakeSink() {
    const enqueued: [string, number[]][] = [];
    let played: Record<string, number> = {};
    const sink: AudioSink = {
      enqueue: (item, pcm) => { enqueued.push([item, Array.from(pcm)]); played[item] = (played[item] ?? 0) + 10; },
      flush: async () => { const p = played; played = {}; return p; },
      close: async () => {},
    };
    return { sink, enqueued };
  }

  it('plays frames for the announced item, flushes on interrupt and reports playback', async () => {
    const { sink, enqueued } = fakeSink();
    const { session, socket } = await start({ audio: { output: sink } });
    expect(socket.ofType('hello')[0]).toMatchObject({ output: { encoding: 'pcm16', sampleRate: 24000 } });
    socket.server({ type: 'audio.start', itemId: 'a1', responseId: 'r1', epoch: 1 });
    socket.binary(encodeAudioFrame(2, 0, new Uint8Array([1, 2])));
    expect(enqueued).toEqual([['a1', [1, 2]]]);
    session.interrupt();
    await flush();
    expect(socket.ofType('playback')).toMatchObject([{ itemId: 'a1', playedMs: 10 }]);
    socket.binary(encodeAudioFrame(2, 1, new Uint8Array([3, 4])));
    expect(enqueued).toHaveLength(1);
  });

  it('barge-in: a listening state flushes playback at once', async () => {
    const { sink } = fakeSink();
    const flushSpy = vi.spyOn(sink, 'flush');
    const { socket } = await start({ audio: { output: sink } });
    socket.server({ type: 'turn.state', turnId: 't2', epoch: 2, state: 'listening' });
    expect(flushSpy).toHaveBeenCalled();
  });

  it('custom capture sends binary input frames once ready', async () => {
    let push: ((pcm: Uint8Array) => void) | undefined;
    const { socket } = await start({ audio: { input: async (_format, onFrame) => { push = onFrame; return { stop: async () => {} }; } } });
    push!(new Uint8Array([7, 7]));
    const frame = socket.sent.find((d): d is Uint8Array => typeof d !== 'string')!;
    expect(decodeAudioFrame(frame)).toMatchObject({ kind: 1, seq: 0 });
  });
});

describe('authentication', () => {
  it('sends the token in hello and calls a token function on every connect', async () => {
    let n = 0;
    const { socket } = await start({ auth: async () => `token-${++n}` });
    await flush();
    expect(socket.ofType('hello')[0]).toMatchObject({ auth: 'token-1' });
    socket.drop(1006);
    vi.advanceTimersByTime(250);
    latest().open();
    await flush();
    expect(latest().ofType('hello')[0]).toMatchObject({ auth: 'token-2', sessionId: 'sess' });
  });

  it('gives up reconnecting on UNAUTHORIZED with a fixed token', async () => {
    const { socket, events } = await start({ auth: 'static' });
    socket.drop(1006);
    vi.advanceTimersByTime(250);
    latest().open();
    await flush();
    latest().server({ type: 'error', code: 'UNAUTHORIZED', message: 'expired', recoverable: false });
    latest().drop(4401);
    vi.advanceTimersByTime(10_000);
    expect(events.at(-1)).toMatchObject({ type: 'closed', code: 4401 });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('fails the connection when the token function throws', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never, auth: () => { throw new Error('no session'); } });
    latest().open();
    await expect(pending).rejects.toThrow(/before ready/);
    expect(latest().closedWith).toEqual([4401, 'auth failed']);
  });
});

describe('reliability', () => {
  it('dedupes server messages and acks in batches', async () => {
    const { socket, events } = await start();
    socket.server({ type: 'transcript', role: 'user', itemId: 'u', text: 'a', final: true }, 1);
    socket.server({ type: 'transcript', role: 'user', itemId: 'u', text: 'a', final: true }, 1);
    expect(events.filter((e) => e.type === 'transcript')).toHaveLength(1);
    expect(socket.ofType('ack')).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(socket.ofType('ack')).toMatchObject([{ upTo: 1, seq: 0 }]);
    for (let i = 2; i < 40; i++) socket.server({ type: 'text', responseId: 'r', delta: 'x' }, i);
    expect(socket.ofType('ack').at(-1)).toMatchObject({ upTo: 33 });
  });

  it('reconnects with backoff, resumes and resends unacknowledged messages', async () => {
    const { session, socket, events } = await start();
    socket.server({ type: 'transcript', role: 'user', itemId: 'u', text: 'a', final: true }, 5);
    session.sendText('one');
    socket.drop(1006);
    session.sendText('two (offline)');
    expect(events.at(-1)).toEqual({ type: 'reconnecting', attempt: 1, delayMs: 250 });
    vi.advanceTimersByTime(250);
    const second = latest();
    expect(second).not.toBe(socket);
    second.open();
    expect(second.ofType('hello')[0]).toMatchObject({ sessionId: 'sess', resumeFrom: 5 });
    second.server({ type: 'ready', sessionId: 'sess', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 }, resumedFrom: 1 });
    await flush();
    expect(second.ofType('text').map((m) => [m.seq, m.text])).toEqual([[2, 'two (offline)']]);
    expect(events.at(-1)).toEqual({ type: 'ready', sessionId: 'sess', resumed: true });
  });

  it('caps the backoff and gives up after maxAttempts', async () => {
    const { socket, events } = await start({ reconnect: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 300 } });
    socket.drop();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000);
      latest().drop();
    }
    expect(events.filter((e) => e.type === 'reconnecting').map((e) => (e as { delayMs: number }).delayMs)).toEqual([100, 200, 300, 300]);
    expect(events.at(-1)).toMatchObject({ type: 'closed' });
  });

  it('stops reconnecting when the server cannot resume', async () => {
    const { socket, events } = await start();
    socket.drop();
    vi.advanceTimersByTime(250);
    latest().open();
    latest().server({ type: 'error', code: 'RESUME_FAILED', message: 'expired', recoverable: false });
    latest().drop(4404);
    expect(events.at(-1)).toMatchObject({ type: 'closed', code: 4404 });
  });

  it('pings on an interval and drops a silent socket', async () => {
    const { socket, events } = await start({ heartbeatMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(socket.ofType('ping')).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(socket.closedWith).toEqual([4000, 'heartbeat timeout']);
    expect(events.at(-1)).toMatchObject({ type: 'reconnecting' });
  });

  it('close() does not reconnect', async () => {
    const { session, socket, events } = await start();
    await session.close();
    expect(socket.closedWith).toEqual([1000, 'client closed']);
    expect(events.map((e) => e.type)).toEqual(['closed']);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

void (null as unknown as ClientSession);
