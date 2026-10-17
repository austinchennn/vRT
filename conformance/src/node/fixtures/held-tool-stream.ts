import { appendFileSync } from 'node:fs';
import { streamServer } from '../drivers/server-tool-stream.js';
import { control } from '../drivers/control.js';
let server: Awaited<ReturnType<typeof streamServer>> | undefined;
if (process.argv[2]) appendFileSync(process.argv[2], process.pid + '\n');
async function close(): Promise<void> { await server?.close(); }
control(async (command, data) => {
  if (command === 'ready') {
    server = await streamServer(data.argumentStreaming !== false);
    return { url: server.url, driverCapabilities: ['server-tool-stream-v1'] };
  }
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'finishStream') return new Promise(() => {});
  if (!server) throw new Error('Not ready');
  return server.handle(command, data);
}, close);
