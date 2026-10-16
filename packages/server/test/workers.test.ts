import { defineAgent } from '@vrealtime/core';
import type { ServerMessage } from '@vrealtime/protocol';
import { fakeModel } from '@vrealtime/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub, upgrade } from '../src/workers/index.js';

type Listener = (event: { data?: unknown }) => void;

/** One end of a fake Workers WebSocketPair: what one end sends, the other receives. */
class PairSocket {
  peer!: PairSocket;
  accepted = false;
  closed = false;
  #listeners: Record<string, Listener[]> = {};
  accept() {
    this.accepted = true;
  }
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string | Uint8Array) {
    for (const l of this.peer.#listeners['message'] ?? []) l({ data });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.#listeners['close'] ?? []) l({});
    this.peer.close();
  }
}

class FakePair {
  0: PairSocket;
  1: PairSocket;
  constructor() {
    this[0] = new PairSocket();
    this[1] = new PairSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

class FakeResponse {
  constructor(readonly body: unknown, readonly init: ResponseInit & { webSocket?: PairSocket }) {}
  get status() {
    return this.init.status;
  }
}

afterEach(() => vi.unstubAllGlobals());

const wsRequest = (upgradeHeader = 'websocket') => new Request('https://agent.example/', { headers: { Upgrade: upgradeHeader } });

describe('upgrade() on Workers', () => {
  it('rejects plain HTTP requests with 426', () => {
    const response = upgrade(defineAgent({ model: fakeModel(), instructions: '' }), new Request('https://agent.example/'));
    expect(response.status).toBe(426);
  });

  it('accepts the server end, returns the client end and speaks protocol v1', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const model = fakeModel();
    const response = upgrade(defineAgent({ model, instructions: '' }), wsRequest()) as unknown as FakeResponse;
    expect(response.status).toBe(101);
    const client = response.init.webSocket!;
    expect(client.peer.accepted).toBe(true);
    const received: ServerMessage[] = [];
    client.addEventListener('message', (e) => received.push(JSON.parse(e.data as string)));
    client.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [] }));
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('ready'));
    client.send(JSON.stringify({ v: 1, seq: 1, type: 'text', text: 'hi' }));
    expect(model.session.commandsOf('sendText')).toEqual([{ type: 'sendText', text: 'hi' }]);
  });

  it('resumes a session through the same hub (e.g. the same Durable Object)', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const model = fakeModel();
    const hub = new Hub(defineAgent({ model, instructions: '' }));
    const first = (upgrade(hub, wsRequest()) as unknown as FakeResponse).init.webSocket!;
    const firstMessages: ServerMessage[] = [];
    first.addEventListener('message', (e) => firstMessages.push(JSON.parse(e.data as string)));
    first.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [] }));
    await vi.waitFor(() => expect(firstMessages[0]?.type).toBe('ready'));
    const sessionId = (firstMessages[0] as Extract<ServerMessage, { type: 'ready' }>).sessionId;
    first.close();

    const second = (upgrade(hub, wsRequest()) as unknown as FakeResponse).init.webSocket!;
    const secondMessages: ServerMessage[] = [];
    second.addEventListener('message', (e) => secondMessages.push(JSON.parse(e.data as string)));
    second.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [], sessionId, resumeFrom: 0 }));
    expect(secondMessages[0]).toMatchObject({ type: 'ready', sessionId, resumedFrom: 0 });
    expect(model.sessions).toHaveLength(1);
  });

  it('explains when WebSocketPair is missing', () => {
    expect(() => upgrade(defineAgent({ model: fakeModel(), instructions: '' }), wsRequest())).toThrow(/WebSocketPair/);
  });
});
