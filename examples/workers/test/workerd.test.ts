/**
 * vdoc's deployment shape, for real: @vrealtime/client → Worker → Durable Object (per
 * document) → upgrade() → Boson adapter over fetchSocket() → a local mock Boson server
 * speaking the OpenAI Realtime GA protocol. Runs inside `wrangler dev` (workerd).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type ClientEvent } from '@vrealtime/client';
import type { ServerMessage } from '@vrealtime/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

const here = fileURLToPath(new URL('..', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../../../node_modules/.bin/wrangler', import.meta.url));
const TOKEN = 'demo-secret';
const AUDIO = Buffer.from(new Uint8Array(960)).toString('base64');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Mock Boson: replies to "make it <color>" by speaking and calling set_accent_color; "blue" waits for `releaseLate()`. */
function mockBoson(port: number) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const seen = { authorization: [] as string[], models: [] as string[], cancels: 0 };
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => { releaseLate = resolve; });
  wss.on('connection', (socket: WsSocket, request) => {
    seen.authorization.push(request.headers.authorization ?? '');
    const send = (message: Record<string, unknown>) => socket.readyState === 1 && socket.send(JSON.stringify(message));
    let text = '';
    let afterTool = false;
    let responses = 0;
    let open: string | undefined;
    socket.on('message', async (raw) => {
      const message = JSON.parse(String(raw));
      switch (message.type) {
        case 'session.update':
          if (message.session.model) {
            seen.models.push(message.session.model);
            send({ type: 'session.created', session: { id: 'boson-sess' } });
            send({ type: 'session.updated', session: { id: 'boson-sess' } });
          }
          return;
        case 'conversation.item.create':
          if (message.item.type === 'function_call_output') afterTool = true;
          else text = message.item.content[0].text;
          return;
        case 'response.cancel':
          seen.cancels++;
          if (open) send({ type: 'response.done', response: { id: open, status: 'cancelled', status_details: { reason: 'client_cancelled' } } });
          open = undefined;
          return;
        case 'response.create': {
          const id = `resp_${++responses}`;
          open = id;
          const color = afterTool ? undefined : /make it (\w+)/.exec(text)?.[1];
          afterTool = false;
          send({ type: 'response.created', response: { id } });
          send({ type: 'response.output_audio_transcript.delta', response_id: id, item_id: `item_${id}`, delta: color ? 'Okay, changing it now.' : 'Done.' });
          send({ type: 'response.output_audio.delta', response_id: id, item_id: `item_${id}`, delta: AUDIO });
          if (color) {
            if (color === 'blue') await late;
            send({ type: 'response.output_item.added', response_id: id, item: { type: 'function_call', call_id: `call_${id}`, name: 'set_accent_color' } });
            send({ type: 'response.function_call_arguments.done', response_id: id, call_id: `call_${id}`, name: 'set_accent_color', arguments: JSON.stringify({ color }) });
          }
          if (open === id) {
            send({ type: 'response.done', response: { id, status: 'completed' } });
            open = undefined;
          }
        }
      }
    });
  });
  return { wss, seen, releaseLate };
}

let wrangler: ChildProcess | undefined;
let boson: ReturnType<typeof mockBoson>;
let base = '';
let state = '';
let logs = '';

beforeAll(async () => {
  const [workerPort, bosonPort] = [await freePort(), await freePort()];
  boson = mockBoson(bosonPort);
  state = mkdtempSync(join(tmpdir(), 'vrt-wrangler-'));
  wrangler = spawn(wranglerBin, [
    'dev', '--ip', '127.0.0.1', '--port', String(workerPort), '--persist-to', state, '--inspector-port', '0',
    '--var', `BOSON_URL:ws://127.0.0.1:${bosonPort}`, '--var', 'BOSON_API_KEY:test-key', '--var', `DEMO_TOKEN:${TOKEN}`,
  ], { cwd: here, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1' } });
  wrangler.stdout?.on('data', (d) => { logs += String(d); });
  wrangler.stderr?.on('data', (d) => { logs += String(d); });
  await vi.waitFor(() => {
    if (wrangler?.exitCode !== null) throw new Error(`wrangler exited:\n${logs}`);
    expect(logs).toMatch(/Ready on/);
  }, { timeout: 90_000, interval: 250 });
  base = `ws://127.0.0.1:${workerPort}`;
}, 120_000);

afterAll(async () => {
  wrangler?.kill('SIGINT');
  await new Promise((resolve) => { if (!wrangler || wrangler.exitCode !== null) resolve(undefined); else wrangler.once('exit', resolve); });
  boson?.wss.close();
  if (state) rmSync(state, { recursive: true, force: true });
});

/** A bare protocol client, to test handshakes the SDK would not send. */
function rawHello(url: string, hello: Record<string, unknown>): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const received: ServerMessage[] = [];
    socket.addEventListener('open', () => socket.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [], ...hello })));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as ServerMessage;
      received.push(message);
      if (message.type === 'ready' || message.type === 'error') {
        socket.close();
        resolve(received);
      }
    });
  });
}

describe('Workers + Durable Object in workerd', () => {
  it('refuses a connection without a valid token', async () => {
    await expect(connect(`${base}/?doc=doc-1`, { auth: 'wrong', reconnect: false })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('runs the vdoc scenario end to end and resumes on the same document object', async () => {
    let color = 'initial';
    const session = await connect(`${base}/?doc=doc-1`, {
      auth: TOKEN,
      context: { docId: 'doc-1' },
      tools: {
        set_accent_color: {
          description: 'Change the accent color.',
          parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
          run: ({ color: next }: { color: string }, context) => {
            color = next;
            return { applied: next, turnId: context.turnId };
          },
        },
      },
    });
    const events: ClientEvent[] = [];
    for (const type of ['transcript', 'tool.result', 'interrupted'] as const) session.on(type, (e) => events.push(e));

    // The Durable Object reached Boson through fetchSocket() with the API key as a bearer header.
    expect(boson.seen.authorization).toEqual(['Bearer test-key']);
    expect(boson.seen.models).toEqual(['higgs-realtime']);

    session.sendText('make it red');
    await vi.waitFor(() => expect(color).toBe('red'), { timeout: 10_000 });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'transcript', role: 'agent', text: 'Done.', final: true })), { timeout: 10_000 });
    const applied = events.find((e) => e.type === 'tool.result') as Extract<ClientEvent, { type: 'tool.result' }>;
    expect(applied.result).toMatchObject({ ok: true, output: { applied: 'red' } });
    expect(applied.turnId).toMatch(/^turn-/);

    session.sendText('make it blue');
    await vi.waitFor(() => expect(session.state).toBe('speaking'), { timeout: 10_000 });
    session.interrupt();
    await vi.waitFor(() => expect(boson.seen.cancels).toBe(1), { timeout: 10_000 });
    boson.releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(color).toBe('red');
    expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(1);

    // Same document → same object → the session resumes; another document cannot see it.
    const sessionId = session.sessionId!;
    const elsewhere = await rawHello(`${base}/?doc=doc-2`, { auth: TOKEN, sessionId, resumeFrom: 0 });
    expect(elsewhere.at(-1)).toMatchObject({ type: 'error', code: 'RESUME_FAILED' });
    const resumed = await rawHello(`${base}/?doc=doc-1`, { auth: TOKEN, sessionId, resumeFrom: 0 });
    expect(resumed.find((m) => m.type === 'ready')).toMatchObject({ type: 'ready', sessionId });
    await session.close();
  }, 60_000);
});
