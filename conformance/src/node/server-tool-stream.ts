import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { STREAM_CAPABILITY } from '../tool-stream-oracle.js';
import type { Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';
export const STREAM_PROFILE = 'server-tool-stream-v1';
export const STREAM_KINDS = ['baseline', 'lifecycle', 'no-delta', 'failed', 'cancelled'] as const;
export const STREAM_CASES = STREAM_KINDS.map(kind => `server/tool-stream/${kind}`);
export class IncompleteStream extends Error {}

export async function serverToolStream(
  id: string, peer: Peer, driver: ProcessDriver, oracle: Oracle, hello: Wire,
  end: number, stage: (value: string) => void,
): Promise<Wire> {
  const kind = id.split('/').at(-1)!;
  const baseline = kind === 'baseline';
  const ids = kind === 'lifecycle' ? ['stream-a', 'stream-b'] : ['stream-a'];
  let capabilities: string[] = [];
  async function fence(label: string): Promise<void> {
    stage(label); const offset = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    await peer.expect(m => m.type === 'pong', end, label, offset);
  }
  try {
    stage('stream handshake');
    peer.send({ ...hello, ...(!baseline ? { capabilities: [STREAM_CAPABILITY] } : {}) });
    const ready = await peer.expect(m => m.type === 'ready' || m.type === 'error', end, 'stream ready');
    oracle.message('server', ready);
    if (ready.type !== 'ready') throw new Error('Expected ready');
    capabilities = ready.capabilities ?? [];
    if (capabilities.some(token => baseline || token !== STREAM_CAPABILITY) || new Set(capabilities).size !== capabilities.length) throw new Error('Server enabled unoffered/duplicate capability');
    if (!baseline && !capabilities.includes(STREAM_CAPABILITY)) throw new IncompleteStream('Required optional tool-stream-v1 was not negotiated');
    stage('begin parameter stream');
    await driver.request('beginStream', { kind, callIds: ids }, end);
    await fence('parameter wire fence');
    oracle.streams(peer.messages, capabilities, ids, false);
    const before = await driver.request('readStreamEffects', {}, end);
    if (ids.some(id => before.calls?.[id]?.started !== 0 || before.calls?.[id]?.committed !== 0)) throw new Error(`Missing/nonzero effects during partial arguments: ${JSON.stringify(before)}`);
    if (!baseline && kind !== 'no-delta' && !peer.messages.some(m => m.type === 'tool.stream' && m.phase === 'arguments-delta')) throw new Error('Fixture did not produce required argument fragments');
    if (kind === 'cancelled') {
      // §6.1 observes epochs through state/audio/calls, not display-only tool.stream.
      const observed = Math.max(-1, ...peer.messages.filter(m => ['turn.state', 'audio.start', 'tool.call'].includes(m.type)).map(m => m.epoch));
      const first = peer.messages.find(m => m.type === 'tool.stream')!;
      if (observed < 0 || first.epoch !== observed) throw new IncompleteStream('Fixture needs an observed live epoch before interrupt');
      stage('wire interrupt'); peer.send({ v: 1, seq: 1, type: 'interrupt', epoch: observed, reason: 'user' });
      await peer.expect(m => m.type === 'interrupted' && m.epoch === observed, end, 'interrupt confirmation');
    } else if (kind !== 'failed') {
      stage('complete arguments'); await driver.request('completeStream', {}, end);
      stage('tool blocked before commit'); await driver.request('waitStreamTool', {}, end);
      await fence('progress wire fence');
      oracle.streams(peer.messages, capabilities, ids, false);
      const held = await driver.request('readStreamEffects', {}, end);
      if (held.calls?.[ids[0]!]?.started !== 1 || ids.some(id => held.calls?.[id]?.committed !== 0)) throw new Error(`Expected first tool held before commit: ${JSON.stringify(held)}`);
    }
    stage('drain scenario work'); const effects = await driver.request('finishStream', {}, end);
    // Still live: do not invoke the session-ended exception to excuse missing terminals.
    await fence('live completion fence');
    const calls = oracle.streams(peer.messages, capabilities, ids, !baseline);
    const executes = kind !== 'failed' && kind !== 'cancelled';
    for (const callId of ids) {
      const effect = effects.calls?.[callId];
      const count = executes ? 1 : 0;
      if (!effect || effect.started !== count || effect.committed !== count) throw new Error(`Unexpected tool effects for ${callId}: ${JSON.stringify(effect)}`);
      if (!baseline) {
        const steps = calls.get(callId)!;
        const terminal = steps.at(-1)!;
        const expected = kind === 'failed' ? 'failed' : kind === 'cancelled' ? 'cancelled' : 'settled';
        if (terminal.phase !== expected || (expected === 'settled' && terminal.ok !== true)) throw new Error(`Expected ${expected} terminal`);
        if (executes && kind !== 'no-delta' && !steps.some(m => m.phase === 'progress')) throw new Error('Fixture progress missing');
        if (kind === 'no-delta' && steps.some(m => m.phase === 'arguments-delta')) throw new Error('No-delta fixture unexpectedly streamed arguments');
      }
    }
    stage('stream close fence'); peer.socket.close(1000, 'scenario complete'); await peer.closed(end);
    oracle.streams(peer.messages, capabilities, ids, !baseline);
    return { capabilities, effects, calls: Object.fromEntries([...calls].map(([key, steps]) => [key, steps.map(m => m.phase)])), liveCompletionFence: true };
  } catch (error) {
    // A valid prefix ending early is incomplete, not a missing-terminal wire violation.
    oracle.streams(peer.messages, capabilities, ids, false);
    if (peer.closeInfo) throw new IncompleteStream(`Connection ended before scenario completion; session completion unobserved: ${String(error)}`);
    throw error;
  }
}
