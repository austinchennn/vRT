import type { Wire } from './report.js';
import type { Oracle } from './oracle.js';
export const PRINCIPAL_PROFILE = 'server-resume-principal-v1';
export const PRINCIPAL_KINDS = ['same-owner', 'foreign-parked', 'foreign-live', 'reauth'] as const;
export const PRINCIPAL_CASES = PRINCIPAL_KINDS.map(kind => `server/resume-principal/${kind}`);
export const LIVE_CONTEXT = { principalReceipt: 'owner-live' };
export class IncompletePrincipal extends Error {}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
/** Compare authoritative wire semantics, not text, reasons, timing or private ownership tables. */
export function principalRefusal(oracle: Oracle, messages: Wire[], close: Wire | undefined, code: 'UNAUTHORIZED' | 'RESUME_FAILED'): void {
  oracle.baseline('server', messages);
  if (messages.length !== 1) throw new Error('Rejected principal received ready/business or multiple responses');
  const error = messages[0]!; oracle.error(error, code, false);
  const expected = code === 'UNAUTHORIZED' ? 4401 : 4404;
  if (error.seq !== 0 || close?.code !== expected || close?.messageCount !== 1) throw new Error(`Expected unbound ${code} seq 0 before close ${expected}`);
}
export function principalEffects(value: Wire, labels: string[], contexts: unknown[], connections: number): void {
  const expected = { sessions: 1, connections, auth: labels.map((label, index) => ({ label, resume: index > 0 })), contexts,
    emitted: ['before', 'after'], closedConnections: Array.from({ length: connections }, (_, index) => index + 1) };
  if (Object.entries(expected).some(([key, item]) => canonical(value[key]) !== canonical(item))) throw new Error(`Principal effects mismatch: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
}
export function principalOwner(oracle: Oracle, first: Wire[], owner: Wire[], resumed: boolean): void {
  oracle.baseline('server', resumed ? [...first, ...owner] : owner);
  const initial = first.filter(message => message.type === 'ready');
  const ready = owner.filter(message => message.type === 'ready');
  if (initial.length !== 1 || ready.length !== 1 || first[0] !== initial[0] || owner[0] !== ready[0] || initial[0]!.resumedFrom !== undefined || ready[0]!.sessionId !== initial[0]!.sessionId || ready[0]!.resumedFrom !== (resumed ? 0 : undefined) || (initial[0]!.capabilities ?? []).length || (ready[0]!.capabilities ?? []).length) throw new Error('Owner identity/cursor/capabilities changed');
  if (canonical(initial[0]!.input) !== canonical(ready[0]!.input) || canonical(initial[0]!.output) !== canonical(ready[0]!.output)) throw new Error('Owner formats changed');
  const positive = [...new Map((resumed ? [...first, ...owner] : owner).filter(message => message.seq > 0).map(message => [message.seq, message])).values()];
  if (positive.length !== 2 || ['before', 'after'].some((marker, index) => {
    const message = positive[index]!;
    return message.seq !== index + 1 || message.type !== 'transcript' || message.role !== 'user' || message.itemId !== `principal-${marker}` || message.text !== marker || message.final !== true;
  })) throw new Error('Owner markers missing/changed or duplicated logical business');
  if ((resumed ? [...first, ...owner] : owner).some(message => !['ready', 'transcript', 'pong', 'ack'].includes(message.type) || (message.type === 'ack' && message.upTo > (resumed ? 0 : 1)))) throw new Error('Unexpected owner traffic');
}
