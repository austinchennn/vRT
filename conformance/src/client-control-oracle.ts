import type { Wire } from './report.js';
export const CONTROL_PROFILE = 'client-control-validation-v1';
export const CONTROL_KINDS = ['framing', 'version', 'types', 'fields', 'state-call'] as const;
export const CONTROL_CASES = CONTROL_KINDS.map(kind => `client/control/${kind}`);
export class IncompleteControl extends Error {}
export const CONTROL_CALL = 'control-call';
export const CONTROL_TURN = 'control-turn';
export const CONTROL_MARKER = 'control-finish-marker';

/** Independent public application observations, not the SDK's decoder or hidden state. */
export function controlEffects(value: Wire, codes: string[], final = false): void {
  if (!Array.isArray(value.errors) || !Array.isArray(value.events) || value.errors.length > 64 || value.events.length > 128 || typeof value.closed !== 'boolean' || (!final && value.closed) ||
      value.errors.length !== codes.length || value.errors.some((error: Wire, i: number) => !error || error.code !== codes[i] || error.recoverable !== true) ||
      value.started !== (final ? 1 : 0) || value.committed !== (final ? 1 : 0)) throw new Error(`Unexpected/missing control observations: expected errors=${JSON.stringify(codes)}, starts/commits=${final ? 1 : 0}; actual=${JSON.stringify(value)}`);
  if (!final) {
    if (value.events.length !== 0) throw new Error('Invalid control triggered application business events');
    return;
  }
  const expected = ['state', 'tool.call', 'tool.result', 'transcript', 'interrupted'];
  if (value.events.length !== expected.length || expected.some(type => value.events.filter((event: Wire) => event?.type === type).length !== 1)) throw new Error('Unexpected/duplicate application business events');
  for (const event of value.events) {
    if (event.type === 'state' && (event.epoch !== 1 || event.turnId !== CONTROL_TURN || event.state !== 'thinking')) throw new Error('Invalid state polluted client');
    if ((event.type === 'tool.call' || event.type === 'tool.result') && (event.callId !== CONTROL_CALL || event.epoch !== 1 || event.turnId !== CONTROL_TURN)) throw new Error('Invalid call identity');
    if (event.type === 'transcript' && (event.itemId !== CONTROL_MARKER || event.text !== 'control-complete' || event.final !== true || event.role !== 'user')) throw new Error('Missing transcript completion fence');
    if (event.type === 'interrupted' && event.epoch !== 1) throw new Error('Invalid input polluted observed epoch');
  }
  if (value.closed !== true) throw new Error('Driver did not close after draining observations');
}
export function controlResult(messages: Wire[]): void {
  const logical = new Map<number, Wire>();
  for (const message of messages.filter(message => message.type === 'tool.result')) logical.set(message.seq, message);
  if (logical.size !== 1) throw new Error(`Expected one logical tool result, got ${logical.size}`);
  const result = [...logical.values()][0]!;
  if (result.callId !== CONTROL_CALL || result.epoch !== 1 || result.ok !== true) throw new Error('Expected successful legal tool result');
  if (messages.some(message => message.type === 'ack' && message.upTo > 3)) throw new Error('Invalid input advanced receive cursor');
}
