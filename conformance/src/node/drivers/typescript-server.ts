import { defineAgent } from '@vrealtime/core';
import { serve, type RunningServer } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import { control } from './control.js';
let running: RunningServer | undefined;
async function close(): Promise<void> { const current = running; running = undefined; await current?.close(); }
control(async command => {
  if (command === 'ready') {
    running = await serve(defineAgent({ model: fakeModel(), instructions: '', clientTools: 'accept' }), {
      host: '127.0.0.1', port: 0, onListening: () => {},
    });
    return { url: running.url.replace('http:', 'ws:') };
  }
  if (command === 'close') { await close(); return {}; }
  throw new Error(`Unknown command ${command}`);
}, close);
