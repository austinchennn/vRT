// Independent real-wire implementation; faults alter actual recovery behavior.
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { control } from '../drivers/control.js';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';
const [fault = 'none', evidence] = process.argv.slice(2);
let server: WebSocketServer | undefined; let active: WebSocket | undefined;
const records: { socket: WebSocket; closed: boolean; done: ReturnType<typeof deferred<void>> }[] = [];
const acks: Wire[] = []; const emitted: string[] = []; const history: Wire[] = [];
let sessions = 0; let seq = 0; let removed = 0; let sessionClosed = false;
const checks = new Set<() => void>();
const notify = () => { for (const check of [...checks]) check(); };
const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { checks.delete(check); resolve(); } }; checks.add(check); check();
});
const snapshot = () => fault === 'missing-observations' ? {} : ({ sessions, connections: records.length, contexts: [], emitted,
  receivedAcks: acks, closedModels: sessionClosed ? 1 : 0, closedConnections: records.flatMap((record, index) => record.closed ? [index + 1] : []) });
const send = (socket: WebSocket, message: Wire) => socket.send(JSON.stringify({ v: 1, ...message }));
const ready = (socket: WebSocket, resume: boolean) => send(socket, { type: 'ready', seq: 0, sessionId: 'rejection-fixture', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 }, ...(resume ? { resumedFrom: 0 } : {}) });
const refuse = (socket: WebSocket, bound: boolean) => {
  const error = { type: 'error', seq: bound ? (fault === 'bound-zero' ? 0 : ++seq) : (fault === 'unknown-positive' ? 1 : 0), code: 'RESUME_FAILED', message: 'fixture rejection', recoverable: fault === 'recoverable' };
  send(socket, error);
  if (bound && fault === 'error-repeat') send(socket, error);
  if (bound && fault !== 'keep-session') sessionClosed = true;
  if (fault === 'business-after-error') send(socket, { type: 'transcript', seq: ++seq, role: 'user', itemId: 'bad', text: 'bad', final: true });
  if (fault !== 'no-close') socket.close(bound ? (fault === 'alternative-close' ? 1008 : 1000) : (fault === 'unknown-close' ? 1000 : 4404), 'rejected');
};
async function close(): Promise<void> {
  const current = server; server = undefined; if (!current) return;
  for (const socket of current.clients) socket.terminate();
  await Promise.all(records.map(record => record.done.promise));
  await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'ready') {
    if (evidence) appendFileSync(evidence, `${process.pid}\n`);
    if (fault === 'exit') process.exit(7);
    if (fault === 'hang-ready') return new Promise(() => {});
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
    server.on('connection', socket => {
      const record = { socket, closed: false, done: deferred<void>() }; records.push(record); const number = records.length;
      socket.on('error', () => {});
      socket.on('close', () => { record.closed = true; record.done.resolve(); if (active === socket) active = undefined; notify(); });
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString()) as Wire;
        if (message.type === 'hello') {
          if (number === 2 && fault === 'early-second') { socket.close(1000, 'early'); return; }
          const resume = typeof message.sessionId === 'string';
          if (!resume) { sessions++; active = socket; ready(socket, false); return; }
          if (!sessions || sessionClosed || message.sessionId !== 'rejection-fixture') {
            if (fault === 'new-unknown') { sessions++; active = socket; ready(socket, false); }
            else refuse(socket, false);
            return;
          }
          active = socket;
          const ahead = message.resumeFrom > seq;
          const old = message.resumeFrom < removed;
          const rejected = (ahead && fault !== 'accept-ahead') || (old && fault !== 'partial-history') || (message.resumeFrom === removed && removed > 0 && fault === 'reject-boundary');
          if (!(rejected && fault === 'no-ready')) ready(socket, true);
          if (rejected) { refuse(socket, true); return; }
          for (const item of history.filter(item => item.seq > message.resumeFrom && item.seq > removed)) {
            if (fault === 'drop-retained') continue;
            send(socket, fault === 'changed-retained' ? { ...item, text: 'changed' } : item);
            if (fault === 'replay-repeat') send(socket, item);
            if (fault === 'conflicting-replay') send(socket, { ...item, text: 'conflict' });
          }
        } else if (message.type === 'ack') {
          acks.push({ connection: number, upTo: message.upTo }); removed = Math.max(removed, message.upTo); notify();
        } else if (message.type === 'ping') send(socket, { type: 'pong', seq: 0 });
      });
      if (number > 3) socket.close(1008, 'bounded fixture');
    });
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    return { url: `ws://127.0.0.1:${address.port}`, driverCapabilities: fault === 'legacy' ? [] : fault === 'malformed-capability' ? ['server-resume-rejection-v1', 7] : ['server-resume-rejection-v1'], retention: { acknowledged: fault === 'retain-policy' ? 'retain' : 'discard' } };
  }
  if (command === 'emitResume') {
    if (fault === 'exit-emit') process.exit(7);
    for (const marker of data.markers as string[]) {
      emitted.push(marker);
      const message = { v: 1, type: 'transcript', seq: ++seq, role: 'user', itemId: `resume-${marker}`, text: marker, final: true };
      history.push(message); if (active?.readyState === WebSocket.OPEN) send(active, message);
    }
    return snapshot();
  }
  if (command === 'waitResumeAck') {
    if (fault === 'hang-ack') return new Promise(() => {});
    if (fault === 'error-ack') throw new Error('ACK receipt failed');
    await wait(() => acks.some(ack => ack.connection === data.connection && ack.upTo === data.upTo)); return snapshot();
  }
  if (command === 'waitResumeClosed') {
    if (fault === 'hang-closed') return new Promise(() => {});
    const record = records[data.connection - 1]; if (!record) throw new Error('Unknown connection');
    await record.done.promise; return snapshot();
  }
  if (command === 'finishResume') {
    if (fault === 'hang-finish') return new Promise(() => {});
    return snapshot();
  }
  throw new Error('Unknown fixture command');
}, close);
