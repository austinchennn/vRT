// @vitest-environment jsdom
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type Unsequenced } from '@vrealtime/protocol';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtime, type UseRealtimeOptions } from '../src/index.js';

type Listener = (event: any) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  #listeners: Record<string, Listener[]> = {};
  #seq = 0;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.#fire('open', {});
    });
  }
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') return;
    this.sent.push(data);
    const message = JSON.parse(data) as ClientMessage;
    if (message.type === 'hello') this.server({ type: 'ready', sessionId: 'sess', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 } });
  }
  close(code = 1000) {
    this.readyState = 3;
    this.#fire('close', { code });
  }
  server(message: Unsequenced<ServerMessage>) {
    const transient = ['ready', 'audio.start', 'ack', 'pong'].includes(message.type);
    this.#fire('message', { data: JSON.stringify({ v: PROTOCOL_VERSION, seq: transient ? 0 : ++this.#seq, ...message }) });
  }
  ofType(type: string) {
    return this.sent.map((d) => JSON.parse(d)).filter((m) => m.type === type);
  }
  #fire(type: string, event: unknown) {
    for (const listener of this.#listeners[type] ?? []) listener(event);
  }
}

const base: UseRealtimeOptions = { WebSocket: FakeSocket as never, reconnect: false };
const latest = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  FakeSocket.instances = [];
});

describe('useRealtime', () => {
  it('connects on demand and exposes status, state and transcript', async () => {
    const { result } = renderHook(() => useRealtime('ws://test', base));
    expect(result.current.status).toBe('idle');
    await act(() => result.current.connect());
    expect(result.current.status).toBe('connected');
    expect(result.current.session?.sessionId).toBe('sess');

    act(() => {
      latest().server({ type: 'turn.state', turnId: 't', epoch: 1, state: 'speaking' });
      latest().server({ type: 'transcript', role: 'agent', itemId: 'a1', text: 'Hel', final: false });
      latest().server({ type: 'transcript', role: 'agent', itemId: 'a1', text: 'Hello', final: true });
      latest().server({ type: 'text', responseId: 'r2', delta: 'Plain ' });
      latest().server({ type: 'text', responseId: 'r2', delta: 'text' });
    });
    expect(result.current.state).toBe('speaking');
    expect(result.current.transcript).toEqual([
      { itemId: 'a1', role: 'agent', text: 'Hello', final: true },
      { itemId: 'r2', role: 'agent', text: 'Plain text', final: false },
    ]);
  });

  it('connect() is idempotent and autoConnect connects on mount', async () => {
    const { result } = renderHook(() => useRealtime('ws://test', { ...base, autoConnect: true }));
    await waitFor(() => expect(result.current.status).toBe('connected'));
    await act(() => result.current.connect());
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('sendText shows the line locally and interrupt reaches the server', async () => {
    const { result } = renderHook(() => useRealtime('ws://test', base));
    await act(() => result.current.connect());
    act(() => result.current.sendText('hi there'));
    expect(result.current.transcript).toEqual([{ itemId: 'local-1', role: 'user', text: 'hi there', final: true }]);
    expect(latest().ofType('text')).toMatchObject([{ text: 'hi there' }]);
    act(() => result.current.interrupt('keyboard'));
    expect(latest().ofType('interrupt')).toMatchObject([{ reason: 'keyboard' }]);
  });

  it('runs the latest tool closure without reconnecting', async () => {
    let color = 'none';
    const { result, rerender } = renderHook(({ suffix }) => useRealtime('ws://test', {
      ...base,
      tools: { paint: { parameters: {}, run: ({ c }: { c: string }) => { color = c + suffix; return color; } } },
    }), { initialProps: { suffix: '-v1' } });
    await act(() => result.current.connect());
    rerender({ suffix: '-v2' });
    await act(async () => {
      latest().server({ type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't', name: 'paint', arguments: { c: 'red' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(color).toBe('red-v2');
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reports connection failures without throwing', async () => {
    class Refusing extends FakeSocket {
      override send() {
        queueMicrotask(() => this.close(1006));
      }
    }
    const { result } = renderHook(() => useRealtime('ws://test', { ...base, WebSocket: Refusing as never }));
    await act(() => result.current.connect());
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('CONNECT_FAILED');
  });

  it('closes the session on unmount and on disconnect()', async () => {
    const { result, unmount } = renderHook(() => useRealtime('ws://test', base));
    await act(() => result.current.connect());
    const close = vi.spyOn(result.current.session!, 'close');
    unmount();
    expect(close).toHaveBeenCalled();

    const second = renderHook(() => useRealtime('ws://test', base));
    await act(() => second.result.current.connect());
    await act(() => second.result.current.disconnect());
    expect(second.result.current.status).toBe('closed');
    expect(second.result.current.session).toBeUndefined();
  });
});
