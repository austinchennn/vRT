import type { Wire } from './report.js';
import type { Oracle } from './oracle.js';
export const REJECTION_PROFILE = 'server-resume-rejection-v1';
export const REJECTION_KINDS = ['unknown', 'ahead', 'ack-history', 'ack-boundary'] as const;
export const REJECTION_CASES = REJECTION_KINDS.map(kind => `server/resume-rejection/${kind}`);
export class IncompleteRejection extends Error {}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
export function rejectionEffects(value: Wire, sessions: number, connections: number, closed: number[], emitted: string[], ack: boolean, closedModels: number): void {
  const expected = { sessions, connections, closedConnections: closed, emitted, contexts: [], receivedAcks: ack ? [{ connection: 1, upTo: 1 }] : [], closedModels };
  if (Object.entries(expected).some(([key, item]) => canonical(value[key]) !== canonical(item))) throw new Error(`Recovery effects mismatch: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
}
/** Unknown/closed hello is unbound; valid retained sessions bind before replay checking (§5.4). */
export function resumeRefused(oracle: Oracle, messages: Wire[], close: Wire | undefined, prior: Wire[] = []): void {
  oracle.baseline('server', [...prior, ...messages]);
  const seen = new Set<number>();
  const logical = messages.filter(message => {
    if (message.seq === 0) return true;
    if (seen.has(message.seq)) return false;
    seen.add(message.seq); return true;
  });
  const errors = logical.filter(message => message.type === 'error');
  if (errors.length !== 1) throw new Error('Expected exactly one RESUME_FAILED');
  const error = errors[0]!;
  oracle.error(error, 'RESUME_FAILED', false);
  const previous = Math.max(0, ...prior.map(message => message.seq));
  if (error.seq !== (prior.length ? previous + 1 : 0)) throw new Error(`Wrong recovery error seq: expected ${prior.length ? previous + 1 : 0}, actual ${error.seq}`);
  const ready = messages.filter(message => message.type === 'ready');
  if ((!prior.length && ready.length) || ready.length > 1 || (ready.length && messages[0] !== ready[0])) throw new Error('Unexpected ready on rejected recovery');
  if (ready.length && (ready[0]!.sessionId !== prior.find(message => message.type === 'ready')?.sessionId || ready[0]!.resumedFrom !== 0 || (ready[0]!.capabilities ?? []).length)) throw new Error('Rejected recovery changed session identity/cursor/capabilities');
  if (logical.some(message => message !== error && message.type !== 'ready')) throw new Error('Unexpected business/replay traffic on rejected recovery');
  if (!close || close.messageCount !== messages.length || canonical(messages.at(-1)) !== canonical(error) || (!prior.length && close.code !== 4404)) throw new Error('RESUME_FAILED must precede wire close (4404 for unknown/closed session)');
  // §5.4 does not mandate a particular close code for replay-history failure.
}
export function ackBoundaryReplay(oracle: Oracle, first: Wire[], second: Wire[]): void {
  oracle.baseline('server', [...first, ...second]);
  const initial = first.filter(message => message.type === 'ready');
  const ready = second.filter(message => message.type === 'ready');
  if (initial.length !== 1 || ready.length !== 1 || second[0] !== ready[0] || ready[0]!.sessionId !== initial[0]!.sessionId || ready[0]!.resumedFrom !== 0 || (ready[0]!.capabilities ?? []).length) throw new Error('Expected successful same-session ACK-boundary recovery');
  if (canonical(ready[0]!.input) !== canonical(initial[0]!.input) || canonical(ready[0]!.output) !== canonical(initial[0]!.output)) throw new Error('Recovery changed formats');
  const logical = [...new Map(second.filter(message => message.seq > 0).map(message => [message.seq, message])).values()];
  const retained = first.find(message => message.seq === 2)!;
  const after = logical[1];
  if (logical.length !== 2 || canonical(logical[0]) !== canonical(retained) || !after || after.type !== 'transcript' || after.seq !== 3 || after.itemId !== 'resume-after' || after.text !== 'after' || after.role !== 'user' || after.final !== true) throw new Error('Incomplete/changed ACK-boundary replay or new marker');
  if (second.some(message => !['ready', 'transcript', 'pong'].includes(message.type))) throw new Error('Unexpected ACK-boundary traffic');
}
