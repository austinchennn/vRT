import type { Capabilities } from '@vrealtime/core';
import { describe, expect, it, vi } from 'vitest';
import { createCompatibleModel, fetchSocket, type ProviderSocket, type SocketFactory } from '../src/index.js';

const capabilities = {} as Capabilities;

class OpenSocket implements ProviderSocket {
  readyState = 1;
  sent: string[] = [];
  accepted = false;
  addEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  accept() {
    this.accepted = true;
  }
}

const options = (socket: SocketFactory) => ({
  provider: 'p',
  id: 'm',
  model: 'm',
  url: 'wss://example.test/v1/realtime',
  headers: { Authorization: 'Bearer k' },
  capabilities,
  defaults: {},
  transcriptionModel: 't',
  socket,
});

describe('fetchSocket', () => {
  it('upgrades over fetch with auth headers and accepts the socket', async () => {
    const socket = new OpenSocket();
    const fetchImpl = vi.fn(async () => ({ status: 101, webSocket: socket }));
    const opened = await fetchSocket(fetchImpl)('wss://example.test/v1/realtime', { Authorization: 'Bearer k' });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/v1/realtime', { headers: { Authorization: 'Bearer k', Upgrade: 'websocket' } });
    expect(opened).toBe(socket);
    expect(socket.accepted).toBe(true);
  });

  it('fails clearly when the upgrade is refused', async () => {
    await expect(fetchSocket(async () => ({ status: 401, webSocket: null }))('wss://x.test', {})).rejects.toThrow('HTTP 401');
  });
});

describe('createCompatibleModel', () => {
  it('accepts async factories returning an already-open socket', async () => {
    const socket = new OpenSocket();
    const model = createCompatibleModel(options(async () => socket));
    await model.connect({ instructions: 'hi' });
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'session.update', session: { model: 'm', instructions: 'hi' } });
  });

  it('closes the socket when aborted while the factory is pending', async () => {
    const socket = new OpenSocket();
    const controller = new AbortController();
    const model = createCompatibleModel(options(async () => {
      controller.abort();
      return socket;
    }));
    await expect(model.connect({}, { signal: controller.signal })).rejects.toThrow();
    expect(socket.readyState).toBe(3);
  });
});
