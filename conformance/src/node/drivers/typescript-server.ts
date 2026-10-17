import { defineAgent } from '@vrealtime/core';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import { streamServer } from './server-tool-stream.js';
import { inputServer } from './server-input.js';
import { control } from './control.js';
let stream: Awaited<ReturnType<typeof streamServer>> | undefined;
let input: Awaited<ReturnType<typeof inputServer>> | undefined;
let running: RunningServer | undefined;
async function close(): Promise<void> { const current = running; running = undefined; await current?.close(); await stream?.close(); await input?.close(); }
control(async (command, data) => {
  if (command === 'ready') {
    if (data.profile === 'server-input-validation-v1') {
      input = await inputServer();
      return { url: input.url, driverCapabilities: ['server-input-validation-v1'] };
    }
    if (data.profile === 'server-tool-stream-v1') {
      if (typeof data.argumentStreaming !== 'boolean') throw new Error('Expected model argumentStreaming boolean');
      stream = await streamServer(data.argumentStreaming !== false);
      return { url: stream.url, driverCapabilities: ['server-tool-stream-v1'] };
    }
    const authenticated = data.profile === 'server-auth-v1';
    if (authenticated && (typeof data.authToken !== 'string' || data.authToken.length === 0)) throw new Error('Missing ephemeral test credential');
    running = await serve(defineAgent({ model: fakeModel(), instructions: '', clientTools: 'accept' }), {
      host: '127.0.0.1', port: 0, onListening: () => {},
      ...(authenticated ? { authenticate: ({ token }: { token: string | undefined }) => token === data.authToken ? { id: 'conformance-principal' } : undefined } : {}),
    });
    return { url: running.url.replace('http:', 'ws:'), ...(authenticated ? { driverCapabilities: ['server-auth-v1'] } : {}) };
  }
  if (command === 'close') { await close(); return {}; }
  if (input) return input.handle(command);
  if (stream) return stream.handle(command, data);
  throw new Error(`Unknown command ${command}`);
}, close);
