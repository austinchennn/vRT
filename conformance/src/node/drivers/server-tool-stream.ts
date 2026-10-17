import { setImmediate } from 'node:timers/promises';
import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import type { Wire } from '../../report.js';
import { STREAM_OUTPUT } from '../../tool-stream-oracle.js';
import { deferred } from '../deadline.js';

/** Test instrumentation owns only the fake model and application tasks, not SDK internals. */
export async function streamServer(argumentStreaming = true) {
  let kind = ''; let ids: string[] = [];
  let completed = false; let finished = false;
  const calls: Record<string, { started: number; committed: number }> = {};
  const release = deferred<void>(); const started = deferred<void>();
  const results = new Map<string, ReturnType<typeof deferred<void>>>();
  const responseId = 'stream-response';
  const model = fakeModel({ capabilities: { tools: { argumentStreaming } }, onCommand(command) {
    if (command.type === 'submitToolResult') results.get(command.callId)?.resolve();
  } });
  const running = await serve(defineAgent({ model, instructions: '', tools: {
    probe: { description: 'Conformance server probe', parameters: { type: 'object' },
      async run(_args, context) {
        const effect = calls[context.callId]!; effect.started++; started.resolve();
        if (kind !== 'no-delta') context.emit({ step: 'working' });
        await release.promise;
        if (!context.signal.aborted) effect.committed++;
        return STREAM_OUTPUT;
      },
    },
  } }), { host: '127.0.0.1', port: 0, onListening: () => {} });
  const delta = (callId: string, argumentsDelta: string) => model.session.emit({ type: 'tool.call.delta', responseId, callId, name: 'probe', argumentsDelta });
  const complete = (callId: string) => model.session.emit({ type: 'tool.call', responseId, callId, name: 'probe', arguments: { value: 1 } });
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    return closing ??= (async () => { const shutdown = running.close(); release.resolve(); await shutdown; await setImmediate(); })();
  }
  async function handle(command: string, data: Wire): Promise<Wire> {
    if (command === 'beginStream') {
      if (kind || !['baseline', 'lifecycle', 'no-delta', 'failed', 'cancelled'].includes(data.kind) || !Array.isArray(data.callIds) || data.callIds.length < 1 || data.callIds.length > 2 || data.callIds.some((id: unknown) => typeof id !== 'string') || new Set(data.callIds).size !== data.callIds.length) throw new Error('Invalid/repeated stream setup');
      kind = data.kind; ids = data.callIds;
      for (const id of ids) { calls[id] = { started: 0, committed: 0 }; results.set(id, deferred<void>()); }
      model.session.emit({ type: 'response.start', responseId });
      if (kind !== 'no-delta') {
        for (const id of ids) delta(id, '{"value":');
        for (const id of ids) delta(id, '1}');
      }
      return {};
    }
    if (command === 'readStreamEffects') return { calls };
    if (command === 'completeStream') {
      if (!kind || completed || kind === 'failed' || kind === 'cancelled') throw new Error('Invalid completion');
      completed = true;
      for (const id of ids) complete(id);
      model.session.emit({ type: 'response.end', responseId, status: 'done' });
      return {};
    }
    if (command === 'waitStreamTool') {
      if (!completed) throw new Error('Complete arguments first');
      await started.promise; return {};
    }
    if (command === 'finishStream') {
      if (!kind || finished || (!completed && kind !== 'failed' && kind !== 'cancelled')) throw new Error('Invalid/repeated finish');
      finished = true;
      if (kind === 'failed') model.session.emit({ type: 'response.end', responseId, status: 'done' });
      if (kind === 'cancelled') {
        // cancel() schedules response.end on the public testing clock.
        model.clock.advance();
        for (const id of ids) { delta(id, 'late'); complete(id); }
      } else if (kind !== 'failed') {
        release.resolve(); await Promise.all([...results.values()].map(result => result.promise));
      }
      if (kind === 'failed') for (const id of ids) delta(id, 'late');
      await setImmediate(); // drain owned promise continuations before the wire fence
      return { calls };
    }
    throw new Error(`Unknown stream command ${command}`);
  }
  return { url: running.url.replace('http:', 'ws:'), handle, close };
}
