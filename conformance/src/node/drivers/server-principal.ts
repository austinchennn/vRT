import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { defineAgent } from '@vrealtime/core';
import { Hub } from '@vrealtime/server';
import { fakeModel } from '@vrealtime/testing';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';

/** Public authenticated Hub edge; neither session ownership nor recovery is simulated here. */
export async function principalServer(tokens: Wire, throwInvalid = false) {
  if (['aliceA', 'aliceB', 'bob', 'invalid'].some(key => typeof tokens?.[key] !== 'string' || !/^[a-f0-9]{64}$/.test(tokens[key])) || new Set(Object.values(tokens)).size !== 4) throw new Error('Expected four distinct ephemeral credentials');
  const auth: Wire[] = []; const contexts: unknown[] = []; const emitted: string[] = [];
  const records: { socket: WebSocket; closed: ReturnType<typeof deferred<void>>; done: boolean }[] = [];
  const changed = new Set<() => void>(); let failure: Error | undefined;
  const notify = () => { for (const check of [...changed]) check(); };
  const model = fakeModel();
  const hub = new Hub(defineAgent({ model, instructions: '' }), {
    authenticate({ token, sessionId }) {
      const label = token === tokens.aliceA ? 'alice-a' : token === tokens.aliceB ? 'alice-b' : token === tokens.bob ? 'bob' : token === undefined ? 'missing' : 'invalid';
      if (auth.length >= 8) { failure = new Error('Authentication observation bound exceeded'); throw failure; }
      auth.push({ label, resume: sessionId !== undefined }); notify();
      if (label.startsWith('alice-')) return { id: 'principal-alice' }; // A fresh object on every hello.
      if (label === 'bob') return { id: 'principal-bob' };
      if (throwInvalid) throw new Error('Test authentication refusal');
      return undefined;
    },
    onContext(value) {
      if (contexts.length >= 4 || JSON.stringify(value).length > 1024) failure = new Error('Context observation bound exceeded');
      else contexts.push(value);
      notify();
    },
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  server.on('connection', socket => {
    if (records.length >= 4) { socket.close(1008, 'scenario connection limit'); return; }
    const record = { socket, closed: deferred<void>(), done: false }; records.push(record);
    const connection = hub.attach({ send: value => socket.send(value), close: (code, reason) => socket.close(code, reason), get bufferedAmount() { return socket.bufferedAmount; } });
    socket.on('message', (bytes, binary) => connection.receive(binary ? bytes : bytes.toString()));
    socket.on('error', () => {});
    socket.on('close', () => { connection.closed(); record.done = true; record.closed.resolve(); notify(); });
  });
  await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No principal listener');
  const snapshot = (): Wire => {
    if (failure) throw failure;
    return { sessions: model.sessions.length, connections: records.length, auth: auth.map(value => ({ ...value })),
      contexts: JSON.parse(JSON.stringify(contexts)), emitted: [...emitted], closedConnections: records.flatMap((record, index) => record.done ? [index + 1] : []) };
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    for (const socket of server.clients) socket.terminate();
    await Promise.all(records.map(record => record.closed.promise));
    await hub.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  })();
  async function handle(command: string, data: Wire): Promise<Wire> {
    if (command === 'emitPrincipal') {
      if (!['before', 'after'].includes(data.marker) || emitted.length >= 2) throw new Error('Invalid/bounded model marker');
      model.session.emit({ type: 'input.transcript', itemId: `principal-${data.marker}`, text: data.marker, final: true });
      emitted.push(data.marker); return snapshot();
    }
    if (command === 'waitPrincipalClosed') {
      if (!Number.isInteger(data.connection) || data.connection < 1 || data.connection > 4 || !records[data.connection - 1]) throw new Error('Unknown physical connection');
      await records[data.connection - 1]!.closed.promise; return snapshot();
    }
    if (command === 'waitPrincipalContext') {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (failure) { changed.delete(check); reject(failure); }
          else if (contexts.length >= 1) { changed.delete(check); resolve(); }
        };
        changed.add(check); check();
      });
      return snapshot();
    }
    if (command === 'finishPrincipal') { await setImmediate(); return snapshot(); }
    throw new Error(`Unknown principal command ${command}`);
  }
  return { url: `ws://127.0.0.1:${address.port}`, handle, close };
}
