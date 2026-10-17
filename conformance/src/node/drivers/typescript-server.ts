import { defineAgent } from '@vrealtime/core';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import { heartbeatServer } from './server-heartbeat.js';
import { streamServer } from './server-tool-stream.js';
import { principalServer } from './server-principal.js';
import { control } from './control.js';
let heartbeat: Awaited<ReturnType<typeof heartbeatServer>> | undefined;
let stream: Awaited<ReturnType<typeof streamServer>> | undefined;
let principal: Awaited<ReturnType<typeof principalServer>> | undefined;
let running: RunningServer | undefined;
async function close(): Promise<void> { const current = running; running = undefined; await current?.close(); await stream?.close(); await heartbeat?.close(); await principal?.close(); }
control(async (command, data) => {
  if (command === 'ready') {
    if (data.profile === 'server-resume-principal-v1') {
      principal = await principalServer(data.tokens);
      return { url: principal.url, driverCapabilities: ['server-resume-principal-v1'] };
    }
    if (data.profile === 'server-heartbeat-v1') {
      heartbeat = await heartbeatServer(data);
      return { url: heartbeat.url, timing: heartbeat.timing, driverCapabilities: ['server-heartbeat-v1'] };
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
  if (principal) return principal.handle(command, data);
  if (heartbeat) return heartbeat.handle(command, data);
  if (stream) return stream.handle(command, data);
  throw new Error(`Unknown command ${command}`);
}, close);
