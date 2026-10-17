import type { Wire } from './report.js';
export const RESUME_PROFILE = 'server-resume-replay-v1';
export const RESUME_KINDS = ['suffix', 'from-zero', 'caught-up', 'replace'] as const;
export const RESUME_CASES = RESUME_KINDS.map(kind => `server/resume/${kind}`);
export const CONTEXT_FIRST = { revision: 1, tag: 'resume-first' };
export const CONTEXT_SECOND = { revision: 2, tag: 'resume-second' };
export class IncompleteResume extends Error {}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
export function resumeEffects(value: Wire, contexts: Wire[], emitted: string[], connections: number, closed: number[]): void {
  if (value.sessions !== 1 || value.connections !== connections || !Array.isArray(value.contexts) || !Array.isArray(value.emitted) || !Array.isArray(value.closedConnections) ||
      value.contexts.length > 8 || value.emitted.length > 8 || value.closedConnections.length > 2 ||
      canonical(value.contexts) !== canonical(contexts) || canonical(value.emitted) !== canonical(emitted) || canonical(value.closedConnections) !== canonical(closed)) throw new Error(`Expected one model, contexts=${canonical(contexts)}, emitted=${canonical(emitted)}, connections=${connections}, closed=${canonical(closed)}; actual=${JSON.stringify(value)}`);
}
function sequenced(messages: Wire[]): Wire[] {
  const seen = new Set<number>(); const result: Wire[] = [];
  for (const message of messages) {
    if (message.seq > 0 && !seen.has(message.seq)) { seen.add(message.seq); result.push(message); }
  }
  return result;
}
function formatKey(format: Wire): string { return format.encoding === 'pcm16' ? `pcm16:${format.sampleRate ?? 24000}` : format.encoding; }
export function resumeReady(first: Wire[], second: Wire[]): void {
  const original = first.filter(message => message.type === 'ready');
  const resumed = second.filter(message => message.type === 'ready');
  if (original.length !== 1 || resumed.length !== 1 || second[0]?.type !== 'ready') throw new Error('Expected one new ready before replay on each connection');
  const a = original[0]!; const b = resumed[0]!;
  if (a.sessionId !== b.sessionId || a.resumedFrom !== undefined || b.resumedFrom !== 1) throw new Error(`Session identity/client cursor changed: ${JSON.stringify({ first: a, second: b })}`);
  if ((a.capabilities ?? []).length || (b.capabilities ?? []).length || formatKey(a.input) !== formatKey(b.input) || formatKey(a.output) !== formatKey(b.output)) throw new Error('Baseline formats/capabilities changed on resume');
}
/** Existing schema/sequence oracle checks concatenated traffic before semantic replay checks. */
export function resumeReplay(first: Wire[], second: Wire[], cursor: number, offline: string[]): void {
  resumeReady(first, second);
  if ([...first, ...second].some(message => message.type === 'error')) throw new Error('Unexpected error on normal resume');
  const history = sequenced(first);
  const initial = history.at(-1)?.seq ?? 0;
  const prefix = history.filter(message => message.seq > cursor);
  const emitted = [...offline, 'after'].map((marker, index) => ({ v: 1, type: 'transcript', seq: initial + index + 1, role: 'user', itemId: `resume-${marker}`, text: marker, final: true }));
  const actual = sequenced(second);
  if (actual.length !== prefix.length + emitted.length) throw new Error(`Incomplete/unexpected replay: expected seq ${[...prefix, ...emitted].map(message => message.seq)}, got ${actual.map(message => message.seq)}`);
  for (const [index, expected] of prefix.entries()) if (canonical(actual[index]) !== canonical(expected)) throw new Error('Retained replay content changed');
  for (const [index, expected] of emitted.entries()) {
    const message = actual[prefix.length + index]!;
    if (Object.entries(expected).some(([key, value]) => message[key] !== value)) throw new Error(`Replay/marker changed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
  }
  if ([...first, ...second].some(message => message.type === 'ack' && message.upTo > 2)) throw new Error('Server ACK beyond handled client cursor');
}
