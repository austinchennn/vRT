// Intentionally wrong wire peers, plus a deferred-settlement control fixture.
import { appendFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { Wire } from '../../report.js';
import { deferred } from '../deadline.js';
import { control } from '../drivers/control.js';

const mode = process.argv[2] ?? 'deferred-result';
if (process.argv[3]) appendFileSync(process.argv[3], String(process.pid) + '\n');
let socket: WebSocket | undefined;
let seq = 0;
let epoch = 0;
let blocked = '';
let released = false;
const calls = new Map<string, Wire>();
const settled = new Set<string>();
const changed = new Set<() => void>();
const ready = deferred<void>();
const closed = deferred<void>();
const release = deferred<'resolve' | 'reject'>();
let completion: Promise<unknown> = Promise.resolve();
function notify(): void { for (const check of [...changed]) check(); }
const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { changed.delete(check); resolve(); } };
  changed.add(check); check();
});
function send(message: Wire, sequence?: number): void {
  socket!.send(JSON.stringify({ v: 1, seq: sequence ?? ++seq, ...message }));
}
function interrupted(callId: string): void {
  send({ type: 'tool.result', callId, epoch, ok: false, code: 'INTERRUPTED', message: 'cancelled' });
  settled.add(callId); notify();
}
function effects(): Wire {
  return { calls: Object.fromEntries(calls),
    started: [...calls.values()].reduce((sum, call) => sum + call.started, 0),
    committed: [...calls.values()].reduce((sum, call) => sum + call.committed, 0) };
}
async function close(): Promise<void> {
  if (!socket) return;
  socket.close(1000);
  if (!released) { released = true; release.resolve('resolve'); }
  await Promise.allSettled([completion]);
  await closed.promise;
}
control(async (command, data) => {
  switch (command) {
    case 'ready':
      socket = new WebSocket(process.env.VRT_CONFORMANCE_URL!);
      socket.on('error', error => ready.reject(error));
      socket.on('close', () => closed.resolve());
      socket.on('open', () => send({ type: 'hello', tools: [{ name: 'probe', description: '', parameters: {} }] }, 0));
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'ready') ready.resolve();
        if (message.type === 'turn.state') { epoch = message.epoch; notify(); }
        if (message.type !== 'tool.call') return;
        const entry = calls.get(message.callId)!;
        entry.received = true;
        if (message.callId === blocked) {
          entry.started++;
          completion = release.promise.then(outcome => {
            entry.completed++;
            if (!entry.aborted) entry.committed++;
            if (mode === 'deferred-result') interrupted(blocked);
            if (mode === 'late-duplicate') {
              if (outcome === 'reject') send({ type: 'tool.result', callId: blocked, epoch, ok: false, code: 'FAILED', message: 'late rejection' });
              else send({ type: 'tool.result', callId: blocked, epoch, ok: true, output: 'late success' });
            }
            if (mode === 'same-seq-replay') {
              const original = entry.originalResult;
              send(original.message, original.seq);
            }
            notify();
            if (outcome === 'reject') throw new Error('Controlled fixture rejection');
          });
          void completion.catch(() => {});
        } else if (calls.get(blocked)?.aborted) interrupted(message.callId);
        notify();
      });
      await ready.promise;
      return { capabilities: [], driverCapabilities: ['tool-cancellation-v1'] };
    case 'prepareCancellation':
      blocked = data.blockedCallId;
      for (const id of data.callIds) calls.set(id, { received: false, started: 0, committed: 0, aborted: false, completed: 0 });
      return {};
    case 'observe': await wait(() => epoch === data.epoch); return {};
    case 'waitForCall':
      await wait(() => Boolean(calls.get(data.callId)?.[data.phase])); return {};
    case 'readEffects': return effects();
    case 'interrupt': {
      if (mode !== 'ignore-abort') calls.get(blocked)!.aborted = true;
      send({ type: 'interrupt', epoch, reason: 'user' });
      for (const [id, call] of calls) {
        if (!call.received) continue;
        if (id === blocked && mode === 'deferred-result') continue;
        if (id !== blocked && mode === 'start-queued') { call.started++; call.committed++; call.completed++; }
        interrupted(id);
        if (id === blocked) call.originalResult = { seq, message: { type: 'tool.result', callId: id, epoch, ok: false, code: 'INTERRUPTED', message: 'cancelled' } };
      }
      notify(); return {};
    }
    case 'releaseCall':
      if (mode === 'exit-on-release') process.exit(7);
      if (mode === 'hold-release') return await new Promise<never>(() => {});
      if (released) throw new Error('Already released');
      released = true; release.resolve(data.outcome);
      await Promise.allSettled([completion]); return {};
    case 'finish':
      if (mode === 'hang-finish') return await new Promise<never>(() => {});
      await wait(() => data.callIds.every((id: string) => settled.has(id)));
      await Promise.allSettled([completion]); await close(); return effects();
    case 'close': await close(); return {};
    default: throw new Error('Unknown fixture command');
  }
}, close);
