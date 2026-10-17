// Intentionally faulty real wire peers. No dependency on SDK or conformance oracle.
import { appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { control } from '../drivers/control.js';
import type { Wire } from '../../report.js';
const [fault = 'none', evidence] = process.argv.slice(2);
let server: WebSocketServer | undefined;
let sessions = 0; const texts: string[] = []; const audio: Wire[] = [];
let emitMarker: (() => void) | undefined;
const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (!current) return;
  for (const socket of current.clients) socket.terminate();
  await new Promise<void>(resolve => current.close(() => resolve()));
}
function classify(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return 'MALFORMED';
  const value = message as Wire;
  if (fault === 'priority' && value.v !== 1 && value.type === 'nope') return 'UNKNOWN_TYPE';
  if (value.v !== 1) return 'UNSUPPORTED_VERSION';
  if (!['hello', 'ping', 'text', 'ack'].includes(value.type)) return 'UNKNOWN_TYPE';
  if (!Number.isInteger(value.seq) || value.seq < 0 || value.seq > 4294967295 ||
      (value.type === 'text' ? value.seq === 0 || typeof value.text !== 'string' : value.seq !== 0) ||
      (value.type === 'hello' && !Array.isArray(value.tools))) return 'INVALID_FIELD';
  return undefined;
}
control(async command => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'readInputs' || command === 'finishInputs') {
    if (command === 'finishInputs' && fault === 'hang-finish') return new Promise(() => {});
    if (command === 'finishInputs') emitMarker?.();
    if (fault === 'missing-observations') return {};
    return { sessions, texts, audio };
  }
  if (command !== 'ready') throw new Error('Unknown input command');
  if (evidence) appendFileSync(evidence, `${process.pid}\n`);
  if (fault === 'exit') process.exit(7);
  if (fault === 'hang-ready') return new Promise(() => {});
  server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  await new Promise<void>(resolve => server!.once('listening', resolve));
  server.on('connection', socket => {
    let bound = false; let seq = 0; let received = 0;
    const buffered: string[] = [];
    const send = (value: Wire) => socket.send(JSON.stringify({ v: 1, ...value }));
    emitMarker = () => {
      const marker = { type: 'transcript', role: 'user', seq: ++seq, itemId: 'input-finish-marker', text: 'input-observation-marker', final: true };
      send(marker);
      if (fault === 'replay-marker') send(marker);
      if (fault === 'conflicting-marker') send({ ...marker, text: 'conflicting-content' });
    };
    const error = (code: string) => {
      send({ type: 'error', seq: bound ? (fault === 'bound-zero' ? 0 : ++seq) : (fault === 'sessionless-positive' ? 1 : 0), code, recoverable: true, message: 'Fixture rejection' });
      if (fault === 'close-error') socket.close(1000, 'incorrect recoverable close');
    };
    socket.on('error', () => {});
    if (fault === 'early-close') { socket.close(1000, 'premature end'); return; }
    socket.on('message', (bytes, binary) => {
      if (binary) {
        const data = Buffer.from(bytes as Buffer);
        if (data.length < 5 || data[0] !== 1) {
          if (fault === 'binary-effect') audio.push({ hex: data.toString('hex'), format });
          error('MALFORMED'); return;
        }
        const hex = data.subarray(5).toString('hex');
        if (!bound) { if (fault === 'buffer-pre') buffered.push(hex); return; }
        if (fault === 'audio-ack' || fault === 'zero-ack') send({ type: 'ack', seq: 0, upTo: fault === 'zero-ack' ? 0 : 1 });
        if (fault === 'audio-sequence') seq++;
        if (hex !== '' || fault !== 'ignore-empty') audio.push({ hex, format });
        return;
      }
      let message: Wire;
      try { message = JSON.parse(bytes.toString()); } catch { error('MALFORMED'); return; }
      const code = classify(message);
      if (code) {
        if (fault === 'advance-invalid' && message?.type === 'text' && message.seq === 1) received = 1;
        if (fault === 'control-effect' && message?.type === 'text') texts.push(String(message.text));
        error(code); return;
      }
      if (message.type === 'hello') {
        bound = true; sessions++;
        for (const hex of buffered) audio.push({ hex, format });
        send({ type: 'ready', seq: 0, sessionId: 'input-fixture', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 } });
      } else if (message.type === 'ping') {
        if (fault === 'unexpected-binary') socket.send(Buffer.from('02000000000000', 'hex'));
        send({ type: 'pong', seq: 0 });
      } else if (message.type === 'text' && message.seq > received) {
        received = message.seq; texts.push(message.text);
        send({ type: 'ack', seq: 0, upTo: received });
      }
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { url: `ws://127.0.0.1:${address.port}`, driverCapabilities: fault === 'legacy' ? [] : ['server-input-validation-v1'] };
}, close);
