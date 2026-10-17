// Raw-wire implementation: no SDK heartbeat/clock/sequence code is reused.
import { appendFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import type { Wire } from '../../report.js';
import { deferred } from '../deadline.js';
import { control } from '../drivers/control.js';
const [fault = 'none', pidFile] = process.argv.slice(2);
if (pidFile) appendFileSync(pidFile, process.pid + '\n');
let server: WebSocketServer | undefined; let now = 0; let timeout = 0; let settings: Wire;
let holdOpening = false; let released = false;
const sessions = new Set<string>();
const records: { socket: WebSocket; facts: Set<string>; closed: ReturnType<typeof deferred<void>>; lastReceived: number; seq: number; sessionId?: string; pending?: Wire; bufferedPings: number; closeRequestedAt?: number }[] = [];
const changed = new Set<() => void>();
const notify = () => { for (const check of [...changed]) check(); };
function send(record: typeof records[number], message: Wire): void {
  record.socket.send(JSON.stringify({ v: 1, seq: ['ready', 'pong', 'ack'].includes(message.type) ? 0 : message.type === 'error' && !record.sessionId ? 0 : ++record.seq, ...message }));
}
function hello(record: typeof records[number], message: Wire): void {
  if (message.sessionId && !sessions.has(message.sessionId)) {
    send(record, { type: 'error', code: 'RESUME_FAILED', message: 'Unknown session', recoverable: false }); record.socket.close(4404, 'unknown session'); return;
  }
  const id = message.sessionId ?? 'heartbeat-fixture-session';
  if (message.sessionId) record.seq = records.find(prior => prior !== record && prior.sessionId === id)?.seq ?? 0;
  record.sessionId = id; sessions.add(id);
  send(record, { type: 'ready', sessionId: id, input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 }, ...(message.sessionId ? { resumedFrom: 0 } : {}) });
  if (fault === 'control-cursor') send(record, { type: 'turn.state', turnId: 'fixture-idle-turn', epoch: 0, state: 'idle' });
}
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (!current) return;
  for (const record of records) record.socket.terminate();
  await Promise.all(records.map(record => record.closed.promise));
  await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'ready') {
    if (fault === 'no-response') return new Promise(() => {});
    timeout = data.timeoutMs; holdOpening = data.holdOpening;
    settings = { clock: 'virtual', timeoutMs: timeout, delayAllowanceMs: Math.ceil(timeout / 2), resumeWindowMs: data.resumeWindowMs };
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', socket => {
      const record: typeof records[number] = { socket, facts: new Set(['connected']), closed: deferred<void>(), lastReceived: now, seq: 0, bufferedPings: 0 };
      records.push(record); notify();
      socket.on('error', () => {});
      socket.on('close', () => { record.facts.add('closed'); record.closed.resolve(); notify(); });
      socket.on('message', (bytes, binary) => {
        if (binary) {
          if (fault !== 'only-ping') record.lastReceived = now;
          record.facts.add('audio'); notify(); return;
        }
        let message: Wire;
        try { message = JSON.parse(bytes.toString()); }
        catch {
          if (fault !== 'only-ping') record.lastReceived = now;
          send(record, { type: 'error', code: 'MALFORMED', message: 'Invalid JSON', recoverable: true }); return;
        }
        if (fault !== 'only-ping' || message.type === 'ping' || message.type === 'hello') record.lastReceived = now;
        if (message.type === 'ping') {
          if (fault === 'buffer-opening-ping' && record.pending) { record.bufferedPings++; return; }
          send(record, { type: 'pong', ...(fault === 'number-pong' ? { seq: ++record.seq } : {}) });
        } else if (message.type === 'hello') {
          if (holdOpening && !released) { record.pending = message; record.facts.add('opening'); notify(); }
          else hello(record, message);
        } else if (message.type === 'context') {
          record.facts.add(`context:${message.context.heartbeatReceipt}`); notify();
          send(record, { type: 'ack', upTo: message.seq });
        }
      });
    });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    return { url: `ws://127.0.0.1:${address.port}`, timing: settings, driverCapabilities: fault === 'missing-instrumentation' ? [] : ['server-heartbeat-v1'] };
  }
  if (command === 'waitHeartbeat') {
    await new Promise<void>(resolve => {
      const check = () => { if (records[data.connection - 1]?.facts.has(data.event)) { changed.delete(check); resolve(); } };
      changed.add(check); check();
    });
    return { now };
  }
  if (command === 'releaseHeartbeatOpening') {
    if (fault === 'hold-opening') return new Promise(() => {});
    released = true;
    for (const record of records) if (record.pending) {
      hello(record, record.pending); delete record.pending;
      while (record.bufferedPings-- > 0) send(record, { type: 'pong' });
    }
    return {};
  }
  if (command === 'advanceHeartbeat') {
    if (fault === 'clock-error') throw new Error('Injected clock failure');
    if (fault === 'exit') process.exit(7);
    now += data.ms;
    for (const record of records) if (record.socket.readyState === WebSocket.OPEN) {
      if (fault === 'outbound-resets' && record.sessionId) { send(record, { type: 'text', responseId: 'fixture-response', delta: 'server output' }); record.lastReceived = now; }
      if (fault !== 'never-close' && now - record.lastReceived >= (fault === 'early-close' ? timeout / 2 : timeout)) {
        record.closeRequestedAt = now;
        if (fault === 'destroy-session' && record.sessionId) sessions.delete(record.sessionId);
        record.socket.close(fault === 'wrong-close' ? 1000 : 4408, 'heartbeat timeout');
      }
    }
    await setImmediate();
    await Promise.all(records.filter(record => record.socket.readyState === WebSocket.CLOSING).map(record => record.closed.promise));
    return { now, connections: records.map(record => ({ open: record.socket.readyState === WebSocket.OPEN, closeRequestedAt: record.closeRequestedAt })) };
  }
  throw new Error('Unknown heartbeat fixture command');
}, close);
