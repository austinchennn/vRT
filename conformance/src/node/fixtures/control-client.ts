// Deliberately faulty real client implementations, independent of SDK and oracle.
import { appendFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import WebSocket from 'ws';
import { control } from '../drivers/control.js';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';
const [fault = 'none', evidence] = process.argv.slice(2);
let socket: WebSocket | undefined;
let started = 0; let committed = 0; let last = 0; let seq = 0; let epoch = 0; let closed = false;
let prepared = false; let reserved = false;
const errors: Wire[] = []; const events: Wire[] = [];
const changed = new Set<() => void>();
const notify = () => { for (const check of [...changed]) check(); };
const snapshot = () => ({ errors, events, started, committed, closed });
const send = (message: Wire) => socket!.send(JSON.stringify({ v: 1, ...message }));
const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
  const check = () => {
    if (closed) { changed.delete(check); reject(new Error('Fixture closed')); }
    else if (predicate()) { changed.delete(check); resolve(); }
  };
  changed.add(check); check();
});
function classify(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'MALFORMED';
  const message = value as Wire;
  if (fault === 'priority' && message.v !== 1 && message.type === 'nope') return 'UNKNOWN_TYPE';
  if (message.v !== 1) return 'UNSUPPORTED_VERSION';
  if (!['ready', 'turn.state', 'tool.call', 'transcript', 'interrupted', 'pong', 'ack', 'text'].includes(message.type)) return 'UNKNOWN_TYPE';
  const transient = ['ready', 'pong', 'ack'].includes(message.type);
  if (!Number.isInteger(message.seq) || message.seq < (transient ? 0 : 1) || message.seq > 4294967295 || (transient && message.seq !== 0)) return 'INVALID_FIELD';
  if (message.type === 'turn.state' && (!Number.isInteger(message.epoch) || !['thinking', 'acting', 'idle', 'listening', 'speaking'].includes(message.state) || typeof message.turnId !== 'string')) return 'INVALID_FIELD';
  if (message.type === 'tool.call' && (!Number.isInteger(message.epoch) || message.epoch < 0 || typeof message.name !== 'string' || typeof message.callId !== 'string' || typeof message.turnId !== 'string' || !Object.hasOwn(message, 'arguments'))) return 'INVALID_FIELD';
  if (message.type === 'text' && (typeof message.delta !== 'string' || typeof message.responseId !== 'string')) return 'INVALID_FIELD';
  return undefined;
}
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const done = new Promise<void>(resolve => socket!.once('close', () => resolve()));
  socket.close(1000, 'fixture complete'); await done;
})();
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'ready') {
    if (evidence) appendFileSync(evidence, `${process.pid}\n`);
    if (fault === 'exit') process.exit(7);
    if (fault === 'hang-ready') return new Promise(() => {});
    const ready = deferred<void>();
    socket = new WebSocket(process.env.VRT_CONFORMANCE_URL!);
    socket.on('open', () => send({ seq: 0, type: 'hello', tools: [{ name: 'probe', description: 'Fixture probe', parameters: { type: 'object' } }] }));
    socket.on('close', () => { closed = true; ready.reject(new Error('Closed during ready')); notify(); });
    socket.on('error', error => ready.reject(error));
    socket.on('message', bytes => {
      let message: Wire; let code: string | undefined;
      try { message = JSON.parse(bytes.toString()); code = classify(message); }
      catch { message = {}; code = 'MALFORMED'; }
      if (code) {
        if (fault === 'exit-on-error') process.exit(7);
        if (fault !== 'ignore-error') errors.push({ code, recoverable: true });
        if (fault === 'execute-invalid' && message.type === 'tool.call') { started++; committed++; }
        if (fault === 'advance-invalid' && typeof message.seq === 'number') last = Math.max(last, message.seq);
        if (fault === 'reserve-invalid' && message.type === 'tool.call') reserved = true;
        if (fault === 'epoch-invalid' && message.type === 'turn.state') epoch = Math.max(epoch, message.epoch);
        notify();
        if (fault === 'close-error') socket!.close(1000, 'incorrect close');
        return;
      }
      if (message.type === 'ready') { ready.resolve(); return; }
      if (message.seq > 0) {
        if (message.seq <= last) return;
        last = message.seq;
      }
      if (message.type === 'turn.state') {
        epoch = Math.max(epoch, message.epoch);
        events.push({ type: 'state', turnId: message.turnId, epoch: message.epoch, state: message.state }); notify();
      } else if (message.type === 'tool.call') {
        if (reserved || fault === 'hold-call') return;
        events.push({ type: 'tool.call', callId: message.callId, turnId: message.turnId, epoch: message.epoch });
        started++; committed++;
        const result = { type: 'tool.result', seq: ++seq, callId: message.callId, epoch: message.epoch, ok: true, output: null };
        send(result);
        if (fault === 'replay-result') send(result);
        if (fault === 'conflicting-result') send({ ...result, output: 'changed' });
        if (fault === 'duplicate-result') send({ ...result, seq: ++seq });
        events.push({ type: 'tool.result', callId: message.callId, turnId: message.turnId, epoch: message.epoch }); notify();
      } else if (message.type === 'transcript') { events.push({ ...message }); notify(); }
    });
    await ready.promise;
    return { capabilities: [], driverCapabilities: fault === 'legacy' ? [] : fault === 'malformed-capability' ? ['client-control-validation-v1', 7] : ['client-control-validation-v1'] };
  }
  if (command === 'prepareControl') {
    if (prepared) throw new Error('Repeated preparation');
    prepared = true; return fault === 'missing-observations' ? {} : snapshot();
  }
  if (command === 'waitControlErrors') { await wait(() => errors.length >= data.count); return snapshot(); }
  if (command === 'waitControlMarker') { await wait(() => events.some(event => event.type === 'transcript' && event.itemId === data.itemId)); return snapshot(); }
  if (command === 'interrupt') {
    send({ type: 'interrupt', seq: ++seq, epoch, reason: 'user' });
    events.push({ type: 'interrupted', epoch }); return {};
  }
  if (command === 'finishControl') {
    if (fault === 'hang-finish') return new Promise(() => {});
    await setImmediate(); await close(); return snapshot();
  }
  throw new Error('Unknown fixture command');
}, close);
