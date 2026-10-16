// Deliberately incorrect wire implementation: exercises the real runner/oracle path.
import WebSocket from 'ws';
import type { Wire } from '../../report.js';
import { deferred } from '../deadline.js';
import { control } from '../drivers/control.js';
let socket: WebSocket | undefined; let seq = 0; let epoch = 0;
let started = 0; let committed = 0;
let pending = Promise.resolve();
const ready = deferred<void>(); const closed = deferred<void>();
const result = deferred<void>(); const observed = deferred<void>();
function send(message: Wire) { socket!.send(JSON.stringify({ v: 1, seq: ['hello'].includes(message.type) ? 0 : ++seq, ...message })); }
async function close() {
  if (!socket) return;
  socket.close(1000); await closed.promise;
}
control(async (command) => {
  if (command === 'ready') {
    socket = new WebSocket(process.env.VRT_CONFORMANCE_URL!);
    socket.on('error', error => ready.reject(error));
    socket.on('close', () => closed.resolve());
    socket.on('open', () => send({ type: 'hello', tools: [{ name: 'probe', description: '', parameters: {} }] }));
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString());
      if (m.type === 'ready') ready.resolve();
      if (m.type === 'turn.state') { epoch = m.epoch; observed.resolve(); }
      if (m.type === 'tool.call') {
        if (process.argv.includes('execute-stale')) { started++; committed++; }
        const outcome = { type: 'tool.result', callId: m.callId, epoch: m.epoch, ok: false, code: 'INTERRUPTED', message: 'interrupted' };
        if (process.argv.includes('wrong-epoch')) outcome.epoch++;
        if (!process.argv.includes('no-result')) send(outcome);
        if (process.argv.includes('delayed-duplicate')) pending = new Promise<void>(resolve => setImmediate(() => { send(outcome); resolve(); }));
        if (process.argv.includes('duplicate-result')) send(outcome); // distinct seq: not retransmission
        if (process.argv.includes('replay-result')) { seq--; send(Object.fromEntries(Object.entries(outcome).reverse())); }
        result.resolve();
      }
    });
    await ready.promise; return { capabilities: [] };
  }
  if (command === 'observe') { await observed.promise; return {}; }
  if (command === 'interrupt') { send({ type: 'interrupt', epoch, reason: 'user' }); return {}; }
  if (command === 'finish') { if (epoch) await result.promise; await pending; await close(); return { started, committed }; }
  if (command === 'readEffects') return { started, committed };
  if (command === 'close') { await close(); return {}; }
  throw new Error('Unknown command');
}, close);
