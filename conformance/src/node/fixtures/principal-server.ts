// Fault branches are independent wire implementations; sdk-throw alone exercises the public SDK hook exception path.
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { control } from '../drivers/control.js';
import { principalServer } from '../drivers/server-principal.js';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';
const [fault = 'none', evidence] = process.argv.slice(2);
let sdk: Awaited<ReturnType<typeof principalServer>> | undefined;
let server: WebSocketServer | undefined; let active: WebSocket | undefined; let tokens: Wire;
const records: { socket: WebSocket; done: boolean; closed: ReturnType<typeof deferred<void>> }[] = [];
const auth: Wire[] = []; const contexts: unknown[] = []; const emitted: string[] = [];
const changed = new Set<() => void>();
let sessions = 0; let seq = 0; let exists = false;
const notify = () => { for (const check of [...changed]) check(); };
const snapshot = () => fault === 'missing-observations' ? {} : ({ sessions, connections: records.length, auth, contexts, emitted,
  closedConnections: records.flatMap((record, index) => record.done ? [index + 1] : []) });
const send = (socket: WebSocket, message: Wire) => socket.send(JSON.stringify({ v: 1, ...message }));
const ready = (socket: WebSocket, resume: boolean) => send(socket, { seq: 0, type: 'ready', sessionId: resume && fault === 'fresh-session' ? 'different-owner' : 'principal-fixture',
  input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 }, ...(resume ? { resumedFrom: fault === 'wrong-cursor' ? 1 : 0 } : {}) });
function refuse(socket: WebSocket, unauthorized: boolean): void {
  const wrong = fault === 'wrong-code' && unauthorized || fault === 'foreign-unauthorized' && !unauthorized;
  const authError = wrong ? !unauthorized : unauthorized;
  send(socket, { seq: fault === 'positive-error' ? 1 : 0, type: 'error', code: authError ? 'UNAUTHORIZED' : 'RESUME_FAILED', recoverable: false,
    message: fault === 'echo-token' ? Object.values(tokens).join(' ') : 'fixture refusal' });
  if (fault !== 'no-close') socket.close(authError ? 4401 : 4404, 'refused');
}
async function close(): Promise<void> {
  await sdk?.close(); const current = server; server = undefined; if (!current) return;
  for (const socket of current.clients) socket.terminate();
  await Promise.all(records.map(record => record.closed.promise));
  await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'ready') {
    tokens = data.tokens;
    if (evidence) appendFileSync(evidence, JSON.stringify({ pid: process.pid, hashes: Object.values(tokens).map(token => createHash('sha256').update(String(token)).digest('hex')) }) + '\n');
    if (fault === 'reject-ready') throw new Error(Object.values(tokens).join(' '));
    if (fault === 'exit' || fault === 'exit-secret') { if (fault === 'exit-secret') console.error(Object.values(tokens).join(' ')); process.exit(7); }
    if (fault === 'hang-ready') return new Promise(() => {});
    if (fault === 'sdk-throw') { sdk = await principalServer(tokens, true); return { url: sdk.url, driverCapabilities: ['server-resume-principal-v1'] }; }
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
    server.on('connection', socket => {
      const record = { socket, done: false, closed: deferred<void>() }; records.push(record);
      socket.on('error', () => {});
      socket.on('close', () => { record.done = true; record.closed.resolve(); if (active === socket) active = undefined; notify(); });
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString()) as Wire;
        if (message.type === 'hello') {
          if (fault === 'hang-auth' && message.sessionId) return;
          const resume = typeof message.sessionId === 'string';
          const label = message.auth === tokens.aliceA ? 'alice-a' : message.auth === tokens.aliceB ? 'alice-b' : message.auth === tokens.bob ? 'bob' : message.auth === undefined ? 'missing' : 'invalid';
          if (!(resume && fault === 'skip-reauth')) auth.push({ label, resume });
          if (resume && fault === 'skip-reauth') { active = socket; ready(socket, true); return; }
          if (label === 'invalid' || label === 'missing') { refuse(socket, true); return; }
          if (!resume) { sessions++; exists = true; active = socket; ready(socket, false); return; }
          if (label === 'bob' || !exists || message.sessionId !== 'principal-fixture' || (label === 'alice-b' && fault === 'token-bound')) {
            if (label === 'bob' && message.sessionId === 'principal-fixture') {
              if (fault === 'accept-foreign') { active = socket; ready(socket, true); return; }
              if (fault === 'leak-ready') ready(socket, true);
              if (fault === 'leak-data') send(socket, { type: 'transcript', seq: 1, role: 'user', itemId: 'private', text: 'private', final: true });
              if (fault === 'close-owner') active?.close(4000, 'incorrect replacement');
              if (fault === 'delete-owner') exists = false;
            }
            refuse(socket, false); return;
          }
          if (fault === 'new-model') sessions++;
          active = socket; ready(socket, true);
        } else if (message.type === 'context') { contexts.push(message.context); notify(); send(socket, { type: 'ack', seq: 0, upTo: message.seq }); }
        else if (message.type === 'ping') send(socket, { type: 'pong', seq: 0 });
      });
      if (records.length > 4) socket.close(1008, 'bounded fixture');
    });
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No principal fixture address');
    const url = `ws://127.0.0.1:${address.port}`;
    return { url: fault === 'url-token' ? `${url}/?token=${tokens.aliceB}` : url, driverCapabilities: fault === 'legacy' ? [] : fault === 'malformed-capability' ? ['server-resume-principal-v1', 7] : ['server-resume-principal-v1'] };
  }
  if (sdk) return sdk.handle(command, data);
  if (command === 'emitPrincipal') {
    if (fault === 'exit-emit') process.exit(7);
    emitted.push(data.marker);
    const message = { type: 'transcript', seq: ++seq, role: 'user', itemId: `principal-${data.marker}`, text: data.marker, final: true };
    if (active?.readyState === WebSocket.OPEN && !(fault === 'hold-owner' && data.marker === 'after')) {
      if (fault === 'early-owner' && data.marker === 'after') active.close(1000, 'early');
      else { send(active, message); if (fault === 'replay-repeat') send(active, message); if (fault === 'conflicting-replay') send(active, { ...message, text: 'conflict' }); }
    }
    return snapshot();
  }
  if (command === 'waitPrincipalClosed') {
    if (fault === 'hang-closed') return new Promise(() => {});
    const record = records[data.connection - 1]; if (!record) throw new Error('Unknown connection');
    await record.closed.promise; return snapshot();
  }
  if (command === 'waitPrincipalContext') {
    if (fault === 'hang-context') return new Promise(() => {});
    await new Promise<void>(resolve => { const check = () => { if (contexts.length) { changed.delete(check); resolve(); } }; changed.add(check); check(); });
    return snapshot();
  }
  if (command === 'finishPrincipal') { if (fault === 'hang-finish') return new Promise(() => {}); return snapshot(); }
  throw new Error('Unknown fixture command');
}, close);
