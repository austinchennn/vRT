import { setImmediate } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { defineAgent, type Clock } from '@vrealtime/core';
import { Hub } from '@vrealtime/server';
import { fakeModel, VirtualClock } from '@vrealtime/testing';
import type { Wire } from '../../report.js';
import { deferred } from '../deadline.js';

/** Public Hub edge adapter: network/clock ownership is instrumentation, not SDK state. */
export async function heartbeatServer(data: Wire) {
  const timeout = data.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000 || data.resumeWindowMs !== timeout * 6 || typeof data.holdOpening !== 'boolean') throw new Error('Invalid heartbeat test configuration');
  const virtual = new VirtualClock();
  const timers = new Set<number>();
  const clock: Clock = {
    now: () => virtual.now(),
    setTimeout(run, ms) {
      const id = virtual.setTimeout(() => { timers.delete(id); run(); }, ms);
      timers.add(id); return id;
    },
    clearTimeout(id) { timers.delete(id as number); virtual.clearTimeout(id as number); },
  };
  const release = deferred<void>();
  const changed = new Set<() => void>();
  const records: { socket: WebSocket; facts: Set<string>; closed: ReturnType<typeof deferred<void>>; closeRequestedAt: number | undefined }[] = [];
  function fact(value: string): void { records.at(-1)?.facts.add(value); for (const notify of [...changed]) notify(); }
  const model = fakeModel({ clock: virtual, onCommand(command) { if (command.type === 'sendAudio') fact('audio'); } });
  const hub = new Hub(defineAgent({ model, instructions: '' }), {
    clock, heartbeatTimeoutMs: timeout, resumeWindowMs: data.resumeWindowMs,
    ...(data.holdOpening ? { authenticate: async () => { fact('opening'); await release.promise; return { id: 'heartbeat-test-principal' }; } } : {}),
    onContext(context) { if (context && typeof context === 'object' && 'heartbeatReceipt' in context) fact(`context:${String(context.heartbeatReceipt)}`); },
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  server.on('connection', socket => {
    const record = { socket, facts: new Set<string>(), closed: deferred<void>(), closeRequestedAt: undefined as number | undefined };
    records.push(record);
    const connection = hub.attach({
      send: value => socket.send(value),
      close(code, reason) { record.closeRequestedAt = virtual.now(); socket.close(code, reason); },
      get bufferedAmount() { return socket.bufferedAmount; },
    });
    socket.on('message', (bytes, binary) => connection.receive(binary ? new Uint8Array(bytes as Buffer) : bytes.toString()));
    socket.on('error', () => connection.closed());
    socket.on('close', () => { connection.closed(); record.facts.add('closed'); record.closed.resolve(); for (const notify of [...changed]) notify(); });
    fact('connected'); // attach and receive listeners installed before confirmation
  });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    return closing ??= (async () => {
      for (const record of records) record.socket.terminate();
      await Promise.all(records.map(record => record.closed.promise));
      release.resolve(); await setImmediate();
      await hub.close();
      for (const id of timers) virtual.clearTimeout(id);
      timers.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
  }
  async function handle(command: string, input: Wire): Promise<Wire> {
    if (command === 'waitHeartbeat') {
      if (!Number.isInteger(input.connection) || input.connection < 1 || input.connection > 2 || !/^(connected|opening|closed|audio|context:[a-z0-9-]+)$/.test(input.event)) throw new Error('Invalid heartbeat barrier');
      await new Promise<void>(resolve => {
        const check = () => { if (records[input.connection - 1]?.facts.has(input.event)) { changed.delete(check); resolve(); } };
        changed.add(check); check();
      });
      return { now: virtual.now() };
    }
    if (command === 'releaseHeartbeatOpening') { release.resolve(); await setImmediate(); return {}; }
    if (command === 'advanceHeartbeat') {
      if (!Number.isInteger(input.ms) || input.ms < 0 || input.ms > timeout * 2 || virtual.now() + input.ms > data.resumeWindowMs + timeout * 3) throw new Error('Invalid/bounded heartbeat clock advance');
      virtual.advance(input.ms); await setImmediate();
      await Promise.all(records.filter(record => record.socket.readyState === WebSocket.CLOSING).map(record => record.closed.promise));
      return { now: virtual.now(), connections: records.map(record => ({ open: record.socket.readyState === WebSocket.OPEN, closeRequestedAt: record.closeRequestedAt })) };
    }
    throw new Error(`Unknown heartbeat command ${command}`);
  }
  return { url: `ws://127.0.0.1:${address.port}`, handle, close, timing: { clock: 'virtual', timeoutMs: timeout, delayAllowanceMs: Math.ceil(timeout / 2), resumeWindowMs: data.resumeWindowMs } };
}
