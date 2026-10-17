import { defineAgent } from '@vrealtime/core';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import { control } from './control.js';
let running: RunningServer | undefined;
async function close(): Promise<void> { const current = running; running = undefined; await current?.close(); }
control(async (command, data) => {
  if (command === 'ready') {
    const authenticated = data.profile === 'server-auth-v1';
    if (authenticated && (typeof data.authToken !== 'string' || data.authToken.length === 0)) throw new Error('Missing ephemeral test credential');
    running = await serve(defineAgent({ model: fakeModel(), instructions: '', clientTools: 'accept' }), {
      host: '127.0.0.1', port: 0, onListening: () => {},
      ...(authenticated ? { authenticate: ({ token }: { token: string | undefined }) => token === data.authToken ? { id: 'conformance-principal' } : undefined } : {}),
    });
    return { url: running.url.replace('http:', 'ws:'), ...(authenticated ? { driverCapabilities: ['server-auth-v1'] } : {}) };
  }
  if (command === 'close') { await close(); return {}; }
  throw new Error(`Unknown command ${command}`);
}, close);
