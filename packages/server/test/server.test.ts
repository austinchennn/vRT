import { defineAgent, tool, type AgentDefinition, type Tool } from '@vrealtime/core';
import { PROTOCOL_VERSION, decodeAudioFrame, encodeAudioFrame, type ClientMessage, type ServerMessage, type Unsequenced } from '@vrealtime/protocol';
import { fakeModel, type FakeModel } from '@vrealtime/testing';
import { describe, expect, it } from 'vitest';
import { Hub, attach, type AttachOptions, type WebSocketLike } from '../src/index.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pcm24 = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;

class FakeSocket implements WebSocketLike {
  sent: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  closedWith: [number | undefined, string | undefined] | undefined;
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
  }
  messages(): ServerMessage[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.messages().filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  frames() {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string').map((d) => decodeAudioFrame(d)!);
  }
}

function setup(agentOptions: Partial<AgentDefinition> = {}, options: AttachOptions = {}) {
  const model = fakeModel();
  const agent = defineAgent({ model, instructions: 'test', clientTools: 'accept', ...agentOptions });
  const hub = new Hub(agent, { clock: model.clock, ...options });
  const connect = () => {
    const socket = new FakeSocket();
    const connection = hub.attach(socket);
    let seq = 0;
    const send = (message: Unsequenced<ClientMessage>, explicitSeq?: number) => {
      const transient = ['hello', 'ack', 'ping'].includes(message.type);
      connection.receive(JSON.stringify({ v: PROTOCOL_VERSION, seq: explicitSeq ?? (transient ? 0 : ++seq), ...message }));
    };
    return { socket, connection, send };
  };
  return { model, agent, hub, connect };
}

async function ready(model: FakeModel, client: ReturnType<ReturnType<typeof setup>['connect']>, hello: Partial<Extract<ClientMessage, { type: 'hello' }>> = {}) {
  client.send({ type: 'hello', tools: [], ...hello });
  await flush();
  return { fake: model.session, ready: client.socket.ofType('ready')[0]! };
}

const paint = { name: 'paint', description: 'paint', parameters: { type: 'object' } };

describe('handshake', () => {
  it('starts a session on hello and replies ready with negotiated formats', async () => {
    const { model, connect, hub } = setup();
    const client = connect();
    const { ready: r, fake } = await ready(model, client, { input: { encoding: 'opus' }, output: { encoding: 'pcm16', sampleRate: 24000 } });
    expect(r).toMatchObject({ type: 'ready', seq: 0, input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 } });
    expect(client.connection.sessionId).toBe(r.sessionId);
    expect(fake.config.inputFormat).toEqual(pcm24);
    expect(hub.size).toBe(1);
  });

  it('rejects messages before hello and malformed input without throwing', async () => {
    const { connect } = setup();
    const client = connect();
    client.send({ type: 'text', text: 'hi' });
    client.connection.receive('{nope');
    client.connection.receive(new Uint8Array([9, 9]));
    expect(client.socket.ofType('error').map((e) => [e.code, e.recoverable])).toEqual([['NO_SESSION', false], ['MALFORMED', true], ['MALFORMED', true]]);
  });

  it('queues control messages that arrive while the session starts', async () => {
    const { model, connect } = setup();
    const client = connect();
    client.send({ type: 'hello', tools: [] });
    client.send({ type: 'text', text: 'early' });
    await flush();
    expect(model.session.commandsOf('sendText')).toEqual([{ type: 'sendText', text: 'early' }]);
  });

  it('answers ping with pong and acks handled messages', async () => {
    const { model, connect } = setup();
    const client = connect();
    await ready(model, client);
    client.send({ type: 'ping' });
    client.send({ type: 'text', text: 'a' });
    client.send({ type: 'text', text: 'dup' }, 1);
    await flush();
    expect(client.socket.ofType('pong')).toHaveLength(1);
    expect(client.socket.ofType('ack').at(-1)).toMatchObject({ upTo: 1 });
    expect(model.session.commandsOf('sendText')).toHaveLength(1);
  });

  it('attach() shares one hub per agent and wires event-style sockets', async () => {
    const model = fakeModel();
    const agent = defineAgent({ model, instructions: '' });
    const listeners: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = Object.assign(new FakeSocket(), { addEventListener: (type: string, l: (event: { data?: unknown }) => void) => { listeners[type] = l; } });
    attach(agent, socket);
    listeners['message']!({ data: JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [] }) });
    await flush();
    expect(socket.ofType('ready')).toHaveLength(1);
  });
});

describe('client tools', () => {
  it('offers client tools, forwards calls with their epoch and returns results', async () => {
    const { model, connect } = setup({ tools: { server_side: tool({ description: '', parameters: {}, run: () => 1 }) as Tool<never, unknown> } });
    const client = connect();
    const { fake } = await ready(model, client, { tools: [paint] });
    expect(fake.config.tools?.map((t) => t.name)).toEqual(['server_side', 'paint']);
    fake.emit({ type: 'input.speech.start', atMs: 0 });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: { color: 'red' } });
    await flush();
    const call = client.socket.ofType('tool.call')[0]!;
    expect(call).toMatchObject({ callId: 'c1', name: 'paint', arguments: { color: 'red' } });
    client.send({ type: 'tool.result', callId: 'c1', epoch: call.epoch, ok: true, output: 'done' });
    expect(fake.commandsOf('submitToolResult')).toEqual([{ type: 'submitToolResult', callId: 'c1', output: 'done', options: { respond: false } }]);
  });

  it('resolves a missing result as TIMEOUT after clientToolTimeoutMs', async () => {
    const { model, connect } = setup({ clientToolTimeoutMs: 500 });
    const client = connect();
    const { fake } = await ready(model, client, { tools: [paint] });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: {} });
    await flush();
    model.clock.advance(500);
    expect(fake.commandsOf('submitToolResult')[0]!.output).toEqual({ error: { code: 'TIMEOUT', message: 'No result within 500 ms' } });
  });

  it('forwards failed results with their code', async () => {
    const { model, connect } = setup();
    const client = connect();
    const { fake } = await ready(model, client, { tools: [paint] });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    fake.emit({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'paint', arguments: {} });
    await flush();
    client.send({ type: 'tool.result', callId: 'c1', epoch: 1, ok: false, code: 'REJECTED', message: 'user said no' });
    expect(fake.commandsOf('submitToolResult')[0]!.output).toEqual({ error: { code: 'REJECTED', message: 'user said no' } });
  });
});

describe('audio, interrupt and playback', () => {
  it('passes input frames to the model and output audio to the socket', async () => {
    const { model, connect } = setup();
    const client = connect();
    const { fake } = await ready(model, client);
    client.connection.receive(encodeAudioFrame(1, 0, new Uint8Array([1, 2, 3, 4])));
    expect(fake.commandsOf('sendAudio')[0]!.chunk).toEqual({ data: new Uint8Array([1, 2, 3, 4]), format: pcm24 });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    fake.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array([5, 6]), format: pcm24 } });
    fake.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array([7, 8]), format: pcm24 } });
    expect(client.socket.ofType('audio.start')).toMatchObject([{ itemId: 'a1', responseId: 'r1', seq: 0 }]);
    expect(client.socket.frames().map((f) => [f.kind, f.seq, Array.from(f.payload)])).toEqual([[2, 0, [5, 6]], [2, 1, [7, 8]]]);
  });

  it('interrupt cancels the model, reports interrupted and truncates to playback', async () => {
    const { model, connect } = setup();
    const client = connect();
    const { fake } = await ready(model, client);
    fake.emit({ type: 'input.speech.start', atMs: 0 });
    fake.emit({ type: 'input.speech.end', atMs: 0 });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    fake.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array(48_000), format: pcm24 } });
    const epoch = client.socket.ofType('audio.start')[0]!.epoch;
    client.send({ type: 'interrupt', epoch, reason: 'user' });
    client.send({ type: 'playback', itemId: 'a1', playedMs: 250 });
    expect(fake.commandsOf('cancel')).toHaveLength(1);
    expect(client.socket.ofType('interrupted')).toMatchObject([{ epoch }]);
    expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 250 }]);
  });

  it('respects backpressure, keeps frame order and drops queued audio on interruption', async () => {
    const { model, connect } = setup({}, { highWaterMark: 100 });
    const client = connect();
    const { fake } = await ready(model, client);
    fake.emit({ type: 'input.speech.start', atMs: 0 });
    fake.emit({ type: 'response.start', responseId: 'r1' });
    client.socket.bufferedAmount = 1000;
    const sentBefore = client.socket.sent.length;
    for (let i = 0; i < 3; i++) fake.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array([i]), format: pcm24 } });
    expect(client.socket.sent.length).toBe(sentBefore);
    model.clock.advance(50);
    expect(client.socket.sent.length).toBe(sentBefore);
    client.socket.bufferedAmount = 0;
    model.clock.advance(10);
    expect(client.socket.frames().map((f) => f.payload[0])).toEqual([0, 1, 2]);

    client.socket.bufferedAmount = 1000;
    fake.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a1', chunk: { data: new Uint8Array([9]), format: pcm24 } });
    client.send({ type: 'interrupt', epoch: 0, reason: 'user' });
    client.socket.bufferedAmount = 0;
    model.clock.advance(10);
    expect(client.socket.frames().map((f) => f.payload[0])).toEqual([0, 1, 2]);
    expect(client.socket.ofType('interrupted')).toHaveLength(1);
  });
});

describe('resume and heartbeat', () => {
  it('resumes a session after a reconnect and resends what the client missed', async () => {
    const { model, connect } = setup();
    const first = connect();
    const { fake, ready: r } = await ready(model, first);
    fake.emit({ type: 'input.transcript', itemId: 'u1', text: 'one', final: true });
    const lastSeen = first.socket.ofType('transcript')[0]!.seq;
    first.connection.closed();
    fake.emit({ type: 'input.transcript', itemId: 'u2', text: 'two', final: true });

    const second = connect();
    second.send({ type: 'text', text: 'before hello' }, 7);
    second.send({ type: 'hello', tools: [], sessionId: r.sessionId, resumeFrom: lastSeen });
    await flush();
    expect(second.socket.ofType('ready')[0]).toMatchObject({ sessionId: r.sessionId, resumedFrom: 0 });
    expect(second.socket.ofType('transcript').map((t) => t.text)).toEqual(['two']);
    expect(model.sessions).toHaveLength(1);
  });

  it('a newer connection replaces the old socket', async () => {
    const { model, connect } = setup();
    const first = connect();
    const { ready: r } = await ready(model, first);
    const second = connect();
    second.send({ type: 'hello', tools: [], sessionId: r.sessionId, resumeFrom: 0 });
    await flush();
    expect(first.socket.closedWith).toEqual([4000, 'replaced by a newer connection']);
    model.session.emit({ type: 'input.transcript', itemId: 'u', text: 'x', final: true });
    expect(first.socket.ofType('transcript')).toHaveLength(0);
    expect(second.socket.ofType('transcript')).toHaveLength(1);
  });

  it('closes the session after the resume window and refuses late resumes', async () => {
    const { model, connect, hub } = setup({}, { resumeWindowMs: 1000 });
    const first = connect();
    const { ready: r, fake } = await ready(model, first);
    first.connection.closed();
    model.clock.advance(1000);
    await flush();
    expect(fake.closed).toBe(true);
    expect(hub.size).toBe(0);
    const late = connect();
    late.send({ type: 'hello', tools: [], sessionId: r.sessionId, resumeFrom: 0 });
    await flush();
    expect(late.socket.ofType('error')[0]).toMatchObject({ code: 'RESUME_FAILED', recoverable: false });
    expect(late.socket.closedWith?.[0]).toBe(4404);
  });

  it('closes silent sockets after the heartbeat timeout', async () => {
    const { model, connect } = setup({}, { heartbeatTimeoutMs: 3000 });
    const client = connect();
    await ready(model, client);
    model.clock.advance(2000);
    client.send({ type: 'ping' });
    model.clock.advance(2000);
    expect(client.socket.closedWith).toBeUndefined();
    model.clock.advance(1500);
    expect(client.socket.closedWith).toEqual([4408, 'heartbeat timeout']);
  });
});
