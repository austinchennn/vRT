import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { defineAgent } from '@vrealtime/core';
import { Hub } from '@vrealtime/server';
import { fakeModel } from '@vrealtime/testing';
import type { Wire } from '../../report.js';
import { deferred } from '../deadline.js';

/** Public SDK session/connection APIs behind an observable real WebSocket edge. */
export async function resumeServer() {
  const contexts: unknown[] = []; const emitted: string[] = [];
  const records: { socket: WebSocket; closed: boolean; done: ReturnType<typeof deferred<void>> }[] = [];
  const changed = new Set<() => void>(); let failure: Error | undefined;
  const notify = () => { for (const check of [...changed]) check(); };
  const model = fakeModel();
  const hub = new Hub(defineAgent({ model, instructions: '' }), { onContext(value) {
    if (contexts.length >= 8 || JSON.stringify(value).length > 1024) failure = new Error('Context observation bound exceeded');
    else contexts.push(value);
    notify();
  } });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  server.on('connection', socket => {
    if (records.length >= 2) { socket.close(1008, 'two connections per scenario'); return; }
    const record = { socket, closed: false, done: deferred<void>() }; records.push(record);
    const connection = hub.attach({ send: data => socket.send(data), close: (code, reason) => socket.close(code, reason), get bufferedAmount() { return socket.bufferedAmount; } });
    socket.on('message', (bytes, binary) => connection.receive(binary ? bytes : bytes.toString()));
    socket.on('error', () => {});
    socket.on('close', () => {
      // Acknowledgement only after the SDK's public close handler has run.
      connection.closed(); record.closed = true; record.done.resolve(); notify();
    });
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No resume listener');
  const snapshot = (): Wire => {
    if (failure) throw failure;
    return { sessions: model.sessions.length, connections: records.length,
      contexts: JSON.parse(JSON.stringify(contexts)), emitted: [...emitted],
      closedConnections: records.flatMap((record, index) => record.closed ? [index + 1] : []) };
  };
  const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (failure) { changed.delete(check); reject(failure); }
      else if (predicate()) { changed.delete(check); resolve(); }
    };
    changed.add(check); check();
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Deliver public connection.closed() before hub shutdown, clearing parked timers.
    for (const socket of server.clients) socket.terminate();
    await Promise.all(records.map(record => record.done.promise));
    await hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  })();
  async function handle(command: string, data: Wire): Promise<Wire> {
    if (command === 'emitResume') {
      if (!Array.isArray(data.markers) || data.markers.length < 1 || data.markers.length > 2 || data.markers.some((marker: unknown) => typeof marker !== 'string' || !/^[a-z-]{1,24}$/.test(marker)) || emitted.length + data.markers.length > 8) throw new Error('Invalid/bounded resume markers');
      for (const marker of data.markers as string[]) {
        model.session.emit({ type: 'input.transcript', itemId: `resume-${marker}`, text: marker, final: true });
        emitted.push(marker);
      }
      return snapshot();
    }
    if (command === 'waitResumeContext') {
      if (!Number.isInteger(data.count) || data.count < 1 || data.count > 2) throw new Error('Invalid context count');
      await wait(() => contexts.length >= data.count); return snapshot();
    }
    if (command === 'waitResumeClosed') {
      if (!Number.isInteger(data.connection) || data.connection < 1 || data.connection > 2 || !records[data.connection - 1]) throw new Error('Unknown physical connection');
      await records[data.connection - 1]!.done.promise; return snapshot();
    }
    if (command === 'finishResume') { await setImmediate(); return snapshot(); }
    throw new Error(`Unknown resume command ${command}`);
  }
  return { url: `ws://127.0.0.1:${address.port}`, handle, close };
}
