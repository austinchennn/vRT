import { defineAgent } from '@vrealtime/core';
import { PROTOCOL_VERSION, TRANSIENT_TYPES, type ClientMessage, type ServerMessage, type Unsequenced } from '@vrealtime/protocol';
import { fakeModel, type CapabilityOverrides } from '@vrealtime/testing';
import { describe, expect, it, vi } from 'vitest';
import { registeredCapabilities } from '../../../scripts/spec.mjs';
import { Hub, type WebSocketLike } from '../src/index.js';
import type * as CapabilityModule from '../src/capabilities.js';

// A capability this server would offer when the model streams tool arguments.
vi.mock('../src/capabilities.js', async (importActual) => {
  const actual = await importActual<typeof CapabilityModule>();
  const rules = [{ token: 'demo-v1', available: (model: { tools: { argumentStreaming: boolean } }) => model.tools.argumentStreaming }];
  return { ...actual, CAPABILITY_RULES: rules, supportedCapabilities: (model: never) => actual.supportedCapabilities(model, rules) };
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function connect(hub: Hub) {
  const sent: string[] = [];
  const socket: WebSocketLike = { send: (data) => void (typeof data === 'string' && sent.push(data)), close: () => {} };
  const connection = hub.attach(socket);
  return {
    connection,
    send: (message: Unsequenced<ClientMessage>) => connection.receive(JSON.stringify({ v: PROTOCOL_VERSION, seq: TRANSIENT_TYPES.has(message.type) ? 0 : 1, ...message })),
    ready: () => sent.map((data) => JSON.parse(data) as ServerMessage).find((m): m is Extract<ServerMessage, { type: 'ready' }> => m.type === 'ready'),
  };
}

function hubWith(capabilities: CapabilityOverrides) {
  return new Hub(defineAgent({ model: fakeModel({ capabilities }), instructions: '' }));
}

describe('capability negotiation', () => {
  it('offers what the server implements and the model supports, intersected with the client offer', async () => {
    const hub = hubWith({ tools: { argumentStreaming: true } });
    expect([...hub.capabilities]).toEqual(['demo-v1']);
    const client = connect(hub);
    client.send({ type: 'hello', tools: [], capabilities: ['x-unknown', 'demo-v1', 'demo-v1'] });
    await flush();
    expect(client.ready()).toMatchObject({ capabilities: ['demo-v1'] });
  });

  it('withholds a capability the model cannot support', async () => {
    const hub = hubWith({ tools: { argumentStreaming: false } });
    expect(hub.capabilities.size).toBe(0);
    const client = connect(hub);
    client.send({ type: 'hello', tools: [], capabilities: ['demo-v1'] });
    await flush();
    expect(client.ready()).not.toHaveProperty('capabilities');
  });

  it('keeps the session set on resume, whatever the resuming hello offers', async () => {
    const hub = hubWith({ tools: { argumentStreaming: true } });
    const first = connect(hub);
    first.send({ type: 'hello', tools: [], capabilities: ['demo-v1'] });
    await flush();
    first.connection.closed();
    const second = connect(hub);
    second.send({ type: 'hello', tools: [], sessionId: first.ready()!.sessionId, resumeFrom: 0 });
    await flush();
    expect(second.ready()).toMatchObject({ resumedFrom: 0, capabilities: ['demo-v1'] });
  });
});

describe('capability rules', () => {
  it('claim only tokens from the spec registry (spec/capabilities.json) or private x- tokens', async () => {
    const { CAPABILITY_RULES } = await vi.importActual<typeof CapabilityModule>('../src/capabilities.js');
    const registered = registeredCapabilities();
    expect(CAPABILITY_RULES.map((rule) => rule.token).filter((token) => !token.startsWith('x-') && !registered.has(token))).toEqual([]);
  });
});
