// Independent raw-wire server; faults occur on real WebSocket/control paths.
import { appendFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { control } from '../drivers/control.js';
import type { Wire } from '../../report.js';
const [fault = 'none', pidFile] = process.argv.slice(2);
if (pidFile) appendFileSync(pidFile, process.pid + '\n');
let server: WebSocketServer | undefined; let socket: WebSocket | undefined;
let seq = 0; let negotiated = false; let kind = ''; let ids: string[] = [];
const calls: Record<string, { started: number; committed: number }> = {};
const send = (message: Wire) => {
  const frame = { v: 1, seq: message.seq ?? (['ready', 'pong'].includes(message.type) ? 0 : ++seq), ...message };
  socket!.send(JSON.stringify(frame)); return frame;
};
function phase(id: string, phase: string, data: Wire = {}): void {
  if (!negotiated && fault !== 'unnegotiated-stream') {
    if (phase === 'arguments-delta' || phase === 'progress') send({ type: 'tool.call.delta', callId: id, epoch: 1, name: 'probe', preview: data });
    return;
  }
  if (fault === 'missing-terminal' && phase === 'settled' && id === ids[0]) return;
  const frame = send({ type: 'tool.stream', callId: id, epoch: 1, turnId: 'fixture-turn', name: 'probe', phase, ...data,
    ...(fault === 'output-leak' && phase === 'settled' ? { output: 'conformance-server-only-output' } : {}),
    ...(fault === 'identity-change' && phase === 'progress' ? { epoch: 2 } : {}),
  });
  if (phase === 'settled' && id === ids[0]) {
    if (fault === 'duplicate-terminal') send({ ...frame, seq: ++seq });
    if (fault === 'replay-terminal') socket!.send(JSON.stringify(frame));
    if (fault === 'conflicting-replay') socket!.send(JSON.stringify({ ...frame, ok: false, code: 'FAILED' }));
    if (fault === 'reopen') send({ ...frame, seq: ++seq, phase: 'arguments-delta', delta: 'late' });
  }
}
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (!current) return;
  for (const peer of current.clients) peer.terminate();
  await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async (command, data) => {
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'ready') {
    if (fault === 'hang-ready') return new Promise(() => {});
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    server.on('connection', peer => {
      socket = peer; peer.on('error', () => {});
      peer.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'hello') {
          negotiated = fault !== 'decline-capability' && (message.capabilities ?? []).includes('tool-stream-v1');
          send({ type: 'ready', sessionId: 'fixture-session', input: { encoding: 'pcm16', sampleRate: 24000 }, output: { encoding: 'pcm16', sampleRate: 24000 }, capabilities: fault === 'unoffered-capability' ? ['tool-stream-v1'] : negotiated ? ['tool-stream-v1'] : [] });
        }
        if (message.type === 'ping') send({ type: 'pong' });
        if (message.type === 'interrupt') {
          for (const id of ids) phase(id, 'cancelled');
          send({ type: 'interrupted', epoch: 1, reason: 'user' });
        }
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    return { url: `ws://127.0.0.1:${address.port}`, driverCapabilities: fault === 'malformed-instrumentation' ? 'server-tool-stream-v1' : ['server-tool-stream-v1'] };
  }
  if (command === 'beginStream') {
    kind = data.kind; ids = data.callIds;
    send({ type: 'turn.state', turnId: 'fixture-turn', epoch: 1, state: 'thinking' });
    for (const id of ids) calls[id] = { started: 0, committed: 0 };
    if (kind !== 'no-delta') for (const id of ids) {
      phase(id, 'start');
      if (fault === 'progress-early') phase(id, 'progress', { progress: null });
      phase(id, 'arguments-delta', { delta: '{"value":' });
      phase(id, 'arguments-delta', { delta: '1}' });
    }
    if (fault === 'legacy-with-stream' && negotiated) send({ type: 'tool.call.delta', callId: ids[0], name: 'probe', epoch: 1, preview: null });
    if (fault === 'early-close') socket!.close(1000, 'session ends before scenario');
    return {};
  }
  if (command === 'readStreamEffects') return fault === 'missing-effects' ? { calls: {} } : { calls };
  if (command === 'completeStream') {
    for (const id of ids) {
      if (kind === 'no-delta') phase(id, 'start');
      phase(id, 'arguments-complete', { arguments: { value: 1 } });
      if (fault === 'complete-twice') phase(id, 'arguments-complete', { arguments: { value: 1 } });
    }
    calls[ids[0]!]!.started++;
    if (kind !== 'no-delta') phase(ids[0]!, 'progress', { progress: null });
    return {};
  }
  if (command === 'waitStreamTool') {
    if (fault === 'hold-tool') return new Promise(() => {});
    return {};
  }
  if (command === 'finishStream') {
    if (fault === 'exit') process.exit(7);
    if (fault === 'hang-release') return new Promise(() => {});
    if (kind === 'failed') for (const id of ids) phase(id, 'failed', { message: 'incomplete arguments' });
    else if (kind !== 'cancelled') for (const id of ids) {
      if (calls[id]!.started === 0) { calls[id]!.started++; if (kind !== 'no-delta') phase(id, 'progress', { progress: null }); }
      calls[id]!.committed++;
      phase(id, 'settled', { ok: true });
    }
    return { calls };
  }
  throw new Error('Unknown command');
}, close);
