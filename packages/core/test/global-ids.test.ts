import { fakeModel } from '@vrealtime/testing';
import { describe, expect, it } from 'vitest';
import { defineAgent, startSession, tool, type AgentEventOf, type AgentEventType, type AgentSession, type Tool, type ToolStreamEvent } from '../src/index.js';

function next<T extends AgentEventType>(session: AgentSession, type: T): Promise<AgentEventOf<T>> {
  return new Promise((resolve) => { const off = session.on(type, (event) => { off(); resolve(event); }); });
}
const paint = { name: 'paint', description: '', parameters: {} };

describe('opaque identifiers across sessions', () => {
  it('keeps server tool contexts, hooks, progress and results on one public identity and ignores duplicate issuance', async () => {
    const model = fakeModel();
    const observed: string[] = [];
    let executions = 0;
    const session = await startSession(defineAgent({
      model, instructions: '',
      hooks: { beforeToolCall: (call) => { observed.push(call.callId); }, afterToolCall: (call) => { observed.push(call.callId); } },
      tools: { probe: tool({ description: '', parameters: {}, run: (_args, context) => { executions++; observed.push(context.callId); context.emit('progress'); return 'done'; } }) as Tool<never, unknown> },
    }));
    session.on('tool.preview', (event) => observed.push(event.callId));
    session.on('tool.stream', (event) => observed.push(event.callId));
    try {
      const result = next(session, 'tool.result');
      model.session.emit({ type: 'response.start', responseId: 'r1' });
      const call = { type: 'tool.call', responseId: 'r1', callId: 'raw', name: 'probe', arguments: {} } as const;
      model.session.emit(call); model.session.emit(call);
      const settled = await result;
      expect(settled.callId).not.toBe('raw');
      expect(new Set(observed)).toEqual(new Set([settled.callId]));
      expect(executions).toBe(1);
      expect(model.session.commandsOf('submitToolResult')).toMatchObject([{ callId: 'raw', output: 'done' }]);
    } finally { await session.close(); }
  });
  it('does not reuse the first turn or provider call ID when the same agent opens another session', async () => {
    const model = fakeModel();
    const agent = defineAgent({ model, instructions: '', clientTools: 'accept' });
    const sessions = await Promise.all([startSession(agent, { clientTools: [paint] }), startSession(agent, { clientTools: [paint] })]);
    try {
      const calls = await Promise.all(sessions.map(async (session, index) => {
        const pending = next(session, 'tool.call');
        session.sendText('paint');
        model.sessions[index]!.emit({ type: 'response.start', responseId: 'r1' });
        model.sessions[index]!.emit({ type: 'tool.call', responseId: 'r1', callId: 'provider-call', name: 'paint', arguments: {} });
        return pending;
      }));
      expect(calls[0]!.turnId).not.toBe(calls[1]!.turnId);
      expect(calls[0]!.callId).not.toBe(calls[1]!.callId);
      for (const call of calls) {
        expect(call.callId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
        expect(call.turnId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
      }
    } finally { await Promise.all(sessions.map((session) => session.close())); }
  });

  it('uses the same public ID for fragments, stream, invocation and result, then restores the provider ID', async () => {
    const model = fakeModel();
    const session = await startSession(defineAgent({ model, instructions: '', clientTools: 'accept' }), { clientTools: [paint] });
    const raw = 'provider-'.repeat(64);
    const streams: ToolStreamEvent[] = [];
    const fragments: string[] = [];
    session.on('tool.stream', (event) => streams.push(event));
    session.on('tool.call.delta', (event) => fragments.push(event.callId));
    try {
      session.sendText('paint');
      model.session.emit({ type: 'response.start', responseId: 'r1' });
      model.session.emit({ type: 'tool.call.delta', responseId: 'r1', callId: raw, name: 'paint', argumentsDelta: '{}' });
      const pending = next(session, 'tool.call');
      model.session.emit({ type: 'tool.call', responseId: 'r1', callId: raw, name: 'paint', arguments: {} });
      const call = await pending;
      expect(call.callId).not.toBe(raw);
      expect(call.callId.length).toBeLessThanOrEqual(128);
      expect(fragments).toEqual([call.callId]);
      expect(new Set(streams.map((event) => event.callId))).toEqual(new Set([call.callId]));
      session.submitClientToolResult(raw, { ok: true, output: 'wrong identity' });
      expect(model.session.commandsOf('submitToolResult')).toHaveLength(0);
      const result = next(session, 'tool.result');
      session.submitClientToolResult(call.callId, { ok: true, output: 'painted' });
      expect((await result).callId).toBe(call.callId);
      expect(model.session.commandsOf('submitToolResult')).toMatchObject([{ callId: raw, output: 'painted' }]);
      session.submitClientToolResult(call.callId, { ok: true, output: 'duplicate' });
      expect(model.session.commandsOf('submitToolResult')).toHaveLength(1);
    } finally { await session.close(); }
  });

  it('gives reused provider IDs in later responses new identities and ignores a previous result', async () => {
    const model = fakeModel();
    const session = await startSession(defineAgent({ model, instructions: '', clientTools: 'accept' }), { clientTools: [paint] });
    try {
      const calls = [];
      for (const responseId of ['r1', 'r2']) {
        const pending = next(session, 'tool.call');
        model.session.emit({ type: 'response.start', responseId });
        model.session.emit({ type: 'tool.call', responseId, callId: 'reused', name: 'paint', arguments: {} });
        const call = await pending; calls.push(call);
        if (responseId === 'r2') {
          expect(call.callId).not.toBe(calls[0]!.callId);
          session.submitClientToolResult(calls[0]!.callId, { ok: true, output: 'late' });
          expect(model.session.commandsOf('submitToolResult')).toHaveLength(1);
        }
        session.submitClientToolResult(call.callId, { ok: true, output: responseId });
        model.session.emit({ type: 'response.end', responseId, status: 'done' });
      }
      expect(model.session.commandsOf('submitToolResult').map((command) => [command.callId, command.output])).toEqual([['reused', 'r1'], ['reused', 'r2']]);
    } finally { await session.close(); }
  });
});
