// Deliberately incorrect wire implementations, independent of the SDK and oracle.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { control } from '../drivers/control.js';
const [fault = 'none', evidenceFile] = process.argv.slice(2);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
let server: WebSocketServer | undefined;
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (!current) return;
  for (const socket of current.clients) socket.terminate();
  await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command !== 'ready') throw new Error('Unknown command');
  const token = data.authToken;
  if (evidenceFile) appendFileSync(evidenceFile, JSON.stringify({ pid: process.pid, tokenHash: digest(token) }) + '\n');
  if (fault === 'exit') { console.error(token); process.exit(7); }
  if (fault === 'hang') return new Promise(() => {});
  if (fault === 'reject-ready') throw new Error(`Deliberate refusal: ${token}`);
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server!.once('listening', resolve));
  server.on('connection', socket => {
    let bound = false; let seq = 0;
    const send = (message: object) => socket.send(JSON.stringify({ v: 1, ...message }));
    socket.on('error', () => {});
    socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); }
      catch {
        const number = bound ? (fault === 'post-seq-zero' ? 0 : ++seq) : (fault === 'pre-seq-positive' ? 1 : 0);
        send({ type: 'error', seq: number, code: 'MALFORMED', recoverable: true, message: 'Malformed JSON' });
        return;
      }
      if (message.type === 'hello') {
        if (evidenceFile && message.auth) appendFileSync(evidenceFile, JSON.stringify({ observedTokenHash: digest(message.auth) }) + '\n');
        if (message.auth !== token && fault !== 'accept-wrong') {
          if (fault === 'close-before-error') { socket.close(4401, 'unauthorized'); return; }
          send({ type: 'error', seq: fault === 'echo-token' ? 1 : 0, code: 'UNAUTHORIZED', recoverable: false,
            message: fault === 'echo-token' ? `${token} ${message.auth ?? ''}` : 'Unauthorized' });
          if (fault !== 'no-close') socket.close(fault === 'wrong-close' ? 1000 : 4401, fault === 'echo-token' ? token : 'unauthorized');
          return;
        }
        bound = true;
        send({ type: 'ready', seq: 0, sessionId: 'fixture-session', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 },
          ...(fault === 'echo-token' ? { capabilities: ['unoffered'] } : {}) });
      } else if (message.type === 'ping') send({ type: 'pong', seq: 0 });
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return { url: `ws://127.0.0.1:${address.port}`, driverCapabilities: ['server-auth-v1'] };
}, close);
