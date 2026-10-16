import { afterEach, describe, expect, it, vi } from 'vitest';
import { registeredCapabilities } from '../../../scripts/spec.mjs';
import { connect } from '../src/index.js';
import type * as CapabilityModule from '../src/capabilities.js';
import { FakeSocket, latest } from './support/fake-socket.js';

vi.mock('../src/capabilities.js', () => ({ CLIENT_CAPABILITIES: ['demo-v1'] }));

afterEach(() => {
  FakeSocket.instances = [];
  expect(FakeSocket.offSpec.splice(0)).toEqual([]);
});

const pcm = { encoding: 'pcm16', sampleRate: 24000 } as const;

describe('capability negotiation', () => {
  it('offers its capabilities in hello and keeps only those the server confirms', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never });
    const socket = latest();
    socket.open();
    expect(socket.ofType('hello')[0]).toMatchObject({ capabilities: ['demo-v1'] });
    socket.server({ type: 'ready', sessionId: 's', input: pcm, output: pcm, capabilities: ['demo-v1', 'x-never-offered'] });
    const session = await pending;
    expect([...session.capabilities]).toEqual(['demo-v1']);
  });

  it('has none in effect when the server confirms none', async () => {
    const pending = connect('ws://test', { WebSocket: FakeSocket as never });
    latest().open();
    latest().server({ type: 'ready', sessionId: 's', input: pcm, output: pcm });
    expect((await pending).capabilities.size).toBe(0);
  });

  it('claims only tokens from the spec registry (spec/capabilities.json) or private x- tokens', async () => {
    const { CLIENT_CAPABILITIES } = await vi.importActual<typeof CapabilityModule>('../src/capabilities.js');
    const registered = registeredCapabilities();
    expect(CLIENT_CAPABILITIES.filter((token) => !token.startsWith('x-') && !registered.has(token))).toEqual([]);
  });
});
