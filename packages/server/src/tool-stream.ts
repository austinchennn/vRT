import type { ToolStreamEvent } from '@vrealtime/core';
import type { ServerMessage, Unsequenced } from '@vrealtime/protocol';

type Outgoing = Unsequenced<ServerMessage>;

/** With `tool-stream-v1`: the step as a `tool.stream` message. A server tool's output never leaves the server. */
export function toolStreamMessage(event: ToolStreamEvent): Outgoing {
  const call = { type: 'tool.stream', callId: event.callId, epoch: event.epoch, turnId: event.turnId, name: event.name } as const;
  switch (event.phase) {
    case 'start':
    case 'cancelled':
      return { ...call, phase: event.phase };
    case 'arguments-delta':
      return { ...call, phase: event.phase, delta: event.delta };
    // Required members on the wire: a missing value is sent as null.
    case 'arguments-complete':
      return { ...call, phase: event.phase, arguments: event.arguments ?? null };
    case 'progress':
      return { ...call, phase: event.phase, progress: event.progress ?? null };
    case 'settled':
      return event.result.ok ? { ...call, phase: 'settled', ok: true } : { ...call, phase: 'settled', ok: false, code: event.result.code };
    case 'failed':
      return { ...call, phase: event.phase, message: event.message };
  }
}

/** Without the capability: argument fragments and progress as the `tool.call.delta` preview of protocol 1.0; nothing else is sent. */
export function legacyPreview(event: ToolStreamEvent): Outgoing | undefined {
  const call = { type: 'tool.call.delta', callId: event.callId, epoch: event.epoch, name: event.name } as const;
  if (event.phase === 'arguments-delta') return { ...call, preview: { argumentsDelta: event.delta } };
  if (event.phase === 'progress') return { ...call, preview: event.progress ?? null };
  return undefined;
}
