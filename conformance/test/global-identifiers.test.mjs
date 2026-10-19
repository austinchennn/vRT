import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import WebSocket from 'ws';

async function dial(url, end) {
  const socket = new WebSocket(url);
  const messages = [];
  const changed = new Set();
  let failure;
  const notify = () => { for (const listener of [...changed]) listener(); };
  socket.on('message', (bytes, binary) => {
    try {
      if (binary || messages.length >= 256) throw new Error('Unexpected binary frame or trace overflow');
      messages.push(JSON.parse(bytes.toString()));
    } catch (error) { failure = error; }
    notify();
  });
  socket.on('open', notify);
  socket.on('close', notify);
  socket.on('error', (error) => { failure = error; notify(); });
  async function wait(check, deadline, stage) {
    let timer;
    let listener;
    try {
      return await new Promise((resolve, reject) => {
        listener = () => {
          try {
            if (failure) throw failure;
            const value = check();
            if (value) resolve(value);
            else if (socket.readyState === WebSocket.CLOSED) reject(new Error(`Connection closed: ${stage}`));
          } catch (error) { reject(error); }
        };
        changed.add(listener);
        timer = setTimeout(() => reject(new Error(`Deadline: ${stage}`)), Math.max(0, deadline - performance.now()));
        listener();
      });
    } finally { clearTimeout(timer); changed.delete(listener); }
  }
  const peer = {
    socket, messages,
    send: (message) => socket.send(JSON.stringify(message)),
    expect: (predicate, deadline, stage, after = 0) => wait(() => messages.slice(after).find(predicate), deadline, stage),
    closed: (deadline) => wait(() => socket.readyState === WebSocket.CLOSED, deadline, 'close'),
    async dispose() { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); await peer.closed(performance.now() + 1000); },
  };
  try { await wait(() => socket.readyState === WebSocket.OPEN, end, 'open'); return peer; }
  catch (error) { await peer.dispose(); throw error; }
}

const capability = 'global-tool-ids-v1';
const tool = { name: 'probe', description: 'Identity test', parameters: { type: 'object' } };

// This raw-wire regression is deliberately narrower than a complete reusable CLI conformance profile.
test('negotiated IDs differ across sessions and replay retains the exact call/turn identities', { timeout: 10000 }, async () => {
  const model = fakeModel();
  const server = await serve(defineAgent({ model, instructions: '', clientTools: 'accept' }), { host: '127.0.0.1', port: 0, clock: model.clock, onListening() {} });
  const peers = [];
  const end = performance.now() + 7000;
  const url = server.url.replace('http:', 'ws:');
  async function open(hello = {}) {
    const peer = await dial(url, end); peers.push(peer);
    peer.send({ v: 1, seq: 0, type: 'hello', tools: [tool], capabilities: [capability], ...hello });
    const ready = await peer.expect((frame) => frame.type === 'ready', end, 'global-ID handshake');
    assert.deepEqual(ready.capabilities, [capability]);
    return { peer, ready };
  }
  try {
    const first = await open();
    const second = await open();
    for (const fake of model.sessions) {
      fake.emit({ type: 'response.start', responseId: 'same-response' });
      fake.emit({ type: 'tool.call', responseId: 'same-response', callId: 'same-provider-call', name: 'probe', arguments: {} });
    }
    const call1 = await first.peer.expect((frame) => frame.type === 'tool.call', end, 'first call');
    const call2 = await second.peer.expect((frame) => frame.type === 'tool.call', end, 'second call');
    assert.notEqual(call1.callId, call2.callId, 'call IDs collide across sessions');
    assert.notEqual(call1.turnId, call2.turnId, 'turn IDs collide across sessions');
    first.peer.socket.close(1000, 'resume');
    await first.peer.closed(end);
    const resumed = await open({ sessionId: first.ready.sessionId, resumeFrom: 0, capabilities: [] });
    assert.equal(resumed.ready.sessionId, first.ready.sessionId);
    const replay = await resumed.peer.expect((frame) => frame.type === 'tool.call', end, 'replayed call');
    assert.deepEqual(replay, call1, 'replay changed an existing call or its envelope');
    resumed.peer.send({ v: 1, seq: 1, type: 'tool.result', callId: call2.callId, epoch: call1.epoch, ok: true, output: 'foreign' });
    resumed.peer.send({ v: 1, seq: 0, type: 'ping' });
    await resumed.peer.expect((frame) => frame.type === 'pong', end, 'foreign-result fence');
    assert.equal(model.sessions[0].commandsOf('submitToolResult').length, 0);
    const resultOffset = resumed.peer.messages.length;
    resumed.peer.send({ v: 1, seq: 2, type: 'tool.result', callId: replay.callId, epoch: replay.epoch, ok: true, output: 'first' });
    resumed.peer.send({ v: 1, seq: 0, type: 'ping' });
    await resumed.peer.expect((frame) => frame.type === 'pong', end, 'correct-result fence', resultOffset);
    assert.deepEqual(model.sessions[0].commandsOf('submitToolResult').map((command) => [command.callId, command.output]), [['same-provider-call', 'first']]);
  } finally {
    try { await Promise.all(peers.map((peer) => peer.dispose())); }
    finally { await server.close(); }
  }
});
