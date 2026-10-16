import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent } from '@vrealtime/core';
import type { ServerMessage } from '@vrealtime/protocol';
import { fakeModel } from '@vrealtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { serve, type RunningServer } from '../src/node/index.js';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

function nextMessage(socket: WebSocket, type: ServerMessage['type']): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type !== type) return;
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };
    socket.addEventListener('message', onMessage);
  });
}

describe('serve()', () => {
  it('serves the debug page and speaks protocol v1 over a real WebSocket', async () => {
    const model = fakeModel({
      onCommand: (command, session) => {
        if (command.type !== 'respond') return;
        session.emit({ type: 'response.start', responseId: 'r1' });
        session.emit({ type: 'output.transcript', responseId: 'r1', itemId: 'a1', delta: 'Hi there' });
        session.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
      },
    });
    running = await serve(defineAgent({ model, instructions: 'test' }), { port: 0, onListening: () => {} });

    const page = await fetch(running.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('vRealTime');
    expect((await fetch(`${running.url}/missing`)).status).toBe(404);

    const socket = new WebSocket(running.url.replace('http', 'ws'));
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const ready = nextMessage(socket, 'ready');
    socket.send(JSON.stringify({ v: 1, seq: 0, type: 'hello', tools: [] }));
    expect(await ready).toMatchObject({ type: 'ready', input: { encoding: 'pcm16', sampleRate: 24000 } });

    const transcript = new Promise<ServerMessage>((resolve) => {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === 'transcript' && message.final) resolve(message);
      });
    });
    socket.send(JSON.stringify({ v: 1, seq: 1, type: 'text', text: 'hello' }));
    expect(await transcript).toMatchObject({ role: 'agent', text: 'Hi there', final: true });
    expect(model.session.commandsOf('sendText')).toEqual([{ type: 'sendText', text: 'hello' }]);
    socket.close();
  });

  it('serves a public directory instead of the debug page, without path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vrt-public-'));
    writeFileSync(join(dir, 'index.html'), '<h1>app</h1>');
    writeFileSync(join(dir, 'app.js'), 'export {}');
    running = await serve(defineAgent({ model: fakeModel(), instructions: '' }), { port: 0, publicDir: dir, onListening: () => {} });
    expect(await (await fetch(running.url)).text()).toBe('<h1>app</h1>');
    const js = await fetch(`${running.url}/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${running.url}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
  });
});
