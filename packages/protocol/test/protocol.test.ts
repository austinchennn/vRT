import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_BYTES,
  Inbox,
  Outbox,
  decodeAudioFrame,
  decodeClientMessage,
  decodeServerMessage,
  encodeAudioFrame,
  encodeMessage,
  parseClientMessage,
  writeAudioHeader,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.js';

const env = { v: 1 as const, seq: 7 };
const pcm = { encoding: 'pcm16' as const, sampleRate: 24000 };

const clientMessages: ClientMessage[] = [
  { ...env, type: 'hello', tools: [{ name: 'paint', description: 'd', parameters: { type: 'object' } }], input: pcm, output: { encoding: 'opus' }, sessionId: 's1', resumeFrom: 3, context: { doc: 1 }, auth: 'token-abc' },
  { ...env, type: 'hello', tools: [] },
  { ...env, type: 'text', text: 'hi' },
  { ...env, type: 'interrupt', epoch: 4, reason: 'keyboard' },
  { ...env, type: 'playback', itemId: 'a1', playedMs: 320.5 },
  { ...env, type: 'tool.result', callId: 'c1', epoch: 4, ok: true, output: { done: true } },
  { ...env, type: 'tool.result', callId: 'c1', epoch: 4, ok: false, code: 'INTERRUPTED', message: 'stop' },
  { ...env, type: 'context', context: null },
  { ...env, type: 'ack', upTo: 12 },
  { ...env, type: 'ping' },
];

const serverMessages: ServerMessage[] = [
  { ...env, type: 'ready', sessionId: 's', input: pcm, output: pcm, resumedFrom: 2 },
  { ...env, type: 'audio.start', itemId: 'a1', responseId: 'r1', epoch: 1 },
  { ...env, type: 'turn.state', turnId: 't1', epoch: 1, state: 'acting' },
  { ...env, type: 'transcript', role: 'agent', itemId: 'a1', text: 'hello', final: false },
  { ...env, type: 'text', responseId: 'r1', delta: 'x' },
  { ...env, type: 'tool.call.delta', callId: 'c1', epoch: 1, name: 'paint', preview: { partial: true } },
  { ...env, type: 'tool.call', callId: 'c1', epoch: 1, turnId: 't1', name: 'paint', arguments: { color: 'red' } },
  { ...env, type: 'interrupted', epoch: 1 },
  { ...env, type: 'ack', upTo: 3 },
  { ...env, type: 'pong' },
  { ...env, type: 'error', code: 'X', message: 'm', recoverable: false },
];

describe('codec', () => {
  it.each(clientMessages)('round-trips client $type', (message) => {
    expect(decodeClientMessage(encodeMessage(message))).toEqual({ ok: true, message });
  });

  it.each(serverMessages)('round-trips server $type', (message) => {
    expect(decodeServerMessage(encodeMessage(message))).toEqual({ ok: true, message });
  });

  it('returns typed errors for bad input', () => {
    expect(decodeClientMessage('{')).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
    expect(decodeClientMessage(new Uint8Array(2))).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
    expect(decodeClientMessage('[1]')).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
    expect(decodeClientMessage('{"v":2,"seq":1,"type":"ping"}')).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
    expect(decodeClientMessage('{"v":1,"seq":1,"type":"nope"}')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE' } });
    expect(decodeClientMessage('{"v":1,"seq":1,"type":"toString"}')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE' } });
    expect(decodeClientMessage('{"v":1,"seq":-1,"type":"ping"}')).toMatchObject({ ok: false, error: { code: 'INVALID_FIELD' } });
    expect(decodeClientMessage('{"v":1,"seq":1,"type":"text","text":3}')).toEqual({ ok: false, error: { code: 'INVALID_FIELD', message: 'Invalid field for text: text' } });
    expect(parseClientMessage({ v: 1, seq: 1, type: 'tool.result', callId: 'c', epoch: 0, ok: false, code: 'NOPE', message: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_FIELD' } });
    expect(parseClientMessage({ v: 1, seq: 1, type: 'hello', tools: [{ name: 'x' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_FIELD' } });
    // Server-only types are not accepted from clients.
    expect(decodeClientMessage(encodeMessage(serverMessages[0]!))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE' } });
  });

  it('never throws on random input', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const atoms = [null, true, false, 0, -1, 1.5, 2 ** 40, NaN, '', 'x', 'hello', 'ping', 'tool.result', 'hello'];
    const keys = ['v', 'seq', 'type', 'tools', 'text', 'epoch', 'ok', 'code', 'message', 'callId', 'input', 'name', '__proto__', 'constructor'];
    const value = (depth: number): unknown => {
      const r = rand();
      if (depth > 3 || r < 0.4) return atoms[Math.floor(rand() * atoms.length)];
      if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1));
      const obj: Record<string, unknown> = rand() < 0.5 ? { v: 1, seq: 1 } : {};
      for (let i = 0; i < 4; i++) obj[keys[Math.floor(rand() * keys.length)]!] = value(depth + 1);
      return obj;
    };
    for (let i = 0; i < 20_000; i++) {
      const input = value(0);
      expect(() => { parseClientMessage(input); decodeServerMessage(JSON.stringify(input) ?? 'undefined'); }).not.toThrow();
      const garbage = String.fromCharCode(...Array.from({ length: Math.floor(rand() * 20) }, () => Math.floor(rand() * 128)));
      expect(() => decodeClientMessage(garbage)).not.toThrow();
    }
  });
});

describe('audio frames', () => {
  it('encodes [kind u8][seq u32 BE][payload]', () => {
    const frame = encodeAudioFrame(1, 0x01020304, new Uint8Array([9, 8]));
    expect(Array.from(frame)).toEqual([1, 1, 2, 3, 4, 9, 8]);
  });

  it('decodes without copying the payload', () => {
    const backing = new Uint8Array(20);
    const frame = encodeAudioFrame(2, 0xffffffff, new Uint8Array([1, 2, 3]));
    backing.set(frame, 4);
    const view = backing.subarray(4, 4 + frame.byteLength);
    const decoded = decodeAudioFrame(view)!;
    expect(decoded.kind).toBe(2);
    expect(decoded.seq).toBe(0xffffffff);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
    expect(decoded.payload.buffer).toBe(backing.buffer);
    expect(decodeAudioFrame(frame.buffer as ArrayBuffer)!.seq).toBe(0xffffffff);
  });

  it('handles boundary sizes and rejects malformed frames', () => {
    expect(decodeAudioFrame(encodeAudioFrame(1, 0, new Uint8Array(0)))).toEqual({ kind: 1, seq: 0, payload: new Uint8Array(0) });
    const big = new Uint8Array(1 << 20).fill(7);
    expect(decodeAudioFrame(encodeAudioFrame(1, 5, big))!.payload.byteLength).toBe(1 << 20);
    expect(decodeAudioFrame(new Uint8Array(AUDIO_HEADER_BYTES - 1))).toBeUndefined();
    expect(decodeAudioFrame(new Uint8Array([3, 0, 0, 0, 0]))).toBeUndefined();
    expect(decodeAudioFrame('x' as unknown as Uint8Array)).toBeUndefined();
  });

  it('writeAudioHeader supports zero-copy sending and wraps seq to u32', () => {
    const frame = new Uint8Array(AUDIO_HEADER_BYTES + 2);
    frame.set([5, 6], AUDIO_HEADER_BYTES);
    writeAudioHeader(frame, 1, 2 ** 32 + 3);
    expect(decodeAudioFrame(frame)).toMatchObject({ kind: 1, seq: 3 });
  });
});

describe('sequencing', () => {
  it('stamps seq, keeps unacked messages and resends after a reconnect', () => {
    const out = new Outbox<ServerMessage>();
    const a = out.stamp({ type: 'interrupted', epoch: 1 });
    const ping = out.stamp({ type: 'pong' });
    expect(out.stamp({ type: 'audio.start', itemId: 'a', responseId: 'r', epoch: 1 }).seq).toBe(0);
    const b = out.stamp({ type: 'text', responseId: 'r', delta: 'x' });
    expect([a.seq, ping.seq, b.seq]).toEqual([1, 0, 2]);
    expect(a.v).toBe(1);
    expect(out.pending).toBe(2);
    expect(out.resendFrom(1)).toEqual([b]);
    out.ack(1);
    expect(out.resendFrom(0)).toEqual([b]);
    out.ack(2);
    expect(out.resendFrom(2)).toEqual([]);
  });

  it('refuses to resume past dropped messages', () => {
    const out = new Outbox<ServerMessage>(2);
    for (let i = 0; i < 3; i++) out.stamp({ type: 'interrupted', epoch: i });
    expect(out.resendFrom(0)).toBeUndefined();
    expect(out.resendFrom(1)!.map((m) => m.seq)).toEqual([2, 3]);
  });

  it('drops duplicate incoming seq and tracks the resume point', () => {
    const inbox = new Inbox();
    expect(inbox.accept({ type: 'text', seq: 1 })).toBe(true);
    expect(inbox.accept({ type: 'text', seq: 1 })).toBe(false);
    expect(inbox.accept({ type: 'ping', seq: 0 })).toBe(true);
    expect(inbox.accept({ type: 'text', seq: 3 })).toBe(true);
    expect(inbox.lastSeq).toBe(3);
    expect(new Inbox(10).accept({ type: 'text', seq: 9 })).toBe(false);
  });
});
