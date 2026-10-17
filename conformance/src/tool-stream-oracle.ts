import type { Wire } from './report.js';
export const STREAM_CAPABILITY = 'tool-stream-v1';
export const STREAM_OUTPUT = 'conformance-server-only-output';
const TERMINAL = new Set(['settled', 'failed', 'cancelled']);

/** Independent per-call state; input is already schema/sequence/capability checked. */
export function streamLifecycle(messages: Wire[], ids: string[], final: boolean): Map<string, Wire[]> {
  const calls = new Map<string, Wire[]>();
  const seen = new Set<number>();
  for (const message of messages) {
    if (message.seq > 0) {
      if (seen.has(message.seq)) continue;
      seen.add(message.seq);
    }
    if (message.type !== 'tool.stream') continue;
    if (!ids.includes(message.callId)) throw new Error(`Unexpected fixture call ${message.callId}`);
    const steps = calls.get(message.callId) ?? [];
    const first = steps[0];
    if (!first && message.phase !== 'start') throw new Error('Stream must start with start');
    if (first) {
      if (['name', 'epoch', 'turnId'].some(key => message[key] !== first[key])) throw new Error('Stream call identity changed');
      if (TERMINAL.has(steps.at(-1)!.phase)) throw new Error('Message after terminal (duplicate settlement or reopened call)');
      if (message.phase === 'start') throw new Error('Duplicate stream start');
    }
    const complete = steps.some(step => step.phase === 'arguments-complete');
    if (message.phase === 'arguments-delta' && complete) throw new Error('Argument delta after complete');
    if (message.phase === 'arguments-complete' && complete) throw new Error('Duplicate arguments-complete');
    if (message.phase === 'progress' && !complete) throw new Error('Progress before arguments-complete');
    if (message.phase === 'settled' && !complete) throw new Error('Settled before arguments-complete');
    if (message.phase === 'failed' && complete) throw new Error('Failed denotes an unissued call');
    if ((message.phase === 'settled' && 'output' in message) || JSON.stringify(message).includes(STREAM_OUTPUT)) throw new Error('Server tool output leaked in tool.stream');
    steps.push(message); calls.set(message.callId, steps);
  }
  if (final) for (const id of ids) {
    if (!TERMINAL.has(calls.get(id)?.at(-1)?.phase)) throw new Error(`Missing terminal for ${id} at live completion fence`);
  }
  return calls;
}
