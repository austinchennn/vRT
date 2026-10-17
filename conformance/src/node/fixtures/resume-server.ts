// Independent, deliberately faulty wire servers. No SDK or oracle implementation reused.
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { control } from '../drivers/control.js';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';
const [fault = 'none', evidence] = process.argv.slice(2);
let server: WebSocketServer | undefined; let active: WebSocket | undefined;
const records: { socket: WebSocket; closed: boolean; done: ReturnType<typeof deferred<void>> }[] = [];
const contexts: unknown[] = []; const emitted: string[] = []; const history: Wire[] = [];
let originalReady: Wire | undefined;
let sessions = 0; let seq = 0; let received = 0;
const changed = new Set<() => void>();
const notify = () => { for (const check of [...changed]) check(); };
const snapshot = () => fault === 'missing-observations' ? {} : ({ sessions, connections: records.length, contexts, emitted, closedConnections: records.flatMap((record, index) => record.closed ? [index + 1] : []) });
const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { changed.delete(check); resolve(); } };
  changed.add(check); check();
});
const send = (socket: WebSocket, message: Wire) => socket.send(JSON.stringify({ v: 1, ...message }));
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (!current) return;
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
      const record = { socket, closed: false, done: deferred<void>() }; records.push(record);
      const number = records.length;
      socket.on('error', () => {});
      socket.on('close', () => { record.closed = true; record.done.resolve(); if (active === socket) active = undefined; notify(); });
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString()) as Wire;
        if (message.type === 'hello') {
          const resume = typeof message.sessionId === 'string';
          if (resume && active?.readyState === WebSocket.OPEN && fault !== 'keep-old') active.close(fault === 'wrong-close' ? 1000 : 4000, 'replaced');
          active = socket;
          if (!resume || fault === 'new-session' || fault === 'new-model') sessions++;
          const ready = { type: 'ready', seq: 0, sessionId: resume && fault === 'new-session' ? 'different-session' : 'resume-fixture',
            input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 },
            ...(resume ? { resumedFrom: fault === 'wrong-cursor' ? 0 : received } : {}) };
          if (!resume) originalReady = ready;
          send(socket, ready);
          if (resume && fault === 'early-second') { socket.close(1000, 'premature resume close'); return; }
          if (resume && fault === 'transient-replay') send(socket, originalReady!);
          if (resume && fault !== 'hold-replay') for (const original of history.filter(item => item.seq > message.resumeFrom)) {
            if ((fault === 'drop-middle' && original.itemId === 'resume-offline-a') || (fault === 'drop-last' && original.itemId === 'resume-offline-b')) continue;
            const item = { ...original, ...(fault === 'changed-content' && original.itemId === 'resume-offline-a' ? { text: 'changed' } : {}), ...(fault === 'renumber' ? { seq: original.seq + 1 } : {}) };
            send(socket, item);
            if (fault === 'replay-repeat') send(socket, item);
            if (fault === 'conflicting-replay') send(socket, { ...item, text: 'conflicting' });
          }
        } else if (message.type === 'context') {
          if (message.seq > received || fault === 'duplicate-context') contexts.push(message.context);
          received = Math.max(received, message.seq); notify();
          send(socket, { type: 'ack', seq: 0, upTo: received });
        } else if (message.type === 'ping') send(socket, { type: 'pong', seq: 0 });
      });
      if (number > 2) socket.close(1008, 'fixture limit');
    });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    return { url: `ws://127.0.0.1:${address.port}`, driverCapabilities: fault === 'legacy' ? [] : fault === 'malformed-capability' ? ['server-resume-replay-v1', 7] : ['server-resume-replay-v1'] };
  }
  if (command === 'emitResume') {
    if (fault === 'exit-emit') process.exit(7);
    for (const marker of data.markers as string[]) {
      emitted.push(marker);
      const message = { v: 1, type: 'transcript', seq: ++seq, role: 'user', itemId: `resume-${marker}`, text: marker, final: true };
      history.push(message);
      if (active?.readyState === WebSocket.OPEN && !(fault === 'hold-replay' && records.length === 2)) send(active, message);
    }
    return snapshot();
  }
  if (command === 'waitResumeContext') {
    if (fault === 'hang-context') return new Promise(() => {});
    await wait(() => contexts.length >= data.count); return snapshot();
  }
  if (command === 'waitResumeClosed') {
    if (fault === 'hang-closed') return new Promise(() => {});
    const record = records[data.connection - 1];
    if (!record) throw new Error('Unknown fixture connection');
    await record.done.promise; return snapshot();
  }
  if (command === 'finishResume') {
    if (fault === 'hang-finish') return new Promise(() => {});
    return snapshot();
  }
  throw new Error('Unknown fixture command');
}, close);
